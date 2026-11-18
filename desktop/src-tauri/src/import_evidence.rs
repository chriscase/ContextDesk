//! Process-local authorization for on-demand reads from a successfully previewed source.
use cd_core::log_analysis::import_preview::ImportPreviewPlan;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct EvidencePreviewGrants {
    entries: VecDeque<(PathBuf, String, u32, Instant)>,
}
impl EvidencePreviewGrants {
    pub fn remember(&mut self, path: PathBuf, plan: &ImportPreviewPlan) {
        if plan.report.truncated {
            return;
        }
        self.entries.retain(|(p, _, _, _)| p != &path);
        self.entries.push_back((
            path,
            plan.plan_token.clone(),
            plan.plan_version,
            Instant::now(),
        ));
        while self.entries.len() > 16 {
            self.entries.pop_front();
        }
    }
    pub fn permits(&self, path: &Path, token: &str, version: u32) -> bool {
        self.entries.iter().any(|(p, t, v, at)| {
            p == path && t == token && *v == version && at.elapsed() <= Duration::from_secs(15 * 60)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_bind_every_parameter_and_expire() {
        let mut grants = EvidencePreviewGrants::default();
        grants
            .entries
            .push_back((PathBuf::from("selected"), "token".into(), 1, Instant::now()));
        assert!(grants.permits(Path::new("selected"), "token", 1));
        assert!(!grants.permits(Path::new("other"), "token", 1));
        assert!(!grants.permits(Path::new("selected"), "forged", 1));
        assert!(!grants.permits(Path::new("selected"), "token", 2));
        grants.entries[0].3 = Instant::now() - Duration::from_secs(901);
        assert!(!grants.permits(Path::new("selected"), "token", 1));
    }
}
