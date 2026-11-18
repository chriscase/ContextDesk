//! Memory-only, one-shot handles for host-authored import-attempt diagnostics.
use cd_core::log_analysis::import_attempt_diagnostic::ImportAttemptDiagnostic;
use std::collections::VecDeque;

const MAX_REPORTS: usize = 16;
struct Entry {
    id: String,
    started: bool,
    report: Option<ImportAttemptDiagnostic>,
    // Private binding only; never serialized/exported.
    preview_token: Option<String>,
}
#[derive(Default)]
pub struct ImportAttemptReports {
    entries: VecDeque<Entry>,
}
impl ImportAttemptReports {
    pub fn reserve(&mut self) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.entries.push_back(Entry {
            id: id.clone(),
            started: false,
            report: None,
            preview_token: None,
        });
        while self.entries.len() > MAX_REPORTS {
            self.entries.pop_front();
        }
        id
    }
    pub fn start(&mut self, id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("import diagnostic expired; start a new attempt")?;
        if entry.started {
            return Err("import diagnostic already belongs to an attempt".into());
        }
        entry.started = true;
        Ok(())
    }
    pub fn finish(
        &mut self,
        id: &str,
        report: ImportAttemptDiagnostic,
        preview_token: Option<String>,
    ) {
        // An evicted/expired report must never resurrect or replace another attempt.
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id && entry.started && entry.report.is_none())
        {
            entry.report = Some(report);
            entry.preview_token = preview_token;
        }
    }
    pub fn preview(&self, token: &str) -> Option<ImportAttemptDiagnostic> {
        self.entries
            .iter()
            .rev()
            .find(|entry| entry.preview_token.as_deref() == Some(token))
            .and_then(|entry| entry.report.clone())
    }
    pub fn snapshot(&self, id: &str) -> Result<ImportAttemptDiagnostic, String> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.report.clone())
            .ok_or_else(|| "import diagnostic is unavailable, still running, or expired".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::FailedIngestSourceKind;
    #[test]
    fn rejected_admission_has_its_own_terminal_snapshot() {
        let mut store = ImportAttemptReports::default();
        let id = store.reserve();
        store.start(&id).unwrap();
        let mut report = ImportAttemptDiagnostic::new(FailedIngestSourceKind::Unknown);
        report.finish_failure(false, Default::default());
        store.finish(&id, report, None);
        let json = store.snapshot(&id).unwrap().to_json().unwrap();
        assert!(json.contains("\"status\": \"failed\""));
        assert!(!json.contains(&id));
        assert!(store.start(&id).is_err());
    }
    #[test]
    fn handles_are_one_shot_bounded_and_never_fall_back_to_latest() {
        let mut store = ImportAttemptReports::default();
        let first = store.reserve();
        assert!(store.snapshot(&first).is_err());
        store.start(&first).unwrap();
        assert!(store.start(&first).is_err());
        store.finish(
            &first,
            ImportAttemptDiagnostic::new(FailedIngestSourceKind::Unknown),
            Some("private-plan-token".into()),
        );
        assert!(store.snapshot(&first).is_ok());
        assert!(store.snapshot("unknown").is_err());
        assert!(store.preview("different-token").is_none());
        for _ in 0..MAX_REPORTS {
            store.reserve();
        }
        assert!(store.snapshot(&first).is_err());
        assert!(store.preview("private-plan-token").is_none());
        store.finish(
            &first,
            ImportAttemptDiagnostic::new(FailedIngestSourceKind::Unknown),
            None,
        );
        assert!(store.snapshot(&first).is_err());
    }
}
