/**
 * Privacy denylist for assessment UI strings.
 * Mirrors `cd_core::log_analysis::public_assessment_denylist_patterns` intent:
 * never show absolute paths, credentials, or local storage roots in the GUI.
 */

/** Patterns forbidden in rendered assessment UI (case-insensitive). */
export const ASSESSMENT_UI_DENYLIST: readonly string[] = [
  "/users/",
  "/home/",
  "c:\\",
  "\\\\users\\\\",
  ".contextdesk",
  "log_corpora",
  "api_key",
  "apikey",
  "authorization:",
  "bearer ",
  "password",
  "aws_access",
  "openai.com",
  "api.x.ai",
];

/**
 * Scan a free-form string for denylist hits.
 * Returns the first matching pattern, or null when clean.
 */
export function findAssessmentPrivacyLeak(text: string): string | null {
  const lower = text.toLowerCase();
  for (const pattern of ASSESSMENT_UI_DENYLIST) {
    if (lower.includes(pattern.toLowerCase())) return pattern;
  }
  // Absolute POSIX path shape (not a relative portable source).
  if (/(^|[\s"'`])\/(?:Users|home|var|tmp|private)\//i.test(text)) {
    return "absolute_posix_path";
  }
  // Windows drive path.
  if (/(^|[\s"'`])[a-z]:\\/i.test(text)) {
    return "absolute_windows_path";
  }
  return null;
}

/** True when every provided string is free of denylist / absolute-path leaks. */
export function assessmentUiStringsArePrivate(
  texts: readonly (string | null | undefined)[],
): boolean {
  for (const t of texts) {
    if (t == null || t === "") continue;
    if (findAssessmentPrivacyLeak(t) != null) return false;
  }
  return true;
}

/**
 * Collect display strings from a host assessment DTO for a privacy scan.
 * Does not include sourceKeyMap values that are portable relative paths
 * (those are checked separately for absolute-path shape).
 */
export function collectAssessmentDisplayStrings(
  assessment: {
    summary: { headline: string; dimensions: { label: string; measuredFact: string }[] };
    findings: {
      title: string;
      measuredFact: string;
      finding: string;
      improvementHint: { change: string; acceptanceCriteria: string[] };
      limitations: string[];
      evidence: { label: string; key: string }[];
    }[];
    limitations: string[];
    confidence: { summary: string; nonClaims: string[] };
    privacy: { policySummary: string };
    metrics: {
      selection: { availabilityNote: string };
      templates: { proposalNote: string };
      storedLevel: { honestyNote: string };
      traceId: { availabilityNote: string };
    };
  },
): string[] {
  const out: string[] = [
    assessment.summary.headline,
    assessment.privacy.policySummary,
    assessment.confidence.summary,
    ...assessment.confidence.nonClaims,
    ...assessment.limitations,
    assessment.metrics.selection.availabilityNote,
    assessment.metrics.templates.proposalNote,
    assessment.metrics.storedLevel.honestyNote,
    assessment.metrics.traceId.availabilityNote,
  ];
  for (const d of assessment.summary.dimensions) {
    out.push(d.label, d.measuredFact);
  }
  for (const f of assessment.findings) {
    out.push(
      f.title,
      f.measuredFact,
      f.finding,
      f.improvementHint.change,
      ...f.improvementHint.acceptanceCriteria,
      ...f.limitations,
    );
    for (const e of f.evidence) {
      out.push(e.label, e.key);
    }
  }
  return out;
}
