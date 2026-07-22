//! Build / runtime identity for About, diagnostics, and update channel honesty (#338).

use serde::{Deserialize, Serialize};

use crate::{PROTOCOL_VERSION, VERSION};

/// How this binary should be treated for updates and UX.
///
/// - [`BuildChannel::Dev`]: source/`cargo`/debug or unsigned local release — do not
///   claim installer auto-update.
/// - [`BuildChannel::Installed`]: packaged desktop build (release channel env or
///   packaging sets `CD_CHANNEL=installed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildChannel {
    /// Development / source run.
    Dev,
    /// Installed application build (signed updater applies).
    Installed,
}

impl BuildChannel {
    /// Wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Installed => "installed",
        }
    }

    /// Parse wire string.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "dev" | "development" | "source" => Some(Self::Dev),
            "installed" | "release" | "prod" | "production" => Some(Self::Installed),
            _ => None,
        }
    }
}

impl std::fmt::Display for BuildChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Snapshot of what build is running.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildIdentity {
    /// Cargo package version.
    pub version: String,
    /// Protocol version (`cd.v1`).
    pub protocol: String,
    /// Update/UX channel.
    pub channel: BuildChannel,
    /// Short git SHA when embedded at build time.
    pub git_sha: Option<String>,
    /// `git describe` when embedded at build time.
    pub git_describe: Option<String>,
}

impl BuildIdentity {
    /// One-line label for Settings / error reports.
    pub fn display_line(&self) -> String {
        let mut parts = vec![
            format!("v{}", self.version),
            format!("channel={}", self.channel.as_str()),
            format!("protocol={}", self.protocol),
        ];
        if let Some(sha) = &self.git_sha {
            parts.push(format!("git={sha}"));
        } else if let Some(d) = &self.git_describe {
            parts.push(format!("git={d}"));
        }
        parts.join(" · ")
    }
}

/// Resolve channel from debug flag + optional env (`CD_CHANNEL`).
///
/// Pure: offline unit-testable. Defaults to **dev** unless env explicitly
/// selects installed (packaged builds should set `CD_CHANNEL=installed`).
pub fn resolve_channel(debug_assertions: bool, channel_env: Option<&str>) -> BuildChannel {
    if let Some(raw) = channel_env {
        if let Some(c) = BuildChannel::parse(raw) {
            return c;
        }
    }
    if debug_assertions {
        BuildChannel::Dev
    } else {
        // Release binary without packaging env: still treat as dev so source
        // `cargo run --release` does not claim installer updates.
        BuildChannel::Dev
    }
}

/// Prefer non-empty SHA; reject obvious placeholders.
pub fn resolve_git_field(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() || s == "unknown" || s == "0" {
        return None;
    }
    Some(s.to_string())
}

/// Build identity from explicit pieces (tests + hosts).
pub fn build_identity_from(
    version: impl Into<String>,
    protocol: impl Into<String>,
    debug_assertions: bool,
    channel_env: Option<&str>,
    git_sha: Option<&str>,
    git_describe: Option<&str>,
) -> BuildIdentity {
    BuildIdentity {
        version: version.into(),
        protocol: protocol.into(),
        channel: resolve_channel(debug_assertions, channel_env),
        git_sha: resolve_git_field(git_sha),
        git_describe: resolve_git_field(git_describe),
    }
}

/// Current process identity (uses compile-time git env when present).
pub fn current() -> BuildIdentity {
    let channel_env = std::env::var("CD_CHANNEL").ok();
    let git_sha = option_env!("CD_GIT_SHA");
    let git_describe = option_env!("CD_GIT_DESCRIBE");
    build_identity_from(
        VERSION,
        PROTOCOL_VERSION,
        cfg!(debug_assertions),
        channel_env.as_deref(),
        git_sha,
        git_describe,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_env_installed_wins_over_debug() {
        assert_eq!(
            resolve_channel(true, Some("installed")),
            BuildChannel::Installed
        );
        assert_eq!(resolve_channel(true, None), BuildChannel::Dev);
        assert_eq!(resolve_channel(false, None), BuildChannel::Dev);
        assert_eq!(
            resolve_channel(false, Some("installed")),
            BuildChannel::Installed
        );
    }

    #[test]
    fn channel_parse_aliases() {
        assert_eq!(BuildChannel::parse("DEV"), Some(BuildChannel::Dev));
        assert_eq!(
            BuildChannel::parse("production"),
            Some(BuildChannel::Installed)
        );
        assert_eq!(BuildChannel::parse("nope"), None);
    }

    #[test]
    fn git_field_filters_empty() {
        assert_eq!(resolve_git_field(Some("  ")), None);
        assert_eq!(resolve_git_field(Some("unknown")), None);
        assert_eq!(
            resolve_git_field(Some("abc1234")),
            Some("abc1234".into())
        );
    }

    #[test]
    fn display_line_includes_channel_and_optional_git() {
        let id = build_identity_from(
            "0.1.0",
            "cd.v1",
            true,
            None,
            Some("deadbeef"),
            Some("v0.1.0-1-gdeadbeef"),
        );
        let line = id.display_line();
        assert!(line.contains("v0.1.0"));
        assert!(line.contains("channel=dev"));
        assert!(line.contains("protocol=cd.v1"));
        assert!(line.contains("git=deadbeef"));
    }

    #[test]
    fn current_returns_crate_version() {
        let id = current();
        assert_eq!(id.version, VERSION);
        assert_eq!(id.protocol, PROTOCOL_VERSION);
        assert!(matches!(
            id.channel,
            BuildChannel::Dev | BuildChannel::Installed
        ));
    }
}
