//! Per-model context budgets — default, declared (from catalogs), learned (from errors).
//!
//! ContextDesk sizes model-facing history in **characters** via
//! [`crate::sessions::estimate_context_chars`]. Many gateways advertise limits
//! in **tokens**. We convert with a conservative factor and tighten budgets
//! when the provider returns a context-length error.

use crate::sessions::DEFAULT_CONTEXT_CHAR_BUDGET;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Floor so a single turn can still carry system + one tool pair.
pub const MIN_CONTEXT_CHAR_BUDGET: usize = 24_000;

/// Ceiling even when a catalog claims enormous windows (keeps desktop stable).
pub const MAX_CONTEXT_CHAR_BUDGET: usize = 480_000;

/// Rough tokens→chars for our byte-length estimator (chars ≈ tokens × 4).
/// Use 3.5-ish via integer math: tokens * 7 / 2, then take 90% headroom.
fn tokens_to_char_budget(tokens: u64) -> usize {
    if tokens == 0 {
        return DEFAULT_CONTEXT_CHAR_BUDGET;
    }
    let chars = tokens.saturating_mul(7) / 2; // ×3.5
    let with_headroom = chars.saturating_mul(90) / 100;
    clamp_budget(with_headroom as usize)
}

fn clamp_budget(n: usize) -> usize {
    n.clamp(MIN_CONTEXT_CHAR_BUDGET, MAX_CONTEXT_CHAR_BUDGET)
}

/// How a budget was established.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextBudgetSource {
    /// Product default (`DEFAULT_CONTEXT_CHAR_BUDGET`).
    #[default]
    Default,
    /// From model catalog / gateway metadata.
    Declared,
    /// Learned by shrinking after a context-length failure.
    Learned,
}

/// One model's remembered budget.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelContextBudgetEntry {
    /// Character budget for model-facing context preparation.
    pub budget_chars: usize,
    /// Provenance.
    pub source: ContextBudgetSource,
    /// Unix seconds when last updated.
    #[serde(default)]
    pub updated_at: i64,
    /// Optional last observed context-length error (redacted free text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_note: Option<String>,
}

impl ModelContextBudgetEntry {
    fn now_entry(budget_chars: usize, source: ContextBudgetSource) -> Self {
        Self {
            budget_chars: clamp_budget(budget_chars),
            source,
            updated_at: crate::embed::now_unix_secs(),
            last_error_note: None,
        }
    }
}

/// Map of model id → budget (persisted in [`crate::config::AppConfig`]).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ModelContextBudgets {
    /// Keyed by chat model id (profile.chat_model), case-sensitive as the gateway uses.
    #[serde(default)]
    pub by_model: HashMap<String, ModelContextBudgetEntry>,
}

impl ModelContextBudgets {
    /// Resolve effective char budget for a model id (or default).
    pub fn resolve(&self, model_id: Option<&str>) -> usize {
        let Some(id) = model_id.map(str::trim).filter(|s| !s.is_empty()) else {
            return DEFAULT_CONTEXT_CHAR_BUDGET;
        };
        self.by_model
            .get(id)
            .map(|e| clamp_budget(e.budget_chars))
            .unwrap_or(DEFAULT_CONTEXT_CHAR_BUDGET)
    }

    /// Record a catalog-declared limit (tokens preferred).
    ///
    /// Does not overwrite a **stricter learned** budget (learned wins if smaller).
    pub fn note_declared_tokens(&mut self, model_id: &str, tokens: u64) {
        let id = model_id.trim();
        if id.is_empty() || tokens == 0 {
            return;
        }
        let declared = tokens_to_char_budget(tokens);
        match self.by_model.get(id) {
            Some(existing)
                if existing.source == ContextBudgetSource::Learned
                    && existing.budget_chars < declared =>
            {
                // Keep the tighter learned limit.
            }
            Some(existing) if existing.budget_chars == declared => {}
            _ => {
                self.by_model.insert(
                    id.to_string(),
                    ModelContextBudgetEntry::now_entry(declared, ContextBudgetSource::Declared),
                );
            }
        }
    }

    /// After a context-length failure when we had sent ~`chars_sent` to the model,
    /// tighten the budget for next time. Returns the new budget if recorded.
    pub fn learn_from_context_error(
        &mut self,
        model_id: Option<&str>,
        chars_sent: usize,
        error_note: &str,
    ) -> Option<usize> {
        let id = model_id.map(str::trim).filter(|s| !s.is_empty())?;
        // Shrink below what failed: 80% of the oversize payload, floored.
        let target = clamp_budget(
            chars_sent
                .saturating_mul(80)
                .saturating_div(100)
                .max(MIN_CONTEXT_CHAR_BUDGET),
        );
        let current = self.resolve(Some(id));
        // Only tighten (never raise on errors).
        let new_budget = target
            .min(current.saturating_sub(1))
            .max(MIN_CONTEXT_CHAR_BUDGET);
        if new_budget >= current && self.by_model.contains_key(id) {
            // Already at or below; still stamp learned note.
            if let Some(e) = self.by_model.get_mut(id) {
                e.source = ContextBudgetSource::Learned;
                e.updated_at = crate::embed::now_unix_secs();
                e.last_error_note = Some(truncate_note(error_note));
            }
            return Some(current);
        }
        let mut entry =
            ModelContextBudgetEntry::now_entry(new_budget, ContextBudgetSource::Learned);
        entry.last_error_note = Some(truncate_note(error_note));
        self.by_model.insert(id.to_string(), entry);
        Some(new_budget)
    }
}

fn truncate_note(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 200 {
        return t.to_string();
    }
    t.chars().take(197).collect::<String>() + "…"
}

/// Pull a context-length token count from a JSON model row if present.
pub fn context_tokens_from_model_json(row: &serde_json::Value) -> Option<u64> {
    const KEYS: &[&str] = &[
        "context_length",
        "context_window",
        "max_model_len",
        "max_position_embeddings",
        "max_seq_len",
        "max_tokens",
        "n_ctx",
        "context_size",
    ];
    for k in KEYS {
        if let Some(n) = row.get(*k).and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().map(|i| i.max(0) as u64))
                .or_else(|| v.as_f64().map(|f| f.max(0.0) as u64))
        }) {
            // Ignore tiny nonsense and output-only max_tokens (e.g. 4096 completion caps
            // are ambiguous — only accept if clearly a window-sized number).
            if n >= 2048 {
                return Some(n);
            }
        }
    }
    // Nested: meta.context_length, parameters.num_ctx (Ollama)
    if let Some(meta) = row.get("meta").or_else(|| row.get("details")) {
        if let Some(n) = context_tokens_from_model_json(meta) {
            return Some(n);
        }
    }
    if let Some(params) = row.get("parameters").or_else(|| row.get("model_info")) {
        if let Some(n) = context_tokens_from_model_json(params) {
            return Some(n);
        }
        // Ollama sometimes has "num_ctx": "8192" as string inside parameters string — skip.
        if let Some(n) = params.get("num_ctx").and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        }) {
            if n >= 2048 {
                return Some(n);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_defaults() {
        let b = ModelContextBudgets::default();
        assert_eq!(b.resolve(None), DEFAULT_CONTEXT_CHAR_BUDGET);
        assert_eq!(b.resolve(Some("gpt-x")), DEFAULT_CONTEXT_CHAR_BUDGET);
    }

    #[test]
    fn declared_tokens_set_budget() {
        let mut b = ModelContextBudgets::default();
        b.note_declared_tokens("big-model", 32_000);
        let got = b.resolve(Some("big-model"));
        assert!(got < DEFAULT_CONTEXT_CHAR_BUDGET || got >= MIN_CONTEXT_CHAR_BUDGET);
        assert!(got >= MIN_CONTEXT_CHAR_BUDGET);
        // 32k tokens * 3.5 * 0.9 ≈ 100800
        assert!((90_000..=120_000).contains(&got), "got {got}");
    }

    #[test]
    fn learned_tightens_and_beats_declared() {
        let mut b = ModelContextBudgets::default();
        b.note_declared_tokens("m", 100_000); // large declared
        let before = b.resolve(Some("m"));
        let learned = b
            .learn_from_context_error(Some("m"), 50_000, "context_length_exceeded")
            .unwrap();
        assert!(learned < before);
        assert!(learned <= 50_000 * 80 / 100);
        assert_eq!(
            b.by_model.get("m").unwrap().source,
            ContextBudgetSource::Learned
        );
        // Declared larger must not wipe learned tighter
        b.note_declared_tokens("m", 200_000);
        assert_eq!(b.resolve(Some("m")), learned);
    }

    #[test]
    fn parse_context_tokens_from_row() {
        let row = serde_json::json!({"id": "x", "context_length": 8192});
        assert_eq!(context_tokens_from_model_json(&row), Some(8192));
        let row2 = serde_json::json!({"id": "y", "max_model_len": 32768});
        assert_eq!(context_tokens_from_model_json(&row2), Some(32768));
        let row3 = serde_json::json!({"id": "z", "max_tokens": 512}); // too small / completion-like
        assert_eq!(context_tokens_from_model_json(&row3), None);
    }
}
