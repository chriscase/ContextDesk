//! Share-safe privacy boundary and scanner used by public triage contracts.

use serde::{Deserialize, Serialize};

/// Explicit privacy boundary for a packet or event (share-safe vs owner-only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketPrivacyBoundary {
    /// Safe to share without secrets, endpoints, private paths, or raw bodies.
    ShareSafe,
    /// Owner-only; may retain more detail but must never be the default export.
    OwnerOnly,
}

/// Substrings forbidden in share-safe extension artifacts (lowercase match).
pub const PRIVACY_FORBIDDEN_SUBSTRINGS: &[&str] = &[
    "sk-",
    "api_key",
    "apikey",
    "authorization",
    "bearer ",
    "password=",
    "token=",
    "credential=",
    "/users/",
    "/home/",
    "/private/",
    "/var/folders/",
    "c:\\users\\",
    "file://",
    "http://",
    "https://",
];

/// One privacy scan finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyFinding {
    /// Matched forbidden needle.
    pub needle: String,
}

impl std::fmt::Display for PrivacyFinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "forbidden substring `{}`", self.needle)
    }
}

/// Scan text for absolute paths and credential-shaped substrings.
pub fn scan_share_safe_text(text: &str) -> Vec<PrivacyFinding> {
    let normalized = text.to_ascii_lowercase();
    let mut findings = Vec::new();
    for token in PRIVACY_FORBIDDEN_SUBSTRINGS {
        if normalized.contains(token) {
            findings.push(PrivacyFinding {
                needle: (*token).to_string(),
            });
        }
    }
    findings
}
