//! `contextdesk retrieval-reanalyze` — CLI parity for rebinding an existing
//! corpus's template vectors.
//!
//! The desktop app can re-analyze a corpus; before this command the CLI could
//! not, so a corpus whose typed embedding space was legacy or drifted could be
//! diagnosed from a terminal but not repaired from one.
//!
//! The plan is always shown first. It states **where the work runs** and
//! **whether log template text leaves this machine**, using the same
//! [`cd_core::log_analysis::ReanalysisPlan`] copy the desktop UI renders — so
//! the two surfaces cannot describe the same operation differently. A remote
//! plan is refused without explicit acknowledgement, before a backend is
//! constructed or a credential is read.

use std::path::Path;
use std::sync::Arc;

use cd_core::config::AppConfig;
use cd_core::embed::EmbedBackend;
use cd_core::embedding_space::LOCAL_ENDPOINT_FINGERPRINT;
use cd_core::log_analysis::{
    plan_reanalysis, reanalyze_corpus_embeddings, CorpusEmbeddingStatus, ReanalysisLocality,
    ReanalysisPlan,
};
use cd_core::process_progress::{CancelFlag, NoopProcessProgress};
use cd_workflow::retrieval_diagnostic::configured_embedding_space;
use serde::Serialize;

use crate::cli::RetrievalReanalyzeArgs;
use crate::envelope::{CliError, CliResult, Render};

/// Stable schema id for this command's envelope.
pub const RETRIEVAL_REANALYZE_SCHEMA_ID: &str = "contextdesk.cli.retrieval_reanalyze.v1";

/// Command output: the plan, plus the resulting binding when it executed.
#[derive(Debug, Serialize)]
pub struct RetrievalReanalyzeOutput {
    pub schema_id: &'static str,
    /// True when this invocation performed no embedding work at all.
    pub dry_run: bool,
    pub credentials_read: bool,
    pub network: bool,
    /// The plan that was shown (and, when confirmed, executed).
    pub plan: ReanalysisPlan,
    /// Resulting binding when the plan executed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<CorpusEmbeddingStatus>,
}

impl Render for RetrievalReanalyzeOutput {
    fn render_text(&self) -> String {
        let mut out = String::from(if self.dry_run {
            "Corpus re-analysis — plan (dry run)\n\n"
        } else {
            "Corpus re-analysis — complete\n\n"
        });
        out.push_str(&format!("  Corpus:    {}\n", self.plan.corpus_id));
        out.push_str(&format!("  Needed:    {}\n", self.plan.reason.code()));
        out.push_str(&format!("  Locality:  {}\n", self.plan.locality.as_str()));
        out.push_str(&format!(
            "  Current:   {}\n",
            self.plan
                .current_space_label
                .as_deref()
                .unwrap_or("unbound (legacy or not embedded)")
        ));
        out.push_str(&format!("  Target:    {}\n", self.plan.target_space_label));
        out.push_str(&format!(
            "  Templates: {} of {}\n",
            self.plan.templates_to_embed, self.plan.total_templates
        ));

        // The single source of this sentence is the plan, so this surface and
        // the desktop UI can never describe the same operation differently.
        out.push_str(&format!("\n  {}\n", self.plan.locality_copy()));
        if self.plan.requires_egress_consent {
            out.push_str("  Remote re-analysis requires --acknowledge-egress.\n");
        }

        match &self.result {
            None => out.push_str(
                "\nNothing ran. Re-run with --confirm to rebuild this corpus's vectors.\n",
            ),
            Some(status) => {
                out.push_str(&format!(
                    "\n  Embedded:  {} of {} templates\n  State:     {:?}\n",
                    status.embedded_templates, status.total_templates, status.state
                ));
                out.push_str(
                    "\nThe previous index was preserved until the new one validated.\n\
                     This changed no default and no readiness evidence.\n",
                );
            }
        }
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

fn resolve_corpus(args: &RetrievalReanalyzeArgs, current: &Option<String>) -> CliResult<String> {
    if let Some(id) = args.corpus_id.as_ref() {
        return Ok(id.clone());
    }
    current.clone().ok_or_else(|| {
        CliError::user(
            "no corpus selected; pass --corpus-id or select one with `contextdesk corpus use`",
        )
    })
}

/// Run the command.
pub async fn run(
    args: &RetrievalReanalyzeArgs,
    cache_root: &Path,
    app_cfg: &AppConfig,
    current_corpus_id: &Option<String>,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) -> CliResult<RetrievalReanalyzeOutput> {
    let corpus_id = resolve_corpus(args, current_corpus_id)?;
    let role = app_cfg
        .retrieval
        .embedding
        .as_ref()
        .filter(|role| role.enabled)
        .ok_or_else(|| {
            CliError::user(
                "no embedding role is enabled; re-analysis needs one so the rebuilt vectors have \
                 a typed embedding space to bind to",
            )
        })?;
    if role.dialect.as_deref().unwrap_or("").trim().is_empty() {
        return Err(CliError::user(
            "the embedding role has no explicit dialect; re-analysis never infers a parser from \
             an endpoint or a model name",
        ));
    }

    let space = configured_embedding_space(role);
    // Locality comes from the role's URL, which is the only thing that knows
    // it: the space carries a one-way endpoint fingerprint.
    let locality = if space.endpoint_fingerprint == LOCAL_ENDPOINT_FINGERPRINT
        || !cd_workflow::retrieval::retrieval_endpoint_is_remote(role)
    {
        ReanalysisLocality::Local
    } else {
        ReanalysisLocality::Remote {
            endpoint_fingerprint: space.endpoint_fingerprint.clone(),
        }
    };
    let plan = plan_reanalysis(cache_root, &corpus_id, &space, locality)
        .map_err(|error| CliError::user(error.to_string()))?;

    if !args.confirm {
        return Ok(RetrievalReanalyzeOutput {
            schema_id: RETRIEVAL_REANALYZE_SCHEMA_ID,
            dry_run: true,
            credentials_read: false,
            network: false,
            plan,
            result: None,
        });
    }

    // Consent is checked on the PLAN, before a backend exists.
    plan.authorize(args.acknowledge_egress)
        .map_err(|error| CliError::user(error.to_string()))?;

    let backend: Arc<dyn EmbedBackend> =
        cd_workflow::retrieval::build_embedding_backend(role, Some(secrets))
            .map_err(|error| CliError::user(error.to_string()))?;

    let cancel = CancelFlag::new();
    let cancel_for_signal = cancel.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancel_for_signal.cancel();
        }
    });

    let cache_root_owned = cache_root.to_path_buf();
    let corpus_for_task = corpus_id.clone();
    let model_label = role.model.clone();
    let cancel_for_task = cancel.clone();
    let joined = tokio::task::spawn_blocking(move || {
        reanalyze_corpus_embeddings(
            &cache_root_owned,
            &corpus_for_task,
            backend.as_ref(),
            &model_label,
            &NoopProcessProgress,
            Some(&cancel_for_task),
        )
    })
    .await;
    signal.abort();

    let status = match joined {
        Err(error) => {
            return Err(CliError::internal(format!(
                "re-analysis task join: {error}"
            )))
        }
        Ok(Err(error)) => {
            let message = error.to_string();
            return Err(if message.contains("cancelled") {
                CliError::cancelled(
                    "re-analysis cancelled; the previous index was preserved, safe to retry",
                )
            } else {
                // The executor already restores the previous index on failure.
                CliError::user(cd_workflow::retrieval_diagnostic::redact(&message))
            });
        }
        Ok(Ok(status)) => status,
    };

    Ok(RetrievalReanalyzeOutput {
        schema_id: RETRIEVAL_REANALYZE_SCHEMA_ID,
        dry_run: false,
        credentials_read: role.api_key_ref.is_some(),
        network: plan.locality.leaves_machine(),
        plan,
        result: Some(status),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plan's locality and the factory's egress gate must be the same
    /// decision, or a plan promises what the factory refuses.
    #[test]
    fn plan_locality_delegates_to_the_retrieval_factory() {
        let role = |base_url: &str| cd_core::config::RetrievalRoleModel {
            enabled: true,
            base_url: base_url.into(),
            model: "m".into(),
            dialect: Some("openai_embeddings".into()),
            allow_remote: false,
            api_key_ref: None,
        };
        for local in ["http://127.0.0.1:11434", "http://localhost:8080"] {
            assert!(
                !cd_workflow::retrieval::retrieval_endpoint_is_remote(&role(local)),
                "{local} must be local on both surfaces"
            );
        }
        for remote in [
            "http://10.0.0.5:8080",
            "https://gateway.example",
            "not a url",
        ] {
            assert!(
                cd_workflow::retrieval::retrieval_endpoint_is_remote(&role(remote)),
                "{remote} must be remote on both surfaces"
            );
        }
    }

    #[test]
    fn a_corpus_must_be_selected_explicitly_or_by_current_state() {
        let args = RetrievalReanalyzeArgs {
            corpus_id: None,
            confirm: false,
            acknowledge_egress: false,
        };
        assert!(resolve_corpus(&args, &None)
            .unwrap_err()
            .to_string()
            .contains("no corpus selected"));
        assert_eq!(
            resolve_corpus(&args, &Some("from-state".into())).unwrap(),
            "from-state"
        );
        let explicit = RetrievalReanalyzeArgs {
            corpus_id: Some("explicit".into()),
            ..args
        };
        assert_eq!(
            resolve_corpus(&explicit, &Some("from-state".into())).unwrap(),
            "explicit",
            "an explicit id always wins over ambient state"
        );
    }
}
