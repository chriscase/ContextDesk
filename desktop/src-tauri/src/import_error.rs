//! User-facing sanitation for import preview/run errors (#751 surfaces).
//!
//! The engine annotates a preview-stage failure with the failing member's
//! RAW identity behind a `[member=…]` transport marker so the typed outcome
//! contract (`cd_core::log_analysis::import_outcome`) can locate it after
//! the fact. The CLI strips that marker and re-states the member through the
//! contract's REDACTED locator (`crates/cd-cli/src/commands/import.rs`);
//! this module is the desktop host's side of the same rule, so neither the
//! marker nor an unscrubbed identity ever reaches the WebView. Import
//! surfaces must route engine errors through [`user_facing_import_error`],
//! never a bare `to_string()`.

use cd_core::error::CoreError;
use cd_core::log_analysis::import_outcome::{strip_member_annotation, ImportOutcomeReport};

/// Engine error → operator-safe message, mirroring the CLI's handling.
///
/// The engine's own wording leads (existing callers match on it), the
/// transport marker is stripped, and — when the error was annotated with a
/// member — the failing source is appended by its secret-scrubbed locator
/// and stable defect code from the typed outcome contract.
pub fn user_facing_import_error(error: &CoreError) -> String {
    let raw = error.to_string();
    let message = strip_member_annotation(&raw);
    if message.len() == raw.len() {
        // No annotation to strip — pass the engine wording through
        // unchanged, exactly as the CLI does for an unannotated failure.
        return raw;
    }
    let rejected = ImportOutcomeReport::rejected_from_error(error);
    match rejected.defects.first() {
        Some(defect) => format!(
            "{message}\n\nfailing source: {} ({})",
            defect.source.identity,
            defect.code.as_str()
        ),
        None => message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn annotated(message: &str) -> CoreError {
        CoreError::Message(message.to_string())
    }

    /// The exact string the preview walk produces for a corrupt nested
    /// container (see `crates/cd-core/tests/import_outcome_contract.rs`,
    /// `a_preview_stage_rejection_still_names_the_member`) must reach the
    /// WebView with the marker stripped and the member named by the
    /// contract's locator — the CLI's presentation, not the raw engine one.
    #[test]
    fn strips_the_transport_marker_and_names_the_member_by_redacted_locator() {
        let error = annotated("zip open: invalid Zip archive [member=bundles/inner.zip]");
        let shown = user_facing_import_error(&error);
        assert!(
            !shown.contains("[member="),
            "the transport marker must not reach the operator: {shown}"
        );
        assert!(
            shown.starts_with("zip open: invalid Zip archive"),
            "the engine's own wording must survive in front: {shown}"
        );
        assert!(
            shown.contains("failing source: bundles/inner.zip (archive_unreadable)"),
            "the failing member must be named with its stable code: {shown}"
        );
    }

    /// A credential-shaped member name is structural identity and must be
    /// scrubbed by the locator before display, exactly as in the CLI report.
    #[test]
    fn secret_bearing_member_identities_are_scrubbed_before_display() {
        let error = annotated(
            "zip open: invalid Zip archive [member=archive.zip!/sk-abcdefghijklmnopqrst.zip]",
        );
        let shown = user_facing_import_error(&error);
        assert!(
            !shown.contains("abcdefghijklmnopqrst"),
            "credential-shaped member name must not reach the WebView: {shown}"
        );
        assert!(shown.contains("failing source:"), "{shown}");
    }

    #[test]
    fn unannotated_errors_pass_through_unchanged() {
        let error = CoreError::Message("nothing importable found".into());
        let shown = user_facing_import_error(&error);
        assert_eq!(shown, "nothing importable found");
        assert!(!shown.contains("failing source:"));
    }

    /// Wiring guard: the import surfaces must route engine errors through
    /// this module — a bare `error.to_string()` on these paths is exactly
    /// the leak this module exists to close.
    #[test]
    fn import_surfaces_route_errors_through_this_sanitizer() {
        let source = include_str!("lib.rs");
        for (function, window) in [
            ("async fn log_preview_import(", 2600),
            ("async fn log_run_import(", 3400),
            ("async fn run_log_ingest(", 5000),
        ] {
            let start = source.find(function).expect(function);
            let body: String = source[start..].chars().take(window).collect();
            assert!(
                body.contains("user_facing_import_error"),
                "{function} must sanitize engine errors before they reach the frontend"
            );
        }
    }
}
