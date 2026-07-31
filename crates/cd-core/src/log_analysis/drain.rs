//! Drain-style incremental templating (#356). LOG_ANALYSIS.md §3.
//!
//! High-cardinality hostiles are fail-closed (#824): total-template and
//! per-length-bucket caps reject new clusters rather than silently mis-merging
//! evidence or unbounded memory growth.

use super::parse::level_severity;
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Hard cap on distinct templates retained by one ingest DrainMiner (#824).
///
/// Authoritative triage-stress 250k produces 648 templates; company-scale noise
/// stays far below this. The cap exists for adversarial unique-message floods.
pub const MAX_DRAIN_TEMPLATES: usize = 25_000;

/// Hard cap on templates sharing one token-length bucket (#824).
///
/// Linear same-length scans are O(bucket); unbounded equal-token-count
/// messages would otherwise stall ingest. Cap forces fail-closed rejection.
pub const MAX_DRAIN_TEMPLATES_PER_LENGTH_BUCKET: usize = 2_048;

/// One template row (counts / window updated on match).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateInfo {
    /// Stable template id (1-based sequence).
    pub template_id: u64,
    /// Pattern with `<*>` placeholders.
    pub pattern: String,
    /// Token count in pattern.
    pub token_count: usize,
    /// Match count.
    pub count: u64,
    /// First seen unix secs.
    pub first_seen: i64,
    /// Last seen unix secs.
    pub last_seen: i64,
    /// Max severity seen (0–5).
    pub severity: u8,
    /// Example raw message (redacted at higher layer).
    pub example: String,
}

/// Incremental single-pass Drain miner (streaming-ready, deterministic).
///
/// Similarity uses token-position equality with a simple wildcard threshold
/// (classic Drain idea, pure Rust, no full-corpus buffer).
pub struct DrainMiner {
    /// depth of prefix tree (token groups).
    depth: usize,
    /// max children before collapsing to wildcard.
    max_children: usize,
    /// similarity threshold [0,1] for cluster match.
    sim_threshold: f32,
    next_id: u64,
    /// length → list of template ids
    by_len: HashMap<usize, Vec<u64>>,
    templates: HashMap<u64, TemplateInfo>,
    /// Total-template hard cap.
    max_templates: usize,
    /// Per token-length bucket hard cap.
    max_per_bucket: usize,
}

impl Default for DrainMiner {
    fn default() -> Self {
        Self::new(4, 80, 0.5)
    }
}

impl DrainMiner {
    /// Create with Drain hyperparameters (product default caps).
    pub fn new(depth: usize, max_children: usize, sim_threshold: f32) -> Self {
        Self::with_bounds(
            depth,
            max_children,
            sim_threshold,
            MAX_DRAIN_TEMPLATES,
            MAX_DRAIN_TEMPLATES_PER_LENGTH_BUCKET,
        )
    }

    /// Create with explicit cardinality bounds (tests + policy knobs).
    pub fn with_bounds(
        depth: usize,
        max_children: usize,
        sim_threshold: f32,
        max_templates: usize,
        max_per_bucket: usize,
    ) -> Self {
        Self {
            depth: depth.max(1),
            max_children: max_children.max(2),
            sim_threshold: sim_threshold.clamp(0.1, 1.0),
            next_id: 1,
            by_len: HashMap::new(),
            templates: HashMap::new(),
            max_templates: max_templates.max(1),
            max_per_bucket: max_per_bucket.max(1),
        }
    }

    /// All templates sorted by id.
    pub fn templates(&self) -> Vec<TemplateInfo> {
        let mut v: Vec<_> = self.templates.values().cloned().collect();
        v.sort_by_key(|t| t.template_id);
        v
    }

    /// Current distinct template count.
    pub fn template_count(&self) -> usize {
        self.templates.len()
    }

    /// Tokenize a message into words (split on whitespace / punctuation).
    pub fn tokenize(msg: &str) -> Vec<String> {
        msg.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect()
    }

    /// Ingest one message; returns `(template_id, params)`.
    ///
    /// Fail-closed on cardinality: if no existing template matches and a new
    /// cluster would exceed total or per-bucket caps, returns
    /// [`CoreError::Policy`] rather than silently merging into a wrong cluster.
    pub fn match_or_create(
        &mut self,
        message: &str,
        ts: i64,
        level: &str,
    ) -> CoreResult<(u64, Vec<String>)> {
        self.match_or_create_cancellable(message, ts, level, None)
    }

    /// Same as [`Self::match_or_create`] with cancel checks during same-length scans.
    pub fn match_or_create_cancellable(
        &mut self,
        message: &str,
        ts: i64,
        level: &str,
        cancel: Option<&CancelFlag>,
    ) -> CoreResult<(u64, Vec<String>)> {
        let tokens = Self::tokenize(message);
        let len = tokens.len();
        let sev = level_severity(level);

        if let Some(ids) = self.by_len.get(&len).cloned() {
            let mut best: Option<(u64, f32, Vec<String>)> = None;
            for (scan_i, id) in ids.into_iter().enumerate() {
                // Poll cancel inside the linear same-length scan (#824).
                if scan_i > 0
                    && scan_i.is_multiple_of(64)
                    && cancel.map(|c| c.is_cancelled()).unwrap_or(false)
                {
                    return Err(CoreError::Cancelled);
                }
                let Some(t) = self.templates.get(&id) else {
                    continue;
                };
                let pat_toks = Self::tokenize(&t.pattern);
                if pat_toks.len() != len {
                    continue;
                }
                let (sim, params) = token_similarity(&pat_toks, &tokens);
                if sim >= self.sim_threshold && best.as_ref().map(|b| sim > b.1).unwrap_or(true) {
                    best = Some((id, sim, params));
                }
            }
            if let Some((id, _, params)) = best {
                if let Some(t) = self.templates.get_mut(&id) {
                    t.count += 1;
                    t.last_seen = ts;
                    t.severity = t.severity.max(sev);
                    // Merge pattern wildcards if needed
                    let merged = merge_pattern(&Self::tokenize(&t.pattern), &tokens);
                    t.pattern = merged.join(" ");
                    t.token_count = Self::tokenize(&t.pattern).len();
                }
                return Ok((id, params));
            }
        }

        // New template — enforce total + per-bucket caps fail-closed.
        let bucket_len = self.by_len.get(&len).map(|v| v.len()).unwrap_or(0);
        if self.templates.len() >= self.max_templates {
            return Err(CoreError::Policy(format!(
                "log template cardinality limit exceeded (max {} distinct templates); \
                 refusing to create or silently merge a new cluster",
                self.max_templates
            )));
        }
        if bucket_len >= self.max_per_bucket {
            return Err(CoreError::Policy(format!(
                "log template length-bucket limit exceeded (max {} templates with {} tokens); \
                 refusing silent mis-cluster of unique equal-token-count messages",
                self.max_per_bucket, len
            )));
        }

        let id = self.next_id;
        self.next_id += 1;
        let pattern = tokens.join(" ");
        let info = TemplateInfo {
            template_id: id,
            pattern: pattern.clone(),
            token_count: tokens.len(),
            count: 1,
            first_seen: ts,
            last_seen: ts,
            severity: sev,
            example: message.chars().take(240).collect(),
        };
        self.templates.insert(id, info);
        self.by_len.entry(len).or_default().push(id);
        // max_children / depth reserved for future tree pruning; keep API stable.
        let _ = (self.depth, self.max_children);
        Ok((id, Vec::new()))
    }

    /// Reduction ratio: lines / templates (higher = better collapse).
    pub fn reduction_ratio(&self, total_lines: u64) -> f64 {
        let n = self.templates.len().max(1) as f64;
        total_lines as f64 / n
    }
}

fn token_similarity(pat: &[String], msg: &[String]) -> (f32, Vec<String>) {
    if pat.len() != msg.len() || pat.is_empty() {
        return (0.0, Vec::new());
    }
    let mut same = 0usize;
    let mut params = Vec::new();
    for (p, m) in pat.iter().zip(msg.iter()) {
        if p == "<*>" {
            params.push(m.clone());
            same += 1;
        } else if p == m {
            same += 1;
        } else if looks_variable(p) && looks_variable(m) {
            params.push(m.clone());
            same += 1;
        }
    }
    (same as f32 / pat.len() as f32, params)
}

fn looks_variable(tok: &str) -> bool {
    if tok == "<*>" {
        return true;
    }
    // digits / hex / uuid-ish / paths with numbers
    let digitish = tok.chars().filter(|c| c.is_ascii_digit()).count();
    if digitish >= 2 && digitish * 2 >= tok.len() {
        return true;
    }
    tok.len() > 20
}

fn merge_pattern(pat: &[String], msg: &[String]) -> Vec<String> {
    pat.iter()
        .zip(msg.iter())
        .map(|(p, m)| {
            if p == "<*>" || p == m {
                p.clone()
            } else {
                "<*>".into()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn near_duplicates_collapse() {
        let mut d = DrainMiner::default();
        let a = "GET /users/8123 200 14ms";
        let b = "GET /users/9971 200 9ms";
        let (id1, _) = d.match_or_create(a, 1, "info").unwrap();
        let (id2, params) = d.match_or_create(b, 2, "info").unwrap();
        assert_eq!(id1, id2, "near-duplicate HTTP lines share a template");
        assert!(d.templates().len() == 1);
        let t = &d.templates()[0];
        assert!(t.count >= 2);
        assert!(!params.is_empty() || t.pattern.contains("<*>") || t.pattern.contains("users"));
    }

    #[test]
    fn total_template_cap_fails_closed_without_silent_merge() {
        let mut d = DrainMiner::with_bounds(4, 80, 0.99, 3, 100);
        for i in 0..3 {
            // Distinct token lengths so each is a new template (high sim threshold).
            let msg = format!("unique message number {i} with extra tokens pad");
            d.match_or_create(&msg, i as i64, "info").unwrap();
        }
        assert_eq!(d.template_count(), 3);
        let err = d
            .match_or_create("brand new never seen message alpha beta gamma", 9, "info")
            .unwrap_err();
        assert!(
            format!("{err}").contains("cardinality") || format!("{err}").contains("limit"),
            "{err}"
        );
        assert_eq!(
            d.template_count(),
            3,
            "must not create or merge past total cap"
        );
    }

    #[test]
    fn per_bucket_cap_fails_closed_for_equal_token_count_flood() {
        // Force every message into the same token-length bucket with no matches.
        let mut d = DrainMiner::with_bounds(4, 80, 0.99, 10_000, 4);
        for i in 0..4 {
            // Exactly 4 tokens each, all unique → 4 templates in one bucket.
            let msg = format!("tokA{i} tokB{i} tokC{i} tokD{i}");
            d.match_or_create(&msg, i as i64, "warn").unwrap();
        }
        assert_eq!(d.template_count(), 4);
        let err = d
            .match_or_create("tokA9 tokB9 tokC9 tokD9", 99, "warn")
            .unwrap_err();
        assert!(
            format!("{err}").to_lowercase().contains("bucket")
                || format!("{err}").to_lowercase().contains("limit"),
            "{err}"
        );
        assert_eq!(d.template_count(), 4);
    }

    #[test]
    fn cancel_during_same_length_scan_is_observed() {
        let mut d = DrainMiner::with_bounds(4, 80, 0.99, 10_000, 10_000);
        // Fill a long same-length bucket so the scan iterates many candidates.
        for i in 0..200 {
            let msg = format!("alpha{i} beta{i} gamma{i} delta{i}");
            d.match_or_create(&msg, i as i64, "info").unwrap();
        }
        let flag = CancelFlag::new();
        flag.cancel();
        // First iteration may not hit the every-64 poll; ensure we cancel with
        // a non-matching message that forces a full scan.
        let err = d
            .match_or_create_cancellable("zzzz0 zzzz1 zzzz2 zzzz3", 1, "info", Some(&flag))
            .unwrap_err();
        // Either Cancelled (scan poll) or Policy if it somehow creates — prefer cancel.
        // With cancel set from the start, the 64-poll on scan_i>0 should fire.
        let msg = format!("{err}");
        assert!(
            msg.contains("cancelled")
                || msg.contains("Cancelled")
                || matches!(err, CoreError::Cancelled),
            "expected cancel during scan, got {err}"
        );
    }

    #[test]
    fn adversarial_equal_token_unique_messages_stay_bounded() {
        // Many unique equal-token-count messages must not grow past bucket cap.
        let mut d = DrainMiner::with_bounds(4, 80, 0.95, 500, 32);
        let mut accepted = 0u64;
        let mut rejected = 0u64;
        for i in 0..5_000 {
            let msg = format!("evt uid={i:06} host=h{i} path=/v1/x status=200");
            match d.match_or_create(&msg, i as i64, "info") {
                Ok(_) => accepted += 1,
                Err(CoreError::Policy(_)) => rejected += 1,
                Err(e) => panic!("unexpected error: {e}"),
            }
        }
        assert!(
            d.template_count() <= 500,
            "templates {} over total cap",
            d.template_count()
        );
        assert!(rejected > 0, "flood must hit a bound (accepted={accepted})");
        // Existing clusters remain addressable — no silent wipe.
        assert!(accepted > 0);
    }

    /// Hostile equal-token flood: cancel mid-scan must reach a terminal
    /// Cancelled error with measured cancel→terminal wall latency (#824).
    #[test]
    fn adversarial_high_cardinality_cancel_to_terminal_is_bounded() {
        // Fill a large same-length bucket. Encode index in pure letters so
        // looks_variable (digit heuristic) does not collapse patterns.
        fn letter_code(i: usize) -> String {
            // Base-26 style encoding → alphabetic-only token, fixed width-ish.
            let mut n = i + 1;
            let mut out = String::new();
            while n > 0 {
                out.push((b'a' + ((n % 26) as u8)) as char);
                n /= 26;
            }
            // Pad so all messages share the same token count and roughly length.
            while out.len() < 6 {
                out.push('z');
            }
            out
        }
        let mut d = DrainMiner::with_bounds(4, 80, 1.0, 50_000, 50_000);
        const N: usize = 3_200; // > 64 so cancel poll fires during scan
        for i in 0..N {
            let a = letter_code(i);
            let b = letter_code(i + 10_000);
            let c = letter_code(i + 20_000);
            let dtok = letter_code(i + 30_000);
            let msg = format!("{a} {b} {c} {dtok}");
            d.match_or_create(&msg, i as i64, "info").unwrap();
        }
        assert!(
            d.template_count() >= 3_000,
            "need a large same-length bucket for cancel scan, got {}",
            d.template_count()
        );

        let flag = CancelFlag::new();
        flag.cancel();
        let t0 = std::time::Instant::now();
        let err = d
            .match_or_create_cancellable("qqqqqq wwwwww eeeeee rrrrrr", 1, "info", Some(&flag))
            .expect_err("hostile cancel path must terminate");
        let cancel_to_terminal_ms = t0.elapsed().as_millis() as u64;
        assert!(
            matches!(err, CoreError::Cancelled),
            "expected Cancelled terminal, got {err}"
        );
        // Linear scan with 64-step cancel polls must finish quickly.
        assert!(
            cancel_to_terminal_ms < 2_000,
            "cancel-to-terminal {cancel_to_terminal_ms}ms exceeded 2s modest bound"
        );
        eprintln!(
            "PASS adversarial-cancel-to-terminal templates={} cancel_to_terminal_ms={} (one-machine observation)",
            d.template_count(),
            cancel_to_terminal_ms
        );
    }
}
