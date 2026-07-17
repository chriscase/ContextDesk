//! ContextDesk Tauri host — secrets stay here; webview gets redacted DTOs only.

use cd_core::branding::Branding;
use cd_core::chat::ChatMessage;
use cd_core::config::{
    config_path, ensure_config_dir, load_config, save_config, AppConfig, WorkspaceConfig,
};
use cd_core::discovery::{discover_local, ollama_reachable, LocalCandidate};
use cd_core::permissions::PermissionDecision;
use cd_core::preflight::{run_preflight, PreflightInput, PreflightReport};
use cd_core::probe::{expand_base_candidates, normalize_gateway_input};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::memory_fs::{list_memory_files, read_workspace_file, write_memory_file, MemoryFile};
use cd_core::research::{
    build_host, events_to_dto, grant_and_execute, research_local, research_turn, EventDto,
};
use cd_core::secrets::{key_ref_for_profile, KeychainSecretStore, SecretStore};
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
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

fn ensure_host(state: &AppState) -> Result<(), String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or_else(|| "no workspace configured".to_string())?;
    if ws.roots.is_empty() {
        return Err("workspace has no roots".into());
    }
    let audit = ensure_config_dir(&state.branding)
        .ok()
        .map(|d| d.join("audit.jsonl"));
    let host = build_host(ws, audit).map_err(|e| e.to_string())?;
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
            if r.starts_with("sk-") || r.starts_with("xai-") {
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
    let r = key_ref_for_profile(&profile_id);
    state.secrets.set(&r, &secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn provider_has_secret(state: State<'_, AppState>, profile_id: String) -> Result<bool, String> {
    let r = key_ref_for_profile(&profile_id);
    state.secrets.has(&r).map_err(|e| e.to_string())
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
    Ok(run_preflight(PreflightInput {
        workspace: ws.as_ref(),
        providers: &cfg.providers,
        data_dir_writable: data_ok,
        ollama_reachable: ollama_ok,
        provider_reachable: provider_ok,
        active_key_present: key_present,
    }))
}

#[tauri::command]
fn set_workspace_roots(
    state: State<'_, AppState>,
    name: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let mut cfg = state.config.lock().expect("config lock");
    let id = cfg
        .workspace
        .as_ref()
        .map(|w| w.id.clone())
        .unwrap_or_else(|| format!("ws-{}", chrono_like()));
    cfg.workspace = Some(WorkspaceConfig {
        id,
        name,
        roots: roots.into_iter().map(PathBuf::from).collect(),
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
}

#[tauri::command]
async fn agent_turn(state: State<'_, AppState>, req: AgentTurnReq) -> Result<Vec<EventDto>, String> {
    ensure_host(&state)?;
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
                    &req.text,
                    &mut history,
                    &req.session_id,
                    false,
                ))
            });
            match res {
                Ok(ev) => ev,
                Err(_) => research_local(host, &req.text, &req.session_id)
                    .map_err(|e| e.to_string())?,
            }
        } else {
            research_local(host, &req.text, &req.session_id).map_err(|e| e.to_string())?
        }
    } else {
        let mut host_guard = state.host.lock().expect("host");
        let host = host_guard.as_mut().ok_or("host missing")?;
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(research_turn(
                host,
                &profile,
                api_key,
                &req.text,
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
            list_local_candidates,
            probe_url,
            check_ollama,
            run_preflight_cmd,
            set_workspace_roots,
            agent_turn,
            complete_permission_cmd,
            reindex,
            read_memory_file,
            read_workspace_file_cmd,
            list_memory_notes,
            write_memory_note,
            sql_ro_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextDesk");
}
