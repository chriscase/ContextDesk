//! Shared model-context budgeting for ordinary chat, broad triage, and focused
//! linked-log synthesis.
//!
//! Headroom policy (generation reservation) is **shared** across linked
//! synthesis paths — not only `broad_log_triage`. Evidence packing is
//! deterministic and identity-aware: it ranks/dedupes host blocks, never splits
//! citation `seq=` / `source=` lines or UTF-8 sequences, and discloses omits.

use crate::model_context::ContextBudgetSource;
use crate::text::{floor_char_boundary, truncate_bytes};
use serde::{Deserialize, Serialize};

/// Absolute characters reserved so linked/ordinary synthesis cannot pack to the
/// hard budget ceiling (same class as broad triage). Near-ceiling packs such as
/// 119_900 / 120_000 are not success.
pub const SYNTHESIS_CONTEXT_HEADROOM_CHARS: usize = 12_000;

/// Minimum free ratio of the hard budget after packing (0.0–1.0).
pub const SYNTHESIS_MIN_HEADROOM_RATIO: f64 = 0.08;

/// Backward-compatible alias used by broad-triage docs and tests.
pub const BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS: usize = SYNTHESIS_CONTEXT_HEADROOM_CHARS;
/// Backward-compatible alias for the min headroom ratio.
pub const BROAD_TRIAGE_MIN_HEADROOM_RATIO: f64 = SYNTHESIS_MIN_HEADROOM_RATIO;

/// Max characters reserved for the omit disclosure footer inside evidence.
const OMIT_FOOTER_RESERVE: usize = 240;
/// Soft per-record body cap when a single evidence unit still exceeds remaining budget.
const MAX_SINGLE_RECORD_BODY_CHARS: usize = 1_200;
/// Cap for force-included first/last identity lines so one huge lead cannot starve the tail.
const MAX_MANDATORY_IDENTITY_CHARS: usize = 480;

/// How the hard character capacity was established for this turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CapacitySourceLabel {
    /// Product default (not measured from a live model).
    #[default]
    Default,
    /// Operator/configured ContextDesk budget for the turn.
    Configured,
    /// Declared by catalog/gateway metadata (not live-probed this turn).
    Declared,
    /// Learned by shrinking after a prior context-length failure.
    Learned,
    /// Provider window is unknown; configured/default used honestly.
    UnknownConfigured,
}

impl CapacitySourceLabel {
    /// Stable wire string for trail / JSONL.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Configured => "configured",
            Self::Declared => "declared",
            Self::Learned => "learned",
            Self::UnknownConfigured => "unknown_configured",
        }
    }

    /// Map from [`ContextBudgetSource`] plus whether the host treated capacity as unknown.
    pub fn from_budget_source(source: ContextBudgetSource, capacity_unknown: bool) -> Self {
        if capacity_unknown {
            return Self::UnknownConfigured;
        }
        match source {
            ContextBudgetSource::Default => Self::Default,
            ContextBudgetSource::Declared => Self::Declared,
            ContextBudgetSource::Learned => Self::Learned,
        }
    }
}

/// Typed budget / packing telemetry for one model request.
///
/// Shared by CLI human progress, JSON/JSONL trails, and (when projected) Activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetTelemetry {
    /// Zero-based model request / round identity for this snapshot.
    pub model_round: u32,
    /// Hard / configured ContextDesk char budget for this turn.
    pub hard_budget_chars: usize,
    /// Budget after reserved generation headroom (packing target).
    pub packing_budget_chars: usize,
    /// Reserved headroom = hard − packing.
    pub reserved_headroom_chars: usize,
    /// Estimated chars actually sent after packing.
    pub used_chars_estimate: usize,
    /// Free = hard − used (may be larger than reserved when under-filled).
    pub free_chars_estimate: usize,
    /// Host evidence chars **before** packing (sum of trusted blocks).
    pub evidence_pre_pack_chars: usize,
    /// Evidence body chars included (excluding system/user/history).
    pub evidence_included_chars: usize,
    /// Evidence blocks omitted by the packer.
    pub evidence_omitted_blocks: usize,
    /// Approx chars of omitted evidence.
    pub evidence_omitted_chars: usize,
    /// Citeable identity lines retained.
    pub evidence_identity_lines_included: usize,
    /// Citeable identity lines dropped for budget.
    pub evidence_identity_lines_omitted: usize,
    /// History messages retained in the model window (non-system).
    pub history_retained_messages: usize,
    /// History messages omitted/compacted out of the model window.
    pub history_omitted_messages: usize,
    /// Whether history compaction/summary was applied.
    pub history_compacted: bool,
    /// Capacity provenance label (never pretends ContextDesk discovered a limit
    /// when the source is default/configured/unknown).
    pub provider_capacity_source: CapacitySourceLabel,
    /// True when used leaves useful headroom under hard budget.
    pub useful_headroom: bool,
}

impl ContextBudgetTelemetry {
    /// Search-trail style step for CLI / Activity projection.
    ///
    /// Includes both legacy field names (`budget`, `packing_budget`) and extended
    /// aliases (`hard`, `packing`) so existing parsers and new telemetry agree.
    pub fn trail_step(&self) -> String {
        format!(
            "context_budget:round={},used={},budget={},hard={},packing_budget={},packing={},\
headroom={},reserved={},evidence_pre_pack={},evidence_included={},\
evidence_omitted_blocks={},evidence_omitted_chars={},\
evidence_identity_included={},evidence_identity_omitted={},\
history_retained={},history_omitted={},\
history_compacted={},capacity_source={},useful_headroom={}",
            self.model_round,
            self.used_chars_estimate,
            self.hard_budget_chars,
            self.hard_budget_chars,
            self.packing_budget_chars,
            self.packing_budget_chars,
            self.free_chars_estimate,
            self.reserved_headroom_chars,
            self.evidence_pre_pack_chars,
            self.evidence_included_chars,
            self.evidence_omitted_blocks,
            self.evidence_omitted_chars,
            self.evidence_identity_lines_included,
            self.evidence_identity_lines_omitted,
            self.history_retained_messages,
            self.history_omitted_messages,
            self.history_compacted,
            self.provider_capacity_source.as_str(),
            self.useful_headroom
        )
    }

    /// Nested multi-line human Context section (trace/detail only — not ordinary chat).
    pub fn human_context_section(&self) -> String {
        format!(
            "Context\n\
  hard:              {}\n\
  packing:           {}\n\
  used:              {}\n\
  reserved:          {}\n\
  free:              {}\n\
  evidence_pre_pack: {}\n\
  evidence_included: {}\n\
  omitted_blocks:    {}\n\
  omitted_chars:     {}\n\
  history_retained:  {}\n\
  history_omitted:   {}\n\
  history_compacted: {}\n\
  capacity_source:   {}\n\
  useful_headroom:   {}\n\
  model_round:       {}",
            self.hard_budget_chars,
            self.packing_budget_chars,
            self.used_chars_estimate,
            self.reserved_headroom_chars,
            self.free_chars_estimate,
            self.evidence_pre_pack_chars,
            self.evidence_included_chars,
            self.evidence_omitted_blocks,
            self.evidence_omitted_chars,
            self.history_retained_messages,
            self.history_omitted_messages,
            self.history_compacted,
            self.provider_capacity_source.as_str(),
            self.useful_headroom,
            self.model_round
        )
    }

    /// Compact JSON object for JSONL/developer detail.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}))
    }
}

/// Effective packing budget after reserving synthesis generation headroom.
///
/// Used by **focused** linked synthesis, **broad** triage, retries, and final
/// linked synthesis — not only `broad_log_triage`.
pub fn synthesis_packing_budget(hard_budget_chars: usize) -> usize {
    if hard_budget_chars == 0 {
        return 0;
    }
    let proportional = hard_budget_chars / 10;
    let reservation = SYNTHESIS_CONTEXT_HEADROOM_CHARS.min(proportional);
    // Never reserve more than half the window (tiny custom budgets).
    let reservation = reservation.min(hard_budget_chars / 2);
    hard_budget_chars.saturating_sub(reservation)
}

/// Backward-compatible name for broad-triage call sites and tests.
pub fn broad_triage_packing_budget(char_budget: usize) -> usize {
    synthesis_packing_budget(char_budget)
}

/// Whether measured usage leaves useful headroom relative to the hard budget.
pub fn has_useful_context_headroom(used_chars: usize, hard_budget_chars: usize) -> bool {
    if hard_budget_chars == 0 || used_chars > hard_budget_chars {
        return false;
    }
    let free = hard_budget_chars.saturating_sub(used_chars);
    let ratio = free as f64 / hard_budget_chars as f64;
    let min_abs = SYNTHESIS_CONTEXT_HEADROOM_CHARS.min(hard_budget_chars / 10);
    free >= min_abs || ratio + f64::EPSILON >= SYNTHESIS_MIN_HEADROOM_RATIO
}

/// Result of packing host evidence blocks for one synthesis request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackedLinkedEvidence {
    /// Model-facing evidence body (may be empty).
    pub text: String,
    /// Blocks fully or partially included.
    pub included_blocks: usize,
    /// Blocks with no content retained.
    pub omitted_blocks: usize,
    /// Characters included in [`Self::text`] (excluding omit footer).
    pub included_chars: usize,
    /// Characters dropped.
    pub omitted_chars: usize,
    /// Lines containing both `seq=` and `source=` kept.
    pub identity_lines_included: usize,
    /// Such lines dropped.
    pub identity_lines_omitted: usize,
}

/// Deterministic evidence packer for linked-log synthesis.
///
/// - Stable order: original block order, then line order within a block.
/// - Prefers lines that carry citeable `seq=` + `source=` identities.
/// - Dedupes identical identity keys (keeps first).
/// - Never splits a citation line or UTF-8 codepoint.
/// - When content exceeds `evidence_budget_chars`, appends an omit disclosure.
pub fn pack_linked_evidence_blocks(
    blocks: &[String],
    evidence_budget_chars: usize,
) -> PackedLinkedEvidence {
    if blocks.is_empty() || evidence_budget_chars == 0 {
        return PackedLinkedEvidence {
            text: String::new(),
            included_blocks: 0,
            omitted_blocks: blocks.len(),
            included_chars: 0,
            omitted_chars: blocks.iter().map(|b| b.chars().count()).sum(),
            identity_lines_included: 0,
            identity_lines_omitted: 0,
        };
    }

    let total_chars: usize = blocks.iter().map(|b| b.chars().count()).sum();
    // Fast path: entire host evidence fits under budget. Preserve blocks
    // **byte-for-byte** (same join as CurrentTurnEvidence::render) so broad-triage
    // complete-brief checks using `contains(evidence)` keep working. Deduping is
    // only applied on the oversize ranked path below.
    if total_chars <= evidence_budget_chars {
        let text = blocks.join("\n\n");
        let identity_lines_included = text
            .lines()
            .filter(|l| line_has_citation_identity(l))
            .count();
        return PackedLinkedEvidence {
            text,
            included_blocks: blocks.len(),
            omitted_blocks: 0,
            included_chars: total_chars,
            omitted_chars: 0,
            identity_lines_included,
            identity_lines_omitted: 0,
        };
    }
    // Budget for body after omit footer reserve when we expect overflow.
    let body_budget =
        evidence_budget_chars.saturating_sub(OMIT_FOOTER_RESERVE.min(evidence_budget_chars / 4));

    #[derive(Clone)]
    struct Unit {
        block_idx: usize,
        line: String,
        is_identity: bool,
        identity_key: Option<String>,
        score: i32,
        /// 0 = force first identity, 1 = force last identity, 2 = normal fill.
        stratum: u8,
    }

    let mut units: Vec<Unit> = Vec::new();
    let n_blocks = blocks.len();
    for (block_idx, block) in blocks.iter().enumerate() {
        let line_list: Vec<&str> = block.lines().collect();
        let n_lines = line_list.len();
        for (line_i, raw_line) in line_list.iter().enumerate() {
            let line = raw_line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            let raw_key = identity_key_from_line(&line);
            // Valid identity requires parseable seq+source (not mere keyword presence).
            let is_identity = line_has_citation_identity(&line) && !raw_key.is_empty();
            let identity_key = if is_identity { Some(raw_key) } else { None };
            // Prefer identity lines and denser (shorter) rows. Do **not** penalize
            // late identity blocks — that drops rare tail events under oversize packs.
            let mut score = 0i32;
            if is_identity {
                score += 1_000;
                score -= (line.chars().count() as i32).min(150);
            } else {
                score += 10;
                score -= (block_idx as i32).min(80);
            }
            // First/last lines of a block (headers / rare tails).
            if line_i == 0 {
                score += 80;
            }
            if n_lines > 1 && line_i + 1 == n_lines {
                score += 120;
            }
            if n_blocks > 1 && block_idx + 1 == n_blocks && is_identity {
                score += 200;
            }
            if block_idx == 0 && is_identity {
                score += 100;
            }
            units.push(Unit {
                block_idx,
                line,
                is_identity,
                identity_key,
                score,
                stratum: 2,
            });
        }
    }

    // Force-include first and last identity units so rare tail + lead both survive.
    // Capacity is **reserved** for them first so a huge early row cannot starve the last.
    let identity_idxs: Vec<usize> = units
        .iter()
        .enumerate()
        .filter(|(_, u)| u.is_identity)
        .map(|(i, _)| i)
        .collect();
    let mut first_identity_idx: Option<usize> = None;
    let mut last_identity_idx: Option<usize> = None;
    if let Some(&first) = identity_idxs.first() {
        units[first].stratum = 0;
        units[first].score += 5_000;
        first_identity_idx = Some(first);
    }
    if identity_idxs.len() > 1 {
        if let Some(&last) = identity_idxs.last() {
            units[last].stratum = 1;
            units[last].score += 5_000;
            last_identity_idx = Some(last);
        }
    }

    // Prepare mandatory lines (capped) and reserve their cost before middle fill.
    // Prefer char-prefix truncation so useful msg text near the identity survives
    // (source=-only cuts drop the event body). Dedup identity keys across strata.
    let mut mandatory: Vec<(usize, String, usize)> = Vec::new();
    let mut reserved_chars = 0usize;
    let mut mandatory_keys = std::collections::BTreeSet::new();
    for idx in [first_identity_idx, last_identity_idx]
        .into_iter()
        .flatten()
    {
        if mandatory.iter().any(|(i, _, _)| *i == idx) {
            continue;
        }
        if let Some(key) = &units[idx].identity_key {
            if !mandatory_keys.insert(key.clone()) {
                continue; // same identity as another mandatory slot
            }
        }
        let line = &units[idx].line;
        let capped = {
            let by_chars = truncate_chars_at_boundary(line, MAX_MANDATORY_IDENTITY_CHARS);
            if line_has_citation_identity(&by_chars) {
                by_chars
            } else {
                truncate_preserving_identity_line(line, MAX_MANDATORY_IDENTITY_CHARS)
                    .unwrap_or(by_chars)
            }
        };
        if !line_has_citation_identity(&capped) {
            continue;
        }
        let cost = capped.chars().count().saturating_add(1);
        mandatory.push((idx, capped, cost));
        reserved_chars = reserved_chars.saturating_add(cost);
    }
    // Never reserve more than half the body for mandatory strata alone.
    if reserved_chars > body_budget / 2 && !mandatory.is_empty() {
        // Keep both mandatory lines but shrink their allowance proportionally.
        let scale_budget = (body_budget / 2).max(64);
        let n_mandatory = mandatory.len().max(1);
        let max_line = (scale_budget / n_mandatory).max(32);
        reserved_chars = 0;
        for item in &mut mandatory {
            if let Some(t) = truncate_preserving_identity_line(&item.1, max_line) {
                item.1 = t;
            } else {
                item.1 = truncate_chars_at_boundary(&item.1, max_line);
            }
            item.2 = item.1.chars().count().saturating_add(1);
            reserved_chars = reserved_chars.saturating_add(item.2);
        }
    }
    let fill_budget = body_budget.saturating_sub(reserved_chars);

    // Fill remaining budget with non-mandatory units (score desc, stable).
    let mut order: Vec<usize> = (0..units.len())
        .filter(|i| !mandatory.iter().any(|(m, _, _)| m == i))
        .collect();
    order.sort_by(|&a, &b| units[b].score.cmp(&units[a].score).then_with(|| a.cmp(&b)));

    let mut selected: Vec<Option<String>> = vec![None; units.len()];
    let mut used_chars = 0usize;
    let mut seen_ids = std::collections::BTreeSet::new();
    let mut identity_included = 0usize;
    let mut identity_omitted = 0usize;
    let mut blocks_touched = std::collections::BTreeSet::new();

    // Place mandatory strata first (reserved capacity).
    for (idx, line, cost) in &mandatory {
        if let Some(key) = &units[*idx].identity_key {
            seen_ids.insert(key.clone());
        }
        selected[*idx] = Some(line.clone());
        used_chars = used_chars.saturating_add(*cost);
        blocks_touched.insert(units[*idx].block_idx);
        identity_included = identity_included.saturating_add(1);
    }

    for idx in order {
        let u = &units[idx];
        if let Some(key) = &u.identity_key {
            if !seen_ids.insert(key.clone()) {
                // Duplicate identity — keep first only.
                continue;
            }
        }
        let mut candidate = u.line.clone();
        let mut cand_chars = candidate.chars().count();
        let join_cost = 1;
        // Middle fill only competes for fill_budget (mandatory already reserved).
        let fill_used = used_chars.saturating_sub(reserved_chars.min(used_chars));
        if fill_used + cand_chars + join_cost > fill_budget {
            if u.is_identity {
                if let Some(trimmed) = truncate_preserving_identity_line(
                    &candidate,
                    fill_budget.saturating_sub(fill_used + join_cost),
                ) {
                    candidate = trimmed;
                    cand_chars = candidate.chars().count();
                    if fill_used + cand_chars + join_cost > fill_budget {
                        identity_omitted = identity_omitted.saturating_add(1);
                        continue;
                    }
                } else {
                    identity_omitted = identity_omitted.saturating_add(1);
                    continue;
                }
            } else {
                let room = fill_budget.saturating_sub(fill_used + join_cost);
                if room < 48 {
                    continue;
                }
                let stub =
                    truncate_chars_at_boundary(&candidate, room.min(MAX_SINGLE_RECORD_BODY_CHARS));
                if stub.chars().count() < 24 {
                    continue;
                }
                candidate = stub;
                cand_chars = candidate.chars().count();
            }
        }
        // Hard ceiling: never exceed full body_budget.
        if used_chars + cand_chars + join_cost > body_budget {
            if u.is_identity {
                identity_omitted = identity_omitted.saturating_add(1);
            }
            continue;
        }
        selected[idx] = Some(candidate);
        used_chars = used_chars.saturating_add(cand_chars + join_cost);
        blocks_touched.insert(u.block_idx);
        if u.is_identity {
            identity_included = identity_included.saturating_add(1);
        }
    }

    // Reassemble in original unit order for stable model-facing text.
    let mut parts: Vec<String> = Vec::new();
    for line in selected.into_iter().flatten() {
        parts.push(line);
    }
    let mut text = parts.join("\n");
    let included_chars = text.chars().count();
    let omitted_chars = total_chars.saturating_sub(included_chars);
    let included_blocks = blocks_touched.len();
    let omitted_blocks = blocks.len().saturating_sub(included_blocks);

    // Count identity lines that never made it.
    let total_identity = units.iter().filter(|u| u.is_identity).count();
    // identity_omitted already tracks budget drops; add unselected unique ids.
    let identity_omitted = identity_omitted.max(total_identity.saturating_sub(identity_included));

    if omitted_blocks > 0 || omitted_chars > 0 || identity_omitted > 0 {
        let footer = format!(
            "\n[HOST EVIDENCE PACKED] omitted_blocks={omitted_blocks} omitted_chars≈{omitted_chars} \
identity_lines_omitted={identity_omitted} identity_lines_included={identity_included}. \
Further deepening must stay bounded — do not re-request the full window."
        );
        let room = evidence_budget_chars.saturating_sub(text.chars().count());
        if room > 32 {
            let foot = truncate_chars_at_boundary(&footer, room);
            text.push_str(&foot);
        }
    }

    // Final hard cap on evidence_budget_chars at char boundary.
    if text.chars().count() > evidence_budget_chars {
        text = truncate_chars_at_boundary(&text, evidence_budget_chars);
    }

    PackedLinkedEvidence {
        text,
        included_blocks,
        omitted_blocks,
        included_chars,
        omitted_chars,
        identity_lines_included: identity_included,
        identity_lines_omitted: identity_omitted,
    }
}

/// Compact correction package for a rejected linked synthesis draft.
///
/// Intentionally tiny: system reminder + bounded evidence pack — not a re-send
/// of the full oversized context.
pub fn compact_correction_package(
    base_system: &str,
    user_text: &str,
    evidence_blocks: &[String],
    packing_budget_chars: usize,
) -> (String, String, PackedLinkedEvidence) {
    let correction_system = format!(
        "{base_system}\n\
PRIOR DRAFT REJECTED: its citation syntax was missing, malformed, or did not match \
the bounded evidence. Return only a concise corrected analysis. DO NOT emit seq=, \
source=, template_id=, bracketed citations, or an evidence list; ContextDesk will \
attach the exact host-verified event identities. Use only the compact evidence \
package below — do not assume omitted rows."
    );
    // Leave room for system + user in the packing budget.
    let sys_chars = correction_system.chars().count();
    let user_chars = user_text.chars().count();
    let overhead = sys_chars.saturating_add(user_chars).saturating_add(512); // message framing
    let evidence_budget = packing_budget_chars.saturating_sub(overhead).max(512);
    // Prefer identity-dense packing under a tighter cap than first synthesis.
    let tight = evidence_budget.min(packing_budget_chars / 3).max(400);
    let packed = pack_linked_evidence_blocks(evidence_blocks, tight);
    (correction_system, user_text.to_string(), packed)
}

fn line_has_citation_identity(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    // Accept seq=… and source=… (optionally quoted). Avoid requiring exact order.
    let has_seq = lower.contains("seq=") || lower.contains("\"seq\":") || lower.contains("seq\":");
    let has_source =
        lower.contains("source=") || lower.contains("source\":") || lower.contains("\"source\"");
    has_seq && has_source
}

/// Authoritative citation identity key: `seq` + `source` only (not message body).
fn identity_key_from_line(line: &str) -> String {
    let seq = extract_field_value(line, "seq").unwrap_or_default();
    let source = extract_field_value(line, "source").unwrap_or_default();
    if seq.parse::<u64>().is_err() || source.is_empty() {
        // Malformed identity line: do not invent a key from the full body.
        return String::new();
    }
    format!(
        "seq={}|source={}",
        seq.to_ascii_lowercase(),
        source.to_ascii_lowercase()
    )
}

/// Extract `key=value`, `key="value"`, or JSON `"key":"value"` / `"key": value`.
fn extract_field_value(line: &str, key: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let key_l = key.to_ascii_lowercase();
    // Prefer key= form (log lines); fall back to JSON "key": form.
    let (pos, prefix_len) = if let Some(p) = lower.find(&format!("{key_l}=")) {
        (p, key_l.len() + 1)
    } else {
        let p = lower.find(&format!("\"{key_l}\":"))?;
        (p, key_l.len() + 3)
    };
    let after = line.get(pos + prefix_len..)?.trim_start();
    let value = if let Some(rest) = after.strip_prefix('"') {
        let end = rest.find('"')?;
        rest.get(..end)?.to_string()
    } else if let Some(rest) = after.strip_prefix('\'') {
        let end = rest.find('\'')?;
        rest.get(..end)?.to_string()
    } else {
        after
            .split(|c: char| c.is_whitespace() || c == ',' || c == '}')
            .next()
            .unwrap_or("")
            .to_string()
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn truncate_chars_at_boundary(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            break;
        }
        out.push(ch);
    }
    out
}

/// Keep a citation-bearing line intact when possible; otherwise trim trailing body.
fn truncate_preserving_identity_line(line: &str, max_chars: usize) -> Option<String> {
    if max_chars < 16 {
        return None;
    }
    if line.chars().count() <= max_chars {
        return Some(line.to_string());
    }
    // Prefer cutting after source=… token if present (ASCII-safe floor for slice).
    let lower = line.to_ascii_lowercase();
    if let Some(src_pos) = lower.find("source=") {
        let after = floor_char_boundary(line, src_pos + "source=".len());
        let rest = line.get(after..).unwrap_or("");
        let token_end = if let Some(stripped) = rest.strip_prefix('"') {
            stripped
                .find('"')
                .map(|i| after + 1 + i + 1)
                .unwrap_or(line.len())
        } else {
            rest.find(char::is_whitespace)
                .map(|i| after + i)
                .unwrap_or(line.len())
        };
        let token_end = floor_char_boundary(line, token_end.min(line.len()));
        let head = line.get(..token_end).unwrap_or("");
        if head.chars().count() <= max_chars && line_has_citation_identity(head) {
            return Some(head.to_string());
        }
    }
    // Fall back: char truncate; only accept if identity markers still both present.
    let truncated = truncate_chars_at_boundary(line, max_chars);
    if line_has_citation_identity(&truncated) {
        Some(truncated)
    } else {
        let by_bytes = truncate_bytes(line, max_chars.saturating_mul(4));
        if line_has_citation_identity(by_bytes) {
            Some(by_bytes.to_string())
        } else {
            None
        }
    }
}

/// Inputs for [`telemetry_from_parts`] (keeps call sites under clippy arg limits).
#[derive(Debug, Clone)]
pub struct TelemetryParts<'a> {
    /// Zero-based model request / round for this snapshot.
    pub model_round: u32,
    /// Hard budget.
    pub hard_budget_chars: usize,
    /// Packing budget.
    pub packing_budget_chars: usize,
    /// Measured use.
    pub used_chars_estimate: usize,
    /// Host evidence size before packing.
    pub evidence_pre_pack_chars: usize,
    /// Packed evidence stats.
    pub packed: &'a PackedLinkedEvidence,
    /// Retained **prior-history** message count (excludes system / current user / evidence).
    pub history_retained_messages: usize,
    /// Omitted prior-history message count.
    pub history_omitted_messages: usize,
    /// Compaction applied.
    pub history_compacted: bool,
    /// Capacity source label.
    pub provider_capacity_source: CapacitySourceLabel,
}

/// Build a telemetry snapshot after messages are finalized.
pub fn telemetry_from_parts(parts: TelemetryParts<'_>) -> ContextBudgetTelemetry {
    let reserved = parts
        .hard_budget_chars
        .saturating_sub(parts.packing_budget_chars);
    let free = parts
        .hard_budget_chars
        .saturating_sub(parts.used_chars_estimate);
    ContextBudgetTelemetry {
        model_round: parts.model_round,
        hard_budget_chars: parts.hard_budget_chars,
        packing_budget_chars: parts.packing_budget_chars,
        reserved_headroom_chars: reserved,
        used_chars_estimate: parts.used_chars_estimate,
        free_chars_estimate: free,
        evidence_pre_pack_chars: parts.evidence_pre_pack_chars,
        evidence_included_chars: parts.packed.included_chars,
        evidence_omitted_blocks: parts.packed.omitted_blocks,
        evidence_omitted_chars: parts.packed.omitted_chars,
        evidence_identity_lines_included: parts.packed.identity_lines_included,
        evidence_identity_lines_omitted: parts.packed.identity_lines_omitted,
        history_retained_messages: parts.history_retained_messages,
        history_omitted_messages: parts.history_omitted_messages,
        history_compacted: parts.history_compacted,
        provider_capacity_source: parts.provider_capacity_source,
        useful_headroom: has_useful_context_headroom(
            parts.used_chars_estimate,
            parts.hard_budget_chars,
        ),
    }
}

/// Count prior-history retention with multiset/occurrence-aware matching.
///
/// Excludes system messages, the current user request (even if it duplicates an
/// earlier user turn), and the current-turn host evidence block. Two identical
/// prior messages only contribute as many retentions as distinct prepared copies.
pub fn count_prior_history_retention(
    prior_history: &[crate::chat::ChatMessage],
    prepared: &[crate::chat::ChatMessage],
    current_user_text: &str,
) -> (usize, usize, bool) {
    use crate::chat::Role;
    use std::collections::HashMap;

    let prior: Vec<&crate::chat::ChatMessage> = prior_history
        .iter()
        .filter(|m| m.role != Role::System)
        .collect();
    let prior_len = prior.len();

    // Multiset of prepared non-system messages. Exclude only the **last** user
    // message matching current_user_text (the current request) and host evidence
    // blocks — not every prior turn that happens to share the same text.
    let mut skip_current_user_idx: Option<usize> = None;
    for (i, m) in prepared.iter().enumerate().rev() {
        if m.role == Role::User && m.content == current_user_text {
            skip_current_user_idx = Some(i);
            break;
        }
    }
    let mut prepared_bag: HashMap<(String, String), usize> = HashMap::new();
    for (i, m) in prepared.iter().enumerate() {
        if m.role == Role::System {
            continue;
        }
        if Some(i) == skip_current_user_idx {
            continue;
        }
        if m.content.starts_with("HOST-RETURNED BOUNDED EVIDENCE") {
            continue;
        }
        *prepared_bag
            .entry((m.role.as_str().to_string(), m.content.clone()))
            .or_insert(0) += 1;
    }

    let mut retained = 0usize;
    for p in &prior {
        let key = (p.role.as_str().to_string(), p.content.clone());
        if let Some(count) = prepared_bag.get_mut(&key) {
            if *count > 0 {
                *count -= 1;
                retained = retained.saturating_add(1);
            }
        }
    }

    let compacted = prepared.iter().any(|m| {
        m.content.contains("[earlier conversation compacted]")
            || m.content.contains("compacted for model context")
    });
    let omitted = prior_len.saturating_sub(retained);
    (retained, omitted, compacted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packing_budget_reserves_headroom_like_broad_triage() {
        let budget = 120_000;
        let pack = synthesis_packing_budget(budget);
        assert_eq!(pack, budget - SYNTHESIS_CONTEXT_HEADROOM_CHARS);
        assert!(has_useful_context_headroom(pack, budget));
        assert!(!has_useful_context_headroom(119_900, budget));
        let small = 40_000;
        let small_pack = synthesis_packing_budget(small);
        assert_eq!(small_pack, small - small / 10);
        assert!(has_useful_context_headroom(small_pack, small));
    }

    #[test]
    fn broad_alias_matches_shared_budget() {
        assert_eq!(
            broad_triage_packing_budget(120_000),
            synthesis_packing_budget(120_000)
        );
    }

    #[test]
    fn packer_is_deterministic_and_preserves_identities() {
        let mut blocks = Vec::new();
        for i in 0..200 {
            blocks.push(format!(
                "hit {i}: seq={i} source=\"worker.log\" template_id={} msg={}",
                i % 7,
                "x".repeat(400)
            ));
        }
        // Lead + rare late identity must survive oversize packing (not only early hits).
        blocks.insert(
            0,
            "LEAD seq=0 source=\"worker.log\" template_id=0 msg=needle-first-event".into(),
        );
        blocks.push(
            "RARE seq=9999 source=\"worker.log\" template_id=99 msg=needle-rare-event".into(),
        );
        let budget = 8_000;
        let a = pack_linked_evidence_blocks(&blocks, budget);
        let b = pack_linked_evidence_blocks(&blocks, budget);
        assert_eq!(a, b);
        assert!(a.identity_lines_included >= 2);
        assert!(a.omitted_blocks > 0 || a.omitted_chars > 0);
        assert!(a.text.chars().count() <= budget);
        assert!(a.text.contains("seq="));
        assert!(a.text.contains("source="));
        assert!(
            a.text.contains("needle-rare-event") && a.text.contains("seq=9999"),
            "rare late identity must survive oversize pack: {}",
            a.text.chars().take(400).collect::<String>()
        );
        assert!(
            a.text.contains("needle-first-event"),
            "first/representative identity must survive: {}",
            a.text.chars().take(400).collect::<String>()
        );
        // Identity counts must match packed text.
        let id_lines = a
            .text
            .lines()
            .filter(|l| line_has_citation_identity(l))
            .count();
        assert_eq!(
            id_lines, a.identity_lines_included,
            "included identity count must match packed lines"
        );
        assert!(a.identity_lines_omitted > 0);
        // Full package near hard budget class would fail headroom check when used as packing fill.
        assert!(!has_useful_context_headroom(119_900, 120_000));
        // Citation lines never split mid-marker
        for line in a.text.lines() {
            if line.contains("seq=") {
                assert!(
                    !line.ends_with("seq") && !line.ends_with("seq="),
                    "truncated identity: {line}"
                );
            }
        }
    }

    #[test]
    fn packer_handles_unicode_without_panic() {
        let blocks = vec![
            "seq=1 source=\"svc/日志—west.log\" msg=αβγδ 🎉🎉🎉".repeat(50),
            "seq=2 source=\"svc/日志—west.log\" msg=こんにちは世界".repeat(50),
        ];
        let packed = pack_linked_evidence_blocks(&blocks, 500);
        assert!(packed.text.chars().count() <= 500);
        // Valid UTF-8 guaranteed by String
        let _ = packed.text.as_str();
        assert!(line_has_citation_identity(
            "seq=1 source=\"svc/日志—west.log\" msg=x"
        ));
    }

    #[test]
    fn packer_dedupes_identical_identity_lines() {
        // Oversize path only: under-budget fast path preserves verbatim joins for
        // broad-triage brief fidelity (no dedupe). Pad so total_chars > budget.
        let pad = "z".repeat(2_000);
        let line = format!("seq=42 source=\"api.log\" template_id=3 msg=hello {pad}");
        let blocks = vec![line.clone(), line.clone(), line.clone()];
        let budget = 3_500; // < 3 * ~2k so rank/dedupe path runs
        assert!(
            blocks.iter().map(|b| b.chars().count()).sum::<usize>() > budget,
            "test setup must force oversize ranked path"
        );
        let packed = pack_linked_evidence_blocks(&blocks, budget);
        let count = packed
            .text
            .lines()
            .filter(|l| l.contains("seq=42") && l.contains("source=\"api.log\""))
            .count();
        assert_eq!(
            count, 1,
            "duplicate identities must collapse on oversize path: {}",
            packed.text
        );
    }

    #[test]
    fn packer_oversize_force_includes_first_and_last_rare_identities() {
        // Huge first identity + many mid hits must not starve the last rare row.
        let mut blocks = Vec::new();
        blocks.push(format!(
            "seq=0 source=\"worker.log\" template_id=0 msg=RARE_FIRST {}",
            "LEAD_PAD ".repeat(40)
        ));
        for i in 1..80 {
            blocks.push(format!(
                "seq={i} source=\"worker.log\" template_id={} msg={}",
                i % 5,
                "EARLY_LONG_HIT ".repeat(80)
            ));
        }
        blocks.push(
            "seq=9999 source=\"worker.log\" template_id=99 msg=needle-rare-event UNIQUE_TAIL"
                .into(),
        );
        let budget = 6_000;
        let packed = pack_linked_evidence_blocks(&blocks, budget);
        assert!(
            packed.omitted_blocks > 0 || packed.omitted_chars > 0,
            "must be an oversize pack"
        );
        assert!(
            packed.text.contains("RARE_FIRST"),
            "first rare must survive: {}",
            packed.text.chars().take(300).collect::<String>()
        );
        assert!(
            packed.text.contains("needle-rare-event") || packed.text.contains("UNIQUE_TAIL"),
            "last rare identity must survive: included={} omitted_blocks={} text_prefix={}",
            packed.identity_lines_included,
            packed.omitted_blocks,
            packed.text.chars().take(300).collect::<String>()
        );
        assert!(packed.text.chars().count() <= budget);
        // Deterministic under reordering of middle blocks only (ends fixed).
        let mut reordered = blocks.clone();
        let last_i = reordered.len() - 1;
        reordered[1..last_i].reverse();
        let packed2 = pack_linked_evidence_blocks(&reordered, budget);
        assert!(packed2.text.contains("RARE_FIRST"));
        assert!(packed2.text.contains("needle-rare-event") || packed2.text.contains("UNIQUE_TAIL"));
    }

    #[test]
    fn packer_tiny_residual_still_keeps_both_identity_strata() {
        let blocks = vec![
            "seq=1 source=\"a.log\" msg=first-rare".into(),
            format!("seq=2 source=\"a.log\" msg={}", "x".repeat(5_000)),
            "seq=3 source=\"a.log\" msg=last-rare".into(),
        ];
        let packed = pack_linked_evidence_blocks(&blocks, 200);
        assert!(packed.text.contains("seq=1") && packed.text.contains("first-rare"));
        assert!(packed.text.contains("seq=3") && packed.text.contains("last-rare"));
        assert!(packed.text.chars().count() <= 200);
    }

    #[test]
    fn identity_key_is_seq_and_source_not_body() {
        let a = identity_key_from_line(r#"seq=7 source="api.log" msg=hello"#);
        let b = identity_key_from_line(r#"seq=7 source="api.log" msg=different body text"#);
        let c = identity_key_from_line(r#"seq=7 source="other.log" msg=hello"#);
        let d = identity_key_from_line(r#"seq=7 source=api.log msg=unquoted"#);
        assert_eq!(a, b, "same seq+source must dedupe across message body");
        assert_ne!(a, c, "different source must remain distinct");
        assert_eq!(a, d, "quoted/unquoted source forms must match");
        assert!(identity_key_from_line("no identity here").is_empty());
        assert!(identity_key_from_line("seq= source=api.log").is_empty());
        assert!(identity_key_from_line("seq=not-a-number source=api.log").is_empty());
        assert!(identity_key_from_line("seq=7 source=").is_empty());
        // Packer collapses same seq/source with different bodies (oversize path).
        let pad = "p".repeat(2_000);
        let blocks = vec![
            format!(r#"seq=1 source="w.log" msg=AAAAAAAA {pad}"#),
            format!(r#"seq=1 source="w.log" msg=BBBBBBBB {pad}"#),
            format!(r#"seq=2 source="w.log" msg=CCCCCCCC {pad}"#),
        ];
        let packed = pack_linked_evidence_blocks(&blocks, 3_500);
        let seq1 = packed
            .text
            .lines()
            .filter(|l| l.contains("seq=1") && l.contains("source="))
            .count();
        assert_eq!(
            seq1, 1,
            "duplicate seq+source must collapse: {}",
            packed.text
        );
        assert!(packed.text.contains("seq=2") || packed.identity_lines_included >= 1);
    }

    #[test]
    fn count_prior_history_multiset_duplicates_and_collisions() {
        use crate::chat::{ChatMessage, Role};
        let prior = vec![
            ChatMessage {
                role: Role::User,
                content: "same".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "same".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "reply".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "reply".into(),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        // Only one copy of each survives prepare
        let prepared = vec![
            ChatMessage {
                role: Role::User,
                content: "same".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "reply".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "same".into(), // current user collides with prior — excluded
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content:
                    "HOST-RETURNED BOUNDED EVIDENCE — current turn only:\nseq=1 source=\"w.log\""
                        .into(),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        let (ret, om, _) = count_prior_history_retention(&prior, &prepared, "same");
        assert_eq!(
            ret, 2,
            "one user + one assistant of the duplicates retained"
        );
        assert_eq!(om, 2);
        // Compaction marker
        let prepared_c = vec![ChatMessage {
            role: Role::System,
            content: "[earlier conversation compacted] summary".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        let (_, _, compacted) = count_prior_history_retention(&prior, &prepared_c, "new question");
        assert!(compacted);
    }

    #[test]
    fn count_prior_history_excludes_user_and_evidence() {
        use crate::chat::{ChatMessage, Role};
        let prior = vec![
            ChatMessage {
                role: Role::User,
                content: "old question".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "old answer".into(),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        let prepared = vec![
            ChatMessage {
                role: Role::System,
                content: "sys".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "old question".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "old answer".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "current question".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content:
                    "HOST-RETURNED BOUNDED EVIDENCE — current turn only:\nseq=1 source=\"w.log\""
                        .into(),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        let (ret, om, _c) = count_prior_history_retention(&prior, &prepared, "current question");
        assert_eq!(ret, 2, "both prior messages retained");
        assert_eq!(om, 0);
        // Drop one prior from prepared → omitted=1
        let prepared2: Vec<_> = prepared
            .into_iter()
            .filter(|m| m.content != "old answer")
            .collect();
        let (ret2, om2, _) = count_prior_history_retention(&prior, &prepared2, "current question");
        assert_eq!(ret2, 1);
        assert_eq!(om2, 1);
    }

    #[test]
    fn compact_correction_is_much_smaller_than_full_flood() {
        let mut blocks = Vec::new();
        for i in 0..100 {
            blocks.push(format!("seq={i} source=\"s.log\" msg={}", "y".repeat(800)));
        }
        let full = pack_linked_evidence_blocks(&blocks, 50_000);
        let (sys, _user, compact) =
            compact_correction_package("SYS", "what broke?", &blocks, 120_000);
        assert!(sys.contains("ContextDesk will attach"));
        assert!(sys.contains("DO NOT emit seq="));
        assert!(compact.included_chars < full.included_chars);
        assert!(compact.included_chars < 50_000);
        assert!(compact.text.contains("seq="));
    }

    #[test]
    fn capacity_source_unknown_configured_label() {
        assert_eq!(
            CapacitySourceLabel::from_budget_source(ContextBudgetSource::Default, true).as_str(),
            "unknown_configured"
        );
        assert_eq!(
            CapacitySourceLabel::from_budget_source(ContextBudgetSource::Declared, false).as_str(),
            "declared"
        );
    }

    #[test]
    fn mutation_near_ceiling_fails_headroom_gate() {
        // The near-full package class from the production defect must not pass.
        assert!(!has_useful_context_headroom(119_900, 120_000));
        assert!(!has_useful_context_headroom(120_000, 120_000));
        let pack = synthesis_packing_budget(120_000);
        assert!(has_useful_context_headroom(pack, 120_000));
        // Filling only the packing budget still leaves useful headroom on hard budget.
        assert!(has_useful_context_headroom(pack, 120_000));
    }

    #[test]
    fn trail_step_contains_required_fields() {
        let packed = pack_linked_evidence_blocks(&["seq=1 source=\"a.log\" msg=hi".into()], 1000);
        let tel = telemetry_from_parts(TelemetryParts {
            model_round: 2,
            hard_budget_chars: 120_000,
            packing_budget_chars: synthesis_packing_budget(120_000),
            used_chars_estimate: 50_000,
            evidence_pre_pack_chars: 80_000,
            packed: &packed,
            history_retained_messages: 3,
            history_omitted_messages: 10,
            history_compacted: true,
            provider_capacity_source: CapacitySourceLabel::Configured,
        });
        let step = tel.trail_step();
        for key in [
            "round=",
            "used=",
            "budget=",
            "hard=",
            "packing_budget=",
            "packing=",
            "reserved=",
            "evidence_included=",
            "evidence_omitted_blocks=",
            "history_retained=",
            "capacity_source=",
            "useful_headroom=",
        ] {
            assert!(step.contains(key), "missing {key} in {step}");
        }
    }
}
