//! cluster_problems + timeline (#361).

use super::drain::TemplateInfo;
use super::search::normalize_excluded_template_ids;
use super::store::LogCorpus;
use crate::error::{CoreError, CoreResult};
use duckdb::types::Value;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

/// Maximum number of templates admitted to pairwise problem clustering.
///
/// Candidate selection remains deterministic and reserves capacity for rare
/// templates so a high-cardinality corpus cannot turn clustering into O(T²)
/// work or let frequent templates entirely hide rare severe anomalies.
pub const MAX_CLUSTER_TEMPLATE_CANDIDATES: usize = 512;

/// Maximum number of buckets returned by the agent-facing analysis timeline.
///
/// This is intentionally separate from the Explorer timeline DTOs. The agent
/// tool needs a fixed memory bound even when every event has a unique
/// timestamp.
pub const MAX_ANALYSIS_TIMELINE_BUCKETS: usize = 512;

const RARE_TEMPLATE_MAX_COUNT: u64 = 2;
const RARE_TEMPLATE_CANDIDATE_RESERVE: usize = 64;
const MAX_CLUSTER_EXEMPLARS: usize = 3;
const MAX_EXEMPLAR_CHARS: usize = 120;
const CLUSTER_SIMILARITY_THRESHOLD: f32 = 0.4;

/// One problem cluster summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSummary {
    /// Cluster id (lowest template id).
    pub cluster_id: u64,
    /// Member template ids.
    pub template_ids: Vec<u64>,
    /// Representative pattern.
    pub label: String,
    /// Combined event count.
    pub count: u64,
    /// Max severity in cluster.
    pub severity: u8,
    /// Ranking score = severity × log(count) × anomaly hint.
    pub score: f32,
    /// Exemplar messages.
    pub exemplars: Vec<String>,
    /// True when some available templates could not be assigned to a bounded
    /// prototype without weakening the similarity rule.
    #[serde(default)]
    pub partial: bool,
    /// Templates represented by the returned analysis before max-cluster
    /// result truncation.
    #[serde(default)]
    pub templates_considered: usize,
    /// Templates available in the corpus.
    #[serde(default)]
    pub templates_available: usize,
}

/// Timeline bucket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineBucket {
    /// Bucket start unix secs.
    pub start: i64,
    /// Bucket width secs.
    pub width: i64,
    /// Count of events in bucket.
    pub count: u64,
    /// Count by level.
    pub by_level: HashMap<String, u64>,
}

/// Bounded agent-facing timeline plus coarsening disclosure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineAnalysis {
    /// Normalized width requested by the caller (minimum one second).
    pub requested_width: i64,
    /// Width actually used to enforce [`MAX_ANALYSIS_TIMELINE_BUCKETS`].
    pub effective_width: i64,
    /// Whether the effective width is wider than the requested width.
    pub coarsened: bool,
    /// Exact number of events matching the optional filters.
    pub total_count: u64,
    /// Chronological occupied buckets, always bounded.
    pub buckets: Vec<TimelineBucket>,
}

/// Cluster templates by pattern token Jaccard + severity.
pub fn cluster_problems(
    corpus: &LogCorpus,
    max_clusters: usize,
) -> CoreResult<Vec<ClusterSummary>> {
    cluster_problems_with_excluded_templates(corpus, max_clusters, &[])
}

/// Cluster templates after applying an exact-template suppression lens.
pub fn cluster_problems_with_excluded_templates(
    corpus: &LogCorpus,
    max_clusters: usize,
    excluded_template_ids: &[u64],
) -> CoreResult<Vec<ClusterSummary>> {
    cluster_problems_with_excluded_templates_and_cancel(
        corpus,
        max_clusters,
        excluded_template_ids,
        None,
    )
}

/// Cluster templates with a cooperative cancellation flag for blocking hosts.
pub fn cluster_problems_with_excluded_templates_and_cancel(
    corpus: &LogCorpus,
    max_clusters: usize,
    excluded_template_ids: &[u64],
    cancel: Option<&AtomicBool>,
) -> CoreResult<Vec<ClusterSummary>> {
    let excluded = normalize_excluded_template_ids(excluded_template_ids)?;
    check_analysis_cancel(cancel)?;
    let candidates = load_cluster_candidates(corpus, &excluded, cancel)?;
    if candidates.templates.is_empty() {
        return Ok(vec![]);
    }
    let templates_available = candidates.templates_available;
    let templates_considered = candidates.templates.len();
    let candidate_tokens: Vec<_> = candidates
        .templates
        .iter()
        .map(|template| tokenize(&template.info.pattern))
        .collect();

    // Greedy clustering: assign each template to first cluster with sim >= 0.4
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for candidate_position in 0..candidates.templates.len() {
        check_analysis_cancel(cancel)?;
        let mut placed = false;
        for c in clusters.iter_mut() {
            let prototype_position = c[0];
            if jaccard(
                &candidate_tokens[candidate_position],
                &candidate_tokens[prototype_position],
            ) >= CLUSTER_SIMILARITY_THRESHOLD
            {
                c.push(candidate_position);
                placed = true;
                break;
            }
        }
        if !placed {
            clusters.push(vec![candidate_position]);
        }
    }

    // Clustering work is now strictly capped: omitted templates are neither
    // tokenized nor compared with prototypes. Their exclusion is explicit in
    // every summary, and each count is exact only for the candidate members
    // actually considered.
    let partial = templates_considered < templates_available;

    let mut out = Vec::new();
    for c in clusters {
        let mut tids = Vec::new();
        let mut count = 0u64;
        let mut severity = 0u8;
        let mut label = String::new();
        let mut ex = Vec::new();
        let mut min_id = u64::MAX;
        for candidate_position in c {
            let t = &candidates.templates[candidate_position];
            tids.push(t.info.template_id);
            count += t.info.count;
            severity = severity.max(t.info.severity);
            if label.is_empty() {
                label = t.info.pattern.clone();
            }
            min_id = min_id.min(t.info.template_id);
            let exemplar: String = t.info.example.chars().take(MAX_EXEMPLAR_CHARS).collect();
            if !exemplar.is_empty() && ex.len() < MAX_CLUSTER_EXEMPLARS && !ex.contains(&exemplar) {
                ex.push(exemplar);
            }
        }
        let score = problem_score(severity, count);
        out.push(ClusterSummary {
            cluster_id: min_id,
            template_ids: tids,
            label,
            count,
            severity,
            score,
            exemplars: ex,
            partial,
            templates_considered,
            templates_available,
        });
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| b.severity.cmp(&a.severity))
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.cluster_id.cmp(&b.cluster_id))
    });
    out.truncate(max_clusters.max(1));
    Ok(out)
}

#[derive(Debug)]
struct ClusterCandidateSet {
    templates: Vec<ClusterTemplateCandidate>,
    templates_available: usize,
}

#[derive(Debug)]
struct ClusterTemplateCandidate {
    info: ClusterTemplateInfo,
}

#[derive(Debug)]
struct ClusterTemplateInfo {
    template_id: u64,
    pattern: String,
    count: u64,
    severity: u8,
    example: String,
}

impl From<TemplateInfo> for ClusterTemplateInfo {
    fn from(info: TemplateInfo) -> Self {
        Self {
            template_id: info.template_id,
            pattern: info.pattern,
            count: info.count,
            severity: info.severity,
            example: info.example,
        }
    }
}

fn load_cluster_candidates(
    corpus: &LogCorpus,
    excluded: &BTreeSet<u64>,
    cancel: Option<&AtomicBool>,
) -> CoreResult<ClusterCandidateSet> {
    check_analysis_cancel(cancel)?;
    let total_templates = corpus.template_count();
    if total_templates <= MAX_CLUSTER_TEMPLATE_CANDIDATES {
        let mut templates = corpus
            .list_template_infos()
            .into_iter()
            .filter(|info| !excluded.contains(&info.template_id))
            .map(|info| ClusterTemplateCandidate { info: info.into() })
            .collect::<Vec<_>>();
        check_analysis_cancel(cancel)?;
        templates.sort_by(template_impact_cmp);
        return Ok(ClusterCandidateSet {
            templates_available: templates.len(),
            templates,
        });
    }

    let path = corpus.root().join("templates.json");
    let mut sidecar = File::open(path)?;
    let sidecar_before = template_sidecar_digest(&mut sidecar, cancel)?;
    let rank_scan = scan_template_ranks(&mut sidecar, excluded, cancel).map_err(|error| {
        CoreError::Message(format!(
            "bounded template analysis requires a current templates.json sidecar: {error}"
        ))
    })?;
    if rank_scan.templates_total != total_templates {
        return Err(CoreError::Message(format!(
            "bounded template analysis refused a stale templates.json sidecar: \
             in-memory templates={total_templates}, persisted templates={}",
            rank_scan.templates_total
        )));
    }

    let templates_available = rank_scan.templates_available;
    let selected_ranks = select_cluster_candidate_ranks(rank_scan);
    let selected_by_id = selected_ranks
        .iter()
        .map(|rank| (rank.template_id, rank))
        .collect::<HashMap<_, _>>();
    let payload_scan =
        scan_selected_template_payloads(&mut sidecar, &selected_by_id, excluded, cancel)?;
    if template_sidecar_digest(&mut sidecar, cancel)? != sidecar_before {
        return Err(CoreError::Message(
            "bounded template analysis refused a templates.json sidecar that changed during analysis"
                .into(),
        ));
    }
    if payload_scan.templates_total != total_templates
        || payload_scan.templates_available != templates_available
    {
        return Err(CoreError::Message(
            "bounded template analysis refused a templates.json sidecar that changed during analysis"
                .into(),
        ));
    }
    if payload_scan.templates.len() != selected_ranks.len() {
        return Err(CoreError::Message(format!(
            "bounded template analysis could not materialize every selected template: \
             selected={}, materialized={}",
            selected_ranks.len(),
            payload_scan.templates.len()
        )));
    }

    let mut templates = payload_scan.templates;
    templates.sort_by(template_impact_cmp);
    Ok(ClusterCandidateSet {
        templates,
        templates_available: payload_scan.templates_available,
    })
}

fn check_analysis_cancel(cancel: Option<&AtomicBool>) -> CoreResult<()> {
    if cancel.is_some_and(|flag| flag.load(AtomicOrdering::Relaxed)) {
        return Err(CoreError::Message(
            "deterministic broad log triage cancelled".into(),
        ));
    }
    Ok(())
}

struct CancelReader<'a, R> {
    inner: R,
    cancel: Option<&'a AtomicBool>,
}

impl<R: Read> Read for CancelReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self
            .cancel
            .is_some_and(|flag| flag.load(AtomicOrdering::Relaxed))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "deterministic broad log triage cancelled",
            ));
        }
        self.inner.read(buffer)
    }
}

fn template_sidecar_digest(file: &mut File, cancel: Option<&AtomicBool>) -> CoreResult<[u8; 32]> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check_analysis_cancel(cancel)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

#[derive(Debug, Clone, Copy)]
struct TemplateRank {
    score: f32,
    severity: u8,
    count: u64,
    template_id: u64,
    severity_first: bool,
}

impl TemplateRank {
    fn new(info: &TemplateRankInfo, severity_first: bool) -> Self {
        Self {
            score: if severity_first {
                info.severity as f32
            } else {
                problem_score(info.severity, info.count)
            },
            severity: info.severity,
            count: info.count,
            template_id: info.template_id,
            severity_first,
        }
    }
}

impl PartialEq for TemplateRank {
    fn eq(&self, other: &Self) -> bool {
        self.score.to_bits() == other.score.to_bits()
            && self.severity == other.severity
            && self.count == other.count
            && self.template_id == other.template_id
            && self.severity_first == other.severity_first
    }
}

impl Eq for TemplateRank {}

impl PartialOrd for TemplateRank {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for TemplateRank {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap keeps the greatest value at its root. Reverse the impact
        // fields so the worst retained candidate is evicted first.
        other
            .score
            .total_cmp(&self.score)
            .then_with(|| other.severity.cmp(&self.severity))
            .then_with(|| other.count.cmp(&self.count))
            .then_with(|| self.template_id.cmp(&other.template_id))
            .then_with(|| self.severity_first.cmp(&other.severity_first))
    }
}

#[derive(Debug, Deserialize)]
struct TemplateRankEnvelope {
    info: TemplateRankInfo,
}

#[derive(Debug, Deserialize)]
struct TemplateRankInfo {
    template_id: u64,
    count: u64,
    severity: u8,
}

#[derive(Debug)]
struct TemplateRankScan {
    templates_total: usize,
    templates_available: usize,
    impact: BinaryHeap<TemplateRank>,
    rare: BinaryHeap<TemplateRank>,
}

struct TemplateRankScanSeed<'a> {
    excluded: &'a BTreeSet<u64>,
    cancel: Option<&'a AtomicBool>,
}

impl<'de> DeserializeSeed<'de> for TemplateRankScanSeed<'_> {
    type Value = TemplateRankScan;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct TemplateRankScanVisitor<'a> {
            excluded: &'a BTreeSet<u64>,
            cancel: Option<&'a AtomicBool>,
        }

        impl<'de> Visitor<'de> for TemplateRankScanVisitor<'_> {
            type Value = TemplateRankScan;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a template row array")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut scan = TemplateRankScan {
                    templates_total: 0,
                    templates_available: 0,
                    impact: BinaryHeap::with_capacity(MAX_CLUSTER_TEMPLATE_CANDIDATES + 1),
                    rare: BinaryHeap::with_capacity(MAX_CLUSTER_TEMPLATE_CANDIDATES + 1),
                };
                while let Some(row) = seq.next_element::<TemplateRankEnvelope>()? {
                    if self
                        .cancel
                        .is_some_and(|flag| flag.load(AtomicOrdering::Relaxed))
                    {
                        return Err(serde::de::Error::custom(
                            "deterministic broad log triage cancelled",
                        ));
                    }
                    scan.templates_total = scan.templates_total.saturating_add(1);
                    if self.excluded.contains(&row.info.template_id) {
                        continue;
                    }
                    scan.templates_available = scan.templates_available.saturating_add(1);
                    retain_bounded_rank(&mut scan.impact, TemplateRank::new(&row.info, false));
                    if row.info.count <= RARE_TEMPLATE_MAX_COUNT {
                        retain_bounded_rank(&mut scan.rare, TemplateRank::new(&row.info, true));
                    }
                }
                Ok(scan)
            }
        }

        deserializer.deserialize_seq(TemplateRankScanVisitor {
            excluded: self.excluded,
            cancel: self.cancel,
        })
    }
}

fn retain_bounded_rank(heap: &mut BinaryHeap<TemplateRank>, rank: TemplateRank) {
    if heap.len() < MAX_CLUSTER_TEMPLATE_CANDIDATES {
        heap.push(rank);
    } else if heap.peek().is_some_and(|worst| rank < *worst) {
        heap.pop();
        heap.push(rank);
    }
}

fn scan_template_ranks(
    file: &mut File,
    excluded: &BTreeSet<u64>,
    cancel: Option<&AtomicBool>,
) -> CoreResult<TemplateRankScan> {
    file.seek(SeekFrom::Start(0))?;
    let reader = CancelReader {
        inner: file,
        cancel,
    };
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(reader));
    let scan = TemplateRankScanSeed { excluded, cancel }.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(scan)
}

fn select_cluster_candidate_ranks(scan: TemplateRankScan) -> Vec<TemplateRank> {
    let templates_available = scan.templates_available;
    let mut impact = scan.impact.into_vec();
    impact.sort_by(template_rank_impact_cmp);
    if templates_available <= MAX_CLUSTER_TEMPLATE_CANDIDATES {
        return impact;
    }

    let mut rare = scan.rare.into_vec();
    rare.sort_by(template_rank_rare_cmp);
    let impact_slots =
        MAX_CLUSTER_TEMPLATE_CANDIDATES.saturating_sub(RARE_TEMPLATE_CANDIDATE_RESERVE);
    let mut selected = impact
        .iter()
        .take(impact_slots)
        .copied()
        .collect::<Vec<_>>();
    let mut selected_ids = selected
        .iter()
        .map(|rank| rank.template_id)
        .collect::<HashSet<_>>();
    for rank in rare.into_iter().chain(impact.iter().copied()) {
        if selected.len() >= MAX_CLUSTER_TEMPLATE_CANDIDATES {
            break;
        }
        if selected_ids.insert(rank.template_id) {
            selected.push(rank);
        }
    }
    selected.sort_by(template_rank_impact_cmp);
    selected
}

fn template_rank_impact_cmp(a: &TemplateRank, b: &TemplateRank) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| b.severity.cmp(&a.severity))
        .then_with(|| b.count.cmp(&a.count))
        .then_with(|| a.template_id.cmp(&b.template_id))
}

fn template_rank_rare_cmp(a: &TemplateRank, b: &TemplateRank) -> Ordering {
    b.severity
        .cmp(&a.severity)
        .then_with(|| template_rank_impact_cmp(a, b))
}

#[derive(Debug)]
struct TemplatePayloadScan {
    templates_total: usize,
    templates_available: usize,
    templates: Vec<ClusterTemplateCandidate>,
}

struct TemplatePayloadScanSeed<'a> {
    selected_by_id: &'a HashMap<u64, &'a TemplateRank>,
    excluded: &'a BTreeSet<u64>,
}

struct TemplatePayloadRowSeed<'a> {
    selected_by_id: &'a HashMap<u64, &'a TemplateRank>,
}

struct TemplatePayloadRow {
    template_id: u64,
    candidate: Option<ClusterTemplateCandidate>,
}

impl<'de> DeserializeSeed<'de> for TemplatePayloadRowSeed<'_> {
    type Value = TemplatePayloadRow;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct TemplatePayloadRowVisitor<'a> {
            selected_by_id: &'a HashMap<u64, &'a TemplateRank>,
        }

        impl<'de> Visitor<'de> for TemplatePayloadRowVisitor<'_> {
            type Value = TemplatePayloadRow;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a persisted template row")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut info = None;
                while let Some(field) = map.next_key::<String>()? {
                    if field == "info" {
                        info = Some(map.next_value_seed(TemplateInfoPayloadSeed {
                            selected_by_id: self.selected_by_id,
                        })?);
                    } else {
                        // In particular, the optional embedding vector is
                        // consumed without allocating or cloning its values.
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                info.ok_or_else(|| serde::de::Error::missing_field("info"))
            }
        }

        deserializer.deserialize_map(TemplatePayloadRowVisitor {
            selected_by_id: self.selected_by_id,
        })
    }
}

struct TemplateInfoPayloadSeed<'a> {
    selected_by_id: &'a HashMap<u64, &'a TemplateRank>,
}

impl<'de> DeserializeSeed<'de> for TemplateInfoPayloadSeed<'_> {
    type Value = TemplatePayloadRow;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct TemplateInfoPayloadVisitor<'a> {
            selected_by_id: &'a HashMap<u64, &'a TemplateRank>,
        }

        impl<'de> Visitor<'de> for TemplateInfoPayloadVisitor<'_> {
            type Value = TemplatePayloadRow;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("persisted template info")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut template_id = None;
                let mut pattern = None;
                let mut count = None;
                let mut severity = None;
                let mut example = None;
                while let Some(field) = map.next_key::<String>()? {
                    let selected =
                        template_id.is_some_and(|id| self.selected_by_id.contains_key(&id));
                    match field.as_str() {
                        "template_id" => template_id = Some(map.next_value()?),
                        "pattern" if selected || template_id.is_none() => {
                            pattern = Some(map.next_value()?)
                        }
                        "count" if selected || template_id.is_none() => {
                            count = Some(map.next_value()?)
                        }
                        "severity" if selected || template_id.is_none() => {
                            severity = Some(map.next_value()?)
                        }
                        "example" if selected || template_id.is_none() => {
                            example = Some(map.next_value()?)
                        }
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }

                let template_id =
                    template_id.ok_or_else(|| serde::de::Error::missing_field("template_id"))?;
                if !self.selected_by_id.contains_key(&template_id) {
                    return Ok(TemplatePayloadRow {
                        template_id,
                        candidate: None,
                    });
                }
                Ok(TemplatePayloadRow {
                    template_id,
                    candidate: Some(ClusterTemplateCandidate {
                        info: ClusterTemplateInfo {
                            template_id,
                            pattern: pattern
                                .ok_or_else(|| serde::de::Error::missing_field("pattern"))?,
                            count: count.ok_or_else(|| serde::de::Error::missing_field("count"))?,
                            severity: severity
                                .ok_or_else(|| serde::de::Error::missing_field("severity"))?,
                            example: example
                                .ok_or_else(|| serde::de::Error::missing_field("example"))?,
                        },
                    }),
                })
            }
        }

        deserializer.deserialize_map(TemplateInfoPayloadVisitor {
            selected_by_id: self.selected_by_id,
        })
    }
}

impl<'de> DeserializeSeed<'de> for TemplatePayloadScanSeed<'_> {
    type Value = TemplatePayloadScan;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct TemplatePayloadScanVisitor<'a> {
            selected_by_id: &'a HashMap<u64, &'a TemplateRank>,
            excluded: &'a BTreeSet<u64>,
        }

        impl<'de> Visitor<'de> for TemplatePayloadScanVisitor<'_> {
            type Value = TemplatePayloadScan;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a template row array")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut scan = TemplatePayloadScan {
                    templates_total: 0,
                    templates_available: 0,
                    templates: Vec::with_capacity(self.selected_by_id.len()),
                };
                while let Some(row) = seq.next_element_seed(TemplatePayloadRowSeed {
                    selected_by_id: self.selected_by_id,
                })? {
                    scan.templates_total = scan.templates_total.saturating_add(1);
                    if self.excluded.contains(&row.template_id) {
                        continue;
                    }
                    scan.templates_available = scan.templates_available.saturating_add(1);
                    let Some(candidate) = row.candidate else {
                        continue;
                    };
                    let expected = self
                        .selected_by_id
                        .get(&candidate.info.template_id)
                        .ok_or_else(|| {
                            serde::de::Error::custom(
                                "template payload materialized outside the bounded selection",
                            )
                        })?;
                    if candidate.info.count != expected.count
                        || candidate.info.severity != expected.severity
                    {
                        return Err(serde::de::Error::custom(format!(
                            "template {} ranking metadata changed between bounded scans",
                            candidate.info.template_id
                        )));
                    }
                    scan.templates.push(candidate);
                }
                Ok(scan)
            }
        }

        deserializer.deserialize_seq(TemplatePayloadScanVisitor {
            selected_by_id: self.selected_by_id,
            excluded: self.excluded,
        })
    }
}

fn scan_selected_template_payloads(
    file: &mut File,
    selected_by_id: &HashMap<u64, &TemplateRank>,
    excluded: &BTreeSet<u64>,
    cancel: Option<&AtomicBool>,
) -> CoreResult<TemplatePayloadScan> {
    file.seek(SeekFrom::Start(0))?;
    let reader = CancelReader {
        inner: file,
        cancel,
    };
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(reader));
    let scan = TemplatePayloadScanSeed {
        selected_by_id,
        excluded,
    }
    .deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(scan)
}

fn template_impact_cmp(a: &ClusterTemplateCandidate, b: &ClusterTemplateCandidate) -> Ordering {
    problem_score(b.info.severity, b.info.count)
        .partial_cmp(&problem_score(a.info.severity, a.info.count))
        .unwrap_or(Ordering::Equal)
        .then_with(|| b.info.severity.cmp(&a.info.severity))
        .then_with(|| b.info.count.cmp(&a.info.count))
        .then_with(|| a.info.template_id.cmp(&b.info.template_id))
}

fn problem_score(severity: u8, count: u64) -> f32 {
    let anomaly = if count <= RARE_TEMPLATE_MAX_COUNT {
        1.5
    } else {
        1.0
    };
    (severity as f32) * ((count as f32).ln_1p()) * anomaly
}

/// Frequency-over-time for events matching optional filters.
pub fn timeline(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
) -> CoreResult<Vec<TimelineBucket>> {
    timeline_with_excluded_templates(corpus, width_secs, level, service, &[])
}

/// Frequency-over-time after applying an exact-template suppression lens.
pub fn timeline_with_excluded_templates(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
    excluded_template_ids: &[u64],
) -> CoreResult<Vec<TimelineBucket>> {
    Ok(timeline_summary_with_excluded_templates(
        corpus,
        width_secs,
        level,
        service,
        excluded_template_ids,
    )?
    .buckets)
}

/// Frequency-over-time with the exact width/coarsening decision used by the
/// agent-facing timeline tool.
pub fn timeline_summary(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
) -> CoreResult<TimelineAnalysis> {
    timeline_summary_with_excluded_templates(corpus, width_secs, level, service, &[])
}

/// Agent-facing timeline after applying an exact-template suppression lens.
pub fn timeline_summary_with_excluded_templates(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
    excluded_template_ids: &[u64],
) -> CoreResult<TimelineAnalysis> {
    let excluded = normalize_excluded_template_ids(excluded_template_ids)?;
    let requested_width = width_secs.max(1);
    let normalized_level = level.map(str::to_ascii_lowercase);
    let (where_sql, filter_binds) =
        timeline_filter(&normalized_level, service, excluded.iter().copied());
    corpus.with_connection(|conn| {
        let count_sql = format!("SELECT MIN(ts), MAX(ts), COUNT(*) FROM events WHERE {where_sql}");
        let (min_ts, max_ts, total_count) = conn
            .query_row(&count_sql, params_ref(&filter_binds).as_slice(), |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(duck_error)?;
        let (Some(min_ts), Some(max_ts)) = (min_ts, max_ts) else {
            return Ok(TimelineAnalysis {
                requested_width,
                effective_width: requested_width,
                coarsened: false,
                total_count: 0,
                buckets: Vec::new(),
            });
        };
        let effective_width = bounded_timeline_width(min_ts, max_ts, requested_width);

        // `ts - (ts % width)` matches Rust's integer division semantics,
        // including truncation toward zero for order-only negative values.
        let timeline_sql = format!(
            r#"
                SELECT ts - (ts % ?) AS bucket_start,
                       level,
                       COUNT(*) AS event_count
                FROM events
                WHERE {where_sql}
                GROUP BY 1, 2
                ORDER BY 1 ASC, 2 ASC
                "#
        );
        let mut stmt = conn.prepare(&timeline_sql).map_err(duck_error)?;
        let mut timeline_binds = Vec::with_capacity(filter_binds.len() + 1);
        timeline_binds.push(Value::BigInt(effective_width));
        timeline_binds.extend(filter_binds.iter().cloned());
        let rows = stmt
            .query_map(params_ref(&timeline_binds).as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(duck_error)?;

        let mut buckets = Vec::<TimelineBucket>::new();
        for row in rows {
            let (start, row_level, count) = row.map_err(duck_error)?;
            if buckets.last().map(|bucket| bucket.start) != Some(start) {
                buckets.push(TimelineBucket {
                    start,
                    width: effective_width,
                    count: 0,
                    by_level: HashMap::new(),
                });
            }
            let bucket = buckets.last_mut().ok_or_else(|| {
                CoreError::Message("timeline aggregate row had no destination bucket".into())
            })?;
            bucket.count += count;
            bucket.by_level.insert(row_level, count);
        }
        debug_assert!(buckets.len() <= MAX_ANALYSIS_TIMELINE_BUCKETS);
        debug_assert_eq!(
            buckets.iter().map(|bucket| bucket.count).sum::<u64>(),
            total_count
        );
        Ok(TimelineAnalysis {
            requested_width,
            effective_width,
            coarsened: effective_width > requested_width,
            total_count,
            buckets,
        })
    })
}

fn timeline_filter(
    normalized_level: &Option<String>,
    service: Option<&str>,
    excluded_template_ids: impl Iterator<Item = u64>,
) -> (String, Vec<Value>) {
    let mut clauses = vec!["1=1".to_string()];
    let mut binds = Vec::new();
    if let Some(level) = normalized_level {
        clauses.push("LOWER(level) = ?".into());
        binds.push(Value::Text(level.clone()));
    }
    if let Some(service) = service {
        clauses.push("service = ?".into());
        binds.push(Value::Text(service.to_string()));
    }
    let excluded_template_ids = excluded_template_ids
        .map(|template_id| {
            i64::try_from(template_id)
                .expect("excluded template ids were validated against signed storage range")
        })
        .collect::<Vec<_>>();
    if !excluded_template_ids.is_empty() {
        clauses.push(format!(
            "template_id NOT IN ({})",
            std::iter::repeat_n("?", excluded_template_ids.len())
                .collect::<Vec<_>>()
                .join(",")
        ));
        binds.extend(excluded_template_ids.into_iter().map(Value::BigInt));
    }
    (clauses.join(" AND "), binds)
}

fn params_ref(values: &[Value]) -> Vec<&dyn duckdb::ToSql> {
    values
        .iter()
        .map(|value| value as &dyn duckdb::ToSql)
        .collect()
}

fn bounded_timeline_width(min_ts: i64, max_ts: i64, requested_width: i64) -> i64 {
    if timeline_axis_bucket_count(min_ts, max_ts, requested_width) <= MAX_ANALYSIS_TIMELINE_BUCKETS
    {
        return requested_width;
    }

    // Find the smallest deterministic width that keeps the entire axis within
    // the cap. i128 arithmetic avoids overflow for mixed i64 extrema.
    let mut low = i128::from(requested_width) + 1;
    let mut high = i128::from(i64::MAX);
    while low < high {
        let mid = low + (high - low) / 2;
        if timeline_axis_bucket_count(min_ts, max_ts, mid as i64) <= MAX_ANALYSIS_TIMELINE_BUCKETS {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low as i64
}

fn timeline_axis_bucket_count(min_ts: i64, max_ts: i64, width: i64) -> usize {
    debug_assert!(width > 0);
    let width = i128::from(width);
    let bucket_start = |timestamp: i64| {
        let timestamp = i128::from(timestamp);
        timestamp - (timestamp % width)
    };
    let first = bucket_start(min_ts);
    let last = bucket_start(max_ts);
    let count = ((last - first) / width) + 1;
    usize::try_from(count).unwrap_or(usize::MAX)
}

fn duck_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Message(format!("duckdb timeline: {error}"))
}

fn tokenize(s: &str) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for t in s.split(|c: char| !c.is_alphanumeric() && c != '*') {
        if t.is_empty() || t == "<*>" {
            continue;
        }
        *m.entry(t.to_lowercase()).or_insert(0) += 1;
    }
    m
}

fn jaccard(a: &HashMap<String, usize>, b: &HashMap<String, usize>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut inter = 0usize;
    let mut union = 0usize;
    let mut keys: HashSet<&String> = a.keys().collect();
    keys.extend(b.keys());
    for k in keys {
        let ca = a.get(k).copied().unwrap_or(0);
        let cb = b.get(k).copied().unwrap_or(0);
        inter += ca.min(cb);
        union += ca.max(cb);
    }
    if union == 0 {
        0.0
    } else {
        inter as f32 / union as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::drain::TemplateInfo;
    use crate::log_analysis::ingest::ingest_path;
    use crate::log_analysis::store::TemplateRow;
    use std::io::Write;
    use std::sync::Arc;

    #[test]
    fn clusters_and_timeline_on_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("x.log")).unwrap();
        for i in 0..200 {
            writeln!(
                f,
                r#"{{"ts":{},"level":"error","service":"api","message":"connection refused {i}"}}"#,
                1000 + i
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"ts":{},"level":"info","service":"api","message":"heartbeat ok"}}"#,
                1000 + i
            )
            .unwrap();
        }
        let report = ingest_path(dir.path(), &logs, "a", None, "x").unwrap();
        let corpus = LogCorpus::open(dir.path(), &report.corpus_id).unwrap();
        let clusters = cluster_problems(&corpus, 10).unwrap();
        assert!(!clusters.is_empty());
        assert!(clusters[0].count >= 1);
        let tl = timeline(&corpus, 50, None, Some("api")).unwrap();
        assert!(!tl.is_empty());
        let total: u64 = tl.iter().map(|b| b.count).sum();
        assert_eq!(total, corpus.event_count() as u64);
    }

    #[test]
    fn cluster_candidates_are_bounded_and_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "bounded clustering").unwrap();
        corpus
            .upsert_templates(
                (1..=2_048)
                    .map(|id| template_row(id, &format!("uniquecomponent{id}"), 3, 100 + id)),
            )
            .unwrap();
        corpus.flush().unwrap();

        // A full TemplateRow decoder would reject this field. The bounded
        // projection deliberately ignores embeddings while retaining ranking
        // scalars and selected template payloads.
        let templates_path = corpus.root().join("templates.json");
        let persisted = std::fs::read_to_string(&templates_path).unwrap();
        assert!(persisted.contains("\"vector\": null"));
        std::fs::write(
            &templates_path,
            persisted.replace(
                "\"vector\": null",
                "\"vector\": {\"must_not_deserialize\": true}",
            ),
        )
        .unwrap();

        let first = cluster_problems(&corpus, 1_000).unwrap();
        let mut persisted_rows: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&templates_path).unwrap()).unwrap();
        persisted_rows.reverse();
        std::fs::write(
            &templates_path,
            serde_json::to_vec_pretty(&persisted_rows).unwrap(),
        )
        .unwrap();
        let second = cluster_problems(&corpus, 1_000).unwrap();
        assert_eq!(first.len(), MAX_CLUSTER_TEMPLATE_CANDIDATES);
        let selected_ids: HashSet<_> = first.iter().map(|cluster| cluster.cluster_id).collect();
        assert_eq!(
            selected_ids,
            (1_537..=2_048).collect(),
            "the cap must retain the 512 highest-impact templates exactly"
        );
        assert!(first.iter().all(|cluster| {
            cluster.partial
                && cluster.templates_considered == MAX_CLUSTER_TEMPLATE_CANDIDATES
                && cluster.templates_available == 2_048
        }));
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap(),
            "candidate and cluster ordering must not depend on sidecar row order"
        );
    }

    #[test]
    fn high_cardinality_exclusions_preserve_bounded_order_and_scope_honesty() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "bounded exclusions").unwrap();
        corpus
            .upsert_templates(
                (1..=2_000).map(|id| template_row(id, &format!("isolatedpattern{id}"), 3, 10 + id)),
            )
            .unwrap();
        corpus.flush().unwrap();

        let mut excluded = (1_980..=2_000).collect::<Vec<_>>();
        excluded.extend([1, 1]);
        let clusters = cluster_problems_with_excluded_templates(&corpus, 1_000, &excluded).unwrap();
        let selected_ids = clusters
            .iter()
            .flat_map(|cluster| cluster.template_ids.iter().copied())
            .collect::<HashSet<_>>();
        assert_eq!(selected_ids, (1_468..=1_979).collect());
        assert_eq!(selected_ids.len(), MAX_CLUSTER_TEMPLATE_CANDIDATES);
        assert!(selected_ids.is_disjoint(&excluded.into_iter().collect()));
        assert!(clusters.iter().all(|cluster| {
            cluster.partial
                && cluster.templates_available == 1_978
                && cluster.templates_considered == MAX_CLUSTER_TEMPLATE_CANDIDATES
        }));
    }

    #[test]
    fn sidecar_reader_interrupts_during_a_real_read_sequence() {
        struct CancelAfterFirstRead {
            bytes: std::io::Cursor<Vec<u8>>,
            cancel: Arc<AtomicBool>,
            reads: usize,
        }

        impl Read for CancelAfterFirstRead {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let read = self.bytes.read(buffer)?;
                self.reads += 1;
                if self.reads == 1 {
                    self.cancel.store(true, AtomicOrdering::SeqCst);
                }
                Ok(read)
            }
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let source = CancelAfterFirstRead {
            bytes: std::io::Cursor::new(vec![b'x'; 32]),
            cancel: Arc::clone(&cancel),
            reads: 0,
        };
        let mut reader = CancelReader {
            inner: source,
            cancel: Some(cancel.as_ref()),
        };
        let mut buffer = [0_u8; 8];
        assert_eq!(reader.read(&mut buffer).unwrap(), buffer.len());
        let error = reader.read(&mut buffer).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert!(error.to_string().contains("triage cancelled"));
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_scans_stay_on_one_open_snapshot_across_path_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("templates.json");
        let original =
            serde_json::to_vec(&vec![template_row(7, "original pattern", 4, 9)]).unwrap();
        std::fs::write(&path, &original).unwrap();
        let mut opened = File::open(&path).unwrap();
        let digest = template_sidecar_digest(&mut opened, None).unwrap();

        std::fs::rename(&path, dir.path().join("original-retained.json")).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&vec![template_row(99, "replacement pattern", 1, 1)]).unwrap(),
        )
        .unwrap();

        let scan = scan_template_ranks(&mut opened, &BTreeSet::new(), None).unwrap();
        let selected = select_cluster_candidate_ranks(scan);
        assert_eq!(
            selected
                .iter()
                .map(|rank| rank.template_id)
                .collect::<Vec<_>>(),
            vec![7]
        );
        assert_eq!(template_sidecar_digest(&mut opened, None).unwrap(), digest);
    }

    #[test]
    fn exact_template_exclusions_remove_clusters_deterministically() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "suppressed clustering").unwrap();
        corpus
            .upsert_templates([
                template_row(1, "routine heartbeat ok", 1, 50),
                template_row(2, "database connection failed", 4, 3),
            ])
            .unwrap();

        let baseline = cluster_problems(&corpus, 10).unwrap();
        let explicit_empty = cluster_problems_with_excluded_templates(&corpus, 10, &[]).unwrap();
        assert_eq!(
            serde_json::to_value(&baseline).unwrap(),
            serde_json::to_value(&explicit_empty).unwrap(),
            "the compatibility wrapper must preserve empty-lens behavior"
        );
        assert!(baseline
            .iter()
            .any(|cluster| cluster.template_ids.contains(&1)));

        let hidden_once = cluster_problems_with_excluded_templates(&corpus, 10, &[1]).unwrap();
        let hidden_with_duplicates =
            cluster_problems_with_excluded_templates(&corpus, 10, &[1, 1]).unwrap();
        assert_eq!(
            serde_json::to_value(&hidden_once).unwrap(),
            serde_json::to_value(&hidden_with_duplicates).unwrap()
        );
        assert!(hidden_once
            .iter()
            .all(|cluster| !cluster.template_ids.contains(&1)));
        assert!(hidden_once
            .iter()
            .all(|cluster| cluster.templates_available == 1));
    }

    #[test]
    fn rare_severe_template_survives_repetitive_error_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "rare severe").unwrap();
        let mut templates: Vec<_> = (1..=700)
            .map(|id| {
                template_row(
                    id,
                    &format!("connection refused shard <*> retry <*> group-{}", id % 3),
                    4,
                    50_000 + id,
                )
            })
            .collect();
        templates.push(template_row(
            9_999,
            "kernel panic unrecoverable allocator corruption",
            5,
            1,
        ));
        corpus.upsert_templates(templates).unwrap();
        corpus.flush().unwrap();

        let clusters = cluster_problems(&corpus, 10).unwrap();
        assert!(
            clusters
                .iter()
                .any(|cluster| cluster.template_ids.contains(&9_999)),
            "the reserved rare-severe candidate must remain visible"
        );
        let repetitive = clusters
            .iter()
            .find(|cluster| !cluster.template_ids.contains(&9_999))
            .expect("the repetitive error cluster remains represented");
        let expected_repetitive_count: u64 = (190..=700).map(|id| 50_000 + id).sum();
        assert_eq!(
            repetitive.count, expected_repetitive_count,
            "candidate-only count must be exact for the 511 considered repetitive templates"
        );
        assert_eq!(repetitive.template_ids.len(), 511);
        assert!(repetitive.partial);
        assert_eq!(repetitive.templates_considered, 512);
        assert_eq!(repetitive.templates_available, 701);
    }

    #[test]
    fn clustering_uses_persisted_template_examples_without_event_rows() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "template exemplars").unwrap();
        corpus
            .upsert_templates([template_row(7, "database timeout <*>", 4, 17)])
            .unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch("DROP TABLE events")
                    .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let clusters = cluster_problems(&corpus, 5).unwrap();
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].count, 17);
        assert_eq!(
            clusters[0].exemplars,
            vec!["redacted example for template 7"]
        );
    }

    #[test]
    fn cluster_summary_deserializes_pre_scope_metadata() {
        let summary: ClusterSummary = serde_json::from_value(serde_json::json!({
            "cluster_id": 7,
            "template_ids": [7],
            "label": "database timeout <*>",
            "count": 17,
            "severity": 4,
            "score": 9.5,
            "exemplars": ["database timeout after redaction"]
        }))
        .unwrap();

        assert!(!summary.partial);
        assert_eq!(summary.templates_considered, 0);
        assert_eq!(summary.templates_available, 0);
    }

    #[test]
    fn timeline_aggregates_scale_shaped_rows_with_filters() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "timeline scale").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    )
                    SELECT i + 1,
                           1700000000 + (i % 1000),
                           CASE WHEN i % 10 = 0 THEN 'error' ELSE 'info' END,
                           CASE WHEN i % 2 = 0 THEN 'api' ELSE 'worker' END,
                           'host-01',
                           (i % 25) + 1,
                           '[]',
                           NULL,
                           'bounded synthetic event',
                           'scale.log'
                    FROM range(250000) AS generated(i)
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let all = timeline_summary(&corpus, 100, None, None).unwrap();
        assert_eq!(all.requested_width, 100);
        assert_eq!(all.effective_width, 100);
        assert!(!all.coarsened);
        assert_eq!(all.total_count, 250_000);
        assert_eq!(all.buckets.len(), 10);
        assert_eq!(
            all.buckets.iter().map(|bucket| bucket.count).sum::<u64>(),
            250_000
        );
        assert!(all
            .buckets
            .windows(2)
            .all(|pair| pair[0].start < pair[1].start));

        let api_errors = timeline_summary(&corpus, 100, Some("ERROR"), Some("api")).unwrap();
        assert!(!api_errors.coarsened);
        assert_eq!(api_errors.total_count, 25_000);
        assert_eq!(
            api_errors
                .buckets
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            25_000
        );
        assert!(api_errors.buckets.iter().all(|bucket| {
            bucket.by_level.len() == 1
                && bucket.by_level.get("error").copied() == Some(bucket.count)
        }));
        assert!(timeline(&corpus, 100, Some("error"), Some("worker"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn exact_template_exclusions_apply_to_analysis_timeline() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "suppressed timeline").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    ) VALUES
                        (1, 100, 'info', 'api', NULL, 1, '[]', NULL, 'heartbeat', 'x.log'),
                        (2, 101, 'error', 'api', NULL, 2, '[]', NULL, 'failed', 'x.log'),
                        (3, 102, 'error', 'api', NULL, 2, '[]', NULL, 'failed', 'x.log')
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let baseline = timeline_summary(&corpus, 10, None, None).unwrap();
        let explicit_empty =
            timeline_summary_with_excluded_templates(&corpus, 10, None, None, &[]).unwrap();
        assert_eq!(
            serde_json::to_value(&baseline).unwrap(),
            serde_json::to_value(&explicit_empty).unwrap()
        );
        assert_eq!(baseline.total_count, 3);

        let hidden_once =
            timeline_summary_with_excluded_templates(&corpus, 10, None, None, &[2]).unwrap();
        let hidden_with_duplicates =
            timeline_summary_with_excluded_templates(&corpus, 10, None, None, &[2, 2]).unwrap();
        assert_eq!(
            serde_json::to_value(&hidden_once).unwrap(),
            serde_json::to_value(&hidden_with_duplicates).unwrap()
        );
        assert_eq!(hidden_once.total_count, 1);
        assert_eq!(
            hidden_once
                .buckets
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            1
        );
        assert!(hidden_once
            .buckets
            .iter()
            .all(|bucket| !bucket.by_level.contains_key("error")));
    }

    #[test]
    fn analysis_rejects_over_bound_exclusion_input() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "suppression bound").unwrap();
        let too_many = (0..=super::super::search::MAX_ANALYSIS_EXCLUDED_TEMPLATE_IDS as u64)
            .collect::<Vec<_>>();

        let cluster_error =
            cluster_problems_with_excluded_templates(&corpus, 10, &too_many).unwrap_err();
        let timeline_error =
            timeline_summary_with_excluded_templates(&corpus, 10, None, None, &too_many)
                .unwrap_err();
        assert!(
            cluster_error.to_string().contains("exceeds maximum 256"),
            "{cluster_error}"
        );
        assert!(
            timeline_error.to_string().contains("exceeds maximum 256"),
            "{timeline_error}"
        );
    }

    #[test]
    fn timeline_rejects_template_ids_outside_signed_storage_range() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "suppression storage range").unwrap();
        let error = timeline_summary_with_excluded_templates(&corpus, 10, None, None, &[u64::MAX])
            .unwrap_err();

        assert!(
            error.to_string().contains("exceeds signed storage range"),
            "{error}"
        );
    }

    #[test]
    fn timeline_coarsens_250k_unique_timestamps_to_fixed_bound() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "unique timeline").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    )
                    SELECT i + 1,
                           i,
                           CASE WHEN i % 10 = 0 THEN 'error' ELSE 'info' END,
                           'api',
                           'host-01',
                           (i % 25) + 1,
                           '[]',
                           NULL,
                           'unique timestamp event',
                           'unique.log'
                    FROM range(250000) AS generated(i)
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let summary = timeline_summary(&corpus, 1, None, None).unwrap();
        assert_eq!(summary.requested_width, 1);
        assert_eq!(summary.effective_width, 489);
        assert!(summary.coarsened);
        assert_eq!(summary.total_count, 250_000);
        assert_eq!(summary.buckets.len(), MAX_ANALYSIS_TIMELINE_BUCKETS);
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            250_000
        );
        assert!(summary
            .buckets
            .windows(2)
            .all(|pair| pair[0].start < pair[1].start));
    }

    #[test]
    fn timeline_preserves_truncating_bucket_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "negative timeline").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    ) VALUES
                        (1, -3, 'warn', 'api', NULL, 1, '[]', NULL, 'a', 'x.log'),
                        (2, -2, 'error', 'api', NULL, 2, '[]', NULL, 'b', 'x.log'),
                        (3,  3, 'info', 'api', NULL, 3, '[]', NULL, 'c', 'x.log')
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let summary = timeline_summary(&corpus, 2, None, None).unwrap();
        assert_eq!(summary.requested_width, 2);
        assert_eq!(summary.effective_width, 2);
        assert!(!summary.coarsened);
        assert_eq!(summary.total_count, 3);
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| (bucket.start, bucket.count))
                .collect::<Vec<_>>(),
            vec![(-2, 2), (2, 1)]
        );
    }

    fn template_row(id: u64, pattern: &str, severity: u8, count: u64) -> TemplateRow {
        TemplateRow {
            info: TemplateInfo {
                template_id: id,
                pattern: pattern.to_string(),
                token_count: pattern.split_whitespace().count(),
                count,
                first_seen: 1_700_000_000,
                last_seen: 1_700_000_100,
                severity,
                example: format!("redacted example for template {id}"),
            },
            content_hash: format!("hash-{id}"),
            vector: None,
        }
    }
}
