//! Drain-style incremental templating (#356). LOG_ANALYSIS.md §3.
//!
//! High-cardinality hostiles are fail-closed (#824): total-template and
//! per-length-bucket caps reject new clusters rather than silently mis-merging
//! evidence or unbounded memory growth.
//!
//! Match path keeps **tokenized patterns** alongside each template so same-length
//! scans never re-tokenize every stored pattern for every event (#824). Candidate
//! selection stays the full same-length bucket (deterministic order); only the
//! per-candidate work is reduced.

use super::parse::level_severity;
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

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

/// Test/observability: number of candidate comparisons completed in the current
/// (or last) same-length scan. Used by active-scan cancel proofs (#824).
static SCAN_CANDIDATES_SEEN: AtomicUsize = AtomicUsize::new(0);

/// Reset and read helpers for cancel / profile tests.
pub fn reset_scan_candidates_seen() {
    SCAN_CANDIDATES_SEEN.store(0, Ordering::SeqCst);
}

/// Candidates compared so far in the active same-length scan (relaxed load).
pub fn scan_candidates_seen() -> usize {
    SCAN_CANDIDATES_SEEN.load(Ordering::Acquire)
}

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
    /// length → list of template ids (insertion order = deterministic scan order).
    by_len: HashMap<usize, Vec<u64>>,
    templates: HashMap<u64, TemplateInfo>,
    /// Cached tokenized patterns keyed by template id (#824).
    ///
    /// Identity of `TemplateInfo.pattern` is still `tokens.join(" ")`; matching
    /// never re-parses that string for each candidate on each event.
    pattern_tokens: HashMap<u64, Vec<String>>,
    /// Total-template hard cap.
    max_templates: usize,
    /// Per token-length bucket hard cap.
    max_per_bucket: usize,
    /// Optional per-candidate progress hook (`candidates_seen`). Production
    /// leaves this `None`. Active-scan cancel tests use it to synchronize so
    /// cancel is requested only after the expensive scan is confirmed active.
    scan_progress_hook: Option<std::sync::Arc<dyn Fn(usize) + Send + Sync>>,
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
            pattern_tokens: HashMap::new(),
            max_templates: max_templates.max(1),
            max_per_bucket: max_per_bucket.max(1),
            scan_progress_hook: None,
        }
    }

    /// Install a per-candidate scan progress hook (tests / diagnostics only).
    pub fn set_scan_progress_hook(
        &mut self,
        hook: Option<std::sync::Arc<dyn Fn(usize) + Send + Sync>>,
    ) {
        self.scan_progress_hook = hook;
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

    /// Tokenize a message into owned words (split on whitespace / punctuation).
    pub fn tokenize(msg: &str) -> Vec<String> {
        tokenize_borrowed(msg)
            .into_iter()
            .map(str::to_string)
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
        // Borrowed tokens avoid millions of per-event String allocations (#824).
        let tokens = tokenize_borrowed(message);
        let len = tokens.len();
        let sev = level_severity(level);

        // Reset per-call scan progress so active-scan cancel tests can wait
        // until this message's candidate loop is actually running.
        SCAN_CANDIDATES_SEEN.store(0, Ordering::Release);

        if let Some(ids) = self.by_len.get(&len) {
            // Copy ids only (cheap) so we can mutate templates after the scan.
            // Do **not** re-tokenize stored patterns — use pattern_tokens cache.
            let ids: Vec<u64> = ids.clone();
            // Score-only scan (no param Vec alloc per candidate); extract params
            // once for the winning template.
            let mut best: Option<(u64, f32)> = None;
            for (scan_i, id) in ids.into_iter().enumerate() {
                let seen = scan_i + 1;
                SCAN_CANDIDATES_SEEN.store(seen, Ordering::Release);
                if let Some(hook) = &self.scan_progress_hook {
                    hook(seen);
                }
                // Poll cancel inside the linear same-length scan (#824).
                // Check every 16 after the first so mid-scan cancel is observed
                // without waiting for a full 64-step quantum.
                if scan_i > 0
                    && scan_i.is_multiple_of(16)
                    && cancel.map(|c| c.is_cancelled()).unwrap_or(false)
                {
                    return Err(CoreError::Cancelled);
                }
                let Some(pat_toks) = self.pattern_tokens.get(&id) else {
                    continue;
                };
                if pat_toks.len() != len {
                    continue;
                }
                let sim = token_similarity_score(pat_toks, &tokens, self.sim_threshold);
                if sim >= self.sim_threshold && best.as_ref().map(|b| sim > b.1).unwrap_or(true) {
                    best = Some((id, sim));
                }
            }
            if let Some((id, _)) = best {
                let pat_toks = self
                    .pattern_tokens
                    .get(&id)
                    .cloned()
                    .expect("matched id always has pattern_tokens");
                let params = token_params(&pat_toks, &tokens);
                // Only rewrite pattern when a constant token must become <*>.
                let needs_merge = pat_toks
                    .iter()
                    .zip(tokens.iter())
                    .any(|(p, m)| p.as_str() != "<*>" && p.as_str() != *m);
                let merged = needs_merge.then(|| merge_pattern(&pat_toks, &tokens));
                if let Some(t) = self.templates.get_mut(&id) {
                    t.count += 1;
                    t.last_seen = ts;
                    t.severity = t.severity.max(sev);
                    if let Some(ref m) = merged {
                        t.pattern = m.join(" ");
                        t.token_count = m.len();
                    }
                }
                if let Some(m) = merged {
                    self.pattern_tokens.insert(id, m);
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
        let owned: Vec<String> = tokens.iter().map(|t| (*t).to_string()).collect();
        let pattern = owned.join(" ");
        let info = TemplateInfo {
            template_id: id,
            pattern: pattern.clone(),
            token_count: owned.len(),
            count: 1,
            first_seen: ts,
            last_seen: ts,
            severity: sev,
            example: message.chars().take(240).collect(),
        };
        self.templates.insert(id, info);
        self.pattern_tokens.insert(id, owned);
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

    /// Cached token count for a template (tests / diagnostics).
    pub fn cached_pattern_token_count(&self, template_id: u64) -> Option<usize> {
        self.pattern_tokens.get(&template_id).map(|t| t.len())
    }
}

/// Split on whitespace / `,` / `;` without allocating token strings.
fn tokenize_borrowed(msg: &str) -> Vec<&str> {
    msg.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .filter(|t| !t.is_empty())
        .collect()
}

/// Score-only similarity with early exit when the remaining positions cannot
/// meet `threshold`. Avoids allocating params for every candidate (#824).
fn token_similarity_score(pat: &[String], msg: &[&str], threshold: f32) -> f32 {
    if pat.len() != msg.len() || pat.is_empty() {
        return 0.0;
    }
    let n = pat.len();
    // Minimum same-count needed to meet threshold (ceil without float edge cases).
    let need = ((threshold * n as f32) - f32::EPSILON).ceil().max(0.0) as usize;
    let mut same = 0usize;
    for (i, (p, m)) in pat.iter().zip(msg.iter()).enumerate() {
        let remaining = n - i;
        if same + remaining < need {
            return same as f32 / n as f32;
        }
        if p.as_str() == "<*>" || p.as_str() == *m || (looks_variable(p) && looks_variable(m)) {
            same += 1;
        }
    }
    same as f32 / n as f32
}

/// Extract wildcard / variable params for a known matching pattern.
fn token_params(pat: &[String], msg: &[&str]) -> Vec<String> {
    let mut params = Vec::new();
    if pat.len() != msg.len() {
        return params;
    }
    for (p, m) in pat.iter().zip(msg.iter()) {
        if p.as_str() == "<*>"
            || (p.as_str() != *m && looks_variable(p) && looks_variable(m))
        {
            params.push((*m).to_string());
        }
    }
    params
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

fn merge_pattern(pat: &[String], msg: &[&str]) -> Vec<String> {
    pat.iter()
        .zip(msg.iter())
        .map(|(p, m)| {
            if p.as_str() == "<*>" || p.as_str() == *m {
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
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

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
        assert_eq!(
            d.cached_pattern_token_count(id1),
            Some(t.token_count),
            "cached tokens must track pattern token_count"
        );
    }

    /// Structural proof: match path uses `pattern_tokens`, not re-tokenizing
    /// `TemplateInfo.pattern` for every candidate (#824).
    #[test]
    fn match_path_uses_cached_tokens_not_pattern_string_reparse() {
        let mut d = DrainMiner::default();
        let (id, _) = d
            .match_or_create("alpha beta gamma delta", 1, "info")
            .unwrap();
        // Corrupt the display pattern so whitespace tokenization would diverge
        // from the cached four-token sequence. Matching must still hit cache.
        if let Some(t) = d.templates.get_mut(&id) {
            t.pattern = "alpha|beta|gamma|delta".into();
        }
        let (id2, _) = d
            .match_or_create("alpha beta gamma epsilon", 2, "info")
            .unwrap();
        assert_eq!(
            id, id2,
            "must match via cached tokens even when pattern string would re-tokenize differently"
        );
        assert_eq!(d.template_count(), 1);
        // Pattern string was rewritten from cached merge (space-joined).
        let t = &d.templates()[0];
        assert!(
            t.pattern.contains(' '),
            "merge rewrites pattern from tokens, got {:?}",
            t.pattern
        );
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
        let err = d
            .match_or_create_cancellable("zzzz0 zzzz1 zzzz2 zzzz3", 1, "info", Some(&flag))
            .unwrap_err();
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

    /// Hostile equal-token flood: cancel only **after** an expensive same-length
    /// scan is confirmed active; measure request→terminal latency; no new
    /// template published from the cancelled call (#824).
    #[test]
    fn adversarial_active_scan_cancel_to_terminal_is_bounded() {
        use std::sync::atomic::AtomicBool;
        use std::sync::mpsc;

        fn letter_code(i: usize) -> String {
            let mut n = i + 1;
            let mut out = String::new();
            while n > 0 {
                out.push((b'a' + ((n % 26) as u8)) as char);
                n /= 26;
            }
            while out.len() < 6 {
                out.push('z');
            }
            out
        }

        let mut d = DrainMiner::with_bounds(4, 80, 1.0, 50_000, 50_000);
        const N: usize = 3_200;
        for i in 0..N {
            let a = letter_code(i);
            let b = letter_code(i + 10_000);
            let c = letter_code(i + 20_000);
            let dtok = letter_code(i + 30_000);
            let msg = format!("{a} {b} {c} {dtok}");
            d.match_or_create(&msg, i as i64, "info").unwrap();
        }
        let templates_before = d.template_count();
        assert!(
            templates_before >= 3_000,
            "need a large same-length bucket, got {templates_before}"
        );

        // Synchronize: scan holds at candidate 128 until the test cancels, so
        // cancel is requested only after the expensive scan is confirmed active
        // (not pre-cancelled before the scan starts).
        let (active_tx, active_rx) = mpsc::sync_channel::<usize>(1);
        let release = Arc::new(AtomicBool::new(false));
        let release_hook = Arc::clone(&release);
        d.set_scan_progress_hook(Some(Arc::new(move |seen| {
            if seen == 128 {
                let _ = active_tx.send(seen);
                while !release_hook.load(Ordering::SeqCst) {
                    thread::yield_now();
                }
            }
        })));

        let d = Arc::new(Mutex::new(d));
        let flag = CancelFlag::new();
        let flag_scan = flag.clone();
        let d_scan = Arc::clone(&d);

        reset_scan_candidates_seen();
        let scan_thread = thread::spawn(move || {
            d_scan.lock().unwrap().match_or_create_cancellable(
                "qqqqqq wwwwww eeeeee rrrrrr",
                1,
                "info",
                Some(&flag_scan),
            )
        });

        let seen_before_cancel = active_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("scan must become active (reach candidate 128)");
        assert!(
            seen_before_cancel >= 128,
            "cancel must fire only after active scan, seen={seen_before_cancel}"
        );
        assert!(
            scan_candidates_seen() >= 128,
            "scan_candidates_seen must reflect active work"
        );

        let t0 = Instant::now();
        flag.cancel();
        release.store(true, Ordering::SeqCst);
        let result = scan_thread.join().expect("scan thread");
        let cancel_to_terminal_ms = t0.elapsed().as_millis() as u64;

        let err = result.expect_err("active-scan cancel must terminate with error");
        assert!(
            matches!(err, CoreError::Cancelled),
            "expected Cancelled terminal, got {err}"
        );
        assert!(
            cancel_to_terminal_ms < 2_000,
            "request→terminal {cancel_to_terminal_ms}ms exceeded 2s modest bound"
        );

        // No publication from the cancelled call — template count unchanged.
        let mut d = d.lock().unwrap();
        d.set_scan_progress_hook(None);
        assert_eq!(
            d.template_count(),
            templates_before,
            "cancel must not publish a new template"
        );

        // Retry after cancel succeeds (creates the previously cancelled template).
        let (id, _) = d
            .match_or_create("qqqqqq wwwwww eeeeee rrrrrr", 2, "info")
            .expect("retry after cancel must succeed");
        assert!(id >= 1);
        assert_eq!(d.template_count(), templates_before + 1);

        eprintln!(
            "PASS adversarial-active-scan-cancel templates_before={} candidates_before_cancel={} cancel_to_terminal_ms={} (one-machine observation)",
            templates_before, seen_before_cancel, cancel_to_terminal_ms
        );
    }
}
