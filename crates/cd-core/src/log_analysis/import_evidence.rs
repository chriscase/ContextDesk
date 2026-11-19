//! On-demand, plan-bound supporting HTML inspection. No raw markup crosses the host.
use std::path::Path;

use serde::Serialize;

use super::html_diagnostic::{detect_and_extract, HtmlDiagnostic, MAX_HTML_BYTES};
use super::import_preview::{
    preview_import_plan, ImportItemStatus, ImportPreviewReason, IMPORT_PLAN_VERSION,
};
use crate::error::{CoreError, CoreResult};

/// Bounded, passive plaintext for one host-verified supporting document.
#[derive(Debug, Serialize)]
pub struct ImportEvidenceText {
    /// Redacted plaintext only; empty when a safe projection is unavailable.
    pub text: String,
    /// Whether the complete readable projection could not be returned.
    pub truncated: bool,
    /// Stable classifier reason, never source or operating-system text.
    pub reason: String,
}

fn refused() -> CoreError {
    CoreError::Policy("supporting document unavailable; preview the selected source again".into())
}

/// The host must additionally bind the token to a source it previously previewed.
/// Verification is repeated after the bounded read: no result is returned if
/// inventory, classification or sampled content changed while resolving it.
pub fn inspect_import_evidence(
    path: &Path,
    plan_token: &str,
    plan_version: u32,
    identity: &str,
) -> CoreResult<ImportEvidenceText> {
    if plan_version != IMPORT_PLAN_VERSION || plan_token.len() != 64 {
        return Err(refused());
    }
    let plan = preview_import_plan(path, None).map_err(|_| refused())?;
    if plan.report.truncated || plan.plan_token != plan_token {
        return Err(refused());
    }
    let mut matching = plan
        .report
        .items
        .iter()
        .filter(|item| item.identity == identity);
    let item = matching.next().ok_or_else(refused)?;
    if matching.next().is_some()
        || item.status != ImportItemStatus::Supporting
        || !item
            .reasons
            .contains(&ImportPreviewReason::HtmlEventParsingUnsupported)
    {
        return Err(refused());
    }
    if item.bytes > MAX_HTML_BYTES as u64 {
        return Ok(ImportEvidenceText {
            text: String::new(),
            truncated: true,
            reason: "input_limit".into(),
        });
    }
    let bytes = super::ingest::read_import_evidence_bytes(path, identity, MAX_HTML_BYTES)
        .map_err(|_| refused())?;
    if bytes.len() as u64 != item.bytes {
        return Err(refused());
    }
    let mut reader = std::io::Cursor::new(&bytes);
    let sample = if plan.report.source_kind == super::import_preview::ImportSourceKind::Archive
        || identity.contains("!/")
    {
        match super::import_preview::sample_streaming(&mut reader, bytes.len() as u64, None)? {
            super::import_preview::SampleOutcome::Sampled(sample) => sample,
            super::import_preview::SampleOutcome::ReadFailed => return Err(refused()),
        }
    } else {
        super::import_preview::sample_bounded(&mut reader, bytes.len() as u64)
    };
    let captured =
        super::import_preview::item_from_sample(identity, bytes.len() as u64, &sample, None, false);
    if captured.plan_fingerprint != item.plan_fingerprint {
        return Err(refused());
    }
    let HtmlDiagnostic::Document {
        visible_text,
        visible_truncated,
        reason,
    } = detect_and_extract(&bytes)
    else {
        return Err(refused());
    };
    let after = preview_import_plan(path, None).map_err(|_| refused())?;
    if after.report.truncated || after.plan_token != plan_token {
        return Err(refused());
    }
    // Reuse both established credential scrubbers, and never expose evaluator markers.
    let scrubbed = super::redact_log::redact_message(&visible_text);
    let candidate = crate::redact::redact_candidate(&scrubbed);
    let mut text = if candidate.blocked {
        "[credential-dominant document redacted]".to_string()
    } else if crate::incident_evidence::contains_forbidden_sentinel(&candidate.text) {
        "[protected evaluator marker omitted]".to_string()
    } else {
        candidate.text
    };
    let truncated = visible_truncated || text.len() > 8192;
    if text.len() > 8192 {
        let mut end = 8192;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Ok(ImportEvidenceText {
        text,
        truncated,
        reason: reason.into(),
    })
}
