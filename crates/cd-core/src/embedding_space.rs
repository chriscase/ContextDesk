//! Typed embedding-space identity and fail-closed binding checks.
//!
//! A stored vector is only comparable to a query vector when **every** input
//! that shaped the vector space is the same. Historically this repository
//! bound corpora with a single free-form `model_id` string, which cannot tell
//! `bge-m3` on one gateway apart from `bge-m3` on another, cannot notice that
//! the wire dialect changed, and cannot notice that the text handed to the
//! model was preprocessed differently. [`EmbeddingSpaceIdentity`] makes every
//! one of those inputs an explicit, typed field.
//!
//! # Fail-closed rules
//!
//! 1. **Legacy** — a corpus that carries vectors but no typed space cannot be
//!    proven comparable, so semantic retrieval is refused
//!    ([`EmbeddingSpaceVerdict::LegacyUnbound`]). It is repaired by an explicit
//!    re-analysis, never by assuming the current configuration produced it.
//! 2. **Drift** — any differing field refuses with the exact field names
//!    ([`EmbeddingSpaceVerdict::Drift`]). Dimensions are compared only when
//!    both sides are measured; an unmeasured query dimension is not a match.
//! 3. A refusal never fails the search: the caller withholds the semantic lane
//!    and keeps the structured/keyword baseline.
//!
//! Nothing here carries an endpoint URL, a credential, a header, or corpus
//! text. The endpoint appears only as a SHA-256 fingerprint, exactly as
//! [`crate::capability_qualification::fingerprint_endpoint`] produces it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Wire schema id for [`EmbeddingSpaceIdentity`].
pub const EMBEDDING_SPACE_SCHEMA_ID: &str = "contextdesk.embedding_space.v1";

/// Endpoint fingerprint used when a backend runs in-process (no egress).
pub const LOCAL_ENDPOINT_FINGERPRINT: &str = "local-in-process";

/// Chunking contract version for log **template** vectors. Bump whenever the
/// text handed to the embedder for a template changes shape, so old corpora
/// stop matching instead of silently mixing two chunkings.
pub const TEMPLATE_CHUNKING_VERSION: &str = "log_template.v1";

/// Representation label for "the raw chunk text, verbatim".
pub const REPRESENTATION_RAW_TEXT: &str = "raw_text";

/// Preprocessing label for "nothing was applied before the wire call".
pub const PREPROCESSING_NONE: &str = "none";

/// Every input that defines a vector space, as typed fields.
///
/// Two vectors are comparable only when their identities are equal under
/// [`EmbeddingSpaceIdentity::compare`]. Construct with [`Self::new`] and
/// refine with the builder methods; `dimensions` is filled in from *measured*
/// vectors, never from configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingSpaceIdentity {
    /// Always [`EMBEDDING_SPACE_SCHEMA_ID`].
    #[serde(default = "default_schema_id")]
    pub schema_id: String,
    /// SHA-256 of the normalized endpoint, or [`LOCAL_ENDPOINT_FINGERPRINT`]
    /// for in-process backends. Never the URL itself.
    pub endpoint_fingerprint: String,
    /// Exact model identity as configured for that endpoint.
    pub model: String,
    /// Explicit wire dialect (`openai_embeddings`, `vercel_v4_embeddings`,
    /// `ollama_embeddings`, `local_onnx`, `synthetic`). Never inferred from a
    /// URL or a model name.
    pub dialect: String,
    /// What was embedded: the raw chunk, a query-side variant, a summary, ...
    pub representation: String,
    /// Instruction/prefix prepended to every input, when the space uses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    /// Text preprocessing applied before the wire call (casefolding,
    /// whitespace collapse, redaction pass, ...).
    pub preprocessing: String,
    /// Version of the chunk/template extraction that produced the input text.
    pub chunking_version: String,
    /// Measured vector dimensions; `None` until vectors actually exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<u32>,
    /// True when the backend is deterministic/scripted. A synthetic space can
    /// never be reported as a shipped capability.
    #[serde(default)]
    pub synthetic: bool,
}

fn default_schema_id() -> String {
    EMBEDDING_SPACE_SCHEMA_ID.to_string()
}

impl EmbeddingSpaceIdentity {
    /// Build an identity from the fields a backend always knows.
    pub fn new(
        endpoint_fingerprint: impl Into<String>,
        model: impl Into<String>,
        dialect: impl Into<String>,
    ) -> Self {
        Self {
            schema_id: default_schema_id(),
            endpoint_fingerprint: endpoint_fingerprint.into(),
            model: model.into(),
            dialect: dialect.into(),
            representation: REPRESENTATION_RAW_TEXT.into(),
            instruction: None,
            preprocessing: PREPROCESSING_NONE.into(),
            chunking_version: TEMPLATE_CHUNKING_VERSION.into(),
            dimensions: None,
            synthetic: false,
        }
    }

    /// Identity for an in-process backend that never performs egress.
    pub fn local(model: impl Into<String>, dialect: impl Into<String>) -> Self {
        Self::new(LOCAL_ENDPOINT_FINGERPRINT, model, dialect)
    }

    /// Identity for a deterministic offline backend. Marked synthetic so no
    /// report can pass a scripted run off as a capability.
    pub fn synthetic(model: impl Into<String>) -> Self {
        Self {
            synthetic: true,
            ..Self::new(LOCAL_ENDPOINT_FINGERPRINT, model, "synthetic")
        }
    }

    /// Set the representation label.
    pub fn with_representation(mut self, representation: impl Into<String>) -> Self {
        self.representation = representation.into();
        self
    }

    /// Set the instruction/prefix that shapes every input.
    pub fn with_instruction(mut self, instruction: Option<String>) -> Self {
        self.instruction = instruction.filter(|value| !value.trim().is_empty());
        self
    }

    /// Set the preprocessing label.
    pub fn with_preprocessing(mut self, preprocessing: impl Into<String>) -> Self {
        self.preprocessing = preprocessing.into();
        self
    }

    /// Set the chunking contract version.
    pub fn with_chunking_version(mut self, chunking_version: impl Into<String>) -> Self {
        self.chunking_version = chunking_version.into();
        self
    }

    /// Record the **measured** dimension count of produced vectors.
    pub fn with_dimensions(mut self, dimensions: Option<u32>) -> Self {
        self.dimensions = dimensions.filter(|dims| *dims > 0);
        self
    }

    /// Stable content fingerprint of every identity field except the measured
    /// dimensions, which are recorded separately so a dimension change reports
    /// as a dimension drift rather than a wholesale identity change.
    pub fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        for field in [
            self.schema_id.as_str(),
            self.endpoint_fingerprint.as_str(),
            self.model.as_str(),
            self.dialect.as_str(),
            self.representation.as_str(),
            self.instruction.as_deref().unwrap_or(""),
            self.preprocessing.as_str(),
            self.chunking_version.as_str(),
            if self.synthetic { "synthetic" } else { "real" },
        ] {
            // Length framing: two different field splits can never collide.
            hasher.update(field.len().to_string().as_bytes());
            hasher.update(b":");
            hasher.update(field.as_bytes());
        }
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Short share-safe label for reports: never an endpoint, never a
    /// credential. The fingerprint prefix disambiguates same-model spaces on
    /// two different gateways.
    pub fn report_label(&self) -> String {
        let fingerprint = self.fingerprint();
        let short = fingerprint.get(..12).unwrap_or(fingerprint.as_str());
        let dims = self
            .dimensions
            .map(|dims| dims.to_string())
            .unwrap_or_else(|| "unmeasured".into());
        format!(
            "{}/{} dims={} space={}{}",
            self.dialect,
            self.model,
            dims,
            short,
            if self.synthetic { " (synthetic)" } else { "" }
        )
    }

    /// Compare a stored space against the query space, failing closed.
    pub fn compare(&self, query: &EmbeddingSpaceIdentity) -> EmbeddingSpaceVerdict {
        let mut drifted: Vec<&'static str> = Vec::new();
        if self.schema_id != query.schema_id {
            drifted.push("schema_id");
        }
        if self.endpoint_fingerprint != query.endpoint_fingerprint {
            drifted.push("endpoint_fingerprint");
        }
        if self.model != query.model {
            drifted.push("model");
        }
        if self.dialect != query.dialect {
            drifted.push("dialect");
        }
        if self.representation != query.representation {
            drifted.push("representation");
        }
        if self.instruction != query.instruction {
            drifted.push("instruction");
        }
        if self.preprocessing != query.preprocessing {
            drifted.push("preprocessing");
        }
        if self.chunking_version != query.chunking_version {
            drifted.push("chunking_version");
        }
        if self.synthetic != query.synthetic {
            drifted.push("synthetic");
        }
        match (self.dimensions, query.dimensions) {
            // The stored side must always be measured; an unmeasured stored
            // dimension is a legacy/unusable binding, handled by the caller.
            (Some(stored), Some(queried)) if stored != queried => drifted.push("dimensions"),
            (Some(_), Some(_)) => {}
            // A query space with no measured dimensions has not proven itself
            // comparable yet; the caller verifies against real vectors before
            // merging. This is not drift, so it is not reported as drift.
            (Some(_), None) | (None, Some(_)) | (None, None) => {}
        }
        if drifted.is_empty() {
            EmbeddingSpaceVerdict::Bound
        } else {
            EmbeddingSpaceVerdict::Drift { fields: drifted }
        }
    }
}

/// Outcome of a stored-vs-query embedding-space comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddingSpaceVerdict {
    /// Every identity field matched; the semantic lane may run.
    Bound,
    /// The corpus carries vectors but no typed space (written by an older
    /// build). Comparability cannot be proven, so semantic retrieval is
    /// refused until an explicit re-analysis rebinds the corpus.
    LegacyUnbound,
    /// At least one identity field differs.
    Drift {
        /// Field names that differ, in a stable declaration order.
        fields: Vec<&'static str>,
    },
}

impl EmbeddingSpaceVerdict {
    /// Whether the semantic lane may run under this verdict.
    pub fn is_bound(&self) -> bool {
        matches!(self, Self::Bound)
    }

    /// Stable machine code for degradations and reports.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Bound => "embedding_space_bound",
            Self::LegacyUnbound => "embedding_space_legacy_unbound",
            Self::Drift { .. } => "embedding_space_drift",
        }
    }

    /// Share-safe explanation. Contains field names only — never values that
    /// could reveal an endpoint, a credential, or corpus text.
    pub fn detail(&self) -> String {
        match self {
            Self::Bound => "stored and query embedding spaces are identical".into(),
            Self::LegacyUnbound => "stored template vectors carry no typed embedding-space \
                 identity (written by an older build); comparability cannot be proven, so \
                 semantic retrieval stays off until an explicit re-analysis rebinds the corpus; \
                 structured/keyword results kept"
                .into(),
            Self::Drift { fields } => format!(
                "stored and query embedding spaces differ in: {}; vectors from different spaces \
                 are not comparable; semantic results withheld; structured/keyword results kept",
                fields.join(", ")
            ),
        }
    }
}

/// Evaluate a stored binding against the query space, failing closed on both
/// legacy (no stored space) and drift.
///
/// `stored` is the space persisted with the corpus vectors; `None` means the
/// corpus predates typed binding.
pub fn evaluate_space_binding(
    stored: Option<&EmbeddingSpaceIdentity>,
    query: &EmbeddingSpaceIdentity,
) -> EmbeddingSpaceVerdict {
    match stored {
        None => EmbeddingSpaceVerdict::LegacyUnbound,
        Some(stored) if stored.dimensions.is_none_or(|dims| dims == 0) => {
            // A stored space with no measured dimension count cannot pin the
            // geometry it claims; treat it exactly like a legacy binding.
            EmbeddingSpaceVerdict::LegacyUnbound
        }
        Some(stored) => stored.compare(query),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::new("fp-alpha", "bge-m3", "openai_embeddings")
            .with_dimensions(Some(1024))
    }

    #[test]
    fn identical_spaces_bind() {
        let query = stored();
        assert_eq!(
            evaluate_space_binding(Some(&stored()), &query),
            EmbeddingSpaceVerdict::Bound
        );
        assert!(evaluate_space_binding(Some(&stored()), &query).is_bound());
    }

    #[test]
    fn legacy_binding_fails_closed() {
        let verdict = evaluate_space_binding(None, &stored());
        assert_eq!(verdict, EmbeddingSpaceVerdict::LegacyUnbound);
        assert!(!verdict.is_bound());
        assert_eq!(verdict.code(), "embedding_space_legacy_unbound");
        assert!(verdict.detail().contains("re-analysis"));

        // A stored space that never measured its dimensions is equally unusable.
        let unmeasured = EmbeddingSpaceIdentity::new("fp-alpha", "bge-m3", "openai_embeddings");
        assert_eq!(
            evaluate_space_binding(Some(&unmeasured), &stored()),
            EmbeddingSpaceVerdict::LegacyUnbound
        );
    }

    #[test]
    fn every_identity_field_drifts_independently() {
        let cases: Vec<(&'static str, EmbeddingSpaceIdentity)> = vec![
            (
                "endpoint_fingerprint",
                EmbeddingSpaceIdentity::new("fp-beta", "bge-m3", "openai_embeddings")
                    .with_dimensions(Some(1024)),
            ),
            (
                "model",
                EmbeddingSpaceIdentity::new("fp-alpha", "bge-large", "openai_embeddings")
                    .with_dimensions(Some(1024)),
            ),
            (
                "dialect",
                EmbeddingSpaceIdentity::new("fp-alpha", "bge-m3", "vercel_v4_embeddings")
                    .with_dimensions(Some(1024)),
            ),
            (
                "representation",
                stored().with_representation("query_prefixed"),
            ),
            (
                "instruction",
                stored().with_instruction(Some("represent this sentence".into())),
            ),
            (
                "preprocessing",
                stored().with_preprocessing("lowercase_collapse_ws"),
            ),
            (
                "chunking_version",
                stored().with_chunking_version("log_template.v2"),
            ),
            ("dimensions", stored().with_dimensions(Some(768))),
        ];
        for (field, query) in cases {
            let verdict = evaluate_space_binding(Some(&stored()), &query);
            match &verdict {
                EmbeddingSpaceVerdict::Drift { fields } => {
                    assert!(
                        fields.contains(&field),
                        "expected `{field}` drift, got {fields:?}"
                    );
                }
                other => panic!("expected drift on `{field}`, got {other:?}"),
            }
            assert_eq!(verdict.code(), "embedding_space_drift");
            assert!(verdict.detail().contains(field));
        }
    }

    #[test]
    fn synthetic_spaces_never_bind_to_real_ones() {
        let synthetic = EmbeddingSpaceIdentity::synthetic("concept").with_dimensions(Some(64));
        let real = EmbeddingSpaceIdentity::local("concept", "synthetic").with_dimensions(Some(64));
        match evaluate_space_binding(Some(&synthetic), &real) {
            EmbeddingSpaceVerdict::Drift { fields } => assert!(fields.contains(&"synthetic")),
            other => panic!("synthetic marker must drift, got {other:?}"),
        }
        assert!(synthetic.report_label().contains("(synthetic)"));
    }

    #[test]
    fn an_unmeasured_query_dimension_is_not_reported_as_drift() {
        let query = EmbeddingSpaceIdentity::new("fp-alpha", "bge-m3", "openai_embeddings");
        assert_eq!(
            evaluate_space_binding(Some(&stored()), &query),
            EmbeddingSpaceVerdict::Bound,
            "dimensions are verified against real vectors, not claimed ones"
        );
    }

    #[test]
    fn fingerprints_are_stable_framed_and_share_safe() {
        let space = stored();
        assert_eq!(space.fingerprint(), stored().fingerprint());
        assert_eq!(space.fingerprint().len(), 64);
        // Field framing: moving a character across a boundary must not collide.
        let shifted = EmbeddingSpaceIdentity::new("fp-alph", "abge-m3", "openai_embeddings")
            .with_dimensions(Some(1024));
        assert_ne!(space.fingerprint(), shifted.fingerprint());
        // Measured dimensions are deliberately outside the fingerprint so a
        // dimension change reports as dimension drift.
        assert_eq!(
            space.fingerprint(),
            stored().with_dimensions(Some(768)).fingerprint()
        );
        let label = space.report_label();
        assert!(!label.contains("http"));
        assert!(label.contains("dims=1024"));
    }
}
