//! Offline retrieval quality eval (keyword path only).
//!
//! Metric: hit@3 — fraction of queries whose expected file is among top-3.
//! Threshold: 1.0 on this labeled set (every query must hit). A scoring
//! regression that drops the expected doc out of top-3 fails CI.

use cd_core::index::KeywordIndex;
use cd_core::workspace::Workspace;
use std::path::{Path, PathBuf};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/kb")
        .canonicalize()
        .expect("fixtures/kb")
}

/// (query, expected path substring that must appear in top-K)
fn cases() -> Vec<(&'static str, &'static str)> {
    vec![
        ("billing payments service", "billing"),
        ("gateway middleware session tokens", "auth"),
        ("deploy runbook production rollout", "deploy"),
        ("session cookies httpOnly", "auth"),
    ]
}

#[test]
fn golden_retrieval_hit_at_3() {
    let root = fixture_root();
    assert!(root.is_dir(), "missing fixtures at {}", root.display());
    let ws = Workspace::new("golden-retrieval", vec![root.clone()]);
    let idx = KeywordIndex::build(&ws).expect("index");
    assert!(!idx.is_empty());

    let k = 3usize;
    let mut hits = 0usize;
    let mut mrr = 0.0f64;
    let cases = cases();
    for (query, expect_sub) in &cases {
        let ranked = idx.search(query, k);
        let paths: Vec<String> = ranked
            .iter()
            .map(|(_, c)| c.path.display().to_string())
            .collect();
        let pos = paths.iter().position(|p| {
            Path::new(p)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.to_lowercase().contains(expect_sub))
                .unwrap_or(false)
                || p.to_lowercase().contains(expect_sub)
        });
        if let Some(i) = pos {
            hits += 1;
            mrr += 1.0 / (i as f64 + 1.0);
        } else {
            eprintln!("MISS query={query:?} expect~{expect_sub} ranked={paths:?}");
        }
    }
    let n = cases.len() as f64;
    let hit_at_k = hits as f64 / n;
    let mrr = mrr / n;
    eprintln!(
        "golden_retrieval hit@{k}={hit_at_k:.2} mrr={mrr:.2} ({hits}/{})",
        cases.len()
    );
    // Threshold: every labeled case must hit top-3 (hit@3 == 1.0).
    assert!(
        (hit_at_k - 1.0).abs() < f64::EPSILON,
        "hit@3={hit_at_k} below 1.0 — retrieval quality regressed"
    );
}
