//! Durable, corpus-scoped exact-template suppression rules.
//!
//! Suppression is a reversible query lens, never deletion. This module stores
//! only rule metadata, bounded redacted preview examples, and audit metadata in
//! a versioned corpus sidecar. Raw corpus events remain authoritative and are
//! never changed by any operation here.

use super::{classify_active_timestamp_basis, ActiveTimestampBasis, LogCorpus, TimeQuality};
use crate::error::{CoreError, CoreResult};
use crate::redact::redact_candidate;
use duckdb::params;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use uuid::{Uuid, Version};

/// Suppression sidecar schema understood by this build.
pub const SUPPRESSION_SCHEMA_VERSION: u32 = 1;
/// Maximum durable rules in one corpus.
pub const MAX_SUPPRESSION_RULES: usize = 1_024;
/// Maximum append-only audit records.
///
/// New previews/activations are refused before they could consume the capacity
/// reserved to disable and remove every live rule.
pub const MAX_SUPPRESSION_AUDIT_ENTRIES: usize = 4_096;
/// Maximum retained preview records. Normal mutations retain at most one current preview.
pub const MAX_SUPPRESSION_PREVIEWS: usize = 16;
/// Maximum representative events in one preview.
pub const MAX_SUPPRESSION_REPRESENTATIVES: usize = 3;
/// Maximum distinct level buckets in one preview.
pub const MAX_SUPPRESSION_LEVEL_BUCKETS: usize = 32;

const SIDECAR_FILENAME: &str = "suppression.json";
const LOCK_FILENAME: &str = ".suppression.lock";
const MAX_SIDECAR_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CORPUS_ID_BYTES: usize = 128;
const MAX_RULE_NAME_BYTES: usize = 128;
const MAX_RULE_RATIONALE_BYTES: usize = 2_048;
const MAX_TEMPLATE_FINGERPRINT_BYTES: usize = 256;
const MAX_SOURCE_IDENTITY_BYTES: usize = 1_024;
const MAX_LEVEL_BYTES: usize = 64;
const MAX_REDACTED_EXCERPT_BYTES: usize = 1_024;

static SUPPRESSION_MUTATION_LOCK: Mutex<()> = Mutex::new(());

struct SuppressionMutationGuard {
    _process_guard: MutexGuard<'static, ()>,
    _file: File,
}

/// Provenance of a proposed exact-template suppression rule.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionRuleOrigin {
    /// A person authored and explicitly confirmed the rule.
    Human,
    /// A deterministic detector proposed the rule for human review.
    DetectorProposal,
    /// A model proposed the rule for human review.
    ModelProposal,
}

/// Durable lifecycle of a suppression rule.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionRuleState {
    /// The rule participates in the current suppression lens.
    Enabled,
    /// The rule is retained but does not participate in the lens.
    Disabled,
    /// Inactive tombstone retained for auditability.
    Removed,
}

/// Exact template identity captured by preview and rule records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionTemplatePredicate {
    /// Corpus-local exact template identifier.
    pub template_id: u64,
    /// Trusted-core fingerprint of the exact template definition.
    pub template_fingerprint: String,
}

/// One bounded level-distribution bucket in a preview.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionLevelCount {
    /// Canonical or source level label.
    pub level: String,
    /// Exact event count for this level.
    pub count: u64,
}

/// Inclusive time span of the exact template matches.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionTimeSpan {
    /// Earliest timestamp/order value.
    pub from: i64,
    /// Latest timestamp/order value.
    pub to: i64,
}

/// Bounded, redacted representative identity for human preview.
///
/// This DTO deliberately has no evaluator-answer, expected-cause, or raw
/// parameter fields. `redacted_excerpt` is fetched and redacted by the trusted
/// core; callers cannot supply representative rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionRepresentativeEvent {
    /// Stable event sequence within the corpus.
    pub seq: u64,
    /// Relative source identity, never an absolute path.
    pub source: String,
    /// Timestamp/order value shown to the reviewer.
    pub timestamp: i64,
    /// Honesty classification for `timestamp`.
    pub time_quality: TimeQuality,
    /// Bounded level label.
    pub level: String,
    /// Bounded redacted excerpt; never evaluator truth.
    pub redacted_excerpt: String,
}

/// Human-authored input used to request a trusted-core suppression preview.
///
/// Counts, distributions, spans, overlap, and representative events are
/// intentionally absent. The core derives all of them from [`LogCorpus`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewSuppressionPreview {
    /// Required human-readable rule name.
    pub name: String,
    /// Required human-readable reason for suppressing the template.
    pub rationale: String,
    /// Corpus-local exact template identifier selected by the person.
    ///
    /// The trusted core derives its fingerprint; webview callers never echo
    /// or claim template integrity metadata.
    pub template_id: u64,
    /// Proposal provenance.
    pub origin: SuppressionRuleOrigin,
}

/// Durable preview record whose token is bound to corpus and revisions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionPreview {
    /// Opaque UUIDv7 token consumed by activation.
    pub token: String,
    /// Corpus owning the preview.
    pub corpus_id: String,
    /// Corpus event revision observed while computing preview facts.
    pub event_revision: u64,
    /// Suppression document revision published with this preview.
    pub rule_revision: u64,
    /// Required rule name.
    pub name: String,
    /// Required rule rationale.
    pub rationale: String,
    /// Exact template predicate.
    pub predicate: SuppressionTemplatePredicate,
    /// Proposal provenance.
    pub origin: SuppressionRuleOrigin,
    /// Exact raw-corpus matches.
    pub matching_event_count: u64,
    /// Incremental matches not already hidden.
    pub incremental_event_count: u64,
    /// Raw corpus count at preview time.
    pub corpus_event_count: u64,
    /// Complete level distribution.
    pub level_counts: Vec<SuppressionLevelCount>,
    /// Distinct source count.
    pub source_count: u64,
    /// Inclusive match span.
    pub time_span: SuppressionTimeSpan,
    /// Bounded redacted representatives.
    pub representatives: Vec<SuppressionRepresentativeEvent>,
    /// Creation time in Unix seconds.
    pub created_at: i64,
}

/// One durable exact-template suppression rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionRule {
    /// Stable UUIDv7 rule identity.
    pub id: String,
    /// Required human-readable name.
    pub name: String,
    /// Required human-readable rationale.
    pub rationale: String,
    /// Exact template predicate.
    pub predicate: SuppressionTemplatePredicate,
    /// Provenance retained from the accepted preview.
    pub origin: SuppressionRuleOrigin,
    /// Current lifecycle state.
    pub state: SuppressionRuleState,
    /// Creation time in Unix seconds.
    pub created_at: i64,
    /// Last mutation time in Unix seconds.
    pub updated_at: i64,
}

/// Audited suppression operation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionAuditAction {
    /// A bounded preview was computed and persisted.
    Previewed,
    /// A human-authored preview became an enabled rule.
    Activated,
    /// An enabled rule was disabled.
    Disabled,
    /// A disabled rule was re-enabled.
    Reenabled,
    /// A rule became an inactive tombstone.
    Removed,
}

/// Payload-free append-only audit record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionAuditEntry {
    /// Stable UUIDv7 audit identity.
    pub id: String,
    /// Document revision created by this operation.
    pub revision: u64,
    /// Operation kind.
    pub action: SuppressionAuditAction,
    /// Rule identity when one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    /// Preview token when the operation consumed or created one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_token: Option<String>,
    /// Operation time in Unix seconds.
    pub created_at: i64,
}

/// Versioned corpus sidecar body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionDocument {
    /// Schema version.
    pub schema_version: u32,
    /// Corpus owning this sidecar.
    pub corpus_id: String,
    /// Monotonic mutation revision. Missing sidecars begin at zero.
    pub revision: u64,
    /// Durable rules, including removed tombstones.
    #[serde(default)]
    pub rules: Vec<SuppressionRule>,
    /// Current and stale bounded previews.
    #[serde(default)]
    pub previews: Vec<SuppressionPreview>,
    /// Bounded append-only audit history.
    #[serde(default)]
    pub audit: Vec<SuppressionAuditEntry>,
}

impl SuppressionDocument {
    /// Return the authoritative exact-template exclusion lens.
    ///
    /// IDs are sorted and deduplicated. The query layer's smaller active-lens
    /// bound is enforced here; durable rule storage may be larger, but active
    /// rules are never silently truncated.
    pub fn enabled_template_ids(&self) -> CoreResult<Vec<u64>> {
        let mut template_ids = self
            .rules
            .iter()
            .filter(|rule| rule.state == SuppressionRuleState::Enabled)
            .map(|rule| rule.predicate.template_id)
            .collect::<Vec<_>>();
        template_ids.sort_unstable();
        template_ids.dedup();
        if template_ids.len() > super::query::MAX_EXCLUDED_TEMPLATE_IDS {
            return Err(CoreError::Message(format!(
                "active suppression lens has {} exact templates; query limit is {}",
                template_ids.len(),
                super::query::MAX_EXCLUDED_TEMPLATE_IDS
            )));
        }
        Ok(template_ids)
    }
}

/// Human activation request for one durable preview token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateSuppressionPreview {
    /// Durable preview token.
    pub preview_token: String,
}

/// Explicit human lifecycle mutation for an existing rule.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionRuleMutation {
    /// Enabled → disabled.
    Disable,
    /// Disabled → enabled.
    Reenable,
    /// Enabled/disabled → removed tombstone.
    Remove,
}

/// Result of an activation or lifecycle mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuppressionMutationResult {
    /// Published document revision.
    pub revision: u64,
    /// Rule after the mutation.
    pub rule: SuppressionRule,
}

struct ComputedPreviewFacts {
    event_revision: u64,
    matching_event_count: u64,
    incremental_event_count: u64,
    corpus_event_count: u64,
    level_counts: Vec<SuppressionLevelCount>,
    source_count: u64,
    time_span: SuppressionTimeSpan,
    representatives: Vec<SuppressionRepresentativeEvent>,
}

/// Load the suppression sidecar, returning an empty revision-zero document when absent.
pub fn load_suppression_document(corpus: &LogCorpus) -> CoreResult<SuppressionDocument> {
    let document = load_document_from_root(corpus.root(), corpus.id())?;
    validate_enabled_predicates(corpus, &document)?;
    Ok(document)
}

/// Persist a bounded preview against the current corpus event revision.
pub fn preview_template_suppression(
    corpus: &LogCorpus,
    expected_revision: u64,
    input: NewSuppressionPreview,
) -> CoreResult<SuppressionPreview> {
    preview_from_root(corpus, corpus.root(), corpus.id(), expected_revision, input)
}

/// Activate exactly one current, human-authored preview.
///
/// The current corpus event revision, rule revision, corpus identity, and
/// trusted-core template fingerprint must all still match.
pub fn activate_template_suppression(
    corpus: &LogCorpus,
    expected_revision: u64,
    input: ActivateSuppressionPreview,
) -> CoreResult<SuppressionMutationResult> {
    activate_from_root(corpus, corpus.root(), corpus.id(), expected_revision, input)
}

/// Apply an explicit lifecycle mutation using optimistic revision control.
pub fn mutate_template_suppression_rule(
    corpus: &LogCorpus,
    expected_revision: u64,
    rule_id: &str,
    mutation: SuppressionRuleMutation,
) -> CoreResult<SuppressionMutationResult> {
    mutate_rule_from_root(
        corpus,
        corpus.root(),
        corpus.id(),
        expected_revision,
        rule_id,
        mutation,
    )
}

fn empty_document(corpus_id: &str) -> SuppressionDocument {
    SuppressionDocument {
        schema_version: SUPPRESSION_SCHEMA_VERSION,
        corpus_id: corpus_id.to_string(),
        revision: 0,
        rules: Vec::new(),
        previews: Vec::new(),
        audit: Vec::new(),
    }
}

fn sidecar_path(corpus_root: &Path) -> PathBuf {
    corpus_root.join(SIDECAR_FILENAME)
}

fn lock_path(corpus_root: &Path) -> PathBuf {
    corpus_root.join(LOCK_FILENAME)
}

fn mutation_guard(corpus_root: &Path) -> CoreResult<SuppressionMutationGuard> {
    let process_guard = SUPPRESSION_MUTATION_LOCK
        .lock()
        .map_err(|_| CoreError::Message("suppression mutation lock is poisoned".into()))?;
    validate_corpus_root(corpus_root)?;
    let file = open_regular_nofollow(&lock_path(corpus_root), true, true)?;
    file.lock()
        .map_err(|error| CoreError::Message(format!("lock suppression policy: {error}")))?;
    Ok(SuppressionMutationGuard {
        _process_guard: process_guard,
        _file: file,
    })
}

fn preview_from_root(
    corpus: &LogCorpus,
    corpus_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    input: NewSuppressionPreview,
) -> CoreResult<SuppressionPreview> {
    validate_preview_input(&input)?;
    let _guard = mutation_guard(corpus_root)?;
    let mut document = load_document_from_root(corpus_root, corpus_id)?;
    require_revision(&document, expected_revision)?;
    ensure_audit_capacity_for(&document, 1, reversal_audit_reserve(&document.rules)?)?;
    let authoritative_predicate = authoritative_template_predicate(corpus, input.template_id)?;
    let facts = compute_preview_facts(corpus, &authoritative_predicate, &document.rules)?;
    let revision = next_revision(document.revision)?;
    let now = crate::embed::now_unix_secs();
    let preview = SuppressionPreview {
        token: Uuid::now_v7().to_string(),
        corpus_id: corpus_id.to_string(),
        event_revision: facts.event_revision,
        rule_revision: revision,
        name: input.name,
        rationale: input.rationale,
        predicate: authoritative_predicate,
        origin: input.origin,
        matching_event_count: facts.matching_event_count,
        incremental_event_count: facts.incremental_event_count,
        corpus_event_count: facts.corpus_event_count,
        level_counts: facts.level_counts,
        source_count: facts.source_count,
        time_span: facts.time_span,
        representatives: facts.representatives,
        created_at: now,
    };
    // Any older preview is revision-stale. Retain only the current bounded record.
    document.previews.clear();
    document.previews.push(preview.clone());
    document.revision = revision;
    document.audit.push(SuppressionAuditEntry {
        id: Uuid::now_v7().to_string(),
        revision,
        action: SuppressionAuditAction::Previewed,
        rule_id: None,
        preview_token: Some(preview.token.clone()),
        created_at: now,
    });
    write_document(corpus_root, &document)?;
    Ok(preview)
}

fn activate_from_root(
    corpus: &LogCorpus,
    corpus_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    input: ActivateSuppressionPreview,
) -> CoreResult<SuppressionMutationResult> {
    validate_uuid_v7("suppression preview token", &input.preview_token)?;
    let _guard = mutation_guard(corpus_root)?;
    let mut document = load_document_from_root(corpus_root, corpus_id)?;
    require_revision(&document, expected_revision)?;
    let next_reserve = reversal_audit_reserve(&document.rules)?
        .checked_add(2)
        .ok_or_else(|| CoreError::Message("suppression audit reserve overflow".into()))?;
    ensure_audit_capacity_for(&document, 1, next_reserve)?;
    let preview = document
        .previews
        .iter()
        .find(|preview| preview.token == input.preview_token)
        .cloned()
        .ok_or_else(|| {
            CoreError::Message("suppression preview token is missing or stale".into())
        })?;
    let current_predicate =
        authoritative_template_predicate(corpus, preview.predicate.template_id)?;
    if preview.corpus_id != corpus_id
        || preview.rule_revision != document.revision
        || preview.event_revision != corpus.event_revision()
        || preview.predicate != current_predicate
    {
        return Err(CoreError::Message(
            "suppression preview is stale; compute a new preview".into(),
        ));
    }
    if preview.origin != SuppressionRuleOrigin::Human {
        return Err(CoreError::Message(
            "detector/model proposals cannot activate suppression; a person must author and confirm a new preview".into(),
        ));
    }
    if document.rules.iter().any(|rule| {
        rule.state != SuppressionRuleState::Removed
            && rule.predicate.template_id == preview.predicate.template_id
    }) {
        return Err(CoreError::Message(
            "an active or disabled rule already owns this exact template predicate".into(),
        ));
    }

    let revision = next_revision(document.revision)?;
    let now = crate::embed::now_unix_secs();
    let rule = SuppressionRule {
        id: Uuid::now_v7().to_string(),
        name: preview.name,
        rationale: preview.rationale,
        predicate: preview.predicate,
        origin: preview.origin,
        state: SuppressionRuleState::Enabled,
        created_at: now,
        updated_at: now,
    };
    document.rules.push(rule.clone());
    document.previews.clear();
    document.revision = revision;
    document.audit.push(SuppressionAuditEntry {
        id: Uuid::now_v7().to_string(),
        revision,
        action: SuppressionAuditAction::Activated,
        rule_id: Some(rule.id.clone()),
        preview_token: Some(input.preview_token),
        created_at: now,
    });
    corpus.with_connection(|_| {
        if preview.event_revision != corpus.event_revision()
            || authoritative_template_predicate(corpus, rule.predicate.template_id)?
                != rule.predicate
        {
            return Err(CoreError::Message(
                "suppression preview became stale before activation publication".into(),
            ));
        }
        // Holding the event connection lock through durable publication keeps
        // an append from landing between the final revision check and write.
        write_document(corpus_root, &document)
    })?;
    Ok(SuppressionMutationResult { revision, rule })
}

fn mutate_rule_from_root(
    corpus: &LogCorpus,
    corpus_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    rule_id: &str,
    mutation: SuppressionRuleMutation,
) -> CoreResult<SuppressionMutationResult> {
    validate_uuid_v7("suppression rule id", rule_id)?;
    let _guard = mutation_guard(corpus_root)?;
    let mut document = load_document_from_root(corpus_root, corpus_id)?;
    require_revision(&document, expected_revision)?;
    let rule_index = document
        .rules
        .iter()
        .position(|rule| rule.id == rule_id)
        .ok_or_else(|| CoreError::Message(format!("suppression rule not found: {rule_id}")))?;
    let current_state = document.rules[rule_index].state;
    let (state, action) = match (current_state, mutation) {
        (SuppressionRuleState::Enabled, SuppressionRuleMutation::Disable) => (
            SuppressionRuleState::Disabled,
            SuppressionAuditAction::Disabled,
        ),
        (SuppressionRuleState::Disabled, SuppressionRuleMutation::Reenable) => (
            SuppressionRuleState::Enabled,
            SuppressionAuditAction::Reenabled,
        ),
        (
            SuppressionRuleState::Enabled | SuppressionRuleState::Disabled,
            SuppressionRuleMutation::Remove,
        ) => (
            SuppressionRuleState::Removed,
            SuppressionAuditAction::Removed,
        ),
        (SuppressionRuleState::Removed, _) => {
            return Err(CoreError::Message(
                "removed suppression rules are immutable tombstones".into(),
            ));
        }
        _ => {
            return Err(CoreError::Message(
                "suppression rule mutation does not match its current state".into(),
            ));
        }
    };
    if mutation == SuppressionRuleMutation::Reenable {
        let current = authoritative_template_predicate(
            corpus,
            document.rules[rule_index].predicate.template_id,
        )?;
        if current != document.rules[rule_index].predicate {
            return Err(CoreError::Message(
                "suppression rule is stale; its exact template changed while disabled".into(),
            ));
        }
    }
    let mut next_states = document
        .rules
        .iter()
        .map(|rule| rule.state)
        .collect::<Vec<_>>();
    next_states[rule_index] = state;
    ensure_audit_capacity_for(&document, 1, reversal_audit_reserve_states(&next_states)?)?;
    let revision = next_revision(document.revision)?;
    let now = crate::embed::now_unix_secs();
    let rule = &mut document.rules[rule_index];
    rule.state = state;
    rule.updated_at = now;
    let result_rule = rule.clone();
    document.previews.clear();
    document.revision = revision;
    document.audit.push(SuppressionAuditEntry {
        id: Uuid::now_v7().to_string(),
        revision,
        action,
        rule_id: Some(result_rule.id.clone()),
        preview_token: None,
        created_at: now,
    });
    write_document(corpus_root, &document)?;
    Ok(SuppressionMutationResult {
        revision,
        rule: result_rule,
    })
}

fn authoritative_template_predicate(
    corpus: &LogCorpus,
    template_id: u64,
) -> CoreResult<SuppressionTemplatePredicate> {
    if template_id == 0 || template_id > i64::MAX as u64 {
        return Err(CoreError::Message(
            "suppression template id is outside the supported range".into(),
        ));
    }
    let row = corpus
        .list_templates()
        .into_iter()
        .find(|row| row.info.template_id == template_id)
        .ok_or_else(|| {
            CoreError::Message(format!(
                "suppression template {template_id} is missing from the corpus"
            ))
        })?;
    let predicate = SuppressionTemplatePredicate {
        template_id,
        template_fingerprint: row.content_hash,
    };
    validate_predicate(&predicate)?;
    Ok(predicate)
}

fn validate_enabled_predicates(
    corpus: &LogCorpus,
    document: &SuppressionDocument,
) -> CoreResult<()> {
    for rule in document
        .rules
        .iter()
        .filter(|rule| rule.state == SuppressionRuleState::Enabled)
    {
        let current = authoritative_template_predicate(corpus, rule.predicate.template_id)?;
        if current != rule.predicate {
            return Err(CoreError::Message(format!(
                "enabled suppression rule {} is stale; exact template {} changed",
                rule.id, rule.predicate.template_id
            )));
        }
    }
    Ok(())
}

fn compute_preview_facts(
    corpus: &LogCorpus,
    predicate: &SuppressionTemplatePredicate,
    rules: &[SuppressionRule],
) -> CoreResult<ComputedPreviewFacts> {
    let template_id = i64::try_from(predicate.template_id)
        .map_err(|_| CoreError::Message("suppression template id exceeds i64".into()))?;
    let already_hidden = rules.iter().any(|rule| {
        rule.state == SuppressionRuleState::Enabled
            && rule.predicate.template_id == predicate.template_id
    });

    let facts = corpus.with_connection(|connection| {
        // Event appends publish their revision while holding this same
        // connection lock, so every fact below belongs to this exact snapshot.
        let event_revision = corpus.event_revision();
        let corpus_event_count = connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(suppression_duck_error)?
            .max(0) as u64;
        let (matching, source_count, span_from, span_to) = connection
            .query_row(
                "SELECT COUNT(*), COUNT(DISTINCT source), MIN(ts), MAX(ts) \
                 FROM events WHERE template_id = ?",
                params![template_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .map_err(suppression_duck_error)?;
        let matching_event_count = matching.max(0) as u64;
        if matching_event_count == 0 {
            return Err(CoreError::Message(format!(
                "suppression template {} has no authoritative events",
                predicate.template_id
            )));
        }
        let time_span = SuppressionTimeSpan {
            from: span_from.ok_or_else(|| {
                CoreError::Message("suppression preview has no minimum timestamp".into())
            })?,
            to: span_to.ok_or_else(|| {
                CoreError::Message("suppression preview has no maximum timestamp".into())
            })?,
        };

        let mut level_statement = connection
            .prepare(
                "SELECT level, COUNT(*) FROM events WHERE template_id = ? \
                 GROUP BY level ORDER BY LOWER(level), level",
            )
            .map_err(suppression_duck_error)?;
        let level_rows = level_statement
            .query_map(params![template_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                ))
            })
            .map_err(suppression_duck_error)?;
        let mut level_counts = Vec::new();
        for row in level_rows {
            let (level, count) = row.map_err(suppression_duck_error)?;
            level_counts.push(SuppressionLevelCount { level, count });
        }

        let mut representative_statement = connection
            .prepare(
                "SELECT seq, ts, level, message, source, active_timestamp_basis FROM events \
                 WHERE template_id = ? ORDER BY ts, seq LIMIT ?",
            )
            .map_err(suppression_duck_error)?;
        let representative_rows = representative_statement
            .query_map(
                params![template_id, MAX_SUPPRESSION_REPRESENTATIVES as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .map_err(suppression_duck_error)?;
        let mut representatives = Vec::new();
        for row in representative_rows {
            let (seq, timestamp, level, message, source, stored_provenance) =
                row.map_err(suppression_duck_error)?;
            let active_basis = ActiveTimestampBasis::from_storage_str(stored_provenance.as_deref())
                .ok_or_else(|| {
                    CoreError::Message("event has invalid active timestamp basis".into())
                })?;
            let seq = u64::try_from(seq).map_err(|_| {
                CoreError::Message("suppression representative has negative sequence".into())
            })?;
            let redaction = redact_candidate(&message);
            let redacted_excerpt = if redaction.blocked {
                "[credential-dominant event redacted]".to_string()
            } else {
                truncate_utf8_bytes(&redaction.text, MAX_REDACTED_EXCERPT_BYTES)
            };
            representatives.push(SuppressionRepresentativeEvent {
                seq,
                source,
                timestamp,
                time_quality: classify_active_timestamp_basis(active_basis),
                level,
                redacted_excerpt,
            });
        }
        if corpus.event_revision() != event_revision {
            return Err(CoreError::Message(
                "corpus changed while computing suppression preview".into(),
            ));
        }
        Ok(ComputedPreviewFacts {
            event_revision,
            matching_event_count,
            incremental_event_count: if already_hidden {
                0
            } else {
                matching_event_count
            },
            corpus_event_count,
            level_counts,
            source_count: source_count.max(0) as u64,
            time_span,
            representatives,
        })
    })?;

    // Template metadata uses a separate sidecar lock. Re-read it after the
    // event snapshot so a concurrent reanalysis cannot publish a plausible
    // preview under a changed fingerprint.
    if authoritative_template_predicate(corpus, predicate.template_id)? != *predicate {
        return Err(CoreError::Message(
            "suppression template changed while computing preview".into(),
        ));
    }
    validate_preview_facts(
        facts.matching_event_count,
        facts.incremental_event_count,
        facts.corpus_event_count,
        &facts.level_counts,
        facts.source_count,
        &facts.time_span,
        &facts.representatives,
    )?;
    Ok(facts)
}

fn suppression_duck_error(error: duckdb::Error) -> CoreError {
    CoreError::Message(format!("suppression preview query: {error}"))
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut output = String::with_capacity(max_bytes);
    for character in value.chars() {
        if output.len().saturating_add(character.len_utf8()) > max_bytes {
            break;
        }
        output.push(character);
    }
    output
}

fn load_document_from_root(corpus_root: &Path, corpus_id: &str) -> CoreResult<SuppressionDocument> {
    validate_corpus_root(corpus_root)?;
    validate_bounded_text("corpus id", corpus_id, MAX_CORPUS_ID_BYTES)?;
    let path = sidecar_path(corpus_root);
    let mut file = match open_regular_nofollow(&path, false, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_document(corpus_id));
        }
        Err(error) => {
            return Err(CoreError::Message(format!(
                "open suppression sidecar without following links: {error}"
            )));
        }
    };
    let metadata = file
        .metadata()
        .map_err(|error| CoreError::Message(format!("inspect suppression sidecar: {error}")))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(CoreError::Message(
            "suppression sidecar must be a regular non-symlink file".into(),
        ));
    }
    if metadata.len() > MAX_SIDECAR_BYTES {
        return Err(CoreError::Message(format!(
            "suppression sidecar exceeds {MAX_SIDECAR_BYTES} bytes"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_SIDECAR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CoreError::Message(format!("read suppression sidecar: {error}")))?;
    if bytes.len() as u64 > MAX_SIDECAR_BYTES {
        return Err(CoreError::Message(format!(
            "suppression sidecar exceeds {MAX_SIDECAR_BYTES} bytes"
        )));
    }
    let after = file
        .metadata()
        .map_err(|error| CoreError::Message(format!("reinspect suppression sidecar: {error}")))?;
    if after.len() != metadata.len() {
        return Err(CoreError::Message(
            "suppression sidecar changed while it was being read".into(),
        ));
    }
    let document: SuppressionDocument = serde_json::from_slice(&bytes)
        .map_err(|error| CoreError::Message(format!("parse suppression sidecar: {error}")))?;
    validate_document(&document, corpus_id)?;
    Ok(document)
}

fn open_regular_nofollow(path: &Path, read_write: bool, create: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(read_write).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "path is not a regular non-symlink file",
        ));
    }
    Ok(file)
}

fn write_document(corpus_root: &Path, document: &SuppressionDocument) -> CoreResult<()> {
    validate_corpus_root(corpus_root)?;
    validate_document(document, &document.corpus_id)?;
    let bytes = serde_json::to_vec_pretty(document)?;
    if bytes.len() as u64 > MAX_SIDECAR_BYTES {
        return Err(CoreError::Message(format!(
            "suppression sidecar exceeds {MAX_SIDECAR_BYTES} bytes"
        )));
    }
    let reparsed: SuppressionDocument = serde_json::from_slice(&bytes)?;
    if reparsed != *document {
        return Err(CoreError::Message(
            "suppression sidecar failed serialization validation".into(),
        ));
    }

    let target = sidecar_path(corpus_root);
    reject_unsafe_existing_sidecar(&target)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".suppression-")
        .tempfile_in(corpus_root)
        .map_err(|error| {
            CoreError::Message(format!("create suppression temporary file: {error}"))
        })?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| CoreError::Message(format!("write suppression sidecar: {error}")))?;
    // Recheck immediately before the fixed-name atomic publication.
    reject_unsafe_existing_sidecar(&target)?;
    let published = temporary.persist(&target).map_err(|error| {
        CoreError::Message(format!(
            "publish suppression sidecar atomically: {}",
            error.error
        ))
    })?;
    published
        .sync_all()
        .map_err(|error| CoreError::Message(format!("sync suppression sidecar: {error}")))?;
    sync_directory(corpus_root)?;

    let loaded = load_document_from_root(corpus_root, &document.corpus_id)?;
    if loaded != *document {
        return Err(CoreError::Message(
            "published suppression sidecar failed validation".into(),
        ));
    }
    Ok(())
}

fn validate_document(document: &SuppressionDocument, expected_corpus_id: &str) -> CoreResult<()> {
    if document.schema_version > SUPPRESSION_SCHEMA_VERSION {
        return Err(CoreError::Message(format!(
            "suppression schema version {} is newer than supported version {SUPPRESSION_SCHEMA_VERSION}",
            document.schema_version
        )));
    }
    if document.schema_version != SUPPRESSION_SCHEMA_VERSION {
        return Err(CoreError::Message(format!(
            "suppression schema version {} is unsupported",
            document.schema_version
        )));
    }
    validate_bounded_text("corpus id", &document.corpus_id, MAX_CORPUS_ID_BYTES)?;
    if document.corpus_id != expected_corpus_id {
        return Err(CoreError::Message(
            "suppression sidecar corpus id does not match its corpus".into(),
        ));
    }
    if document.rules.len() > MAX_SUPPRESSION_RULES {
        return Err(CoreError::Message(format!(
            "suppression sidecar exceeds {MAX_SUPPRESSION_RULES} rules"
        )));
    }
    if document.previews.len() > MAX_SUPPRESSION_PREVIEWS {
        return Err(CoreError::Message(format!(
            "suppression sidecar exceeds {MAX_SUPPRESSION_PREVIEWS} previews"
        )));
    }
    if document.audit.len() > MAX_SUPPRESSION_AUDIT_ENTRIES {
        return Err(CoreError::Message(format!(
            "suppression sidecar exceeds {MAX_SUPPRESSION_AUDIT_ENTRIES} audit entries"
        )));
    }

    let mut rule_ids = HashSet::new();
    for rule in &document.rules {
        validate_uuid_v7("suppression rule id", &rule.id)?;
        if !rule_ids.insert(rule.id.as_str()) {
            return Err(CoreError::Message(format!(
                "suppression sidecar repeats rule id {}",
                rule.id
            )));
        }
        validate_rule_fields(&rule.name, &rule.rationale, &rule.predicate)?;
        if rule.created_at > rule.updated_at {
            return Err(CoreError::Message(format!(
                "suppression rule {} updated_at precedes created_at",
                rule.id
            )));
        }
        if rule.state == SuppressionRuleState::Enabled
            && rule.origin != SuppressionRuleOrigin::Human
        {
            return Err(CoreError::Message(
                "enabled suppression rules must be human-authored".into(),
            ));
        }
    }
    ensure_audit_capacity_for(document, 0, reversal_audit_reserve(&document.rules)?)?;

    let mut preview_tokens = HashSet::new();
    for preview in &document.previews {
        validate_uuid_v7("suppression preview token", &preview.token)?;
        if !preview_tokens.insert(preview.token.as_str()) {
            return Err(CoreError::Message(format!(
                "suppression sidecar repeats preview token {}",
                preview.token
            )));
        }
        if preview.corpus_id != document.corpus_id {
            return Err(CoreError::Message(
                "suppression preview belongs to another corpus".into(),
            ));
        }
        if preview.rule_revision == 0 || preview.rule_revision > document.revision {
            return Err(CoreError::Message(
                "suppression preview has an invalid rule revision".into(),
            ));
        }
        validate_preview_fields(preview)?;
    }

    let mut audit_ids = HashSet::new();
    let mut previous_revision = 0u64;
    for entry in &document.audit {
        validate_uuid_v7("suppression audit id", &entry.id)?;
        if !audit_ids.insert(entry.id.as_str()) {
            return Err(CoreError::Message(format!(
                "suppression sidecar repeats audit id {}",
                entry.id
            )));
        }
        if entry.revision == 0
            || entry.revision <= previous_revision
            || entry.revision > document.revision
        {
            return Err(CoreError::Message(
                "suppression audit revisions must be strictly increasing and published".into(),
            ));
        }
        previous_revision = entry.revision;
        if let Some(rule_id) = entry.rule_id.as_deref() {
            validate_uuid_v7("suppression audit rule id", rule_id)?;
        }
        if let Some(token) = entry.preview_token.as_deref() {
            validate_uuid_v7("suppression audit preview token", token)?;
        }
    }
    if document.revision == 0
        && (!document.rules.is_empty()
            || !document.previews.is_empty()
            || !document.audit.is_empty())
    {
        return Err(CoreError::Message(
            "revision-zero suppression document must be empty".into(),
        ));
    }
    if document.revision > 0
        && document
            .audit
            .last()
            .is_none_or(|entry| entry.revision != document.revision)
    {
        return Err(CoreError::Message(
            "suppression document revision must match its latest audit entry".into(),
        ));
    }
    Ok(())
}

fn validate_preview_input(input: &NewSuppressionPreview) -> CoreResult<()> {
    validate_bounded_text("suppression rule name", &input.name, MAX_RULE_NAME_BYTES)?;
    validate_bounded_text(
        "suppression rule rationale",
        &input.rationale,
        MAX_RULE_RATIONALE_BYTES,
    )?;
    if input.template_id == 0 || input.template_id > i64::MAX as u64 {
        return Err(CoreError::Message(
            "suppression template id is outside the supported range".into(),
        ));
    }
    Ok(())
}

fn validate_preview_fields(preview: &SuppressionPreview) -> CoreResult<()> {
    validate_rule_fields(&preview.name, &preview.rationale, &preview.predicate)?;
    validate_preview_facts(
        preview.matching_event_count,
        preview.incremental_event_count,
        preview.corpus_event_count,
        &preview.level_counts,
        preview.source_count,
        &preview.time_span,
        &preview.representatives,
    )
}

fn validate_preview_facts(
    matching_event_count: u64,
    incremental_event_count: u64,
    corpus_event_count: u64,
    level_counts: &[SuppressionLevelCount],
    source_count: u64,
    time_span: &SuppressionTimeSpan,
    representatives: &[SuppressionRepresentativeEvent],
) -> CoreResult<()> {
    if matching_event_count == 0 || matching_event_count > corpus_event_count {
        return Err(CoreError::Message(
            "suppression preview matches must be within 1..=corpus event count".into(),
        ));
    }
    if incremental_event_count > matching_event_count {
        return Err(CoreError::Message(
            "suppression incremental count exceeds matching count".into(),
        ));
    }
    if source_count == 0 || source_count > matching_event_count {
        return Err(CoreError::Message(
            "suppression source count must be within 1..=matching count".into(),
        ));
    }
    if time_span.from > time_span.to {
        return Err(CoreError::Message(
            "suppression preview time span is reversed".into(),
        ));
    }
    if level_counts.is_empty() || level_counts.len() > MAX_SUPPRESSION_LEVEL_BUCKETS {
        return Err(CoreError::Message(format!(
            "suppression level distribution must contain 1..={MAX_SUPPRESSION_LEVEL_BUCKETS} buckets"
        )));
    }
    let mut levels = HashSet::new();
    let mut level_total = 0u64;
    for bucket in level_counts {
        validate_bounded_text("suppression level", &bucket.level, MAX_LEVEL_BYTES)?;
        if bucket.count == 0 {
            return Err(CoreError::Message(
                "suppression level counts must be positive".into(),
            ));
        }
        if !levels.insert(bucket.level.to_ascii_lowercase()) {
            return Err(CoreError::Message(
                "suppression level distribution repeats a level".into(),
            ));
        }
        level_total = level_total
            .checked_add(bucket.count)
            .ok_or_else(|| CoreError::Message("suppression level count overflow".into()))?;
    }
    if level_total != matching_event_count {
        return Err(CoreError::Message(
            "suppression level distribution does not equal matching count".into(),
        ));
    }
    if representatives.is_empty() || representatives.len() > MAX_SUPPRESSION_REPRESENTATIVES {
        return Err(CoreError::Message(format!(
            "suppression preview must contain 1..={MAX_SUPPRESSION_REPRESENTATIVES} representatives"
        )));
    }
    let mut representative_seqs = HashSet::new();
    for representative in representatives {
        if !representative_seqs.insert(representative.seq) {
            return Err(CoreError::Message(
                "suppression preview repeats a representative event".into(),
            ));
        }
        validate_source_identity(&representative.source)?;
        validate_bounded_text(
            "suppression representative level",
            &representative.level,
            MAX_LEVEL_BYTES,
        )?;
        validate_optional_bounded_text(
            "suppression redacted excerpt",
            &representative.redacted_excerpt,
            MAX_REDACTED_EXCERPT_BYTES,
        )?;
    }
    Ok(())
}

fn validate_rule_fields(
    name: &str,
    rationale: &str,
    predicate: &SuppressionTemplatePredicate,
) -> CoreResult<()> {
    validate_bounded_text("suppression rule name", name, MAX_RULE_NAME_BYTES)?;
    validate_bounded_text(
        "suppression rule rationale",
        rationale,
        MAX_RULE_RATIONALE_BYTES,
    )?;
    validate_predicate(predicate)
}

fn validate_predicate(predicate: &SuppressionTemplatePredicate) -> CoreResult<()> {
    if predicate.template_id == 0 || predicate.template_id > i64::MAX as u64 {
        return Err(CoreError::Message(
            "suppression template id must be within 1..=i64::MAX".into(),
        ));
    }
    validate_bounded_text(
        "suppression template fingerprint",
        &predicate.template_fingerprint,
        MAX_TEMPLATE_FINGERPRINT_BYTES,
    )
}

fn validate_bounded_text(kind: &str, value: &str, max_bytes: usize) -> CoreResult<()> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(CoreError::Message(format!(
            "{kind} must contain 1..={max_bytes} nonblank UTF-8 bytes"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(CoreError::Message(format!(
            "{kind} contains unsupported control characters"
        )));
    }
    Ok(())
}

fn validate_optional_bounded_text(kind: &str, value: &str, max_bytes: usize) -> CoreResult<()> {
    if value.len() > max_bytes {
        return Err(CoreError::Message(format!(
            "{kind} exceeds {max_bytes} UTF-8 bytes"
        )));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(CoreError::Message(format!(
            "{kind} contains unsupported control characters"
        )));
    }
    Ok(())
}

fn validate_source_identity(source: &str) -> CoreResult<()> {
    validate_bounded_text(
        "suppression representative source",
        source,
        MAX_SOURCE_IDENTITY_BYTES,
    )?;
    let bytes = source.as_bytes();
    let windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let portable_traversal = source.split(['/', '\\']).any(|component| component == "..");
    let path = Path::new(source);
    if path.is_absolute()
        || source.starts_with(['/', '\\'])
        || windows_absolute
        || portable_traversal
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreError::Message(
            "suppression representative source must be a relative identity".into(),
        ));
    }
    Ok(())
}

fn validate_corpus_root(corpus_root: &Path) -> CoreResult<()> {
    let metadata = std::fs::symlink_metadata(corpus_root)
        .map_err(|error| CoreError::Message(format!("inspect suppression corpus root: {error}")))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(CoreError::Message(
            "suppression corpus root must be a real directory".into(),
        ));
    }
    Ok(())
}

fn reject_unsafe_existing_sidecar(path: &Path) -> CoreResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            Err(CoreError::Message(
                "suppression sidecar must be a regular non-symlink file".into(),
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CoreError::Message(format!(
            "inspect suppression sidecar: {error}"
        ))),
    }
}

fn validate_uuid_v7(kind: &str, value: &str) -> CoreResult<()> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| CoreError::Message(format!("{kind} must be a UUIDv7")))?;
    if uuid.get_version() != Some(Version::SortRand) {
        return Err(CoreError::Message(format!("{kind} must be a UUIDv7")));
    }
    Ok(())
}

fn require_revision(document: &SuppressionDocument, expected_revision: u64) -> CoreResult<()> {
    if document.revision != expected_revision {
        return Err(CoreError::Message(format!(
            "stale suppression revision: expected {expected_revision}, current {}",
            document.revision
        )));
    }
    Ok(())
}

fn next_revision(current: u64) -> CoreResult<u64> {
    current
        .checked_add(1)
        .ok_or_else(|| CoreError::Message("suppression revision overflow".into()))
}

fn reversal_audit_reserve(rules: &[SuppressionRule]) -> CoreResult<usize> {
    reversal_audit_reserve_states(&rules.iter().map(|rule| rule.state).collect::<Vec<_>>())
}

fn reversal_audit_reserve_states(states: &[SuppressionRuleState]) -> CoreResult<usize> {
    states.iter().try_fold(0usize, |reserve, state| {
        let additional = match state {
            SuppressionRuleState::Enabled => 2,
            SuppressionRuleState::Disabled => 1,
            SuppressionRuleState::Removed => 0,
        };
        reserve
            .checked_add(additional)
            .ok_or_else(|| CoreError::Message("suppression audit reserve overflow".into()))
    })
}

fn ensure_audit_capacity_for(
    document: &SuppressionDocument,
    entries_to_append: usize,
    reversal_reserve_after: usize,
) -> CoreResult<()> {
    let required = document
        .audit
        .len()
        .checked_add(entries_to_append)
        .and_then(|value| value.checked_add(reversal_reserve_after))
        .ok_or_else(|| CoreError::Message("suppression audit capacity overflow".into()))?;
    if required > MAX_SUPPRESSION_AUDIT_ENTRIES {
        return Err(CoreError::Message(format!(
            "suppression audit cannot publish this operation: {required} entries including lifecycle reserve exceeds {MAX_SUPPRESSION_AUDIT_ENTRIES}"
        )));
    }
    Ok(())
}

fn sync_directory(_directory: &Path) -> CoreResult<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(_directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| CoreError::Message(format!("sync suppression directory: {error}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::drain::TemplateInfo;
    use crate::log_analysis::query::fetch_events_by_seqs;
    use crate::log_analysis::{LogEvent, TemplateRow, TimestampProvenance};
    use std::process::Command;
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    const RAW_SENTINEL: &str = "RAW_EVIDENCE_MUST_REMAIN_UNCHANGED";

    fn corpus(cache: &tempfile::TempDir) -> LogCorpus {
        let corpus = LogCorpus::create(cache.path(), "suppression tests").unwrap();
        corpus
            .push_events(&[LogEvent {
                seq: 1,
                ts: 1_700_000_000,
                timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                unresolved_local_timestamp: None,
                level: "info".into(),
                service: Some("worker".into()),
                host: Some("host-1".into()),
                template_id: 7,
                params: vec!["parameter".into()],
                trace_id: None,
                message: RAW_SENTINEL.into(),
                source: "worker/app.log".into(),
            }])
            .unwrap();
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 7,
                    pattern: "routine health <*>".into(),
                    token_count: 3,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000,
                    severity: 1,
                    example: "routine health check".into(),
                },
                content_hash: "sha256:template-seven".into(),
                vector: None,
            }])
            .unwrap();
        corpus
    }

    fn preview_input(origin: SuppressionRuleOrigin) -> NewSuppressionPreview {
        NewSuppressionPreview {
            name: "Routine health check".into(),
            rationale: "Reviewed repetitive success traffic".into(),
            template_id: 7,
            origin,
        }
    }

    fn activate_input(preview: &SuppressionPreview) -> ActivateSuppressionPreview {
        ActivateSuppressionPreview {
            preview_token: preview.token.clone(),
        }
    }

    fn activated_rule(corpus: &LogCorpus) -> SuppressionMutationResult {
        let preview =
            preview_template_suppression(corpus, 0, preview_input(SuppressionRuleOrigin::Human))
                .unwrap();
        activate_template_suppression(corpus, 1, activate_input(&preview)).unwrap()
    }

    #[test]
    fn validation_rejects_blank_fields_unknown_template_and_non_human_activation() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);

        for mutate in [
            |input: &mut NewSuppressionPreview| input.name = " ".into(),
            |input: &mut NewSuppressionPreview| input.rationale = "\t".into(),
            |input: &mut NewSuppressionPreview| input.template_id = 0,
        ] {
            let mut input = preview_input(SuppressionRuleOrigin::Human);
            mutate(&mut input);
            assert!(preview_template_suppression(&corpus, 0, input).is_err());
        }

        let mut missing = preview_input(SuppressionRuleOrigin::Human);
        missing.template_id = 999;
        assert!(preview_template_suppression(&corpus, 0, missing).is_err());

        let proposal = preview_template_suppression(
            &corpus,
            0,
            preview_input(SuppressionRuleOrigin::ModelProposal),
        )
        .unwrap();
        let error = activate_template_suppression(&corpus, 1, activate_input(&proposal))
            .unwrap_err()
            .to_string();
        assert!(error.contains("cannot activate"));
        assert!(load_suppression_document(&corpus).unwrap().rules.is_empty());
    }

    #[test]
    fn preview_facts_and_representatives_are_computed_from_authoritative_events() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        corpus
            .push_events(&[
                LogEvent {
                    seq: 2,
                    ts: 1_700_000_005,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "warn".into(),
                    service: None,
                    host: None,
                    template_id: 7,
                    params: vec![],
                    trace_id: None,
                    message: "Bearer tokentokentoken".into(),
                    source: "api/app.log".into(),
                },
                LogEvent {
                    seq: 3,
                    ts: 1_700_000_006,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: None,
                    host: None,
                    template_id: 8,
                    params: vec![],
                    trace_id: None,
                    message: "unrelated".into(),
                    source: "api/app.log".into(),
                },
            ])
            .unwrap();

        let preview =
            preview_template_suppression(&corpus, 0, preview_input(SuppressionRuleOrigin::Human))
                .unwrap();
        assert_eq!(
            preview.predicate,
            SuppressionTemplatePredicate {
                template_id: 7,
                template_fingerprint: "sha256:template-seven".into()
            }
        );
        assert_eq!(preview.matching_event_count, 2);
        assert_eq!(preview.incremental_event_count, 2);
        assert_eq!(preview.corpus_event_count, 3);
        assert_eq!(preview.source_count, 2);
        assert_eq!(
            preview.time_span,
            SuppressionTimeSpan {
                from: 1_700_000_000,
                to: 1_700_000_005
            }
        );
        assert_eq!(
            preview.level_counts,
            vec![
                SuppressionLevelCount {
                    level: "info".into(),
                    count: 1
                },
                SuppressionLevelCount {
                    level: "warn".into(),
                    count: 1
                }
            ]
        );
        assert_eq!(preview.representatives.len(), 2);
        assert_ne!(
            preview.representatives[1].redacted_excerpt,
            "Bearer tokentokentoken"
        );
        assert!(!preview.representatives[1]
            .redacted_excerpt
            .contains("tokentokentoken"));
    }

    #[test]
    fn restart_persists_uuidv7_rule_and_preserves_raw_evidence() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let corpus_id = corpus.id().to_string();
        let before = fetch_events_by_seqs(&corpus, &[1]).unwrap();
        let activated = activated_rule(&corpus);
        assert_eq!(
            Uuid::parse_str(&activated.rule.id).unwrap().get_version(),
            Some(Version::SortRand)
        );
        let after = fetch_events_by_seqs(&corpus, &[1]).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before[0].seq, after[0].seq);
        assert_eq!(before[0].message, after[0].message);
        assert_eq!(before[0].source, after[0].source);
        assert_eq!(after[0].message, RAW_SENTINEL);
        corpus.flush().unwrap();
        drop(corpus);

        let reopened = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let document = load_suppression_document(&reopened).unwrap();
        assert_eq!(document.revision, 2);
        assert_eq!(document.rules, vec![activated.rule]);
        assert_eq!(document.audit.len(), 2);
    }

    #[test]
    fn future_schema_version_is_refused() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let body = serde_json::json!({
            "schemaVersion": SUPPRESSION_SCHEMA_VERSION + 1,
            "corpusId": corpus.id(),
            "revision": 0,
            "rules": [],
            "previews": [],
            "audit": []
        });
        std::fs::write(
            sidecar_path(corpus.root()),
            serde_json::to_vec_pretty(&body).unwrap(),
        )
        .unwrap();
        let error = load_suppression_document(&corpus).unwrap_err().to_string();
        assert!(error.contains("newer than supported"));
    }

    #[test]
    fn concurrent_expected_revision_allows_exactly_one_winner() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = Arc::new(corpus(&cache));
        let activated = activated_rule(&corpus);
        let root = corpus.root().to_path_buf();
        let corpus_id = corpus.id().to_string();
        let rule_id = activated.rule.id;
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for mutation in [
            SuppressionRuleMutation::Disable,
            SuppressionRuleMutation::Remove,
        ] {
            let root = root.clone();
            let corpus_id = corpus_id.clone();
            let rule_id = rule_id.clone();
            let barrier = Arc::clone(&barrier);
            let corpus = Arc::clone(&corpus);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                mutate_rule_from_root(&corpus, &root, &corpus_id, 2, &rule_id, mutation)
            }));
        }
        barrier.wait();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(
            load_document_from_root(&root, &corpus_id).unwrap().revision,
            3
        );
    }

    #[test]
    fn suppression_lock_child_process() {
        let Ok(root) = std::env::var("CONTEXTDESK_SUPPRESSION_LOCK_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        std::fs::write(root.join("child-ready"), b"ready").unwrap();
        let _guard = mutation_guard(&root).unwrap();
        std::fs::write(root.join("child-acquired"), b"acquired").unwrap();
    }

    #[test]
    fn mutation_guard_serializes_a_separate_process() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let guard = mutation_guard(corpus.root()).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("log_analysis::suppression::tests::suppression_lock_child_process")
            .arg("--exact")
            .env("CONTEXTDESK_SUPPRESSION_LOCK_TEST_ROOT", corpus.root())
            .spawn()
            .unwrap();

        let ready = corpus.root().join("child-ready");
        for _ in 0..500 {
            if ready.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child test did not reach the lock attempt");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!corpus.root().join("child-acquired").exists());
        assert!(child.try_wait().unwrap().is_none());

        drop(guard);
        assert!(child.wait().unwrap().success());
        assert!(corpus.root().join("child-acquired").exists());
    }

    #[test]
    fn activation_rejects_stale_event_revision_rule_revision_and_predicate() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let preview =
            preview_template_suppression(&corpus, 0, preview_input(SuppressionRuleOrigin::Human))
                .unwrap();

        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 7,
                    pattern: "changed <*>".into(),
                    token_count: 2,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000,
                    severity: 1,
                    example: "changed".into(),
                },
                content_hash: "sha256:changed-template".into(),
                vector: None,
            }])
            .unwrap();
        assert!(activate_template_suppression(&corpus, 1, activate_input(&preview)).is_err());
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 7,
                    pattern: "routine health <*>".into(),
                    token_count: 3,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000,
                    severity: 1,
                    example: "routine health check".into(),
                },
                content_hash: "sha256:template-seven".into(),
                vector: None,
            }])
            .unwrap();

        corpus
            .push_events(&[LogEvent {
                seq: 2,
                ts: 1_700_000_001,
                timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                unresolved_local_timestamp: None,
                level: "info".into(),
                service: None,
                host: None,
                template_id: 8,
                params: vec![],
                trace_id: None,
                message: "new event".into(),
                source: "worker/app.log".into(),
            }])
            .unwrap();
        let error = activate_template_suppression(&corpus, 1, activate_input(&preview))
            .unwrap_err()
            .to_string();
        assert!(error.contains("stale"));

        let refreshed =
            preview_template_suppression(&corpus, 1, preview_input(SuppressionRuleOrigin::Human))
                .unwrap();
        assert!(activate_template_suppression(&corpus, 1, activate_input(&refreshed)).is_err());
    }

    #[test]
    fn enabled_and_reenabled_rules_fail_closed_when_the_template_changes() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let activated = activated_rule(&corpus);
        let changed_template = TemplateRow {
            info: TemplateInfo {
                template_id: 7,
                pattern: "different evidence <*>".into(),
                token_count: 3,
                count: 1,
                first_seen: 1_700_000_000,
                last_seen: 1_700_000_000,
                severity: 4,
                example: "different evidence".into(),
            },
            content_hash: "sha256:different-template".into(),
            vector: None,
        };
        corpus.upsert_templates([changed_template.clone()]).unwrap();
        let error = load_suppression_document(&corpus).unwrap_err().to_string();
        assert!(error.contains("enabled suppression rule"));
        assert!(error.contains("is stale"));

        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 7,
                    pattern: "routine health <*>".into(),
                    token_count: 3,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000,
                    severity: 1,
                    example: "routine health check".into(),
                },
                content_hash: "sha256:template-seven".into(),
                vector: None,
            }])
            .unwrap();
        let disabled = mutate_template_suppression_rule(
            &corpus,
            activated.revision,
            &activated.rule.id,
            SuppressionRuleMutation::Disable,
        )
        .unwrap();
        corpus.upsert_templates([changed_template]).unwrap();
        let error = mutate_template_suppression_rule(
            &corpus,
            disabled.revision,
            &activated.rule.id,
            SuppressionRuleMutation::Reenable,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("changed while disabled"));
        let stored = load_document_from_root(corpus.root(), corpus.id()).unwrap();
        assert_eq!(stored.revision, disabled.revision);
        assert_eq!(stored.rules[0].state, SuppressionRuleState::Disabled);
    }

    #[test]
    fn corrupted_sidecar_rejects_template_ids_above_signed_storage_range() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let body = serde_json::json!({
            "schemaVersion": SUPPRESSION_SCHEMA_VERSION,
            "corpusId": corpus.id(),
            "revision": 1,
            "rules": [{
                "id": Uuid::now_v7().to_string(),
                "name": "Invalid range",
                "rationale": "Crafted sidecar",
                "predicate": {
                    "templateId": u64::MAX,
                    "templateFingerprint": "sha256:invalid"
                },
                "origin": "human",
                "state": "enabled",
                "createdAt": 1,
                "updatedAt": 1
            }],
            "previews": [],
            "audit": [{
                "id": Uuid::now_v7().to_string(),
                "revision": 1,
                "action": "activated",
                "ruleId": Uuid::now_v7().to_string(),
                "createdAt": 1
            }]
        });
        std::fs::write(
            sidecar_path(corpus.root()),
            serde_json::to_vec_pretty(&body).unwrap(),
        )
        .unwrap();
        let error = load_suppression_document(&corpus).unwrap_err().to_string();
        assert!(error.contains("1..=i64::MAX"));
    }

    #[test]
    fn disabled_reenabled_and_removed_rules_retain_history() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let activated = activated_rule(&corpus);
        let disabled = mutate_template_suppression_rule(
            &corpus,
            2,
            &activated.rule.id,
            SuppressionRuleMutation::Disable,
        )
        .unwrap();
        assert_eq!(disabled.rule.state, SuppressionRuleState::Disabled);
        let reenabled = mutate_template_suppression_rule(
            &corpus,
            3,
            &activated.rule.id,
            SuppressionRuleMutation::Reenable,
        )
        .unwrap();
        assert_eq!(reenabled.rule.state, SuppressionRuleState::Enabled);
        let removed = mutate_template_suppression_rule(
            &corpus,
            4,
            &activated.rule.id,
            SuppressionRuleMutation::Remove,
        )
        .unwrap();
        assert_eq!(removed.rule.state, SuppressionRuleState::Removed);
        assert!(mutate_template_suppression_rule(
            &corpus,
            5,
            &activated.rule.id,
            SuppressionRuleMutation::Reenable
        )
        .is_err());

        let document = load_suppression_document(&corpus).unwrap();
        assert_eq!(document.revision, 5);
        assert_eq!(document.rules.len(), 1);
        assert_eq!(document.rules[0].state, SuppressionRuleState::Removed);
        assert_eq!(
            document
                .audit
                .iter()
                .map(|entry| entry.action)
                .collect::<Vec<_>>(),
            vec![
                SuppressionAuditAction::Previewed,
                SuppressionAuditAction::Activated,
                SuppressionAuditAction::Disabled,
                SuppressionAuditAction::Reenabled,
                SuppressionAuditAction::Removed,
            ]
        );
    }

    #[test]
    fn enabled_template_lens_is_sorted_deduplicated_and_refuses_query_overflow() {
        let make_rule = |template_id: u64| SuppressionRule {
            id: Uuid::now_v7().to_string(),
            name: format!("Rule {template_id}"),
            rationale: "Reviewed exact template".into(),
            predicate: SuppressionTemplatePredicate {
                template_id,
                template_fingerprint: format!("fingerprint-{template_id}"),
            },
            origin: SuppressionRuleOrigin::Human,
            state: SuppressionRuleState::Enabled,
            created_at: 1,
            updated_at: 1,
        };
        let mut document = empty_document("corpus");
        document.rules = vec![make_rule(9), make_rule(2), make_rule(9), make_rule(5)];
        assert_eq!(document.enabled_template_ids().unwrap(), vec![2, 5, 9]);

        document.rules = (1..=(super::super::query::MAX_EXCLUDED_TEMPLATE_IDS as u64 + 1))
            .map(make_rule)
            .collect();
        let error = document.enabled_template_ids().unwrap_err().to_string();
        assert!(error.contains("query limit"));
    }

    #[test]
    fn audit_capacity_reserves_disable_and_remove_for_every_live_rule() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        let rule = SuppressionRule {
            id: Uuid::now_v7().to_string(),
            name: "Bounded rule".into(),
            rationale: "Audit capacity test".into(),
            predicate: SuppressionTemplatePredicate {
                template_id: 7,
                template_fingerprint: "sha256:template-seven".into(),
            },
            origin: SuppressionRuleOrigin::Human,
            state: SuppressionRuleState::Enabled,
            created_at: 1,
            updated_at: 1,
        };
        let starting_revision = MAX_SUPPRESSION_AUDIT_ENTRIES - 2;
        let audit = (1..=starting_revision)
            .map(|revision| SuppressionAuditEntry {
                id: Uuid::now_v7().to_string(),
                revision: revision as u64,
                action: SuppressionAuditAction::Previewed,
                rule_id: None,
                preview_token: Some(Uuid::now_v7().to_string()),
                created_at: revision as i64,
            })
            .collect::<Vec<_>>();
        let document = SuppressionDocument {
            schema_version: SUPPRESSION_SCHEMA_VERSION,
            corpus_id: corpus.id().to_string(),
            revision: starting_revision as u64,
            rules: vec![rule.clone()],
            previews: Vec::new(),
            audit,
        };
        write_document(corpus.root(), &document).unwrap();
        let error = preview_template_suppression(
            &corpus,
            document.revision,
            preview_input(SuppressionRuleOrigin::Human),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("lifecycle reserve"));

        let disabled = mutate_template_suppression_rule(
            &corpus,
            document.revision,
            &rule.id,
            SuppressionRuleMutation::Disable,
        )
        .unwrap();
        let removed = mutate_template_suppression_rule(
            &corpus,
            disabled.revision,
            &rule.id,
            SuppressionRuleMutation::Remove,
        )
        .unwrap();
        assert_eq!(removed.revision as usize, MAX_SUPPRESSION_AUDIT_ENTRIES);
        assert_eq!(removed.rule.state, SuppressionRuleState::Removed);
        assert_eq!(
            load_suppression_document(&corpus).unwrap().audit.len(),
            MAX_SUPPRESSION_AUDIT_ENTRIES
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_safety_rejects_traversal_and_symlink_sidecar() {
        use std::os::unix::fs::symlink;

        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(&cache);
        corpus
            .push_events(&[LogEvent {
                seq: 2,
                ts: 1_700_000_001,
                timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                unresolved_local_timestamp: None,
                level: "info".into(),
                service: None,
                host: None,
                template_id: 7,
                params: vec![],
                trace_id: None,
                message: "unsafe source".into(),
                source: "../outside.log".into(),
            }])
            .unwrap();
        assert!(preview_template_suppression(
            &corpus,
            0,
            preview_input(SuppressionRuleOrigin::Human)
        )
        .is_err());

        let outside = cache.path().join("outside.json");
        std::fs::write(&outside, b"outside").unwrap();
        symlink(&outside, sidecar_path(corpus.root())).unwrap();
        let error = load_suppression_document(&corpus).unwrap_err().to_string();
        assert!(error.contains("without following links"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");

        std::fs::remove_file(sidecar_path(corpus.root())).unwrap();
        symlink(
            cache.path().join("missing-target.json"),
            sidecar_path(corpus.root()),
        )
        .unwrap();
        let error = load_suppression_document(&corpus).unwrap_err().to_string();
        assert!(error.contains("without following links"));

        std::fs::remove_file(sidecar_path(corpus.root())).unwrap();
        std::fs::remove_file(lock_path(corpus.root())).unwrap();
        symlink(&outside, lock_path(corpus.root())).unwrap();
        let error =
            preview_template_suppression(&corpus, 0, preview_input(SuppressionRuleOrigin::Human))
                .unwrap_err()
                .to_string();
        assert!(error.contains("open") || error.contains("link"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    }
}
