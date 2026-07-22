//! Drain-style incremental templating (#356). LOG_ANALYSIS.md §3.

use super::parse::level_severity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
}

impl Default for DrainMiner {
    fn default() -> Self {
        Self::new(4, 80, 0.5)
    }
}

impl DrainMiner {
    /// Create with Drain hyperparameters.
    pub fn new(depth: usize, max_children: usize, sim_threshold: f32) -> Self {
        Self {
            depth: depth.max(1),
            max_children: max_children.max(2),
            sim_threshold: sim_threshold.clamp(0.1, 1.0),
            next_id: 1,
            by_len: HashMap::new(),
            templates: HashMap::new(),
        }
    }

    /// All templates sorted by id.
    pub fn templates(&self) -> Vec<TemplateInfo> {
        let mut v: Vec<_> = self.templates.values().cloned().collect();
        v.sort_by_key(|t| t.template_id);
        v
    }

    /// Tokenize a message into words (split on whitespace / punctuation).
    pub fn tokenize(msg: &str) -> Vec<String> {
        msg.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect()
    }

    /// Ingest one message; returns `(template_id, params)`.
    pub fn match_or_create(&mut self, message: &str, ts: i64, level: &str) -> (u64, Vec<String>) {
        let tokens = Self::tokenize(message);
        let len = tokens.len();
        let sev = level_severity(level);

        if let Some(ids) = self.by_len.get(&len).cloned() {
            let mut best: Option<(u64, f32, Vec<String>)> = None;
            for id in ids {
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
                return (id, params);
            }
        }

        // New template
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
        (id, Vec::new())
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
        let (id1, _) = d.match_or_create(a, 1, "info");
        let (id2, params) = d.match_or_create(b, 2, "info");
        assert_eq!(id1, id2, "near-duplicate HTTP lines share a template");
        assert!(d.templates().len() == 1);
        let t = &d.templates()[0];
        assert!(t.count >= 2);
        assert!(t.pattern.contains("GET") || t.pattern.contains("<*>"));
        let _ = params;
    }

    #[test]
    fn distinct_messages_separate() {
        let mut d = DrainMiner::default();
        let (a, _) = d.match_or_create("database connection refused to primary", 1, "error");
        let (b, _) = d.match_or_create("user login succeeded for alice", 2, "info");
        assert_ne!(a, b);
        assert_eq!(d.templates().len(), 2);
    }

    #[test]
    fn deterministic_for_fixed_input() {
        let lines = [
            "error code 1 on shard 7",
            "error code 2 on shard 9",
            "error code 3 on shard 11",
        ];
        let mut d1 = DrainMiner::default();
        let mut d2 = DrainMiner::default();
        for (i, l) in lines.iter().enumerate() {
            d1.match_or_create(l, i as i64, "error");
            d2.match_or_create(l, i as i64, "error");
        }
        let p1: Vec<_> = d1.templates().into_iter().map(|t| t.pattern).collect();
        let p2: Vec<_> = d2.templates().into_iter().map(|t| t.pattern).collect();
        assert_eq!(p1, p2);
    }
}
