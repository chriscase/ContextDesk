//! Ambient recall injection — tight budget, echo-suppressed (MEMORY.md §4 / §10.1).

use super::types::{RecallHit, RecallQuery};
use super::MemoryStore;
use crate::embed::{EmbedBackend, HybridWeights};
use crate::error::CoreResult;

/// Ambient injection budget (owner default ON + tight).
#[derive(Debug, Clone, Copy)]
pub struct AmbientBudget {
    /// Max characters of injected memory text (~1500).
    pub max_chars: usize,
    /// Max memories (≤5).
    pub max_memories: usize,
    /// Min hybrid score floor (~0.35).
    pub min_score: f32,
}

impl Default for AmbientBudget {
    fn default() -> Self {
        Self {
            max_chars: 1500,
            max_memories: 5,
            min_score: 0.35,
        }
    }
}

/// One ambient memory line ready for system context + citation.
#[derive(Debug, Clone, PartialEq)]
pub struct AmbientMemory {
    /// Citation source_id (`memory:{uuid}`).
    pub source_id: String,
    /// Short label for Citation chip.
    pub label: String,
    /// Body snippet included in context.
    pub text: String,
    /// Hybrid score.
    pub score: f32,
}

/// Result of ambient injection (context block + citation payloads).
#[derive(Debug, Clone, Default)]
pub struct AmbientInjection {
    /// First-party system text (not wrap_untrusted).
    pub context_block: String,
    /// Citation chips to emit (`source_id`, `label`).
    pub citations: Vec<(String, String)>,
    /// How many memories included.
    pub count: usize,
}

/// Build ambient memory context for a user turn.
///
/// - Filters by `min_score`, budget, and echo-suppression (skip content already
///   present in `visible_history_text`).
/// - When `enabled` is false, returns empty (explicit `recall_memory` only).
/// - Pass `embed` when the host has an [`EmbedBackend`] so ambient is hybrid
///   (cosine over stored vectors), not keyword-only (#346).
pub fn inject_memory_context(
    store: &dyn MemoryStore,
    query: &str,
    visible_history_text: &str,
    enabled: bool,
    budget: AmbientBudget,
    weights: HybridWeights,
    now_secs: i64,
) -> CoreResult<AmbientInjection> {
    inject_memory_context_with_embed(
        store,
        query,
        visible_history_text,
        enabled,
        budget,
        weights,
        now_secs,
        None,
    )
}

/// Ambient injection with an optional embed backend for semantic ranking (#346).
#[allow(clippy::too_many_arguments)]
pub fn inject_memory_context_with_embed(
    store: &dyn MemoryStore,
    query: &str,
    visible_history_text: &str,
    enabled: bool,
    budget: AmbientBudget,
    weights: HybridWeights,
    now_secs: i64,
    embed: Option<&dyn EmbedBackend>,
) -> CoreResult<AmbientInjection> {
    if !enabled || query.trim().is_empty() {
        return Ok(AmbientInjection::default());
    }
    let mut q = RecallQuery::new(query);
    q.k = budget
        .max_memories
        .saturating_mul(3)
        .max(budget.max_memories);
    q.min_score = Some(budget.min_score);
    let hits = store.recall(&q, embed, weights, now_secs)?;
    select_ambient(&hits, visible_history_text, budget)
}

fn select_ambient(
    hits: &[RecallHit],
    visible_history_text: &str,
    budget: AmbientBudget,
) -> CoreResult<AmbientInjection> {
    let history_l = visible_history_text.to_lowercase();
    let mut chars = 0usize;
    let mut items: Vec<AmbientMemory> = Vec::new();
    for h in hits {
        if h.score < budget.min_score {
            continue;
        }
        // Echo-suppress: skip if title or substantial content already in history.
        let title_l = h.record.title.to_lowercase();
        let snippet_l = h.snippet.to_lowercase();
        if !title_l.is_empty() && history_l.contains(&title_l) {
            continue;
        }
        if snippet_l.len() > 24 && history_l.contains(&snippet_l) {
            continue;
        }
        let line = format!(
            "- [{}] {} — {}",
            h.record.kind.as_str(),
            h.record.title,
            h.snippet
        );
        if chars + line.len() > budget.max_chars && !items.is_empty() {
            break;
        }
        if items.len() >= budget.max_memories {
            break;
        }
        chars += line.len();
        items.push(AmbientMemory {
            source_id: h.source_id.clone(),
            label: if h.record.title.is_empty() {
                h.record.kind.as_str().to_string()
            } else {
                h.record.title.clone()
            },
            text: line,
            score: h.score,
        });
    }
    if items.is_empty() {
        return Ok(AmbientInjection::default());
    }
    let mut block = String::from(
        "Relevant memories (first-party durable store; already secret-redacted at write time):\n",
    );
    let mut citations = Vec::new();
    for m in &items {
        block.push_str(&m.text);
        block.push('\n');
        citations.push((m.source_id.clone(), m.label.clone()));
    }
    // Hard cap on final block
    if block.len() > budget.max_chars + 120 {
        block = crate::text::truncate_bytes(&block, budget.max_chars + 120).to_string();
    }
    Ok(AmbientInjection {
        count: items.len(),
        context_block: block,
        citations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{Kind, MemoryDraft, MemoryWriteOp, SqliteMemoryStore};

    #[test]
    fn budget_and_toggle() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        for i in 0..10 {
            store
                .put(
                    MemoryWriteOp::Insert(MemoryDraft::new(
                        Kind::Fact,
                        format!("project alpha fact number {i} about shipping"),
                    )),
                    100 + i,
                )
                .unwrap();
        }
        let off = inject_memory_context(
            &store,
            "alpha shipping",
            "",
            false,
            AmbientBudget::default(),
            HybridWeights::default(),
            200,
        )
        .unwrap();
        assert_eq!(off.count, 0);

        let on = inject_memory_context(
            &store,
            "alpha shipping",
            "",
            true,
            AmbientBudget::default(),
            HybridWeights::default(),
            200,
        )
        .unwrap();
        assert!(on.count <= 5);
        assert!(on.context_block.len() <= 1500 + 200); // header slack
        assert!(!on.citations.is_empty() || on.count == 0);
        for (sid, _) in &on.citations {
            assert!(sid.starts_with("memory:"));
        }
    }

    #[test]
    fn echo_suppression() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        store
            .put(
                MemoryWriteOp::Insert({
                    let mut d = MemoryDraft::new(Kind::Fact, "unique-zebra-memory-content-xyz");
                    d.title = "Zebra Plan".into();
                    d
                }),
                1,
            )
            .unwrap();
        let hist = "User already said: Zebra Plan is done";
        let inj = inject_memory_context(
            &store,
            "zebra",
            hist,
            true,
            AmbientBudget::default(),
            HybridWeights::default(),
            10,
        )
        .unwrap();
        assert_eq!(
            inj.count, 0,
            "title already in history must be echo-suppressed"
        );
    }
}
