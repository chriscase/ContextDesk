//! ContextDesk Tauri host — secrets stay here; webview gets redacted DTOs only.

use cd_core::branding::Branding;
use cd_core::config::{
    config_path, ensure_config_dir, load_config, save_config, AppConfig, WorkspaceConfig,
};
use cd_core::discovery::{discover_local, ollama_reachable, LocalCandidate};
use cd_core::preflight::{run_preflight, PreflightInput, PreflightReport};
use cd_core::probe::{expand_base_candidates, normalize_gateway_input};
use cd_core::providers::{ProviderConfig, ProviderKind};
use cd_core::secrets::{key_ref_for_profile, KeychainSecretStore, SecretStore};
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
use cd_core::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

struct AppState {
    branding: Branding,
    config: Mutex<AppConfig>,
    secrets: KeychainSecretStore,
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
    // Never accept raw secrets in api_key_ref
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
fn run_preflight_cmd(state: State<'_, AppState>) -> Result<PreflightReport, String> {
    let cfg = state.config.lock().expect("config lock").clone();
    let ws = cfg.workspace.as_ref().map(|w| Workspace {
        id: w.id.clone(),
        name: w.name.clone(),
        roots: w.roots.clone(),
    });
    let active_key = cfg.providers.active().and_then(|p| {
        p.api_key_ref.as_ref().map(|r| state.secrets.has(r).unwrap_or(false))
    });
    // For ollama, key not required
    let active_key_present = match cfg.providers.active().map(|p| p.kind) {
        Some(ProviderKind::Ollama) | None => None,
        _ => active_key,
    };
    let data_ok = ensure_config_dir(&state.branding).is_ok();
    Ok(run_preflight(PreflightInput {
        workspace: ws.as_ref(),
        providers: &cfg.providers,
        data_dir_writable: data_ok,
        ollama_reachable: None,
        provider_reachable: None,
        active_key_present,
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
        .unwrap_or_else(|| uuid_simple());
    cfg.workspace = Some(WorkspaceConfig {
        id,
        name,
        roots: roots.into_iter().map(Into::into).collect(),
    });
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("ws-{t}")
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
    };

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextDesk");
}
