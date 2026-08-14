//! Case builder and suite generation for the retrieval-ablation lab.
//!
//! Child module of `retrieval_ablation.rs`. Case CONTENT lives in
//! `retrieval_ablation_case_defs_a.rs` / `_b.rs`; this file owns the
//! deterministic emission machinery and the suite-level generate entry.
//!
//! Emission model: every record is buffered as a `(sort_ts, seq, bytes)`
//! block per file and files are rendered in `(sort_ts, seq)` order at finish,
//! so case specs can weave truth records into the middle of noise windows
//! while each rendered file stays chronologically ordered.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};

#[path = "retrieval_ablation_case_defs_a.rs"]
mod defs_a;
#[path = "retrieval_ablation_case_defs_b.rs"]
mod defs_b;

// The generator helpers of the grandparent module (`log_lab_generator.rs`).
use super::super::{sha256_bytes, write_json, LabResult};

pub const RA_SUITE_REL_ROOT: &str = "scenarios/retrieval-ablation";

#[derive(Clone, Copy)]
pub struct RaCaseSpec {
    pub case_id: &'static str,
    pub case_version: u32,
    pub title: &'static str,
    pub intended_probe: &'static str,
    /// Case window start, in days after the suite epoch.
    pub day: i64,
    /// Optional cap on the tier noise multiplier for structural cases whose
    /// probe is not volumetric. Disclosed in suite.json.
    pub scale_cap: Option<u64>,
    pub build: fn(&mut RaCaseBuilder),
}

pub fn ra_case_specs() -> Vec<RaCaseSpec> {
    let specs = vec![
        defs_a::RB01,
        defs_a::RB02,
        defs_a::RB03,
        defs_a::RB04,
        defs_a::RB05,
        defs_a::RB06,
        defs_a::RB07,
        defs_a::RB08,
        defs_a::RB09,
        defs_a::RB10,
        defs_b::RB11,
        defs_b::RB12,
        defs_b::RB13,
        defs_b::RB14,
        defs_b::RB15,
        defs_b::RB16,
        defs_b::RB17,
        defs_b::RB18,
        defs_b::RB19,
        defs_b::RB20,
    ];
    assert_eq!(
        specs.len(),
        RA_CASE_COUNT,
        "retrieval-ablation case roster drifted"
    );
    specs
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RaFormat {
    Jsonl,
    Logfmt,
    /// `2025-02-19T21:20:00.000Z LEVEL message` with untimestamped
    /// continuation lines allowed (production framing attaches them).
    Plain,
}

pub fn ra_iso_utc(ts: i64, millis: u32) -> String {
    let datetime = chrono::DateTime::from_timestamp(ts, 0).expect("valid lab epoch");
    format!("{}.{millis:03}Z", datetime.format("%Y-%m-%dT%H:%M:%S"))
}

// ---------------------------------------------------------------------------
// Internal file / group state
// ---------------------------------------------------------------------------

struct RaFileState {
    format: RaFormat,
    service: String,
    host: String,
    /// (sort_ts, insertion seq, rendered block bytes)
    blocks: Vec<(i64, u64, Vec<u8>)>,
    next_seq: u64,
    records: u64,
    level_counts: BTreeMap<String, u64>,
    excluded: bool,
    raw: Option<Vec<u8>>,
    zip_mirrored_into: Option<String>,
}

impl RaFileState {
    fn rendered(&self) -> Vec<u8> {
        if let Some(raw) = &self.raw {
            return raw.clone();
        }
        let mut ordered: Vec<&(i64, u64, Vec<u8>)> = self.blocks.iter().collect();
        ordered.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut bytes = Vec::new();
        for (_, _, block) in ordered {
            bytes.extend_from_slice(block);
        }
        bytes
    }
}

#[derive(Debug, Default, Clone)]
struct RaGroupContribution {
    token_records: u64,
    raw_records: u64,
    occurrences: u64,
}

struct RaGroupDraft {
    group_id: String,
    token: String,
    role: RaRole,
    incident_id: Option<String>,
    timestamp_certainty: String,
    ts: i64,
    notes: String,
    per_source: BTreeMap<String, RaGroupContribution>,
    occurrence_override: Option<u64>,
}

/// Handle to an evidence group under construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RaGroupHandle(usize);

pub struct RaCaseBuilder {
    spec: RaCaseSpec,
    tier: RaTier,
    seed: u64,
    /// Case window start (suite epoch + day offset).
    pub epoch: i64,
    pub rng: RaRng,
    files: Vec<(String, RaFileState)>,
    groups: Vec<RaGroupDraft>,
    incidents: Vec<RaIncident>,
    queries: Vec<RaQuery>,
    relevance: BTreeMap<String, RaQueryTruth>,
    required_claims: Vec<String>,
    forbidden_claims: Vec<String>,
    competing_explanations: Vec<String>,
    permitted_uncertainty: Vec<String>,
    secret_tokens: Vec<String>,
    exclusions: Vec<RaExclusion>,
    known_counts: RaKnownCounts,
    time_quality: String,
    expectation: Option<RaBaselineExpectation>,
}

impl RaCaseBuilder {
    fn new(spec: RaCaseSpec, tier: RaTier, seed: u64, suite_epoch: i64) -> Self {
        Self {
            tier,
            seed,
            epoch: suite_epoch + spec.day * 86_400,
            rng: RaRng::for_case(seed, spec.case_id),
            files: Vec::new(),
            groups: Vec::new(),
            incidents: Vec::new(),
            queries: Vec::new(),
            relevance: BTreeMap::new(),
            required_claims: Vec::new(),
            forbidden_claims: Vec::new(),
            competing_explanations: Vec::new(),
            permitted_uncertainty: Vec::new(),
            secret_tokens: Vec::new(),
            exclusions: Vec::new(),
            known_counts: RaKnownCounts {
                corpus_completeness: "complete".into(),
                total_events_known: true,
                known_missing_references: 0,
            },
            time_quality: "wall".into(),
            expectation: None,
            spec,
        }
    }

    pub fn case_id(&self) -> &'static str {
        self.spec.case_id
    }

    /// Tier-scaled noise count for this case (multiplier bounded by the
    /// case's disclosed scale cap).
    pub fn scaled(&self, count_small: u64) -> u64 {
        let cap = self.spec.scale_cap.unwrap_or(u64::MAX);
        count_small * self.tier.noise_multiplier().min(cap)
    }

    // -- sources ------------------------------------------------------------

    pub fn source(&mut self, path: &str, service: &str, host: &str, format: RaFormat) {
        assert!(
            !self.files.iter().any(|(existing, _)| existing == path),
            "duplicate source path {path}"
        );
        assert!(
            !path.split('/').any(|segment| segment == "logs"),
            "directory name `logs/` is git-ignored repo-wide; pick another name"
        );
        self.files.push((
            path.to_string(),
            RaFileState {
                format,
                service: service.to_string(),
                host: host.to_string(),
                blocks: Vec::new(),
                next_seq: 0,
                records: 0,
                level_counts: BTreeMap::new(),
                excluded: false,
                raw: None,
                zip_mirrored_into: None,
            },
        ));
    }

    /// Register a file with arbitrary raw bytes (malformed / binary / markup
    /// content). `expected_records` counts records the production importer is
    /// expected to keep; `severity_counts` states their expected levels; pass
    /// `excluded = true` when the whole file should be rejected as
    /// unsupported input.
    pub fn raw_source(
        &mut self,
        path: &str,
        bytes: Vec<u8>,
        expected_records: u64,
        severity_counts: &[(&str, u64)],
        excluded: bool,
    ) {
        assert!(
            !self.files.iter().any(|(existing, _)| existing == path),
            "duplicate source path {path}"
        );
        let mut level_counts = BTreeMap::new();
        for (level, count) in severity_counts {
            *level_counts.entry(level.to_string()).or_default() += count;
        }
        assert_eq!(
            level_counts.values().sum::<u64>(),
            expected_records,
            "{path}: severity counts must sum to expected records"
        );
        self.files.push((
            path.to_string(),
            RaFileState {
                format: RaFormat::Plain,
                service: String::new(),
                host: String::new(),
                blocks: Vec::new(),
                next_seq: 0,
                records: expected_records,
                level_counts,
                excluded,
                raw: Some(bytes),
                zip_mirrored_into: None,
            },
        ));
    }

    fn state_mut(&mut self, path: &str) -> &mut RaFileState {
        let index = self
            .files
            .iter()
            .position(|(existing, _)| existing == path)
            .unwrap_or_else(|| panic!("unknown source path {path}"));
        &mut self.files[index].1
    }

    fn push_block(&mut self, path: &str, sort_ts: i64, level: &str, block: Vec<u8>) {
        let state = self.state_mut(path);
        assert!(
            state.raw.is_none(),
            "{path}: raw sources take no emitted records"
        );
        let seq = state.next_seq;
        state.next_seq += 1;
        state.blocks.push((sort_ts, seq, block));
        state.records += 1;
        *state.level_counts.entry(level.to_string()).or_default() += 1;
    }

    // -- record emission ----------------------------------------------------

    fn render_line(
        &mut self,
        path: &str,
        ts: i64,
        level: &str,
        trace_id: &str,
        message: &str,
    ) -> Vec<u8> {
        let state = self.state_mut(path);
        let line = match state.format {
            RaFormat::Jsonl => {
                super::super::json_line(ts, level, &state.service, &state.host, trace_id, message)
            }
            RaFormat::Logfmt => {
                super::super::logfmt(ts, level, &state.service, &state.host, trace_id, message)
            }
            RaFormat::Plain => format!(
                "{} {} {message}",
                ra_iso_utc(ts, 0),
                level.to_ascii_uppercase()
            ),
        };
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        bytes
    }

    /// Emit one single-line record at `at_rel` seconds after the case epoch.
    pub fn emit(&mut self, path: &str, at_rel: i64, level: &str, message: &str) {
        let trace = format!("trace-{:08x}", fnv1a64(message.as_bytes()) & 0xFFFF_FFFF);
        self.emit_traced(path, at_rel, level, &trace, message);
    }

    /// Emit one record with an explicit trace id.
    pub fn emit_traced(
        &mut self,
        path: &str,
        at_rel: i64,
        level: &str,
        trace_id: &str,
        message: &str,
    ) {
        let ts = self.epoch + at_rel;
        let block = self.render_line(path, ts, level, trace_id, message);
        self.push_block(path, ts, level, block);
    }

    /// Emit a raw pre-rendered line as one record (special timestamp
    /// encodings). `at_rel` positions the record within the file; `level` is
    /// used for expected severity accounting only.
    pub fn emit_raw_record(&mut self, path: &str, at_rel: i64, level: &str, line: &str) {
        let ts = self.epoch + at_rel;
        let mut block = line.as_bytes().to_vec();
        block.push(b'\n');
        self.push_block(path, ts, level, block);
    }

    /// Emit a multi-line exception: a timestamped lead line plus indented
    /// continuation frames. Production framing attaches the continuations, so
    /// this counts as ONE record. Frame lines must stay free of dotted
    /// `alpha.alpha` tokens (the frozen safety scan treats those as public
    /// hostnames); use slash paths like `at charge in checkout/service.go:42`.
    pub fn emit_exception(
        &mut self,
        path: &str,
        at_rel: i64,
        level: &str,
        lead: &str,
        frames: &[String],
    ) {
        let ts = self.epoch + at_rel;
        {
            let state = self.state_mut(path);
            assert!(
                state.format == RaFormat::Plain,
                "exceptions need the plain format"
            );
        }
        let mut block = format!(
            "{} {} {lead}\n",
            ra_iso_utc(ts, 0),
            level.to_ascii_uppercase()
        )
        .into_bytes();
        for frame in frames {
            block.extend_from_slice(b"    ");
            block.extend_from_slice(frame.as_bytes());
            block.push(b'\n');
        }
        self.push_block(path, ts, level, block);
    }

    /// Emit stderr-wrapped rendering records: every line carries its own
    /// timestamp, so each is a separate record.
    pub fn emit_stderr_wrapped(&mut self, path: &str, at_rel: i64, level: &str, lines: &[String]) {
        let ts = self.epoch + at_rel;
        {
            let state = self.state_mut(path);
            assert!(
                state.format == RaFormat::Plain,
                "stderr wrapping needs plain format"
            );
        }
        for (index, line) in lines.iter().enumerate() {
            let millis = (index % 1000) as u32;
            let rendered = format!(
                "{} {} [stderr] {line}\n",
                ra_iso_utc(ts, millis),
                level.to_ascii_uppercase()
            );
            self.push_block(path, ts, level, rendered.into_bytes());
        }
    }

    /// Deterministically spread `count_small` (tier-scaled) noise records
    /// over `[from_rel, to_rel)`. The family closure receives a per-record
    /// fork of the neutral RNG and the noise index.
    pub fn noise(
        &mut self,
        path: &str,
        from_rel: i64,
        to_rel: i64,
        count_small: u64,
        family: &mut dyn FnMut(&mut RaRng, u64) -> (&'static str, String),
    ) {
        let count = self.scaled(count_small);
        assert!(to_rel > from_rel && count > 0);
        let span = (to_rel - from_rel) as u64;
        for index in 0..count {
            let at_rel = from_rel + ((index.saturating_mul(span)) / count) as i64;
            let mut fork = RaRng::new(self.rng.next_u64());
            let (level, message) = family(&mut fork, index);
            self.emit(path, at_rel, level, &message);
        }
    }

    // -- evidence groups ----------------------------------------------------

    /// Register an evidence group. `token` must be a unique model-visible
    /// substring; uniqueness (including substring collisions) is verified at
    /// finish.
    #[allow(clippy::too_many_arguments)]
    pub fn group(
        &mut self,
        local_id: &str,
        role: RaRole,
        incident_local: Option<&str>,
        token: String,
        timestamp_certainty: &str,
        ts_rel: i64,
        notes: &str,
    ) -> RaGroupHandle {
        let group_id = format!("{}-{local_id}", self.spec.case_id);
        assert!(
            !self.groups.iter().any(|g| g.group_id == group_id),
            "duplicate group {group_id}"
        );
        self.groups.push(RaGroupDraft {
            group_id,
            token,
            role,
            incident_id: incident_local.map(|local| format!("{}-{local}", self.spec.case_id)),
            timestamp_certainty: timestamp_certainty.into(),
            ts: self.epoch + ts_rel,
            notes: notes.into(),
            per_source: BTreeMap::new(),
            occurrence_override: None,
        });
        RaGroupHandle(self.groups.len() - 1)
    }

    fn credit(
        &mut self,
        handle: RaGroupHandle,
        path: &str,
        token_records: u64,
        raw_records: u64,
        occurrences: u64,
    ) {
        let entry = self.groups[handle.0]
            .per_source
            .entry(path.to_string())
            .or_default();
        entry.token_records += token_records;
        entry.raw_records += raw_records;
        entry.occurrences += occurrences;
    }

    /// Emit a single-line record that belongs to a group. The message MUST
    /// contain the group token (asserted).
    pub fn gevent(
        &mut self,
        handle: RaGroupHandle,
        path: &str,
        at_rel: i64,
        level: &str,
        message: &str,
    ) {
        assert!(
            message.contains(&self.groups[handle.0].token),
            "group record must carry its token"
        );
        self.emit(path, at_rel, level, message);
        self.credit(handle, path, 1, 1, 1);
    }

    /// Emit a raw pre-rendered group record (special encodings).
    pub fn gevent_raw(
        &mut self,
        handle: RaGroupHandle,
        path: &str,
        at_rel: i64,
        level: &str,
        line: &str,
    ) {
        assert!(
            line.contains(&self.groups[handle.0].token),
            "group record must carry its token"
        );
        self.emit_raw_record(path, at_rel, level, line);
        self.credit(handle, path, 1, 1, 1);
    }

    /// Emit a multi-line exception lead for a group (one record, one
    /// occurrence, token in the lead line).
    #[allow(clippy::too_many_arguments)]
    pub fn gexception(
        &mut self,
        handle: RaGroupHandle,
        path: &str,
        at_rel: i64,
        level: &str,
        lead: &str,
        frames: &[String],
    ) {
        assert!(
            lead.contains(&self.groups[handle.0].token),
            "exception lead must carry the group token"
        );
        self.emit_exception(path, at_rel, level, lead, frames);
        self.credit(handle, path, 1, 1, 1);
    }

    /// Emit stderr-wrapped supporting records for a group. Lines carrying the
    /// token count as token records; all lines count as raw records. Adds NO
    /// occurrences — wrapped renderings duplicate an existing occurrence.
    pub fn gstderr_wrapped(
        &mut self,
        handle: RaGroupHandle,
        path: &str,
        at_rel: i64,
        level: &str,
        lines: &[String],
    ) {
        let token = self.groups[handle.0].token.clone();
        self.emit_stderr_wrapped(path, at_rel, level, lines);
        let token_lines = lines.iter().filter(|line| line.contains(&token)).count() as u64;
        self.credit(handle, path, token_lines, lines.len() as u64, 0);
    }

    /// Override the total occurrence count when renderings duplicate
    /// occurrences (applies before any ZIP mirroring doubling).
    pub fn set_occurrences(&mut self, handle: RaGroupHandle, occurrences: u64) {
        self.groups[handle.0].occurrence_override = Some(occurrences);
    }

    // -- incidents / queries / claims ----------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn incident(
        &mut self,
        local_id: &str,
        summary: &str,
        root_cause_status: &str,
        trigger_groups: &[RaGroupHandle],
        window_from_rel: i64,
        window_to_rel: i64,
    ) -> String {
        let incident_id = format!("{}-{local_id}", self.spec.case_id);
        let trigger_group_ids = trigger_groups
            .iter()
            .map(|handle| self.groups[handle.0].group_id.clone())
            .collect();
        self.incidents.push(RaIncident {
            incident_id: incident_id.clone(),
            summary: summary.into(),
            root_cause_status: root_cause_status.into(),
            trigger_group_ids,
            window_from_ts: self.epoch + window_from_rel,
            window_to_ts: self.epoch + window_to_rel,
        });
        incident_id
    }

    /// Register a query plus its evaluator-side relevance truth.
    #[allow(clippy::too_many_arguments)]
    pub fn query(
        &mut self,
        query_id: &str,
        kind: &str,
        question: &str,
        plan: RaKeywordPlan,
        answerable: bool,
        relevant: &[(RaGroupHandle, u8)],
        contaminating: &[RaGroupHandle],
    ) {
        let full_id = format!("{}-{query_id}", self.spec.case_id);
        assert!(
            !self.queries.iter().any(|query| query.query_id == full_id),
            "duplicate query {full_id}"
        );
        self.queries.push(RaQuery {
            query_id: full_id.clone(),
            kind: kind.into(),
            question: question.into(),
            keyword_plan: plan,
        });
        self.relevance.insert(
            full_id,
            RaQueryTruth {
                answerable,
                relevant: relevant
                    .iter()
                    .map(|(handle, gain)| RaRelevantGroup {
                        group_id: self.groups[handle.0].group_id.clone(),
                        gain: *gain,
                    })
                    .collect(),
                contaminating_groups: contaminating
                    .iter()
                    .map(|handle| self.groups[handle.0].group_id.clone())
                    .collect(),
            },
        );
    }

    pub fn claims(
        &mut self,
        required: &[&str],
        forbidden: &[&str],
        competing: &[&str],
        permitted_uncertainty: &[&str],
    ) {
        self.required_claims = required.iter().map(|s| s.to_string()).collect();
        self.forbidden_claims = forbidden.iter().map(|s| s.to_string()).collect();
        self.competing_explanations = competing.iter().map(|s| s.to_string()).collect();
        self.permitted_uncertainty = permitted_uncertainty
            .iter()
            .map(|s| s.to_string())
            .collect();
    }

    pub fn secret(&mut self, value: String) {
        self.secret_tokens.push(value);
    }

    pub fn exclude(&mut self, token: &str, reason: &str) {
        self.exclusions.push(RaExclusion {
            token: token.into(),
            reason: reason.into(),
        });
    }

    pub fn partial_corpus(&mut self, known_missing_references: u64) {
        self.known_counts = RaKnownCounts {
            corpus_completeness: "partial_lower_bound".into(),
            total_events_known: false,
            known_missing_references,
        };
    }

    pub fn mixed_time_quality(&mut self) {
        self.time_quality = "mixed".into();
    }

    pub fn expect_pass(&mut self, min_recall_at_25: f64, max_decoy_share_at_25: f64) {
        self.expectation = Some(RaBaselineExpectation {
            class: "pass".into(),
            gates: RaBaselineGates {
                min_recall_at_25: Some(min_recall_at_25),
                max_decoy_share_at_25: Some(max_decoy_share_at_25),
                queries_expected_below_floor: Vec::new(),
            },
            limitation_reason: None,
        });
    }

    pub fn expect_limitation(
        &mut self,
        reason: &str,
        below_floor_query_ids: &[&str],
        min_recall_at_25: Option<f64>,
        max_decoy_share_at_25: Option<f64>,
    ) {
        self.expectation = Some(RaBaselineExpectation {
            class: "limitation".into(),
            gates: RaBaselineGates {
                min_recall_at_25,
                max_decoy_share_at_25,
                queries_expected_below_floor: below_floor_query_ids
                    .iter()
                    .map(|id| format!("{}-{id}", self.spec.case_id))
                    .collect(),
            },
            limitation_reason: Some(reason.into()),
        });
    }

    /// Mirror the listed already-emitted sources into a deterministic ZIP
    /// under `import/` so archive and folder ingestion of identical content
    /// can be compared inside one corpus. Group counts contributed by the
    /// mirrored files are doubled under the archive-member identity at
    /// finish. Call after all content for the members is emitted.
    pub fn zip_mirror(&mut self, zip_rel_path: &str, members: &[&str]) {
        let mut rendered_members = Vec::new();
        for member in members {
            let state = self
                .files
                .iter()
                .find(|(path, _)| path == member)
                .unwrap_or_else(|| panic!("zip member {member} not emitted yet"));
            rendered_members.push((member.to_string(), state.1.rendered()));
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let time = zip::DateTime::from_date_and_time(2025, 1, 1, 0, 0, 0)
                .expect("fixed zip timestamp");
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .last_modified_time(time)
                .unix_permissions(0o644);
            let mut ordered = rendered_members.clone();
            ordered.sort_by(|a, b| a.0.cmp(&b.0));
            for (name, bytes) in &ordered {
                zip.start_file(name, options).expect("zip entry");
                std::io::Write::write_all(&mut zip, bytes).expect("zip bytes");
            }
            zip.finish().expect("zip finish");
        }
        let zip_bytes = cursor.into_inner();
        for member in members {
            let index = self
                .files
                .iter()
                .position(|(path, _)| path == member)
                .expect("member present");
            self.files[index].1.zip_mirrored_into = Some(zip_rel_path.to_string());
        }
        self.files.push((
            zip_rel_path.to_string(),
            RaFileState {
                format: RaFormat::Plain,
                service: String::new(),
                host: String::new(),
                blocks: Vec::new(),
                next_seq: 0,
                records: 0,
                level_counts: BTreeMap::new(),
                excluded: false,
                raw: Some(zip_bytes),
                zip_mirrored_into: None,
            },
        ));
    }

    // -- finish ---------------------------------------------------------------

    fn finish(mut self, case_root: &Path) -> LabResult<(RaTruthManifest, RaQuerySet)> {
        let expectation = self
            .expectation
            .take()
            .unwrap_or_else(|| panic!("{}: baseline expectation not set", self.spec.case_id));
        assert!(
            self.queries.len() >= 7,
            "{}: every case needs its full query set",
            self.spec.case_id
        );

        // Token uniqueness including substring collisions: a token contained
        // in another group's token would corrupt containment matching.
        for (index, group) in self.groups.iter().enumerate() {
            assert!(!group.token.is_empty(), "empty token in {}", group.group_id);
            for (other_index, other) in self.groups.iter().enumerate() {
                if index != other_index {
                    assert!(
                        !other.token.contains(&group.token),
                        "token {} is a substring of {}; containment matching would collide",
                        group.token,
                        other.token
                    );
                }
            }
        }

        // Materialise files.
        let import_root = case_root.join("import");
        let mut rendered: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for (path, state) in &self.files {
            rendered.insert(path.clone(), state.rendered());
        }
        for (path, bytes) in &rendered {
            let disk_path = import_root.join(path);
            if let Some(parent) = disk_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&disk_path, bytes)?;
        }

        // Expectation accounting. Zip members are accounted under their
        // archive identities; the mirrored folder copies stay first-class.
        let mut files_by_path = BTreeMap::new();
        let mut sources = BTreeMap::new();
        let mut severities: BTreeMap<String, u64> = BTreeMap::new();
        let mut excluded_files = Vec::new();
        let mut total_bytes = 0u64;
        let mut total_events = 0u64;
        for (path, state) in &self.files {
            if state.excluded {
                excluded_files.push(path.clone());
                continue;
            }
            let bytes = &rendered[path];
            if path.ends_with(".zip") {
                let reader = std::io::Cursor::new(bytes.clone());
                let mut archive = zip::ZipArchive::new(reader)?;
                for index in 0..archive.len() {
                    let mut entry = archive.by_index(index)?;
                    let mut member_bytes = Vec::new();
                    std::io::Read::read_to_end(&mut entry, &mut member_bytes)?;
                    let member_state = self
                        .files
                        .iter()
                        .find(|(candidate, _)| candidate == entry.name())
                        .map(|(_, s)| s);
                    let member_records = member_state.map(|s| s.records).unwrap_or(0);
                    if let Some(member) = member_state {
                        for (level, count) in &member.level_counts {
                            *severities.entry(level.clone()).or_default() += count;
                        }
                    }
                    let identity = format!("{path}!/{}", entry.name());
                    files_by_path.insert(
                        identity.clone(),
                        RaFileFacts {
                            sha256: sha256_bytes(&member_bytes),
                            bytes: member_bytes.len() as u64,
                            events: member_records,
                        },
                    );
                    sources.insert(identity, member_records);
                    total_bytes += member_bytes.len() as u64;
                    total_events += member_records;
                }
                continue;
            }
            files_by_path.insert(
                path.clone(),
                RaFileFacts {
                    sha256: sha256_bytes(bytes),
                    bytes: bytes.len() as u64,
                    events: state.records,
                },
            );
            sources.insert(path.clone(), state.records);
            for (level, count) in &state.level_counts {
                *severities.entry(level.clone()).or_default() += count;
            }
            total_bytes += bytes.len() as u64;
            total_events += state.records;
        }

        // Flatten groups, doubling contributions for zip-mirrored sources.
        let mut evidence_groups = Vec::new();
        for draft in &self.groups {
            let mut group_sources = Vec::new();
            let mut token_records = 0u64;
            let mut raw_records = 0u64;
            let mut occurrences = 0u64;
            for (path, contribution) in &draft.per_source {
                group_sources.push(path.clone());
                token_records += contribution.token_records;
                raw_records += contribution.raw_records;
                occurrences += contribution.occurrences;
                let mirrored = self
                    .files
                    .iter()
                    .find(|(candidate, _)| candidate == path)
                    .and_then(|(_, state)| state.zip_mirrored_into.clone());
                if let Some(zip_path) = mirrored {
                    group_sources.push(format!("{zip_path}!/{path}"));
                    token_records += contribution.token_records;
                    raw_records += contribution.raw_records;
                    occurrences += contribution.occurrences;
                }
            }
            let occurrences = match draft.occurrence_override {
                Some(value) => {
                    let mirrored_double = draft.per_source.keys().any(|path| {
                        self.files
                            .iter()
                            .find(|(candidate, _)| candidate == path)
                            .is_some_and(|(_, state)| state.zip_mirrored_into.is_some())
                    });
                    if mirrored_double {
                        value * 2
                    } else {
                        value
                    }
                }
                None => occurrences,
            };
            assert!(
                token_records > 0,
                "group {} emitted no token records",
                draft.group_id
            );
            assert!(
                occurrences > 0,
                "group {} has zero occurrences",
                draft.group_id
            );
            evidence_groups.push(RaEvidenceGroup {
                group_id: draft.group_id.clone(),
                token: draft.token.clone(),
                sources: group_sources,
                role: draft.role,
                incident_id: draft.incident_id.clone(),
                expected_token_records: token_records,
                expected_raw_records: raw_records,
                expected_occurrences: occurrences,
                timestamp_certainty: draft.timestamp_certainty.clone(),
                ts: draft.ts,
                notes: draft.notes.clone(),
            });
        }

        let queries = RaQuerySet {
            schema_id: RA_QUERYSET_SCHEMA_ID.into(),
            schema_version: RA_QUERYSET_SCHEMA_VERSION,
            suite_id: RA_SUITE_ID.into(),
            case_id: self.spec.case_id.into(),
            queries: self.queries.clone(),
        };

        let mut truth = RaTruthManifest {
            schema_id: RA_TRUTH_SCHEMA_ID.into(),
            schema_version: RA_TRUTH_SCHEMA_VERSION,
            suite_id: RA_SUITE_ID.into(),
            suite_version: RA_SUITE_VERSION,
            case_id: self.spec.case_id.into(),
            case_version: self.spec.case_version,
            generator_version: RA_GENERATOR_VERSION.into(),
            seed: self.seed,
            tier: self.tier.as_str().into(),
            provenance: RA_PROVENANCE.into(),
            evaluator_only: true,
            evaluator_isolation: RA_EVALUATOR_ISOLATION_NOTE.into(),
            intended_probe: self.spec.intended_probe.into(),
            title: self.spec.title.into(),
            base_ts: self.epoch,
            expected: RaExpectedCorpus {
                files: sources.len() as u64,
                events: total_events,
                bytes: total_bytes,
                source_count: sources.len() as u64,
                sources,
                severities,
                time_quality: self.time_quality.clone(),
                files_by_path,
                excluded_files,
            },
            incidents: self.incidents.clone(),
            evidence_groups,
            known_counts: self.known_counts.clone(),
            required_claims: self.required_claims.clone(),
            forbidden_claims: self.forbidden_claims.clone(),
            competing_explanations: self.competing_explanations.clone(),
            permitted_uncertainty: self.permitted_uncertainty.clone(),
            privacy: RaPrivacy {
                secret_tokens: self.secret_tokens.clone(),
                marker: "LOG-LAB-INVALID".into(),
            },
            retrieval_exclusions: self.exclusions.clone(),
            per_query_relevance: self.relevance.clone(),
            baseline_expectation: expectation,
            semantic_truth_digest: String::new(),
            import_tree_sha256: String::new(),
        };

        // Truth-isolation precondition: evaluator-only identifiers must not
        // appear in any model-visible byte.
        let mut import_bytes = Vec::new();
        for bytes in rendered.values() {
            import_bytes.extend_from_slice(bytes);
        }
        let import_text = String::from_utf8_lossy(&import_bytes);
        for group in &truth.evidence_groups {
            assert!(
                !import_text.contains(&group.group_id),
                "evaluator group id {} leaked into import bytes",
                group.group_id
            );
        }
        for marker in [RA_TRUTH_SCHEMA_ID, "evaluator", "answer_key", "answer-key"] {
            assert!(
                !import_text.contains(marker),
                "evaluator marker `{marker}` leaked into import bytes"
            );
        }

        truth.import_tree_sha256 = {
            let hashes = super::super::tree_hashes(&import_root)?;
            let mut digest_input = Vec::new();
            for (rel, hash) in &hashes {
                digest_input.extend_from_slice(rel.as_bytes());
                digest_input.push(b'\n');
                digest_input.extend_from_slice(hash.as_bytes());
                digest_input.push(b'\n');
            }
            sha256_bytes(&digest_input)
        };
        truth.semantic_truth_digest = ra_semantic_truth_digest(&truth)?;

        write_json(
            &case_root.join("truth/manifest.json"),
            &serde_json::to_value(&truth)?,
        )?;
        write_json(
            &case_root.join("queries.json"),
            &serde_json::to_value(&queries)?,
        )?;
        Ok((truth, queries))
    }
}

// ---------------------------------------------------------------------------
// Suite generation
// ---------------------------------------------------------------------------

/// Generate the retrieval-ablation suite under `root` (the log-lab-shaped
/// root: schema docs land in `root/schema/`, cases under
/// `root/scenarios/retrieval-ablation/`). The suite subtree must not already
/// exist; other log-lab content in `root` is left untouched.
pub fn generate_retrieval_ablation(
    root: &Path,
    tier: RaTier,
    seed: u64,
) -> LabResult<RaSuiteSummary> {
    let suite_root = root.join(RA_SUITE_REL_ROOT);
    if suite_root.exists() {
        return Err(format!(
            "output already contains {}; refusing to overwrite prior work",
            suite_root.display()
        )
        .into());
    }
    fs::create_dir_all(root.join("schema"))?;
    for (name, document) in ra_schema_documents() {
        write_json(&root.join("schema").join(name), &document)?;
    }

    let suite_epoch = ra_suite_epoch(seed);
    let mut entries = Vec::new();
    let mut semantic_inputs = Vec::new();
    let mut total_files = 0u64;
    let mut total_events = 0u64;
    let mut total_bytes = 0u64;
    for spec in ra_case_specs() {
        let case_root = suite_root.join("cases").join(spec.case_id);
        let mut builder = RaCaseBuilder::new(spec, tier, seed, suite_epoch);
        (spec.build)(&mut builder);
        let (truth, _queries) = builder.finish(&case_root)?;
        total_files += truth.expected.files;
        total_events += truth.expected.events;
        total_bytes += truth.expected.bytes;
        semantic_inputs.push(truth.semantic_truth_digest.clone());
        entries.push(RaSuiteCaseEntry {
            case_id: spec.case_id.into(),
            case_version: spec.case_version,
            title: spec.title.into(),
            intended_probe: spec.intended_probe.into(),
            scale_cap: spec.scale_cap,
            files: truth.expected.files,
            events: truth.expected.events,
            bytes: truth.expected.bytes,
            import_tree_sha256: truth.import_tree_sha256.clone(),
            semantic_truth_digest: truth.semantic_truth_digest.clone(),
        });
    }

    let corpus_identity_sha256 = {
        let hashes = super::super::tree_hashes(&suite_root.join("cases"))?;
        let mut digest_input = Vec::new();
        for (rel, hash) in &hashes {
            digest_input.extend_from_slice(rel.as_bytes());
            digest_input.push(b'\n');
            digest_input.extend_from_slice(hash.as_bytes());
            digest_input.push(b'\n');
        }
        sha256_bytes(&digest_input)
    };
    let semantic_suite_digest = sha256_bytes(semantic_inputs.join("\n").as_bytes());

    let manifest = RaSuiteManifest {
        schema_id: RA_SUITE_SCHEMA_ID.into(),
        schema_version: 1,
        suite_id: RA_SUITE_ID.into(),
        suite_version: RA_SUITE_VERSION,
        generator_version: RA_GENERATOR_VERSION.into(),
        truth_schema_id: RA_TRUTH_SCHEMA_ID.into(),
        queryset_schema_id: RA_QUERYSET_SCHEMA_ID.into(),
        seed,
        tier: tier.as_str().into(),
        suite_epoch,
        provenance: RA_PROVENANCE.into(),
        noise_multiplier: tier.noise_multiplier(),
        cases: entries,
        total_files,
        total_events,
        total_bytes,
        corpus_identity_sha256: corpus_identity_sha256.clone(),
        semantic_suite_digest,
    };
    write_json(
        &suite_root.join("suite.json"),
        &serde_json::to_value(&manifest)?,
    )?;

    super::super::verify_safety(&suite_root)?;

    Ok(RaSuiteSummary {
        tier,
        seed,
        cases: manifest.cases.len(),
        files: total_files,
        events: total_events,
        bytes: total_bytes,
        corpus_identity_sha256,
    })
}

/// Load a case truth manifest from a generated (or committed) suite root.
pub fn load_ra_truth(root: &Path, case_id: &str) -> LabResult<RaTruthManifest> {
    let path = root
        .join(RA_SUITE_REL_ROOT)
        .join("cases")
        .join(case_id)
        .join("truth/manifest.json");
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Load a case query set.
pub fn load_ra_queries(root: &Path, case_id: &str) -> LabResult<RaQuerySet> {
    let path = root
        .join(RA_SUITE_REL_ROOT)
        .join("cases")
        .join(case_id)
        .join("queries.json");
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Load the suite manifest.
pub fn load_ra_suite(root: &Path) -> LabResult<RaSuiteManifest> {
    let bytes = fs::read(root.join(RA_SUITE_REL_ROOT).join("suite.json"))?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn ra_case_import_root(root: &Path, case_id: &str) -> PathBuf {
    root.join(RA_SUITE_REL_ROOT)
        .join("cases")
        .join(case_id)
        .join("import")
}
