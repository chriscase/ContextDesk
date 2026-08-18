//! Deterministic model-agreement projection over stored comparison runs.
//!
//! This module answers one narrow question: **which strategies anchored a
//! claim to the same snapshot evidence, in the same causal role?** It is a
//! projection over records that already exist in the library. It executes no
//! strategy, contacts no provider, reads no credential, opens no socket, and
//! reads no clock.
//!
//! Three rules shape everything here.
//!
//! *Evidence, not text.* The unit of agreement is an **anchor**: a pair of one
//! snapshot evidence item and one causal [`RoleBucket`]. Claim text is never
//! compared, hashed for similarity, or scored. Two strategies that wrote the
//! same sentence without citing evidence agree about nothing observable, and
//! this projection says so.
//!
//! *The full claim graph, not the flattened summary.* [`TriageRun::claims`] is
//! a lossy convenience projection for ContextDesk SDK rows: it keeps a claim's
//! text and its *first* evidence id and discards the claim kind, the host
//! status, and every later evidence id. Agreement therefore reads the
//! owner-only replay envelope for SDK rows and falls back to `claims` only for
//! imported human, web-only, and other-product rows, where it is the only
//! source that exists.
//!
//! *No ranking.* There is no score, no ordering by concurrence, no winner, and
//! no readiness claim. Counts and explicit membership lists only.
//!
//! Nothing here mutates a stored record or changes an existing schema. The
//! views are computed on demand and serialized on their own.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical::to_canonical_json;
use crate::error::BenchResult;
use crate::privacy::gate_share_safe_text;
use crate::report::{escape_report_value, is_adapter_owner_only_envelope, safe_report_identity};
use crate::types::{
    sha256_hex, EvaluationTask, FairnessClass, PrivacyClass, RunStatus, SourceKind, TriageRun,
};

/// Owner-only agreement projection schema.
pub const AGREEMENT_VIEW_SCHEMA_V1: &str = "contextdesk.triage_bench.agreement_view.v1";
/// Share-safe agreement projection schema.
pub const AGREEMENT_VIEW_SHARE_SAFE_SCHEMA_V1: &str =
    "contextdesk.triage_bench.agreement_view_share_safe.v1";

/// Fingerprint prefix for a bench run identity in a share-safe view.
const RUN_PREFIX: &str = "arf";
/// Fingerprint prefix for a snapshot evidence item id.
const EVIDENCE_PREFIX: &str = "aef";
/// Fingerprint prefix for a source identity (model pair, or imported strategy).
const SOURCE_PREFIX: &str = "asf";
/// Task/snapshot prefixes match the adapter's share-safe projection, so a
/// reader can line an agreement view up with a `bench-compare` payload.
const TASK_PREFIX: &str = "tkf";
/// See [`TASK_PREFIX`].
const SNAPSHOT_PREFIX: &str = "snf";

/// Fixed honesty notes emitted verbatim on every view.
const NOTES: &[&str] = &[
    "Agreement is computed only within one exact evaluation task and evidence snapshot.",
    "Agreement is not correctness: concurring strategies can be wrong together.",
    "An anchor requires a claim cited to a visible snapshot evidence item. Claim text is never compared.",
    "Independent corroboration counts distinct source identities, not runs: two candidates on one model are not independent.",
    "The same evidence cited under different causal roles is a conflict, not agreement.",
    "Failed, partial, timed-out, and cancelled runs stay listed and contribute no anchors.",
    "This projection assigns no score, rank, readiness, or winner.",
];

/// Deterministic causal role an anchor was claimed under.
///
/// Declaration order is the rendering and sort order. `Unknown` is reserved
/// for imported rows, whose source format carries no claim kind; it never
/// merges with a known bucket, so an imported citation can corroborate another
/// imported citation but never silently corroborates a typed SDK claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleBucket {
    /// `initiating_cause`.
    Cause,
    /// `causal_candidate` or `competing_explanation`.
    Candidate,
    /// `symptom`.
    Symptom,
    /// `observation`.
    Observation,
    /// `missing_evidence`.
    Gap,
    /// Imported row with no typed claim kind.
    Unknown,
}

impl RoleBucket {
    /// Stable wire/render token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cause => "cause",
            Self::Candidate => "candidate",
            Self::Symptom => "symptom",
            Self::Observation => "observation",
            Self::Gap => "gap",
            Self::Unknown => "unknown",
        }
    }
}

/// Map one SDK `claim_kind` onto a bucket.
///
/// An unrecognized kind returns `None` and the claim is counted as
/// unrecognized rather than folded into [`RoleBucket::Unknown`]: a future
/// schema addition must not silently become agreement with an imported row.
fn bucket_for_claim_kind(kind: &str) -> Option<RoleBucket> {
    match kind {
        "initiating_cause" => Some(RoleBucket::Cause),
        "causal_candidate" | "competing_explanation" => Some(RoleBucket::Candidate),
        "symptom" => Some(RoleBucket::Symptom),
        "observation" => Some(RoleBucket::Observation),
        "missing_evidence" => Some(RoleBucket::Gap),
        _ => None,
    }
}

/// Why one run could not participate in a group's agreement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExclusionReason {
    /// The group's evaluation task record was not supplied, so visible
    /// evidence could not be established and no citation could be validated.
    TaskRecordUnavailable,
    /// The evaluation task record binds a different evidence snapshot than the
    /// one these runs recorded, so the task's visibility policy does not
    /// describe what they actually saw.
    TaskSnapshotMismatch,
    /// Fairness is not `same_snapshot`.
    FairnessNotSameSnapshot,
    /// An SDK row's raw output was not supplied to the projection.
    SdkRawOutputUnavailable,
    /// An SDK row's raw output is not parseable JSON.
    SdkEnvelopeUnparseable,
    /// An SDK row's raw output is not the adapter's owner-only envelope.
    SdkRowWithoutOwnerOnlyEnvelope,
    /// The envelope's bounded visibility differs from the task's visibility.
    SdkVisibilityMismatch,
    /// No exact model identity could be recovered, so independence of this
    /// row from another row cannot be established.
    SdkModelIdentityUnavailable,
    /// SDK rows in this group do not share one materialized packet.
    PacketFingerprintDivergence,
}

impl ExclusionReason {
    /// Stable wire/render token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskRecordUnavailable => "task_record_unavailable",
            Self::TaskSnapshotMismatch => "task_snapshot_mismatch",
            Self::FairnessNotSameSnapshot => "fairness_not_same_snapshot",
            Self::SdkRawOutputUnavailable => "sdk_raw_output_unavailable",
            Self::SdkEnvelopeUnparseable => "sdk_envelope_unparseable",
            Self::SdkRowWithoutOwnerOnlyEnvelope => "sdk_row_without_owner_only_envelope",
            Self::SdkVisibilityMismatch => "sdk_visibility_mismatch",
            Self::SdkModelIdentityUnavailable => "sdk_model_identity_unavailable",
            Self::PacketFingerprintDivergence => "packet_fingerprint_divergence",
        }
    }
}

/// One run kept out of the agreement computation, with the exact reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExcludedRun {
    /// Durable bench run identity.
    pub run_id: String,
    /// Why it was excluded.
    pub reason: ExclusionReason,
}

/// One participating run and what it contributed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgreementRun {
    /// Durable bench run identity.
    pub run_id: String,
    /// Bench strategy name.
    pub strategy_name: String,
    /// Where the run came from.
    pub source_kind: SourceKind,
    /// Honest terminal status; never a reason to drop the row.
    pub status: RunStatus,
    /// Identity used for independence: the exact model pair for an SDK row,
    /// `<source_kind>::<strategy_name>` for an imported row.
    pub source_identity: String,
    /// Exact provider-profile/model identities. Owner-only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_identities: Vec<String>,
    /// Opaque model fingerprints preserved by the envelope.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_fingerprints: Vec<String>,
    /// Whether any claim set could be read at all. `false` distinguishes "this
    /// row produced no answer" from "this row answered and cited nothing".
    pub claims_available: bool,
    /// Claims this run contributed to an anchor.
    pub anchor_count: u32,
    /// Supported claims carrying no evidence id: text only, never agreement.
    pub unanchored_claims: u32,
    /// Claims the host marked `unsupported` or `withheld`.
    pub withheld_claims: u32,
    /// Claims whose kind or status this schema version does not recognize.
    pub unrecognized_claims: u32,
    /// Cited evidence ids that are not visible under this task. A finding,
    /// never an anchor.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invalid_citations: Vec<String>,
}

/// One evidence item claimed under one causal role, and who claimed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceAnchor {
    /// Snapshot evidence item id.
    pub evidence_item_id: String,
    /// Causal role this anchor was claimed under.
    pub role_bucket: RoleBucket,
    /// Runs that claimed it, sorted.
    pub concurring_run_ids: Vec<String>,
    /// Distinct source identities behind those runs, sorted. Owner-only.
    pub concurring_source_identities: Vec<String>,
    /// Number of distinct source identities.
    pub distinct_source_count: u32,
    /// Number of distinct exact model identities among SDK rows here.
    pub distinct_model_identity_count: u32,
    /// Two or more distinct sources. Two candidates on one model are not
    /// independent and this stays `false`.
    pub independent: bool,
    /// Exactly one run claimed this anchor.
    pub sole_support: bool,
    /// Contributing claim ids, sorted. Imported rows contribute none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub claim_ids: Vec<String>,
}

/// One role bucket within a conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleConflictBucket {
    /// The role claimed.
    pub role_bucket: RoleBucket,
    /// Runs claiming it, sorted.
    pub run_ids: Vec<String>,
}

/// One evidence item claimed under two or more incompatible roles.
///
/// This is reported instead of, and alongside, agreement: runs inside one
/// bucket still concur with each other, and the disagreement about what the
/// evidence *means* is stated rather than averaged away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleConflict {
    /// Snapshot evidence item id.
    pub evidence_item_id: String,
    /// Every bucket claimed for it, sorted by role.
    pub buckets: Vec<RoleConflictBucket>,
}

/// Owner-only agreement projection for one comparison group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgreementView {
    /// Schema id.
    pub schema_id: String,
    /// Always [`PrivacyClass::OwnerOnly`]: exact model identities and evidence
    /// ids are retained. Use [`project_agreement_share_safe`] to share.
    pub privacy: PrivacyClass,
    /// Exact case identity.
    pub case_id: String,
    /// Exact evaluation task identity.
    pub task_id: String,
    /// Exact evidence snapshot identity.
    pub snapshot_id: String,
    /// The one materialized packet every participating SDK row shared, when
    /// this group contains SDK rows at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packet_fingerprint: Option<String>,
    /// Evidence the task made visible, sorted.
    pub visible_item_ids: Vec<String>,
    /// Participating runs, sorted by run id.
    pub runs: Vec<AgreementRun>,
    /// Anchors, sorted by evidence id then role.
    pub anchors: Vec<EvidenceAnchor>,
    /// Role conflicts, sorted by evidence id.
    pub role_conflicts: Vec<RoleConflict>,
    /// Visible evidence nobody cited, sorted.
    pub uncited_visible_evidence: Vec<String>,
    /// Runs excluded from the computation, sorted by run id.
    pub excluded_runs: Vec<ExcludedRun>,
    /// Fixed honesty notes.
    pub notes: Vec<String>,
}

/// Share-safe counterpart of [`AgreementRun`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeAgreementRun {
    /// Fingerprint of the bench run id.
    pub run_fingerprint: String,
    /// Fingerprint of the source identity.
    pub source_fingerprint: String,
    /// Where the run came from. A category, not an identity.
    pub source_kind: SourceKind,
    /// Honest terminal status.
    pub status: RunStatus,
    /// Opaque model fingerprints, never an exact identity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_fingerprints: Vec<String>,
    /// See [`AgreementRun::claims_available`].
    pub claims_available: bool,
    /// See [`AgreementRun::anchor_count`].
    pub anchor_count: u32,
    /// See [`AgreementRun::unanchored_claims`].
    pub unanchored_claims: u32,
    /// See [`AgreementRun::withheld_claims`].
    pub withheld_claims: u32,
    /// See [`AgreementRun::unrecognized_claims`].
    pub unrecognized_claims: u32,
    /// Count only: an invalid evidence id is not projected.
    pub invalid_citation_count: u32,
}

/// Share-safe counterpart of [`EvidenceAnchor`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeEvidenceAnchor {
    /// Fingerprint of the evidence item id.
    pub evidence_fingerprint: String,
    /// Causal role.
    pub role_bucket: RoleBucket,
    /// Fingerprints of the concurring runs, sorted.
    pub concurring_run_fingerprints: Vec<String>,
    /// Number of distinct source identities.
    pub distinct_source_count: u32,
    /// Number of distinct exact model identities.
    pub distinct_model_identity_count: u32,
    /// Two or more distinct sources.
    pub independent: bool,
    /// Exactly one run claimed this anchor.
    pub sole_support: bool,
}

/// Share-safe counterpart of [`RoleConflict`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeRoleConflict {
    /// Fingerprint of the evidence item id.
    pub evidence_fingerprint: String,
    /// Role plus how many runs claimed it. Membership stays owner-only.
    pub buckets: Vec<ShareSafeRoleConflictBucket>,
}

/// One bucket of a share-safe role conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeRoleConflictBucket {
    /// The role claimed.
    pub role_bucket: RoleBucket,
    /// How many runs claimed it.
    pub run_count: u32,
}

/// Share-safe agreement projection.
///
/// Produced by projection, never by filtering the owner-only view: every field
/// is constructed explicitly, so a field added to [`AgreementView`] cannot leak
/// here by default. Carries no exact model identity, claim text, locator,
/// evidence excerpt, task or protocol text, raw output, or operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeAgreementView {
    /// Schema id.
    pub schema_id: String,
    /// Always [`PrivacyClass::ShareSafe`].
    pub privacy: PrivacyClass,
    /// Fingerprint of the task id.
    pub task_fingerprint: String,
    /// Fingerprint of the snapshot id.
    pub snapshot_fingerprint: String,
    /// The shared packet fingerprint, already an opaque digest upstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packet_fingerprint: Option<String>,
    /// How much evidence the task made visible.
    pub visible_item_count: u32,
    /// Participating runs.
    pub runs: Vec<ShareSafeAgreementRun>,
    /// Anchors.
    pub anchors: Vec<ShareSafeEvidenceAnchor>,
    /// Role conflicts.
    pub role_conflicts: Vec<ShareSafeRoleConflict>,
    /// How much visible evidence nobody cited.
    pub uncited_visible_count: u32,
    /// How many runs were excluded, by reason. Identities stay owner-only.
    pub excluded_run_counts: Vec<ShareSafeExclusionCount>,
    /// Fixed honesty notes.
    pub notes: Vec<String>,
}

/// One exclusion reason and how many runs it covered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeExclusionCount {
    /// Why those runs were excluded.
    pub reason: ExclusionReason,
    /// How many.
    pub run_count: u32,
}

/// One claim normalized out of whichever source format carried it.
struct NormalizedClaim {
    claim_id: Option<String>,
    bucket: Option<RoleBucket>,
    supported: bool,
    recognized: bool,
    evidence_ids: Vec<String>,
}

/// Everything one eligible run contributes, before anchors are assembled.
struct RunContribution {
    run_id: String,
    strategy_name: String,
    source_kind: SourceKind,
    status: RunStatus,
    source_identity: String,
    model_identities: Vec<String>,
    model_fingerprints: Vec<String>,
    claims_available: bool,
    claims: Vec<NormalizedClaim>,
}

/// Build one agreement view per comparison group.
///
/// Groups are keyed by exact `(task_id, snapshot_id, case_id)` — the same key
/// [`crate::report::build_report_with_attribution`] uses — so a run can never
/// contribute to a group it did not run against. `raw_outputs` maps a bench run
/// id to its stored raw-output bytes; only ContextDesk SDK rows are looked up
/// there, and a missing entry excludes that row explicitly rather than silently
/// crediting it with no claims.
///
/// `tasks` supplies the visibility policy each group is validated against. A
/// group whose task record is absent yields a view with every run excluded:
/// without the visible-item set no citation can be checked, and guessing would
/// be the one thing this projection must never do.
pub fn build_agreement_views(
    runs: &[TriageRun],
    tasks: &[EvaluationTask],
    raw_outputs: &BTreeMap<String, Vec<u8>>,
) -> BenchResult<Vec<AgreementView>> {
    let tasks_by_id: BTreeMap<&str, &EvaluationTask> = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task))
        .collect();

    let mut grouped: BTreeMap<(&str, &str, &str), Vec<&TriageRun>> = BTreeMap::new();
    for run in runs {
        grouped
            .entry((
                run.task_id.as_str(),
                run.snapshot_id.as_str(),
                run.case_id.as_str(),
            ))
            .or_default()
            .push(run);
    }

    let mut views = Vec::with_capacity(grouped.len());
    for ((task_id, snapshot_id, case_id), group_runs) in grouped {
        views.push(build_group_view(
            task_id,
            snapshot_id,
            case_id,
            &group_runs,
            tasks_by_id.get(task_id).copied(),
            raw_outputs,
        )?);
    }
    Ok(views)
}

fn build_group_view(
    task_id: &str,
    snapshot_id: &str,
    case_id: &str,
    group_runs: &[&TriageRun],
    task: Option<&EvaluationTask>,
    raw_outputs: &BTreeMap<String, Vec<u8>>,
) -> BenchResult<AgreementView> {
    let notes = NOTES.iter().map(|note| (*note).to_string()).collect();

    // Without a task record there is no visible-item set, and a task record
    // that binds another snapshot does not describe what these runs saw.
    // Either way the only honest move is to refuse the whole group rather than
    // validate citations against a policy that does not apply.
    let unusable_task = match task {
        None => Some(ExclusionReason::TaskRecordUnavailable),
        Some(task) if task.snapshot_id != snapshot_id => {
            Some(ExclusionReason::TaskSnapshotMismatch)
        }
        Some(_) => None,
    };
    if let Some(reason) = unusable_task {
        let mut excluded = group_runs
            .iter()
            .map(|run| ExcludedRun {
                run_id: run.run_id.clone(),
                reason,
            })
            .collect::<Vec<_>>();
        excluded.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        return Ok(AgreementView {
            schema_id: AGREEMENT_VIEW_SCHEMA_V1.into(),
            privacy: PrivacyClass::OwnerOnly,
            case_id: case_id.into(),
            task_id: task_id.into(),
            snapshot_id: snapshot_id.into(),
            packet_fingerprint: None,
            visible_item_ids: Vec::new(),
            runs: Vec::new(),
            anchors: Vec::new(),
            role_conflicts: Vec::new(),
            uncited_visible_evidence: Vec::new(),
            excluded_runs: excluded,
            notes,
        });
    }
    let task = task.expect("unusable_task covers the absent-task case");

    let visible: BTreeSet<&str> = task
        .visibility
        .visible_item_ids
        .iter()
        .map(String::as_str)
        .collect();

    let mut excluded: Vec<ExcludedRun> = Vec::new();
    let mut contributions: Vec<RunContribution> = Vec::new();
    // Packet fingerprints observed on SDK rows. More than one means the rows
    // did not share a materialization, so none of them may anchor.
    let mut packet_fingerprints: BTreeSet<String> = BTreeSet::new();

    for run in group_runs {
        if run.fairness != FairnessClass::SameSnapshot {
            excluded.push(ExcludedRun {
                run_id: run.run_id.clone(),
                reason: ExclusionReason::FairnessNotSameSnapshot,
            });
            continue;
        }
        match run.source_kind {
            SourceKind::ContextdeskSdk => match sdk_contribution(run, task, raw_outputs) {
                Ok((contribution, packet_fingerprint)) => {
                    if let Some(fingerprint) = packet_fingerprint {
                        packet_fingerprints.insert(fingerprint);
                    }
                    contributions.push(contribution);
                }
                Err(reason) => excluded.push(ExcludedRun {
                    run_id: run.run_id.clone(),
                    reason,
                }),
            },
            SourceKind::Human | SourceKind::WebOnly | SourceKind::OtherProduct => {
                contributions.push(imported_contribution(run));
            }
        }
    }

    // A group whose SDK rows disagree about the materialized packet has no
    // single same-snapshot execution to compare. Refuse all of them rather
    // than picking a majority — that choice would be a ranking.
    let packet_fingerprint = if packet_fingerprints.len() > 1 {
        contributions.retain(|contribution| {
            if contribution.source_kind == SourceKind::ContextdeskSdk {
                excluded.push(ExcludedRun {
                    run_id: contribution.run_id.clone(),
                    reason: ExclusionReason::PacketFingerprintDivergence,
                });
                false
            } else {
                true
            }
        });
        None
    } else {
        packet_fingerprints.into_iter().next()
    };

    // (evidence_id, bucket) -> (run ids, source identities, model identities, claim ids)
    type AnchorMembers = (
        BTreeSet<String>,
        BTreeSet<String>,
        BTreeSet<String>,
        BTreeSet<String>,
    );
    let mut anchor_map: BTreeMap<(String, RoleBucket), AnchorMembers> = BTreeMap::new();
    let mut agreement_runs: Vec<AgreementRun> = Vec::with_capacity(contributions.len());

    for contribution in &contributions {
        let mut anchor_count = 0_u32;
        let mut unanchored = 0_u32;
        let mut withheld = 0_u32;
        let mut unrecognized = 0_u32;
        let mut invalid: BTreeSet<String> = BTreeSet::new();

        for claim in &contribution.claims {
            if !claim.recognized {
                unrecognized = unrecognized.saturating_add(1);
                continue;
            }
            if !claim.supported {
                withheld = withheld.saturating_add(1);
                continue;
            }
            let Some(bucket) = claim.bucket else {
                unrecognized = unrecognized.saturating_add(1);
                continue;
            };
            if claim.evidence_ids.is_empty() {
                unanchored = unanchored.saturating_add(1);
                continue;
            }
            let mut anchored_here = false;
            for evidence_id in &claim.evidence_ids {
                if !visible.contains(evidence_id.as_str()) {
                    invalid.insert(evidence_id.clone());
                    continue;
                }
                let entry = anchor_map
                    .entry((evidence_id.clone(), bucket))
                    .or_insert_with(|| {
                        (
                            BTreeSet::new(),
                            BTreeSet::new(),
                            BTreeSet::new(),
                            BTreeSet::new(),
                        )
                    });
                entry.0.insert(contribution.run_id.clone());
                entry.1.insert(contribution.source_identity.clone());
                for model in &contribution.model_identities {
                    entry.2.insert(model.clone());
                }
                if let Some(claim_id) = &claim.claim_id {
                    entry.3.insert(claim_id.clone());
                }
                anchored_here = true;
            }
            if anchored_here {
                anchor_count = anchor_count.saturating_add(1);
            }
        }

        agreement_runs.push(AgreementRun {
            run_id: contribution.run_id.clone(),
            strategy_name: contribution.strategy_name.clone(),
            source_kind: contribution.source_kind,
            status: contribution.status,
            source_identity: contribution.source_identity.clone(),
            model_identities: contribution.model_identities.clone(),
            model_fingerprints: contribution.model_fingerprints.clone(),
            claims_available: contribution.claims_available,
            anchor_count,
            unanchored_claims: unanchored,
            withheld_claims: withheld,
            unrecognized_claims: unrecognized,
            invalid_citations: invalid.into_iter().collect(),
        });
    }

    agreement_runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    excluded.sort_by(|left, right| {
        left.run_id
            .cmp(&right.run_id)
            .then_with(|| left.reason.cmp(&right.reason))
    });

    let mut anchors = Vec::with_capacity(anchor_map.len());
    let mut buckets_by_evidence: BTreeMap<String, Vec<RoleConflictBucket>> = BTreeMap::new();
    for ((evidence_item_id, role_bucket), (run_ids, sources, models, claim_ids)) in anchor_map {
        buckets_by_evidence
            .entry(evidence_item_id.clone())
            .or_default()
            .push(RoleConflictBucket {
                role_bucket,
                run_ids: run_ids.iter().cloned().collect(),
            });
        anchors.push(EvidenceAnchor {
            evidence_item_id,
            role_bucket,
            distinct_source_count: sources.len() as u32,
            distinct_model_identity_count: models.len() as u32,
            independent: sources.len() >= 2,
            sole_support: run_ids.len() == 1,
            concurring_run_ids: run_ids.into_iter().collect(),
            concurring_source_identities: sources.into_iter().collect(),
            claim_ids: claim_ids.into_iter().collect(),
        });
    }

    let role_conflicts = buckets_by_evidence
        .into_iter()
        .filter(|(_, buckets)| buckets.len() > 1)
        .map(|(evidence_item_id, mut buckets)| {
            buckets.sort_by_key(|bucket| bucket.role_bucket);
            RoleConflict {
                evidence_item_id,
                buckets,
            }
        })
        .collect::<Vec<_>>();

    let cited: BTreeSet<&str> = anchors
        .iter()
        .map(|anchor| anchor.evidence_item_id.as_str())
        .collect();
    let uncited_visible_evidence = visible
        .iter()
        .filter(|item| !cited.contains(*item))
        .map(|item| (*item).to_string())
        .collect::<Vec<_>>();

    Ok(AgreementView {
        schema_id: AGREEMENT_VIEW_SCHEMA_V1.into(),
        privacy: PrivacyClass::OwnerOnly,
        case_id: case_id.into(),
        task_id: task_id.into(),
        snapshot_id: snapshot_id.into(),
        packet_fingerprint,
        visible_item_ids: visible.iter().map(|item| (*item).to_string()).collect(),
        runs: agreement_runs,
        anchors,
        role_conflicts,
        uncited_visible_evidence,
        excluded_runs: excluded,
        notes,
    })
}

/// Normalize one imported human / web-only / other-product row.
///
/// `TriageRun::claims` is the only claim structure these formats carry, so
/// every claim lands in [`RoleBucket::Unknown`] and is treated as supported:
/// the import contract has no status field to contradict it.
fn imported_contribution(run: &TriageRun) -> RunContribution {
    let claims = run
        .claims
        .iter()
        .map(|claim| NormalizedClaim {
            claim_id: None,
            bucket: Some(RoleBucket::Unknown),
            supported: true,
            recognized: true,
            evidence_ids: claim.evidence_item_id.iter().cloned().collect(),
        })
        .collect::<Vec<_>>();
    RunContribution {
        run_id: run.run_id.clone(),
        strategy_name: run.strategy.name.clone(),
        source_kind: run.source_kind,
        status: run.status,
        source_identity: format!("{}::{}", run.source_kind.as_str(), run.strategy.name),
        model_identities: Vec::new(),
        model_fingerprints: Vec::new(),
        claims_available: !run.claims.is_empty(),
        claims,
    }
}

/// Normalize one ContextDesk SDK row from its owner-only replay envelope.
///
/// Deliberately does not read `run.claims`: that projection drops the claim
/// kind, the host status, and every evidence id after the first, so agreement
/// built on it could neither detect a role conflict nor count shared support.
fn sdk_contribution(
    run: &TriageRun,
    task: &EvaluationTask,
    raw_outputs: &BTreeMap<String, Vec<u8>>,
) -> Result<(RunContribution, Option<String>), ExclusionReason> {
    let raw = raw_outputs
        .get(&run.run_id)
        .ok_or(ExclusionReason::SdkRawOutputUnavailable)?;
    let envelope: Value =
        serde_json::from_slice(raw).map_err(|_| ExclusionReason::SdkEnvelopeUnparseable)?;
    if !is_adapter_owner_only_envelope(&envelope) {
        return Err(ExclusionReason::SdkRowWithoutOwnerOnlyEnvelope);
    }

    // The envelope names the exact visibility its packet was bounded to. If it
    // differs from the task's, the row did not see this task's evidence set.
    let envelope_visible: BTreeSet<&str> = envelope
        .get("visible_item_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let task_visible: BTreeSet<&str> = task
        .visibility
        .visible_item_ids
        .iter()
        .map(String::as_str)
        .collect();
    if envelope_visible != task_visible {
        return Err(ExclusionReason::SdkVisibilityMismatch);
    }

    let attribution = crate::report::extract_owner_model_attribution(raw)
        .ok_or(ExclusionReason::SdkModelIdentityUnavailable)?;
    if attribution.model_identities.is_empty() {
        return Err(ExclusionReason::SdkModelIdentityUnavailable);
    }

    let packet_fingerprint = envelope
        .get("fingerprints")
        .and_then(|fingerprints| fingerprints.get("packet"))
        .and_then(Value::as_str)
        .filter(|value| safe_report_identity(value))
        .map(str::to_owned);

    let (claims_available, claims) = sdk_claims(&envelope);

    Ok((
        RunContribution {
            run_id: run.run_id.clone(),
            strategy_name: run.strategy.name.clone(),
            source_kind: run.source_kind,
            status: run.status,
            source_identity: attribution.model_identities.join("+"),
            model_identities: attribution.model_identities,
            model_fingerprints: attribution.model_fingerprints,
            claims_available,
            claims,
        },
        packet_fingerprint,
    ))
}

/// Read the validated claim graph off the terminal event of a replay.
///
/// Returns `(claims_available, claims)`. `claims_available` is `false` when the
/// terminal carried no answer at all — an honest partial, a failed run, a
/// pre-packet refusal — which is a different fact from an answer that cited
/// nothing, and the two are never conflated.
fn sdk_claims(envelope: &Value) -> (bool, Vec<NormalizedClaim>) {
    let Some(terminal) = envelope
        .get("replay")
        .and_then(|replay| replay.get("events"))
        .and_then(Value::as_array)
        .and_then(|events| events.last())
        .and_then(|event| event.get("event"))
    else {
        return (false, Vec::new());
    };
    // A completed terminal carries `result`; failed, timed-out, and cancelled
    // terminals may carry an honest `partial_result` instead.
    let Some(result) = terminal
        .get("result")
        .or_else(|| terminal.get("partial_result"))
    else {
        return (false, Vec::new());
    };
    let Some(candidates) = result
        .get("answer")
        .and_then(|envelope| envelope.get("answer"))
        .and_then(|answer| answer.get("candidates"))
        .and_then(Value::as_array)
    else {
        return (false, Vec::new());
    };

    let mut claims = Vec::new();
    for candidate in candidates {
        let Some(candidate_claims) = candidate.get("claims").and_then(Value::as_array) else {
            continue;
        };
        for claim in candidate_claims {
            let kind = claim.get("claim_kind").and_then(Value::as_str);
            let status = claim.get("status").and_then(Value::as_str);
            let bucket = kind.and_then(bucket_for_claim_kind);
            // An unreadable kind or status is schema drift, not permission to
            // fold the claim into `unknown` and call it agreement.
            let recognized = bucket.is_some()
                && matches!(status, Some("supported" | "unsupported" | "withheld"));
            let evidence_ids = claim
                .get("evidence_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|value| safe_report_identity(value))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            claims.push(NormalizedClaim {
                claim_id: claim
                    .get("claim_id")
                    .and_then(Value::as_str)
                    .filter(|value| safe_report_identity(value))
                    .map(str::to_owned),
                bucket,
                supported: status == Some("supported"),
                recognized,
                evidence_ids,
            });
        }
    }
    (true, claims)
}

/// Stable opaque fingerprint over one value, matching the adapter's shape.
fn fingerprint(prefix: &str, value: &str) -> BenchResult<String> {
    let canonical = to_canonical_json(&value)?;
    Ok(format!("{prefix}-{}", sha256_hex(canonical.as_bytes())))
}

/// Project one owner-only view into its share-safe counterpart.
///
/// Every field is built explicitly rather than filtered, and the serialized
/// result is passed through the real share-safe scanner before it is returned,
/// so a projection that ever regressed into carrying a path or credential-shaped
/// substring fails closed instead of shipping.
pub fn project_agreement_share_safe(view: &AgreementView) -> BenchResult<ShareSafeAgreementView> {
    let mut run_fingerprints: BTreeMap<&str, String> = BTreeMap::new();
    for run in &view.runs {
        run_fingerprints.insert(run.run_id.as_str(), fingerprint(RUN_PREFIX, &run.run_id)?);
    }

    let mut runs = Vec::with_capacity(view.runs.len());
    for run in &view.runs {
        runs.push(ShareSafeAgreementRun {
            run_fingerprint: fingerprint(RUN_PREFIX, &run.run_id)?,
            source_fingerprint: fingerprint(SOURCE_PREFIX, &run.source_identity)?,
            source_kind: run.source_kind,
            status: run.status,
            model_fingerprints: run.model_fingerprints.clone(),
            claims_available: run.claims_available,
            anchor_count: run.anchor_count,
            unanchored_claims: run.unanchored_claims,
            withheld_claims: run.withheld_claims,
            unrecognized_claims: run.unrecognized_claims,
            invalid_citation_count: run.invalid_citations.len() as u32,
        });
    }

    let mut anchors = Vec::with_capacity(view.anchors.len());
    for anchor in &view.anchors {
        let mut concurring = Vec::with_capacity(anchor.concurring_run_ids.len());
        for run_id in &anchor.concurring_run_ids {
            concurring.push(match run_fingerprints.get(run_id.as_str()) {
                Some(value) => value.clone(),
                None => fingerprint(RUN_PREFIX, run_id)?,
            });
        }
        concurring.sort();
        anchors.push(ShareSafeEvidenceAnchor {
            evidence_fingerprint: fingerprint(EVIDENCE_PREFIX, &anchor.evidence_item_id)?,
            role_bucket: anchor.role_bucket,
            concurring_run_fingerprints: concurring,
            distinct_source_count: anchor.distinct_source_count,
            distinct_model_identity_count: anchor.distinct_model_identity_count,
            independent: anchor.independent,
            sole_support: anchor.sole_support,
        });
    }

    let mut role_conflicts = Vec::with_capacity(view.role_conflicts.len());
    for conflict in &view.role_conflicts {
        role_conflicts.push(ShareSafeRoleConflict {
            evidence_fingerprint: fingerprint(EVIDENCE_PREFIX, &conflict.evidence_item_id)?,
            buckets: conflict
                .buckets
                .iter()
                .map(|bucket| ShareSafeRoleConflictBucket {
                    role_bucket: bucket.role_bucket,
                    run_count: bucket.run_ids.len() as u32,
                })
                .collect(),
        });
    }

    let mut exclusion_counts: BTreeMap<ExclusionReason, u32> = BTreeMap::new();
    for excluded in &view.excluded_runs {
        *exclusion_counts.entry(excluded.reason).or_default() += 1;
    }

    let projection = ShareSafeAgreementView {
        schema_id: AGREEMENT_VIEW_SHARE_SAFE_SCHEMA_V1.into(),
        privacy: PrivacyClass::ShareSafe,
        task_fingerprint: fingerprint(TASK_PREFIX, &view.task_id)?,
        snapshot_fingerprint: fingerprint(SNAPSHOT_PREFIX, &view.snapshot_id)?,
        packet_fingerprint: view.packet_fingerprint.clone(),
        visible_item_count: view.visible_item_ids.len() as u32,
        runs,
        anchors,
        role_conflicts,
        uncited_visible_count: view.uncited_visible_evidence.len() as u32,
        excluded_run_counts: exclusion_counts
            .into_iter()
            .map(|(reason, run_count)| ShareSafeExclusionCount { reason, run_count })
            .collect(),
        notes: view.notes.clone(),
    };

    gate_share_safe_text(&to_canonical_json(&projection)?)?;
    Ok(projection)
}

/// Render owner-only agreement views as markdown.
///
/// Every dynamic value is escaped with the report renderer's escaper, so a
/// crafted identity in an imported record cannot inject markup or split a row.
pub fn render_agreement_markdown(views: &[AgreementView]) -> BenchResult<String> {
    let esc = escape_report_value;
    let mut out = String::from("# Triage bench evidence agreement\n\n");
    out.push_str(&format!("Schema: `{}`\n\n", esc(AGREEMENT_VIEW_SCHEMA_V1)));

    if views.is_empty() {
        out.push_str("No stored runs to project.\n");
        return Ok(out);
    }

    for view in views {
        out.push_str(&format!(
            "## task `{}` snapshot `{}`\n\n",
            esc(&view.task_id),
            esc(&view.snapshot_id)
        ));
        out.push_str(&format!(
            "- case: `{}`\n- participating runs: {}\n- excluded runs: {}\n- shared packet: {}\n\n",
            esc(&view.case_id),
            view.runs.len(),
            view.excluded_runs.len(),
            view.packet_fingerprint
                .as_deref()
                .map_or_else(|| "none".to_string(), |value| format!("`{}`", esc(value)))
        ));

        out.push_str(
            "| evidence | role | concurring | sources | models | independent | sole support |\n",
        );
        out.push_str("| --- | --- | --- | --- | --- | --- | --- |\n");
        if view.anchors.is_empty() {
            out.push_str("| _none_ | — | 0 | 0 | 0 | no | — |\n");
        }
        for anchor in &view.anchors {
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} | {} |\n",
                esc(&anchor.evidence_item_id),
                esc(anchor.role_bucket.as_str()),
                anchor.concurring_run_ids.len(),
                anchor.distinct_source_count,
                anchor.distinct_model_identity_count,
                if anchor.independent { "yes" } else { "no" },
                if anchor.sole_support { "yes" } else { "—" }
            ));
        }
        out.push('\n');

        if view.role_conflicts.is_empty() {
            out.push_str("Role conflicts: none\n\n");
        } else {
            out.push_str("### Role conflicts (same evidence, different role)\n\n");
            for conflict in &view.role_conflicts {
                let buckets = conflict
                    .buckets
                    .iter()
                    .map(|bucket| {
                        format!(
                            "{} ({})",
                            esc(bucket.role_bucket.as_str()),
                            bucket.run_ids.len()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!(
                    "- `{}`: {}\n",
                    esc(&conflict.evidence_item_id),
                    buckets
                ));
            }
            out.push('\n');
        }

        out.push_str("### Runs\n\n");
        out.push_str("| run | strategy | source | status | model(s) | anchors | unanchored | withheld | unrecognized | invalid citations |\n");
        out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
        for run in &view.runs {
            let models = if run.model_identities.is_empty() {
                "unknown".to_string()
            } else {
                run.model_identities
                    .iter()
                    .map(|model| format!("`{}`", esc(model)))
                    .collect::<Vec<_>>()
                    .join("<br>")
            };
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
                esc(&run.run_id),
                esc(&run.strategy_name),
                esc(run.source_kind.as_str()),
                esc(run.status.as_str()),
                models,
                if run.claims_available {
                    run.anchor_count.to_string()
                } else {
                    "no answer".to_string()
                },
                run.unanchored_claims,
                run.withheld_claims,
                run.unrecognized_claims,
                run.invalid_citations.len()
            ));
        }
        out.push('\n');

        if !view.excluded_runs.is_empty() {
            out.push_str("### Excluded runs\n\n");
            for excluded in &view.excluded_runs {
                out.push_str(&format!(
                    "- `{}`: {}\n",
                    esc(&excluded.run_id),
                    esc(excluded.reason.as_str())
                ));
            }
            out.push('\n');
        }

        out.push_str(&format!(
            "Visible evidence never cited: {} of {}\n\n",
            view.uncited_visible_evidence.len(),
            view.visible_item_ids.len()
        ));

        out.push_str("### Honesty notes\n\n");
        for note in &view.notes {
            out.push_str(&format!("- {}\n", esc(note)));
        }
        out.push('\n');
    }
    Ok(out)
}

/// Serialize owner-only views as pretty JSON.
pub fn render_agreement_json(views: &[AgreementView]) -> BenchResult<String> {
    crate::canonical::to_pretty_json(&views)
}

/// Serialize share-safe views as pretty JSON, gated once more on the way out.
pub fn render_agreement_share_safe_json(views: &[ShareSafeAgreementView]) -> BenchResult<String> {
    let text = crate::canonical::to_pretty_json(&views)?;
    gate_share_safe_text(&text)?;
    Ok(text)
}

/// Render share-safe views as markdown carrying fingerprints only.
pub fn render_agreement_share_safe_markdown(
    views: &[ShareSafeAgreementView],
) -> BenchResult<String> {
    let esc = escape_report_value;
    let mut out = String::from("# Triage bench evidence agreement (share-safe)\n\n");
    out.push_str(&format!(
        "Schema: `{}`\n\n",
        esc(AGREEMENT_VIEW_SHARE_SAFE_SCHEMA_V1)
    ));
    if views.is_empty() {
        out.push_str("No stored runs to project.\n");
        return Ok(out);
    }
    for view in views {
        out.push_str(&format!(
            "## task `{}` snapshot `{}`\n\n",
            esc(&view.task_fingerprint),
            esc(&view.snapshot_fingerprint)
        ));
        out.push_str(&format!(
            "- runs: {}\n- visible evidence: {}\n- uncited visible evidence: {}\n\n",
            view.runs.len(),
            view.visible_item_count,
            view.uncited_visible_count
        ));
        out.push_str("| evidence | role | concurring | sources | models | independent |\n");
        out.push_str("| --- | --- | --- | --- | --- | --- |\n");
        for anchor in &view.anchors {
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} |\n",
                esc(&anchor.evidence_fingerprint),
                esc(anchor.role_bucket.as_str()),
                anchor.concurring_run_fingerprints.len(),
                anchor.distinct_source_count,
                anchor.distinct_model_identity_count,
                if anchor.independent { "yes" } else { "no" }
            ));
        }
        out.push('\n');
        out.push_str("### Honesty notes\n\n");
        for note in &view.notes {
            out.push_str(&format!("- {}\n", esc(note)));
        }
        out.push('\n');
    }
    let rendered = out;
    gate_share_safe_text(&rendered)?;
    Ok(rendered)
}

/// Convenience: project every owner-only view.
pub fn project_all_share_safe(views: &[AgreementView]) -> BenchResult<Vec<ShareSafeAgreementView>> {
    views.iter().map(project_agreement_share_safe).collect()
}
