//! Explicit, inspectable plan for re-analyzing an existing corpus's template
//! vectors — including where the work runs and whether content leaves the
//! machine.
//!
//! Re-analysis is the only honest repair for a corpus whose typed embedding
//! space is unbound (legacy) or has drifted. Before this module the decision
//! was implicit: a host picked a backend and re-analysis simply happened, so
//! there was no artifact a user could read before the first byte of their log
//! content was sent anywhere.
//!
//! [`ReanalysisPlan`] makes the decision explicit and reviewable:
//!
//! * **Locality** — [`ReanalysisLocality::Local`] means the work runs in this
//!   process and nothing leaves; [`ReanalysisLocality::Remote`] means template
//!   text is sent to another machine, identified only by an endpoint
//!   fingerprint.
//! * **Egress consent** — a remote plan is refused unless the caller passes an
//!   explicit acknowledgement. Consent is per plan, never inherited from an
//!   unrelated setting, and never implied by having configured an endpoint.
//! * **Truthful copy** — [`ReanalysisPlan::locality_copy`] is the single
//!   source of the sentence a surface shows. The CLI and the desktop UI render
//!   the same string, so a UI cannot describe a remote plan as local.
//!
//! Nothing here carries an endpoint URL, a credential, a header, or corpus
//! text: the endpoint appears only as a fingerprint, exactly as
//! [`crate::embedding_space::EmbeddingSpaceIdentity`] records it.

use serde::{Deserialize, Serialize};

use crate::embedding_space::{
    evaluate_space_binding, EmbeddingSpaceIdentity, EmbeddingSpaceVerdict,
    LOCAL_ENDPOINT_FINGERPRINT,
};
use crate::error::{CoreError, CoreResult};
use crate::log_analysis::store::{CorpusEmbeddingStatus, LogCorpus};

use std::path::Path;

/// Wire schema id for [`ReanalysisPlan`].
pub const REANALYSIS_PLAN_SCHEMA_ID: &str = "contextdesk.reanalysis_plan.v1";

/// The exact sentence a surface must show before running a **local** plan.
pub const LOCAL_REANALYSIS_COPY: &str =
    "Re-analysis runs on this machine. Log content does not leave this machine.";

/// The exact sentence a surface must show before running a **remote** plan.
///
/// It names what is sent (template text, not the whole corpus) and that it
/// leaves the machine, because those are the two facts a person needs in
/// order to consent.
pub const REMOTE_REANALYSIS_COPY: &str =
    "Re-analysis sends log template text to a remote embedding provider. \
     Log content leaves this machine.";

/// Where the embedding work for a re-analysis runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ReanalysisLocality {
    /// In-process: no network, nothing leaves the machine.
    Local,
    /// A non-loopback endpoint: template text leaves this machine.
    Remote {
        /// SHA-256 fingerprint of the normalized endpoint. Never the URL.
        endpoint_fingerprint: String,
    },
}

impl ReanalysisLocality {
    /// Classify the target space. Anything that is not the in-process marker
    /// is treated as remote: a private or corporate address is still another
    /// machine, and guessing otherwise would create silent egress.
    pub fn for_space(space: &EmbeddingSpaceIdentity) -> Self {
        if space.endpoint_fingerprint == LOCAL_ENDPOINT_FINGERPRINT {
            Self::Local
        } else {
            Self::Remote {
                endpoint_fingerprint: space.endpoint_fingerprint.clone(),
            }
        }
    }

    /// Whether running this plan sends content off the machine.
    pub fn leaves_machine(&self) -> bool {
        matches!(self, Self::Remote { .. })
    }

    /// Stable wire label.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote { .. } => "remote",
        }
    }
}

/// Why a corpus needs re-analysis (or does not).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReanalysisReason {
    /// The corpus has no vectors at all; semantic retrieval is unavailable.
    NotEmbedded,
    /// Vectors exist but carry no typed embedding space (older build).
    LegacyUnbound,
    /// Vectors exist under a different embedding space than the target.
    SpaceDrift {
        /// Identity fields that differ.
        fields: Vec<String>,
    },
    /// Vectors already match the target space; running the plan is a rebuild.
    AlreadyBound,
}

impl ReanalysisReason {
    /// Stable machine code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotEmbedded => "not_embedded",
            Self::LegacyUnbound => "legacy_unbound",
            Self::SpaceDrift { .. } => "space_drift",
            Self::AlreadyBound => "already_bound",
        }
    }

    /// Whether re-analysis would change the corpus's binding.
    pub fn requires_rebind(&self) -> bool {
        !matches!(self, Self::AlreadyBound)
    }
}

/// A reviewable plan for one corpus re-analysis.
///
/// Build with [`plan_reanalysis`], show it, then call
/// [`ReanalysisPlan::authorize`] with the consent the user actually gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReanalysisPlan {
    /// Always [`REANALYSIS_PLAN_SCHEMA_ID`].
    pub schema_id: String,
    /// Corpus this plan targets.
    pub corpus_id: String,
    /// Where the embedding work runs.
    pub locality: ReanalysisLocality,
    /// Why the corpus needs re-analysis.
    pub reason: ReanalysisReason,
    /// Share-safe label of the embedding space the corpus currently carries.
    /// `None` for a legacy or unembedded corpus.
    pub current_space_label: Option<String>,
    /// Share-safe label of the space this plan would bind the corpus to.
    pub target_space_label: String,
    /// Templates that would be re-embedded (bounded by the re-analysis cap).
    pub templates_to_embed: u64,
    /// Templates in the corpus.
    pub total_templates: u64,
    /// Whether running this plan requires explicit egress consent.
    pub requires_egress_consent: bool,
}

impl ReanalysisPlan {
    /// The exact sentence a surface must show for this plan.
    ///
    /// Both the CLI and the desktop UI render this string, so a surface cannot
    /// describe a remote plan with local copy.
    pub fn locality_copy(&self) -> &'static str {
        if self.locality.leaves_machine() {
            REMOTE_REANALYSIS_COPY
        } else {
            LOCAL_REANALYSIS_COPY
        }
    }

    /// Check the consent this plan needs before any work runs.
    ///
    /// A local plan needs none. A remote plan needs `egress_acknowledged` to
    /// be true, and refuses otherwise — before a backend is constructed, a
    /// credential is read, or an endpoint is contacted.
    pub fn authorize(&self, egress_acknowledged: bool) -> CoreResult<()> {
        if self.requires_egress_consent && !egress_acknowledged {
            return Err(CoreError::Policy(format!(
                "remote re-analysis was not acknowledged; {} Acknowledge egress explicitly \
                 before re-analysis, or choose a local embedding space.",
                REMOTE_REANALYSIS_COPY
            )));
        }
        Ok(())
    }
}

/// Build a re-analysis plan for `corpus_id` against `target_space`.
///
/// This reads corpus metadata only: no backend is constructed, no credential
/// is read, and no endpoint is contacted, so a plan is always safe to show.
pub fn plan_reanalysis(
    cache_root: &Path,
    corpus_id: &str,
    target_space: &EmbeddingSpaceIdentity,
) -> CoreResult<ReanalysisPlan> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let status = corpus.embedding_status();
    Ok(plan_from_status(corpus_id, &status, target_space))
}

/// Build a plan from an already-loaded corpus status (same rules, no I/O).
pub fn plan_from_status(
    corpus_id: &str,
    status: &CorpusEmbeddingStatus,
    target_space: &EmbeddingSpaceIdentity,
) -> ReanalysisPlan {
    let locality = ReanalysisLocality::for_space(target_space);
    let reason = if status.embedded_templates == 0 {
        ReanalysisReason::NotEmbedded
    } else {
        match evaluate_space_binding(status.space.as_ref(), target_space) {
            EmbeddingSpaceVerdict::Bound => ReanalysisReason::AlreadyBound,
            EmbeddingSpaceVerdict::LegacyUnbound => ReanalysisReason::LegacyUnbound,
            EmbeddingSpaceVerdict::Drift { fields } => ReanalysisReason::SpaceDrift {
                fields: fields.into_iter().map(str::to_string).collect(),
            },
        }
    };
    let templates_to_embed = status
        .total_templates
        .min(super::reanalyze::LOCAL_REANALYZE_TEMPLATE_CAP as u64);
    ReanalysisPlan {
        schema_id: REANALYSIS_PLAN_SCHEMA_ID.into(),
        corpus_id: corpus_id.to_string(),
        requires_egress_consent: locality.leaves_machine(),
        locality,
        reason,
        current_space_label: status
            .space
            .as_ref()
            .map(EmbeddingSpaceIdentity::report_label),
        target_space_label: target_space.report_label(),
        templates_to_embed,
        total_templates: status.total_templates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding_space::TEMPLATE_CHUNKING_VERSION;
    use crate::log_analysis::store::EmbeddingState;

    fn local_space() -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::local("all-minilm-l6-v2-onnx", "local_onnx")
            .with_dimensions(Some(384))
    }

    fn remote_space() -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::new("fp-remote-gateway", "bge-m3", "openai_embeddings")
            .with_dimensions(Some(1024))
    }

    fn bound_status(space: EmbeddingSpaceIdentity) -> CorpusEmbeddingStatus {
        CorpusEmbeddingStatus {
            state: EmbeddingState::Complete,
            model_id: Some(space.model.clone()),
            embedded_dims: space.dimensions,
            embedded_templates: 12,
            total_templates: 12,
            reason: Some("local_embedding_complete".into()),
            space: Some(space),
            updated_at: 1,
        }
    }

    #[test]
    fn a_local_plan_needs_no_consent_and_says_content_stays() {
        let plan = plan_from_status("corpus-a", &bound_status(remote_space()), &local_space());
        assert_eq!(plan.locality, ReanalysisLocality::Local);
        assert!(!plan.locality.leaves_machine());
        assert!(!plan.requires_egress_consent);
        assert_eq!(plan.locality_copy(), LOCAL_REANALYSIS_COPY);
        assert!(plan.locality_copy().contains("does not leave this machine"));
        plan.authorize(false)
            .expect("a local plan needs no consent");
    }

    #[test]
    fn a_remote_plan_fails_closed_without_explicit_consent() {
        let plan = plan_from_status("corpus-a", &bound_status(local_space()), &remote_space());
        assert!(matches!(plan.locality, ReanalysisLocality::Remote { .. }));
        assert!(plan.requires_egress_consent);
        assert_eq!(plan.locality_copy(), REMOTE_REANALYSIS_COPY);
        assert!(plan.locality_copy().contains("leaves this machine"));
        let error = plan
            .authorize(false)
            .expect_err("unacknowledged remote re-analysis must fail closed");
        assert!(error.to_string().contains("not acknowledged"));
        plan.authorize(true).expect("explicit consent runs");
    }

    #[test]
    fn the_two_copy_strings_can_never_be_confused() {
        // A surface that renders `locality_copy` cannot describe a remote plan
        // as local, because the two strings share no claim about egress.
        assert_ne!(LOCAL_REANALYSIS_COPY, REMOTE_REANALYSIS_COPY);
        assert!(LOCAL_REANALYSIS_COPY.contains("does not leave"));
        assert!(!REMOTE_REANALYSIS_COPY.contains("does not leave"));
        assert!(REMOTE_REANALYSIS_COPY.contains("leaves this machine"));
    }

    #[test]
    fn reasons_distinguish_unembedded_legacy_drift_and_bound() {
        let target = local_space();

        let mut unembedded = bound_status(local_space());
        unembedded.embedded_templates = 0;
        unembedded.space = None;
        assert_eq!(
            plan_from_status("c", &unembedded, &target).reason,
            ReanalysisReason::NotEmbedded
        );

        let mut legacy = bound_status(local_space());
        legacy.space = None;
        assert_eq!(
            plan_from_status("c", &legacy, &target).reason,
            ReanalysisReason::LegacyUnbound
        );

        let drifted = plan_from_status("c", &bound_status(remote_space()), &target).reason;
        match &drifted {
            ReanalysisReason::SpaceDrift { fields } => {
                assert!(fields.iter().any(|field| field == "model"));
                assert!(fields.iter().any(|field| field == "endpoint_fingerprint"));
            }
            other => panic!("expected drift, got {other:?}"),
        }
        assert!(drifted.requires_rebind());

        let bound = plan_from_status("c", &bound_status(local_space()), &target).reason;
        assert_eq!(bound, ReanalysisReason::AlreadyBound);
        assert!(!bound.requires_rebind());
    }

    #[test]
    fn a_plan_is_share_safe_and_bounded() {
        let plan = plan_from_status("corpus-a", &bound_status(local_space()), &remote_space());
        let json = serde_json::to_string(&plan).expect("serializes");
        assert!(
            !json.contains("http"),
            "a plan never carries an endpoint URL"
        );
        assert!(json.contains("fp-remote-gateway"), "only the fingerprint");
        assert_eq!(plan.schema_id, REANALYSIS_PLAN_SCHEMA_ID);
        assert_eq!(plan.total_templates, 12);
        assert_eq!(plan.templates_to_embed, 12);

        // The work is bounded by the same cap the executor enforces, so a plan
        // can never promise more templates than re-analysis would embed.
        let mut huge = bound_status(local_space());
        huge.total_templates = u64::from(u32::MAX);
        let bounded = plan_from_status("corpus-a", &huge, &local_space());
        assert_eq!(
            bounded.templates_to_embed,
            super::super::reanalyze::LOCAL_REANALYZE_TEMPLATE_CAP as u64
        );
        assert_eq!(
            local_space().chunking_version,
            TEMPLATE_CHUNKING_VERSION,
            "plans and stored bindings must agree on the chunking contract"
        );
    }
}
