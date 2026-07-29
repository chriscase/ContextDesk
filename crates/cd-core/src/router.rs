//! Multi-source routing budgets — enforced on the live agent path, not cosmetic.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use url::Url;

use crate::providers::{ProviderDeadlinePreference, ProviderKind, ProviderProfile};

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
    /// Whether `deadline_ms` is a user-authored whole-turn ceiling.
    ///
    /// Existing serialized router settings predate this field and therefore
    /// migrate as explicit so an upgrade never silently lengthens a user's
    /// configured stop. A brand-new default remains adaptive.
    #[serde(default = "migrated_deadline_is_explicit")]
    pub deadline_is_explicit: bool,
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
    // Stored fallback and managed-provider adaptive ceiling. Local/private
    // profiles receive the patient adaptive plan in TurnDeadlinePlan, while
    // cancellation and one monotonic hard ceiling remain authoritative.
    120_000
}
fn migrated_deadline_is_explicit() -> bool {
    true
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
            deadline_is_explicit: false,
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
            "budget:sources={},rounds={},per_source={},deadline={}ms,deadline_policy={}",
            self.max_sources,
            self.max_tool_rounds,
            self.max_results_per_source,
            self.deadline_ms,
            if self.deadline_is_explicit {
                "explicit"
            } else {
                "adaptive"
            }
        )
    }
}

/// Bounded lifecycle phases for one provider/tool turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPhase {
    /// The provider is choosing which bounded evidence to request.
    ChoosingEvidence,
    /// The trusted host is running one bounded read.
    RetrievingEvidence,
    /// The provider is answering from a tool-closed evidence package.
    SynthesizingAnswer,
}

impl AgentPhase {
    /// Stable user-facing phase label.
    pub const fn label(self) -> &'static str {
        match self {
            Self::ChoosingEvidence => "Choosing evidence",
            Self::RetrievingEvidence => "Retrieving evidence",
            Self::SynthesizingAnswer => "Synthesizing answer",
        }
    }
}

/// Effective bounded deadline plan for one turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnDeadlinePlan {
    /// Whole-turn hard ceiling.
    pub total_ms: u64,
    /// Maximum uninterrupted provider evidence-selection wait.
    pub choosing_ms: u64,
    /// Maximum uninterrupted trusted retrieval wait.
    pub retrieving_ms: u64,
    /// Maximum uninterrupted tool-closed synthesis wait.
    pub synthesizing_ms: u64,
    /// True when the total came from an explicit user setting.
    pub explicit: bool,
}

impl TurnDeadlinePlan {
    /// Resolve the cap for one lifecycle phase.
    pub const fn for_phase(self, phase: AgentPhase) -> u64 {
        match phase {
            AgentPhase::ChoosingEvidence => self.choosing_ms,
            AgentPhase::RetrievingEvidence => self.retrieving_ms,
            AgentPhase::SynthesizingAnswer => self.synthesizing_ms,
        }
    }

    /// Build a provider-aware plan while preserving an explicit user ceiling.
    pub fn for_profile(budget: &RouterBudget, profile: &ProviderProfile) -> Self {
        let budget = budget.clone().sanitized();
        let slow_private = provider_prefers_patient_deadlines(profile);
        let total_ms = if budget.deadline_is_explicit {
            budget.deadline_ms
        } else if slow_private {
            300_000
        } else {
            120_000
        };
        let phase = |numerator: u64, denominator: u64| {
            total_ms
                .saturating_mul(numerator)
                .checked_div(denominator)
                .unwrap_or(total_ms)
                .clamp(500, total_ms)
        };
        if slow_private {
            Self {
                total_ms,
                choosing_ms: phase(2, 5),
                retrieving_ms: phase(1, 3),
                synthesizing_ms: phase(3, 5),
                explicit: budget.deadline_is_explicit,
            }
        } else {
            Self {
                total_ms,
                choosing_ms: phase(3, 8),
                retrieving_ms: phase(1, 4),
                synthesizing_ms: phase(5, 8),
                explicit: budget.deadline_is_explicit,
            }
        }
    }
}

fn provider_prefers_patient_deadlines(profile: &ProviderProfile) -> bool {
    match profile.deadline_preference {
        ProviderDeadlinePreference::Patient => return true,
        ProviderDeadlinePreference::Standard => return false,
        ProviderDeadlinePreference::Auto => {}
    }
    if profile.kind == ProviderKind::Ollama || profile.local_only {
        return true;
    }
    let Ok(url) = Url::parse(&profile.base_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".local")
        || host.ends_with(".lan")
        || host.ends_with(".internal")
        || host.ends_with(".corp")
        || host.ends_with(".intranet")
        || host.ends_with(".private")
    {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
    })
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
        assert_eq!(RouterBudget::default().deadline_ms, 120_000);
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
        assert!(t.contains("deadline_policy=adaptive"));
    }

    #[test]
    fn sanitized_clamps_bounds() {
        let b = RouterBudget {
            max_sources: 0,
            max_tool_rounds: 999,
            max_results_per_source: 0,
            deadline_ms: 1,
            deadline_is_explicit: true,
            order: vec![],
        }
        .sanitized();
        assert_eq!(b.max_sources, 1);
        assert_eq!(b.max_tool_rounds, 32);
        assert_eq!(b.max_results_per_source, 1);
        assert_eq!(b.deadline_ms, 500);
        assert!(!b.order.is_empty());
    }

    #[test]
    fn adaptive_deadlines_are_patient_for_local_and_private_profiles() {
        let budget = RouterBudget::default();
        let ollama = ProviderProfile::ollama_local();
        let local = TurnDeadlinePlan::for_profile(&budget, &ollama);
        assert_eq!(local.total_ms, 300_000);
        assert!(!local.explicit);

        let mut private = ollama.clone();
        private.kind = ProviderKind::OpenAiCompatible;
        private.local_only = false;
        private.base_url = "https://10.20.30.40/v1".into();
        let private = TurnDeadlinePlan::for_profile(&budget, &private);
        assert_eq!(private.total_ms, 300_000);

        let mut managed = ollama;
        managed.kind = ProviderKind::OpenAiCompatible;
        managed.local_only = false;
        managed.base_url = "https://models.example.com/v1".into();
        let managed = TurnDeadlinePlan::for_profile(&budget, &managed);
        assert_eq!(managed.total_ms, 120_000);

        for host in [
            "gateway.internal",
            "gateway.local",
            "gateway.lan",
            "gateway.corp",
            "gateway.intranet",
            "gateway.private",
        ] {
            let mut profile = ProviderProfile::ollama_local();
            profile.kind = ProviderKind::OpenAiCompatible;
            profile.local_only = false;
            profile.base_url = format!("https://{host}/v1");
            profile.deadline_preference = ProviderDeadlinePreference::Auto;
            assert_eq!(
                TurnDeadlinePlan::for_profile(&budget, &profile).total_ms,
                300_000,
                "host={host}"
            );
        }
    }

    #[test]
    fn explicit_profile_deadline_preference_overrides_url_inference() {
        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.local_only = false;
        profile.base_url = "https://models.example.com/v1".into();
        profile.deadline_preference = ProviderDeadlinePreference::Patient;
        assert_eq!(
            TurnDeadlinePlan::for_profile(&RouterBudget::default(), &profile).total_ms,
            300_000
        );

        profile.base_url = "https://models.example.corp/v1".into();
        profile.deadline_preference = ProviderDeadlinePreference::Standard;
        assert_eq!(
            TurnDeadlinePlan::for_profile(&RouterBudget::default(), &profile).total_ms,
            120_000
        );
    }

    #[test]
    fn explicit_deadline_precedes_provider_defaults_and_bounds_every_phase() {
        let budget = RouterBudget {
            deadline_ms: 42_000,
            deadline_is_explicit: true,
            ..RouterBudget::default()
        };
        let plan = TurnDeadlinePlan::for_profile(&budget, &ProviderProfile::ollama_local());
        assert_eq!(plan.total_ms, 42_000);
        assert!(plan.explicit);
        for phase in [
            AgentPhase::ChoosingEvidence,
            AgentPhase::RetrievingEvidence,
            AgentPhase::SynthesizingAnswer,
        ] {
            assert!((500..=42_000).contains(&plan.for_phase(phase)));
        }
    }

    #[test]
    fn serialized_legacy_budget_migrates_deadline_as_explicit() {
        let budget: RouterBudget = serde_json::from_value(serde_json::json!({
            "max_sources": 3,
            "max_tool_rounds": 12,
            "max_results_per_source": 8,
            "deadline_ms": 90_000,
            "order": ["memory", "files"]
        }))
        .expect("legacy budget");
        assert!(budget.deadline_is_explicit);
        assert_eq!(budget.deadline_ms, 90_000);
    }
}
