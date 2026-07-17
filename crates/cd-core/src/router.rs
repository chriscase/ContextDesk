//! Multi-source routing budgets (cheap sources first).

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

/// Budget for one turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterBudget {
    /// Max sources to fan out.
    pub max_sources: usize,
    /// Max tool rounds.
    pub max_tool_rounds: usize,
    /// Preferred order.
    pub order: Vec<SourceKind>,
}

impl Default for RouterBudget {
    fn default() -> Self {
        Self {
            max_sources: 3,
            max_tool_rounds: 8,
            order: vec![
                SourceKind::Memory,
                SourceKind::Files,
                SourceKind::Mcp,
                SourceKind::Sql,
                SourceKind::Wiki,
            ],
        }
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
            // order bias
            if let Some(pos) = budget.order.iter().position(|x| *x == k) {
                score += (budget.order.len() - pos) as i32;
            }
            (score, k)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
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
}
