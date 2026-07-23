//! Salience + confidence scoring for capture proposals (MEMORY.md §9 Phase 2).
//!
//! Two separate 0..1 signals:
//! - **salience** — worth remembering (spam gate)
//! - **confidence** — captured correctly (structure/clarity)

use super::types::Kind;
use serde::{Deserialize, Serialize};

/// Pair of capture scores.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScorePair {
    /// Worth remembering (0..1).
    pub salience: f32,
    /// Captured correctly (0..1).
    pub confidence: f32,
}

/// Score a proposed candidate from kind, content, and cue label.
///
/// Deterministic and offline-testable.
pub fn score_candidate(kind: Kind, content: &str, cue: &str) -> ScorePair {
    let len = content.chars().count().max(1) as f32;
    let mut salience: f32 = 0.30;
    let mut confidence: f32 = 0.45;

    // Kind base
    match kind {
        Kind::Decision => {
            salience += 0.35;
            confidence += 0.15;
        }
        Kind::Preference => {
            salience += 0.28;
            confidence += 0.12;
        }
        Kind::Fact => {
            salience += 0.25;
            confidence += 0.10;
        }
        Kind::Task => {
            salience += 0.20;
            confidence += 0.08;
        }
        Kind::Bookmark => {
            salience += 0.22;
            confidence += 0.20;
        }
        Kind::Contact | Kind::Term | Kind::ProjectNote | Kind::Other(_) => {
            salience += 0.15;
            confidence += 0.05;
        }
    }

    // Explicit cues are higher confidence
    if cue.starts_with("explicit_") {
        salience += 0.15;
        confidence += 0.20;
    } else if cue.starts_with("decision_") {
        confidence += 0.10;
    }

    // Length sweet spot (too short = low conf; very long = slightly lower)
    if len < 12.0 {
        confidence -= 0.15;
        salience -= 0.10;
    } else if (20.0..200.0).contains(&len) {
        confidence += 0.10;
        salience += 0.05;
    } else if len > 400.0 {
        confidence -= 0.05;
    }

    // Concrete tokens boost confidence
    let lower = content.to_lowercase();
    let concrete = [
        "http://", "https://", "postgres", "sqlite", "port ", "v1", "api",
    ]
    .iter()
    .any(|t| lower.contains(t));
    if concrete {
        confidence += 0.08;
        salience += 0.05;
    }

    // Vague fillers lower confidence
    if lower.contains("something") || lower.contains("maybe") || lower.contains("i think") {
        confidence -= 0.12;
        salience -= 0.05;
    }

    ScorePair {
        salience: salience.clamp(0.0, 1.0),
        confidence: confidence.clamp(0.0, 1.0),
    }
}

/// Kind half-life in days for recency ranking (Phase 2).
///
/// Shorter half-life → ages faster in ranking.
pub fn kind_half_life_days(kind: &Kind) -> f32 {
    match kind {
        Kind::Task => 14.0,
        Kind::Preference => 180.0,
        Kind::Decision => 365.0,
        Kind::Fact | Kind::Term => 270.0,
        Kind::Bookmark => 120.0,
        Kind::Contact => 365.0,
        Kind::ProjectNote => 90.0,
        Kind::Other(_) => 90.0,
    }
}

/// Recency boost with per-kind half-life (replaces flat 90-day curve for ranking).
///
/// `1 / (1 + age_days / half_life)`.
pub fn recency_boost_kind(mtime_secs: i64, now_secs: i64, kind: &Kind) -> f32 {
    let age = (now_secs.saturating_sub(mtime_secs)).max(0) as f32;
    let age_days = age / 86_400.0;
    let hl = kind_half_life_days(kind).max(1.0);
    1.0 / (1.0 + age_days / hl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_fact_scores_above_floor() {
        let s = score_candidate(
            Kind::Fact,
            "staging DB is Postgres on port 5433",
            "explicit_remember_that",
        );
        assert!(s.salience >= 0.35, "{s:?}");
        assert!(s.confidence >= 0.40, "{s:?}");
    }

    #[test]
    fn vague_content_lower_confidence() {
        let strong = score_candidate(
            Kind::Fact,
            "API base is https://api.example.com/v1",
            "explicit_remember_that",
        );
        let weak = score_candidate(
            Kind::Fact,
            "maybe something about the api i think",
            "explicit_remember_that",
        );
        assert!(
            strong.confidence > weak.confidence,
            "strong={strong:?} weak={weak:?}"
        );
    }

    #[test]
    fn task_half_life_shorter_than_fact() {
        assert!(kind_half_life_days(&Kind::Task) < kind_half_life_days(&Kind::Fact));
        let now = 1_700_000_000i64;
        let age = now - 86_400 * 60; // 60 days old
        let task_r = recency_boost_kind(age, now, &Kind::Task);
        let fact_r = recency_boost_kind(age, now, &Kind::Fact);
        assert!(
            task_r < fact_r,
            "task should age faster: task={task_r} fact={fact_r}"
        );
    }

    #[test]
    fn decision_more_salient_than_project_note_base() {
        let d = score_candidate(
            Kind::Decision,
            "use SQLite for durable memory",
            "decision_we_decided",
        );
        let n = score_candidate(
            Kind::ProjectNote,
            "use SQLite for durable memory",
            "explicit_note_that",
        );
        assert!(d.salience >= n.salience, "d={d:?} n={n:?}");
    }
}
