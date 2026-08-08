//! Strict, host-validated investigation answer contract.
//!
//! Model JSON is only a proposal.  Evidence metadata, citations, acceptance,
//! and turn binding are created by the host and never accepted from the model.

#![allow(missing_docs)] // DTO field names are the external schema contract.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Stable schema for model proposals and validated answers.
pub const SCHEMA_V1: &str = "contextdesk.investigation_answer.v1";

/// Exact log-analysis snapshot which grounds one typed answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LogSnapshotRevisionV1 {
    pub event_revision: u64,
    pub template_analysis_revision: u64,
    pub suppression_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimKind {
    Observation,
    Symptom,
    CausalCandidate,
    InitiatingCause,
    CompetingExplanation,
    MissingEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRole {
    Cause,
    Supporting,
    Symptom,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Supported,
    Unsupported,
    Withheld,
}

/// The only model-owned claim fields.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelClaimV1 {
    pub claim_id: String,
    pub text: String,
    pub evidence_ids: Vec<String>,
}

/// The only model-owned candidate fields.  Section fixes claim kind by shape.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCandidateV1 {
    pub candidate_id: String,
    #[serde(default)]
    pub observations: Vec<ModelClaimV1>,
    #[serde(default)]
    pub symptoms: Vec<ModelClaimV1>,
    #[serde(default)]
    pub causal_candidates: Vec<ModelClaimV1>,
    #[serde(default)]
    pub initiating_causes: Vec<ModelClaimV1>,
    #[serde(default)]
    pub competing_explanations: Vec<ModelClaimV1>,
    #[serde(default)]
    pub missing_evidence: Vec<ModelClaimV1>,
}

/// Strict single-object model proposal.  Host-owned fields are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInvestigationAnswerV1 {
    pub schema: String,
    pub candidates: Vec<ModelCandidateV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationClaimV1 {
    pub claim_id: String,
    pub claim_kind: ClaimKind,
    pub text: String,
    pub candidate_id: String,
    pub evidence_ids: Vec<String>,
    pub status: ClaimStatus,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationCandidateV1 {
    pub candidate_id: String,
    pub claims: Vec<InvestigationClaimV1>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalCitationV1 {
    pub evidence_id: String,
    pub candidate_id: String,
    pub source_label: String,
    pub locator: String,
    pub corpus_id: String,
    pub revision: LogSnapshotRevisionV1,
    /// Host-owned bounded excerpt used by future renderers.
    pub content: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationAnswerV1 {
    pub schema: String,
    pub candidates: Vec<InvestigationCandidateV1>,
    pub canonical_citations: Vec<CanonicalCitationV1>,
    pub root_cause_established: bool,
}

/// Host-owned row, immutable for the turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostEvidenceEntry {
    pub evidence_id: String,
    pub candidate_id: String,
    pub source_label: String,
    pub locator: String,
    pub corpus_id: String,
    pub revision: LogSnapshotRevisionV1,
    pub role: EvidenceRole,
    /// Host-owned bounded excerpt; never supplied by the model.
    pub content: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerBindingV1 {
    pub session_id: String,
    pub turn_id: String,
    pub corpus_id: String,
    pub revision: LogSnapshotRevisionV1,
    pub ledger_digest: String,
}
/// Persistable authoritative state for later host-only CLI/GUI/session lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerEnvelopeV1 {
    pub binding: AnswerBindingV1,
    pub evidence: Vec<HostEvidenceEntry>,
    pub answer: InvestigationAnswerV1,
    pub semantic_attempts: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    Parse,
    Schema,
    DuplicateId,
    UnknownEvidence,
    WrongScope,
    WrongRevision,
    EmptyEvidence,
    RootRole,
    EmptyLedger,
    InvalidBinding,
    DigestMismatch,
}

#[derive(Debug, Clone)]
pub struct HostEvidenceLedger {
    binding: AnswerBindingV1,
    entries: BTreeMap<String, HostEvidenceEntry>,
}
impl HostEvidenceLedger {
    pub fn new(
        binding: AnswerBindingV1,
        evidence: Vec<HostEvidenceEntry>,
    ) -> Result<Self, ValidationError> {
        if binding.session_id.trim().is_empty()
            || binding.turn_id.trim().is_empty()
            || binding.corpus_id.trim().is_empty()
            || binding.ledger_digest.trim().is_empty()
        {
            return Err(ValidationError::InvalidBinding);
        }
        if evidence.is_empty() {
            return Err(ValidationError::EmptyLedger);
        }
        let mut entries = BTreeMap::new();
        for entry in evidence {
            if entry.evidence_id.trim().is_empty() {
                return Err(ValidationError::DuplicateId);
            }
            if entries.insert(entry.evidence_id.clone(), entry).is_some() {
                return Err(ValidationError::DuplicateId);
            }
        }
        let canonical = entries.values().cloned().collect::<Vec<_>>();
        if binding.ledger_digest != Self::digest(&canonical) {
            return Err(ValidationError::DigestMismatch);
        }
        // Every row is persisted in the authoritative envelope, including
        // rows the model elects not to cite. Bind the complete ledger here so
        // an unreferenced stale or cross-corpus row cannot bypass the
        // claim-level checks in `validate_model_answer`.
        for entry in entries.values() {
            if entry.candidate_id.trim().is_empty() {
                return Err(ValidationError::WrongScope);
            }
            if entry.corpus_id != binding.corpus_id || entry.revision != binding.revision {
                return Err(ValidationError::WrongRevision);
            }
        }
        Ok(Self { binding, entries })
    }
    pub fn binding(&self) -> &AnswerBindingV1 {
        &self.binding
    }
    pub fn digest(entries: &[HostEvidenceEntry]) -> String {
        let mut rows = entries.to_vec();
        rows.sort_by(|a, b| a.evidence_id.cmp(&b.evidence_id));
        let mut h = Sha256::new();
        for e in rows {
            h.update([match e.role {
                EvidenceRole::Cause => 1,
                EvidenceRole::Supporting => 2,
                EvidenceRole::Symptom => 3,
                EvidenceRole::Neutral => 4,
            }]);
            for part in [
                &e.evidence_id,
                &e.candidate_id,
                &e.source_label,
                &e.locator,
                &e.corpus_id,
                &e.content,
            ] {
                h.update(part.as_bytes());
                h.update([0]);
            }
            h.update(e.revision.event_revision.to_le_bytes());
            h.update(e.revision.template_analysis_revision.to_le_bytes());
            h.update(e.revision.suppression_revision.to_le_bytes());
        }
        format!("{:x}", h.finalize())
    }
    pub fn entries(&self) -> Vec<HostEvidenceEntry> {
        self.entries.values().cloned().collect()
    }
    /// Look up one host evidence row by id. Used by multi-model stage
    /// validators to reject any id the host did not create, exactly as
    /// [`validate_model_answer`] does for the final synthesis.
    pub fn get(&self, evidence_id: &str) -> Option<&HostEvidenceEntry> {
        self.entries.get(evidence_id)
    }
    /// The exact set of candidate ids the host bound into this ledger.
    pub fn candidate_ids(&self) -> BTreeSet<String> {
        self.entries
            .values()
            .map(|entry| entry.candidate_id.clone())
            .collect()
    }
}

/// Parse exactly one JSON object; no fences, prefixes, schema defaults, or embeds.
pub fn parse_model_json(raw: &str) -> Result<ModelInvestigationAnswerV1, ValidationError> {
    let value: ModelInvestigationAnswerV1 =
        serde_json::from_str(raw).map_err(|_| ValidationError::Parse)?;
    if value.schema != SCHEMA_V1 {
        return Err(ValidationError::Schema);
    }
    Ok(value)
}

/// Validate a proposal against the exact immutable host ledger and derive all authority.
pub fn validate_model_answer(
    raw: &str,
    ledger: &HostEvidenceLedger,
) -> Result<AnswerEnvelopeV1, ValidationError> {
    if ledger.entries.is_empty() {
        return Err(ValidationError::EmptyLedger);
    }
    let proposal = parse_model_json(raw)?;
    let mut candidate_ids = BTreeSet::new();
    let mut claim_ids = BTreeSet::new();
    let mut citations = BTreeMap::new();
    let mut candidates = Vec::new();
    let mut root = false;
    for candidate in proposal.candidates {
        if candidate.candidate_id.is_empty()
            || !candidate_ids.insert(candidate.candidate_id.clone())
        {
            return Err(ValidationError::DuplicateId);
        }
        let mut claims = Vec::new();
        for (kind, section) in [
            (ClaimKind::Observation, candidate.observations),
            (ClaimKind::Symptom, candidate.symptoms),
            (ClaimKind::CausalCandidate, candidate.causal_candidates),
            (ClaimKind::InitiatingCause, candidate.initiating_causes),
            (
                ClaimKind::CompetingExplanation,
                candidate.competing_explanations,
            ),
            (ClaimKind::MissingEvidence, candidate.missing_evidence),
        ] {
            for model_claim in section {
                if model_claim.claim_id.is_empty()
                    || !claim_ids.insert(model_claim.claim_id.clone())
                {
                    return Err(ValidationError::DuplicateId);
                }
                let mut ids = BTreeSet::new();
                if model_claim.evidence_ids.is_empty() && kind != ClaimKind::MissingEvidence {
                    return Err(ValidationError::EmptyEvidence);
                }
                for id in &model_claim.evidence_ids {
                    if !ids.insert(id.clone()) {
                        return Err(ValidationError::DuplicateId);
                    }
                    let entry = ledger
                        .entries
                        .get(id)
                        .ok_or(ValidationError::UnknownEvidence)?;
                    if entry.candidate_id != candidate.candidate_id {
                        return Err(ValidationError::WrongScope);
                    }
                    if entry.corpus_id != ledger.binding.corpus_id
                        || entry.revision != ledger.binding.revision
                    {
                        return Err(ValidationError::WrongRevision);
                    }
                    citations
                        .entry(id.clone())
                        .or_insert_with(|| CanonicalCitationV1 {
                            evidence_id: entry.evidence_id.clone(),
                            candidate_id: entry.candidate_id.clone(),
                            source_label: entry.source_label.clone(),
                            locator: entry.locator.clone(),
                            corpus_id: entry.corpus_id.clone(),
                            revision: entry.revision,
                            content: entry.content.clone(),
                        });
                }
                let cause_root = kind == ClaimKind::InitiatingCause
                    && model_claim.evidence_ids.iter().any(|id| {
                        ledger
                            .entries
                            .get(id)
                            .is_some_and(|e| e.role == EvidenceRole::Cause)
                    });
                let status = if kind == ClaimKind::InitiatingCause && !cause_root {
                    ClaimStatus::Withheld
                } else {
                    ClaimStatus::Supported
                };
                root |= cause_root;
                claims.push(InvestigationClaimV1 {
                    claim_id: model_claim.claim_id,
                    claim_kind: kind,
                    text: model_claim.text,
                    candidate_id: candidate.candidate_id.clone(),
                    evidence_ids: model_claim.evidence_ids,
                    status,
                });
            }
        }
        candidates.push(InvestigationCandidateV1 {
            candidate_id: candidate.candidate_id,
            claims,
        });
    }
    let ledger_candidates = ledger
        .entries
        .values()
        .map(|entry| entry.candidate_id.clone())
        .collect::<BTreeSet<_>>();
    if candidate_ids != ledger_candidates {
        return Err(ValidationError::WrongScope);
    }
    Ok(AnswerEnvelopeV1 {
        binding: ledger.binding.clone(),
        evidence: ledger.entries(),
        answer: InvestigationAnswerV1 {
            schema: SCHEMA_V1.into(),
            candidates,
            canonical_citations: citations.into_values().collect(),
            root_cause_established: root,
        },
        semantic_attempts: 0,
    })
}

pub fn authoritative_json(envelope: &AnswerEnvelopeV1) -> String {
    serde_json::to_string(&envelope.answer).unwrap_or_else(|_| "{}".into())
}

/// Unicode formatting controls that can reorder or re-anchor a rendered line
/// without being visible: the bidi overrides, embeddings, isolates, and the
/// directional marks. Their only effect on a log excerpt or an identifier is
/// to make what a reader sees differ from what the bytes say, which is exactly
/// the property a presentation boundary must remove.
const BIDI_FORMATTING_CONTROLS: [char; 12] = [
    '\u{061c}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}', '\u{202e}',
    '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
];

/// Whether `c` is one of [`BIDI_FORMATTING_CONTROLS`].
///
/// Exposed so a host's own terminal or webview boundary applies the same set
/// as this projection instead of keeping a second, drifting copy.
pub fn is_bidi_formatting_control(c: char) -> bool {
    BIDI_FORMATTING_CONTROLS.contains(&c)
}

/// Whether `c` starts or ends a line, paragraph, or column in some renderer.
///
/// Exposed so validators that must *reject* (not merely re-render) a value
/// smuggling a line break — e.g. a model-authored id printed into a
/// host-scaffolding prompt region — share the exact same notion the display
/// boundary uses.
pub fn is_line_boundary(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\t' | '\u{000b}' | '\u{000c}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
    )
}

/// Reduce one untrusted value to a single line of literal display text.
///
/// Applies to *every* dynamic string the projection shows — model-authored
/// claim text and host-owned-but-corpus-derived strings alike (identifiers,
/// source labels, locators, excerpts). Host-owned does not mean trustworthy as
/// presentation: a source label is whatever the imported log called itself.
///
/// Three deliberate normalizations, in order:
///
/// 1. **Every line, paragraph, and column boundary becomes one space.** This
///    is the load-bearing one. A value that cannot contain a line break cannot
///    begin a line, and every block construct in Markdown — heading, list
///    item, table row, fence, block quote — as well as every host status line
///    this projection emits, is line-anchored. One rule removes the whole
///    class, with no knowledge of any construct.
/// 2. **C0, C1, and DEL are removed.** That covers ESC, so ANSI/OSC sequences
///    (including OSC 8 hyperlinks) can never survive into a terminal, and the
///    single-byte C1 CSI introducer with them.
/// 3. **Bidi formatting controls are removed** ([`BIDI_FORMATTING_CONTROLS`]),
///    so displayed order matches byte order.
///
/// A backtick becomes a straight apostrophe, because the caller renders the
/// result inside a code span and a backtick is the one character that could
/// close it early. Replacing rather than deleting keeps quoted prose readable.
///
/// Everything else is preserved, including non-ASCII letters, emoji, and
/// combining marks: this is a control-character and line-structure boundary,
/// not a character allowlist.
pub fn literal_display_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut pending_space = false;
    for c in raw.chars() {
        if is_line_boundary(c) || c == ' ' {
            pending_space = !out.is_empty();
            continue;
        }
        if c.is_control() || c == '\u{007f}' || BIDI_FORMATTING_CONTROLS.contains(&c) {
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(if c == '`' { '\'' } else { c });
    }
    out
}

/// Placeholder shown when a value carried nothing displayable.
///
/// Host-owned static text, so an emptied value can never render as an empty
/// code span (which is not a code span at all) or vanish silently.
const EMPTY_VALUE_PLACEHOLDER: &str = "(empty)";

/// Render one untrusted value as literal display text inside a code span.
///
/// The code span is the boundary that survives a Markdown renderer: its
/// content is by definition literal, so no emphasis, link, autolink, citation
/// chip, or HTML can be formed from a dynamic value. [`literal_display_text`]
/// has already removed the one character able to close the span early, so the
/// value cannot escape it.
///
/// Every dynamic value in the projection goes through here. The visible
/// backticks are the point as much as the safety is: a reader can see exactly
/// where host-owned structure stops and quoted, untrusted content starts.
///
/// Exposed so every host renderer of untrusted values — the multi-model
/// review projection included — uses the exact same boundary instead of
/// keeping a second, drifting copy.
pub fn literal_span(raw: &str) -> String {
    let normalized = literal_display_text(raw);
    if normalized.is_empty() {
        return EMPTY_VALUE_PLACEHOLDER.to_string();
    }
    format!("`{normalized}`")
}

/// Human-readable label for a claim kind.
///
/// Host-owned presentation of a fixed enum — not a domain word list, and not
/// derived from any corpus text. Renaming every claim, evidence row, and log
/// term in a corpus leaves these labels unchanged.
fn claim_kind_label(kind: ClaimKind) -> &'static str {
    match kind {
        ClaimKind::Observation => "Observations",
        ClaimKind::Symptom => "Symptoms",
        ClaimKind::CausalCandidate => "Causal candidates",
        ClaimKind::InitiatingCause => "Initiating causes",
        ClaimKind::CompetingExplanation => "Competing explanations",
        ClaimKind::MissingEvidence => "Missing evidence",
    }
}

/// Fixed render order for claim kinds — the same order
/// [`validate_model_answer`] consumes the proposal's sections in.
const CLAIM_KIND_RENDER_ORDER: [ClaimKind; 6] = [
    ClaimKind::Observation,
    ClaimKind::Symptom,
    ClaimKind::CausalCandidate,
    ClaimKind::InitiatingCause,
    ClaimKind::CompetingExplanation,
    ClaimKind::MissingEvidence,
];

/// Explicit status marker for a claim the host did not accept as supported.
///
/// `Supported` renders unmarked; every other status is named in the visible
/// text, so a withheld initiating cause can never read as an established one.
fn claim_status_marker(status: ClaimStatus) -> Option<&'static str> {
    match status {
        ClaimStatus::Supported => None,
        ClaimStatus::Unsupported => Some("**[unsupported]**"),
        ClaimStatus::Withheld => Some("**[withheld]**"),
    }
}

/// Whether the citation line already states everything `content` would add.
///
/// The host excerpt is optional and some ledgers populate it with the same
/// identity the citation line already prints. Repeating it would be noise, so
/// it is shown only when it carries tokens the line does not.
fn excerpt_adds_information(content: &str, already_shown: &str) -> bool {
    let shown = already_shown.to_ascii_lowercase();
    let shown_tokens = shown
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<BTreeSet<_>>();
    content
        .to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .any(|token| !shown_tokens.contains(token))
}

/// Deterministic, host-owned Markdown projection of a validated envelope.
///
/// This is the *display* contract for [`InvestigationAnswerV1`]; the typed
/// event and [`authoritative_json`] remain the machine and persistence
/// contract. Nothing ever parses this text back into authority — a later turn
/// builds a fresh ledger — so the projection is free to be readable.
///
/// Guarantees, all of which are gated:
///
/// * every displayed citation is an entry of `canonical_citations`; claim
///   `evidence_ids` are only ever *looked up* there, never printed raw;
/// * candidate and claim-kind separation is preserved — no claim is shown
///   outside its candidate, and no kind is merged into another;
/// * a claim whose host status is not `Supported` carries a visible marker;
/// * root-cause establishment is printed from `root_cause_established` alone;
/// * no confidence value is invented — V1 validates none, and the output says
///   so rather than leaving a reader to assume one;
/// * output is stable under input ordering: candidates, claims, evidence ids,
///   and citations are ordered by their host-owned identifiers, so a permuted
///   envelope renders byte-identically. V1 carries no rank, so imposing an
///   identifier order is the only ordering the host can honestly display.
pub fn render_answer_markdown(envelope: &AnswerEnvelopeV1) -> String {
    let citations: BTreeMap<&str, &CanonicalCitationV1> = envelope
        .answer
        .canonical_citations
        .iter()
        .map(|citation| (citation.evidence_id.as_str(), citation))
        .collect();

    let mut out = String::from("# Investigation answer\n\n");
    out.push_str(&format!(
        "- Root cause established: {}\n",
        if envelope.answer.root_cause_established {
            "yes"
        } else {
            "no"
        }
    ));
    // V1 has no validated confidence field. Saying so is the honest option;
    // omitting the line silently would invite the reader to supply one.
    out.push_str("- Confidence: not rated by this contract\n");
    out.push_str(&format!(
        "- Evidence snapshot: corpus {} · events {} · template analysis {} · suppression {}\n",
        literal_span(&envelope.binding.corpus_id),
        envelope.binding.revision.event_revision,
        envelope.binding.revision.template_analysis_revision,
        envelope.binding.revision.suppression_revision,
    ));

    let mut candidates = envelope.answer.candidates.iter().collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    if candidates.is_empty() {
        out.push_str("\nNo candidate was reported for this turn.\n");
    }
    let mut displayed_evidence: BTreeSet<&str> = BTreeSet::new();
    for candidate in candidates {
        out.push_str(&format!(
            "\n## Candidate {}\n",
            literal_span(&candidate.candidate_id)
        ));
        let mut rendered_any = false;
        for kind in CLAIM_KIND_RENDER_ORDER {
            let mut claims = candidate
                .claims
                .iter()
                .filter(|claim| claim.claim_kind == kind)
                .collect::<Vec<_>>();
            if claims.is_empty() {
                continue;
            }
            claims.sort_by(|left, right| left.claim_id.cmp(&right.claim_id));
            rendered_any = true;
            // Bold labels, not headings: the legacy structured-triage parser
            // keys on normalized headings, and these two answer contracts must
            // stay visibly and mechanically separate.
            out.push_str(&format!("\n**{}**\n\n", claim_kind_label(kind)));
            for claim in claims {
                out.push_str("- ");
                if let Some(marker) = claim_status_marker(claim.status) {
                    out.push_str(marker);
                    out.push(' ');
                }
                out.push_str(&literal_span(&claim.text));
                let mut cited = claim
                    .evidence_ids
                    .iter()
                    .filter(|id| citations.contains_key(id.as_str()))
                    .map(String::as_str)
                    .collect::<Vec<_>>();
                cited.sort_unstable();
                cited.dedup();
                if !cited.is_empty() {
                    let rendered = cited
                        .iter()
                        .map(|id| literal_span(id))
                        .collect::<Vec<_>>()
                        .join(", ");
                    out.push_str(&format!(" — cites {rendered}"));
                    displayed_evidence.extend(cited);
                } else if !claim.evidence_ids.is_empty() {
                    // Only reachable for an envelope that did not come from
                    // `validate_model_answer`; never silently drop the gap.
                    out.push_str(" — no host citation available");
                }
                out.push('\n');
            }
        }
        if !rendered_any {
            out.push_str("\nNo claims were reported for this candidate.\n");
        }
    }

    if !displayed_evidence.is_empty() {
        out.push_str("\n## Evidence\n\n");
        for evidence_id in &displayed_evidence {
            let Some(citation) = citations.get(evidence_id) else {
                continue;
            };
            let line = format!(
                "- {} — {} · {}",
                literal_span(&citation.evidence_id),
                literal_span(&citation.source_label),
                literal_span(&citation.locator)
            );
            out.push_str(&line);
            if citation.corpus_id != envelope.binding.corpus_id
                || citation.revision != envelope.binding.revision
            {
                out.push_str(" · outside this turn's evidence snapshot");
            }
            let excerpt = literal_display_text(&citation.content);
            if !excerpt.is_empty() && excerpt_adds_information(&excerpt, &line) {
                out.push_str(&format!("\n  - {}", literal_span(&excerpt)));
            }
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn revision() -> LogSnapshotRevisionV1 {
        LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        }
    }
    fn ledger() -> HostEvidenceLedger {
        ledger_with_roles(EvidenceRole::Cause, EvidenceRole::Symptom)
    }
    fn ledger_with_roles(role_a: EvidenceRole, role_b: EvidenceRole) -> HostEvidenceLedger {
        let evidence = vec![
            HostEvidenceEntry {
                evidence_id: "e-a".into(),
                candidate_id: "a".into(),
                source_label: "one".into(),
                locator: "line 1".into(),
                corpus_id: "c".into(),
                revision: revision(),
                role: role_a,
                content: "host excerpt one".into(),
            },
            HostEvidenceEntry {
                evidence_id: "e-b".into(),
                candidate_id: "b".into(),
                source_label: "two".into(),
                locator: "line 2".into(),
                corpus_id: "c".into(),
                revision: revision(),
                role: role_b,
                content: "host excerpt two".into(),
            },
        ];
        let binding = AnswerBindingV1 {
            session_id: "s".into(),
            turn_id: "t".into(),
            corpus_id: "c".into(),
            revision: revision(),
            ledger_digest: HostEvidenceLedger::digest(&evidence),
        };
        HostEvidenceLedger::new(binding, evidence).unwrap()
    }
    fn proposal(body: &str) -> String {
        format!(r#"{{"schema":"{SCHEMA_V1}","candidates":[{body}]}}"#)
    }
    #[test]
    fn strict_and_host_owned_fields_rejected() {
        assert!(parse_model_json("```json {} ```").is_err());
        assert!(parse_model_json(&format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[],"canonical_citations":[]}}"#
        ))
        .is_err());
    }
    #[test]
    fn forged_scope_revision_and_duplicates_fail() {
        let l = ledger();
        for b in [
            r#"{"candidate_id":"a","observations":[{"claim_id":"x","text":"x","evidence_ids":["fake"]}]}"#,
            r#"{"candidate_id":"a","observations":[{"claim_id":"x","text":"x","evidence_ids":["e-b"]}]}"#,
            r#"{"candidate_id":"a","observations":[{"claim_id":"x","text":"x","evidence_ids":["e-a","e-a"]}]}"#,
        ] {
            assert!(validate_model_answer(&proposal(b), &l).is_err());
        }
        let mut stale = l.entries();
        stale[0].revision.event_revision += 1;
        let mut stale_binding = l.binding().clone();
        stale_binding.ledger_digest = HostEvidenceLedger::digest(&stale);
        assert!(matches!(
            HostEvidenceLedger::new(stale_binding, stale),
            Err(ValidationError::WrongRevision)
        ));
    }
    #[test]
    fn duplicate_candidate_and_claim_ids_fail() {
        let l = ledger();
        let duplicate_candidate = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"one","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"a","observations":[{{"claim_id":"two","text":"x","evidence_ids":["e-a"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&duplicate_candidate, &l),
            Err(ValidationError::DuplicateId)
        );
        let duplicate_claim = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"same","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"same","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&duplicate_claim, &l),
            Err(ValidationError::DuplicateId)
        );
    }
    #[test]
    fn empty_or_unbound_ledger_is_never_authoritative() {
        let empty = HostEvidenceLedger::new(
            AnswerBindingV1 {
                session_id: "s".into(),
                turn_id: "t".into(),
                corpus_id: "c".into(),
                revision: revision(),
                ledger_digest: "x".into(),
            },
            Vec::new(),
        );
        assert!(matches!(empty, Err(ValidationError::EmptyLedger)));
        let mut binding = ledger().binding().clone();
        binding.turn_id.clear();
        assert!(matches!(
            HostEvidenceLedger::new(binding, ledger().entries()),
            Err(ValidationError::InvalidBinding)
        ));
    }
    #[test]
    fn digest_binds_every_rendered_host_fact_and_round_trips_envelope() {
        let l = ledger();
        for change in 0..4 {
            let mut rows = l.entries();
            match change {
                0 => rows[0].source_label.push('x'),
                1 => rows[0].locator.push('x'),
                2 => rows[0].role = EvidenceRole::Supporting,
                _ => rows[0].content.push('x'),
            }
            assert!(matches!(
                HostEvidenceLedger::new(l.binding().clone(), rows),
                Err(ValidationError::DigestMismatch)
            ));
        }
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"a","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"b","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        let envelope = validate_model_answer(&raw, &l).unwrap();
        let round_trip: AnswerEnvelopeV1 =
            serde_json::from_str(&serde_json::to_string(&envelope).unwrap()).unwrap();
        assert_eq!(round_trip, envelope);
        let event = crate::events::StreamEvent::InvestigationAnswer { envelope };
        let event_round_trip: crate::events::StreamEvent =
            serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        match event_round_trip {
            crate::events::StreamEvent::InvestigationAnswer { envelope: got } => {
                assert_eq!(got, round_trip);
            }
            other => panic!("expected typed envelope event, got {other:?}"),
        }
    }
    #[test]
    fn root_is_withheld_for_symptom_only() {
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"a","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","initiating_causes":[{{"claim_id":"x","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        let e = validate_model_answer(&raw, &ledger()).unwrap();
        assert!(!e.answer.root_cause_established);
        assert_eq!(
            e.answer.candidates[1].claims[0].status,
            ClaimStatus::Withheld
        );
    }
    #[test]
    fn supporting_only_discloses_but_never_establishes_root() {
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","initiating_causes":[{{"claim_id":"root-a","text":"candidate root","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"obs-b","text":"observation","evidence_ids":["e-b"]}}]}}]}}"#
        );
        let envelope = validate_model_answer(
            &raw,
            &ledger_with_roles(EvidenceRole::Supporting, EvidenceRole::Neutral),
        )
        .unwrap();
        assert!(!envelope.answer.root_cause_established);
        assert_eq!(
            envelope.answer.candidates[0].claims[0].status,
            ClaimStatus::Withheld
        );
    }
    #[test]
    fn cause_establishes_only_its_candidate_scoped_claim() {
        let valid = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","initiating_causes":[{{"claim_id":"root-a","text":"candidate root","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"obs-b","text":"observation","evidence_ids":["e-b"]}}]}}]}}"#
        );
        let envelope = validate_model_answer(&valid, &ledger()).unwrap();
        assert!(envelope.answer.root_cause_established);
        assert_eq!(
            envelope.answer.candidates[0].claims[0].status,
            ClaimStatus::Supported
        );

        let transplanted = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"obs-a","text":"observation","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","initiating_causes":[{{"claim_id":"root-b","text":"candidate root","evidence_ids":["e-a"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&transplanted, &ledger()),
            Err(ValidationError::WrongScope)
        );
    }
    // -----------------------------------------------------------------
    // Host Markdown projection (`render_answer_markdown`).
    //
    // These gates are V1-native and vocabulary-neutral: no gate depends on
    // any incident word, log term, or corpus content. Every identifier below
    // is deliberately meaningless.
    // -----------------------------------------------------------------

    /// Evidence ids the rendered text actually shows the reader.
    ///
    /// Span-aware: the host's `— cites` grammar and the Evidence section are
    /// read from the text *outside* code spans, so a dynamic value that
    /// spells out the same grammar contributes nothing. Cited ids are the
    /// span values positioned after the host marker on that line.
    fn displayed_evidence_ids(markdown: &str) -> BTreeSet<String> {
        let mut ids = BTreeSet::new();
        let mut in_evidence = false;
        for line in markdown.lines() {
            let (outside, values) = split_spans(line);
            let trimmed = outside.trim();
            if trimmed == "## Evidence" {
                in_evidence = true;
                continue;
            }
            if trimmed.starts_with("## ") || trimmed.starts_with("# ") {
                in_evidence = false;
            }
            if let Some((before, _)) = outside.split_once("— cites ") {
                let already = before.matches(VALUE_SLOT).count();
                ids.extend(values.iter().skip(already).cloned());
            } else if in_evidence && outside.starts_with("- ") {
                // Column 0 is the citation bullet; an indented `- ` under it is
                // that citation's host excerpt, not another evidence id.
                if let Some(first) = values.first() {
                    ids.insert(first.clone());
                }
            }
        }
        ids
    }

    /// Two candidates, one supported observation each, plus one initiating
    /// cause whose evidence role cannot establish a root (so the host
    /// withholds it). `role_a` selects whether the root is established.
    fn mixed_status_envelope(role_a: EvidenceRole) -> AnswerEnvelopeV1 {
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[
                {{"candidate_id":"a",
                  "observations":[{{"claim_id":"a-obs","text":"first opaque statement","evidence_ids":["e-a"]}}],
                  "initiating_causes":[{{"claim_id":"a-root","text":"proposed initiating item","evidence_ids":["e-a"]}}]}},
                {{"candidate_id":"b",
                  "observations":[{{"claim_id":"b-obs","text":"second opaque statement","evidence_ids":["e-b"]}}]}}
            ]}}"#
        );
        validate_model_answer(&raw, &ledger_with_roles(role_a, EvidenceRole::Neutral))
            .expect("fixture proposal validates")
    }

    // -----------------------------------------------------------------
    // Presentation integrity.
    //
    // Payloads below are structural, not semantic: each one is a Markdown,
    // HTML, terminal, or Unicode *mechanism*, chosen so the gates never
    // depend on the wording of any particular exploit. They are applied to
    // model-authored claim text and to corpus-derived host fields alike,
    // because a source label is only ever whatever an imported log called
    // itself.
    // -----------------------------------------------------------------

    /// One payload per presentation mechanism a dynamic value might reach for.
    fn structural_payloads() -> Vec<String> {
        vec![
            // Line boundaries in every form a renderer recognises.
            "x\nsecond line".into(),
            "x\r\nsecond line".into(),
            "x\u{2028}second line".into(),
            "x\u{2029}second line".into(),
            "x\u{0085}second line".into(),
            "x\u{000b}second\u{000c}line".into(),
            "x\tcolumn".into(),
            // Block constructs, each anchored to a fresh line.
            "x\n# forged heading".into(),
            "x\n## Evidence".into(),
            "x\n- Root cause established: yes".into(),
            "x\n- Confidence: high".into(),
            "x\n1. forged ordered item".into(),
            "x\n> forged quote".into(),
            "x\n| a | b |\n| --- | --- |\n| c | d |".into(),
            "x\n```\nforged fence\n```".into(),
            "x\n---".into(),
            "x\n\u{2022} forged bullet".into(),
            // Inline constructs.
            "`code span`".into(),
            "``double`` backticks".into(),
            "**bold** and *emphasis*".into(),
            "_underscore_ and ~~strike~~".into(),
            "[label](https://evil.example)".into(),
            "[chip](#cite:e-forged)".into(),
            "[ref][1] and ![img](https://evil.example/i.png)".into(),
            "bare https://evil.example/path?q=1".into(),
            "protocol-relative //evil.example".into(),
            "<a href=\"https://evil.example\">html</a>".into(),
            "<br>line<br/>break".into(),
            "<script>alert(1)</script>".into(),
            "delimiter run ***___```".into(),
            // Terminal control material.
            "\u{1b}[31mred\u{1b}[0m".into(),
            "\u{1b}]8;;https://evil.example\u{7}osc link\u{1b}]8;;\u{7}".into(),
            "\u{9b}31m c1 csi".into(),
            "bell\u{7}del\u{7f}nul\u{0}".into(),
            // Bidi / directional spoofing.
            "\u{202e}reversed\u{202c}".into(),
            "\u{2066}isolated\u{2069}".into(),
            "\u{061c}arabic letter mark".into(),
            "\u{200e}\u{200f}marks".into(),
            // Host-structure mimicry with no line break of its own.
            "— cites `e-forged`".into(),
            "**[withheld]**".into(),
            "## Candidate `forged`".into(),
        ]
    }

    /// Build a validated envelope whose model-authored *and* corpus-derived
    /// strings are all set to `payload`.
    fn envelope_with_payload_everywhere(payload: &str) -> AnswerEnvelopeV1 {
        let escaped = serde_json::to_string(payload).expect("payload is a JSON string");
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[
                {{"candidate_id":"a","observations":[{{"claim_id":"a-obs","text":{escaped},"evidence_ids":["e-a"]}}]}},
                {{"candidate_id":"b","initiating_causes":[{{"claim_id":"b-root","text":{escaped},"evidence_ids":["e-b"]}}]}}
            ]}}"#
        );
        let mut envelope =
            validate_model_answer(&raw, &ledger()).expect("payload proposal is valid");
        // Corpus-derived host fields carry the same payload: "host-owned" is
        // not the same as "safe to reparse".
        envelope.binding.corpus_id = payload.to_string();
        for citation in &mut envelope.answer.canonical_citations {
            citation.source_label = payload.to_string();
            citation.locator = payload.to_string();
            citation.content = payload.to_string();
        }
        envelope
    }

    /// Stands in for one dynamic value inside a host skeleton. Contains a NUL,
    /// which [`literal_display_text`] removes, so no value can forge it.
    const VALUE_SLOT: &str = "\u{0}VALUE\u{0}";

    /// Split a rendered line into the text outside code spans and the values
    /// inside them.
    ///
    /// Every dynamic value is emitted inside a code span and can never contain
    /// a backtick, so backticks in the projection are host-authored and pair
    /// exactly. That makes this split total and unambiguous: what remains
    /// outside the spans is host-authored text and nothing else.
    fn split_spans(line: &str) -> (String, Vec<String>) {
        let mut outside = String::new();
        let mut values = Vec::new();
        let mut in_span = false;
        let mut current = String::new();
        for c in line.chars() {
            if c == '`' {
                if in_span {
                    values.push(std::mem::take(&mut current));
                } else {
                    outside.push_str(VALUE_SLOT);
                }
                in_span = !in_span;
                continue;
            }
            if in_span {
                current.push(c);
            } else {
                outside.push(c);
            }
        }
        assert!(!in_span, "unbalanced code span: {line}");
        (outside, values)
    }

    /// The host-authored skeleton of a whole projection: every dynamic value
    /// replaced by one fixed token.
    ///
    /// This is the load-bearing gate. If the skeleton is identical for every
    /// payload, then no dynamic value contributed a heading, a list item, a
    /// status line, a candidate, an evidence section, a withheld marker, a
    /// citation, or any other host construct — whatever it contained.
    fn host_skeleton(markdown: &str) -> String {
        markdown
            .lines()
            .map(|line| {
                split_spans(line)
                    .0
                    .replace(EMPTY_VALUE_PLACEHOLDER, VALUE_SLOT)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn no_dynamic_value_can_author_host_structure() {
        let baseline = host_skeleton(&render_answer_markdown(&envelope_with_payload_everywhere(
            "plain",
        )));
        // The skeleton the fixture is expected to have, spelled out so a
        // change in host structure cannot silently pass as "still invariant".
        assert_eq!(baseline.matches("- Root cause established: no").count(), 1);
        assert_eq!(
            baseline
                .matches("- Confidence: not rated by this contract")
                .count(),
            1
        );
        assert_eq!(baseline.matches("## Candidate ").count(), 2);
        assert_eq!(baseline.matches("## Evidence").count(), 1);
        assert_eq!(baseline.matches("**[withheld]**").count(), 1);
        assert_eq!(baseline.matches("— cites ").count(), 2);

        for payload in structural_payloads() {
            let markdown = render_answer_markdown(&envelope_with_payload_everywhere(&payload));
            assert_eq!(
                host_skeleton(&markdown),
                baseline,
                "payload {payload:?} changed the host skeleton:\n{markdown}"
            );
        }
    }

    #[test]
    fn every_dynamic_value_renders_on_exactly_one_line_without_controls() {
        for payload in structural_payloads() {
            let normalized = literal_display_text(&payload);
            assert!(
                !normalized.chars().any(is_line_boundary),
                "payload {payload:?} kept a line boundary"
            );
            assert!(
                !normalized.chars().any(|c| c.is_control() || c == '\u{7f}'),
                "payload {payload:?} kept a control character"
            );
            assert!(
                !normalized
                    .chars()
                    .any(|c| BIDI_FORMATTING_CONTROLS.contains(&c)),
                "payload {payload:?} kept a backtick or bidi control"
            );
            assert!(
                !normalized.contains('`'),
                "payload {payload:?} kept a backtick"
            );

            // The projection keeps its exact line count whatever the payload.
            let markdown = render_answer_markdown(&envelope_with_payload_everywhere(&payload));
            let plain = render_answer_markdown(&envelope_with_payload_everywhere("plain"));
            assert_eq!(
                markdown.lines().count(),
                plain.lines().count(),
                "payload {payload:?} changed the line count:\n{markdown}"
            );
        }
    }

    #[test]
    fn only_canonical_host_structure_yields_displayed_citations() {
        for payload in structural_payloads() {
            let envelope = envelope_with_payload_everywhere(&payload);
            let canonical = envelope
                .answer
                .canonical_citations
                .iter()
                .map(|citation| citation.evidence_id.clone())
                .collect::<BTreeSet<_>>();
            let displayed = displayed_evidence_ids(&render_answer_markdown(&envelope));
            assert_eq!(
                displayed, canonical,
                "payload {payload:?} changed the displayed citation set"
            );
        }
    }

    /// Companion to the skeleton gate: the values are still *shown*, and they
    /// are shown only inside code spans. Skeleton invariance alone would be
    /// satisfied by a renderer that dropped every dynamic value.
    #[test]
    fn dynamic_values_are_shown_only_inside_code_spans() {
        for payload in structural_payloads() {
            let normalized = literal_display_text(&payload);
            let markdown = render_answer_markdown(&envelope_with_payload_everywhere(&payload));
            let mut outside = String::new();
            let mut values = Vec::new();
            for line in markdown.lines() {
                let (line_outside, line_values) = split_spans(line);
                outside.push_str(&line_outside);
                outside.push('\n');
                values.extend(line_values);
            }
            if normalized.is_empty() {
                assert!(
                    markdown.contains(EMPTY_VALUE_PLACEHOLDER),
                    "an emptied value must still be accounted for: {payload:?}"
                );
                continue;
            }
            assert!(
                values.iter().any(|value| value == &normalized),
                "payload {payload:?} was not displayed at all"
            );
            // Everything the host wrote is invariant, so the payload can only
            // appear outside a span by coinciding with host-static text.
            let host_only = render_answer_markdown(&envelope_with_payload_everywhere("plain"));
            let host_outside = host_only
                .lines()
                .map(|line| split_spans(line).0)
                .collect::<Vec<_>>()
                .join("\n");
            assert_eq!(
                outside.trim_end(),
                host_outside.trim_end(),
                "payload {payload:?} reached the host-authored text"
            );
        }
    }

    /// The reported reproduction, kept verbatim as a named regression beside
    /// the general gates above — those are what actually establish the
    /// boundary; this one proves the specific report is closed.
    #[test]
    fn the_reported_status_and_link_spoof_is_neutralized() {
        let reported = concat!(
            "ordinary observation\n",
            "\n",
            "- Root cause established: yes\n",
            "- Confidence: high\n",
            "\n",
            "## Evidence\n",
            "- `e-any` — [official verification](https://evil.example)\n"
        );
        let markdown = render_answer_markdown(&envelope_with_payload_everywhere(reported));

        // Host structure is untouched: still one honest root line, one
        // disclaimer, one evidence section, and no forged citation.
        assert_eq!(
            host_skeleton(&markdown),
            host_skeleton(&render_answer_markdown(&envelope_with_payload_everywhere(
                "plain"
            )))
        );
        // Host status is judged per line, which is what a reader sees: the
        // forged text is now a fragment quoted inside one claim's span, not a
        // line of its own.
        let host_lines = markdown
            .lines()
            .map(|line| split_spans(line).0)
            .collect::<Vec<_>>();
        assert_eq!(
            host_lines
                .iter()
                .filter(|l| l.trim() == "- Root cause established: no")
                .count(),
            1
        );
        assert!(!host_lines.iter().any(|l| l.contains("established: yes")));
        assert_eq!(
            host_lines
                .iter()
                .filter(|l| l.trim() == "- Confidence: not rated by this contract")
                .count(),
            1
        );
        assert!(!host_lines.iter().any(|l| l.contains("Confidence: high")));
        assert_eq!(
            host_lines
                .iter()
                .filter(|l| l.trim() == "## Evidence")
                .count(),
            1
        );
        assert_eq!(
            displayed_evidence_ids(&markdown),
            BTreeSet::from(["e-a".to_string(), "e-b".to_string()]),
            "the forged evidence id must not be displayed as a citation"
        );
        // The URL survives only as quoted characters inside a span, and the
        // desktop gates prove a span never becomes a link.
        assert!(markdown.contains("https://evil.example"));
        assert!(!host_lines.iter().any(|l| l.contains("evil.example")));
        // Nothing is hidden from the reader: the reported text is still shown,
        // as one line of quoted content.
        assert!(markdown.contains("ordinary observation - Root cause established: yes"));
    }

    #[test]
    fn safe_values_stay_readable() {
        let readable = [
            "connection refused after 3 retries",
            "app/worker_pool-1.jsonl",
            "seq=1428",
            "GET /v2/orders?id=99 -> 503",
            "utilisateur non trouvé — 사용자 없음 — ユーザー未検出",
            "café ☕ ok",
        ];
        for value in readable {
            assert_eq!(
                literal_display_text(value),
                value,
                "a safe value must survive the boundary unchanged"
            );
            let markdown = render_answer_markdown(&envelope_with_payload_everywhere(value));
            assert!(markdown.contains(value), "{markdown}");
        }
        // Runs of whitespace collapse; that is the documented normalization.
        assert_eq!(literal_display_text("a \t\n  b"), "a b");
        assert_eq!(literal_display_text("  padded  "), "padded");
        assert_eq!(literal_display_text("\u{1b}[0m"), "[0m");
        assert_eq!(literal_display_text("a`b"), "a'b");
        assert_eq!(literal_display_text("\u{202e}"), "");
    }

    #[test]
    fn an_emptied_value_renders_a_host_placeholder_not_an_empty_span() {
        let envelope = envelope_with_payload_everywhere("\u{202e}\u{1b}\u{0}");
        let markdown = render_answer_markdown(&envelope);
        assert!(markdown.contains(EMPTY_VALUE_PLACEHOLDER), "{markdown}");
        assert!(
            !markdown.contains("``"),
            "no empty span may appear:\n{markdown}"
        );
        for line in markdown.lines() {
            assert!(line.matches('`').count() % 2 == 0, "{line}");
        }
    }

    #[test]
    fn every_displayed_citation_maps_to_a_host_canonical_citation() {
        let envelope = mixed_status_envelope(EvidenceRole::Neutral);
        let markdown = render_answer_markdown(&envelope);
        let canonical = envelope
            .answer
            .canonical_citations
            .iter()
            .map(|citation| citation.evidence_id.clone())
            .collect::<BTreeSet<_>>();
        let displayed = displayed_evidence_ids(&markdown);
        assert!(!displayed.is_empty(), "{markdown}");
        assert!(
            displayed.is_subset(&canonical),
            "displayed {displayed:?} escaped canonical {canonical:?}\n{markdown}"
        );

        // A claim citing an id the host never canonicalized shows no citation
        // for it, and says so rather than dropping the gap silently.
        let mut tampered = envelope.clone();
        tampered.answer.canonical_citations.clear();
        let tampered_markdown = render_answer_markdown(&tampered);
        assert!(displayed_evidence_ids(&tampered_markdown).is_empty());
        assert!(tampered_markdown.contains("no host citation available"));
    }

    #[test]
    fn candidate_and_claim_kind_separation_survives_rendering() {
        let markdown = render_answer_markdown(&mixed_status_envelope(EvidenceRole::Neutral));
        // Split on the host's own candidate heading rather than byte offsets:
        // the blocks are what a reader sees under each candidate.
        let mut blocks = markdown.split("## Candidate ");
        let header = blocks.next().expect("document header");
        assert!(header.contains("# Investigation answer"), "{markdown}");
        let a_block = blocks.next().expect("candidate a block");
        let b_block = blocks.next().expect("candidate b block");
        assert!(
            blocks.next().is_none(),
            "exactly two candidates: {markdown}"
        );
        assert!(a_block.starts_with("`a`"), "{a_block}");
        assert!(b_block.starts_with("`b`"), "{b_block}");
        // The evidence section trails the last candidate, not the first.
        assert!(!a_block.contains("## Evidence"), "{a_block}");
        assert!(b_block.contains("## Evidence"), "{b_block}");
        let b_block = b_block
            .split("## Evidence")
            .next()
            .expect("candidate b claims");

        // Each claim stays under its own candidate…
        assert!(a_block.contains("first opaque statement"));
        assert!(!a_block.contains("second opaque statement"));
        assert!(b_block.contains("second opaque statement"));
        assert!(!b_block.contains("first opaque statement"));
        // …and each candidate cites only its own evidence.
        assert!(a_block.contains("`e-a`") && !a_block.contains("`e-b`"));
        assert!(b_block.contains("`e-b`") && !b_block.contains("`e-a`"));
        // Kinds are separate labelled groups, not one merged list.
        assert!(a_block.contains("**Observations**"));
        assert!(a_block.contains("**Initiating causes**"));
        assert!(!b_block.contains("**Initiating causes**"));
    }

    #[test]
    fn a_withheld_initiating_cause_never_renders_as_established() {
        let envelope = mixed_status_envelope(EvidenceRole::Neutral);
        assert!(!envelope.answer.root_cause_established);
        let claim = envelope.answer.candidates[0]
            .claims
            .iter()
            .find(|claim| claim.claim_kind == ClaimKind::InitiatingCause)
            .expect("fixture proposes an initiating cause");
        assert_eq!(claim.status, ClaimStatus::Withheld);

        let markdown = render_answer_markdown(&envelope);
        let line = markdown
            .lines()
            .find(|line| line.contains("proposed initiating item"))
            .expect("the withheld claim is still shown");
        assert!(
            line.contains("**[withheld]**"),
            "a withheld claim must carry a visible marker: {line}"
        );
        assert!(
            markdown.contains("- Root cause established: no"),
            "{markdown}"
        );
        assert!(
            !markdown.contains("Root cause established: yes"),
            "{markdown}"
        );
    }

    #[test]
    fn displayed_root_status_equals_the_host_boolean_exactly() {
        for (role, established, expected) in [
            (EvidenceRole::Neutral, false, "- Root cause established: no"),
            (EvidenceRole::Cause, true, "- Root cause established: yes"),
        ] {
            let envelope = mixed_status_envelope(role);
            assert_eq!(envelope.answer.root_cause_established, established);
            let markdown = render_answer_markdown(&envelope);
            assert!(markdown.contains(expected), "{markdown}");
            assert_eq!(
                markdown
                    .lines()
                    .filter(|line| line.starts_with("- Root cause established:"))
                    .count(),
                1,
                "exactly one root statement: {markdown}"
            );
        }
    }

    #[test]
    fn no_confidence_value_is_invented() {
        let markdown = render_answer_markdown(&mixed_status_envelope(EvidenceRole::Cause));
        let confidence = markdown
            .lines()
            .filter(|line| line.starts_with("- Confidence:"))
            .collect::<Vec<_>>();
        assert_eq!(
            confidence,
            vec!["- Confidence: not rated by this contract"],
            "{markdown}"
        );
        let lowered = markdown.to_ascii_lowercase();
        for invented in ["confidence: high", "confidence: medium", "confidence: low"] {
            assert!(!lowered.contains(invented), "{markdown}");
        }
    }

    #[test]
    fn renaming_every_human_string_changes_only_that_text() {
        let envelope = mixed_status_envelope(EvidenceRole::Neutral);
        let mut renamed = envelope.clone();
        // Rename every model- and corpus-derived string the renderer can see.
        // Ids stay fixed: this is the vocabulary-independence property, not an
        // identity-renaming one.
        let rename = |text: &str| text.replace("opaque", "renamed").replace("one", "qux");
        for candidate in &mut renamed.answer.candidates {
            for claim in &mut candidate.claims {
                claim.text = rename(&claim.text);
            }
        }
        for citation in &mut renamed.answer.canonical_citations {
            citation.source_label = rename(&citation.source_label);
            citation.locator = rename(&citation.locator);
            citation.content = rename(&citation.content);
        }
        for entry in &mut renamed.evidence {
            entry.source_label = rename(&entry.source_label);
            entry.locator = rename(&entry.locator);
            entry.content = rename(&entry.content);
        }
        assert_eq!(
            rename(&render_answer_markdown(&envelope)),
            render_answer_markdown(&renamed),
            "the renderer must treat every human string as opaque"
        );
    }

    #[test]
    fn rendering_is_stable_under_input_ordering() {
        let envelope = mixed_status_envelope(EvidenceRole::Neutral);
        let expected = render_answer_markdown(&envelope);

        let mut permuted = envelope.clone();
        permuted.answer.candidates.reverse();
        for candidate in &mut permuted.answer.candidates {
            candidate.claims.reverse();
            for claim in &mut candidate.claims {
                claim.evidence_ids.reverse();
            }
        }
        permuted.answer.canonical_citations.reverse();
        permuted.evidence.reverse();
        assert_eq!(
            render_answer_markdown(&permuted),
            expected,
            "a permuted envelope must render byte-identically"
        );
        // …and rendering the same value twice is itself stable.
        assert_eq!(render_answer_markdown(&envelope), expected);
    }

    #[test]
    fn a_host_excerpt_is_shown_only_when_it_adds_something_the_citation_line_lacks() {
        // The fixture ledger's excerpts carry words the citation line does not.
        let envelope = mixed_status_envelope(EvidenceRole::Neutral);
        let markdown = render_answer_markdown(&envelope);
        assert!(markdown.contains("host excerpt one"), "{markdown}");

        // An excerpt that only restates the identity already printed is noise.
        let mut restating = envelope.clone();
        for citation in &mut restating.answer.canonical_citations {
            citation.content = format!("{} {}", citation.source_label, citation.locator);
        }
        let restated = render_answer_markdown(&restating);
        assert!(!restated.contains("host excerpt"), "{restated}");
        for citation in &restating.answer.canonical_citations {
            assert_eq!(
                restated.matches(citation.locator.as_str()).count(),
                1,
                "the identity must be printed once, not echoed: {restated}"
            );
        }

        // An empty excerpt renders nothing at all.
        let mut empty = envelope.clone();
        for citation in &mut empty.answer.canonical_citations {
            citation.content.clear();
        }
        let rendered = render_answer_markdown(&empty);
        assert!(!rendered.contains("\n  - "), "{rendered}");
    }

    #[test]
    fn the_human_projection_is_markdown_while_the_machine_projection_stays_exact() {
        let envelope = mixed_status_envelope(EvidenceRole::Neutral);
        let markdown = render_answer_markdown(&envelope);
        assert!(markdown.starts_with("# Investigation answer"), "{markdown}");
        assert!(
            serde_json::from_str::<serde_json::Value>(markdown.trim()).is_err(),
            "the visible answer must not be raw JSON: {markdown}"
        );
        assert!(!markdown.contains(SCHEMA_V1), "{markdown}");

        // The machine contract is untouched by the display contract.
        let json = authoritative_json(&envelope);
        let parsed: InvestigationAnswerV1 =
            serde_json::from_str(&json).expect("authoritative JSON stays exact");
        assert_eq!(parsed, envelope.answer);
    }

    /// The V1 projection must not be mistakable for the legacy
    /// structured-triage contract: that parser keys on normalized headings,
    /// so this renderer uses bold labels and its own heading vocabulary.
    #[test]
    fn the_v1_projection_is_not_a_legacy_structured_triage_answer() {
        let markdown = render_answer_markdown(&mixed_status_envelope(EvidenceRole::Cause));
        let legacy = crate::triage_quality::parse_structured_triage_answer(&markdown)
            .expect("the legacy parser is total over text");
        assert!(legacy.observations.is_empty(), "{legacy:?}");
        assert!(legacy.causal_candidates.is_empty(), "{legacy:?}");
        assert!(legacy.competing_explanations.is_empty(), "{legacy:?}");
        assert!(legacy.confidence.is_empty(), "{legacy:?}");
        assert!(
            !legacy.asserts_root_cause_established,
            "an established V1 root must not become a legacy assertion: {legacy:?}"
        );
    }

    #[test]
    fn neutral_and_symptom_roles_never_establish_root() {
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","initiating_causes":[{{"claim_id":"root-a","text":"candidate root","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"obs-b","text":"observation","evidence_ids":["e-b"]}}]}}]}}"#
        );
        for role in [EvidenceRole::Neutral, EvidenceRole::Symptom] {
            let envelope =
                validate_model_answer(&raw, &ledger_with_roles(role, EvidenceRole::Neutral))
                    .unwrap();
            assert!(!envelope.answer.root_cause_established);
            assert_eq!(
                envelope.answer.candidates[0].claims[0].status,
                ClaimStatus::Withheld
            );
        }
    }
}
