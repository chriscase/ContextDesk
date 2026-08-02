//! `ImportProfile v1` — a portable, declarative, versioned import plan.
//!
//! An import profile records *how a recurring corpus should be imported* so the same
//! decision does not have to be re-made by hand every incident: which paths to
//! include or exclude, which sources belong together, what role each plays,
//! and which already-registered format/framing/timestamp profiles apply.
//!
//! # What an import profile deliberately is not
//!
//! * **Not code.** There is no scripting hook and no user-supplied regex. The
//!   only matching primitive is [`SafePattern`], a bounded glob with linear
//!   matching (see its docs for why alternation and backtracking are absent).
//! * **Not a parser.** An import profile may *reference* a format profile by id and
//!   version, but a reference never activates a parser on its own. #751 and
//!   #791 both forbid treating a filename as proof of a format, so
//!   [`match_profile`] only reports a format reference as applied when the
//!   item's own **content fingerprint already agrees**. A path pattern that
//!   claims `json-object-line` over plain text is reported as
//!   [`ProfileFindingKind::Drift`], never honoured.
//! * **Not an importer.** [`match_profile`] is pure: it reads an
//!   [`ImportPreviewReport`], returns explanations, and mutates nothing. It
//!   cannot publish a corpus even if asked.
//! * **Not editable in place.** An import profile's identity is
//!   `(profile_id, version, digest)`. Editing means producing a new version
//!   whose digest differs, so an import can always name the exact document it
//!   used ([`ImportProfile::identity`]).
//!
//! # Relationship to the existing format-profile registry
//!
//! The issues' vocabulary for "a declarative description of a log grammar" is
//! **format profile** ([`super::format_profile`]), and that registry already
//! ships. An import profile does not duplicate or replace it — it is the layer above,
//! binding *sources* to *already-registered profiles*. Keeping these separate
//! is what prevents a second, competing notion of "what format is this".

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::import_preview::{
    ImportItemRole, ImportItemStatus, ImportPreviewItem, ImportPreviewReport,
};

/// Schema identifier carried by every import-profile document.
pub const IMPORT_PROFILE_SCHEMA_ID: &str = "contextdesk.import_profile.v1";

/// Highest schema this build can read.
///
/// A document declaring a higher `minReaderVersion` is rejected rather than
/// partially understood, matching [`crate::incident_evidence::READER_VERSION`].
pub const IMPORT_PROFILE_READER_VERSION: u32 = 1;

/// Maximum bytes of a serialized import-profile document.
pub const MAX_IMPORT_PROFILE_BYTES: u64 = 256 * 1024;

/// Maximum patterns across all rules in one profile.
pub const MAX_IMPORT_PROFILE_PATTERNS: usize = 256;

/// Maximum characters in one pattern.
pub const MAX_IMPORT_PROFILE_PATTERN_CHARS: usize = 256;

/// Maximum wildcards in one pattern.
///
/// Bounds matcher work per pattern. The matcher is already linear, so this is
/// defence in depth against a pathological document rather than the primary
/// protection.
pub const MAX_IMPORT_PROFILE_PATTERN_WILDCARDS: usize = 16;

/// Maximum source groups in one profile.
pub const MAX_IMPORT_PROFILE_GROUPS: usize = 64;

/// Maximum path segments a `**` may span.
pub const MAX_IMPORT_PROFILE_PATTERN_SEGMENTS: usize = 32;

/// Maximum characters in an identifier field.
pub const MAX_IMPORT_PROFILE_ID_CHARS: usize = 128;

/// A bounded glob pattern. The only matching primitive an import profile may contain.
///
/// # Grammar
///
/// | Token | Meaning |
/// | --- | --- |
/// | `?` | exactly one character, not `/` |
/// | `*` | zero or more characters, not `/` |
/// | `**` | zero or more whole path segments |
/// | anything else | a literal character |
///
/// # Why not regex
///
/// #751 requires bounded CPU and explicitly lists catastrophic regex as an
/// adversarial case to defend against. A user-supplied regex cannot be
/// accepted safely without a compile-time complexity analysis this project
/// does not have. This grammar has no alternation, no backreferences, and no
/// nested quantifiers, so [`SafePattern::matches`] runs in `O(pattern × path)`
/// with no backtracking blowup — `*` never needs to reconsider a choice
/// because it can only extend within a single segment.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SafePattern(String);

impl SafePattern {
    /// Wrap a pattern string without validating it.
    ///
    /// Validation happens in [`validate_profile`]; an unvalidated pattern still
    /// cannot do anything unsafe because [`SafePattern::matches`] is total.
    pub fn new(pattern: impl Into<String>) -> Self {
        Self(pattern.into())
    }

    /// The raw pattern text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Structural problems with this pattern, as stable codes.
    pub fn problems(&self) -> Vec<ProfileDiagnosticCode> {
        let mut out = Vec::new();
        if self.0.is_empty() {
            out.push(ProfileDiagnosticCode::PatternEmpty);
            return out;
        }
        if self.0.chars().count() > MAX_IMPORT_PROFILE_PATTERN_CHARS {
            out.push(ProfileDiagnosticCode::PatternTooLong);
        }
        if self.0.chars().filter(|c| *c == '*' || *c == '?').count()
            > MAX_IMPORT_PROFILE_PATTERN_WILDCARDS
        {
            out.push(ProfileDiagnosticCode::PatternTooManyWildcards);
        }
        if self.0.split('/').count() > MAX_IMPORT_PROFILE_PATTERN_SEGMENTS {
            out.push(ProfileDiagnosticCode::PatternTooManySegments);
        }
        if self.0.starts_with('/') || self.0.contains('\\') {
            out.push(ProfileDiagnosticCode::PatternNotRelative);
        }
        if self
            .0
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
        {
            // An import profile must not be able to describe anything outside the
            // selected root, even though the preview identities it matches
            // against are already normalized.
            out.push(ProfileDiagnosticCode::PatternTraversal);
        }
        if self.0.contains('\0') {
            out.push(ProfileDiagnosticCode::PatternControlCharacter);
        }
        if self.0.split('/').any(str::is_empty) {
            // A trailing or doubled separator yields an empty segment, which
            // no portable identity can contain — the pattern would validate
            // clean and then silently match nothing.
            out.push(ProfileDiagnosticCode::PatternEmptySegment);
        }
        out
    }

    /// Whether this pattern matches a preview identity.
    ///
    /// Matching is performed against the portable identity, including the
    /// `archive!/member` form, so an import profile can address archive members without
    /// a separate syntax.
    pub fn matches(&self, identity: &str) -> bool {
        let pattern_segments: Vec<&str> = self.0.split('/').collect();
        let identity_segments: Vec<&str> = identity.split('/').collect();
        match_segments(&pattern_segments, &identity_segments)
    }
}

/// Segment-wise matcher supporting `**`.
///
/// Uses the same greedy single-backtrack algorithm as [`match_segment`], but
/// over path segments, with `**` playing the role `*` plays over characters.
/// Iterative, one backtrack point, so `O(pattern × path)` with no stack growth.
///
/// An earlier version recursed with `(0..=identity.len()).any(...)` per `**`.
/// That was **not** linear despite its comment claiming so: every `**`
/// multiplied the search space. Measured directly, a schema-valid nine-segment
/// pattern against a forty-segment identity took **10.2 seconds** — a CPU
/// denial of service reachable from an import profile that passes validation. The
/// original linearity test only exercised `*` inside a single segment, which
/// was always linear, so it never covered this. `globstar_matching_stays_linear`
/// pins the fix.
fn match_segments(pattern: &[&str], identity: &[&str]) -> bool {
    let (mut p, mut c) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);

    while c < identity.len() {
        if p < pattern.len() && pattern[p] != "**" && match_segment(pattern[p], identity[c]) {
            p += 1;
            c += 1;
        } else if p < pattern.len() && pattern[p] == "**" {
            star = p;
            resume = c;
            p += 1;
        } else if star != usize::MAX {
            p = star + 1;
            resume += 1;
            c = resume;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == "**" {
        p += 1;
    }
    p == pattern.len()
}

/// Match one path segment against one pattern segment.
///
/// Greedy `*` with a single backtrack pointer — the classic linear glob
/// algorithm. No recursion, so no stack growth on hostile input.
fn match_segment(pattern: &str, candidate: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    let (mut p, mut c) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);

    while c < candidate.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == candidate[c]) {
            p += 1;
            c += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = p;
            resume = c;
            p += 1;
        } else if star != usize::MAX {
            p = star + 1;
            resume += 1;
            c = resume;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

/// Scope a import profile applies to.
///
/// #751 requires that a user's correction never silently changes global
/// behaviour, so scope is mandatory and has no "all corpora" value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileScope {
    /// Free-form product or team label chosen by the author.
    pub label: String,
}

/// Reference to an already-registered profile.
///
/// A reference names something the build already knows how to do. It cannot
/// define new parsing behaviour, which is what keeps import profiles declarative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileRef {
    /// Registered profile identifier, e.g. `json-object-line`.
    pub id: String,
    /// Registered profile version.
    pub version: u16,
}

/// One named group of sources with a proposed role and optional references.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceGroupRule {
    /// Stable identifier for this group inside the profile.
    pub group_id: String,
    /// Identities to include.
    pub include: Vec<SafePattern>,
    /// Identities to exclude, applied after `include`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<SafePattern>,
    /// Role assigned to matching sources.
    pub role: ImportItemRole,
    /// Format profile expected for matching sources, if any.
    ///
    /// Expected — not imposed. See [`match_profile`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_profile: Option<ProfileRef>,
    /// Framing profile reference, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing_profile: Option<ProfileRef>,
    /// Timestamp/timezone policy reference, if any.
    ///
    /// A reference to a policy the user already reviewed. It never encodes a
    /// timezone guess: an absent declaration stays unresolved, per #670/#813.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_policy: Option<String>,
}

/// A portable, versioned import plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProfile {
    /// Must equal [`IMPORT_PROFILE_SCHEMA_ID`].
    pub schema_id: String,
    /// Lowest reader version that can interpret this document.
    pub min_reader_version: u32,
    /// Stable identity across versions.
    pub profile_id: String,
    /// Monotonically increasing version. Editing produces a new version.
    pub version: u32,
    /// Scope this import profile applies to.
    pub scope: ProfileScope,
    /// Human-readable name.
    pub name: String,
    /// Source group rules, evaluated in order.
    pub source_groups: Vec<SourceGroupRule>,
}

/// Content-addressed identity of one exact import-profile document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProfileIdentity {
    /// Stable identity across versions.
    pub profile_id: String,
    /// This document's version.
    pub version: u32,
    /// Hex SHA-256 over the canonical serialization.
    pub digest: String,
}

impl ImportProfile {
    /// Content-addressed identity of this exact document.
    ///
    /// Any edit changes the digest, so an import can record precisely which
    /// document it used and a later reader can prove the document has not been
    /// altered since.
    pub fn identity(&self) -> ImportProfileIdentity {
        ImportProfileIdentity {
            profile_id: self.profile_id.clone(),
            version: self.version,
            digest: self.digest(),
        }
    }

    /// Hex SHA-256 over the canonical serialization of this document.
    ///
    /// Canonical form is `serde_json` over the declared field order, which is
    /// deterministic for a fixed struct definition. The digest is not stored
    /// inside the document, so it can never disagree with its own content.
    pub fn digest(&self) -> String {
        let encoded = serde_json::to_vec(self).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&encoded);
        format!("{:x}", hasher.finalize())
    }
}

/// Stable machine-readable validation and matching codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileDiagnosticCode {
    /// `schemaId` is not [`IMPORT_PROFILE_SCHEMA_ID`].
    SchemaIdInvalid,
    /// Document requires a newer reader than this build.
    ReaderTooOld,
    /// `minReaderVersion` is zero or absurd.
    MinReaderVersionInvalid,
    /// An identifier field is empty or too long.
    IdentifierInvalid,
    /// `version` is zero.
    VersionInvalid,
    /// No source groups.
    NoSourceGroups,
    /// More groups than [`MAX_IMPORT_PROFILE_GROUPS`].
    TooManyGroups,
    /// Two groups share a `groupId`.
    DuplicateGroupId,
    /// More patterns than [`MAX_IMPORT_PROFILE_PATTERNS`].
    TooManyPatterns,
    /// A group has no include patterns.
    GroupHasNoIncludes,
    /// Pattern is empty.
    PatternEmpty,
    /// Pattern exceeds [`MAX_IMPORT_PROFILE_PATTERN_CHARS`].
    PatternTooLong,
    /// Pattern exceeds [`MAX_IMPORT_PROFILE_PATTERN_WILDCARDS`].
    PatternTooManyWildcards,
    /// Pattern exceeds [`MAX_IMPORT_PROFILE_PATTERN_SEGMENTS`].
    PatternTooManySegments,
    /// Pattern is absolute or uses backslashes.
    PatternNotRelative,
    /// Pattern contains `.` or `..` segments.
    PatternTraversal,
    /// Pattern contains a NUL.
    PatternControlCharacter,
    /// Pattern contains an empty path segment (trailing or doubled `/`).
    PatternEmptySegment,
    /// A profile reference has an empty id or zero version.
    ProfileRefInvalid,
    /// Document exceeds [`MAX_IMPORT_PROFILE_BYTES`].
    DocumentTooLarge,
}

/// One validation finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDiagnostic {
    /// Stable code.
    pub code: ProfileDiagnosticCode,
    /// Dotted location inside the document, e.g. `sourceGroups[0].include[1]`.
    pub location: String,
}

/// Result of validating a import-profile document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileValidation {
    /// True when there are no diagnostics.
    pub valid: bool,
    /// All findings, sorted for determinism.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<ProfileDiagnostic>,
}

/// Validate a import-profile document against the v1 grammar and bounds.
///
/// Fail-closed: any diagnostic makes the import profile invalid, and an invalid import profile
/// must not be matched or applied. Returns every problem rather than the first,
/// so an author can fix a document in one pass.
pub fn validate_profile(profile: &ImportProfile) -> ProfileValidation {
    let mut diagnostics = Vec::new();
    let mut push = |code: ProfileDiagnosticCode, location: &str| {
        diagnostics.push(ProfileDiagnostic {
            code,
            location: location.to_string(),
        });
    };

    if profile.schema_id != IMPORT_PROFILE_SCHEMA_ID {
        push(ProfileDiagnosticCode::SchemaIdInvalid, "schemaId");
    }
    if profile.min_reader_version == 0 {
        push(
            ProfileDiagnosticCode::MinReaderVersionInvalid,
            "minReaderVersion",
        );
    } else if profile.min_reader_version > IMPORT_PROFILE_READER_VERSION {
        push(ProfileDiagnosticCode::ReaderTooOld, "minReaderVersion");
    }
    if !is_valid_identifier(&profile.profile_id) {
        push(ProfileDiagnosticCode::IdentifierInvalid, "profileId");
    }
    if !is_valid_identifier(&profile.name) {
        push(ProfileDiagnosticCode::IdentifierInvalid, "name");
    }
    if !is_valid_identifier(&profile.scope.label) {
        push(ProfileDiagnosticCode::IdentifierInvalid, "scope.label");
    }
    if profile.version == 0 {
        push(ProfileDiagnosticCode::VersionInvalid, "version");
    }

    if profile.source_groups.is_empty() {
        push(ProfileDiagnosticCode::NoSourceGroups, "sourceGroups");
    }
    if profile.source_groups.len() > MAX_IMPORT_PROFILE_GROUPS {
        push(ProfileDiagnosticCode::TooManyGroups, "sourceGroups");
    }

    let mut seen_groups = BTreeSet::new();
    let mut total_patterns = 0usize;
    for (index, group) in profile.source_groups.iter().enumerate() {
        let base = format!("sourceGroups[{index}]");
        if !is_valid_identifier(&group.group_id) {
            push(
                ProfileDiagnosticCode::IdentifierInvalid,
                &format!("{base}.groupId"),
            );
        }
        if !seen_groups.insert(group.group_id.clone()) {
            push(
                ProfileDiagnosticCode::DuplicateGroupId,
                &format!("{base}.groupId"),
            );
        }
        if group.include.is_empty() {
            push(
                ProfileDiagnosticCode::GroupHasNoIncludes,
                &format!("{base}.include"),
            );
        }
        total_patterns += group.include.len() + group.exclude.len();

        for (pattern_index, pattern) in group.include.iter().enumerate() {
            for code in pattern.problems() {
                push(code, &format!("{base}.include[{pattern_index}]"));
            }
        }
        for (pattern_index, pattern) in group.exclude.iter().enumerate() {
            for code in pattern.problems() {
                push(code, &format!("{base}.exclude[{pattern_index}]"));
            }
        }
        for (label, reference) in [
            ("formatProfile", group.format_profile.as_ref()),
            ("framingProfile", group.framing_profile.as_ref()),
        ] {
            if let Some(reference) = reference {
                if !is_valid_identifier(&reference.id) || reference.version == 0 {
                    push(
                        ProfileDiagnosticCode::ProfileRefInvalid,
                        &format!("{base}.{label}"),
                    );
                }
            }
        }
        if let Some(policy) = &group.timestamp_policy {
            if !is_valid_identifier(policy) {
                push(
                    ProfileDiagnosticCode::IdentifierInvalid,
                    &format!("{base}.timestampPolicy"),
                );
            }
        }
    }
    if total_patterns > MAX_IMPORT_PROFILE_PATTERNS {
        push(ProfileDiagnosticCode::TooManyPatterns, "sourceGroups");
    }

    if serde_json::to_vec(profile)
        .map(|bytes| bytes.len() as u64)
        .unwrap_or(0)
        > MAX_IMPORT_PROFILE_BYTES
    {
        push(ProfileDiagnosticCode::DocumentTooLarge, "");
    }

    diagnostics.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then(left.code.cmp(&right.code))
    });
    diagnostics.dedup();
    ProfileValidation {
        valid: diagnostics.is_empty(),
        diagnostics,
    }
}

/// Whether an identifier field is non-empty, bounded, and control-free.
fn is_valid_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_IMPORT_PROFILE_ID_CHARS
        && !value.chars().any(char::is_control)
}

/// What a import profile finding means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileFindingKind {
    /// The profile's expectation holds against observed content.
    Match,
    /// The import profile still applies structurally, but observed content no longer
    /// agrees with what it expected. Requires human review, never silent
    /// re-interpretation.
    Drift,
    /// Two rules claim the same source incompatibly. #751 requires an explicit
    /// user choice rather than a guess.
    Conflict,
}

/// Whether a status may carry a proposed role at all, and which roles.
///
/// Manager finding 4: matching previously rejected only
/// [`ImportItemStatus::Blocked`], so a broad rule with no format expectation
/// happily proposed `Log` for hidden noise and for binary files. A profile
/// must never re-enable content that policy ignored or that content
/// classification rejected.
///
/// The rule is deliberately narrow:
/// * `Blocked`, `Ignored`, `Unsupported` accept **no** role. Policy and
///   content classification outrank a declaration.
/// * `Ready`, `Review`, `RawFallback` are event-bearing candidates and accept
///   `Log` only. Declaring a log source to be metrics does not make the
///   metrics path able to read it.
/// * `Supporting` accepts only the non-event roles the import path can
///   actually route: `OperationalMetrics`, `Attachment`, `Readme`.
pub fn role_is_compatible(status: ImportItemStatus, role: ImportItemRole) -> bool {
    match status {
        ImportItemStatus::Blocked | ImportItemStatus::Ignored | ImportItemStatus::Unsupported => {
            false
        }
        ImportItemStatus::Ready | ImportItemStatus::Review | ImportItemStatus::RawFallback => {
            matches!(role, ImportItemRole::Log)
        }
        ImportItemStatus::Supporting => matches!(
            role,
            ImportItemRole::OperationalMetrics
                | ImportItemRole::Attachment
                | ImportItemRole::Readme
        ),
    }
}

/// Why a finding was raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileFindingReason {
    /// Pattern matched and the declared format matches observed content.
    FormatAgrees,
    /// Pattern matched but observed content matched a different format.
    FormatDisagrees,
    /// Pattern matched but content produced no confident format at all, so the
    /// declared format cannot be activated from the path alone.
    FormatUnconfirmed,
    /// Pattern matched and the group declared no format expectation.
    NoFormatExpectation,
    /// An include pattern matched nothing in this source.
    PatternMatchedNothing,
    /// Two groups assigned different roles to the same identity.
    RoleConflict,
    /// Two groups assigned different formats to the same identity.
    FormatConflict,
    /// The item is blocked by policy, so no profile rule can apply to it.
    ItemBlocked,
    /// The rule's role cannot apply to this item's status — hidden, ignored,
    /// unsupported, or a role the import path cannot route for it.
    RoleIncompatibleWithStatus,
    /// The preview was bounded before every entry was inspected, so no match
    /// over it can be called complete.
    PreviewTruncated,
    /// A reviewed-format ProfileRef is not present in the durable store.
    ReviewedFormatMissing,
    /// Store has the format id but not the referenced version.
    ReviewedFormatVersionDrift,
    /// Reviewed format is present but content no longer covers the source.
    ReviewedFormatContentStale,
    /// Multiple reviewed formats at equal priority match the sample.
    ReviewedFormatAmbiguous,
}

/// One explanation about one identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileFinding {
    /// Match, drift, or conflict.
    pub kind: ProfileFindingKind,
    /// Why.
    pub reason: ProfileFindingReason,
    /// Group that produced this finding.
    pub group_id: String,
    /// Preview identity this concerns, when it concerns one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// Format the import profile expected, when it declared one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_format_id: Option<String>,
    /// Format the content actually fingerprinted as.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_format_id: Option<String>,
}

/// Whether a match may be acted on at all.
///
/// Manager finding 3: `clean` alone said nothing about whether the *preview*
/// was complete. A report bounded at [`super::import_preview::MAX_IMPORT_PREVIEW_ITEMS`]
/// has entries that were never inspected, so no match over it can honestly be
/// called applicable — the unexamined tail could contain anything the rules
/// would have flagged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileApplicability {
    /// Every entry was inspected and every rule matched cleanly.
    Applicable,
    /// The preview was complete, but drift or conflict was found.
    NotApplicable,
    /// The preview itself was bounded before every entry was inspected. This
    /// outranks the findings: absence of drift among the entries that *were*
    /// examined is not evidence of its absence overall.
    Incomplete,
}

/// Result of matching a import profile against a preview. Purely informational.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileMatchReport {
    /// Identity of the exact import-profile document evaluated.
    pub profile: ImportProfileIdentity,
    /// True only when the profile validated, the preview was complete, and no
    /// drift or conflict was found.
    ///
    /// Never true for a truncated preview, regardless of findings.
    pub clean: bool,
    /// Machine-readable applicability, distinguishing "no problems found" from
    /// "not everything was looked at".
    pub applicability: ProfileApplicability,
    /// Validation of the document itself.
    ///
    /// Carried separately from [`ProfileMatchReport::findings`] because a
    /// malformed *document* is a different class of problem from a document
    /// that is well formed but no longer describes the corpus. Collapsing the
    /// two loses the diagnostic an author needs.
    pub validation: ProfileValidation,
    /// All findings, sorted for determinism.
    pub findings: Vec<ProfileFinding>,
    /// Identities the import profile claims, with the role it proposes.
    ///
    /// A *proposal*. Nothing here has been applied; applying is a separate,
    /// user-confirmed step outside this module.
    pub proposed_roles: BTreeMap<String, ImportItemRole>,
}

/// Resolve one format ProfileRef against built-in fingerprints and/or reviewed grammars.
fn resolve_format_expectation(
    expected: &ProfileRef,
    item: &ImportPreviewItem,
    sample: &str,
    reviewed_formats: &[super::reviewed_format::ReviewedFormat],
) -> (ProfileFindingKind, ProfileFindingReason, Option<String>) {
    // Prefer reviewed catalog when the id is present there (content-authoritative).
    let reviewed_for_id: Vec<&super::reviewed_format::ReviewedFormat> = reviewed_formats
        .iter()
        .filter(|f| f.format_id == expected.id)
        .collect();
    if !reviewed_for_id.is_empty() {
        let versions: Vec<u16> = reviewed_for_id.iter().map(|f| f.version).collect();
        let exact = reviewed_for_id
            .iter()
            .find(|f| f.version == expected.version)
            .copied();
        let Some(format) = exact else {
            return (
                ProfileFindingKind::Drift,
                ProfileFindingReason::ReviewedFormatVersionDrift,
                versions.first().map(|v| format!("{}@{}", expected.id, v)),
            );
        };
        let owned = [format.clone()];
        return match super::reviewed_format::select_format(&owned, item.identity.as_str(), sample) {
            super::reviewed_format::FormatSelection::Selected { format_id, version } => (
                ProfileFindingKind::Match,
                ProfileFindingReason::FormatAgrees,
                Some(format!("{format_id}@{version}")),
            ),
            super::reviewed_format::FormatSelection::NoMatch => (
                ProfileFindingKind::Drift,
                ProfileFindingReason::ReviewedFormatContentStale,
                item.format_id.clone(),
            ),
            super::reviewed_format::FormatSelection::Conflict { format_ids } => (
                ProfileFindingKind::Conflict,
                ProfileFindingReason::ReviewedFormatAmbiguous,
                Some(format_ids.join(",")),
            ),
        };
    }

    // Not in reviewed catalog: either built-in fingerprint agreement, or missing reviewed ref.
    match item.format_id.as_deref() {
        Some(observed)
            if observed == expected.id && item.format_version == Some(expected.version) =>
        {
            (
                ProfileFindingKind::Match,
                ProfileFindingReason::FormatAgrees,
                item.format_id.clone(),
            )
        }
        Some(_) => (
            ProfileFindingKind::Drift,
            // Unknown non-built-in id with no store entry is "missing" reviewed grammar.
            if item.format_id.as_deref() != Some(expected.id.as_str())
                && !is_known_builtin_format_id(&expected.id)
            {
                ProfileFindingReason::ReviewedFormatMissing
            } else {
                ProfileFindingReason::FormatDisagrees
            },
            item.format_id.clone(),
        ),
        None => (
            ProfileFindingKind::Drift,
            if is_known_builtin_format_id(&expected.id) {
                ProfileFindingReason::FormatUnconfirmed
            } else {
                ProfileFindingReason::ReviewedFormatMissing
            },
            None,
        ),
    }
}

fn is_known_builtin_format_id(id: &str) -> bool {
    super::format_profile::BUILT_IN_FORMAT_PROFILES
        .iter()
        .any(|p| p.id == id)
}

/// Match a validated import profile against a preview report (built-in fingerprints only).
///
/// Prefer [`match_profile_with_reviewed`] when a durable reviewed-format catalog
/// is available so `ProfileRef` can resolve user grammars by content.
pub fn match_profile(profile: &ImportProfile, preview: &ImportPreviewReport) -> ProfileMatchReport {
    match_profile_with_reviewed(profile, preview, &[])
}

/// Match a validated import profile against a preview, resolving `formatProfile`
/// references against both built-in fingerprints and a reviewed-format catalog.
///
/// # Guarantees
///
/// * **Never mutates.** Arguments are shared references; nothing is written.
/// * **Content is authoritative.** Path/producer patterns only nominate; a
///   reviewed grammar must cover the sample. Missing / version-drift /
///   content-stale / ambiguous outcomes fail closed as Drift or Conflict.
/// * **Never applies to blocked items.**
pub fn match_profile_with_reviewed(
    profile: &ImportProfile,
    preview: &ImportPreviewReport,
    reviewed_formats: &[super::reviewed_format::ReviewedFormat],
) -> ProfileMatchReport {
    let identity = profile.identity();
    let validation = validate_profile(profile);
    if !validation.valid {
        // Report the validation failure as itself. An earlier version mapped
        // every diagnostic to `role_conflict` and stuffed the schema location
        // into `group_id`, which destroyed the only information a caller
        // needed to fix the document and invented a conflict that did not
        // exist.
        return ProfileMatchReport {
            profile: identity,
            clean: false,
            applicability: ProfileApplicability::NotApplicable,
            findings: Vec::new(),
            validation,
            proposed_roles: BTreeMap::new(),
        };
    }

    let mut findings = Vec::new();
    let mut proposed_roles: BTreeMap<String, ImportItemRole> = BTreeMap::new();
    let mut claimed_formats: BTreeMap<String, (String, Option<String>)> = BTreeMap::new();
    let mut conflicted: BTreeSet<String> = BTreeSet::new();

    for group in &profile.source_groups {
        let mut matched_any = false;

        for item in &preview.items {
            let identity_str = item.identity.as_str();
            let included = group
                .include
                .iter()
                .any(|pattern| pattern.matches(identity_str));
            if !included {
                continue;
            }
            if group
                .exclude
                .iter()
                .any(|pattern| pattern.matches(identity_str))
            {
                continue;
            }
            matched_any = true;

            if matches!(item.status, ImportItemStatus::Blocked) {
                // Policy outranks any profile. Reported so the author can see
                // their rule is not achieving what they think.
                findings.push(ProfileFinding {
                    kind: ProfileFindingKind::Conflict,
                    reason: ProfileFindingReason::ItemBlocked,
                    group_id: group.group_id.clone(),
                    identity: Some(item.identity.clone()),
                    expected_format_id: group
                        .format_profile
                        .as_ref()
                        .map(|reference| reference.id.clone()),
                    observed_format_id: item.format_id.clone(),
                });
                continue;
            }

            if !role_is_compatible(item.status, group.role) {
                // Hidden/ignored noise, binary and empty files, and roles the
                // import path cannot route for this status all land here. The
                // rule is reported so its author can see it, but it proposes
                // nothing.
                findings.push(ProfileFinding {
                    kind: ProfileFindingKind::Conflict,
                    reason: ProfileFindingReason::RoleIncompatibleWithStatus,
                    group_id: group.group_id.clone(),
                    identity: Some(item.identity.clone()),
                    expected_format_id: group
                        .format_profile
                        .as_ref()
                        .map(|reference| reference.id.clone()),
                    observed_format_id: item.format_id.clone(),
                });
                continue;
            }

            // Role conflict detection across groups.
            if let Some(existing) = proposed_roles.get(identity_str) {
                if *existing != group.role {
                    findings.push(ProfileFinding {
                        kind: ProfileFindingKind::Conflict,
                        reason: ProfileFindingReason::RoleConflict,
                        group_id: group.group_id.clone(),
                        identity: Some(item.identity.clone()),
                        expected_format_id: None,
                        observed_format_id: item.format_id.clone(),
                    });
                    // #751 requires an explicit user choice on conflict. Two
                    // rules disagreeing must therefore leave *no* usable
                    // assignment; keeping the last writer would silently pick
                    // a winner.
                    conflicted.insert(item.identity.clone());
                }
            }
            proposed_roles.insert(item.identity.clone(), group.role);

            match &group.format_profile {
                None => {
                    findings.push(ProfileFinding {
                        kind: ProfileFindingKind::Match,
                        reason: ProfileFindingReason::NoFormatExpectation,
                        group_id: group.group_id.clone(),
                        identity: Some(item.identity.clone()),
                        expected_format_id: None,
                        observed_format_id: item.format_id.clone(),
                    });
                }
                Some(expected) => {
                    // Format conflict across groups.
                    if let Some((other_group, Some(other_format))) =
                        claimed_formats.get(identity_str)
                    {
                        if other_format != &expected.id && other_group != &group.group_id {
                            findings.push(ProfileFinding {
                                kind: ProfileFindingKind::Conflict,
                                reason: ProfileFindingReason::FormatConflict,
                                group_id: group.group_id.clone(),
                                identity: Some(item.identity.clone()),
                                expected_format_id: Some(expected.id.clone()),
                                observed_format_id: item.format_id.clone(),
                            });
                        }
                    }
                    claimed_formats.insert(
                        item.identity.clone(),
                        (group.group_id.clone(), Some(expected.id.clone())),
                    );

                    let sample = item.representative.as_deref().unwrap_or("");
                    let (kind, reason, observed) =
                        resolve_format_expectation(expected, item, sample, reviewed_formats);
                    findings.push(ProfileFinding {
                        kind,
                        reason,
                        group_id: group.group_id.clone(),
                        identity: Some(item.identity.clone()),
                        expected_format_id: Some(expected.id.clone()),
                        observed_format_id: observed,
                    });
                }
            }
        }

        if !matched_any {
            // A rule that matches nothing is drift: the corpus changed shape,
            // or the import profile was written for a different layout.
            findings.push(ProfileFinding {
                kind: ProfileFindingKind::Drift,
                reason: ProfileFindingReason::PatternMatchedNothing,
                group_id: group.group_id.clone(),
                identity: None,
                expected_format_id: group
                    .format_profile
                    .as_ref()
                    .map(|reference| reference.id.clone()),
                observed_format_id: None,
            });
        }
    }

    findings.sort_by(|left, right| {
        left.identity
            .cmp(&right.identity)
            .then(left.group_id.cmp(&right.group_id))
            .then(left.kind.cmp(&right.kind))
            .then(left.reason.cmp(&right.reason))
    });
    findings.dedup();

    // A conflicted identity keeps no usable assignment at all.
    for identity in &conflicted {
        proposed_roles.remove(identity);
    }

    if preview.truncated {
        // Surfaced as a finding as well as an applicability value, so a caller
        // reading only `findings` still cannot miss it.
        findings.push(ProfileFinding {
            kind: ProfileFindingKind::Drift,
            reason: ProfileFindingReason::PreviewTruncated,
            group_id: String::new(),
            identity: None,
            expected_format_id: None,
            observed_format_id: None,
        });
    }

    let no_problems = findings
        .iter()
        .all(|finding| matches!(finding.kind, ProfileFindingKind::Match));
    let applicability = if preview.truncated {
        ProfileApplicability::Incomplete
    } else if no_problems {
        ProfileApplicability::Applicable
    } else {
        ProfileApplicability::NotApplicable
    };
    let clean = matches!(applicability, ProfileApplicability::Applicable);

    ProfileMatchReport {
        profile: identity,
        clean,
        applicability,
        validation,
        findings,
        proposed_roles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::import_preview::{
        finish_report_for_test, item_for_test, item_with_status_for_test,
        truncated_report_for_test, ImportSourceKind,
    };

    fn profile_with(groups: Vec<SourceGroupRule>) -> ImportProfile {
        ImportProfile {
            schema_id: IMPORT_PROFILE_SCHEMA_ID.to_string(),
            min_reader_version: 1,
            profile_id: "acme.web-tier".to_string(),
            version: 1,
            scope: ProfileScope {
                label: "acme/web".to_string(),
            },
            name: "Acme web tier".to_string(),
            source_groups: groups,
        }
    }

    fn group(id: &str, include: &[&str], format: Option<(&str, u16)>) -> SourceGroupRule {
        SourceGroupRule {
            group_id: id.to_string(),
            include: include.iter().map(|p| SafePattern::new(*p)).collect(),
            exclude: Vec::new(),
            role: ImportItemRole::Log,
            format_profile: format.map(|(id, version)| ProfileRef {
                id: id.to_string(),
                version,
            }),
            framing_profile: None,
            timestamp_policy: None,
        }
    }

    #[test]
    fn pattern_grammar_matches_segments_and_globstar() {
        assert!(SafePattern::new("*.log").matches("app.log"));
        assert!(!SafePattern::new("*.log").matches("sub/app.log"));
        assert!(SafePattern::new("**/*.log").matches("a/b/c/app.log"));
        assert!(SafePattern::new("**").matches("anything/at/all"));
        assert!(SafePattern::new("logs/app-?.log").matches("logs/app-1.log"));
        assert!(!SafePattern::new("logs/app-?.log").matches("logs/app-12.log"));
        // Archive members are addressable with the same syntax.
        assert!(SafePattern::new("host-a.zip!/**/*.log").matches("host-a.zip!/var/log/app.log"));
    }

    #[test]
    fn pattern_matching_is_linear_on_adversarial_input() {
        // The classic catastrophic-backtracking shape. A regex engine would
        // hang here; the single-backtrack glob matcher must not.
        let pattern = SafePattern::new("*a".repeat(MAX_IMPORT_PROFILE_PATTERN_WILDCARDS));
        let candidate = "a".repeat(4096);
        let started = std::time::Instant::now();
        let _ = pattern.matches(&candidate);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(250),
            "glob matching must stay linear on adversarial input"
        );
    }

    #[test]
    fn globstar_matching_stays_linear() {
        // Regression: the recursive matcher took 10.2s on exactly this input.
        // Eight globstars against forty segments, with a final literal chosen
        // so the match fails only after the whole space is explored.
        let pattern = SafePattern::new("**/**/**/**/**/**/**/**/zzz");
        let identity = vec!["a"; 40].join("/");
        let started = std::time::Instant::now();
        assert!(!pattern.matches(&identity));
        assert!(
            started.elapsed() < std::time::Duration::from_millis(100),
            "globstar matching must not blow up: took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn globstar_semantics_survive_the_linear_rewrite() {
        assert!(SafePattern::new("**").matches("a/b/c"));
        assert!(SafePattern::new("**/*.log").matches("app.log"));
        assert!(SafePattern::new("**/*.log").matches("a/b/app.log"));
        assert!(SafePattern::new("a/**/z").matches("a/z"));
        assert!(SafePattern::new("a/**/z").matches("a/b/c/z"));
        assert!(!SafePattern::new("a/**/z").matches("a/b/c"));
        assert!(!SafePattern::new("a/**/z").matches("b/z"));
        assert!(SafePattern::new("logs/**").matches("logs/a/b.log"));
        assert!(SafePattern::new("logs/**").matches("logs"));
        assert!(!SafePattern::new("logs/**").matches("other/a.log"));
        assert!(SafePattern::new("host.zip!/**/*.log").matches("host.zip!/var/app.log"));
    }

    #[test]
    fn empty_segment_patterns_are_rejected_rather_than_silently_matching_nothing() {
        for pattern in ["logs/", "logs//app.log", "/"] {
            assert!(
                SafePattern::new(pattern)
                    .problems()
                    .contains(&ProfileDiagnosticCode::PatternEmptySegment),
                "{pattern} must be reported"
            );
        }
    }

    #[test]
    fn a_format_version_mismatch_is_drift_not_a_match() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        // item_for_test pins observed version 1; the import profile expects 2.
        let mut profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 2)),
        )]);
        profile.source_groups[0].format_profile = Some(ProfileRef {
            id: "json-object-line".to_string(),
            version: 2,
        });
        let report = match_profile(&profile, &preview);
        assert!(
            !report.clean,
            "a version mismatch must not read as agreement"
        );
        assert_eq!(report.findings[0].kind, ProfileFindingKind::Drift);
    }

    #[test]
    fn an_invalid_recipe_reports_its_real_diagnostics() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test("app.log", ImportItemStatus::Ready, None)],
        );
        let mut profile = profile_with(vec![group("web", &["*.log"], None)]);
        profile.schema_id = "wrong".into();
        let report = match_profile(&profile, &preview);

        assert!(!report.clean);
        assert!(!report.validation.valid);
        assert!(
            report
                .validation
                .diagnostics
                .iter()
                .any(|d| d.code == ProfileDiagnosticCode::SchemaIdInvalid),
            "the real reason must survive"
        );
        assert!(
            report.findings.is_empty(),
            "a malformed document must not invent per-item conflicts"
        );
        assert!(report.proposed_roles.is_empty());
    }

    #[test]
    fn a_truncated_preview_can_never_produce_a_clean_or_applicable_match() {
        // Every entry that WAS examined matches perfectly; the report is
        // nonetheless incomplete, so the match must not be actionable.
        let preview = truncated_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 1)),
        )]);
        let report = match_profile(&profile, &preview);

        assert!(
            !report.clean,
            "entries beyond the cap were never evaluated, so nothing here is clean"
        );
        assert_eq!(report.applicability, ProfileApplicability::Incomplete);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.reason == ProfileFindingReason::PreviewTruncated),
            "truncation must be visible in findings, not only in applicability"
        );
    }

    #[test]
    fn an_untruncated_all_matching_preview_is_applicable() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 1)),
        )]);
        let report = match_profile(&profile, &preview);
        assert!(report.clean);
        assert_eq!(report.applicability, ProfileApplicability::Applicable);
    }

    #[test]
    fn a_profile_can_never_re_enable_ignored_or_unsupported_content() {
        // A deliberately broad rule with NO format expectation — the shape
        // that previously proposed Log for hidden noise and binary files.
        for status in [
            ImportItemStatus::Ignored,
            ImportItemStatus::Unsupported,
            ImportItemStatus::Blocked,
        ] {
            let preview = finish_report_for_test(
                ImportSourceKind::Directory,
                vec![item_with_status_for_test("thing", status)],
            );
            let profile = profile_with(vec![group("catch-all", &["**"], None)]);
            let report = match_profile(&profile, &preview);

            assert!(
                report.proposed_roles.is_empty(),
                "{status:?} must receive no proposed role"
            );
            assert!(!report.clean, "{status:?} must not read as a clean match");
            assert!(
                report
                    .findings
                    .iter()
                    .any(|f| matches!(f.kind, ProfileFindingKind::Conflict)),
                "{status:?} must be reported as a conflict"
            );
        }
    }

    #[test]
    fn supporting_items_accept_only_roles_the_import_path_can_route() {
        for (role, allowed) in [
            (ImportItemRole::OperationalMetrics, true),
            (ImportItemRole::Attachment, true),
            (ImportItemRole::Readme, true),
            (ImportItemRole::Log, false),
            (ImportItemRole::Unknown, false),
        ] {
            assert_eq!(
                role_is_compatible(ImportItemStatus::Supporting, role),
                allowed,
                "supporting/{role:?}"
            );
        }
        // Event-bearing statuses accept only Log.
        for status in [
            ImportItemStatus::Ready,
            ImportItemStatus::Review,
            ImportItemStatus::RawFallback,
        ] {
            assert!(role_is_compatible(status, ImportItemRole::Log));
            assert!(!role_is_compatible(
                status,
                ImportItemRole::OperationalMetrics
            ));
            assert!(!role_is_compatible(status, ImportItemRole::Attachment));
        }
    }

    #[test]
    fn a_role_conflict_leaves_no_usable_assignment() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        // Two groups, both structurally able to claim the item, disagreeing.
        let mut second = group("second", &["*.log"], None);
        second.role = ImportItemRole::Log;
        let mut first = group("first", &["*.log"], None);
        first.role = ImportItemRole::Log;
        // Force a genuine role disagreement via an incompatible-but-declared
        // role on a Supporting item instead, which is the routable case.
        let supporting = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![{
                let mut item = item_with_status_for_test("ops.json", ImportItemStatus::Supporting);
                item.role = ImportItemRole::Unknown;
                item
            }],
        );
        let mut metrics = group("metrics", &["*.json"], None);
        metrics.role = ImportItemRole::OperationalMetrics;
        let mut attachment = group("attachments", &["*.json"], None);
        attachment.role = ImportItemRole::Attachment;
        let profile = profile_with(vec![metrics, attachment]);
        let report = match_profile(&profile, &supporting);

        assert!(
            report
                .findings
                .iter()
                .any(|f| f.reason == ProfileFindingReason::RoleConflict),
            "the disagreement must be reported"
        );
        assert!(
            report.proposed_roles.is_empty(),
            "a conflict must leave no silently usable assignment"
        );
        assert!(!report.clean);
        let _ = (preview, first, second);
    }

    #[test]
    fn malformed_patterns_are_rejected_with_stable_codes() {
        assert!(SafePattern::new("")
            .problems()
            .contains(&ProfileDiagnosticCode::PatternEmpty));
        assert!(SafePattern::new("/abs/path")
            .problems()
            .contains(&ProfileDiagnosticCode::PatternNotRelative));
        assert!(SafePattern::new("a\\b")
            .problems()
            .contains(&ProfileDiagnosticCode::PatternNotRelative));
        assert!(SafePattern::new("../escape")
            .problems()
            .contains(&ProfileDiagnosticCode::PatternTraversal));
        assert!(SafePattern::new("a/./b")
            .problems()
            .contains(&ProfileDiagnosticCode::PatternTraversal));
        assert!(
            SafePattern::new("*".repeat(MAX_IMPORT_PROFILE_PATTERN_WILDCARDS + 1))
                .problems()
                .contains(&ProfileDiagnosticCode::PatternTooManyWildcards)
        );
        assert!(
            SafePattern::new("x".repeat(MAX_IMPORT_PROFILE_PATTERN_CHARS + 1))
                .problems()
                .contains(&ProfileDiagnosticCode::PatternTooLong)
        );
    }

    #[test]
    fn valid_recipe_validates_and_invalid_ones_report_every_problem() {
        let good = profile_with(vec![group(
            "web",
            &["**/*.log"],
            Some(("json-object-line", 1)),
        )]);
        assert!(validate_profile(&good).valid);

        let mut bad = good.clone();
        bad.schema_id = "contextdesk.import_profile.v99".into();
        bad.version = 0;
        bad.min_reader_version = 99;
        bad.source_groups[0].include = vec![SafePattern::new("../escape")];
        let validation = validate_profile(&bad);
        assert!(!validation.valid);
        let codes: Vec<_> = validation.diagnostics.iter().map(|d| d.code).collect();
        assert!(codes.contains(&ProfileDiagnosticCode::SchemaIdInvalid));
        assert!(codes.contains(&ProfileDiagnosticCode::VersionInvalid));
        assert!(codes.contains(&ProfileDiagnosticCode::ReaderTooOld));
        assert!(codes.contains(&ProfileDiagnosticCode::PatternTraversal));
    }

    #[test]
    fn duplicate_group_ids_are_rejected() {
        let profile = profile_with(vec![
            group("dup", &["a/*.log"], None),
            group("dup", &["b/*.log"], None),
        ]);
        let validation = validate_profile(&profile);
        assert!(validation
            .diagnostics
            .iter()
            .any(|d| d.code == ProfileDiagnosticCode::DuplicateGroupId));
    }

    #[test]
    fn digest_changes_on_any_edit_and_is_stable_otherwise() {
        let profile = profile_with(vec![group("web", &["**/*.log"], None)]);
        let first = profile.digest();
        assert_eq!(first, profile.digest(), "digest must be deterministic");

        let mut edited = profile.clone();
        edited.version = 2;
        assert_ne!(first, edited.digest(), "an edit must produce a new digest");

        let mut renamed = profile.clone();
        renamed.source_groups[0].include = vec![SafePattern::new("**/*.jsonl")];
        assert_ne!(first, renamed.digest());
    }

    #[test]
    fn path_patterns_alone_never_activate_a_parser() {
        // The import profile insists these are JSON; the content is plain text.
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::RawFallback,
                None,
            )],
        );
        let profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 1)),
        )]);
        let report = match_profile(&profile, &preview);

        assert!(!report.clean);
        let finding = report
            .findings
            .iter()
            .find(|f| f.identity.as_deref() == Some("app.log"))
            .expect("finding");
        assert_eq!(finding.kind, ProfileFindingKind::Drift);
        assert_eq!(finding.reason, ProfileFindingReason::FormatUnconfirmed);
    }

    #[test]
    fn format_drift_is_reported_when_content_disagrees() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("logfmt-record"),
            )],
        );
        let profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 1)),
        )]);
        let report = match_profile(&profile, &preview);
        let finding = &report.findings[0];
        assert_eq!(finding.kind, ProfileFindingKind::Drift);
        assert_eq!(finding.reason, ProfileFindingReason::FormatDisagrees);
        assert_eq!(finding.observed_format_id.as_deref(), Some("logfmt-record"));
        assert_eq!(
            finding.expected_format_id.as_deref(),
            Some("json-object-line")
        );
    }

    #[test]
    fn agreeing_content_is_a_clean_match() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 1)),
        )]);
        let report = match_profile(&profile, &preview);
        assert!(report.clean);
        assert_eq!(report.findings[0].kind, ProfileFindingKind::Match);
        assert_eq!(
            report.findings[0].reason,
            ProfileFindingReason::FormatAgrees
        );
        assert_eq!(
            report.proposed_roles.get("app.log"),
            Some(&ImportItemRole::Log)
        );
    }

    #[test]
    fn conflicting_groups_require_an_explicit_choice() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        // Two groups claiming the same READY log source with different format
        // expectations. Both roles are Log, so both are compatible and the
        // disagreement is a genuine conflict rather than an incompatibility.
        let profile = profile_with(vec![
            group("web", &["*.log"], Some(("json-object-line", 1))),
            group("edge", &["*.log"], Some(("logfmt-record", 1))),
        ]);
        let report = match_profile(&profile, &preview);
        assert!(!report.clean);
        let reasons: Vec<_> = report.findings.iter().map(|f| f.reason).collect();
        assert!(
            reasons.contains(&ProfileFindingReason::FormatConflict),
            "competing format claims must be reported: {reasons:?}"
        );
    }

    #[test]
    fn declaring_a_log_source_to_be_metrics_is_incompatible_not_a_conflict() {
        // A Ready log source cannot be routed as metrics at all — the metrics
        // path could not read it. That is an incompatibility, reported before
        // any format comparison, and it proposes nothing.
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let mut metrics = group("metrics", &["*.log"], None);
        metrics.role = ImportItemRole::OperationalMetrics;
        let report = match_profile(&profile_with(vec![metrics]), &preview);

        assert!(!report.clean);
        assert!(report
            .findings
            .iter()
            .any(|f| f.reason == ProfileFindingReason::RoleIncompatibleWithStatus));
        assert!(report.proposed_roles.is_empty());
    }

    #[test]
    fn a_recipe_cannot_unblock_a_policy_refusal() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test("evil", ImportItemStatus::Blocked, None)],
        );
        let profile = profile_with(vec![group("web", &["evil"], Some(("json-object-line", 1)))]);
        let report = match_profile(&profile, &preview);
        assert!(!report.clean);
        assert_eq!(report.findings[0].reason, ProfileFindingReason::ItemBlocked);
        assert!(
            report.proposed_roles.is_empty(),
            "a blocked item must never receive a proposed role"
        );
    }

    #[test]
    fn a_rule_matching_nothing_is_drift_not_silence() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let profile = profile_with(vec![group("absent", &["nowhere/*.log"], None)]);
        let report = match_profile(&profile, &preview);
        assert!(!report.clean);
        assert_eq!(
            report.findings[0].reason,
            ProfileFindingReason::PatternMatchedNothing
        );
    }

    #[test]
    fn an_invalid_recipe_can_never_produce_a_clean_match() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let mut profile = profile_with(vec![group("web", &["*.log"], None)]);
        profile.schema_id = "wrong".into();
        let report = match_profile(&profile, &preview);
        assert!(!report.clean);
        assert!(
            report.proposed_roles.is_empty(),
            "a malformed document must propose nothing at all"
        );
    }

    #[test]
    fn matching_never_mutates_its_inputs() {
        let preview = finish_report_for_test(
            ImportSourceKind::Directory,
            vec![item_for_test(
                "app.log",
                ImportItemStatus::Ready,
                Some("json-object-line"),
            )],
        );
        let profile = profile_with(vec![group(
            "web",
            &["*.log"],
            Some(("json-object-line", 1)),
        )]);
        let preview_before = preview.clone();
        let recipe_before = profile.clone();
        let _ = match_profile(&profile, &preview);
        assert_eq!(preview, preview_before);
        assert_eq!(profile, recipe_before);
    }

    #[test]
    fn recipe_round_trips_and_rejects_unknown_fields() {
        let profile = profile_with(vec![group(
            "web",
            &["**/*.log"],
            Some(("json-object-line", 1)),
        )]);
        let encoded = serde_json::to_string(&profile).expect("serialize");
        let decoded: ImportProfile = serde_json::from_str(&encoded).expect("round trip");
        assert_eq!(decoded, profile);

        let tampered = encoded.replace("{\"schemaId\"", "{\"surprise\":1,\"schemaId\"");
        assert!(
            serde_json::from_str::<ImportProfile>(&tampered).is_err(),
            "unknown fields must be rejected, not silently ignored"
        );
    }
}

#[cfg(test)]
mod normative_schema_tests {
    //! Cross-checks the Rust grammar against the normative JSON Schema.
    //!
    //! Mirrors the `incident_evidence` precedent: the schema under
    //! `docs/specs/` is what third-party authors validate against, so it must
    //! not drift from what this crate actually accepts. These assertions fail
    //! loudly when a field, bound, or enum value is changed on one side only.

    use super::*;

    fn schema() -> serde_json::Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/specs/import-profile/schemas/import-profile.v1.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_str(&text).expect("schema parses")
    }

    #[test]
    fn schema_id_and_reader_version_agree_with_the_rust_constants() {
        let schema = schema();
        assert_eq!(
            schema["properties"]["schemaId"]["const"].as_str(),
            Some(IMPORT_PROFILE_SCHEMA_ID)
        );
        assert_eq!(
            schema["$id"].as_str(),
            Some("https://contextdesk.local/schemas/import_profile/import-profile.v1.json")
        );
    }

    #[test]
    fn required_fields_match_the_rust_struct() {
        let schema = schema();
        let required: Vec<&str> = schema["required"]
            .as_array()
            .expect("required")
            .iter()
            .map(|value| value.as_str().expect("string"))
            .collect();
        assert_eq!(
            required,
            vec![
                "schemaId",
                "minReaderVersion",
                "profileId",
                "version",
                "scope",
                "name",
                "sourceGroups"
            ],
            "schema required list drifted from ImportProfile's non-optional fields"
        );
    }

    #[test]
    fn role_enum_matches_the_rust_role_vocabulary() {
        let schema = schema();
        let roles: Vec<&str> = schema["$defs"]["sourceGroup"]["properties"]["role"]["enum"]
            .as_array()
            .expect("enum")
            .iter()
            .map(|value| value.as_str().expect("string"))
            .collect();
        // Serialize each Rust variant and compare against the schema list, so
        // adding a variant without updating the schema fails here.
        let rust: Vec<String> = [
            ImportItemRole::Log,
            ImportItemRole::OperationalMetrics,
            ImportItemRole::Attachment,
            ImportItemRole::Readme,
            ImportItemRole::Unknown,
        ]
        .iter()
        .map(|role| {
            serde_json::to_value(role)
                .expect("serialize")
                .as_str()
                .expect("string")
                .to_string()
        })
        .collect();
        assert_eq!(roles, rust);
    }

    #[test]
    fn schema_bounds_match_the_rust_constants() {
        let schema = schema();
        assert_eq!(
            schema["properties"]["sourceGroups"]["maxItems"].as_u64(),
            Some(MAX_IMPORT_PROFILE_GROUPS as u64)
        );
        assert_eq!(
            schema["$defs"]["safePattern"]["maxLength"].as_u64(),
            Some(MAX_IMPORT_PROFILE_PATTERN_CHARS as u64)
        );
        assert_eq!(
            schema["properties"]["profileId"]["maxLength"].as_u64(),
            Some(MAX_IMPORT_PROFILE_ID_CHARS as u64)
        );
    }

    #[test]
    fn the_schema_forbids_additional_properties_everywhere() {
        // deny_unknown_fields on the Rust side must be mirrored, or a
        // third-party author could ship a document with an `exec` field that
        // validates against the schema and is then rejected by the engine.
        let schema = schema();
        assert_eq!(schema["additionalProperties"].as_bool(), Some(false));
        for definition in ["sourceGroup", "profileRef"] {
            assert_eq!(
                schema["$defs"][definition]["additionalProperties"].as_bool(),
                Some(false),
                "{definition} must forbid additional properties"
            );
        }
        assert_eq!(
            schema["properties"]["scope"]["additionalProperties"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn the_sample_document_validates_structurally_against_the_schema() {
        // A light structural check (no external validator dependency): every
        // required key present, and no key outside the schema's properties.
        let schema = schema();
        let profile = ImportProfile {
            schema_id: IMPORT_PROFILE_SCHEMA_ID.to_string(),
            min_reader_version: 1,
            profile_id: "example.web-tier".to_string(),
            version: 1,
            scope: ProfileScope {
                label: "example/web".to_string(),
            },
            name: "Example".to_string(),
            source_groups: vec![SourceGroupRule {
                group_id: "app".to_string(),
                include: vec![SafePattern::new("logs/**")],
                exclude: Vec::new(),
                role: ImportItemRole::Log,
                format_profile: None,
                framing_profile: None,
                timestamp_policy: None,
            }],
        };
        assert!(validate_profile(&profile).valid);

        let encoded = serde_json::to_value(&profile).expect("serialize");
        let object = encoded.as_object().expect("object");
        let properties = schema["properties"].as_object().expect("properties");
        for key in object.keys() {
            assert!(
                properties.contains_key(key),
                "serialized field `{key}` is absent from the normative schema"
            );
        }
        for key in schema["required"].as_array().expect("required") {
            let key = key.as_str().expect("string");
            assert!(
                object.contains_key(key),
                "schema requires `{key}` but the Rust type does not emit it"
            );
        }
    }
}
