//! Shared vector index abstraction for memory recall and log templates (#354).
//!
//! - [`ExactIndex`]: brute-force cosine — memory + small corpora.
//! - [`HnswIndex`]: pure-Rust navigable small-world ANN — larger template corpora
//!   (DuckDB `vss` may replace later when event store lands; trait stays stable).

use crate::embed::cosine_similarity;
use crate::error::{CoreError, CoreResult};
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

/// Optional id allowlist for scoped search (memory scope, log service filter, …).
pub type IdSet = HashSet<u64>;

/// Dense vector index shared by memory hybrid recall and log template search.
pub trait VectorIndex: Send + Sync {
    /// Insert or replace a vector for `id` (L2-normalized copy stored).
    fn upsert(&self, id: u64, vector: &[f32]) -> CoreResult<()>;
    /// Top-`k` by cosine similarity in `[0,1]` (negatives clamped via cosine helper).
    /// When `filter` is `Some`, only ids in the set are candidates.
    fn search(
        &self,
        query: &[f32],
        k: usize,
        filter: Option<&IdSet>,
    ) -> CoreResult<Vec<(u64, f32)>>;
    /// Number of stored vectors.
    fn len(&self) -> usize;
    /// True when empty.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Remove one id if present.
    fn remove(&self, id: u64) -> CoreResult<()>;
}

fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / n).collect()
}

/// Brute-force cosine index (memory scale, small log corpora).
#[derive(Default)]
pub struct ExactIndex {
    inner: RwLock<HashMap<u64, Vec<f32>>>,
}

impl ExactIndex {
    /// Empty index.
    pub fn new() -> Self {
        Self::default()
    }
}

impl VectorIndex for ExactIndex {
    fn upsert(&self, id: u64, vector: &[f32]) -> CoreResult<()> {
        if vector.is_empty() {
            return Err(CoreError::Message("empty vector".into()));
        }
        let normed = l2_normalize(vector);
        self.inner
            .write()
            .map_err(|_| CoreError::Message("vector index lock poisoned".into()))?
            .insert(id, normed);
        Ok(())
    }

    fn search(
        &self,
        query: &[f32],
        k: usize,
        filter: Option<&IdSet>,
    ) -> CoreResult<Vec<(u64, f32)>> {
        if k == 0 || query.is_empty() {
            return Ok(vec![]);
        }
        let q = l2_normalize(query);
        let guard = self
            .inner
            .read()
            .map_err(|_| CoreError::Message("vector index lock poisoned".into()))?;
        let mut scored: Vec<(u64, f32)> = guard
            .iter()
            .filter(|(id, _)| filter.map(|f| f.contains(id)).unwrap_or(true))
            .map(|(id, v)| (*id, cosine_similarity(&q, v)))
            .filter(|(_, s)| *s > 0.0)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        Ok(scored)
    }

    fn len(&self) -> usize {
        self.inner.read().map(|g| g.len()).unwrap_or(0)
    }

    fn remove(&self, id: u64) -> CoreResult<()> {
        self.inner
            .write()
            .map_err(|_| CoreError::Message("vector index lock poisoned".into()))?
            .remove(&id);
        Ok(())
    }
}

/// Pure-Rust navigable small-world ANN (HNSW-class) for larger template sets.
///
/// Not bit-identical to DuckDB vss; parity tests assert high recall@k vs ExactIndex
/// on seeded data. Vectors are L2-normalized; edges favor cosine neighbors.
pub struct HnswIndex {
    /// Max edges per node (M).
    m: usize,
    /// Construction candidate list size (ef_construction).
    ef_construction: usize,
    /// Search candidate list size (ef_search).
    ef_search: usize,
    state: RwLock<HnswState>,
}

struct HnswState {
    vectors: HashMap<u64, Vec<f32>>,
    /// Adjacency: id → neighbor ids (undirected graph).
    graph: HashMap<u64, Vec<u64>>,
    /// Entry point for search (arbitrary stored id).
    entry: Option<u64>,
}

impl HnswIndex {
    /// Create with graph parameters.
    pub fn new(m: usize, ef_construction: usize, ef_search: usize) -> Self {
        Self {
            m: m.max(4),
            ef_construction: ef_construction.max(16),
            ef_search: ef_search.max(16),
            state: RwLock::new(HnswState {
                vectors: HashMap::new(),
                graph: HashMap::new(),
                entry: None,
            }),
        }
    }

    /// Default parameters suitable for template-scale corpora.
    pub fn with_defaults() -> Self {
        Self::new(16, 64, 64)
    }

    fn select_neighbors(&self, candidates: &[(u64, f32)], m: usize) -> Vec<u64> {
        let mut c = candidates.to_vec();
        c.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        c.into_iter().take(m).map(|(id, _)| id).collect()
    }

    fn search_layer(
        &self,
        st: &HnswState,
        query: &[f32],
        entry: u64,
        ef: usize,
        filter: Option<&IdSet>,
    ) -> Vec<(u64, f32)> {
        let mut visited = HashSet::new();
        let mut candidates: Vec<(u64, f32)> = Vec::new();
        let mut w: Vec<(u64, f32)> = Vec::new();

        let entry_score = st
            .vectors
            .get(&entry)
            .map(|v| cosine_similarity(query, v))
            .unwrap_or(0.0);
        visited.insert(entry);
        candidates.push((entry, entry_score));
        if filter.map(|f| f.contains(&entry)).unwrap_or(true) {
            w.push((entry, entry_score));
        }

        while let Some((c_id, c_score)) = {
            candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            if candidates.is_empty() {
                None
            } else {
                Some(candidates.remove(0))
            }
        } {
            let w_worst = w.iter().map(|(_, s)| *s).fold(f32::INFINITY, f32::min);
            if !w.is_empty() && c_score < w_worst && w.len() >= ef {
                break;
            }
            if let Some(neighbors) = st.graph.get(&c_id) {
                for &n in neighbors {
                    if visited.contains(&n) {
                        continue;
                    }
                    visited.insert(n);
                    let Some(nv) = st.vectors.get(&n) else {
                        continue;
                    };
                    let sc = cosine_similarity(query, nv);
                    let w_worst = w.iter().map(|(_, s)| *s).fold(f32::INFINITY, f32::min);
                    if w.len() < ef || sc > w_worst {
                        candidates.push((n, sc));
                        if filter.map(|f| f.contains(&n)).unwrap_or(true) {
                            w.push((n, sc));
                            if w.len() > ef {
                                w.sort_by(|a, b| {
                                    b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
                                });
                                w.truncate(ef);
                            }
                        }
                    }
                }
            }
        }
        w.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        w
    }
}

impl VectorIndex for HnswIndex {
    fn upsert(&self, id: u64, vector: &[f32]) -> CoreResult<()> {
        if vector.is_empty() {
            return Err(CoreError::Message("empty vector".into()));
        }
        let normed = l2_normalize(vector);
        let mut st = self
            .state
            .write()
            .map_err(|_| CoreError::Message("hnsw lock poisoned".into()))?;

        if st.vectors.is_empty() {
            st.vectors.insert(id, normed);
            st.graph.insert(id, Vec::new());
            st.entry = Some(id);
            return Ok(());
        }

        // Temporary insert so search can see existing graph; rebuild neighbors.
        let entry = st.entry.unwrap_or(id);
        let q = normed.clone();
        // Search without filter among existing
        let found = self.search_layer(&st, &q, entry, self.ef_construction, None);
        let neighbors = self.select_neighbors(&found, self.m);
        st.vectors.insert(id, normed);
        st.graph.insert(id, neighbors.clone());
        // Update reverse edges + trim degree without holding entry borrow across vectors.
        let m = self.m;
        for n in neighbors {
            {
                let e = st.graph.entry(n).or_default();
                if !e.contains(&id) {
                    e.push(id);
                }
            }
            let deg = st.graph.get(&n).map(|e| e.len()).unwrap_or(0);
            if deg > m * 2 {
                let nv = st.vectors.get(&n).cloned().unwrap_or_default();
                let neigh = st.graph.get(&n).cloned().unwrap_or_default();
                let mut scored: Vec<(u64, f32)> = neigh
                    .iter()
                    .filter_map(|oid| {
                        st.vectors
                            .get(oid)
                            .map(|v| (*oid, cosine_similarity(&nv, v)))
                    })
                    .collect();
                scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                let trimmed: Vec<u64> = scored.into_iter().take(m).map(|(i, _)| i).collect();
                st.graph.insert(n, trimmed);
            }
        }
        if st.entry.is_none() {
            st.entry = Some(id);
        }
        Ok(())
    }

    fn search(
        &self,
        query: &[f32],
        k: usize,
        filter: Option<&IdSet>,
    ) -> CoreResult<Vec<(u64, f32)>> {
        if k == 0 || query.is_empty() {
            return Ok(vec![]);
        }
        let st = self
            .state
            .read()
            .map_err(|_| CoreError::Message("hnsw lock poisoned".into()))?;
        let Some(entry) = st.entry else {
            return Ok(vec![]);
        };
        let q = l2_normalize(query);
        let ef = self.ef_search.max(k);
        let mut w = self.search_layer(&st, &q, entry, ef, filter);
        // If filter excluded entry path entirely, brute-force fallback for correctness
        if w.is_empty() && filter.is_some() {
            let mut scored: Vec<(u64, f32)> = st
                .vectors
                .iter()
                .filter(|(id, _)| filter.map(|f| f.contains(id)).unwrap_or(true))
                .map(|(id, v)| (*id, cosine_similarity(&q, v)))
                .filter(|(_, s)| *s > 0.0)
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(k);
            return Ok(scored);
        }
        w.truncate(k);
        Ok(w)
    }

    fn len(&self) -> usize {
        self.state.read().map(|s| s.vectors.len()).unwrap_or(0)
    }

    fn remove(&self, id: u64) -> CoreResult<()> {
        let mut st = self
            .state
            .write()
            .map_err(|_| CoreError::Message("hnsw lock poisoned".into()))?;
        st.vectors.remove(&id);
        st.graph.remove(&id);
        for neigh in st.graph.values_mut() {
            neigh.retain(|x| *x != id);
        }
        if st.entry == Some(id) {
            st.entry = st.vectors.keys().next().copied();
        }
        Ok(())
    }
}

/// Size threshold: below this use ExactIndex for search backends that auto-select.
pub const EXACT_SIZE_THRESHOLD: usize = 50_000;

/// Auto-select backend by expected corpus size (templates or memories).
pub fn select_backend(expected_len: usize) -> Box<dyn VectorIndex> {
    if expected_len < EXACT_SIZE_THRESHOLD {
        Box::new(ExactIndex::new())
    } else {
        Box::new(HnswIndex::with_defaults())
    }
}

/// Backend kind name for diagnostics.
pub fn backend_name(expected_len: usize) -> &'static str {
    if expected_len < EXACT_SIZE_THRESHOLD {
        "exact"
    } else {
        "hnsw"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(i: usize, dims: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; dims];
        v[i % dims] = 1.0;
        v
    }

    #[test]
    fn exact_upsert_search_and_filter() {
        let idx = ExactIndex::new();
        for i in 0..10u64 {
            idx.upsert(i, &unit(i as usize, 8)).unwrap();
        }
        assert_eq!(idx.len(), 10);
        let q = unit(3, 8);
        let hits = idx.search(&q, 3, None).unwrap();
        assert_eq!(hits[0].0, 3);
        assert!(hits[0].1 > 0.99);

        let mut allow = IdSet::new();
        allow.insert(7);
        allow.insert(8);
        let f = idx.search(&unit(7, 8), 5, Some(&allow)).unwrap();
        assert!(f.iter().all(|(id, _)| allow.contains(id)));
        assert_eq!(f[0].0, 7);
    }

    #[test]
    fn hnsw_recall_at_k_parity_vs_exact() {
        // Seeded fixed set — both backends must put true nearest neighbor in top-5.
        let dims = 16;
        let n = 200u64;
        let exact = ExactIndex::new();
        let hnsw = HnswIndex::with_defaults();
        for i in 0..n {
            // Deterministic quasi-random vectors
            let v: Vec<f32> = (0..dims)
                .map(|d| ((i as f32 * 17.0 + d as f32 * 3.0).sin() + 1.0) * 0.5)
                .collect();
            exact.upsert(i, &v).unwrap();
            hnsw.upsert(i, &v).unwrap();
        }
        let q: Vec<f32> = (0..dims)
            .map(|d| ((42.0 + d as f32 * 2.0).cos() + 1.0) * 0.5)
            .collect();
        let k = 5;
        let truth = exact.search(&q, k, None).unwrap();
        let approx = hnsw.search(&q, k, None).unwrap();
        assert!(!truth.is_empty());
        assert!(!approx.is_empty());
        // Top-1 from exact should appear in HNSW top-k (high recall@k)
        let top = truth[0].0;
        assert!(
            approx.iter().any(|(id, _)| *id == top),
            "hnsw missed exact top-1={top}; exact={truth:?} hnsw={approx:?}"
        );
        // Score of shared id should be close
        let exact_score = truth[0].1;
        let hnsw_score = approx
            .iter()
            .find(|(id, _)| *id == top)
            .map(|(_, s)| *s)
            .unwrap();
        assert!((exact_score - hnsw_score).abs() < 1e-4);
    }

    #[test]
    fn hnsw_filter_scopes() {
        let idx = HnswIndex::with_defaults();
        for i in 0..40u64 {
            idx.upsert(i, &unit(i as usize, 8)).unwrap();
        }
        let mut allow = IdSet::new();
        for i in 20..30 {
            allow.insert(i);
        }
        let hits = idx.search(&unit(25, 8), 10, Some(&allow)).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|(id, _)| allow.contains(id)));
    }

    #[test]
    fn select_backend_by_size() {
        assert_eq!(backend_name(100), "exact");
        assert_eq!(backend_name(EXACT_SIZE_THRESHOLD + 1), "hnsw");
        let b = select_backend(10);
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn remove_works() {
        let idx = ExactIndex::new();
        idx.upsert(1, &[1.0, 0.0]).unwrap();
        idx.remove(1).unwrap();
        assert_eq!(idx.len(), 0);
    }
}
