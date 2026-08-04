//! Shared provider-reachability probe wrapper — used by
//! `contextdesk config init --check-connection` and
//! `contextdesk doctor`'s `provider_connectivity` check.
//!
//! Wraps `cd_core::discovery::probe_provider` with the one CLI-specific
//! policy every caller here needs: refuse the probe for an isolated
//! `xai-grok-build` profile rather than silently reading the real
//! `~/.grok/auth.json` session (see `docs/CLI.md`'s isolated-profiles
//! section for why that session can never be scoped by `--data-dir`).
//! Neither caller re-implements `cd_core::discovery::probe_provider` itself
//! — this module only adds the CLI-level skip decision around it.

use cd_core::discovery::{self, ProbeOutcome};
use cd_core::providers::{ProviderKind, ProviderProfile};

/// A provider reachability probe's outcome, classified for both a stable
/// pass/fail readiness signal (`is_pass`) and a human summary string
/// (`summary`) — the same text `config init --check-connection` has always
/// printed, now also consumable as structured data by `contextdesk doctor`.
#[derive(Debug, Clone)]
pub(crate) enum ProviderProbeVerdict {
    Reachable {
        reason: String,
    },
    KeyRejected {
        reason: String,
    },
    Unreachable {
        reason: String,
    },
    /// The probe was never attempted — e.g. an isolated `xai-grok-build`
    /// profile. Never counted as a pass.
    Skipped {
        reason: String,
    },
}

impl ProviderProbeVerdict {
    /// True only for a real, successful reachability probe. `KeyRejected`,
    /// `Unreachable`, and `Skipped` are all non-passing — a caller that
    /// only checks "did the probe run without an internal bug" would wrongly
    /// treat "the key was rejected" as readiness.
    pub(crate) fn is_pass(&self) -> bool {
        matches!(self, Self::Reachable { .. })
    }

    pub(crate) fn summary(&self) -> String {
        match self {
            Self::Reachable { reason } => format!("reachable ({reason})"),
            Self::KeyRejected { reason } => format!("key rejected ({reason})"),
            Self::Unreachable { reason } => format!("unreachable ({reason})"),
            Self::Skipped { reason } => format!("skipped: {reason}"),
        }
    }
}

/// Run the safe connectivity check both callers promise: base URL and, if
/// configured, the given key — never corpus content, never a second read
/// from the secret store (the caller resolves the key once and passes it
/// in).
pub(crate) async fn probe_provider(
    profile: &ProviderProfile,
    secret: Option<String>,
    isolated: bool,
) -> ProviderProbeVerdict {
    if isolated && matches!(profile.kind, ProviderKind::XaiGrokBuild) {
        return ProviderProbeVerdict::Skipped {
            reason: "a Grok Build session is read from the real ~/.grok/auth.json, \
                which an isolated --data-dir profile cannot probe without breaking isolation — \
                rerun this check outside an isolated profile"
                .to_string(),
        };
    }
    match discovery::probe_provider(profile, secret).await {
        ProbeOutcome::Reachable { reason } => ProviderProbeVerdict::Reachable { reason },
        ProbeOutcome::KeyRejected { reason } => ProviderProbeVerdict::KeyRejected { reason },
        ProbeOutcome::Unreachable { reason } => ProviderProbeVerdict::Unreachable { reason },
    }
}
