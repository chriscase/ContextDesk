//! Multi-source routing budgets — enforced on the live agent path, not cosmetic.

use serde::{Deserialize, Serialize};

/// Source kinds ordered by cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Project memory.
    Memory,
    /// Local files / KB.
    Files,
    /// MCP tools.
    Mcp,
    /// SQL catalog.
    Sql,
    /// Remote wiki.
    Wiki,
}

/// Budget for one turn (defaults are conservative).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouterBudget {
    /// Max sources to fan out (trail / ranking).
    #[serde(default = "default_max_sources")]
    pub max_sources: usize,
    /// Max tool rounds in the agent loop.
    #[serde(default = "default_max_tool_rounds")]
    pub max_tool_rounds: usize,
    /// Cap results from each source-query tool (search_kb, etc.).
    #[serde(default = "default_max_results_per_source")]
    pub max_results_per_source: usize,
    /// Wall-clock deadline for the agent loop (milliseconds).
    #[serde(default = "default_deadline_ms")]
    pub deadline_ms: u64,
    /// Preferred order.
    #[serde(default = "default_order")]
    pub order: Vec<SourceKind>,
}

fn default_max_sources() -> usize {
    3
}
fn default_max_tool_rounds() -> usize {
    // News / multi-fetch turns often need search + a few fetches + answer.
    // Hard stop still applies; agent synthesizes once this is hit.
    12
}
fn default_max_results_per_source() -> usize {
    8
}
fn default_deadline_ms() -> u64 {
    60_000
}
fn default_order() -> Vec<SourceKind> {
    vec![
        SourceKind::Memory,
        SourceKind::Files,
        SourceKind::Mcp,
        SourceKind::Sql,
        SourceKind::Wiki,
    ]
}

impl Default for RouterBudget {
    fn default() -> Self {
        Self {
            max_sources: default_max_sources(),
            max_tool_rounds: default_max_tool_rounds(),
            max_results_per_source: default_max_results_per_source(),
            deadline_ms: default_deadline_ms(),
            order: default_order(),
        }
    }
}

impl RouterBudget {
    /// Clamp fields to safe positive ranges (Settings validation).
    pub fn sanitized(mut self) -> Self {
        self.max_sources = self.max_sources.clamp(1, 16);
        self.max_tool_rounds = self.max_tool_rounds.clamp(1, 32);
        self.max_results_per_source = self.max_results_per_source.clamp(1, 50);
        self.deadline_ms = self.deadline_ms.clamp(500, 600_000);
        if self.order.is_empty() {
            self.order = default_order();
        }
        self
    }

    /// Honest trail step describing what will be enforced.
    pub fn trail_step(&self) -> String {
        format!(
            "budget:sources={},rounds={},per_source={},deadline={}ms",
            self.max_sources, self.max_tool_rounds, self.max_results_per_source, self.deadline_ms
        )
    }
}

/// Rank available sources for a query (simple heuristics).
pub fn rank_sources(
    query: &str,
    available: &[SourceKind],
    budget: &RouterBudget,
) -> Vec<SourceKind> {
    let q = query.to_lowercase();
    let mut scored: Vec<(i32, SourceKind)> = available
        .iter()
        .copied()
        .map(|k| {
            let mut score = match k {
                SourceKind::Memory => 100,
                SourceKind::Files => 90,
                SourceKind::Mcp => 50,
                SourceKind::Sql => 40,
                SourceKind::Wiki => 30,
            };
            if (q.contains("table") || q.contains("schema") || q.contains("sql"))
                && k == SourceKind::Sql
            {
                score += 80;
            }
            if (q.contains("confluence") || q.contains("wiki") || q.contains("runbook"))
                && k == SourceKind::Wiki
            {
                score += 40;
            }
            if let Some(pos) = budget.order.iter().position(|x| *x == k) {
                score += (budget.order.len() - pos) as i32;
            }
            (score, k)
        })
        .collect();
    scored.sort_by_key(|b| std::cmp::Reverse(b.0));
    scored
        .into_iter()
        .take(budget.max_sources)
        .map(|(_, k)| k)
        .collect()
}

/// Human trail steps.
pub fn trail_for(sources: &[SourceKind]) -> Vec<String> {
    sources.iter().map(|s| format!("source:{s:?}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_sql_for_schema_query() {
        let avail = [SourceKind::Files, SourceKind::Sql, SourceKind::Wiki];
        let budget = RouterBudget {
            max_sources: 3,
            ..RouterBudget::default()
        };
        let ranked = rank_sources("what table holds schema sessions", &avail, &budget);
        assert_eq!(ranked[0], SourceKind::Sql, "ranked={ranked:?}");
    }

    #[test]
    fn default_memory_first() {
        let avail = [SourceKind::Wiki, SourceKind::Memory, SourceKind::Files];
        let ranked = rank_sources("how does auth work", &avail, &RouterBudget::default());
        assert_eq!(ranked[0], SourceKind::Memory);
    }

    #[test]
    fn trail_step_includes_enforced_fields() {
        let b = RouterBudget::default();
        let t = b.trail_step();
        assert!(t.contains("sources=3"));
        assert!(t.contains("rounds=12"));
        assert!(t.contains("per_source=8"));
        assert!(t.contains("deadline="));
    }

    #[test]
    fn sanitized_clamps_bounds() {
        let b = RouterBudget {
            max_sources: 0,
            max_tool_rounds: 999,
            max_results_per_source: 0,
            deadline_ms: 1,
            order: vec![],
        }
        .sanitized();
        assert_eq!(b.max_sources, 1);
        assert_eq!(b.max_tool_rounds, 32);
        assert_eq!(b.max_results_per_source, 1);
        assert_eq!(b.deadline_ms, 500);
        assert!(!b.order.is_empty());
    }
}
