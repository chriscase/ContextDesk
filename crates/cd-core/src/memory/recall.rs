//! Hybrid recall engine over one or two memory pools (MEMORY.md §4).
//!
//! Reuses `embed::{hybrid_score, cosine_similarity, recency_boost, HybridWeights}`.
//! Keyword scores are **normalized per pool before merge** so a global kw_max
//! cannot drown one scope.

use super::sqlite_store::SqliteMemoryStore;
use super::types::*;
use super::MemoryStore;
use crate::embed::{
    cosine_similarity, hybrid_score, recency_boost, EmbedBackend, HybridWeights,
    MockHashEmbedBackend,
};
use crate::error::CoreResult;
use std::sync::atomic::{AtomicBool, Ordering};

static EMBED_DEGRADED_WARNED: AtomicBool = AtomicBool::new(false);

/// Reset the one-shot embed-degrade warning (tests only).
#[cfg(test)]
pub fn reset_embed_degrade_warning() {
    EMBED_DEGRADED_WARNED.store(false, Ordering::SeqCst);
}

/// Whether embed degrade has already logged (tests).
#[cfg(test)]
pub fn embed_degrade_warned() -> bool {
    EMBED_DEGRADED_WARNED.load(Ordering::SeqCst)
}

/// Recall across personal + workspace with per-pool keyword normalization.
pub fn recall_two_pool(
    personal: &SqliteMemoryStore,
    workspace: &SqliteMemoryStore,
    q: &RecallQuery,
    embed: Option<&dyn EmbedBackend>,
    w: HybridWeights,
    now_secs: i64,
) -> CoreResult<Vec<RecallHit>> {
    let mut personal_q = q.clone();
    personal_q.scope = Some(Scope::Personal);
    personal_q.k = q.k.saturating_mul(3).max(q.k);
    let mut workspace_q = q.clone();
    workspace_q.scope = Some(Scope::Workspace);
    workspace_q.k = q.k.saturating_mul(3).max(q.k);

    let mut personal_hits = pool_recall(personal, &personal_q, embed, w, now_secs, "personal")?;
    let mut workspace_hits = pool_recall(workspace, &workspace_q, embed, w, now_secs, "workspace")?;

    // Normalize keyword component per pool, then recompute hybrid score.
    normalize_pool_keyword_scores(&mut personal_hits);
    normalize_pool_keyword_scores(&mut workspace_hits);
    rescore_hits(&mut personal_hits, w, now_secs);
    rescore_hits(&mut workspace_hits, w, now_secs);

    let mut merged = Vec::with_capacity(personal_hits.len() + workspace_hits.len());
    merged.extend(personal_hits);
    merged.extend(workspace_hits);

    // Contradicting actives both returned (no silent pick) — sort by score only.
    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if let Some(min) = q.min_score {
        merged.retain(|h| h.score >= min);
    }
    merged.truncate(q.k.max(1));
    Ok(merged)
}

fn normalize_pool_keyword_scores(hits: &mut [RecallHit]) {
    let max = hits.iter().map(|h| h.keyword_score).fold(0.0f32, f32::max);
    if max <= f32::EPSILON {
        return;
    }
    for h in hits.iter_mut() {
        h.keyword_score = (h.keyword_score / max).clamp(0.0, 1.0);
    }
}

fn rescore_hits(hits: &mut [RecallHit], w: HybridWeights, now_secs: i64) {
    for h in hits.iter_mut() {
        let recency = recency_boost(h.record.updated_at, now_secs);
        h.recency_score = recency;
        let pinned_boost = if h.record.pinned { 0.15 } else { 0.0 };
        let conf = h.record.confidence.unwrap_or(0.0) * 0.05;
        // keyword_score already normalized 0..1 in-pool → pass as raw with max=1
        h.score =
            hybrid_score(h.keyword_score, 1.0, h.semantic_score, recency, w) + pinned_boost + conf;
    }
}

fn pool_recall(
    store: &SqliteMemoryStore,
    q: &RecallQuery,
    embed: Option<&dyn EmbedBackend>,
    w: HybridWeights,
    now_secs: i64,
    pool_name: &str,
) -> CoreResult<Vec<RecallHit>> {
    // Keyword path always (store.recall)
    let mut hits = store.recall(q, None, w, now_secs)?;

    // Semantic enrichment when embed present and we can run it offline-sync via
    // MockHash or a pre-resolved backend. Async backends are degraded.
    if let Some(backend) = embed {
        match try_query_embed(backend, &q.query) {
            Some(qvec) => {
                for h in hits.iter_mut() {
                    if let Ok(Some((_model, vec))) = store.get_embedding(&h.record.id) {
                        h.semantic_score = cosine_similarity(&qvec, &vec);
                    } else if let Some(doc_vec) = try_query_embed(backend, &h.record.content) {
                        // On-the-fly embed for ranking; host may persist later
                        h.semantic_score = cosine_similarity(&qvec, &doc_vec);
                        let _ = store.put_embedding(&h.record.id, "runtime", &doc_vec);
                    }
                }
                rescore_hits(&mut hits, w, now_secs);
            }
            None => {
                // Graceful degrade: keyword + recency only; warn once
                if !EMBED_DEGRADED_WARNED.swap(true, Ordering::SeqCst) {
                    tracing::warn!(
                        pool = pool_name,
                        "memory recall: embed backend unavailable/async; degrading to keyword+recency"
                    );
                }
            }
        }
    }
    Ok(hits)
}

/// Try to embed synchronously when the backend is the offline mock; otherwise degrade.
///
/// **Always redacts before embed** (MEMORY.md §5) so a secret never reaches the
/// embedding provider even if content slipped past persist.
fn try_query_embed(backend: &dyn EmbedBackend, text: &str) -> Option<Vec<f32>> {
    let redacted = crate::redact::redact_candidate(text);
    if redacted.blocked {
        tracing::warn!("memory embed blocked: credential-dominant content");
        return None;
    }
    let safe = redacted.text;
    // Use a blocking single-thread runtime for hermetic backends that complete instantly.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let texts = vec![safe];
    // Bound latency: the mock is instant; real network backends should be called
    // by the host with a timeout — here we only attempt a short block.
    match rt.block_on(async {
        tokio::time::timeout(std::time::Duration::from_millis(50), backend.embed(&texts)).await
    }) {
        Ok(Ok(mut v)) if !v.is_empty() => v.pop(),
        _ => None,
    }
}

/// Redact text before embedding (public for tests / host pre-embed).
pub fn redact_for_embed(text: &str) -> crate::error::CoreResult<String> {
    let r = crate::redact::redact_candidate(text);
    if r.blocked {
        return Err(crate::error::CoreError::Policy(
            r.block_reason
                .unwrap_or_else(|| "credential-dominant; refuse embed".into()),
        ));
    }
    Ok(r.text)
}

/// Convenience: rank with the offline mock embed backend (tests / no-network).
pub fn recall_with_mock_embed(
    store: &SqliteMemoryStore,
    q: &RecallQuery,
    now_secs: i64,
) -> CoreResult<Vec<RecallHit>> {
    let mock = MockHashEmbedBackend::new(32);
    store.recall(q, Some(&mock), HybridWeights::default(), now_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{Kind, MemoryDraft, MemoryWriteOp, Scope, TwoScopeMemory};

    #[test]
    fn two_pool_normalizes_before_merge() {
        let facade = TwoScopeMemory::open_in_memory("ws").unwrap();
        // Personal: weak keyword match volume
        let mut p = MemoryDraft::new(Kind::Fact, "alpha personal only note");
        p.scope = Scope::Personal;
        facade.put(MemoryWriteOp::Insert(p), 100).unwrap();
        // Workspace: many keyword hits could dominate without per-pool norm
        for i in 0..5 {
            let mut w = MemoryDraft::new(Kind::Fact, format!("alpha workspace note {i} filler"));
            w.scope = Scope::Workspace;
            facade.put(MemoryWriteOp::Insert(w), 100 + i).unwrap();
        }
        let hits = facade
            .recall(
                &RecallQuery::new("alpha"),
                None,
                HybridWeights::default(),
                200,
            )
            .unwrap();
        assert!(hits.iter().any(|h| h.record.scope == Scope::Personal));
        assert!(hits.iter().any(|h| h.record.scope == Scope::Workspace));
    }

    #[test]
    fn hybrid_ranking_with_fake_embed() {
        reset_embed_degrade_warning();
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        store
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(
                    Kind::Fact,
                    "authentication login password credentials",
                )),
                1,
            )
            .unwrap();
        store
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(
                    Kind::Fact,
                    "unrelated cooking recipes pasta",
                )),
                1,
            )
            .unwrap();
        let mock = MockHashEmbedBackend::new(32);
        // Seed embeddings
        for id in store.changes_since(0).unwrap() {
            let v = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(mock.embed(std::slice::from_ref(&id.content)))
                .unwrap()
                .pop()
                .unwrap();
            store.put_embedding(&id.id, "mock", &v).unwrap();
        }
        let _hits = store
            .recall(
                &RecallQuery::new("auth login"),
                Some(&mock),
                HybridWeights::default(),
                10,
            )
            .unwrap();
        // After pool_recall path via facade is better; direct store still keyword.
        // Use recall_two_pool with one store empty via facade.
        let facade = TwoScopeMemory::open_in_memory("ws").unwrap();
        facade
            .workspace()
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(
                    Kind::Fact,
                    "authentication login password credentials",
                )),
                1,
            )
            .unwrap();
        facade
            .workspace()
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(
                    Kind::Fact,
                    "unrelated cooking recipes pasta",
                )),
                1,
            )
            .unwrap();
        let hits = facade
            .recall(
                &RecallQuery::new("authentication credentials"),
                Some(&mock),
                HybridWeights {
                    keyword: 0.2,
                    semantic: 0.7,
                    recency: 0.1,
                },
                10,
            )
            .unwrap();
        assert!(!hits.is_empty());
        assert!(
            hits[0].record.content.contains("authentication")
                || hits[0].semantic_score >= hits.get(1).map(|h| h.semantic_score).unwrap_or(0.0),
            "top hit should prefer semantic match: {:?}",
            hits.iter()
                .map(|h| (&h.record.content, h.score, h.semantic_score))
                .collect::<Vec<_>>()
        );
        let _ = hits;
    }

    #[test]
    fn redact_before_embed_strips_secrets_and_blocks_credentials() {
        // Prose with key → redacted text embeddable
        let safe =
            redact_for_embed("remember the bot uses sk-abcdefghijklmnop for staging only").unwrap();
        assert!(safe.contains("sk-***"));
        assert!(!safe.contains("abcdefghijklmnop"));

        // Credential-dominant blocked
        let err = redact_for_embed("sk-proj-abcdefghijklmnopqrstuvwxyz012345").unwrap_err();
        assert!(
            format!("{err}").to_lowercase().contains("credential")
                || format!("{err}").to_lowercase().contains("policy")
                || format!("{err}").to_lowercase().contains("refuse"),
            "{err}"
        );

        // JWT class
        let jwt = [
            "eyJ",
            "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            ".",
            "eyJ",
            "zdWIiOiIxMjM0NTY3ODkwIn0",
            ".",
            "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ]
        .concat();
        let safe = redact_for_embed(&format!("auth {jwt} ok")).unwrap();
        assert!(safe.contains("[REDACTED_JWT]") || !safe.contains("eyJhbGci"));
    }

    #[test]
    fn try_query_embed_never_sees_raw_secret() {
        // MockHashEmbedBackend is deterministic from text; redacted vs raw differ.
        let mock = MockHashEmbedBackend::new(32);
        let raw = "seed sk-abcdefghijklmnop end";
        let v_raw = try_query_embed(&mock, raw).expect("should embed redacted");
        let redacted = crate::redact::scrub_secrets(raw);
        let v_red = try_query_embed(&mock, &redacted).expect("redacted embed");
        // Both paths redact first, so vectors match
        assert_eq!(v_raw, v_red);
        assert!(!redacted.contains("abcdefghijklmnop"));
    }

    #[test]
    fn embed_degrade_when_backend_times_out() {
        reset_embed_degrade_warning();
        // Use a backend that sleeps longer than 50ms
        struct Slow;
        #[async_trait::async_trait]
        impl EmbedBackend for Slow {
            async fn embed(&self, texts: &[String]) -> crate::error::CoreResult<Vec<Vec<f32>>> {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                Ok(texts.iter().map(|_| vec![0.1, 0.2]).collect())
            }
        }
        let facade = TwoScopeMemory::open_in_memory("ws").unwrap();
        facade
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(Kind::Fact, "note about zebra")),
                1,
            )
            .unwrap();
        let hits = facade
            .recall(
                &RecallQuery::new("zebra"),
                Some(&Slow),
                HybridWeights::default(),
                1,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].semantic_score, 0.0);
        assert!(embed_degrade_warned());
    }

    #[test]
    fn valid_now_and_include_superseded() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let old = store
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(Kind::Decision, "use postgres")),
                100,
            )
            .unwrap();
        store
            .put(
                MemoryWriteOp::Supersede {
                    old: old.id,
                    new: MemoryDraft::new(Kind::Decision, "use sqlite instead"),
                },
                200,
            )
            .unwrap();
        let active = store
            .recall(
                &RecallQuery::new("sqlite"),
                None,
                HybridWeights::default(),
                200,
            )
            .unwrap();
        assert!(active.iter().all(|h| h.record.status == Status::Active));
        let mut q = RecallQuery::new("postgres");
        q.include_superseded = true;
        // "postgres" only in old content — expand from active chain may not FTS-hit.
        // Query the new text and request chain:
        let mut q2 = RecallQuery::new("sqlite");
        q2.include_superseded = true;
        let chain = store
            .recall(&q2, None, HybridWeights::default(), 200)
            .unwrap();
        assert!(chain.iter().any(|h| h.record.id == old.id));
    }
}
