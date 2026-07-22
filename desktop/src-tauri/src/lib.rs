//! ContextDesk Tauri host — secrets stay here; webview gets redacted DTOs only.

use cd_core::branding::Branding;
use cd_core::chat::{ChatMessage, Role as ChatRole};
use cd_core::config::{
    config_path, ensure_config_dir, load_config, save_config, AppConfig, ConfluenceSettings,
    WorkspaceConfig, XSettings, CONFLUENCE_PAT_REF, X_API_KEY_REF,
};
use cd_core::discovery::{discover_local, ollama_reachable, LocalCandidate};
use cd_core::keychain_store::{
    key_ref_confluence_pat, key_ref_for_profile, key_ref_x_api_key, looks_like_raw_secret,
    KeychainSecretStore, SecretStore,
};
use cd_core::memory_fs::{list_memory_files, read_workspace_file, write_memory_file, MemoryFile};
use cd_core::permissions::PermissionDecision;
use cd_core::preflight::{run_preflight, PreflightInput, PreflightReport};
use cd_core::probe::{expand_base_candidates, normalize_gateway_input};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::research::{events_to_dto, grant_and_execute, EventDto};
use cd_core::sessions::{
    sanitize_generated_title, session_title_llm_prompt, title_from_prompt, Session, SessionMeta,
    SessionSearchHit, SessionStore,
};
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

struct AppState {
    branding: Branding,
    config: Mutex<AppConfig>,
    secrets: KeychainSecretStore,
    /// Session id -> chat history
    histories: Mutex<HashMap<String, Vec<ChatMessage>>>,
    /// Live tool host (rebuilt when workspace changes). Arc so the index
    /// watcher callback can reindex without holding AppState.
    host: Arc<Mutex<Option<ToolHost>>>,
    /// Per-session cooperative cancel flags for in-flight turns (#109).
    cancels: Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// Debounced FS watcher for incremental index refresh (#116).
    index_watch: Mutex<Option<cd_core::index_watch::IndexWatchHandle>>,
    /// Background index lifecycle (#117) — search works while Indexing.
    index_status: Arc<Mutex<cd_core::index::IndexStatus>>,
}

fn workspace_from_cfg(cfg: &AppConfig) -> Option<Workspace> {
    cfg.workspace.as_ref().map(|w| Workspace {
        id: w.id.clone(),
        name: w.name.clone(),
        roots: w.roots.clone(),
    })
}

fn session_store(state: &AppState) -> Result<SessionStore, String> {
    let dir = ensure_config_dir(&state.branding)
        .map_err(|e| e.to_string())?
        .join("sessions");
    Ok(SessionStore::new(dir))
}

fn seed_history_from_session(state: &AppState, session: &Session) {
    let hist = session.to_chat_history();
    let mut histories = state.histories.lock().expect("hist");
    histories.insert(session.id.clone(), hist);
}

fn ensure_host(state: &AppState) -> Result<(), String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or_else(|| "no workspace configured".to_string())?;
    if ws.roots.is_empty() {
        return Err("workspace has no roots".into());
    }

    let mut host_guard = state.host.lock().expect("host");
    if let Some(host) = host_guard.as_mut() {
        // Long-lived host (#110): keep permissions. Do **not** reindex on every
        // ensure (#117) — full walks run in the background / FS watcher only.
        if host.workspace.roots != ws.roots || host.workspace.id != ws.id {
            // Workspace changed — rebuild.
            drop(host_guard);
            return rebuild_host(state, cfg, ws);
        }
        apply_host_connectors(host, &cfg, state);
        return Ok(());
    }
    drop(host_guard);
    rebuild_host(state, cfg, ws)
}

fn rebuild_host(state: &AppState, cfg: AppConfig, ws: Workspace) -> Result<(), String> {
    // Stop previous watcher before replacing the host (#116).
    if let Some(mut prev) = state.index_watch.lock().expect("watch").take() {
        prev.stop();
    }
    let audit = ensure_config_dir(&state.branding)
        .ok()
        .map(|d| d.join("audit.jsonl"));
    let index_cache = ensure_config_dir(&state.branding)
        .ok()
        .map(|d| d.join("index"));
    let roots = ws.roots.clone();

    // #117: open shell without blocking full walk — search uses loaded store
    // (or empty cold) immediately; full refresh runs in a background thread.
    let index = cd_core::index::KeywordIndex::open_shell_bounded(
        &ws,
        index_cache.as_deref(),
        Some(cfg.index_max_files),
        Some(cfg.index_max_bytes),
    )
    .map_err(|e| e.to_string())?;
    let audit_log = audit.map(cd_core::audit::AuditLog::new);
    let mut host = ToolHost::new(ws, index, audit_log);
    host.set_router_budget(cfg.router.clone());
    host.attach_connectors(&cfg.connectors);
    apply_host_connectors(&mut host, &cfg, state);
    // Durable memory (MEMORY.md Phase 1) — product seam; without this, tools stay
    // on legacy memory_fs and ambient/recall never run.
    if let Err(e) =
        cd_core::memory::attach_durable_memory_to_host(&mut host, &state.branding, &cfg.memory)
    {
        tracing::warn!(error = %e, "durable memory attach failed; using memory_fs fallback");
    }

    {
        let mut st = state.index_status.lock().expect("index_status");
        *st = cd_core::index::IndexStatus {
            phase: cd_core::index::IndexPhase::Indexing,
            scanned: 0,
            added: 0,
            max_files: cfg.index_max_files as u32,
            truncated: false,
            bytes_capped: host.index_bytes_capped(),
            resident_chunks: host.index_resident_chunks() as u32,
            message: "Background index starting — search uses whatever is already loaded.".into(),
        };
    }

    *state.host.lock().expect("host") = Some(host);

    // Background full/incremental refresh off the UI / turn critical path (#117).
    let host_arc = Arc::clone(&state.host);
    let status_arc = Arc::clone(&state.index_status);
    let _ = std::thread::Builder::new()
        .name("cd-index-bg".into())
        .spawn(move || {
            {
                let mut st = status_arc.lock().expect("index_status");
                st.phase = cd_core::index::IndexPhase::Indexing;
                st.message = "Indexing workspace in background…".into();
            }
            let result = {
                let mut g = host_arc.lock().expect("host");
                match g.as_mut() {
                    Some(h) => h.reindex(),
                    None => {
                        return;
                    }
                }
            };
            let mut st = status_arc.lock().expect("index_status");
            match result {
                Ok(stats) => {
                    let capped = host_arc
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().map(|h| h.index_bytes_capped()))
                        .unwrap_or(false);
                    let chunks = host_arc
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().map(|h| h.index_resident_chunks()))
                        .unwrap_or(0);
                    st.phase = cd_core::index::IndexPhase::Ready;
                    st.scanned = stats.scanned;
                    st.added = stats.added;
                    st.max_files = stats.max_files;
                    st.truncated = stats.truncated;
                    st.bytes_capped = capped;
                    st.resident_chunks = chunks as u32;
                    st.message = if stats.truncated {
                        format!(
                            "Index ready (walk hit soft cap {} files; truncated).",
                            stats.max_files
                        )
                    } else if capped {
                        "Index ready (resident set bytes-capped; search covers recent subset)."
                            .into()
                    } else {
                        format!(
                            "Index ready — scanned {} files, {} added.",
                            stats.scanned, stats.added
                        )
                    };
                    tracing::info!(?stats, "background index complete");
                }
                Err(e) => {
                    st.phase = cd_core::index::IndexPhase::Error;
                    st.message = format!("Background index failed: {e}");
                    tracing::warn!(error = %e, "background index failed");
                }
            }
        });

    // Start debounced FS watcher → incremental reindex (host-agnostic API).
    let host_arc = Arc::clone(&state.host);
    let status_arc = Arc::clone(&state.index_status);
    let on_refresh = Arc::new(move || {
        if let Ok(mut g) = host_arc.lock() {
            if let Some(h) = g.as_mut() {
                match h.reindex() {
                    Ok(stats) => {
                        if let Ok(mut st) = status_arc.lock() {
                            st.phase = cd_core::index::IndexPhase::Ready;
                            st.scanned = stats.scanned;
                            st.added = stats.added;
                            st.truncated = stats.truncated;
                            st.message = format!(
                                "Index refreshed — scanned {}, +{}.",
                                stats.scanned, stats.added
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "index watcher refresh failed");
                    }
                }
            }
        }
    });
    let handle = cd_core::index_watch::spawn_index_watcher(roots, on_refresh);
    *state.index_watch.lock().expect("watch") = Some(handle);
    Ok(())
}

fn apply_host_connectors(host: &mut ToolHost, cfg: &AppConfig, state: &AppState) {
    // Attach Confluence RO when enabled (PAT from keychain only).
    if cfg.confluence.enabled && cfg.confluence.is_configured() {
        let pat = state.secrets.get(&key_ref_confluence_pat()).ok().flatten();
        host.set_confluence(Some(cfg.confluence.to_ro_config()), pat);
    } else {
        host.set_confluence(None, None);
    }
    host.set_web_research(cfg.web_research_enabled);
    host.set_web_research_sources(&cfg.web_research_sources);
    // #119: hybrid search_kb when opt-in; optional Ollama embeddings (no network in tests).
    host.set_hybrid_retrieval(cfg.hybrid_retrieval);
    if cfg.hybrid_retrieval {
        if let Some(profile) = cfg.providers.active() {
            if profile.kind == cd_core::providers::ProviderKind::Ollama {
                match cd_core::chat::OllamaClient::new(
                    &profile.base_url,
                    // Prefer a small embed model id when available; chat model still works
                    // for hosts that share one local model.
                    "nomic-embed-text",
                ) {
                    Ok(client) => {
                        host.set_embed_backend(Some(std::sync::Arc::new(
                            cd_core::embed::OllamaEmbedBackend::new(client),
                        )));
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "hybrid retrieval on but Ollama embed client failed");
                        host.set_embed_backend(None);
                    }
                }
            } else {
                // Keyword + recency hybrid without semantic when no local embed model.
                host.set_embed_backend(None);
            }
        } else {
            host.set_embed_backend(None);
        }
    } else {
        host.set_embed_backend(None);
    }
    if cfg.x.enabled {
        let bearer = state.secrets.get(&key_ref_x_api_key()).ok().flatten();
        host.set_x_search(true, bearer);
    } else {
        host.set_x_search(false, None);
    }
    host.set_router_budget(cfg.router.clone());
    // #127–#131: connector registry → dynamic tools (secrets from keychain only).
    let mut pg_passwords = std::collections::HashMap::new();
    let mut http_bearers = std::collections::HashMap::new();
    for c in cfg.connectors.iter().filter(|c| c.enabled) {
        if c.kind == "postgres" {
            let r = cd_core::sql_ro::postgres_password_ref(&c.id);
            if let Ok(Some(pw)) = state.secrets.get(&r) {
                pg_passwords.insert(c.id.clone(), pw);
            }
        }
        if c.kind == "http" {
            let r = cd_core::http_preset::http_bearer_ref(&c.id);
            if let Ok(Some(b)) = state.secrets.get(&r) {
                http_bearers.insert(c.id.clone(), b);
            }
        }
    }
    host.attach_connectors_with_all_secrets(&cfg.connectors, &pg_passwords, &http_bearers);

    // #136: enabled external modules (local install only; capability grants from #135).
    if let Ok(config_dir) = ensure_config_dir(&state.branding) {
        let modules_dir = cd_core::modules::default_modules_dir(&config_dir);
        let grants_path = config_dir.join("module_grants.json");
        let grants = cd_core::modules::ModuleGrantStore::load(&grants_path).unwrap_or_default();
        let discovered = cd_core::modules::discover_modules(&[modules_dir]).unwrap_or_default();
        for id in &cfg.enabled_modules {
            if let Some(m) = discovered.iter().find(|x| &x.id == id) {
                let secrets = &state.secrets;
                let resolve = |r: &str| secrets.get(r).ok().flatten();
                if let Err(e) = host.attach_module(m, &grants, &resolve) {
                    tracing::warn!(module_id = %id, error = %e, "enabled module attach failed");
                }
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct BrandingDto {
    name: String,
    slug: String,
    tagline: String,
    version: String,
    protocol: String,
}

#[tauri::command]
fn get_branding(state: State<'_, AppState>) -> BrandingDto {
    BrandingDto {
        name: state.branding.name.clone(),
        slug: state.branding.slug.clone(),
        tagline: state.branding.tagline.clone(),
        version: cd_core::VERSION.to_string(),
        protocol: cd_core::PROTOCOL_VERSION.to_string(),
    }
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().expect("config lock").clone()
}

#[tauri::command]
fn save_app_config(state: State<'_, AppState>, cfg: AppConfig) -> Result<(), String> {
    for p in &cfg.providers.profiles {
        if let Some(r) = &p.api_key_ref {
            if looks_like_raw_secret(r) {
                return Err("refusing raw secret in api_key_ref".into());
            }
        }
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config lock") = cfg;
    // rebuild host
    let _ = ensure_host(&state);
    Ok(())
}

/// Connector row for Settings (#127). No secrets.
#[derive(Clone, serde::Serialize)]
struct ConnectorDto {
    id: String,
    kind: String,
    enabled: bool,
    label: String,
    /// Kind-specific non-secret settings (command/args for MCP, etc.).
    settings: serde_json::Value,
    /// Tools discovered after host attach (MCP `mcp__server__tool` names).
    #[serde(default)]
    discovered_tools: Vec<String>,
}

fn connector_dtos(state: &AppState, cfg: &AppConfig) -> Vec<ConnectorDto> {
    let tool_names: Vec<String> = state
        .host
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref()
                .map(|h| h.specs_for_model().into_iter().map(|s| s.name).collect())
        })
        .unwrap_or_default();
    cfg.connectors
        .iter()
        .map(|c| {
            let discovered_tools = if c.kind == "mcp" {
                let server = c
                    .settings
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(c.id.as_str());
                let prefix = format!("mcp__{server}__");
                tool_names
                    .iter()
                    .filter(|n| n.starts_with(&prefix))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            ConnectorDto {
                id: c.id.clone(),
                kind: c.kind.clone(),
                enabled: c.enabled,
                label: c.label(),
                settings: c.settings.clone(),
                discovered_tools,
            }
        })
        .collect()
}

#[tauri::command]
fn list_connectors(state: State<'_, AppState>) -> Vec<ConnectorDto> {
    let cfg = state.config.lock().expect("config lock").clone();
    connector_dtos(&state, &cfg)
}

#[tauri::command]
fn list_connector_kinds() -> Vec<String> {
    cd_core::connectors::CONNECTOR_KINDS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// Replace workspace connector list (settings JSON only; no secrets over IPC).
#[tauri::command]
fn save_connectors(
    state: State<'_, AppState>,
    connectors: Vec<cd_core::connectors::ConnectorConfig>,
) -> Result<Vec<ConnectorDto>, String> {
    for c in &connectors {
        if c.id.trim().is_empty() || c.kind.trim().is_empty() {
            return Err("connector id and kind are required".into());
        }
        // Refuse accidental secret fields in settings JSON.
        if let Some(obj) = c.settings.as_object() {
            for key in ["api_key", "password", "token", "pat", "secret", "bearer"] {
                if let Some(v) = obj.get(key) {
                    if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                        return Err(format!(
                            "refusing secret field `{key}` in connector settings — use keychain"
                        ));
                    }
                }
            }
        }
    }
    let mut cfg = state.config.lock().expect("config lock").clone();
    cfg.connectors = connectors;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config lock") = cfg.clone();
    let _ = ensure_host(&state);
    Ok(connector_dtos(&state, &cfg))
}

/// Store a connector secret in the keychain (Postgres password, etc.). Never returns the secret.
#[tauri::command]
fn set_connector_secret(
    state: State<'_, AppState>,
    connector_id: String,
    kind: String,
    secret: String,
) -> Result<(), String> {
    let connector_id = connector_id.trim();
    if connector_id.is_empty() {
        return Err("connector_id required".into());
    }
    let secret = secret.trim();
    if secret.is_empty() || secret.chars().all(|c| c == '•') {
        return Err("empty secret".into());
    }
    let r = match kind.as_str() {
        "postgres_password" | "password" => cd_core::sql_ro::postgres_password_ref(connector_id),
        "http_bearer" | "bearer" => cd_core::http_preset::http_bearer_ref(connector_id),
        other => return Err(format!("unknown connector secret kind: {other}")),
    };
    state.secrets.set(&r, secret).map_err(|e| e.to_string())?;
    let _ = ensure_host(&state);
    Ok(())
}

/// Whether a connector secret exists in the keychain (bool only over IPC).
#[tauri::command]
fn connector_has_secret(
    state: State<'_, AppState>,
    connector_id: String,
    kind: String,
) -> Result<bool, String> {
    let r = match kind.as_str() {
        "postgres_password" | "password" => {
            cd_core::sql_ro::postgres_password_ref(connector_id.trim())
        }
        "http_bearer" | "bearer" => cd_core::http_preset::http_bearer_ref(connector_id.trim()),
        other => return Err(format!("unknown connector secret kind: {other}")),
    };
    state.secrets.has(&r).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_provider_secret(
    state: State<'_, AppState>,
    profile_id: String,
    secret: String,
) -> Result<(), String> {
    let secret = secret.trim();
    if secret.is_empty() || secret.chars().all(|c| c == '•') {
        return Err("empty secret".into());
    }
    // Never log secret; only store.
    let r = key_ref_for_profile(&profile_id);
    state.secrets.set(&r, secret).map_err(|e| e.to_string())?;
    // Ensure profile records the ref only (not the secret).
    let mut cfg = state.config.lock().expect("config lock");
    if let Some(p) = cfg
        .providers
        .profiles
        .iter_mut()
        .find(|p| p.id == profile_id)
    {
        p.api_key_ref = Some(r);
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn provider_has_secret(state: State<'_, AppState>, profile_id: String) -> Result<bool, String> {
    let r = key_ref_for_profile(&profile_id);
    state.secrets.has(&r).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct SaveProviderReq {
    /// `ollama` | `openai_compatible`
    kind: String,
    base_url: String,
    chat_model: String,
    label: Option<String>,
    /// Optional new API key; empty/null keeps existing keychain entry.
    api_key: Option<String>,
    /// When true, refuse non-loopback remote bases (local-only profile).
    #[serde(default)]
    local_only: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ProviderDto {
    id: String,
    kind: String,
    base_url: String,
    chat_model: String,
    label: String,
    /// Keychain ref id only — never the secret.
    api_key_ref: Option<String>,
    has_key: bool,
}

/// Persist active provider profile (refs only) and optionally store API key in keychain.
#[tauri::command]
fn save_active_provider(
    state: State<'_, AppState>,
    req: SaveProviderReq,
) -> Result<ProviderDto, String> {
    let kind = match req.kind.as_str() {
        "ollama" => ProviderKind::Ollama,
        "openai_compatible" => ProviderKind::OpenAiCompatible,
        "anthropic" => ProviderKind::Anthropic,
        "xai_grok_build" => ProviderKind::XaiGrokBuild,
        other => return Err(format!("unsupported provider kind: {other}")),
    };
    let desc = cd_core::providers::descriptor_for(kind);
    let id = desc.profile_id_slug.to_string();
    let label = req.label.unwrap_or_else(|| desc.default_label.to_string());
    let mut base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        if let Some(def) = desc.default_base_url {
            base_url = def.to_string();
        }
    }
    let chat_model = req.chat_model.trim().to_string();
    if chat_model.is_empty() {
        return Err("chat model is required".into());
    }

    // Grok session credentials live in ~/.grok/auth.json — never paste into keychain via this path.
    if matches!(kind, ProviderKind::XaiGrokBuild) {
        cd_core::grok_auth::assert_grok_base_allowed(&base_url).map_err(|e| e.to_string())?;
        if cd_core::grok_auth::detect_grok_session().is_none() {
            return Err("No Grok session found. Run `grok login`, then try again.".into());
        }
    }

    let mut api_key_ref: Option<String> = None;
    // Grok uses session file, not keychain paste; other needs_api_key kinds accept keychain.
    if !matches!(kind, ProviderKind::XaiGrokBuild) {
        if let Some(key) = req.api_key.as_ref() {
            let key = key.trim();
            if !key.is_empty()
                && !key.chars().all(|c| c == '•')
                && (looks_like_raw_secret(key) || key.len() >= 8)
            {
                let r = key_ref_for_profile(&id);
                state.secrets.set(&r, key).map_err(|e| e.to_string())?;
                api_key_ref = Some(r);
            }
        }
    }

    let mut cfg = state.config.lock().expect("config lock");
    // Keep existing ref if no new key provided (non-Grok).
    if api_key_ref.is_none() && !matches!(kind, ProviderKind::XaiGrokBuild) {
        if let Some(existing) = cfg.providers.profiles.iter().find(|p| p.id == id) {
            api_key_ref = existing.api_key_ref.clone();
        }
    }
    // If still none but key exists under standard ref, record the ref.
    let r = key_ref_for_profile(&id);
    if api_key_ref.is_none()
        && !matches!(kind, ProviderKind::XaiGrokBuild)
        && state.secrets.has(&r).unwrap_or(false)
    {
        api_key_ref = Some(r.clone());
    }

    let local_only = req.local_only.unwrap_or(desc.is_local);
    if local_only && !base_url.is_empty() {
        let policy = SsrfPolicy::local_only();
        if validate_provider_url(&base_url, &policy).is_err() {
            return Err("local-only profile: base URL must be loopback (e.g. 127.0.0.1)".into());
        }
    }

    // #125: seed per-kind defaults from descriptor (never all-false Default).
    let capabilities = desc.default_capabilities;
    let profile = ProviderProfile {
        id: id.clone(),
        label: label.clone(),
        kind,
        base_url: base_url.clone(),
        api_key_ref: api_key_ref.clone(),
        chat_model: chat_model.clone(),
        embedding_model: if capabilities.embeddings {
            // Ollama local default embed id when kind supports embeddings.
            Some("nomic-embed-text".into())
        } else {
            None
        },
        embedding_base_url: None,
        capabilities,
        local_only,
    };

    if let Some(slot) = cfg.providers.profiles.iter_mut().find(|p| p.id == id) {
        *slot = profile.clone();
    } else {
        cfg.providers.profiles.push(profile.clone());
    }
    cfg.providers.active_id = Some(id.clone());

    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;

    let has_key = if matches!(kind, ProviderKind::XaiGrokBuild) {
        cd_core::grok_auth::detect_grok_session().is_some()
    } else {
        api_key_ref
            .as_ref()
            .map(|r| state.secrets.has(r).unwrap_or(false))
            .unwrap_or(false)
    };

    Ok(ProviderDto {
        id,
        kind: req.kind,
        base_url,
        chat_model,
        label,
        api_key_ref,
        has_key,
    })
}

#[tauri::command]
fn list_local_candidates() -> Vec<LocalCandidate> {
    discover_local()
}

#[derive(Debug, Deserialize)]
struct ProbeRequest {
    base_url: String,
    allow_private: bool,
}

#[derive(Debug, Serialize)]
struct ProbeDto {
    ok: bool,
    effective_base: String,
    candidates: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
fn probe_url(req: ProbeRequest) -> ProbeDto {
    let policy = if req.allow_private {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy::default()
    };
    let normalized = normalize_gateway_input(&req.base_url);
    let candidates = expand_base_candidates(&normalized);
    match validate_provider_url(&normalized, &policy) {
        Ok(u) => ProbeDto {
            ok: true,
            effective_base: u.to_string(),
            candidates,
            error: None,
        },
        Err(e) => ProbeDto {
            ok: false,
            effective_base: normalized,
            candidates,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
async fn check_ollama(base_url: String) -> bool {
    ollama_reachable(&base_url).await
}

#[tauri::command]
async fn run_preflight_cmd(state: State<'_, AppState>) -> Result<PreflightReport, String> {
    let cfg = state.config.lock().expect("config lock").clone();
    let ws = workspace_from_cfg(&cfg);
    let active = cfg.providers.active().cloned();
    let mut ollama_ok = None;
    let mut provider_ok = None;
    let mut key_present = None;
    if let Some(p) = &active {
        let desc = cd_core::providers::descriptor_for(p.kind);
        if p.kind == ProviderKind::Ollama {
            ollama_ok = Some(ollama_reachable(&p.base_url).await);
        } else if p.kind == ProviderKind::XaiGrokBuild {
            key_present = Some(cd_core::grok_auth::detect_grok_session().is_some());
            // #126: real probe (session + models list), not structural URL only.
            let outcome = cd_core::discovery::probe_provider(p, None).await;
            provider_ok = Some(outcome.is_reachable());
        } else if desc.needs_api_key {
            let ref_id = p
                .api_key_ref
                .clone()
                .unwrap_or_else(|| key_ref_for_profile(&p.id));
            let has = state.secrets.has(&ref_id).unwrap_or(false);
            key_present = Some(has);
            // #126: live HTTP probe (models list); never structural-only "responded".
            let api_key = if has {
                state.secrets.get(&ref_id).ok().flatten()
            } else {
                None
            };
            let outcome = cd_core::discovery::probe_provider(p, api_key).await;
            provider_ok = Some(outcome.is_reachable());
        }
    }
    let data_ok = ensure_config_dir(&state.branding).is_ok();
    let confluence_pat = if cfg.confluence.enabled {
        Some(
            state
                .secrets
                .has(&key_ref_confluence_pat())
                .unwrap_or(false),
        )
    } else {
        None
    };
    let grok_session_present = Some(cd_core::grok_auth::detect_grok_session().is_some());
    Ok(run_preflight(PreflightInput {
        workspace: ws.as_ref(),
        providers: &cfg.providers,
        data_dir_writable: data_ok,
        ollama_reachable: ollama_ok,
        provider_reachable: provider_ok,
        active_key_present: key_present,
        confluence: Some(&cfg.confluence),
        confluence_pat_present: confluence_pat,
        grok_session_present,
    }))
}

#[tauri::command]
fn get_confluence_settings(state: State<'_, AppState>) -> ConfluenceSettings {
    state.config.lock().expect("config").confluence.clone()
}

#[tauri::command]
fn get_web_research_enabled(state: State<'_, AppState>) -> bool {
    state.config.lock().expect("config").web_research_enabled
}

#[tauri::command]
fn get_hybrid_retrieval(state: State<'_, AppState>) -> bool {
    state.config.lock().expect("config").hybrid_retrieval
}

#[tauri::command]
fn set_hybrid_retrieval(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.hybrid_retrieval = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(enabled)
}

/// Ambient memory injection each turn (MEMORY.md §10.1 / #271). Default ON.
#[tauri::command]
fn get_ambient_recall_enabled(state: State<'_, AppState>) -> bool {
    state
        .config
        .lock()
        .expect("config")
        .memory
        .ambient_recall_enabled
}

#[tauri::command]
fn set_ambient_recall_enabled(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.memory.ambient_recall_enabled = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    // Rebuild host so attach_durable_memory picks up ambient flag.
    let _ = ensure_host(&state);
    Ok(enabled)
}

#[tauri::command]
fn get_router_budget(state: State<'_, AppState>) -> cd_core::router::RouterBudget {
    state.config.lock().expect("config").router.clone()
}

#[derive(Debug, Deserialize)]
struct SetRouterBudgetReq {
    max_sources: usize,
    max_tool_rounds: usize,
    max_results_per_source: usize,
    deadline_ms: u64,
}

#[tauri::command]
fn set_router_budget(
    state: State<'_, AppState>,
    req: SetRouterBudgetReq,
) -> Result<cd_core::router::RouterBudget, String> {
    let budget = cd_core::router::RouterBudget {
        max_sources: req.max_sources,
        max_tool_rounds: req.max_tool_rounds,
        max_results_per_source: req.max_results_per_source,
        deadline_ms: req.deadline_ms,
        order: cd_core::router::RouterBudget::default().order,
    }
    .sanitized();
    let mut cfg = state.config.lock().expect("config");
    cfg.router = budget.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(budget)
}

/// Open an http(s) URL in the **system** default browser.
///
/// WKWebView / Tauri does not treat `window.open` as a real browser launch.
/// Only http(s) is allowed — no `file:`, no custom schemes, no shell strings.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("empty URL".into());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only http(s) URLs may open in the system browser".into());
    }
    // Reject embedded credentials (https://user:pass@host/...).
    if let Some(rest) = url.split("://").nth(1) {
        if rest.contains('@') {
            return Err("credentials in URL are not allowed".into());
        }
    }
    // Basic length guard against abuse.
    if url.len() > 8_192 {
        return Err("URL too long".into());
    }
    open_url_in_default_browser(url)
}

fn open_url_in_default_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // `start` treats the first quoted arg as window title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        let _ = url;
        Err("opening the system browser is unsupported on this platform".into())
    }
}

#[tauri::command]
fn set_web_research_enabled(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.web_research_enabled = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    // Rebuild host so tool specs update for the next agent turn.
    let _ = ensure_host(&state);
    Ok(enabled)
}

/// List curated publisher RSS sources with effective enable flags.
#[tauri::command]
fn list_web_research_sources(
    state: State<'_, AppState>,
) -> Vec<cd_core::news_sources::NewsSourceDto> {
    let overrides = state
        .config
        .lock()
        .expect("config")
        .web_research_sources
        .clone();
    cd_core::news_sources::list_sources_dto(&overrides)
}

/// Save per-source enable map (merged with registry defaults on read).
#[tauri::command]
fn set_web_research_sources(
    state: State<'_, AppState>,
    sources: std::collections::HashMap<String, bool>,
) -> Result<Vec<cd_core::news_sources::NewsSourceDto>, String> {
    // Only persist known registry ids.
    let known: std::collections::HashSet<&str> = cd_core::news_sources::NEWS_SOURCES
        .iter()
        .map(|s| s.id)
        .collect();
    let filtered: std::collections::HashMap<String, bool> = sources
        .into_iter()
        .filter(|(k, _)| known.contains(k.as_str()))
        .collect();
    let mut cfg = state.config.lock().expect("config");
    cfg.web_research_sources = filtered;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    let dto = cd_core::news_sources::list_sources_dto(&cfg.web_research_sources);
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(dto)
}

#[derive(Debug, Deserialize)]
struct SaveConfluenceReq {
    enabled: bool,
    base_url: String,
    /// Comma or space separated space keys.
    spaces: String,
    /// Optional new PAT; empty means keep existing.
    pat: Option<String>,
}

#[tauri::command]
fn save_confluence_settings(
    state: State<'_, AppState>,
    req: SaveConfluenceReq,
) -> Result<ConfluenceSettings, String> {
    let spaces: Vec<String> = req
        .spaces
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if req.enabled && !base_url.is_empty() {
        let policy = SsrfPolicy::default();
        // Allow private wikis on corp networks via allow_private_networks if needed later.
        // For now default SSRF; users on private IP can use advanced override later.
        if let Err(e) = validate_provider_url(&base_url, &policy) {
            // Private corporate wikis: retry with private allowed
            if validate_provider_url(&base_url, &SsrfPolicy::allow_private_networks()).is_err() {
                return Err(format!("Invalid Confluence base URL: {e}"));
            }
        }
    }

    let mut pat_ref = state
        .config
        .lock()
        .expect("config")
        .confluence
        .pat_ref
        .clone();

    if let Some(pat) = req.pat {
        let pat = pat.trim();
        if !pat.is_empty() && !pat.chars().all(|c| c == '•') {
            state
                .secrets
                .set(&key_ref_confluence_pat(), pat)
                .map_err(|e| e.to_string())?;
            pat_ref = Some(CONFLUENCE_PAT_REF.to_string());
        }
    }

    let cf = ConfluenceSettings {
        enabled: req.enabled,
        base_url,
        spaces,
        pat_ref,
    };

    let mut cfg = state.config.lock().expect("config");
    cfg.confluence = cf.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(cf)
}

#[tauri::command]
fn confluence_has_token(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .secrets
        .has(&key_ref_confluence_pat())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_x_settings(state: State<'_, AppState>) -> XSettings {
    state.config.lock().expect("config").x.clone()
}

#[derive(Debug, Deserialize)]
struct SaveXReq {
    enabled: bool,
    /// Optional new bearer; empty means keep existing.
    api_key: Option<String>,
}

#[tauri::command]
fn save_x_settings(state: State<'_, AppState>, req: SaveXReq) -> Result<XSettings, String> {
    let mut api_key_ref = state.config.lock().expect("config").x.api_key_ref.clone();

    if let Some(key) = req.api_key {
        let key = key.trim();
        if !key.is_empty() && !key.chars().all(|c| c == '•') {
            state
                .secrets
                .set(&key_ref_x_api_key(), key)
                .map_err(|e| e.to_string())?;
            api_key_ref = Some(X_API_KEY_REF.to_string());
        }
    }

    let x = XSettings {
        enabled: req.enabled,
        api_key_ref,
    };

    let mut cfg = state.config.lock().expect("config");
    cfg.x = x.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(x)
}

#[tauri::command]
fn x_has_token(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .secrets
        .has(&key_ref_x_api_key())
        .map_err(|e| e.to_string())
}

/// Validate token presence (no live X API call — avoids burning quota / leaking status).
#[tauri::command]
fn test_x_config(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").x.clone();
    if !cfg.enabled {
        return Ok("X search disabled".into());
    }
    let has = state
        .secrets
        .has(&key_ref_x_api_key())
        .map_err(|e| e.to_string())?;
    if !has {
        return Err(
            "No X API bearer in secure storage. Paste a key under Connectors (paid X API plan)."
                .into(),
        );
    }
    Ok(
        "X enabled with a key on file. Search requires a paid/usable X API plan; free tier cannot search."
            .into(),
    )
}

/// Validate URL + token presence (no live network call to avoid leaking PAT to logs).
#[tauri::command]
fn test_confluence_config(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").confluence.clone();
    if !cfg.enabled {
        return Ok("Confluence disabled".into());
    }
    if cfg.base_url.trim().is_empty() {
        return Err("Base URL is required".into());
    }
    let has = state
        .secrets
        .has(&key_ref_confluence_pat())
        .map_err(|e| e.to_string())?;
    if !has {
        return Err("No personal access token in secure storage".into());
    }
    // SSRF check base URL
    let policy = SsrfPolicy::allow_private_networks();
    validate_provider_url(&cfg.base_url, &policy).map_err(|e| e.to_string())?;
    Ok(format!(
        "OK: URL valid, token present, {} space(s) allowlisted",
        cfg.spaces.len()
    ))
}

/// Instant path check for workspace settings UI (exists + readable directory).
#[tauri::command]
fn validate_workspace_path(path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("Path is empty".into());
    }
    if !p.exists() {
        return Err("Path does not exist".into());
    }
    if !p.is_dir() {
        return Err("Path is not a directory".into());
    }
    if cd_core::workspace::is_whole_home_directory(&p) {
        return Err(
            "Refusing whole home directory as a workspace root — pick a project folder".into(),
        );
    }
    // Readable: try listing one entry
    match std::fs::read_dir(&p) {
        Ok(_) => Ok(format!("Readable directory: {}", p.display())),
        Err(e) => Err(format!("Not readable: {e}")),
    }
}

/// Suggested OS-default workspace (Documents/<product>) without creating it.
#[derive(Serialize)]
struct DefaultWorkspaceDto {
    path: String,
    label: String,
    exists: bool,
}

#[tauri::command]
fn suggest_default_workspace(state: State<'_, AppState>) -> Result<DefaultWorkspaceDto, String> {
    let path = cd_core::workspace::default_workspace_root(&state.branding.name)
        .map_err(|e| e.to_string())?;
    Ok(DefaultWorkspaceDto {
        path: path.display().to_string(),
        label: cd_core::workspace::default_workspace_label(&state.branding.name),
        exists: path.is_dir(),
    })
}

/// Create Documents/<product> if needed and return its absolute path.
#[tauri::command]
fn ensure_default_workspace(state: State<'_, AppState>) -> Result<DefaultWorkspaceDto, String> {
    let path = cd_core::workspace::ensure_default_workspace_root(&state.branding.name)
        .map_err(|e| e.to_string())?;
    Ok(DefaultWorkspaceDto {
        path: path.display().to_string(),
        label: cd_core::workspace::default_workspace_label(&state.branding.name),
        exists: true,
    })
}

#[tauri::command]
fn set_workspace_roots(
    state: State<'_, AppState>,
    name: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let root_paths: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
    for r in &root_paths {
        if cd_core::workspace::is_whole_home_directory(r) {
            return Err(
                "Refusing whole home directory as a workspace root — pick a project folder".into(),
            );
        }
        if !r.exists() {
            return Err(format!("Root does not exist: {}", r.display()));
        }
    }
    let mut cfg = state.config.lock().expect("config lock");
    let id = cfg
        .workspace
        .as_ref()
        .map(|w| w.id.clone())
        .unwrap_or_else(|| format!("ws-{}", chrono_like()));
    cfg.workspace = Some(WorkspaceConfig {
        id,
        name,
        roots: root_paths,
    });
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    ensure_host(&state)
}

fn chrono_like() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct AgentTurnReq {
    session_id: String,
    text: String,
    /// Force offline retrieval (no LLM).
    #[serde(default)]
    force_local: bool,
    /// Optional per-turn / per-chat model override.
    #[serde(default)]
    chat_model: Option<String>,
    /// Optional provider profile id when model is chosen from a non-active source.
    #[serde(default)]
    provider_profile_id: Option<String>,
}

fn skill_dirs_for(state: &AppState, cfg: &AppConfig) -> Vec<std::path::PathBuf> {
    let config_dir = ensure_config_dir(&state.branding).ok();
    let roots: Vec<_> = cfg
        .workspace
        .as_ref()
        .map(|w| w.roots.clone())
        .unwrap_or_default();
    cd_core::skills::default_skill_dirs(config_dir.as_deref(), &roots)
}

#[derive(Debug, Serialize)]
struct SkillDto {
    id: String,
    name: String,
    description: String,
    disabled: bool,
    allows_write: bool,
    path: String,
    /// True when a sibling `module.toml` is present (#137).
    has_module: bool,
    module_id: Option<String>,
}

fn skill_to_dto(s: cd_core::skills::Skill) -> SkillDto {
    let module_id = cd_core::skills::skill_module_toml_path(&s)
        .and_then(|p| cd_core::modules::parse_module_file(&p).ok().map(|m| m.id));
    SkillDto {
        has_module: module_id.is_some(),
        module_id,
        id: s.id,
        name: s.name,
        description: s.description,
        disabled: s.disabled,
        allows_write: s.allows_write,
        path: s.path.display().to_string(),
    }
}

#[tauri::command]
fn list_skills_cmd(state: State<'_, AppState>) -> Result<Vec<SkillDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let dirs = skill_dirs_for(&state, &cfg);
    let skills = cd_core::skills::discover_skills(&dirs).map_err(|e| e.to_string())?;
    Ok(skills.into_iter().map(skill_to_dto).collect())
}

/// Result of enabling/disabling a skill (#137). May also request module capability approval.
#[derive(Debug, Serialize)]
struct SetSkillEnabledResult {
    id: String,
    enabled: bool,
    /// When enabling a skill that ships `module.toml`, module may need #135 approval.
    needs_module_approval: bool,
    module_id: Option<String>,
    preview: Option<String>,
    reason: Option<String>,
    type_confirm_phrase: Option<String>,
}

/// Persist skill enabled flag; when enabling a skill that ships `module.toml`,
/// install into the modules dir and request first-use capability approval (#135/#136/#137).
#[tauri::command]
fn set_skill_enabled_cmd(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<SetSkillEnabledResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("skill id required".into());
    }
    let cfg = state.config.lock().expect("config").clone();
    let dirs = skill_dirs_for(&state, &cfg);
    let skill =
        cd_core::skills::set_skill_enabled(&dirs, &id, enabled).map_err(|e| e.to_string())?;

    if !enabled {
        // Disabling the skill does not force-remove the module install; user manages Modules.
        return Ok(SetSkillEnabledResult {
            id: skill.id,
            enabled: false,
            needs_module_approval: false,
            module_id: None,
            preview: None,
            reason: None,
            type_confirm_phrase: None,
        });
    }

    // Optional tool-shipping: provision sibling module.toml through #136 path.
    let Some(src_dir) = cd_core::skills::skill_module_src_dir(&skill) else {
        return Ok(SetSkillEnabledResult {
            id: skill.id,
            enabled: true,
            needs_module_approval: false,
            module_id: None,
            preview: None,
            reason: None,
            type_confirm_phrase: None,
        });
    };

    let mdir = modules_dir(&state)?;
    let m =
        cd_core::modules::install_module_from_dir(&src_dir, &mdir).map_err(|e| e.to_string())?;
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;

    if !cd_core::modules::module_tools_allowed(&m, &grants) {
        let req = cd_core::modules::permission_request_for_module_enable(&m);
        return Ok(SetSkillEnabledResult {
            id: skill.id,
            enabled: true,
            needs_module_approval: true,
            module_id: Some(m.id),
            preview: Some(req.preview.clone()),
            reason: Some(req.reason.clone()),
            type_confirm_phrase: req.type_confirm_phrase.clone(),
        });
    }

    // Already granted or no caps required — enable module tools.
    {
        let mut cfg = state.config.lock().expect("config");
        if !cfg.enabled_modules.iter().any(|x| x == &m.id) {
            cfg.enabled_modules.push(m.id.clone());
        }
        let path = config_path(&state.branding).map_err(|e| e.to_string())?;
        save_config(&path, &cfg).map_err(|e| e.to_string())?;
    }
    let _ = ensure_host(&state);

    Ok(SetSkillEnabledResult {
        id: skill.id,
        enabled: true,
        needs_module_approval: false,
        module_id: Some(m.id),
        preview: None,
        reason: None,
        type_confirm_phrase: None,
    })
}

/// Module row for Settings (#136). No secrets.
#[derive(Clone, serde::Serialize)]
struct ModuleDto {
    id: String,
    name: String,
    version: String,
    enabled: bool,
    granted: bool,
    path: String,
    entrypoint: String,
    requested_filesystem_roots: Vec<String>,
    requested_network_hosts: Vec<String>,
    requested_secret_refs: Vec<String>,
    hard_write_tools: Vec<String>,
    provided_tools: Vec<String>,
}

fn modules_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    let config_dir = ensure_config_dir(&state.branding).map_err(|e| e.to_string())?;
    Ok(cd_core::modules::default_modules_dir(&config_dir))
}

fn grants_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    let config_dir = ensure_config_dir(&state.branding).map_err(|e| e.to_string())?;
    Ok(config_dir.join("module_grants.json"))
}

#[tauri::command]
fn list_modules(state: State<'_, AppState>) -> Result<Vec<ModuleDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let dir = modules_dir(&state)?;
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;
    let found = cd_core::modules::discover_modules(&[dir]).map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|m| ModuleDto {
            enabled: cfg.enabled_modules.iter().any(|x| x == &m.id),
            granted: grants.is_granted(&m.id),
            path: m.path.display().to_string(),
            entrypoint: m.entrypoint.command.display().to_string(),
            requested_filesystem_roots: m
                .requested_capabilities
                .filesystem_roots
                .iter()
                .map(|p| p.display().to_string())
                .collect(),
            requested_network_hosts: m.requested_capabilities.network_hosts,
            requested_secret_refs: m.requested_capabilities.secret_refs,
            hard_write_tools: m.hard_write_tools,
            provided_tools: m.provided_tools.iter().map(|t| t.name.clone()).collect(),
            id: m.id,
            name: m.name,
            version: m.version,
        })
        .collect())
}

/// Install from a **local** directory only (NON_GOALS #7 — no network install).
#[tauri::command]
fn install_module(state: State<'_, AppState>, path: String) -> Result<ModuleDto, String> {
    let src = std::path::PathBuf::from(path.trim());
    let dir = modules_dir(&state)?;
    let m = cd_core::modules::install_module_from_dir(&src, &dir).map_err(|e| e.to_string())?;
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;
    Ok(ModuleDto {
        enabled: false,
        granted: grants.is_granted(&m.id),
        path: m.path.display().to_string(),
        entrypoint: m.entrypoint.command.display().to_string(),
        requested_filesystem_roots: m
            .requested_capabilities
            .filesystem_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        requested_network_hosts: m.requested_capabilities.network_hosts,
        requested_secret_refs: m.requested_capabilities.secret_refs,
        hard_write_tools: m.hard_write_tools,
        provided_tools: m.provided_tools.iter().map(|t| t.name.clone()).collect(),
        id: m.id,
        name: m.name,
        version: m.version,
    })
}

#[derive(Clone, serde::Serialize)]
struct SetModuleEnabledResult {
    enabled: bool,
    /// When true, UI must show permission modal before tools attach.
    needs_approval: bool,
    module_id: String,
    risk: String,
    type_confirm_phrase: Option<String>,
    preview: String,
    reason: String,
    request_id: String,
}

#[tauri::command]
fn set_module_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<SetModuleEnabledResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("module id required".into());
    }
    let dir = modules_dir(&state)?;
    let found = cd_core::modules::discover_modules(&[dir]).map_err(|e| e.to_string())?;
    let m = found
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| format!("module `{id}` not installed"))?;

    if enabled {
        let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
            .map_err(|e| e.to_string())?;
        if !cd_core::modules::module_tools_allowed(&m, &grants) {
            let req = cd_core::modules::permission_request_for_module_enable(&m);
            return Ok(SetModuleEnabledResult {
                enabled: false,
                needs_approval: true,
                module_id: m.id,
                risk: req.risk,
                type_confirm_phrase: req.type_confirm_phrase,
                preview: req.preview,
                reason: req.reason,
                request_id: req.request_id,
            });
        }
        let mut cfg = state.config.lock().expect("config");
        if !cfg.enabled_modules.iter().any(|x| x == &id) {
            cfg.enabled_modules.push(id.clone());
        }
        let path = config_path(&state.branding).map_err(|e| e.to_string())?;
        save_config(&path, &cfg).map_err(|e| e.to_string())?;
        drop(cfg);
        let _ = ensure_host(&state);
        return Ok(SetModuleEnabledResult {
            enabled: true,
            needs_approval: false,
            module_id: id,
            risk: "local".into(),
            type_confirm_phrase: None,
            preview: String::new(),
            reason: String::new(),
            request_id: String::new(),
        });
    }

    // Disable
    let mut cfg = state.config.lock().expect("config");
    cfg.enabled_modules.retain(|x| x != &id);
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(SetModuleEnabledResult {
        enabled: false,
        needs_approval: false,
        module_id: id,
        risk: "local".into(),
        type_confirm_phrase: None,
        preview: String::new(),
        reason: String::new(),
        request_id: String::new(),
    })
}

/// Complete first-use module capability approval (#135/#136) then enable.
#[tauri::command]
fn approve_module_enable(
    state: State<'_, AppState>,
    id: String,
    decision: String,
    typed: Option<String>,
) -> Result<bool, String> {
    let id = id.trim().to_string();
    let dir = modules_dir(&state)?;
    let found = cd_core::modules::discover_modules(&[dir]).map_err(|e| e.to_string())?;
    let m = found
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| format!("module `{id}` not installed"))?;
    let req = cd_core::modules::permission_request_for_module_enable(&m);
    let dec = match decision.as_str() {
        "deny" => cd_core::permissions::PermissionDecision::Deny,
        "allow_once" => cd_core::permissions::PermissionDecision::AllowOnce,
        "allow_session_path" => cd_core::permissions::PermissionDecision::AllowSessionPath,
        _ => return Err("invalid decision".into()),
    };
    cd_core::permissions::validate_decision(&req, dec, typed.as_deref())?;
    if matches!(dec, cd_core::permissions::PermissionDecision::Deny) {
        return Ok(false);
    }
    let gpath = grants_path(&state)?;
    let mut grants = cd_core::modules::ModuleGrantStore::load(&gpath).map_err(|e| e.to_string())?;
    grants
        .grant_from_ui(&m.id, m.requested_capabilities.clone(), dec)
        .map_err(|e| e.to_string())?;
    grants.save(&gpath).map_err(|e| e.to_string())?;

    let mut cfg = state.config.lock().expect("config");
    if !cfg.enabled_modules.iter().any(|x| x == &id) {
        cfg.enabled_modules.push(id);
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(true)
}

#[tauri::command]
fn remove_module(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let id = id.trim().to_string();
    let mut cfg = state.config.lock().expect("config");
    cfg.enabled_modules.retain(|x| x != &id);
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let dir = modules_dir(&state)?;
    cd_core::modules::remove_module_dir(&dir, &id).map_err(|e| e.to_string())?;
    let gpath = grants_path(&state)?;
    if let Ok(mut grants) = cd_core::modules::ModuleGrantStore::load(&gpath) {
        grants.revoke(&id);
        let _ = grants.save(&gpath);
    }
    let _ = ensure_host(&state);
    Ok(true)
}

/// Module registry settings (#139). Empty URL by default; no company hardcode.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModuleRegistrySettingsDto {
    enabled: bool,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
struct ModuleRegistryEntryDto {
    id: String,
    name: String,
    version: String,
    description: String,
    homepage: Option<String>,
    local_path: Option<String>,
    /// True when Install can hand off to #136 with a local path.
    can_install_local: bool,
}

/// Get registry browse settings (defaults: disabled, empty URL).
#[tauri::command]
fn get_module_registry_settings(
    state: State<'_, AppState>,
) -> Result<ModuleRegistrySettingsDto, String> {
    let cfg = state.config.lock().expect("config");
    Ok(ModuleRegistrySettingsDto {
        enabled: cfg.module_registry_enabled,
        url: cfg.module_registry_url.clone(),
    })
}

/// Persist registry opt-in + URL. Does **not** fetch or install (NON_GOALS #7).
#[tauri::command]
fn set_module_registry_settings(
    state: State<'_, AppState>,
    enabled: bool,
    url: String,
) -> Result<ModuleRegistrySettingsDto, String> {
    let url = url.trim().to_string();
    if enabled && !url.is_empty() {
        // SSRF gate on save so bad URLs fail early (no fetch yet).
        cd_core::module_registry::validate_registry_fetch_url(&url, &SsrfPolicy::default())
            .map_err(|e| e.to_string())?;
    }
    let mut cfg = state.config.lock().expect("config");
    cfg.module_registry_enabled = enabled;
    cfg.module_registry_url = url.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(ModuleRegistrySettingsDto { enabled, url })
}

/// Browse registry **metadata only** (#139).
///
/// Never installs or executes modules (docs/NON_GOALS.md #7). Remote fetch uses
/// SSRF-pinned HTTP when enabled; optional `file_path` loads a local JSON index
/// (offline browse; no code execution).
#[tauri::command]
async fn browse_module_registry(
    state: State<'_, AppState>,
    file_path: Option<String>,
) -> Result<Vec<ModuleRegistryEntryDto>, String> {
    let idx = if let Some(fp) = file_path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // Local JSON only — still metadata; does not install.
        let text = std::fs::read_to_string(fp).map_err(|e| format!("read registry file: {e}"))?;
        cd_core::module_registry::parse_registry_json(&text).map_err(|e| e.to_string())?
    } else {
        let cfg = state.config.lock().expect("config").clone();
        if !cd_core::module_registry::registry_browse_enabled(
            cfg.module_registry_enabled,
            &cfg.module_registry_url,
        ) {
            return Err(
                "registry browse is disabled (enable and set a URL, or pass a local file path)"
                    .into(),
            );
        }
        // Network: metadata JSON only — never module code / install (NON_GOALS #7).
        cd_core::module_registry::fetch_registry_index(
            &cfg.module_registry_url,
            &SsrfPolicy::default(),
        )
        .await
        .map_err(|e| e.to_string())?
    };
    Ok(idx
        .entries
        .into_iter()
        .map(|e| {
            let can = cd_core::module_registry::install_path_for_entry(&e).is_some();
            ModuleRegistryEntryDto {
                id: e.id,
                name: e.name,
                version: e.version,
                description: e.description,
                homepage: e.homepage,
                local_path: e.local_path,
                can_install_local: can,
            }
        })
        .collect())
}

/// Re-install from a local path (same id); local only (NON_GOALS #7).
#[tauri::command]
fn update_module(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<ModuleDto, String> {
    let id = id.trim().to_string();
    let src = std::path::PathBuf::from(path.trim());
    let dir = modules_dir(&state)?;
    let m = cd_core::modules::update_module_from_dir(&src, &dir).map_err(|e| e.to_string())?;
    if m.id != id {
        return Err(format!(
            "source module id `{}` does not match update target `{id}`",
            m.id
        ));
    }
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;
    let cfg = state.config.lock().expect("config");
    Ok(ModuleDto {
        enabled: cfg.enabled_modules.iter().any(|x| x == &m.id),
        granted: grants.is_granted(&m.id),
        path: m.path.display().to_string(),
        entrypoint: m.entrypoint.command.display().to_string(),
        requested_filesystem_roots: m
            .requested_capabilities
            .filesystem_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        requested_network_hosts: m.requested_capabilities.network_hosts,
        requested_secret_refs: m.requested_capabilities.secret_refs,
        hard_write_tools: m.hard_write_tools,
        provided_tools: m.provided_tools.iter().map(|t| t.name.clone()).collect(),
        id: m.id,
        name: m.name,
        version: m.version,
    })
}

/// Propose authoring a skill via the SoftWrite tool host path (PermissionRequired).
/// Does **not** write until the UI completes the grant and re-executes.
#[tauri::command]
async fn propose_save_skill_cmd(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    body: String,
    allows_write: bool,
) -> Result<Vec<EventDto>, String> {
    ensure_host(&state)?;
    // #114: do not hold MutexGuard across `.await` (Send bound).
    let mut host = {
        let mut host_guard = state.host.lock().expect("host");
        host_guard.take().ok_or("host missing")?
    };
    let args = serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "body_markdown": body,
        "allows_write": allows_write,
    });
    let result = host
        .execute(cd_core::tools::names::SAVE_SKILL, &args, None)
        .await
        .map_err(|e| e.to_string());
    {
        let mut host_guard = state.host.lock().expect("host");
        *host_guard = Some(host);
    }
    let result = result?;
    Ok(events_to_dto(&result.events))
}

#[tauri::command]
async fn agent_turn(
    state: State<'_, AppState>,
    req: AgentTurnReq,
    on_event: tauri::ipc::Channel<EventDto>,
) -> Result<(), String> {
    ensure_host(&state)?;
    let cfg = state.config.lock().expect("config").clone();
    let skill_dirs = skill_dirs_for(&state, &cfg);
    let mut user_text = req.text.clone();
    // Inject skill playbook into the query prefix for agent context (cannot elevate grants).
    if let Some((sid, rest)) = cd_core::skills::parse_skill_slash(&user_text) {
        if let Ok(skills) = cd_core::skills::discover_skills(&skill_dirs) {
            if let Some(sk) = cd_core::skills::find_skill(&skills, &sid) {
                if !sk.disabled {
                    let ctx = cd_core::skills::skill_context(sk);
                    user_text = if rest.is_empty() {
                        format!("{ctx}\n\nApply this skill to the workspace context.")
                    } else {
                        format!("{ctx}\n\nUser question: {rest}")
                    };
                }
            }
        }
    }
    let mut profile = if let Some(pid) = req
        .provider_profile_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        cfg.providers
            .profiles
            .iter()
            .find(|p| p.id == pid)
            .cloned()
            .or_else(|| cfg.providers.active().cloned())
            .unwrap_or_else(ProviderProfile::ollama_local)
    } else {
        cfg.providers
            .active()
            .cloned()
            .unwrap_or_else(ProviderProfile::ollama_local)
    };
    // Per-chat model override (mid-chat switch), else app default, else profile model.
    if let Some(m) = req
        .chat_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // Accept bare model id or provider::model selection key.
        let (_pid, mid) = parse_selection_key(m);
        profile.chat_model = mid;
    } else if let Some(m) = cfg
        .default_chat_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        profile.chat_model = m.to_string();
    }
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| state.secrets.get(r).ok().flatten());

    let mut history = {
        let mut histories = state.histories.lock().expect("hist");
        histories.entry(req.session_id.clone()).or_default().clone()
    };

    // Fresh cancel flag for this turn (#109).
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.insert(req.session_id.clone(), cancel.clone());
    }

    let channel = on_event;
    let mut sink = |ev: cd_core::events::StreamEvent| {
        let dto = cd_core::research::event_to_dto(&ev);
        let _ = channel.send(dto);
    };

    // #114: take host out of the mutex so we never hold it across `.await`.
    // No block_in_place — turn is a normal async future.
    let mut host = {
        let mut host_guard = state.host.lock().expect("host");
        host_guard.take().ok_or("host missing")?
    };
    let result = if req.force_local {
        let ev = cd_core::research::research_local_with_skills(
            &mut host,
            &user_text,
            &req.session_id,
            &skill_dirs,
        )
        .await
        .map_err(|e| e.to_string());
        if let Ok(ref events) = ev {
            for e in events {
                sink(e.clone());
            }
        }
        ev
    } else {
        cd_core::research::research_turn_with_cancel(
            &mut host,
            &profile,
            api_key,
            &user_text,
            &mut history,
            &req.session_id,
            false,
            Some(cancel.clone()),
            Some(&mut sink),
        )
        .await
        .map_err(|e| e.to_string())
    };
    {
        let mut host_guard = state.host.lock().expect("host");
        *host_guard = Some(host);
    }

    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.remove(&req.session_id);
    }
    {
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(req.session_id.clone(), history);
    }
    result.map(|_| ())
}

/// Signal cooperative cancel for an in-flight turn (#109).
#[tauri::command]
fn cancel_turn(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = cancels.get(&session_id) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

/// List durable chat sessions (newest first).
#[tauri::command]
fn list_chat_sessions(state: State<'_, AppState>) -> Result<Vec<SessionMeta>, String> {
    session_store(&state)?
        .list_meta()
        .map_err(|e| e.to_string())
}

/// Load one session and seed in-memory agent history.
#[tauri::command]
fn load_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let store = session_store(&state)?;
    let session = store.load(&id).map_err(|e| e.to_string())?;
    seed_history_from_session(&state, &session);
    Ok(session)
}

/// Persist full UI session (auto-save path). Seeds agent history.
#[tauri::command]
fn save_chat_session(state: State<'_, AppState>, mut session: Session) -> Result<Session, String> {
    session.maybe_auto_title_from_first_user();
    session.touch();
    // Do not persist empty never-messaged drafts under placeholder titles.
    if session.messages.is_empty() {
        return Ok(session);
    }
    let store = session_store(&state)?;
    store.save(&session).map_err(|e| e.to_string())?;
    seed_history_from_session(&state, &session);
    Ok(session)
}

/// Rename session; locks auto-title when title is non-placeholder.
#[tauri::command]
fn rename_chat_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<Session, String> {
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("title cannot be empty".into());
    }
    session.title = title;
    session.title_locked = !cd_core::sessions::is_placeholder_title(&session.title);
    session.touch();
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Soft-delete: move session to trash (recoverable).
#[tauri::command]
fn trash_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let session = session_store(&state)?
        .trash(&id)
        .map_err(|e| e.to_string())?;
    let mut histories = state.histories.lock().expect("hist");
    histories.remove(&id);
    Ok(session)
}

/// Restore a session from trash.
#[tauri::command]
fn restore_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    session_store(&state)?
        .restore_from_trash(&id)
        .map_err(|e| e.to_string())
}

/// Permanently delete session file and drop in-memory history.
#[tauri::command]
fn delete_chat_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    session_store(&state)?
        .delete(&id)
        .map_err(|e| e.to_string())?;
    let mut histories = state.histories.lock().expect("hist");
    histories.remove(&id);
    Ok(())
}

/// Pin / unpin a chat for the sidebar.
#[tauri::command]
fn pin_chat_session(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<Session, String> {
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    session.pinned = pinned;
    session.touch();
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Soft-archive / unarchive a chat.
#[tauri::command]
fn archive_chat_session(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> Result<Session, String> {
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    session.archived = archived;
    if archived {
        session.pinned = false;
    }
    session.touch();
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Keyword search across the chat archive (title + body scoring).
#[tauri::command]
fn search_chat_sessions(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    include_archived: Option<bool>,
    include_trashed: Option<bool>,
    only_trashed: Option<bool>,
) -> Result<Vec<SessionSearchHit>, String> {
    session_store(&state)?
        .search(
            &query,
            limit.unwrap_or(50),
            include_archived.unwrap_or(false),
            include_trashed.unwrap_or(false),
            only_trashed.unwrap_or(false),
        )
        .map_err(|e| e.to_string())
}

/// A selectable chat model for the UI (grouped by provider source).
#[derive(Debug, Clone, Serialize)]
struct ModelOptionDto {
    /// Model id as sent to the API (e.g. `grok-3`, `mistral`).
    id: String,
    /// Display label (usually same as id).
    label: String,
    /// Unique select value: `provider_id::model_id`.
    selection_key: String,
    /// Provider profile this model belongs to.
    provider_id: String,
    /// Human group label for `<optgroup>` (e.g. "Ollama (local)").
    provider_label: String,
    /// Stable group key for sorting/grouping.
    group: String,
    /// True when this is the app default for new chats.
    is_default: bool,
}

fn model_selection_key(provider_id: &str, model_id: &str) -> String {
    format!("{provider_id}::{model_id}")
}

fn parse_selection_key(key: &str) -> (Option<String>, String) {
    if let Some((pid, mid)) = key.split_once("::") {
        if !pid.is_empty() && !mid.is_empty() {
            return (Some(pid.to_string()), mid.to_string());
        }
    }
    (None, key.to_string())
}

fn provider_group_label(p: &ProviderProfile) -> String {
    let desc = cd_core::providers::descriptor_for(p.kind);
    // Prefer a non-empty custom profile label for local/gateway groups.
    if !p.label.trim().is_empty()
        && matches!(
            p.kind,
            ProviderKind::Ollama | ProviderKind::OpenAiCompatible
        )
    {
        return p.label.clone();
    }
    desc.group_label.to_string()
}

/// Keep almost everything for the picker (TriageTool shows full catalogs).
/// Only drop clear non-chat tooling entries.
fn looks_like_chat_model_id(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    if l.contains("embed")
        || l.contains("text-embedding")
        || l.contains("whisper")
        || l.contains("tts-")
        || l.contains("dall-e")
        || l.contains("moderation")
        || l.contains("realtime")
        || l.contains("transcri")
        || l.contains("speech")
    {
        return false;
    }
    // "image" alone is too aggressive (filters valid vision/chat names);
    // only drop explicit image-generation product ids.
    if l.contains("dall") || l.starts_with("image-") || l.contains("-image-") {
        return false;
    }
    true
}

fn resolve_default_model(cfg: &AppConfig) -> String {
    if let Some(m) = cfg
        .default_chat_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return m.to_string();
    }
    cfg.providers
        .active()
        .map(|p| p.chat_model.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "mistral".into())
}

fn resolve_default_selection(cfg: &AppConfig) -> String {
    let model = resolve_default_model(cfg);
    let pid = cfg
        .providers
        .active()
        .map(|p| p.id.as_str())
        .unwrap_or("ollama-local");
    model_selection_key(pid, &model)
}

async fn models_for_profile(
    profile: &ProviderProfile,
    secrets: &KeychainSecretStore,
) -> Vec<String> {
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| secrets.get(r).ok().flatten());
    models_for_profile_with_key(profile, api_key.as_deref()).await
}

/// List chat models for the **Settings draft** (not only the saved profile).
///
/// Used when the user pastes a base URL / key so the model field can become a
/// select (TriageTool-style discover-on-URL), before Save.
#[derive(Debug, Deserialize)]
struct ListModelsDraftReq {
    kind: String,
    base_url: String,
    /// Optional not-yet-saved key (never logged). Empty → try keychain for kind.
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    local_only: Option<bool>,
    #[serde(default)]
    chat_model: Option<String>,
}

#[tauri::command]
async fn list_models_for_draft(
    state: State<'_, AppState>,
    req: ListModelsDraftReq,
) -> Result<Vec<String>, String> {
    let kind = match req.kind.as_str() {
        "ollama" => ProviderKind::Ollama,
        "openai_compatible" => ProviderKind::OpenAiCompatible,
        "anthropic" => ProviderKind::Anthropic,
        "xai_grok_build" => ProviderKind::XaiGrokBuild,
        other => return Err(format!("unsupported provider kind: {other}")),
    };
    let desc = cd_core::providers::descriptor_for(kind);
    let id = desc.profile_id_slug.to_string();
    let mut base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        if let Some(def) = desc.default_base_url {
            base_url = def.to_string();
        }
    }
    // Normalize gateway paste (…/v1/models → …/v1) like probe_url.
    if matches!(
        kind,
        ProviderKind::OpenAiCompatible | ProviderKind::Anthropic | ProviderKind::XaiGrokBuild
    ) {
        base_url = normalize_gateway_input(&base_url);
    }

    let local_only = req.local_only.unwrap_or(desc.is_local);
    let chat_model = req
        .chat_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("mistral")
        .to_string();

    // Prefer draft paste; else keychain for this profile slug.
    let draft_key = req
        .api_key
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '•'));
    let api_key = if matches!(kind, ProviderKind::XaiGrokBuild) {
        None
    } else if let Some(k) = draft_key {
        Some(k)
    } else {
        let r = key_ref_for_profile(&id);
        state.secrets.get(&r).ok().flatten()
    };

    // Also reuse saved profile ref if config has a different key ref for this id.
    let api_key = if api_key.is_none() && !matches!(kind, ProviderKind::XaiGrokBuild) {
        let cfg = state.config.lock().expect("config");
        if let Some(p) = cfg.providers.profiles.iter().find(|p| p.id == id) {
            p.api_key_ref
                .as_ref()
                .and_then(|r| state.secrets.get(r).ok().flatten())
        } else {
            None
        }
    } else {
        api_key
    };

    let profile = ProviderProfile {
        id: id.clone(),
        label: desc.default_label.to_string(),
        kind,
        base_url,
        api_key_ref: None,
        chat_model,
        embedding_model: None,
        embedding_base_url: None,
        local_only,
        capabilities: desc.default_capabilities,
    };

    // models_for_profile expects key from secrets path for OpenAI — pass via temporary:
    // we already resolved api_key above; inject by calling logic with a one-off.
    // Reuse models_for_profile by temporarily using secrets is awkward; call with
    // a thin duplicate that accepts Option key — here we shadow secrets via profile
    // path only when key is in keychain. So push key into a local list helper.
    let ids = models_for_profile_with_key(&profile, api_key.as_deref()).await;
    Ok(ids)
}

/// Like `models_for_profile` but accepts an already-resolved API key (draft paste).
///
/// For remote gateways, walks `expand_base_candidates` (TriageTool parity) and
/// keeps the **largest** successful model list so corporate path shapes work.
async fn models_for_profile_with_key(
    profile: &ProviderProfile,
    api_key: Option<&str>,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    match profile.kind {
        ProviderKind::Ollama => {
            if let Ok(client) =
                cd_core::chat::OllamaClient::new(&profile.base_url, &profile.chat_model)
            {
                if let Ok(tags) = client.list_tags().await {
                    ids.extend(tags.into_iter().filter(|m| looks_like_chat_model_id(m)));
                }
            }
        }
        ProviderKind::OpenAiCompatible => {
            let policy = if profile.local_only {
                SsrfPolicy::local_only()
            } else {
                SsrfPolicy::default()
            };
            let candidates = expand_base_candidates(&profile.base_url);
            let mut best: Vec<String> = Vec::new();
            for base in candidates {
                if let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                    &base,
                    api_key.map(|s| s.to_string()),
                    &profile.chat_model,
                    &policy,
                ) {
                    if let Ok(listed) = client.list_models().await {
                        let filtered: Vec<String> = listed
                            .into_iter()
                            .filter(|m| looks_like_chat_model_id(m))
                            .collect();
                        if filtered.len() > best.len() {
                            best = filtered;
                        }
                    }
                }
            }
            ids.extend(best);
        }
        ProviderKind::XaiGrokBuild => {
            ids.extend(
                ["grok-3", "grok-3-mini", "grok-2", "grok-2-vision-1212"]
                    .into_iter()
                    .map(str::to_string),
            );
            let base = if profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1"
            } else {
                profile.base_url.trim()
            };
            if cd_core::grok_auth::assert_grok_base_allowed(base).is_ok() {
                if let Ok(creds) = cd_core::grok_auth::load_grok_session_credentials() {
                    if let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                        base,
                        None,
                        &profile.chat_model,
                        &SsrfPolicy::default(),
                    ) {
                        let client = client.with_extra_headers(creds.request_headers());
                        if let Ok(listed) = client.list_models().await {
                            for m in listed.into_iter().filter(|m| looks_like_chat_model_id(m)) {
                                if !ids.iter().any(|x| x == &m) {
                                    ids.push(m);
                                }
                            }
                        }
                    }
                }
            }
        }
        ProviderKind::Anthropic => {
            let policy = if profile.local_only {
                SsrfPolicy::local_only()
            } else {
                SsrfPolicy::default()
            };
            let candidates = expand_base_candidates(&profile.base_url);
            let mut best: Vec<String> = Vec::new();
            for base in candidates {
                if let Ok(client) = cd_core::chat::AnthropicClient::new(
                    &base,
                    api_key.map(|s| s.to_string()),
                    &profile.chat_model,
                    &policy,
                ) {
                    if let Ok(listed) = client.list_models().await {
                        let filtered: Vec<String> = listed
                            .into_iter()
                            .filter(|m| looks_like_chat_model_id(m))
                            .collect();
                        if filtered.len() > best.len() {
                            best = filtered;
                        }
                    }
                }
            }
            ids.extend(best);
        }
    }

    let profile_model = profile.chat_model.trim();
    if !profile_model.is_empty() && !ids.iter().any(|x| x == profile_model) {
        ids.insert(0, profile_model.to_string());
    }
    ids.sort();
    ids.dedup();
    ids
}

/// List models from **all** configured providers, for grouped UI selection.
#[tauri::command]
async fn list_chat_models(state: State<'_, AppState>) -> Result<Vec<ModelOptionDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let default_model = resolve_default_model(&cfg);
    let default_pid = cfg
        .providers
        .active()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| "ollama-local".into());
    let default_key = model_selection_key(&default_pid, &default_model);

    let mut profiles = cfg.providers.profiles.clone();
    if profiles.is_empty() {
        profiles.push(ProviderProfile::ollama_local());
    }

    let mut out: Vec<ModelOptionDto> = Vec::new();
    for profile in &profiles {
        let ids = models_for_profile(profile, &state.secrets).await;
        let group = provider_group_label(profile);
        for id in ids {
            let selection_key = model_selection_key(&profile.id, &id);
            out.push(ModelOptionDto {
                is_default: selection_key == default_key
                    || (id == default_model && profile.id == default_pid),
                label: id.clone(),
                selection_key,
                id,
                provider_id: profile.id.clone(),
                provider_label: group.clone(),
                group: group.clone(),
            });
        }
    }

    // Ensure default is present even if listing failed for that provider.
    if !out.iter().any(|m| m.selection_key == default_key) {
        let label = cfg
            .providers
            .active()
            .map(provider_group_label)
            .unwrap_or_else(|| "Default".into());
        out.insert(
            0,
            ModelOptionDto {
                id: default_model.clone(),
                label: default_model.clone(),
                selection_key: default_key.clone(),
                provider_id: default_pid,
                provider_label: label.clone(),
                group: label,
                is_default: true,
            },
        );
    }

    // Group order: active provider first, then alpha by group, then model id.
    let active_id = cfg.providers.active_id.clone().unwrap_or_default();
    out.sort_by(|a, b| {
        let a_act = a.provider_id == active_id;
        let b_act = b.provider_id == active_id;
        b_act
            .cmp(&a_act)
            .then_with(|| a.group.cmp(&b.group))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(out)
}

/// Set default model for new chats. `selection` may be `provider::model` or bare model id.
#[tauri::command]
fn set_default_chat_model(state: State<'_, AppState>, model: String) -> Result<String, String> {
    let raw = model.trim().to_string();
    if raw.is_empty() {
        return Err("model id is required".into());
    }
    let (provider_id, model_id) = parse_selection_key(&raw);
    if model_id.is_empty() {
        return Err("model id is required".into());
    }
    let mut cfg = state.config.lock().expect("config");
    cfg.default_chat_model = Some(model_id.clone());
    if let Some(pid) = provider_id {
        if cfg.providers.profiles.iter().any(|p| p.id == pid) {
            cfg.providers.active_id = Some(pid.clone());
            if let Some(p) = cfg.providers.profiles.iter_mut().find(|p| p.id == pid) {
                p.chat_model = model_id.clone();
            }
        }
    } else if let Some(active_id) = cfg.providers.active_id.clone() {
        if let Some(p) = cfg
            .providers
            .profiles
            .iter_mut()
            .find(|p| p.id == active_id)
        {
            p.chat_model = model_id.clone();
        }
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(model_selection_key(
        cfg.providers.active_id.as_deref().unwrap_or("ollama-local"),
        &model_id,
    ))
}

/// Read resolved default selection key (`provider::model`).
#[tauri::command]
fn get_default_chat_model(state: State<'_, AppState>) -> String {
    let cfg = state.config.lock().expect("config");
    resolve_default_selection(&cfg)
}

/// One-shot LLM title (falls back to short heuristic if model unavailable).
async fn llm_title_for_prompt(state: &AppState, prompt: &str) -> String {
    let fallback = title_from_prompt(prompt, 40);
    if prompt.trim().is_empty() {
        return fallback;
    }
    let cfg = state.config.lock().expect("config").clone();
    let profile = cfg
        .providers
        .active()
        .cloned()
        .unwrap_or_else(ProviderProfile::ollama_local);
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| state.secrets.get(r).ok().flatten());

    let messages = vec![
        ChatMessage {
            role: ChatRole::System,
            content: "You only output a short chat title. No explanation.".into(),
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: ChatRole::User,
            content: session_title_llm_prompt(prompt),
            tool_call_id: None,
            tool_calls: None,
        },
    ];

    let raw = match profile.kind {
        ProviderKind::Ollama => {
            let Ok(client) =
                cd_core::chat::OllamaClient::new(&profile.base_url, &profile.chat_model)
            else {
                return fallback;
            };
            match client.complete(&messages, None).await {
                Ok(c) => c.content,
                Err(_) => return fallback,
            }
        }
        ProviderKind::OpenAiCompatible => {
            let policy = if profile.local_only {
                SsrfPolicy::local_only()
            } else {
                SsrfPolicy::default()
            };
            let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                &profile.base_url,
                api_key,
                &profile.chat_model,
                &policy,
            ) else {
                return fallback;
            };
            match client.complete(&messages, None).await {
                Ok(c) => c.content,
                Err(_) => return fallback,
            }
        }
        ProviderKind::XaiGrokBuild => {
            let base = if profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1"
            } else {
                profile.base_url.trim()
            };
            if cd_core::grok_auth::assert_grok_base_allowed(base).is_err() {
                return fallback;
            }
            let Ok(creds) = cd_core::grok_auth::load_grok_session_credentials() else {
                return fallback;
            };
            let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                base,
                None,
                &profile.chat_model,
                &SsrfPolicy::default(),
            ) else {
                return fallback;
            };
            let client = client.with_extra_headers(creds.request_headers());
            match client.complete(&messages, None).await {
                Ok(c) => c.content,
                Err(_) => return fallback,
            }
        }
        ProviderKind::Anthropic => return fallback,
    };

    let cleaned = sanitize_generated_title(&raw, 48);
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    }
}

/// Suggest a brief chat title for a user prompt (LLM when possible).
#[tauri::command]
async fn suggest_chat_title(state: State<'_, AppState>, prompt: String) -> Result<String, String> {
    Ok(llm_title_for_prompt(&state, &prompt).await)
}

/// Generate LLM title for session (if not rename-locked) and persist.
#[tauri::command]
async fn retitle_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    if session.title_locked {
        return Ok(session);
    }
    let prompt = session
        .messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    if prompt.trim().is_empty() {
        return Ok(session);
    }
    let title = llm_title_for_prompt(&state, &prompt).await;
    session.apply_suggested_title(&title);
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

#[derive(Debug, Deserialize)]
struct GrantReq {
    request_id: String,
    decision: String,
    typed: Option<String>,
    tool_name: String,
    arguments: serde_json::Value,
    /// Session whose model history should receive the grant outcome (#111).
    #[serde(default)]
    session_id: Option<String>,
}

#[tauri::command]
async fn complete_permission_cmd(
    state: State<'_, AppState>,
    req: GrantReq,
) -> Result<Vec<EventDto>, String> {
    let decision = match req.decision.as_str() {
        "allow_once" => PermissionDecision::AllowOnce,
        "allow_session_path" => PermissionDecision::AllowSessionPath,
        _ => PermissionDecision::Deny,
    };
    let session_key = req
        .session_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Clone history under its lock, then release before taking host (avoid deadlock
    // with agent_turn which also touches both maps).
    let mut history_buf = session_key.as_ref().map(|sid| {
        let mut histories = state.histories.lock().expect("hist");
        histories.entry(sid.clone()).or_default().clone()
    });
    // #114: take host out — MutexGuard is not Send across await.
    let mut host = {
        let mut host_guard = state.host.lock().expect("host");
        host_guard.take().ok_or("host missing")?
    };
    let events = grant_and_execute(
        &mut host,
        &req.request_id,
        decision,
        req.typed.as_deref(),
        &req.tool_name,
        &req.arguments,
        history_buf.as_mut(),
    )
    .await
    .map_err(|e| e.to_string());
    {
        let mut host_guard = state.host.lock().expect("host");
        *host_guard = Some(host);
    }
    let events = events?;
    if let (Some(sid), Some(h)) = (session_key, history_buf) {
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(sid, h);
    }
    Ok(events_to_dto(&events))
}

#[tauri::command]
fn reindex(state: State<'_, AppState>) -> Result<cd_core::index::IndexStatus, String> {
    ensure_host(&state)?;
    {
        let mut st = state.index_status.lock().expect("index_status");
        st.phase = cd_core::index::IndexPhase::Indexing;
        st.message = "Manual reindex…".into();
    }
    let mut host_guard = state.host.lock().expect("host");
    let host = host_guard.as_mut().ok_or("host missing")?;
    let stats = host.reindex().map_err(|e| e.to_string())?;
    let mut st = state.index_status.lock().expect("index_status");
    st.phase = cd_core::index::IndexPhase::Ready;
    st.scanned = stats.scanned;
    st.added = stats.added;
    st.max_files = stats.max_files;
    st.truncated = stats.truncated;
    st.bytes_capped = host.index_bytes_capped();
    st.resident_chunks = host.index_resident_chunks() as u32;
    st.message = format!(
        "Reindex complete — scanned {}, +{}.",
        stats.scanned, stats.added
    );
    Ok(st.clone())
}

/// Background index status (#117). Search works while phase is `indexing`.
#[tauri::command]
fn get_index_status(state: State<'_, AppState>) -> cd_core::index::IndexStatus {
    let mut st = state.index_status.lock().expect("index_status").clone();
    if let Ok(g) = state.host.lock() {
        if let Some(h) = g.as_ref() {
            st.bytes_capped = h.index_bytes_capped();
            st.resident_chunks = h.index_resident_chunks() as u32;
        }
    }
    st
}

#[tauri::command]
fn read_workspace_file_cmd(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    read_workspace_file(&ws, &path).map_err(|e| e.to_string())
}

/// Alias used by UI for citation / source preview.
#[tauri::command]
fn read_memory_file(state: State<'_, AppState>, relative: String) -> Result<String, String> {
    read_workspace_file_cmd(state, relative)
}

/// Durable memory row for UI (content already redacted at write time — no raw secrets).
#[derive(Debug, Clone, Serialize)]
struct DurableMemoryDto {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    scope: String,
    updated_at: i64,
    rev: i64,
    /// Citation / selection key: `memory:{id}`
    source_id: String,
}

impl From<&cd_core::memory::MemoryRecord> for DurableMemoryDto {
    fn from(r: &cd_core::memory::MemoryRecord) -> Self {
        Self {
            id: r.id.to_string(),
            kind: r.kind.as_str().to_string(),
            title: r.title.clone(),
            content: r.content.clone(),
            status: r.status.as_str().to_string(),
            scope: r.scope.as_str().to_string(),
            updated_at: r.updated_at,
            rev: r.rev,
            source_id: format!("memory:{}", r.id),
        }
    }
}

/// List durable memories from the Phase-1 store (#274).
#[tauri::command]
fn list_durable_memories(
    state: State<'_, AppState>,
    kind: Option<String>,
    include_superseded: Option<bool>,
    include_retracted: Option<bool>,
    limit: Option<u32>,
) -> Result<Vec<DurableMemoryDto>, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;
    let kinds_owned = kind.map(|k| vec![cd_core::memory::Kind::parse(&k)]);
    let kinds_ref = kinds_owned.as_deref();
    let list = store
        .list(
            kinds_ref,
            include_superseded.unwrap_or(false),
            include_retracted.unwrap_or(false),
            cd_core::embed::now_unix_secs(),
            limit.unwrap_or(100) as usize,
        )
        .map_err(|e| e.to_string())?;
    Ok(list.iter().map(DurableMemoryDto::from).collect())
}

/// Fetch one durable memory by UUID (citation open).
#[tauri::command]
fn get_durable_memory(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DurableMemoryDto>, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;
    let uuid = cd_core::memory::parse_memory_id(&id).map_err(|e| e.to_string())?;
    let rec = store.get(&uuid).map_err(|e| e.to_string())?;
    Ok(rec.as_ref().map(DurableMemoryDto::from))
}

/// User-initiated composition save (#293): insert or supersede after redaction.
///
/// UI-originated — no model SoftWrite round-trip; the human already clicked Save.
#[tauri::command]
fn save_composition_draft(
    state: State<'_, AppState>,
    content: String,
    title: String,
    kind: Option<String>,
    scope: Option<String>,
    supersede_id: Option<String>,
) -> Result<DurableMemoryDto, String> {
    ensure_host(&state)?;
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;

    // Redact before any persist (same path as tools).
    let redaction = cd_core::redact::redact_candidate(&content);
    if redaction.blocked {
        return Err(redaction
            .block_reason
            .unwrap_or_else(|| "credential-dominant content blocked".into()));
    }
    let safe = redaction.text;
    let mem_kind = kind
        .as_deref()
        .map(cd_core::memory::Kind::parse)
        .unwrap_or(cd_core::memory::Kind::ProjectNote);
    let mut draft = cd_core::memory::MemoryDraft::new(mem_kind, safe);
    draft.title = title;
    draft.source = cd_core::memory::MemorySource::User;
    draft.created_by = "user".into();
    draft.origin_tool = Some("composition_pane".into());
    if let Some(sc) = scope.as_deref().and_then(cd_core::memory::Scope::parse) {
        draft.scope = sc;
    }
    let now = cd_core::embed::now_unix_secs();
    let op = if let Some(ref sid) = supersede_id {
        let old = cd_core::memory::parse_memory_id(sid).map_err(|e| e.to_string())?;
        cd_core::memory::MemoryWriteOp::Supersede { old, new: draft }
    } else {
        cd_core::memory::MemoryWriteOp::Insert(draft)
    };
    let rec = store.put(op, now).map_err(|e| e.to_string())?;
    Ok(DurableMemoryDto::from(&rec))
}

#[tauri::command]
fn list_memory_notes(state: State<'_, AppState>) -> Result<Vec<MemoryFile>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    // Prefer durable store when attached (#274); fall back to memory_fs .md notes.
    if let Ok(host_g) = state.host.lock() {
        if let Some(h) = host_g.as_ref() {
            if let Some(store) = h.durable_memory_store() {
                if let Ok(list) =
                    store.list(None, false, false, cd_core::embed::now_unix_secs(), 200)
                {
                    if !list.is_empty() || h.durable_memory_active() {
                        return Ok(list
                            .iter()
                            .map(|r| MemoryFile {
                                path: std::path::PathBuf::from(format!("memory:{}", r.id)),
                                relative: format!("memory:{}", r.id),
                                title: if r.title.is_empty() {
                                    r.kind.as_str().to_string()
                                } else {
                                    r.title.clone()
                                },
                                body: r.content.clone(),
                            })
                            .collect());
                    }
                }
            }
        }
    }
    list_memory_files(&ws).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_memory_note(
    state: State<'_, AppState>,
    filename: String,
    title: String,
    body: String,
) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    let path = write_memory_file(&ws, &filename, &title, &body).map_err(|e| e.to_string())?;
    // refresh index if host exists
    if let Ok(mut g) = state.host.lock() {
        if let Some(h) = g.as_mut() {
            let _ = h.reindex();
        }
    }
    Ok(path.display().to_string())
}

#[tauri::command]
fn sql_ro_query(
    state: State<'_, AppState>,
    db_path: String,
    sql: String,
) -> Result<cd_core::sql_ro::SqlRoResult, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    let path =
        cd_core::paths::resolve_allowed_path(&ws, &db_path, false).map_err(|e| e.to_string())?;
    cd_core::sql_ro::execute_sqlite_ro(&path, &sql).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let branding = Branding::embedded();
    let _ = ensure_config_dir(&branding);
    let path = config_path(&branding).expect("config path");
    let mut config = load_config(&path).unwrap_or_default();
    if config.providers.profiles.is_empty() {
        config.providers = ProviderConfig::with_local_ollama();
    }

    let state = AppState {
        branding,
        config: Mutex::new(config),
        secrets: KeychainSecretStore::new(),
        histories: Mutex::new(HashMap::new()),
        host: Arc::new(Mutex::new(None)),
        cancels: Mutex::new(HashMap::new()),
        index_watch: Mutex::new(None),
        index_status: Arc::new(Mutex::new(cd_core::index::IndexStatus {
            phase: cd_core::index::IndexPhase::Idle,
            message: "Index not started".into(),
            ..Default::default()
        })),
    };
    let _ = ensure_host(&state);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Opt-in signed updates (#173). Check/install only via Settings — never silent.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_branding,
            get_config,
            save_app_config,
            list_connectors,
            list_connector_kinds,
            save_connectors,
            set_connector_secret,
            connector_has_secret,
            set_connector_secret,
            connector_has_secret,
            set_provider_secret,
            provider_has_secret,
            save_active_provider,
            list_local_candidates,
            probe_url,
            check_ollama,
            run_preflight_cmd,
            set_workspace_roots,
            validate_workspace_path,
            suggest_default_workspace,
            ensure_default_workspace,
            list_chat_sessions,
            load_chat_session,
            save_chat_session,
            rename_chat_session,
            trash_chat_session,
            restore_chat_session,
            delete_chat_session,
            pin_chat_session,
            archive_chat_session,
            search_chat_sessions,
            list_chat_models,
            list_models_for_draft,
            set_default_chat_model,
            get_default_chat_model,
            suggest_chat_title,
            retitle_chat_session,
            agent_turn,
            complete_permission_cmd,
            list_skills_cmd,
            set_skill_enabled_cmd,
            propose_save_skill_cmd,
            list_modules,
            install_module,
            set_module_enabled,
            approve_module_enable,
            remove_module,
            get_module_registry_settings,
            set_module_registry_settings,
            browse_module_registry,
            update_module,
            reindex,
            get_index_status,
            read_memory_file,
            read_workspace_file_cmd,
            list_memory_notes,
            list_durable_memories,
            get_durable_memory,
            save_composition_draft,
            write_memory_note,
            sql_ro_query,
            get_confluence_settings,
            save_confluence_settings,
            confluence_has_token,
            test_confluence_config,
            get_x_settings,
            save_x_settings,
            x_has_token,
            test_x_config,
            get_web_research_enabled,
            set_web_research_enabled,
            get_hybrid_retrieval,
            set_hybrid_retrieval,
            get_ambient_recall_enabled,
            set_ambient_recall_enabled,
            get_router_budget,
            set_router_budget,
            list_web_research_sources,
            set_web_research_sources,
            open_external_url,
            cancel_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextDesk");
}
