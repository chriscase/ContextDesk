//! Template embedding policy for log corpora (#359).
//!
//! - **Default:** local in-process ONNX (`fastembed` when the `log-fastembed`
//!   feature is enabled; otherwise a deterministic offline backend for tests).
//! - **Cloud:** per-corpus opt-in, **off by default**, requires an explicit
//!   "log content leaves this machine" confirmation.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};

/// How a corpus embeds templates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LogEmbedMode {
    /// Local ONNX / offline deterministic — content stays on machine.
    #[default]
    Local,
    /// Cloud embedding API — requires [`LogEmbedPolicy::cloud_content_leaves_machine`].
    Cloud,
    /// Skip embedding (keyword/structured only).
    None,
}

/// Per-corpus embed settings (LOG_ANALYSIS.md §6 / §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEmbedPolicy {
    /// Embed mode.
    #[serde(default)]
    pub mode: LogEmbedMode,
    /// User confirmed "log content leaves this machine" for cloud mode.
    #[serde(default)]
    pub cloud_content_leaves_machine: bool,
    /// Optional cloud base URL (never holds secrets — keys from keychain only).
    #[serde(default)]
    pub cloud_base_url: Option<String>,
    /// Model id label stored with vectors / cache keys.
    #[serde(default = "default_model_id")]
    pub model_id: String,
}

fn default_model_id() -> String {
    "local-onnx-default".into()
}

impl Default for LogEmbedPolicy {
    fn default() -> Self {
        Self {
            mode: LogEmbedMode::Local,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: default_model_id(),
        }
    }
}

impl LogEmbedPolicy {
    /// Local default (owner §10).
    pub fn local_default() -> Self {
        Self::default()
    }

    /// Cloud mode only when the user explicitly confirms content may leave the machine.
    pub fn cloud_opt_in(base_url: impl Into<String>, confirmed: bool) -> Self {
        Self {
            mode: LogEmbedMode::Cloud,
            cloud_content_leaves_machine: confirmed,
            cloud_base_url: Some(base_url.into()),
            model_id: "cloud-embed".into(),
        }
    }

    /// Validate policy before any cloud HTTP call.
    pub fn assert_embed_allowed(&self) -> CoreResult<()> {
        match self.mode {
            LogEmbedMode::None | LogEmbedMode::Local => Ok(()),
            LogEmbedMode::Cloud => {
                if !self.cloud_content_leaves_machine {
                    return Err(CoreError::Policy(
                        "cloud log embedding requires explicit confirmation that \
                         log content leaves this machine"
                            .into(),
                    ));
                }
                if self
                    .cloud_base_url
                    .as_ref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err(CoreError::Config(
                        "cloud embed requires cloud_base_url".into(),
                    ));
                }
                Ok(())
            }
        }
    }
}

/// Fixed confirm string the UI must show (product copy may wrap; policy checks the flag).
pub const CLOUD_LEAVE_MACHINE_CONFIRM: &str =
    "Log content will leave this machine to a cloud embedding provider.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_blocked_without_confirm() {
        let p = LogEmbedPolicy::cloud_opt_in("https://api.example.com", false);
        let err = p.assert_embed_allowed().unwrap_err();
        assert!(format!("{err}").contains("leaves this machine"));
    }

    #[test]
    fn cloud_ok_with_confirm() {
        let p = LogEmbedPolicy::cloud_opt_in("https://api.example.com", true);
        p.assert_embed_allowed().unwrap();
    }

    #[test]
    fn local_default_is_local() {
        let p = LogEmbedPolicy::local_default();
        assert_eq!(p.mode, LogEmbedMode::Local);
        assert!(!p.cloud_content_leaves_machine);
        p.assert_embed_allowed().unwrap();
    }
}
