//! Host-authoritative exclusion lens for Explorer-shaped queries (#819).
//!
//! Agent tools already pin a trusted lens before querying
//! ([`crate::tool_host`]). The Explorer did not: the renderer derived
//! `EventQuery::excluded_template_ids` itself and the host forwarded them, so a
//! stale or compromised renderer could hide evidence the durable policy does
//! not authorize. `docs/THREAT_MODEL.md` puts the webview outside the trusted
//! computing base, so renderer exclusions must be treated as a *request*.
//!
//! This module resolves the trusted set once per corpus and reduces every
//! requested set to a subset of it. Reduction — rather than replacement —
//! is what preserves **Suspend all** and **temporary reveal**: both send fewer
//! ids (usually none), and an intersection can only ever hide less.
//!
//! Resolution is cached on the [`LogCorpus`] handle so paging, facets, counts,
//! and timeline requests do not re-read and re-resolve the sidecar. The cache
//! is per-corpus by construction (it lives on the handle), and the desktop host
//! bounds live handles, so it cannot grow without bound or serve one corpus's
//! policy to another.

use super::query::EventQuery;
use super::suppression::{load_suppression_document, SidecarIdentity};
use super::LogCorpus;
use std::sync::Arc;

/// Whether a trusted exclusion set could be established for this corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionLensState {
    /// The durable policy resolved against the corpus that is actually open.
    Resolved,
    /// Authority could not be established, so nothing may be excluded.
    ///
    /// Covers a malformed or truncated sidecar, a future schema version, a
    /// sidecar naming a different corpus, and an unresolved or concurrently
    /// superseded snapshot. Every one of them hides zero extra evidence.
    Unavailable,
}

/// The trusted exclusion set for one corpus at one moment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedSuppressionLens {
    /// Corpus this lens was resolved against. Never blank.
    pub corpus_id: String,
    /// Whether [`Self::template_ids`] is authoritative.
    pub state: SuppressionLensState,
    /// Payload-free explanation when `state` is `Unavailable`.
    ///
    /// Carries no rule text, event payload, or filesystem path — it is shown to
    /// a person and may be pasted into a support thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Sorted, deduplicated exact template ids the policy authorizes hiding.
    /// Always empty when `state` is `Unavailable`.
    pub template_ids: Vec<u64>,
    /// Durable sidecar mutation revision; absent when unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_revision: Option<u64>,
    /// Event revision observed when this lens was reported.
    pub event_revision: u64,
    /// Template-analysis revision the rules were resolved against.
    pub template_analysis_revision: u64,
}

impl TrustedSuppressionLens {
    /// Whether this template id may be hidden.
    pub fn authorizes(&self, template_id: u64) -> bool {
        self.template_ids.binary_search(&template_id).is_ok()
    }
}

/// What enforcement did to one requested exclusion set.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuppressionLensApplication {
    /// Distinct ids the caller asked to hide.
    pub requested: usize,
    /// Ids actually hidden after intersection with the trusted set.
    pub effective: usize,
    /// Requested ids the durable policy does not authorize hiding.
    ///
    /// Non-zero means the caller was stale or lying; the evidence was shown
    /// rather than hidden, and this is the truthful record of that.
    pub dropped: usize,
    /// Authority state used for this decision.
    pub state: SuppressionLensState,
}

/// Cached resolution plus what would make it stale.
#[derive(Debug, Clone)]
pub(crate) struct CachedSuppressionLens {
    /// Identity of the sidecar file the cached lens was resolved from.
    ///
    /// Suppression writes publish by atomic rename under a cross-process lock,
    /// so a mutation by *another* process changes this identity even though it
    /// cannot invalidate this process's cache directly.
    pub(crate) sidecar: SidecarIdentity,
    /// Template-analysis revision the cached rules were resolved against.
    pub(crate) template_analysis_revision: u64,
    /// The resolved lens, shared rather than recloned per query.
    pub(crate) lens: Arc<TrustedSuppressionLens>,
}

/// Resolve the trusted exclusion lens for one corpus, reusing a cached result.
///
/// A cache hit costs two atomic loads and one `stat`; it performs no sidecar
/// read, no JSON parse, and no rule resolution. That is what keeps repeated
/// rows/facets/counts/timeline requests off the policy path.
///
/// The event revision is re-stamped on every call, so a cache hit never reports
/// a stale one. It is deliberately **not** a cache key: the trusted set is a
/// function of the sidecar and template identity only, never of event data, so
/// keying on it would re-read the policy on every append during ingest and
/// regress time-to-first-use for no correctness gain.
pub fn trusted_suppression_lens(corpus: &LogCorpus) -> Arc<TrustedSuppressionLens> {
    let sidecar = SidecarIdentity::observe(corpus.root());
    let template_analysis_revision = corpus.template_analysis_revision();
    // A sidecar we could not measure is never cached and never served from
    // cache: without a usable identity there is nothing to prove the policy has
    // not changed, and continuing to hide events on that basis is exactly the
    // failure this module exists to prevent.
    let cacheable = sidecar != SidecarIdentity::Unmeasurable;

    if cacheable {
        if let Some(cached) = corpus.cached_suppression_lens() {
            if cached.sidecar == sidecar
                && cached.template_analysis_revision == template_analysis_revision
            {
                return restamp_event_revision(corpus, cached.lens);
            }
        }
    }

    let lens = Arc::new(resolve_lens(corpus, template_analysis_revision));
    // Only cache a resolution taken from the sidecar we just measured. If the
    // file moved underneath us, the next call re-resolves instead of pinning a
    // set that never matched any on-disk state.
    if cacheable
        && SidecarIdentity::observe(corpus.root()) == sidecar
        && corpus.template_analysis_revision() == template_analysis_revision
    {
        corpus.store_suppression_lens(CachedSuppressionLens {
            sidecar,
            template_analysis_revision,
            lens: Arc::clone(&lens),
        });
    }
    lens
}

fn restamp_event_revision(
    corpus: &LogCorpus,
    lens: Arc<TrustedSuppressionLens>,
) -> Arc<TrustedSuppressionLens> {
    let event_revision = corpus.event_revision();
    if lens.event_revision == event_revision {
        return lens;
    }
    let mut restamped = (*lens).clone();
    restamped.event_revision = event_revision;
    Arc::new(restamped)
}

fn resolve_lens(corpus: &LogCorpus, template_analysis_revision: u64) -> TrustedSuppressionLens {
    corpus.record_suppression_lens_load();
    let unavailable = |reason: String| TrustedSuppressionLens {
        corpus_id: corpus.id().to_string(),
        state: SuppressionLensState::Unavailable,
        reason: Some(reason),
        template_ids: Vec::new(),
        policy_revision: None,
        event_revision: corpus.event_revision(),
        template_analysis_revision,
    };

    let document = match load_suppression_document(corpus) {
        Ok(document) => document,
        Err(error) => return unavailable(error.to_string()),
    };
    // Belt and braces: `load_document_from_root` already refuses a sidecar
    // whose corpus id does not match, so reaching this arm would mean that
    // check regressed. Hiding nothing is the correct answer either way.
    if document.corpus_id != corpus.id() {
        return unavailable(
            "suppression sidecar belongs to a different corpus; no events were hidden".into(),
        );
    }
    let template_ids = match document.enabled_template_ids_for_corpus(corpus) {
        Ok(template_ids) => template_ids,
        Err(error) => return unavailable(error.to_string()),
    };

    TrustedSuppressionLens {
        corpus_id: corpus.id().to_string(),
        state: SuppressionLensState::Resolved,
        reason: None,
        template_ids,
        policy_revision: Some(document.revision),
        event_revision: corpus.event_revision(),
        template_analysis_revision,
    }
}

/// Reduce a requested exclusion set to what the durable policy authorizes.
///
/// This never fails and never widens. An unavailable authority empties the set
/// rather than erroring, because refusing the query would withhold *all*
/// evidence while the documented fail-closed direction for suppression is to
/// exclude nothing (`docs/design/LOG_EXPLORER.md` § Rule resolution).
pub fn apply_trusted_suppression_lens(
    corpus: &LogCorpus,
    query: &mut EventQuery,
) -> SuppressionLensApplication {
    let lens = trusted_suppression_lens(corpus);
    apply_lens_to_query(&lens, query)
}

/// Reduce a requested set against an already-resolved lens.
///
/// Split out so one resolution can enforce across the several sub-queries of a
/// single request without re-entering the cache per lane.
pub fn apply_lens_to_query(
    lens: &TrustedSuppressionLens,
    query: &mut EventQuery,
) -> SuppressionLensApplication {
    let mut requested = std::mem::take(&mut query.excluded_template_ids);
    requested.sort_unstable();
    requested.dedup();
    let requested_count = requested.len();

    requested.retain(|template_id| lens.authorizes(*template_id));
    let effective = requested.len();
    query.excluded_template_ids = requested;

    SuppressionLensApplication {
        requested: requested_count,
        effective,
        dropped: requested_count - effective,
        state: lens.state,
    }
}

/// Drop any cached lens for this corpus.
///
/// Called by the host after a policy mutation or package import so the next
/// query re-resolves immediately rather than waiting for the sidecar identity
/// to be observed as changed.
pub fn invalidate_trusted_suppression_lens(corpus: &LogCorpus) {
    corpus.invalidate_suppression_lens();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::drain::TemplateInfo;
    use crate::log_analysis::suppression::{
        activate_template_suppression, mutate_template_suppression_rule,
        preview_template_suppression, ActivateSuppressionPreview, NewSuppressionPreview,
        SuppressionRuleMutation, SuppressionRuleOrigin,
    };
    use crate::log_analysis::{
        ActiveTimestampBasis, LogCorpus, LogEvent, TemplateRow, TimestampProvenance,
    };

    /// Template 7 is repeated background noise; template 9 is the evidence a
    /// stale or hostile renderer must never be able to hide.
    const NOISE_TEMPLATE: u64 = 7;
    const SIGNAL_TEMPLATE: u64 = 9;

    fn corpus_with_noise(root: &std::path::Path) -> LogCorpus {
        let corpus = LogCorpus::create(root, "suppression lens tests").expect("create");
        let mut events = Vec::new();
        for seq in 1..=40u64 {
            events.push(event(seq, NOISE_TEMPLATE, "info", "routine health check"));
        }
        events.push(event(
            41,
            SIGNAL_TEMPLATE,
            "error",
            "payment gateway refused",
        ));
        corpus.push_events(&events).expect("push events");
        corpus
            .upsert_templates([
                template(NOISE_TEMPLATE, "routine health <*>", 40),
                template(SIGNAL_TEMPLATE, "payment gateway <*>", 1),
            ])
            .expect("templates");
        corpus
    }

    fn event(seq: u64, template_id: u64, level: &str, message: &str) -> LogEvent {
        LogEvent {
            seq,
            ts: 1_700_000_000 + seq as i64,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: level.into(),
            service: Some("worker".into()),
            host: Some("host-1".into()),
            template_id,
            params: vec![],
            trace_id: None,
            message: message.into(),
            source: "worker/app.log".into(),
        }
    }

    fn template(template_id: u64, pattern: &str, count: u64) -> TemplateRow {
        TemplateRow {
            info: TemplateInfo {
                template_id,
                pattern: pattern.into(),
                token_count: 3,
                count,
                first_seen: 1_700_000_000,
                last_seen: 1_700_000_100,
                severity: 1,
                example: pattern.into(),
            },
            content_hash: format!("sha256:template-{template_id}"),
            vector: None,
        }
    }

    /// Enable one rule over [`NOISE_TEMPLATE`] and return its durable id.
    fn enable_noise_rule(corpus: &LogCorpus) -> String {
        let preview = preview_template_suppression(
            corpus,
            0,
            NewSuppressionPreview {
                name: "Heartbeat".into(),
                rationale: "Repeated readiness line".into(),
                template_id: NOISE_TEMPLATE,
                origin: SuppressionRuleOrigin::Human,
            },
        )
        .expect("preview");
        activate_template_suppression(
            corpus,
            preview.rule_revision,
            ActivateSuppressionPreview {
                preview_token: preview.token.clone(),
            },
        )
        .expect("activate")
        .rule
        .id
    }

    fn disable_rule(corpus: &LogCorpus, rule_id: &str) {
        let revision = load_suppression_document(corpus)
            .expect("document")
            .revision;
        mutate_template_suppression_rule(
            corpus,
            revision,
            rule_id,
            SuppressionRuleMutation::Disable,
        )
        .expect("disable");
    }

    #[test]
    fn renderer_cannot_hide_a_template_the_policy_never_authorized() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        enable_noise_rule(&corpus);

        // A compromised renderer asks to hide the ERROR evidence too.
        let mut query = EventQuery {
            excluded_template_ids: vec![NOISE_TEMPLATE, SIGNAL_TEMPLATE],
            limit: 50,
            ..Default::default()
        };
        let applied = apply_trusted_suppression_lens(&corpus, &mut query);

        assert_eq!(query.excluded_template_ids, vec![NOISE_TEMPLATE]);
        assert_eq!(applied.requested, 2);
        assert_eq!(applied.effective, 1);
        assert_eq!(applied.dropped, 1);
        assert_eq!(applied.state, SuppressionLensState::Resolved);
    }

    #[test]
    fn stale_renderer_cannot_keep_hiding_a_disabled_rule() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        let rule_id = enable_noise_rule(&corpus);

        // The renderer captured this set before the rule was disabled.
        let stale_request = vec![NOISE_TEMPLATE];
        disable_rule(&corpus, &rule_id);

        let mut query = EventQuery {
            excluded_template_ids: stale_request,
            limit: 50,
            ..Default::default()
        };
        let applied = apply_trusted_suppression_lens(&corpus, &mut query);

        assert!(
            query.excluded_template_ids.is_empty(),
            "a disabled rule must hide nothing"
        );
        assert_eq!(applied.dropped, 1);
    }

    #[test]
    fn suspend_and_reveal_only_ever_reduce_exclusions() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        enable_noise_rule(&corpus);

        // Suspend / temporary reveal both send an empty set.
        let mut query = EventQuery {
            excluded_template_ids: vec![],
            limit: 50,
            ..Default::default()
        };
        let applied = apply_trusted_suppression_lens(&corpus, &mut query);
        assert!(query.excluded_template_ids.is_empty());
        assert_eq!(applied.effective, 0);
        assert_eq!(applied.dropped, 0);
        assert_eq!(applied.state, SuppressionLensState::Resolved);

        // Enforcement is not a floor: it never re-adds the suspended id.
        assert!(!query.excluded_template_ids.contains(&NOISE_TEMPLATE));
    }

    #[test]
    fn unreadable_sidecar_hides_nothing_and_says_so() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        enable_noise_rule(&corpus);
        assert_eq!(
            trusted_suppression_lens(&corpus).template_ids,
            vec![NOISE_TEMPLATE]
        );

        std::fs::write(corpus.root().join("suppression.json"), b"{ not json")
            .expect("corrupt sidecar");

        let mut query = EventQuery {
            excluded_template_ids: vec![NOISE_TEMPLATE],
            limit: 50,
            ..Default::default()
        };
        let applied = apply_trusted_suppression_lens(&corpus, &mut query);

        assert!(query.excluded_template_ids.is_empty());
        assert_eq!(applied.state, SuppressionLensState::Unavailable);
        assert_eq!(applied.dropped, 1);
        let lens = trusted_suppression_lens(&corpus);
        assert!(lens.reason.is_some(), "unavailable state must explain why");
        assert!(lens.template_ids.is_empty());
    }

    #[test]
    fn repeated_queries_resolve_the_policy_once() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        enable_noise_rule(&corpus);

        let baseline = corpus.suppression_lens_load_count();
        for _ in 0..64 {
            let mut query = EventQuery {
                excluded_template_ids: vec![],
                limit: 50,
                ..Default::default()
            };
            apply_trusted_suppression_lens(&corpus, &mut query);
        }
        assert_eq!(
            corpus.suppression_lens_load_count() - baseline,
            1,
            "64 Explorer-shaped queries must read and resolve the sidecar once"
        );
    }

    #[test]
    fn a_policy_mutation_is_observed_without_explicit_invalidation() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        let rule_id = enable_noise_rule(&corpus);
        assert_eq!(
            trusted_suppression_lens(&corpus).template_ids,
            vec![NOISE_TEMPLATE]
        );

        // Simulates another process publishing a new sidecar: the cache is not
        // told, so only the observed file identity can catch it.
        disable_rule(&corpus, &rule_id);

        assert!(
            trusted_suppression_lens(&corpus).template_ids.is_empty(),
            "a sidecar rewritten out of band must not keep hiding events"
        );
    }

    #[test]
    fn explicit_invalidation_forces_one_reresolution() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = corpus_with_noise(temp.path());
        enable_noise_rule(&corpus);
        let _ = trusted_suppression_lens(&corpus);

        let before = corpus.suppression_lens_load_count();
        invalidate_trusted_suppression_lens(&corpus);
        let _ = trusted_suppression_lens(&corpus);
        assert_eq!(corpus.suppression_lens_load_count() - before, 1);

        let after = corpus.suppression_lens_load_count();
        let _ = trusted_suppression_lens(&corpus);
        assert_eq!(
            corpus.suppression_lens_load_count(),
            after,
            "the re-resolved lens must be cached again"
        );
    }

    #[test]
    fn reopening_a_corpus_resolves_from_disk_rather_than_a_stale_handle() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus_id = {
            let corpus = corpus_with_noise(temp.path());
            enable_noise_rule(&corpus);
            // Templates live in memory until an explicit flush, exactly as
            // ingest publishes them. Without this the reopen would model a
            // corpus that never finished writing rather than a restart.
            corpus.flush().expect("flush");
            corpus.id().to_string()
        };

        let reopened = LogCorpus::open(temp.path(), &corpus_id).expect("reopen");
        let lens = trusted_suppression_lens(&reopened);
        assert_eq!(lens.state, SuppressionLensState::Resolved);
        assert_eq!(lens.template_ids, vec![NOISE_TEMPLATE]);
        assert_eq!(lens.corpus_id, corpus_id);
    }

    #[test]
    fn concurrent_queries_agree_on_one_trusted_set() {
        let temp = tempfile::tempdir().expect("temp");
        let corpus = Arc::new(corpus_with_noise(temp.path()));
        enable_noise_rule(&corpus);

        let mut handles = Vec::new();
        for _ in 0..8 {
            let corpus = Arc::clone(&corpus);
            handles.push(std::thread::spawn(move || {
                let mut seen = Vec::new();
                for _ in 0..32 {
                    let mut query = EventQuery {
                        excluded_template_ids: vec![NOISE_TEMPLATE, SIGNAL_TEMPLATE],
                        limit: 10,
                        ..Default::default()
                    };
                    apply_trusted_suppression_lens(&corpus, &mut query);
                    seen.push(query.excluded_template_ids.clone());
                }
                seen
            }));
        }
        for handle in handles {
            for observed in handle.join().expect("thread") {
                assert_eq!(observed, vec![NOISE_TEMPLATE]);
            }
        }
    }
}
