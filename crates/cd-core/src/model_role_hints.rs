//! Versioned model-role **hint** catalog (#723).
//!
//! Classifies discovered model **ids** into suggested roles for setup and
//! preflight. A name is evidence for a **suggestion**, never proof of tools,
//! quality, context length, structured output, embeddings, or reranking.
//!
//! Measured capabilities (#724) and user overrides stay on separate paths;
//! this module only emits name-based hints.

use serde::{Deserialize, Serialize};

/// Catalog / schema version for caches and diagnostics (bump when rules change).
pub const MODEL_ROLE_HINT_CATALOG_VERSION: &str = "contextdesk.model_role_hints.v1";

/// Suggested functional role for a model deployment id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRoleHint {
    /// Chat / investigation / generation / tool-using assistant.
    Investigator,
    /// Embedding retrieval models.
    Embedding,
    /// Reranking / cross-encoder style models.
    Reranker,
    /// Private alias, unfamiliar, or ambiguous id — keep selectable, unqualified.
    Unknown,
}

/// How strongly the name matches a role pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HintConfidence {
    /// Strong family or keyword match.
    High,
    /// Weaker or partial pattern match.
    Medium,
    /// No qualifying pattern (unknown / private alias).
    Low,
}

/// Where the suggestion came from. Only `NameHint` is produced here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HintSource {
    /// Derived solely from the model id string.
    NameHint,
    /// Provider catalog metadata (not produced by this pure module).
    ProviderMetadata,
    /// Host-observed probe / measurement (not produced by this pure module).
    MeasuredLocally,
    /// Explicit user role or default choice (not produced by this pure module).
    UserOverride,
}

/// One role suggestion for a model id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRoleSuggestion {
    /// Catalog version that produced this suggestion.
    pub catalog_version: String,
    /// Suggested role.
    pub role: ModelRoleHint,
    /// Confidence of the name match.
    pub confidence: HintConfidence,
    /// Evidence basis (always name hint from this module).
    pub source: HintSource,
    /// Short “Suggested for …” line for UI.
    pub suggested_for: String,
    /// Human basis label (e.g. "Name hint").
    pub basis_label: String,
    /// When false, do not rank as an ordinary chat default.
    pub ordinary_chat_default: bool,
}

impl ModelRoleHint {
    /// Wire kind string used by discovery DTOs (`chat` | `embedding` | `reranker` | `unknown`).
    pub fn as_kind_str(self) -> &'static str {
        match self {
            Self::Investigator => "chat",
            Self::Embedding => "embedding",
            Self::Reranker => "reranker",
            Self::Unknown => "unknown",
        }
    }
}

/// Classify a model id into a role suggestion (pure, no I/O).
pub fn classify_model_role(id: &str) -> ModelRoleSuggestion {
    let trimmed = id.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (role, confidence) = classify_role_and_confidence(&lower);
    let ordinary_chat_default =
        matches!(role, ModelRoleHint::Investigator) && !matches!(confidence, HintConfidence::Low);
    ModelRoleSuggestion {
        catalog_version: MODEL_ROLE_HINT_CATALOG_VERSION.to_string(),
        role,
        confidence,
        source: HintSource::NameHint,
        suggested_for: suggested_for_line(role).to_string(),
        basis_label: "Name hint".to_string(),
        ordinary_chat_default,
    }
}

/// Sort model ids for a chat picker: likely investigators first; embedding and
/// reranker last. Stable by id within the same rank. Does not drop any id —
/// unknown and specialty models remain selectable.
pub fn sort_ids_for_chat_picker(ids: &[String]) -> Vec<String> {
    let mut scored: Vec<(i32, &String)> = ids.iter().map(|id| (chat_picker_rank(id), id)).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored.into_iter().map(|(_, id)| id.clone()).collect()
}

/// Whether this id should be offered as a **preferred** ordinary chat default
/// candidate (still not auto-applied without user confirmation).
pub fn is_preferred_chat_default_candidate(id: &str) -> bool {
    classify_model_role(id).ordinary_chat_default
}

fn classify_role_and_confidence(lower: &str) -> (ModelRoleHint, HintConfidence) {
    // Order matters:
    // 1) Reranker before embedding (e.g. "bge-reranker" contains "bge-")
    // 2) Embedding before chat keywords (e.g. "chat-bge-m3-embed")
    // 3) Investigator chat families last
    if reranker_match(lower) {
        let conf = if strong_reranker(lower) {
            HintConfidence::High
        } else {
            HintConfidence::Medium
        };
        return (ModelRoleHint::Reranker, conf);
    }
    if embedding_match(lower) {
        let conf = if strong_embedding(lower) {
            HintConfidence::High
        } else {
            HintConfidence::Medium
        };
        return (ModelRoleHint::Embedding, conf);
    }
    if investigator_match(lower) {
        let conf = if strong_investigator(lower) {
            HintConfidence::High
        } else {
            HintConfidence::Medium
        };
        return (ModelRoleHint::Investigator, conf);
    }
    (ModelRoleHint::Unknown, HintConfidence::Low)
}

fn embedding_match(s: &str) -> bool {
    s.contains("embed")
        || s.contains("text-embedding")
        || s.contains("nomic")
        || s.contains("e5-")
        || s.contains("bge-")
        || s.contains("gte-")
        || s.contains("voyage")
        || s.contains("minilm")
        || s.contains("mxbai-embed")
        || s.contains("instructor")
}

fn strong_embedding(s: &str) -> bool {
    s.contains("embed")
        || s.contains("text-embedding")
        || s.contains("bge-")
        || s.contains("nomic-embed")
        || s.contains("voyage")
}

fn reranker_match(s: &str) -> bool {
    s.contains("rerank")
        || s.contains("re-rank")
        || s.contains("cross-encoder")
        || s.contains("cross_encoder")
        || s.contains("bge-reranker")
}

fn strong_reranker(s: &str) -> bool {
    s.contains("rerank") || s.contains("cross-encoder") || s.contains("cross_encoder")
}

fn investigator_match(s: &str) -> bool {
    s.contains("gpt")
        || s.contains("claude")
        || s.contains("mistral")
        || s.contains("llama")
        || s.contains("grok")
        || s.contains("sonnet")
        || s.contains("opus")
        || s.contains("haiku")
        || s.contains("gemini")
        || s.contains("qwen")
        || s.contains("deepseek")
        || s.contains("phi")
        || s.contains("command")
        || s.contains("chat")
        || s.contains("instruct")
        || s.contains("o1")
        || s.contains("o3")
        || s.contains("o4")
}

fn strong_investigator(s: &str) -> bool {
    s.contains("gpt-4")
        || s.contains("gpt-5")
        || s.contains("claude")
        || s.contains("sonnet")
        || s.contains("opus")
        || s.contains("grok-3")
        || s.contains("grok-4")
        || s.contains("mistral")
        || s.contains("llama-3")
        || s.contains("gemini")
}

fn suggested_for_line(role: ModelRoleHint) -> &'static str {
    match role {
        ModelRoleHint::Investigator => {
            "Suggested for: investigation chat and generation (name hint only)"
        }
        ModelRoleHint::Embedding => {
            "Suggested for: embedding retrieval — not an ordinary chat default"
        }
        ModelRoleHint::Reranker => "Suggested for: reranking — not an ordinary chat default",
        ModelRoleHint::Unknown => {
            "Unqualified model id — remains selectable; confirm suitability before use"
        }
    }
}

fn chat_picker_rank(id: &str) -> i32 {
    let s = classify_model_role(id);
    match s.role {
        ModelRoleHint::Investigator => match s.confidence {
            HintConfidence::High => 100,
            HintConfidence::Medium => 80,
            HintConfidence::Low => 40,
        },
        ModelRoleHint::Unknown => 30,
        ModelRoleHint::Embedding => -50,
        ModelRoleHint::Reranker => -60,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_version_is_stable() {
        assert_eq!(
            classify_model_role("grok-3").catalog_version,
            MODEL_ROLE_HINT_CATALOG_VERSION
        );
    }

    #[test]
    fn classifies_familiar_investigator_families() {
        for id in [
            "grok-3",
            "gpt-4o-mini",
            "claude-sonnet-4-20250514",
            "mistral",
            "llama-3.1-8b-instruct",
        ] {
            let s = classify_model_role(id);
            assert_eq!(s.role, ModelRoleHint::Investigator, "{id}");
            assert!(s.ordinary_chat_default, "{id}");
            assert_eq!(s.source, HintSource::NameHint);
            assert_eq!(s.basis_label, "Name hint");
            assert!(s.suggested_for.contains("Suggested for"));
        }
    }

    #[test]
    fn classifies_embedding_names_not_as_chat_defaults() {
        for id in [
            "bge-m3",
            "nomic-embed-text",
            "text-embedding-3-small",
            "voyage-3",
            "mxbai-embed-large",
        ] {
            let s = classify_model_role(id);
            assert_eq!(s.role, ModelRoleHint::Embedding, "{id}");
            assert!(!s.ordinary_chat_default, "{id}");
            assert!(s.suggested_for.contains("embedding"), "{id}");
        }
    }

    #[test]
    fn classifies_reranker_names() {
        for id in [
            "qwen3-reranker-0.6b",
            "bge-reranker-v2-m3",
            "ms-marco-MiniLM-L-6-v2-rerank",
            "cross-encoder-ms-marco",
        ] {
            let s = classify_model_role(id);
            assert_eq!(s.role, ModelRoleHint::Reranker, "{id}");
            assert!(!s.ordinary_chat_default, "{id}");
        }
    }

    #[test]
    fn private_aliases_remain_unknown_and_selectable() {
        for id in ["corp-prod-v3", "team-a-router", "internal-deploy-42"] {
            let s = classify_model_role(id);
            assert_eq!(s.role, ModelRoleHint::Unknown, "{id}");
            assert_eq!(s.confidence, HintConfidence::Low, "{id}");
            assert!(!s.ordinary_chat_default, "{id}");
            // Still present in sort output
            let sorted = sort_ids_for_chat_picker(&[id.to_string(), "grok-3".into()]);
            assert!(sorted.iter().any(|x| x == id));
        }
    }

    #[test]
    fn deceptive_names_prefer_specialty_roles() {
        // Contains "chat" but embedding-shaped.
        let embedish = classify_model_role("chat-bge-m3-embed");
        assert_eq!(embedish.role, ModelRoleHint::Embedding);
        assert!(!embedish.ordinary_chat_default);

        let rerankish = classify_model_role("gpt-oss-reranker-v1");
        assert_eq!(rerankish.role, ModelRoleHint::Reranker);
        assert!(!rerankish.ordinary_chat_default);

        // "instruct" alone without specialty markers → investigator
        let chat = classify_model_role("custom-instruct-7b");
        assert_eq!(chat.role, ModelRoleHint::Investigator);
    }

    #[test]
    fn mixed_inventory_sorts_chat_before_embed_and_rerank() {
        let ids = vec![
            "bge-m3".into(),
            "qwen3-reranker-0.6b".into(),
            "corp-alias".into(),
            "grok-3".into(),
            "nomic-embed-text".into(),
        ];
        let sorted = sort_ids_for_chat_picker(&ids);
        let grok = sorted.iter().position(|x| x == "grok-3").unwrap();
        let embed = sorted.iter().position(|x| x == "bge-m3").unwrap();
        let rerank = sorted
            .iter()
            .position(|x| x == "qwen3-reranker-0.6b")
            .unwrap();
        assert!(grok < embed);
        assert!(grok < rerank);
        // All ids preserved (including unknown alias).
        assert_eq!(sorted.len(), ids.len());
        assert!(sorted.iter().any(|x| x == "corp-alias"));
    }

    #[test]
    fn kind_strings_for_discovery_dto() {
        assert_eq!(ModelRoleHint::Investigator.as_kind_str(), "chat");
        assert_eq!(ModelRoleHint::Embedding.as_kind_str(), "embedding");
        assert_eq!(ModelRoleHint::Reranker.as_kind_str(), "reranker");
        assert_eq!(ModelRoleHint::Unknown.as_kind_str(), "unknown");
    }

    #[test]
    fn never_mutates_caller_defaults() {
        // Pure function: classifying must not imply a write. Call twice, same result.
        let a = classify_model_role("user-chosen-private-id");
        let b = classify_model_role("user-chosen-private-id");
        assert_eq!(a, b);
        assert!(!a.ordinary_chat_default);
    }
}
