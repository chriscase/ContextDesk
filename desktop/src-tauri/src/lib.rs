//! ContextDesk Tauri host — secrets stay here; webview gets redacted DTOs only.

use cd_core::branding::Branding;
use cd_core::config::{
    config_path, ensure_config_dir, load_config, save_config, AppConfig, ConfluenceSettings,
    WorkspaceConfig, CONFLUENCE_PAT_REF,
};
use cd_core::discovery::{discover_local, ollama_reachable, LocalCandidate};
use cd_core::permissions::PermissionDecision;
use cd_core::preflight::{run_preflight, PreflightInput, PreflightReport};
use cd_core::probe::{expand_base_candidates, normalize_gateway_input};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::memory_fs::{list_memory_files, read_workspace_file, write_memory_file, MemoryFile};
use cd_core::research::{
    build_host, events_to_dto, grant_and_execute, research_turn, EventDto,
};
use cd_core::keychain_store::{
    key_ref_confluence_pat, key_ref_for_profile, looks_like_raw_secret, KeychainSecretStore,
    SecretStore,
};
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
use cd_core::chat::{ChatMessage, Role as ChatRole};
use cd_core::sessions::{
    sanitize_generated_title, session_title_llm_prompt, title_from_prompt, Session, SessionMeta,
    SessionSearchHit, SessionStore,
};
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    branding: Branding,
    config: Mutex<AppConfig>,
    secrets: KeychainSecretStore,
    /// Session id -> chat history
    histories: Mutex<HashMap<String, Vec<ChatMessage>>>,
    /// Live tool host (rebuilt when workspace changes)
    host: Mutex<Option<ToolHost>>,
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
    let audit = ensure_config_dir(&state.branding)
        .ok()
        .map(|d| d.join("audit.jsonl"));
    let mut host = build_host(ws, audit).map_err(|e| e.to_string())?;
    // Attach Confluence RO when enabled (PAT from keychain only).
    if cfg.confluence.enabled && cfg.confluence.is_configured() {
        let pat = state
            .secrets
            .get(&key_ref_confluence_pat())
            .ok()
            .flatten();
        host.set_confluence(Some(cfg.confluence.to_ro_config()), pat);
    } else {
        host.set_confluence(None, None);
    }
    // Open-web research tools (opt-in; no secrets).
    host.set_web_research(cfg.web_research_enabled);
    *state.host.lock().expect("host") = Some(host);
    Ok(())
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
    if let Some(p) = cfg.providers.profiles.iter_mut().find(|p| p.id == profile_id) {
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
    let id = match kind {
        ProviderKind::Ollama => "ollama-local".to_string(),
        ProviderKind::OpenAiCompatible => "openai-compatible".to_string(),
        ProviderKind::Anthropic => "anthropic".to_string(),
        ProviderKind::XaiGrokBuild => "xai-grok-build".to_string(),
    };
    let label = req.label.unwrap_or_else(|| match kind {
        ProviderKind::Ollama => "Ollama (local)".into(),
        ProviderKind::OpenAiCompatible => "OpenAI-compatible gateway".into(),
        ProviderKind::Anthropic => "Anthropic".into(),
        ProviderKind::XaiGrokBuild => "Grok Build session".into(),
    });
    let mut base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() && matches!(kind, ProviderKind::XaiGrokBuild) {
        base_url = "https://api.x.ai/v1".into();
    }
    let chat_model = req.chat_model.trim().to_string();
    if chat_model.is_empty() {
        return Err("chat model is required".into());
    }

    // Grok session credentials live in ~/.grok/auth.json — never paste into keychain via this path.
    if matches!(kind, ProviderKind::XaiGrokBuild) {
        cd_core::grok_auth::assert_grok_base_allowed(&base_url).map_err(|e| e.to_string())?;
        if cd_core::grok_auth::detect_grok_session().is_none() {
            return Err(
                "No Grok session found. Run `grok login`, then try again.".into(),
            );
        }
    }

    let mut api_key_ref: Option<String> = None;
    if !matches!(kind, ProviderKind::XaiGrokBuild) {
        if let Some(key) = req.api_key.as_ref() {
            let key = key.trim();
            if !key.is_empty() && !key.chars().all(|c| c == '•') {
                if looks_like_raw_secret(key) || key.len() >= 8 {
                    let r = key_ref_for_profile(&id);
                    state.secrets.set(&r, key).map_err(|e| e.to_string())?;
                    api_key_ref = Some(r);
                }
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

    let local_only = req.local_only.unwrap_or_else(|| match kind {
        ProviderKind::Ollama => true,
        ProviderKind::XaiGrokBuild => false,
        _ => false,
    });
    if local_only && !base_url.is_empty() {
        let policy = SsrfPolicy::local_only();
        if validate_provider_url(&base_url, &policy).is_err() {
            return Err(
                "local-only profile: base URL must be loopback (e.g. 127.0.0.1)".into(),
            );
        }
    }

    let profile = ProviderProfile {
        id: id.clone(),
        label: label.clone(),
        kind,
        base_url: base_url.clone(),
        api_key_ref: api_key_ref.clone(),
        chat_model: chat_model.clone(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: Default::default(),
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
        match p.kind {
            ProviderKind::Ollama => {
                ollama_ok = Some(ollama_reachable(&p.base_url).await);
            }
            ProviderKind::OpenAiCompatible | ProviderKind::Anthropic => {
                let ref_id = p
                    .api_key_ref
                    .clone()
                    .unwrap_or_else(|| key_ref_for_profile(&p.id));
                key_present = Some(state.secrets.has(&ref_id).unwrap_or(false));
                let policy = if p.local_only {
                    SsrfPolicy::local_only()
                } else {
                    SsrfPolicy::default()
                };
                provider_ok = Some(validate_provider_url(&p.base_url, &policy).is_ok());
            }
            ProviderKind::XaiGrokBuild => {
                key_present = Some(cd_core::grok_auth::detect_grok_session().is_some());
            }
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
    state
        .config
        .lock()
        .expect("config")
        .web_research_enabled
}

#[tauri::command]
fn set_web_research_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.web_research_enabled = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    // Rebuild host so tool specs update for the next agent turn.
    let _ = ensure_host(&state);
    Ok(enabled)
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
}

#[tauri::command]
fn list_skills_cmd(state: State<'_, AppState>) -> Result<Vec<SkillDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let dirs = skill_dirs_for(&state, &cfg);
    let skills = cd_core::skills::discover_skills(&dirs).map_err(|e| e.to_string())?;
    Ok(skills
        .into_iter()
        .map(|s| SkillDto {
            id: s.id,
            name: s.name,
            description: s.description,
            disabled: s.disabled,
            allows_write: s.allows_write,
            path: s.path.display().to_string(),
        })
        .collect())
}

/// Propose authoring a skill via the SoftWrite tool host path (PermissionRequired).
/// Does **not** write until the UI completes the grant and re-executes.
#[tauri::command]
fn propose_save_skill_cmd(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    body: String,
    allows_write: bool,
) -> Result<Vec<EventDto>, String> {
    ensure_host(&state)?;
    let mut host_guard = state.host.lock().expect("host");
    let host = host_guard.as_mut().ok_or("host missing")?;
    let args = serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "body_markdown": body,
        "allows_write": allows_write,
    });
    let result = host
        .execute(cd_core::tools::names::SAVE_SKILL, &args, None)
        .map_err(|e| e.to_string())?;
    Ok(events_to_dto(&result.events))
}

#[tauri::command]
async fn agent_turn(state: State<'_, AppState>, req: AgentTurnReq) -> Result<Vec<EventDto>, String> {
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
        histories
            .entry(req.session_id.clone())
            .or_default()
            .clone()
    };

    // Always use local research when forced or for reliability without holding locks
    // across await: run local path under mutex (sync). Live model path uses block_in_place.
    let events = if req.force_local || profile.kind == cd_core::providers::ProviderKind::Ollama {
        let mut host_guard = state.host.lock().expect("host");
        let host = host_guard.as_mut().ok_or("host missing")?;
        // Try ollama via block_in_place only if not force_local
        if !req.force_local {
            let res = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(research_turn(
                    host,
                    &profile,
                    api_key.clone(),
                    &user_text,
                    &mut history,
                    &req.session_id,
                    false,
                ))
            });
            match res {
                Ok(ev) => ev,
                Err(_) => cd_core::research::research_local_with_skills(
                    host,
                    &user_text,
                    &req.session_id,
                    &skill_dirs,
                )
                .map_err(|e| e.to_string())?,
            }
        } else {
            cd_core::research::research_local_with_skills(
                host,
                &user_text,
                &req.session_id,
                &skill_dirs,
            )
            .map_err(|e| e.to_string())?
        }
    } else {
        let mut host_guard = state.host.lock().expect("host");
        let host = host_guard.as_mut().ok_or("host missing")?;
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(research_turn(
                host,
                &profile,
                api_key,
                &user_text,
                &mut history,
                &req.session_id,
                false,
            ))
        })
        .map_err(|e| e.to_string())?
    };

    {
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(req.session_id.clone(), history);
    }
    Ok(events_to_dto(&events))
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

/// Delete session file and drop in-memory history.
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
) -> Result<Vec<SessionSearchHit>, String> {
    session_store(&state)?
        .search(
            &query,
            limit.unwrap_or(50),
            include_archived.unwrap_or(false),
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
    match p.kind {
        ProviderKind::Ollama => {
            if p.label.trim().is_empty() {
                "Ollama".into()
            } else {
                p.label.clone()
            }
        }
        ProviderKind::OpenAiCompatible => {
            if p.label.trim().is_empty() {
                "OpenAI-compatible".into()
            } else {
                p.label.clone()
            }
        }
        ProviderKind::XaiGrokBuild => "Grok / xAI".into(),
        ProviderKind::Anthropic => "Anthropic".into(),
    }
}

fn looks_like_chat_model_id(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    // Drop obvious non-chat entries from vendor catalogs.
    if l.contains("embed")
        || l.contains("whisper")
        || l.contains("tts")
        || l.contains("dall")
        || l.contains("image")
        || l.contains("moderation")
        || l.contains("realtime")
        || l.contains("audio")
        || l.contains("transcri")
    {
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
    let mut ids: Vec<String> = Vec::new();
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| secrets.get(r).ok().flatten());

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
            if let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                &profile.base_url,
                api_key,
                &profile.chat_model,
                &policy,
            ) {
                if let Ok(listed) = client.list_models().await {
                    ids.extend(listed.into_iter().filter(|m| looks_like_chat_model_id(m)));
                }
            }
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
                                // Prefer chat-oriented grok ids from the catalog.
                                let l = m.to_ascii_lowercase();
                                if l.contains("grok") && !ids.iter().any(|x| x == &m) {
                                    ids.push(m);
                                }
                            }
                        }
                    }
                }
            }
        }
        ProviderKind::Anthropic => {}
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
        cfg.providers
            .active_id
            .as_deref()
            .unwrap_or("ollama-local"),
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
async fn retitle_chat_session(
    state: State<'_, AppState>,
    id: String,
) -> Result<Session, String> {
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
}

#[tauri::command]
fn complete_permission_cmd(
    state: State<'_, AppState>,
    req: GrantReq,
) -> Result<Vec<EventDto>, String> {
    let decision = match req.decision.as_str() {
        "allow_once" => PermissionDecision::AllowOnce,
        "allow_session_path" => PermissionDecision::AllowSessionPath,
        _ => PermissionDecision::Deny,
    };
    let mut host_guard = state.host.lock().expect("host");
    let host = host_guard.as_mut().ok_or("host missing")?;
    let events = grant_and_execute(
        host,
        &req.request_id,
        decision,
        req.typed.as_deref(),
        &req.tool_name,
        &req.arguments,
    )
    .map_err(|e| e.to_string())?;
    Ok(events_to_dto(&events))
}

#[tauri::command]
fn reindex(state: State<'_, AppState>) -> Result<(), String> {
    ensure_host(&state)?;
    let mut host_guard = state.host.lock().expect("host");
    let host = host_guard.as_mut().ok_or("host missing")?;
    host.reindex().map_err(|e| e.to_string())
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

#[tauri::command]
fn list_memory_notes(state: State<'_, AppState>) -> Result<Vec<MemoryFile>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
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
    let path = cd_core::paths::resolve_allowed_path(&ws, &db_path, false)
        .map_err(|e| e.to_string())?;
    cd_core::sql_ro::execute_sqlite_ro(&path, &sql).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    let branding = Branding::default();
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
        host: Mutex::new(None),
    };
    let _ = ensure_host(&state);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_branding,
            get_config,
            save_app_config,
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
            delete_chat_session,
            pin_chat_session,
            archive_chat_session,
            search_chat_sessions,
            list_chat_models,
            set_default_chat_model,
            get_default_chat_model,
            suggest_chat_title,
            retitle_chat_session,
            agent_turn,
            complete_permission_cmd,
            list_skills_cmd,
            propose_save_skill_cmd,
            reindex,
            read_memory_file,
            read_workspace_file_cmd,
            list_memory_notes,
            write_memory_note,
            sql_ro_query,
            get_confluence_settings,
            save_confluence_settings,
            confluence_has_token,
            test_confluence_config,
            get_web_research_enabled,
            set_web_research_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextDesk");
}
