//! Telegram input/notification bridge for `cd-server` (#289).
//!
//! Telegram is deliberately not a permission authority. The bridge authenticates
//! webhook delivery, maps configured users to workspace roles, and transports
//! `cd.v1` event output. HardWrite proposals are only queued for a paired desktop.

use super::Role;
use cd_core::ssrf::{build_pinned_client_for_url, SsrfPolicy, SystemResolver};
use cd_core::tools::ToolSideEffect;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

const TELEGRAM_API_BASE: &str = "https://api.telegram.org/";
const TELEGRAM_MESSAGE_LIMIT: usize = 4_000;
const TELEGRAM_UPDATE_DEDUPE_CAP: usize = 4_096;

type ChatThreadSessions = Arc<Mutex<HashMap<(i64, Option<i64>), String>>>;
#[cfg(test)]
pub(crate) type CapturedMessages = Arc<Mutex<Vec<TelegramSendMessage>>>;

/// Server-side Telegram bridge configuration. Secret values never appear here:
/// both fields are OS-keychain reference ids.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TelegramConfig {
    pub(crate) bot_token_ref: String,
    pub(crate) webhook_secret_ref: String,
    #[serde(default)]
    pub(crate) users: Vec<TelegramUserConfig>,
}

/// Exact Telegram user → workspace role mapping.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TelegramUserConfig {
    pub(crate) user_id: i64,
    pub(crate) workspace_id: String,
    pub(crate) role: Role,
    /// Permit this configured admin to confirm SoftWrite with
    /// `/approve_soft <request-id> WRITE`. Never affects HardWrite.
    #[serde(default)]
    pub(crate) allow_soft_write: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct TelegramIdentity {
    pub(crate) user_id: i64,
    pub(crate) workspace_id: String,
    pub(crate) role: Role,
    pub(crate) allow_soft_write: bool,
}

/// Minimal Telegram webhook update surface. Unknown Telegram fields are ignored.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TelegramUpdate {
    #[allow(dead_code)]
    pub(crate) update_id: i64,
    pub(crate) message: Option<TelegramMessage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TelegramMessage {
    pub(crate) message_id: i64,
    pub(crate) chat: TelegramChat,
    #[serde(rename = "from")]
    pub(crate) from_user: Option<TelegramUser>,
    pub(crate) message_thread_id: Option<i64>,
    pub(crate) text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TelegramChat {
    pub(crate) id: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TelegramUser {
    pub(crate) id: i64,
}

/// Outbound Telegram `sendMessage` payload. No parse mode: model output is
/// transported as plain text, so Markdown/HTML cannot create active markup.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct TelegramSendMessage {
    pub(crate) chat_id: i64,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message_thread_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reply_to_message_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChatPermissionProposal {
    pub(crate) request_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) user_id: i64,
    pub(crate) chat_id: i64,
    pub(crate) message_thread_id: Option<i64>,
    pub(crate) tool_name: String,
    pub(crate) target: String,
    pub(crate) reason: String,
    pub(crate) preview: String,
    pub(crate) risk: String,
    pub(crate) side_effect: ToolSideEffect,
    pub(crate) trusted_desktop_connected: bool,
}

#[derive(Clone, Debug)]
struct DesktopPairing {
    pairing_id: String,
    workspace_id: String,
    device_label: String,
    created_at_unix: u64,
}

#[derive(Default)]
struct SeenUpdates {
    order: VecDeque<i64>,
    ids: HashSet<i64>,
}

#[derive(Clone)]
enum TelegramTransport {
    Http(Arc<TelegramHttpTransport>),
    #[cfg(test)]
    Capture(CapturedMessages),
}

struct TelegramHttpTransport {
    client: reqwest::Client,
    api_base: reqwest::Url,
    bot_token: String,
}

impl TelegramHttpTransport {
    fn new(bot_token: String) -> Result<Self, String> {
        if bot_token.trim().is_empty() || bot_token.chars().any(char::is_whitespace) {
            return Err("Telegram bot token from keychain is empty or malformed".into());
        }
        let policy = SsrfPolicy {
            block_private: true,
            allow_loopback: false,
        };
        let (api_base, client) = build_pinned_client_for_url(
            TELEGRAM_API_BASE,
            &policy,
            &SystemResolver,
            Duration::from_secs(15),
        )
        .map_err(|_| "Telegram API endpoint failed SSRF/DNS validation".to_string())?;
        Ok(Self {
            client,
            api_base,
            bot_token,
        })
    }

    async fn send(&self, message: &TelegramSendMessage) -> Result<(), String> {
        let mut url = self.api_base.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "invalid Telegram API base URL".to_string())?;
            segments.pop_if_empty();
            segments.push(&format!("bot{}", self.bot_token));
            segments.push("sendMessage");
        }
        let response = self
            .client
            .post(url)
            .json(message)
            .send()
            .await
            // Do not include reqwest's error text: its URL contains the bot token.
            .map_err(|_| "Telegram sendMessage transport failed".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "Telegram sendMessage returned HTTP {}",
                response.status().as_u16()
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct TelegramBridge {
    webhook_secret: Arc<String>,
    users: Arc<HashMap<i64, TelegramIdentity>>,
    sessions: ChatThreadSessions,
    proposals: Arc<Mutex<HashMap<String, ChatPermissionProposal>>>,
    pairings: Arc<Mutex<HashMap<String, DesktopPairing>>>,
    seen_updates: Arc<Mutex<SeenUpdates>>,
    transport: TelegramTransport,
}

impl TelegramBridge {
    pub(crate) fn new_http(
        config: &TelegramConfig,
        bot_token: String,
        webhook_secret: String,
    ) -> Result<Self, String> {
        let transport = TelegramTransport::Http(Arc::new(TelegramHttpTransport::new(bot_token)?));
        Self::new(config, webhook_secret, transport)
    }

    fn new(
        config: &TelegramConfig,
        webhook_secret: String,
        transport: TelegramTransport,
    ) -> Result<Self, String> {
        validate_secret_ref("bot_token_ref", &config.bot_token_ref)?;
        validate_secret_ref("webhook_secret_ref", &config.webhook_secret_ref)?;
        if webhook_secret.trim().is_empty() {
            return Err("Telegram webhook secret from keychain is empty".into());
        }
        let mut users = HashMap::new();
        for user in &config.users {
            if user.workspace_id.trim().is_empty() {
                return Err(format!(
                    "Telegram user {} has an empty workspace_id",
                    user.user_id
                ));
            }
            if user.allow_soft_write && !user.role.is_admin() {
                return Err(format!(
                    "Telegram user {} enables SoftWrite but is not an admin",
                    user.user_id
                ));
            }
            let identity = TelegramIdentity {
                user_id: user.user_id,
                workspace_id: user.workspace_id.clone(),
                role: user.role,
                allow_soft_write: user.allow_soft_write,
            };
            if users.insert(user.user_id, identity).is_some() {
                return Err(format!(
                    "duplicate Telegram user_id {} in server config",
                    user.user_id
                ));
            }
        }
        Ok(Self {
            webhook_secret: Arc::new(webhook_secret),
            users: Arc::new(users),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            proposals: Arc::new(Mutex::new(HashMap::new())),
            pairings: Arc::new(Mutex::new(HashMap::new())),
            seen_updates: Arc::new(Mutex::new(SeenUpdates::default())),
            transport,
        })
    }

    pub(crate) fn webhook_secret_matches(&self, candidate: &str) -> bool {
        let expected: [u8; 32] = Sha256::digest(self.webhook_secret.as_bytes()).into();
        let candidate: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        bool::from(expected.ct_eq(&candidate))
    }

    pub(crate) fn identity(&self, user_id: i64) -> Option<TelegramIdentity> {
        self.users.get(&user_id).cloned()
    }

    /// Telegram retries webhook deliveries. Admit each update id once, keeping a
    /// bounded process-lifetime window so retries cannot duplicate turns/proposals.
    pub(crate) fn accept_update(&self, update_id: i64) -> Result<bool, String> {
        let mut seen = self
            .seen_updates
            .lock()
            .map_err(|_| "Telegram update dedupe lock poisoned".to_string())?;
        if !seen.ids.insert(update_id) {
            return Ok(false);
        }
        seen.order.push_back(update_id);
        if seen.order.len() > TELEGRAM_UPDATE_DEDUPE_CAP {
            if let Some(expired) = seen.order.pop_front() {
                seen.ids.remove(&expired);
            }
        }
        Ok(true)
    }

    /// Stable process-lifetime mapping from Telegram chat/thread to a cd session.
    pub(crate) fn session_id(
        &self,
        chat_id: i64,
        message_thread_id: Option<i64>,
    ) -> Result<String, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Telegram session map lock poisoned".to_string())?;
        Ok(sessions
            .entry((chat_id, message_thread_id))
            .or_insert_with(|| format!("telegram-{}", uuid::Uuid::new_v4()))
            .clone())
    }

    pub(crate) fn queue_proposal(
        &self,
        mut proposal: ChatPermissionProposal,
    ) -> Result<(), String> {
        proposal.trusted_desktop_connected = self.has_pairing(&proposal.workspace_id)?;
        self.proposals
            .lock()
            .map_err(|_| "Telegram proposal queue lock poisoned".to_string())?
            .insert(proposal.request_id.clone(), proposal);
        Ok(())
    }

    pub(crate) fn proposal(
        &self,
        request_id: &str,
    ) -> Result<Option<ChatPermissionProposal>, String> {
        Ok(self
            .proposals
            .lock()
            .map_err(|_| "Telegram proposal queue lock poisoned".to_string())?
            .get(request_id)
            .cloned())
    }

    pub(crate) fn remove_proposal(&self, request_id: &str) -> Result<(), String> {
        self.proposals
            .lock()
            .map_err(|_| "Telegram proposal queue lock poisoned".to_string())?
            .remove(request_id);
        Ok(())
    }

    pub(crate) fn pair_desktop(
        &self,
        workspace_id: &str,
        device_label: &str,
    ) -> Result<(String, u64), String> {
        if device_label.trim().is_empty() {
            return Err("desktop pairing requires a device_label".into());
        }
        let pairing_id = uuid::Uuid::new_v4().to_string();
        let created_at_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let pairing = DesktopPairing {
            pairing_id: pairing_id.clone(),
            workspace_id: workspace_id.to_string(),
            device_label: device_label.trim().chars().take(120).collect(),
            created_at_unix,
        };
        self.pairings
            .lock()
            .map_err(|_| "Telegram pairing lock poisoned".to_string())?
            .insert(pairing_id.clone(), pairing);
        Ok((pairing_id, created_at_unix))
    }

    pub(crate) fn validate_pairing(
        &self,
        pairing_id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let pairings = self
            .pairings
            .lock()
            .map_err(|_| "Telegram pairing lock poisoned".to_string())?;
        match pairings.get(pairing_id) {
            Some(p) if p.workspace_id == workspace_id => {
                // Touch fields here so they remain part of the auditable pairing record.
                let _ = (&p.pairing_id, &p.device_label, p.created_at_unix);
                Ok(())
            }
            _ => Err("unknown pairing or workspace mismatch".into()),
        }
    }

    pub(crate) fn proposals_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChatPermissionProposal>, String> {
        let paired = self.has_pairing(workspace_id)?;
        let mut proposals: Vec<_> = self
            .proposals
            .lock()
            .map_err(|_| "Telegram proposal queue lock poisoned".to_string())?
            .values()
            .filter(|p| p.workspace_id == workspace_id)
            .cloned()
            .collect();
        for proposal in &mut proposals {
            proposal.trusted_desktop_connected = paired;
        }
        proposals.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        Ok(proposals)
    }

    fn has_pairing(&self, workspace_id: &str) -> Result<bool, String> {
        Ok(self
            .pairings
            .lock()
            .map_err(|_| "Telegram pairing lock poisoned".to_string())?
            .values()
            .any(|p| p.workspace_id == workspace_id))
    }

    pub(crate) async fn send_text(
        &self,
        chat_id: i64,
        message_thread_id: Option<i64>,
        reply_to_message_id: Option<i64>,
        text: &str,
    ) -> Result<(), String> {
        for chunk in split_message(text, TELEGRAM_MESSAGE_LIMIT) {
            let message = TelegramSendMessage {
                chat_id,
                text: chunk,
                message_thread_id,
                reply_to_message_id,
            };
            match &self.transport {
                TelegramTransport::Http(http) => http.send(&message).await?,
                #[cfg(test)]
                TelegramTransport::Capture(messages) => messages
                    .lock()
                    .map_err(|_| "Telegram capture lock poisoned".to_string())?
                    .push(message),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn new_capture(
        config: &TelegramConfig,
        webhook_secret: &str,
    ) -> Result<(Self, CapturedMessages), String> {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let bridge = Self::new(
            config,
            webhook_secret.to_string(),
            TelegramTransport::Capture(messages.clone()),
        )?;
        Ok((bridge, messages))
    }
}

pub(crate) fn validate_secret_ref(field: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    let expected_suffix = match field {
        "bot_token_ref" => "/bot_token",
        "webhook_secret_ref" => "/webhook_secret",
        _ => return Err(format!("unknown Telegram secret-ref field `{field}`")),
    };
    if value.is_empty()
        || !value.starts_with("telegram/")
        || value.split('/').count() != 3
        || !value.ends_with(expected_suffix)
        || value.len() > 160
        || value.chars().any(char::is_whitespace)
        || cd_core::keychain_store::looks_like_raw_secret(value)
    {
        return Err(format!(
            "Telegram {field} must be an OS-keychain reference id, not secret material"
        ));
    }
    Ok(())
}

fn split_message(text: &str, max_chars: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return vec!["Request completed.".into()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_utf16 = 0;
    for ch in text.chars() {
        let units = ch.len_utf16();
        if current_utf16 + units > max_chars && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            current_utf16 = 0;
        }
        current.push(ch);
        current_utf16 += units;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> TelegramConfig {
        TelegramConfig {
            bot_token_ref: "telegram/default/bot_token".into(),
            webhook_secret_ref: "telegram/default/webhook_secret".into(),
            users: vec![TelegramUserConfig {
                user_id: 7,
                workspace_id: "ws-a".into(),
                role: Role::Admin,
                allow_soft_write: true,
            }],
        }
    }

    #[test]
    fn secret_refs_only_and_webhook_constant_time_contract() {
        let (bridge, _) = TelegramBridge::new_capture(&config(), "hook-secret").unwrap();
        assert!(bridge.webhook_secret_matches("hook-secret"));
        assert!(!bridge.webhook_secret_matches("hook-secreu"));
        assert!(!bridge.webhook_secret_matches("short"));
        assert!(validate_secret_ref("bot_token_ref", "123456:raw-token").is_err());
        assert!(validate_secret_ref("bot_token_ref", "telegram/default/bot_token").is_ok());
    }

    #[test]
    fn chat_thread_maps_stably_and_separately() {
        let (bridge, _) = TelegramBridge::new_capture(&config(), "hook-secret").unwrap();
        let a1 = bridge.session_id(100, Some(1)).unwrap();
        let a2 = bridge.session_id(100, Some(1)).unwrap();
        let b = bridge.session_id(100, Some(2)).unwrap();
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert!(a1.starts_with("telegram-"));
    }

    #[test]
    fn webhook_update_ids_are_deduplicated() {
        let (bridge, _) = TelegramBridge::new_capture(&config(), "hook-secret").unwrap();
        assert!(bridge.accept_update(99).unwrap());
        assert!(!bridge.accept_update(99).unwrap());
        assert!(bridge.accept_update(100).unwrap());
    }

    #[tokio::test]
    async fn outbound_is_utf8_safe_and_chunked() {
        let (bridge, sent) = TelegramBridge::new_capture(&config(), "hook-secret").unwrap();
        let original = "🦀".repeat(TELEGRAM_MESSAGE_LIMIT + 1);
        bridge.send_text(1, None, None, &original).await.unwrap();
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 3);
        assert!(sent
            .iter()
            .all(|message| message.text.encode_utf16().count() <= TELEGRAM_MESSAGE_LIMIT));
        assert_eq!(
            sent.iter()
                .map(|message| message.text.as_str())
                .collect::<String>(),
            original
        );
    }

    #[test]
    fn soft_write_requires_configured_admin() {
        let mut bad = config();
        bad.users[0].role = Role::Member;
        assert!(TelegramBridge::new_capture(&bad, "hook-secret").is_err());
    }
}
