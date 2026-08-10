//! `contextdesk models` — discover, verify, and inspect model readiness.
//!
//! Bare status reads only AppConfig plus the secret-free shared evidence file.
//! Discovery and verification are explicit live actions. Each live command
//! resolves the selected profile's credential once, then reuses it for every
//! catalog request and synthetic probe in that operation.

use crate::adapters::Paths;
use crate::cli::{ModelRoleArg, ModelsAction, ModelsArgs, ModelsDiscoverArgs, ModelsVerifyArgs};
use crate::envelope::{CliError, CliResult, Render};
use cd_core::capability_qualification::{
    configured_model_readiness, load_qualification_store, qualification_store_path,
    save_qualification_store, CatalogChange, ConfiguredModelReadiness, QualificationKey,
    QualificationReport,
};
use cd_core::config::AppConfig;
use cd_core::discovery::{ProbeOutcome, ProviderCatalogProbe};
use cd_core::keychain_store::SecretStore;
use cd_core::providers::{descriptor_for, ProviderKind, ProviderProfile};
use cd_core::ssrf::SsrfPolicy;
use cd_workflow::capability_qualification::{
    backend_for_provider, gate_for_model, LiveQualificationTransport,
};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Stable schema id for machine-readable model readiness output.
pub const MODEL_READINESS_OUTPUT_SCHEMA_ID: &str = "contextdesk.model_readiness.v1";

/// Unified output for passive status and explicit live actions.
#[derive(Debug, Serialize)]
pub struct ModelsOutput {
    pub schema_id: &'static str,
    /// `status` | `discover` | `verify`.
    pub action: &'static str,
    /// False only for explicit discovery/verification.
    pub offline: bool,
    /// Whether credential material was resolved for this operation.
    pub credentials_read: bool,
    /// Profile whose live catalog was used, when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// Catalog difference from the preceding successful observation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_change: Option<CatalogChange>,
    /// Configured, discovered, and previously qualified models.
    pub models: Vec<ConfiguredModelReadiness>,
    /// Reports produced by this command only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verified: Vec<QualificationReport>,
}

impl Render for ModelsOutput {
    fn render_text(&self) -> String {
        let mut out = String::from("Model readiness\n");
        if self.offline {
            out.push_str("\n  Cached status — no provider request or credential read.\n");
        } else {
            out.push_str("\n  Live operation used only synthetic, data-free requests.\n");
        }
        if let Some(change) = &self.catalog_change {
            if change.first_observation {
                out.push_str(&format!(
                    "  Saved first catalog snapshot ({} model(s)).\n",
                    change.added.len()
                ));
            } else if change.changed() {
                out.push_str(&format!(
                    "  Catalog changed: {} added, {} removed, {} unchanged.\n",
                    change.added.len(),
                    change.removed.len(),
                    change.unchanged
                ));
            } else {
                out.push_str("  Catalog unchanged.\n");
            }
        }
        if self.models.is_empty() {
            out.push_str("\n  No provider models are configured or discovered.\n");
            return out;
        }
        const TEXT_MODEL_LIMIT: usize = 30;
        for model in self.models.iter().take(TEXT_MODEL_LIMIT) {
            let default = if model.is_default { " · default" } else { "" };
            let configured = if model.configured_for_profile {
                " · configured"
            } else {
                ""
            };
            out.push_str(&format!(
                "\n  {} / {}{}{}\n    {} for {} — {}\n",
                model.profile_label,
                model.model_id,
                default,
                configured,
                model.readiness.state.as_str(),
                model.readiness.role.as_str(),
                model.readiness.detail
            ));
        }
        let omitted = self.models.len().saturating_sub(TEXT_MODEL_LIMIT);
        if omitted > 0 {
            out.push_str(&format!(
                "\n  … {omitted} more model(s) saved. Use `--json` for the full inventory, or `models verify --match TEXT` to narrow it.\n"
            ));
        }
        out.push_str(
            "\nCompatibility verification is role-specific. It does not establish answer quality, attachment support, or cost.\n",
        );
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

struct LiveCredentials {
    api_key: Option<String>,
    extra_headers: Vec<(String, String)>,
    credentials_read: bool,
}

/// Execute passive status, discovery, or verification.
pub async fn run(
    args: &ModelsArgs,
    paths: &Paths,
    app_cfg: &AppConfig,
    preferred_profile_id: Option<&str>,
    preferred_model_id: Option<&str>,
    secrets: &dyn SecretStore,
) -> CliResult<ModelsOutput> {
    let store_path = qualification_store_path(&paths.config_dir);
    let mut store = load_qualification_store(&store_path)
        .map_err(|error| CliError::internal(format!("load model readiness: {error}")))?;
    let Some(action) = &args.action else {
        return Ok(ModelsOutput {
            schema_id: MODEL_READINESS_OUTPUT_SCHEMA_ID,
            action: "status",
            offline: true,
            credentials_read: false,
            profile_id: None,
            catalog_change: None,
            models: configured_model_readiness(
                app_cfg,
                &mut store,
                preferred_profile_id,
                preferred_model_id,
            ),
            verified: Vec::new(),
        });
    };

    let profile = cd_workflow::provider::resolve_provider_profile(app_cfg, preferred_profile_id)
        .map_err(|id| CliError::not_found(format!("provider profile not found: {id}")))?;
    let credentials = resolve_credentials(&profile, secrets)?;
    let mut catalog_change = None;
    let mut reports = Vec::new();
    let mut output_selection = None;

    match action {
        ModelsAction::Discover(discover_args) => {
            let probe = discover_catalog(&profile, &credentials).await?;
            catalog_change = Some(record_catalog(&mut store, &store_path, &profile, &probe)?);
            let selection = selection_after_discovery(discover_args, &probe.model_ids)?;
            if !selection.is_empty() {
                reports = verify_models(
                    app_cfg,
                    &profile,
                    &credentials,
                    selection,
                    &mut store,
                    &store_path,
                )
                .await?;
            }
        }
        ModelsAction::Verify(verify_args) => {
            let needs_catalog = verify_args.refresh
                || verify_args.all
                || (verify_args.model_ids.is_empty()
                    && store.catalog_for(&profile.id, &profile.base_url).is_none());
            if needs_catalog {
                let probe = discover_catalog(&profile, &credentials).await?;
                catalog_change = Some(record_catalog(&mut store, &store_path, &profile, &probe)?);
            }
            let selection = verification_selection(verify_args, &profile, &store)?;
            output_selection = Some(selection.iter().cloned().collect::<BTreeSet<_>>());
            reports = verify_models(
                app_cfg,
                &profile,
                &credentials,
                selection,
                &mut store,
                &store_path,
            )
            .await?;
        }
    }

    let models = readiness_for_selection(
        configured_model_readiness(
            app_cfg,
            &mut store,
            preferred_profile_id,
            preferred_model_id,
        ),
        &profile.id,
        output_selection.as_ref(),
    );

    Ok(ModelsOutput {
        schema_id: MODEL_READINESS_OUTPUT_SCHEMA_ID,
        action: match action {
            ModelsAction::Discover(_) => "discover",
            ModelsAction::Verify(_) => "verify",
        },
        offline: false,
        credentials_read: credentials.credentials_read,
        profile_id: Some(profile.id.clone()),
        catalog_change,
        models,
        verified: reports,
    })
}

/// A targeted verification returns only the selected models. The complete
/// catalog remains persisted for later filtering and is still returned by
/// discovery/status, but it must not make a one-model verification enormous.
fn readiness_for_selection(
    rows: Vec<ConfiguredModelReadiness>,
    profile_id: &str,
    selection: Option<&BTreeSet<String>>,
) -> Vec<ConfiguredModelReadiness> {
    let Some(selection) = selection else {
        return rows;
    };
    rows.into_iter()
        .filter(|row| row.profile_id == profile_id && selection.contains(&row.model_id))
        .collect()
}

fn resolve_credentials(
    profile: &ProviderProfile,
    secrets: &dyn SecretStore,
) -> CliResult<LiveCredentials> {
    if profile.kind == ProviderKind::Ollama {
        return Ok(LiveCredentials {
            api_key: None,
            extra_headers: Vec::new(),
            credentials_read: false,
        });
    }
    if profile.kind == ProviderKind::XaiGrokBuild {
        let base = if profile.base_url.trim().is_empty() {
            "https://api.x.ai/v1"
        } else {
            profile.base_url.trim()
        };
        cd_core::grok_auth::assert_grok_base_allowed(base)
            .map_err(|error| CliError::user(error.to_string()))?;
        let credentials = cd_core::grok_auth::load_grok_session_credentials()
            .map_err(|error| CliError::provider(error.to_string()))?;
        return Ok(LiveCredentials {
            api_key: None,
            extra_headers: credentials.request_headers(),
            credentials_read: true,
        });
    }

    let api_key = profile
        .api_key_ref
        .as_deref()
        .map(|reference| {
            secrets
                .get(reference)
                .map_err(|error| CliError::provider(format!("read provider credential: {error}")))
        })
        .transpose()?
        .flatten();
    if descriptor_for(profile.kind).needs_api_key && api_key.is_none() {
        return Err(CliError::provider(format!(
            "no credential is configured for provider profile {}",
            profile.id
        )));
    }
    Ok(LiveCredentials {
        api_key,
        extra_headers: Vec::new(),
        credentials_read: profile.api_key_ref.is_some(),
    })
}

async fn discover_catalog(
    profile: &ProviderProfile,
    credentials: &LiveCredentials,
) -> CliResult<ProviderCatalogProbe> {
    let probe = if profile.kind == ProviderKind::XaiGrokBuild {
        let base = if profile.base_url.trim().is_empty() {
            "https://api.x.ai/v1"
        } else {
            profile.base_url.trim()
        };
        let client = cd_core::chat::OpenAiCompatibleClient::new(
            base,
            None,
            &profile.chat_model,
            &SsrfPolicy::default(),
        )
        .map_err(|error| CliError::provider(error.to_string()))?
        .with_extra_headers(credentials.extra_headers.clone());
        match client.list_models().await {
            Ok(mut model_ids) => {
                model_ids.sort();
                model_ids.dedup();
                ProviderCatalogProbe {
                    outcome: ProbeOutcome::Reachable {
                        reason: format!("models list ok ({} model(s))", model_ids.len()),
                    },
                    model_ids,
                    effective_base_url: base.to_string(),
                }
            }
            Err(error) => ProviderCatalogProbe {
                outcome: ProbeOutcome::Unreachable {
                    reason: error.to_string(),
                },
                model_ids: Vec::new(),
                effective_base_url: base.to_string(),
            },
        }
    } else {
        cd_core::discovery::probe_provider_catalog(profile, credentials.api_key.clone()).await
    };
    if !probe.outcome.is_reachable() {
        let reason = match &probe.outcome {
            ProbeOutcome::Reachable { reason }
            | ProbeOutcome::KeyRejected { reason }
            | ProbeOutcome::Unreachable { reason } => reason,
        };
        return Err(CliError::provider(format!(
            "model catalog discovery failed: {reason}"
        )));
    }
    Ok(probe)
}

fn record_catalog(
    store: &mut cd_core::capability_qualification::QualificationStore,
    store_path: &std::path::Path,
    profile: &ProviderProfile,
    probe: &ProviderCatalogProbe,
) -> CliResult<CatalogChange> {
    if probe.model_ids.is_empty() {
        return Err(CliError::provider(
            "the gateway returned an empty model catalog; the previous catalog and verification evidence were left unchanged",
        ));
    }
    let change = store.note_catalog(
        &profile.id,
        &profile.base_url,
        probe.model_ids.iter().cloned(),
    );
    save_qualification_store(store_path, store)
        .map_err(|error| CliError::internal(format!("save model catalog: {error}")))?;
    Ok(change)
}

fn selection_after_discovery(
    args: &ModelsDiscoverArgs,
    model_ids: &[String],
) -> CliResult<Vec<String>> {
    if args.verify_all {
        confirm_all(model_ids.len(), args.yes)?;
        return Ok(model_ids.to_vec());
    }
    if !io::stdin().is_terminal() {
        return Ok(Vec::new());
    }
    if !ask_yes_no("Run compatibility verification now?", false)? {
        return Ok(Vec::new());
    }
    prompt_model_selection(model_ids)
}

fn verification_selection(
    args: &ModelsVerifyArgs,
    profile: &ProviderProfile,
    store: &cd_core::capability_qualification::QualificationStore,
) -> CliResult<Vec<String>> {
    if !args.model_ids.is_empty() {
        return Ok(normalize_selection(args.model_ids.clone()));
    }
    let catalog = store
        .catalog_for(&profile.id, &profile.base_url)
        .map(|snapshot| snapshot.model_ids.clone())
        .unwrap_or_default();
    let catalog = filter_catalog(catalog, args.role, args.id_match.as_deref());
    if args.all {
        confirm_all(catalog.len(), args.yes)?;
        return Ok(catalog);
    }
    if !io::stdin().is_terminal() {
        return Err(CliError::user(
            "provide one or more model ids, or pass --all --yes",
        ));
    }
    prompt_model_selection(&catalog)
}

fn filter_catalog(
    model_ids: Vec<String>,
    role: Option<ModelRoleArg>,
    id_match: Option<&str>,
) -> Vec<String> {
    let needle = id_match
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    model_ids
        .into_iter()
        .filter(|model_id| {
            let suggestion = cd_core::model_role_hints::classify_model_role(model_id);
            let role_matches = match role {
                None => true,
                Some(ModelRoleArg::Chat) => matches!(
                    suggestion.role,
                    cd_core::model_role_hints::ModelRoleHint::Investigator
                        | cd_core::model_role_hints::ModelRoleHint::Unknown
                ),
                Some(ModelRoleArg::Embedding) => matches!(
                    suggestion.role,
                    cd_core::model_role_hints::ModelRoleHint::Embedding
                ),
                Some(ModelRoleArg::Reranker) => matches!(
                    suggestion.role,
                    cd_core::model_role_hints::ModelRoleHint::Reranker
                ),
                Some(ModelRoleArg::Unknown) => matches!(
                    suggestion.role,
                    cd_core::model_role_hints::ModelRoleHint::Unknown
                ),
            };
            let id_matches = needle
                .as_ref()
                .is_none_or(|needle| model_id.to_ascii_lowercase().contains(needle));
            role_matches && id_matches
        })
        .collect()
}

fn normalize_selection(model_ids: Vec<String>) -> Vec<String> {
    let mut ids = model_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

fn confirm_all(count: usize, yes: bool) -> CliResult<()> {
    if count == 0 {
        return Err(CliError::user(
            "the gateway catalog contains no models to verify",
        ));
    }
    if yes {
        return Ok(());
    }
    if !io::stdin().is_terminal() {
        return Err(CliError::user(format!(
            "verifying all {count} model(s) spends provider tokens; pass --yes to confirm"
        )));
    }
    if ask_yes_no(
        &format!("Verify all {count} model(s) sequentially? This spends provider tokens."),
        false,
    )? {
        Ok(())
    } else {
        Err(CliError::cancelled("model verification cancelled"))
    }
}

fn prompt_model_selection(model_ids: &[String]) -> CliResult<Vec<String>> {
    if model_ids.is_empty() {
        return Err(CliError::user(
            "the gateway catalog contains no models to select",
        ));
    }
    let narrowed = narrow_large_catalog(model_ids)?;
    let model_ids = narrowed.as_deref().unwrap_or(model_ids);
    let mut stderr = io::stderr();
    writeln!(stderr, "\nAvailable models:")
        .map_err(|error| CliError::internal(error.to_string()))?;
    for (index, model_id) in model_ids.iter().enumerate() {
        let role = cd_core::model_role_hints::classify_model_role(model_id);
        writeln!(
            stderr,
            "  {}) {} [{} suggestion]",
            index + 1,
            model_id,
            role.role.as_kind_str()
        )
        .map_err(|error| CliError::internal(error.to_string()))?;
    }
    write!(
        stderr,
        "Select model numbers separated by commas, or 'all': "
    )
    .map_err(|error| CliError::internal(error.to_string()))?;
    stderr
        .flush()
        .map_err(|error| CliError::internal(error.to_string()))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| CliError::internal(error.to_string()))?;
    let answer = answer.trim();
    if answer.eq_ignore_ascii_case("all") {
        confirm_all(model_ids.len(), false)?;
        return Ok(model_ids.to_vec());
    }
    let mut selected = Vec::new();
    for part in answer
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let index = part
            .parse::<usize>()
            .map_err(|_| CliError::user(format!("invalid model selection: {part}")))?;
        let Some(model_id) = index.checked_sub(1).and_then(|index| model_ids.get(index)) else {
            return Err(CliError::user(format!(
                "model selection {index} is outside 1..={}",
                model_ids.len()
            )));
        };
        selected.push(model_id.clone());
    }
    let selected = normalize_selection(selected);
    if selected.is_empty() {
        return Err(CliError::cancelled("no models selected"));
    }
    Ok(selected)
}

fn narrow_large_catalog(model_ids: &[String]) -> CliResult<Option<Vec<String>>> {
    const INTERACTIVE_CATALOG_LIMIT: usize = 30;
    const DEFAULT_SHORTLIST: usize = 20;
    if model_ids.len() <= INTERACTIVE_CATALOG_LIMIT {
        return Ok(None);
    }
    let mut stderr = io::stderr();
    writeln!(
        stderr,
        "The gateway returned {} models. Enter text to filter ids, a role (chat, embedding, reranker, unknown), or leave blank for up to {} likely chat models:",
        model_ids.len(),
        DEFAULT_SHORTLIST
    )
    .map_err(|error| CliError::internal(error.to_string()))?;
    write!(stderr, "> ").map_err(|error| CliError::internal(error.to_string()))?;
    stderr
        .flush()
        .map_err(|error| CliError::internal(error.to_string()))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| CliError::internal(error.to_string()))?;
    let answer = answer.trim().to_ascii_lowercase();
    let mut narrowed = model_ids
        .iter()
        .filter(|model_id| {
            let role = cd_core::model_role_hints::classify_model_role(model_id)
                .role
                .as_kind_str();
            if answer.is_empty() {
                role == "chat" || role == "unknown"
            } else if matches!(
                answer.as_str(),
                "chat" | "embedding" | "reranker" | "unknown"
            ) {
                role == answer
            } else {
                model_id.to_ascii_lowercase().contains(&answer)
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    if answer.is_empty() {
        narrowed.truncate(DEFAULT_SHORTLIST);
    }
    if narrowed.is_empty() {
        return Err(CliError::user("no models matched that catalog filter"));
    }
    Ok(Some(narrowed))
}

fn ask_yes_no(prompt: &str, default: bool) -> CliResult<bool> {
    let default_label = if default { "Y/n" } else { "y/N" };
    let mut stderr = io::stderr();
    write!(stderr, "{prompt} [{default_label}] ")
        .map_err(|error| CliError::internal(error.to_string()))?;
    stderr
        .flush()
        .map_err(|error| CliError::internal(error.to_string()))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| CliError::internal(error.to_string()))?;
    match answer.trim().to_ascii_lowercase().as_str() {
        "" => Ok(default),
        "y" | "yes" => Ok(true),
        "n" | "no" => Ok(false),
        _ => Err(CliError::user("answer yes or no")),
    }
}

async fn verify_models(
    app_cfg: &AppConfig,
    profile: &ProviderProfile,
    credentials: &LiveCredentials,
    model_ids: Vec<String>,
    store: &mut cd_core::capability_qualification::QualificationStore,
    store_path: &std::path::Path,
) -> CliResult<Vec<QualificationReport>> {
    if model_ids.is_empty() {
        return Err(CliError::user("no models selected for verification"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let signal_cancel = cancel.clone();
    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.store(true, Ordering::SeqCst);
        }
    });
    let mut reports = Vec::new();
    for (index, model_id) in model_ids.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        if index > 0 {
            // Large catalog runs stay deliberately serial and gently paced.
            // This is short enough for small selections while avoiding an
            // immediate request burst against hosted gateway rate limits.
            tokio::time::sleep(Duration::from_millis(500)).await;
            if cancel.load(Ordering::SeqCst) {
                break;
            }
        }
        if io::stderr().is_terminal() {
            eprintln!(
                "Verifying {} ({}/{})…",
                model_id,
                index + 1,
                model_ids.len()
            );
        }
        let tools_enabled = cd_workflow::provider::model_tools_enabled(app_cfg, profile, model_id);
        let gate = gate_for_model(profile, tools_enabled, model_id);
        let key = QualificationKey::new(&profile.id, &profile.base_url, model_id);
        let backend = backend_for_provider(profile.kind);
        let base_url =
            if profile.kind == ProviderKind::XaiGrokBuild && profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1".to_string()
            } else {
                profile.base_url.clone()
            };
        let api_key = credentials.api_key.clone();
        let extra_headers = credentials.extra_headers.clone();
        let local_only = profile.local_only;
        let run_cancel = cancel.clone();
        let report = tokio::task::spawn_blocking(move || {
            let mut transport =
                LiveQualificationTransport::new(backend, base_url, api_key, local_only)
                    .with_extra_headers(extra_headers);
            cd_core::capability_qualification::run_qualification(
                key,
                gate,
                &mut transport,
                &run_cancel,
            )
        })
        .await
        .map_err(|error| CliError::internal(format!("model verification task: {error}")))?;
        store.put(report.clone());
        save_qualification_store(store_path, store)
            .map_err(|error| CliError::internal(format!("save model verification: {error}")))?;
        let rate_limited = report.checks.iter().any(|check| {
            let reason = check.reason.to_ascii_lowercase();
            reason.contains("429") || reason.contains("rate limit")
        });
        reports.push(report);
        if rate_limited {
            signal_task.abort();
            return Err(CliError::provider(format!(
                "the gateway rate-limited model verification after {} completed result(s); the batch stopped and completed evidence was saved",
                reports.len()
            )));
        }
    }
    signal_task.abort();
    if cancel.load(Ordering::SeqCst) {
        return Err(CliError::cancelled(format!(
            "model verification cancelled after {} completed result(s); completed evidence was saved",
            reports.len()
        )));
    }
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::error::CoreResult;
    use cd_core::providers::{
        ProviderCapabilities, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingSecrets {
        reads: AtomicUsize,
    }

    impl SecretStore for CountingSecrets {
        fn get(&self, _reference: &str) -> CoreResult<Option<String>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(Some("test-key".into()))
        }

        fn set(&self, _reference: &str, _value: &str) -> CoreResult<()> {
            Ok(())
        }

        fn delete(&self, _reference: &str) -> CoreResult<()> {
            Ok(())
        }
    }

    fn remote_profile() -> ProviderProfile {
        ProviderProfile {
            id: "work".into(),
            label: "Work".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://gateway.example.com/v1".into(),
            api_key_ref: Some("provider/work/api_key".into()),
            chat_model: "deepseek-v4-flash".into(),
            embedding_model: None,
            embedding_base_url: None,
            capabilities: ProviderCapabilities::chat_remote(),
            local_only: false,
            deadline_preference: ProviderDeadlinePreference::Auto,
        }
    }

    #[test]
    fn one_live_operation_resolves_remote_credential_once() {
        let secrets = CountingSecrets {
            reads: AtomicUsize::new(0),
        };
        let credentials = resolve_credentials(&remote_profile(), &secrets).unwrap();
        assert!(credentials.credentials_read);
        assert_eq!(credentials.api_key.as_deref(), Some("test-key"));
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_reference_never_probes_an_implicit_keychain_entry() {
        let secrets = CountingSecrets {
            reads: AtomicUsize::new(0),
        };
        let mut profile = remote_profile();
        profile.api_key_ref = None;

        let error = match resolve_credentials(&profile, &secrets) {
            Ok(_) => panic!("missing credential reference must fail"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("no credential is configured"));
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn catalog_filters_make_large_gateway_selection_role_specific() {
        let ids = vec![
            "deepseek-v4-flash".into(),
            "bge-m3".into(),
            "qwen3-reranker-0.6b".into(),
            "private-alias".into(),
        ];
        assert_eq!(
            filter_catalog(ids.clone(), Some(ModelRoleArg::Embedding), None),
            ["bge-m3"]
        );
        assert_eq!(
            filter_catalog(ids, Some(ModelRoleArg::Chat), None),
            ["deepseek-v4-flash", "private-alias"]
        );
    }

    #[test]
    fn empty_catalog_does_not_replace_the_last_good_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model-qualifications.json");
        let profile = remote_profile();
        let mut store = cd_core::capability_qualification::QualificationStore::default();
        store.note_catalog(
            &profile.id,
            &profile.base_url,
            ["deepseek-v4-flash".to_string()],
        );
        let before = store.clone();
        let probe = ProviderCatalogProbe {
            outcome: ProbeOutcome::Reachable {
                reason: "models list ok (0 models)".into(),
            },
            model_ids: Vec::new(),
            effective_base_url: profile.base_url.clone(),
        };

        let error = record_catalog(&mut store, &path, &profile, &probe).unwrap_err();

        assert!(error.to_string().contains("empty model catalog"));
        assert_eq!(store, before);
        assert!(!path.exists());
    }

    #[test]
    fn noninteractive_verify_all_requires_explicit_yes() {
        if !io::stdin().is_terminal() {
            let error = confirm_all(12, false).unwrap_err();
            assert!(error.to_string().contains("pass --yes"));
        }
    }

    #[test]
    fn targeted_verification_output_does_not_repeat_the_whole_catalog() {
        let rows = [
            "deepseek/deepseek-v4-flash",
            "openai/gpt-oss-120b",
            "voyage/voyage-4",
        ]
        .into_iter()
        .map(|model_id| ConfiguredModelReadiness {
            profile_id: "work".into(),
            profile_label: "Work".into(),
            model_id: model_id.into(),
            configured_for_profile: false,
            is_default: false,
            readiness: cd_core::capability_qualification::ModelReadiness::unverified(model_id),
        })
        .collect();
        let selection = BTreeSet::from(["deepseek/deepseek-v4-flash".to_string()]);

        let filtered = readiness_for_selection(rows, "work", Some(&selection));

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].model_id, "deepseek/deepseek-v4-flash");
    }
}
