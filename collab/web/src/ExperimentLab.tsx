import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { MouseEvent, ReactNode } from "react";
import { pathFor, type RouteItemKind, type WorkFocus } from "./app-location.js";
import { ArtifactExcerpt } from "./evidence-excerpt.js";
import {
  disambiguateIdentities,
  evidenceIdentity,
  readableReferenceName,
  type EvidenceIdentity,
  type EvidenceIdentityContext,
} from "./evidence-identity.js";
import { protectedApiFetch } from "./protected-api.js";
import { matchingRouteItem, visibleSectionTarget } from "./route-focus.js";

interface CandidateRow {
  candidateId: string;
  modelLabel: string;
  role: string;
  runStatus: string;
  observedLatency: { status: string; milliseconds?: number };
  cost: { status: string };
  usage: { status: string };
  helpfulnessState: string;
  goldState: string;
}

interface ExperimentView {
  id: string;
  packageId: string;
  /** When this comparison was recorded. Drives ordering and the latest marker. */
  createdAt?: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: CandidateRow[];
  agreement: {
    sharedAnchors: { evidenceRef: string; role: string; candidateIds: string[] }[];
    candidateSpecific: { candidateId: string; evidenceRefs: string[] }[];
    roleConflicts: {
      evidenceRef: string;
      assignments: { candidateId: string; role: string }[];
    }[];
    notes: string[];
  };
  observations: {
    id: string;
    candidateId: string;
    dimension: string;
    score: number;
    rationale: string;
    evidenceRefs: string[];
    reviewerUsername: string;
  }[];
  decisions: {
    id: string;
    status: string;
    revision: number;
    text: string;
    rationale: string;
    evidenceRefs: string[];
    authorUsername?: string;
    ownerId?: string | null;
    ownerUsername?: string | null;
    remainingUnknowns?: string[];
  }[];
  gold: {
    goldId: string;
    version: number;
    predecessorGoldId: string | null;
    packageId: string;
    acceptedDecisionId: string;
    acceptedDecisionRevision: number;
    evidenceAnchors: string[];
    promotedByUsername: string;
    notes: string[];
  } | null;
  alignments: {
    candidateId: string;
    status: string;
    matchedAnchors: string[];
    missingAnchors: string[];
    extraAnchors: string[];
    roleMismatches?: { evidenceRef: string; role: string }[];
    notes: string[];
  }[];
  traces: {
    candidateId: string;
    sourceKind: string;
    completeness: string;
    unknowns: string[];
    events: {
      eventId: string;
      sequence: number;
      kind: string;
      actor: string;
      authorUsername?: string;
      excerpt: string | null;
      evidenceRefs: string[];
      unknowns: string[];
    }[];
    efficiency: {
      turnCount: { status: string; count?: number };
      evidenceAcquisitionSteps: { status: string; count?: number };
      latency: { status: string; milliseconds?: number };
      cost: { status: string };
      providerCalls: { status: string; count?: number };
    };
  }[];
  comparison: {
    questionPaths: { pathId: string; excerpt: string | null; candidateIds: string[] }[];
    sharedEvidence: { evidenceRef: string; candidateIds: string[] }[];
    uniqueEvidence: { candidateId: string; evidenceRefs: string[] }[];
    divergence: { kind: string; summary: string }[];
    convergence: { evidenceRef: string; inGold: boolean; candidateIds: string[] }[];
    efficiency: { candidateId: string; efficiency: { turnCount: { status: string; count?: number } } }[];
    gold: { status: string; version: number | null; acceptedDecisionId: string | null };
    notes: string[];
  };
}

interface EvidenceArtifactView {
  id: string;
  kind: string;
  filename: string | null;
  uri: string | null;
  mediaType: string | null;
  privacyClass: string;
  verificationStatus: string | null;
}

function isRestoredAttribution(username: string | null | undefined): boolean {
  const value = username?.trim().toLowerCase() ?? "";
  return value.startsWith("historical-") || value.startsWith("imported-");
}

function attributionLabel(username: string | null | undefined): string {
  if (!username?.trim()) return "identity unavailable in this view";
  return isRestoredAttribution(username) ? "Historical participant (restored)" : username;
}

interface ShareSafeExport {
  schemaId?: string;
  privacyClass?: string;
  review?: {
    candidates?: unknown[];
    observations?: unknown[];
    decision?: { status?: string; revision?: number } | null;
    gold?: { version?: number } | null;
    omissions?: {
      modelLabelsIncluded?: boolean;
      participantIdentitiesIncluded?: boolean;
      freeTextIncluded?: boolean;
      privateContentIncluded?: boolean;
      correlatableMetadataIncluded?: boolean;
    };
  };
  traces?: unknown[];
}

interface PresenceMemberView {
  identityId: string;
  username: string;
  surface: string;
  lastSeenAt: string;
}

interface PresenceView {
  schemaId: string;
  caseId: string;
  ttlSeconds: number;
  members: PresenceMemberView[];
}

const omissionLabels = [
  ["modelLabelsIncluded", "model labels"],
  ["participantIdentitiesIncluded", "participant identities"],
  ["freeTextIncluded", "free text"],
  ["privateContentIncluded", "private content"],
  ["correlatableMetadataIncluded", "correlatable metadata"],
] as const;

function exportOmissionSummary(exported: ShareSafeExport): string | null {
  const omissions = exported.review?.omissions;
  if (!omissions) return null;
  const omitted = omissionLabels
    .filter(([key]) => omissions[key] === false)
    .map(([, label]) => label);
  const included = omissionLabels
    .filter(([key]) => omissions[key] === true)
    .map(([, label]) => label);
  const parts: string[] = [];
  if (omitted.length) parts.push(`Omitted: ${omitted.join(", ")}.`);
  if (included.length) parts.push(`Included: ${included.join(", ")}.`);
  return parts.length ? parts.join(" ") : null;
}

function latencyLabel(value: CandidateRow["observedLatency"]): string {
  return value.status === "observed" && typeof value.milliseconds === "number"
    ? `${value.milliseconds} ms`
    : "unknown";
}

/**
 * Comparisons newest first.
 *
 * The API returns them oldest first, which is the right storage order and the
 * wrong reading order: the newest comparison is the one a decision should be
 * based on, so it belongs at the top and it is what an unspecified selection
 * must resolve to.
 */
function newestFirst(experiments: ExperimentView[]): ExperimentView[] {
  return [...experiments].sort((left, right) => {
    const byTime = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
    if (byTime !== 0) return byTime;
    // Without timestamps the API order is the only ordering fact there is;
    // preserve it reversed rather than inventing one from the ids.
    return experiments.indexOf(right) - experiments.indexOf(left);
  });
}

/** The comparison a decision defaults to when the address names none. */
function defaultExperimentId(experiments: ExperimentView[]): string | null {
  return newestFirst(experiments)[0]?.id ?? null;
}

/** When a comparison was recorded, in local time. */
function recordedAtLabel(experiment: ExperimentView): string {
  const stamp = experiment.createdAt;
  if (!stamp) return "recorded time not captured";
  const parsed = new Date(stamp);
  if (Number.isNaN(parsed.getTime())) return "recorded time not captured";
  return parsed.toLocaleString();
}

function candidateRunSummary(candidates: CandidateRow[]): string {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.runStatus, (counts.get(candidate.runStatus) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ");
}

function candidateModelSummary(candidates: CandidateRow[]): string {
  const labels = [...new Set(candidates.map((candidate) => candidate.modelLabel.trim()).filter(Boolean))];
  if (labels.length <= 2) return labels.join(" + ");
  return `${labels.slice(0, 2).join(" + ")} + ${labels.length - 2} more`;
}

// The alignment status alone ("partial", "unscored") reads like a verdict with a
// hidden rationale; spell out what each status actually measures.
const ALIGNMENT_STATUS_LABELS: Record<string, string> = {
  aligned: "aligned — cites every benchmark anchor",
  partial: "partially aligned",
  divergent: "divergent — cites no benchmark anchor",
  unscored: "unscored — no cited evidence to compare",
  unknown: "unknown — not compared against a benchmark",
  absent: "no benchmark recorded",
};

const TRACE_SOURCE_LABELS: Record<string, string> = {
  plain_text: "pasted chat",
  programmatic: "structured run",
};

const TRACE_COMPLETENESS_LABELS: Record<string, string> = {
  exact: "complete trace",
  partial: "partial trace — unproven steps stay unknown",
  unknown: "trace coverage unknown",
};

function truncateText(value: string, max = 96): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readableUnknown(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

const COMPARE_WORKSPACE = [
  {
    id: "summary",
    label: "Summary",
    section: "scan-heading",
  },
  {
    id: "review-queue",
    label: "Review queue",
    section: "review-queue-heading",
  },
  {
    id: "evidence",
    label: "Evidence",
    section: "evidence-heading",
  },
  {
    id: "strategy",
    label: "Strategy paths",
    section: "strategy-heading",
  },
  {
    id: "signals",
    label: "Signals",
    section: "helpfulness-heading",
  },
] as const;

type CompareWorkspaceId = (typeof COMPARE_WORKSPACE)[number]["id"];

const LEGACY_SECTION_TO_WORKSPACE: Record<string, CompareWorkspaceId> = {
  "scan-heading": "summary",
  "scan-findings-heading": "summary",
  "scan-unknown-heading": "summary",
  "scan-decided-heading": "summary",
  "readiness-heading": "summary",
  "focus-digest-heading": "summary",
  "candidate-comparison-heading": "summary",
  "review-queue-heading": "review-queue",
  "evidence-heading": "evidence",
  "cross-exam-heading": "evidence",
  "strategy-heading": "strategy",
  "helpfulness-heading": "signals",
  "gold-alignment-heading": "signals",
  "decision-heading": "summary",
  "export-heading": "summary",
};

function compareWorkspaceFor(section: string | null | undefined): CompareWorkspaceId {
  if (!section) return "summary";
  return LEGACY_SECTION_TO_WORKSPACE[section] ?? "summary";
}

function stageForSection(section: string): "compare" | "decide" {
  return section === "decision-heading" || section === "export-heading" ? "decide" : "compare";
}

function navigationKey(focus: WorkFocus): string {
  return [
    focus.section,
    focus.itemKind ?? "",
    focus.item ?? "",
    focus.experiment ?? "",
    focus.navigation ?? "focus",
  ].join("\u0000");
}

function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * Who took a recorded step, in words.
 *
 * "actor tool" and "actor assistant" are the transcript's own vocabulary. A
 * reader needs to know whether a person, an automated lane, or a tool call
 * produced the step, because that changes how much the step is worth.
 */
function actorMeaning(actor: string, authorUsername?: string): string {
  const named = authorUsername?.trim();
  if (named) return `recorded by ${named}`;
  switch (actor.toLowerCase()) {
    case "human":
      return "entered by a person";
    case "assistant":
      return "produced by the analysis lane";
    case "tool":
      return "returned by a tool the lane called";
    case "system":
      return "recorded by the system";
    default:
      return `recorded by ${actor}`;
  }
}

function traceEventMeaning(kind: string): string {
  const normalized = kind.toLowerCase();
  if (/input|prompt|question|evidence|retriev|search|tool/.test(normalized)) {
    return "Input or evidence considered";
  }
  if (/review|critic|feedback|challenge/.test(normalized)) return "Review feedback";
  if (/decision|recommend|synth|answer|response|result|conclusion/.test(normalized)) {
    return "Analysis result or decision contribution";
  }
  if (/analysis|reason|hypothesis|diagnos/.test(normalized)) return "Analysis step";
  return "Recorded lane step";
}

// ————— Decision-readiness cockpit projections —————
// Every builder below restates facts already present in the experiment view.
// Nothing here ranks, scores, infers a winner, or persists state: the same
// view always produces the same rows, facets, and queue, in the same order.

interface EvidenceCellFacts {
  recorded: boolean;
  roles: string[];
  matchedGold: boolean;
  missingGold: boolean;
  extraGold: boolean;
  benchmarkRoleDiffers: string | null;
}

interface EvidenceCrossRow {
  evidenceRef: string;
  inGold: boolean | null;
  conflict: boolean;
  singleLane: boolean;
  uncitedAnchor: boolean;
  cells: Record<string, EvidenceCellFacts>;
}

interface SupportingArtifact {
  label: string;
  source: string;
  excerpt: string | null;
  context: string;
}

interface HumanFinding {
  id: string;
  headline: string;
  artifact: SupportingArtifact;
  claims: string;
  why: string;
  nextStep: string;
  candidateIds: string[];
}

interface LoadedEvidenceExcerpt {
  text: string;
  truncated: boolean;
}

/**
 * Adapter from a recorded evidence reference to the presentation shape the lab
 * renders. All naming, attribution, and excerpt-scoping rules live in
 * `evidence-identity`, so every surface answers the same way for the same
 * reference and two distinct references never render as one.
 */
function identityContext(
  view: ExperimentView,
  artifacts: EvidenceArtifactView[],
  excerpts: Record<string, LoadedEvidenceExcerpt>,
  preferLane?: string | null,
): EvidenceIdentityContext {
  return {
    artifacts,
    traces: view.traces ?? [],
    laneName: (candidateId) =>
      view.candidates.find((row) => row.candidateId === candidateId)?.modelLabel
      ?? "an unnamed lane",
    loadedText: excerpts,
    preferLane: preferLane ?? null,
  };
}

/**
 * Every reference this comparison mentions, named and disambiguated together.
 *
 * Names are resolved as a set rather than one at a time so a repeated name can
 * gain a distinguishing suffix; resolving in isolation cannot see the clash.
 */
function evidenceIdentityIndex(
  view: ExperimentView,
  artifacts: EvidenceArtifactView[] = [],
  excerpts: Record<string, LoadedEvidenceExcerpt> = {},
  preferLane?: string | null,
): Map<string, EvidenceIdentity> {
  const context = identityContext(view, artifacts, excerpts, preferLane);
  const identities = disambiguateIdentities(
    evidenceRefsFor(view).map((ref) => evidenceIdentity(ref, context)),
  );
  return new Map(identities.map((identity) => [identity.reference, identity]));
}

function supportingArtifact(
  view: ExperimentView,
  evidenceRef: string,
  artifacts: EvidenceArtifactView[] = [],
  excerpts: Record<string, LoadedEvidenceExcerpt> = {},
  preferLane?: string | null,
): SupportingArtifact {
  const index = evidenceIdentityIndex(view, artifacts, excerpts, preferLane);
  const identity = index.get(evidenceRef)
    ?? evidenceIdentity(evidenceRef, identityContext(view, artifacts, excerpts, preferLane));
  return {
    label: identity.name,
    source: identity.source,
    excerpt: identity.excerpt,
    context: identity.excerptCaveat ?? "",
  };
}

function evidenceRefsFor(view: ExperimentView): string[] {
  const refs = new Set<string>();
  for (const anchor of view.agreement.sharedAnchors) refs.add(anchor.evidenceRef);
  for (const row of view.agreement.candidateSpecific) {
    for (const ref of row.evidenceRefs) refs.add(ref);
  }
  for (const row of view.agreement.roleConflicts) refs.add(row.evidenceRef);
  for (const trace of view.traces ?? []) {
    for (const event of trace.events) {
      for (const ref of event.evidenceRefs) refs.add(ref);
    }
  }
  return [...refs].sort((left, right) => left.localeCompare(right));
}

const MAX_EVIDENCE_EXCERPT_BYTES = 64 * 1024;

function decodeEvidenceExcerpt(contentBase64: string): LoadedEvidenceExcerpt | null {
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
    if (bytes.subarray(0, 1024).includes(0)) return null;
    const bounded = bytes.subarray(0, MAX_EVIDENCE_EXCERPT_BYTES);
    return {
      text: new TextDecoder().decode(bounded),
      truncated: bytes.length > bounded.length,
    };
  } catch {
    return null;
  }
}

function EvidencePicker(props: {
  view: ExperimentView;
  artifacts: EvidenceArtifactView[];
  legend: string;
  roles?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() => new Set());
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  // Resolve the whole set at once: picking one reference at a time cannot see
  // that two of them would render under the same name, and a chooser whose
  // options read identically cannot be used to choose.
  const identities = evidenceIdentityIndex(props.view, props.artifacts);
  const choices = evidenceRefsFor(props.view).map((ref) => {
    const identity = identities.get(ref);
    return {
      ref,
      label: identity?.name ?? readableReferenceName(ref),
      source: identity?.source ?? "named from the recorded reference",
      excerpt: identity?.excerpt ?? null,
    };
  });
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? choices.filter((choice) =>
        selectedRefs.has(choice.ref) ||
        `${choice.label} ${choice.source} ${choice.excerpt ?? ""} ${choice.ref}`
          .toLowerCase()
          .includes(normalized),
      )
    : choices;

  useEffect(() => {
    const form = fieldsetRef.current?.form;
    if (!form) return undefined;
    const reset = () => {
      setSelectedRefs(new Set());
      setQuery("");
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, []);

  useEffect(() => {
    setSelectedRefs(new Set());
    setQuery("");
  }, [props.view.id]);

  return (
    <fieldset className="experiment-lab__evidence-picker" ref={fieldsetRef}>
      <legend>{props.legend}</legend>
      <label className="experiment-lab__evidence-search">
        <span>Search recorded evidence</span>
        <input
          className="login__input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filename, source, or excerpt"
        />
      </label>
      {visible.length ? (
        <div className="experiment-lab__evidence-choices">
          {visible.map((choice) => (
            <div className="experiment-lab__evidence-choice" key={choice.ref}>
              <label>
                <input
                  type="checkbox"
                  name="evidenceRefs"
                  value={choice.ref}
                  checked={selectedRefs.has(choice.ref)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedRefs((current) => {
                      const next = new Set(current);
                      if (checked) next.add(choice.ref);
                      else next.delete(choice.ref);
                      return next;
                    });
                  }}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <small>{choice.source}</small>
                  {choice.excerpt ? <code>{truncateText(choice.excerpt, 240)}</code> : null}
                </span>
              </label>
              {props.roles ? (
                <label className="experiment-lab__evidence-role">
                  <span>Expected role (optional)</span>
                  <select
                    aria-label={`Expected role for ${choice.label}`}
                    className="login__input"
                    name={`evidenceRole:${choice.ref}`}
                    defaultValue=""
                  >
                    <option value="">No role recorded</option>
                    <option value="trigger">Trigger</option>
                    <option value="cause">Cause</option>
                    <option value="symptom">Symptom</option>
                    <option value="observation">Observation</option>
                    <option value="recovery">Recovery</option>
                    <option value="disconfirmation">Disconfirmation</option>
                  </select>
                </label>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="experiment-lab__empty">No recorded evidence matches this search.</p>
      )}
    </fieldset>
  );
}

function buildHumanFindings(
  view: ExperimentView,
  rows: EvidenceCrossRow[],
  artifacts: EvidenceArtifactView[] = [],
  excerpts: Record<string, LoadedEvidenceExcerpt> = {},
): HumanFinding[] {
  const label = (candidateId: string): string =>
    view.candidates.find((row) => row.candidateId === candidateId)?.modelLabel ?? "recorded lane";
  return rows
    .filter((row) => row.conflict || row.singleLane || row.uncitedAnchor || row.inGold === true)
    .map((row) => {
      const cited = view.candidates.filter((candidate) => row.cells[candidate.candidateId]?.recorded);
      const claims = cited.length
        ? cited.map((candidate) => {
            const roles = row.cells[candidate.candidateId]?.roles ?? [];
            return `${label(candidate.candidateId)} treats it as ${roles.length ? roles.join(" / ") : "supporting evidence (role not recorded)"}`;
          }).join("; ")
        : "No lane citation is recorded for this human benchmark anchor.";
      const headline = row.conflict
        ? "Models assign different meaning to the same evidence"
        : row.singleLane
          ? "One model relies on evidence the other lanes do not cite"
          : row.uncitedAnchor
            ? "The human benchmark relies on evidence no lane cited"
            : "Models converge on evidence in the human benchmark";
      const why = row.conflict
        ? "A trigger, symptom, recovery, or observation can lead to different remediation. Resolve the role before accepting a causal conclusion."
        : row.singleLane
          ? "A conclusion may depend on an uncorroborated artifact. Confirm its source and surrounding context before relying on it."
          : row.uncitedAnchor
            ? "The comparison may have missed evidence that informed the accepted human decision."
            : "Shared support narrows review, but agreement does not establish correctness.";
      return {
        id: row.evidenceRef,
        headline,
        artifact: supportingArtifact(view, row.evidenceRef, artifacts, excerpts),
        claims,
        why,
        nextStep: row.conflict
          ? "Open the supporting artifact, inspect surrounding log or stack-trace context, then record which interpretation the evidence supports."
          : row.singleLane
            ? "Inspect or attach the source excerpt, timestamp, and component; then ask another lane or a person to corroborate it."
            : row.uncitedAnchor
              ? "Open the evidence record and determine whether each lane should be rerun with this artifact attached."
              : "Inspect the artifact and compare each lane’s interpretation before deciding.",
        candidateIds: cited.map((candidate) => candidate.candidateId),
      };
    });
}

function buildEvidenceCrossRows(view: ExperimentView): EvidenceCrossRow[] {
  const rows = new Map<string, EvidenceCrossRow>();
  const candidateIds = view.candidates.map((row) => row.candidateId);
  const ensure = (evidenceRef: string): EvidenceCrossRow => {
    let row = rows.get(evidenceRef);
    if (!row) {
      const cells: Record<string, EvidenceCellFacts> = {};
      for (const candidateId of candidateIds) {
        cells[candidateId] = {
          recorded: false,
          roles: [],
          matchedGold: false,
          missingGold: false,
          extraGold: false,
          benchmarkRoleDiffers: null,
        };
      }
      row = {
        evidenceRef,
        inGold: null,
        conflict: false,
        singleLane: false,
        uncitedAnchor: false,
        cells,
      };
      rows.set(evidenceRef, row);
    }
    return row;
  };
  const cite = (evidenceRef: string, candidateId: string, role?: string) => {
    const cell = ensure(evidenceRef).cells[candidateId];
    if (!cell) return;
    cell.recorded = true;
    if (role && !cell.roles.includes(role)) cell.roles.push(role);
  };
  for (const anchor of view.agreement.sharedAnchors) {
    for (const candidateId of anchor.candidateIds) cite(anchor.evidenceRef, candidateId, anchor.role);
  }
  for (const conflictRow of view.agreement.roleConflicts) {
    ensure(conflictRow.evidenceRef).conflict = true;
    for (const assignment of conflictRow.assignments) {
      cite(conflictRow.evidenceRef, assignment.candidateId, assignment.role);
    }
  }
  for (const specific of view.agreement.candidateSpecific) {
    for (const evidenceRef of specific.evidenceRefs) cite(evidenceRef, specific.candidateId);
  }
  for (const evidenceRef of view.gold?.evidenceAnchors ?? []) ensure(evidenceRef);
  for (const alignment of view.alignments ?? []) {
    for (const evidenceRef of alignment.matchedAnchors) {
      cite(evidenceRef, alignment.candidateId);
      const cell = rows.get(evidenceRef)?.cells[alignment.candidateId];
      if (cell) cell.matchedGold = true;
    }
    for (const evidenceRef of alignment.missingAnchors) {
      const cell = ensure(evidenceRef).cells[alignment.candidateId];
      if (cell) cell.missingGold = true;
    }
    for (const evidenceRef of alignment.extraAnchors) {
      cite(evidenceRef, alignment.candidateId);
      const cell = rows.get(evidenceRef)?.cells[alignment.candidateId];
      if (cell) cell.extraGold = true;
    }
    for (const mismatch of alignment.roleMismatches ?? []) {
      cite(mismatch.evidenceRef, alignment.candidateId, mismatch.role);
      const cell = rows.get(mismatch.evidenceRef)?.cells[alignment.candidateId];
      if (cell) cell.benchmarkRoleDiffers = mismatch.role;
    }
  }
  for (const shared of view.comparison?.sharedEvidence ?? []) {
    for (const candidateId of shared.candidateIds) cite(shared.evidenceRef, candidateId);
  }
  for (const unique of view.comparison?.uniqueEvidence ?? []) {
    for (const evidenceRef of unique.evidenceRefs) cite(evidenceRef, unique.candidateId);
  }
  for (const convergence of view.comparison?.convergence ?? []) {
    for (const candidateId of convergence.candidateIds) cite(convergence.evidenceRef, candidateId);
  }
  const goldAnchors = view.gold ? new Set(view.gold.evidenceAnchors) : null;
  const result = [...rows.values()];
  for (const row of result) {
    row.inGold = goldAnchors ? goldAnchors.has(row.evidenceRef) : null;
    const citedBy = candidateIds.filter((candidateId) => row.cells[candidateId]?.recorded);
    row.singleLane = candidateIds.length > 1 && citedBy.length === 1;
    row.uncitedAnchor = row.inGold === true && citedBy.length === 0;
  }
  return result;
}

interface TraceCoverageFact {
  candidateId: string;
  hasTrace: boolean;
  completeness: string;
  refsInEvents: number;
  totalRefs: number;
}

function buildTraceCoverage(view: ExperimentView, rows: EvidenceCrossRow[]): TraceCoverageFact[] {
  return view.candidates.map((candidate) => {
    const trace = (view.traces ?? []).find((row) => row.candidateId === candidate.candidateId);
    if (!trace) {
      return {
        candidateId: candidate.candidateId,
        hasTrace: false,
        completeness: "unknown",
        refsInEvents: 0,
        totalRefs: rows.length,
      };
    }
    const eventRefs = new Set<string>();
    for (const event of trace.events) {
      for (const evidenceRef of event.evidenceRefs) eventRefs.add(evidenceRef);
    }
    return {
      candidateId: candidate.candidateId,
      hasTrace: true,
      completeness: trace.completeness,
      refsInEvents: rows.filter((row) => eventRefs.has(row.evidenceRef)).length,
      totalRefs: rows.length,
    };
  });
}

function traceCoverageLabel(fact: TraceCoverageFact): string {
  if (!fact.hasTrace) return "no trace recorded — coverage unknown";
  const counted = `${fact.refsInEvents} of ${fact.totalRefs} cross-examined refs appear in its events`;
  if (fact.completeness === "exact") return `complete trace — ${counted}`;
  const kind = fact.completeness === "partial" ? "partial trace" : "trace coverage unknown";
  return `${kind} — ${counted}; the rest stay unknown`;
}

interface ReviewQueueItem {
  id: string;
  facetId: string;
  category: string;
  text: string;
  href: string;
  hrefLabel: string;
  candidateIds: string[];
  evidenceRef?: string;
}

// Fixed category order. The queue is a projection of recorded facts, never a
// priority ranking: same record in, same queue out, top to bottom.
const REVIEW_QUEUE_CATEGORIES = [
  "Run completion",
  "Recorded conflicts",
  "Single-lane evidence",
  "Unknown measurements",
  "Trace completeness",
  "Human observations",
  "Benchmark comparison",
  "Decision state",
] as const;

/**
 * What a person can actually do about one queue category.
 *
 * Every entry used to end with the same sentence — "Open the recorded context
 * and resolve or annotate this item" — which tells a triage engineer nothing
 * they did not already know from having read the entry. These name the actual
 * next move, and each one is something this record can be moved forward with.
 */
const REVIEW_QUEUE_NEXT_STEP: Record<string, string> = {
  "Run completion":
    "Open the lane's run facts to see how far it got. A lane that did not complete contributes partial facts at most, so decide whether to rerun it or to proceed without it and say so in the decision.",
  "Recorded conflicts":
    "Open the evidence and read the surrounding log or trace context yourself, then record which reading the evidence supports. A role conflict changes what the remediation should be.",
  "Single-lane evidence":
    "Confirm where this evidence came from and whether anything else corroborates it, then either attach the corroboration or note in the decision that the conclusion rests on one uncorroborated lane.",
  "Unknown measurements":
    "These were never reported, so they cannot be recovered from this record. Import a run that carries them if the measurement matters to the decision; otherwise record that you decided without it.",
  "Trace completeness":
    "Open the lane's recorded path and read how far it can vouch for itself. Attach the missing transcript if you have it; if not, treat the unrecorded steps as unknown rather than as agreement.",
  "Human observations":
    "Read this lane's answer and record a helpfulness observation for it. An unreviewed lane carries no human judgment at all, which is different from a lane judged unhelpful.",
  "Benchmark comparison":
    "Alignment stays unknown until a case lead promotes an accepted decision to a benchmark. Promote one when the team has agreed, or compare the lanes directly without a benchmark.",
  "Decision state":
    "Propose a decision in Decide, with the evidence it rests on and the questions it leaves open. Nothing here decides for you.",
};

function buildReviewQueue(view: ExperimentView): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  const label = (candidateId: string): string =>
    view.candidates.find((row) => row.candidateId === candidateId)?.modelLabel ?? "recorded lane";
  const readable = (summary: string): string =>
    view.candidates.reduce((text, row) => text.split(row.candidateId).join(row.modelLabel), summary);
  const push = (item: Omit<ReviewQueueItem, "id">) => {
    items.push({ ...item, id: `${item.category}:${items.length}` });
  };
  for (const candidate of view.candidates) {
    if (candidate.runStatus !== "completed") {
      push({
        facetId: "completion",
        category: "Run completion",
        text: `${candidate.modelLabel} run is recorded as ${candidate.runStatus}, not completed`,
        href: "#candidate-comparison-heading",
        hrefLabel: "open run facts",
        candidateIds: [candidate.candidateId],
      });
    }
  }
  for (const conflictRow of view.agreement.roleConflicts) {
    push({
      facetId: "divergence",
      category: "Recorded conflicts",
      text: `Models assign different roles to the same evidence — ${conflictRow.assignments
        .map((assignment) => `${label(assignment.candidateId)} as ${assignment.role}`)
        .join("; ")}`,
      href: "#cross-exam-heading",
      hrefLabel: "open cross-examination",
      candidateIds: conflictRow.assignments.map((assignment) => assignment.candidateId),
      evidenceRef: conflictRow.evidenceRef,
    });
  }
  for (const divergenceRow of view.comparison?.divergence ?? []) {
    push({
      facetId: "divergence",
      category: "Recorded conflicts",
      text: `Recorded ${divergenceRow.kind} divergence — ${readable(divergenceRow.summary)}`,
      href: "#strategy-heading",
      hrefLabel: "open strategy comparison",
      candidateIds: [],
    });
  }
  for (const specific of view.agreement.candidateSpecific) {
    if (!specific.evidenceRefs.length) continue;
    push({
      facetId: "divergence",
      category: "Single-lane evidence",
      text: `Only ${label(specific.candidateId)} cites evidence that no other lane corroborates`,
      href: "#cross-exam-heading",
      hrefLabel: "open cross-examination",
      candidateIds: [specific.candidateId],
      evidenceRef: specific.evidenceRefs[0]!,
    });
  }
  for (const candidate of view.candidates) {
    const unknownFacts = [
      candidate.observedLatency.status === "unknown" ? "latency" : null,
      candidate.cost.status === "unknown" ? "cost" : null,
      candidate.usage.status === "unknown" ? "usage" : null,
    ].filter((fact): fact is string => fact !== null);
    if (unknownFacts.length) {
      push({
        facetId: "measurements",
        category: "Unknown measurements",
        text: `${candidate.modelLabel} has no recorded ${unknownFacts.join(", ")}`,
        href: "#candidate-comparison-heading",
        hrefLabel: "open run facts",
        candidateIds: [candidate.candidateId],
      });
    }
  }
  for (const candidate of view.candidates) {
    const trace = (view.traces ?? []).find((row) => row.candidateId === candidate.candidateId);
    if (!trace) {
      push({
        facetId: "traces",
        category: "Trace completeness",
        text: `${candidate.modelLabel} has no recorded interaction trace`,
        href: "#strategy-heading",
        hrefLabel: "open strategy paths",
        candidateIds: [candidate.candidateId],
      });
      continue;
    }
    if (trace.completeness !== "exact") {
      push({
        facetId: "traces",
        category: "Trace completeness",
        text: `${candidate.modelLabel} trace is ${
          trace.completeness === "partial" ? "partial" : "of unknown coverage"
        } — unproven steps stay unknown`,
        href: "#strategy-heading",
        hrefLabel: "open strategy paths",
        candidateIds: [candidate.candidateId],
      });
    }
    if (trace.unknowns.length) {
      push({
        facetId: "traces",
        category: "Trace completeness",
        text: `${candidate.modelLabel} trace leaves ${trace.unknowns.join(", ")} unknown`,
        href: "#strategy-heading",
        hrefLabel: "open strategy paths",
        candidateIds: [candidate.candidateId],
      });
    }
  }
  for (const candidate of view.candidates) {
    const reviewed = view.observations.some((row) => row.candidateId === candidate.candidateId);
    if (!reviewed) {
      push({
        facetId: "observations",
        category: "Human observations",
        text: `${candidate.modelLabel} has no recorded human helpfulness observation`,
        href: "#helpfulness-heading",
        hrefLabel: "open helpfulness",
        candidateIds: [candidate.candidateId],
      });
    }
  }
  if (!view.gold) {
    push({
      facetId: "benchmark",
      category: "Benchmark comparison",
      text: "No gold benchmark is recorded — benchmark comparison stays unknown for every lane",
      href: "#gold-alignment-heading",
      hrefLabel: "open gold alignment",
      candidateIds: [],
    });
  }
  for (const alignment of view.alignments ?? []) {
    if (alignment.status === "unknown" && view.gold) {
      push({
        facetId: "benchmark",
        category: "Benchmark comparison",
        text: `${label(alignment.candidateId)} is not compared against the benchmark`,
        href: "#gold-alignment-heading",
        hrefLabel: "open gold alignment",
        candidateIds: [alignment.candidateId],
      });
    } else if (alignment.status === "unscored") {
      push({
        facetId: "benchmark",
        category: "Benchmark comparison",
        text: `${label(alignment.candidateId)} cited no evidence to compare against the benchmark`,
        href: "#gold-alignment-heading",
        hrefLabel: "open gold alignment",
        candidateIds: [alignment.candidateId],
      });
    }
    if (alignment.missingAnchors.length) {
      push({
        facetId: "benchmark",
        category: "Benchmark comparison",
        text: `${label(alignment.candidateId)} does not cite benchmark anchor${
          alignment.missingAnchors.length === 1 ? "" : "s"
        } ${alignment.missingAnchors.join(", ")}`,
        href: "#cross-exam-heading",
        hrefLabel: "open cross-examination",
        candidateIds: [alignment.candidateId],
        evidenceRef: alignment.missingAnchors[0]!,
      });
    }
    if (alignment.extraAnchors.length) {
      push({
        facetId: "benchmark",
        category: "Benchmark comparison",
        text: `${label(alignment.candidateId)} cites ${alignment.extraAnchors.join(", ")} outside the benchmark anchors`,
        href: "#cross-exam-heading",
        hrefLabel: "open cross-examination",
        candidateIds: [alignment.candidateId],
        evidenceRef: alignment.extraAnchors[0]!,
      });
    }
    if ((alignment.roleMismatches ?? []).length) {
      push({
        facetId: "benchmark",
        category: "Benchmark comparison",
        text: `${label(alignment.candidateId)} records a different role than the benchmark on ${(
          alignment.roleMismatches ?? []
        )
          .map((mismatch) => mismatch.evidenceRef)
          .join(", ")}`,
        href: "#cross-exam-heading",
        hrefLabel: "open cross-examination",
        candidateIds: [alignment.candidateId],
        evidenceRef: alignment.roleMismatches![0]!.evidenceRef,
      });
    }
  }
  const latestDecision = view.decisions.at(-1);
  if (!latestDecision) {
    push({
      facetId: "decision",
      category: "Decision state",
      text: "No human decision is recorded for this experiment",
      href: "#decision-heading",
      hrefLabel: "open decision",
      candidateIds: [],
    });
  } else if (latestDecision.status !== "accepted") {
    push({
      facetId: "decision",
      category: "Decision state",
      text: `Decision r${latestDecision.revision} is ${latestDecision.status} and awaits human adjudication`,
      href: "#decision-heading",
      hrefLabel: "open decision",
      candidateIds: [],
    });
  }
  return items;
}

interface ReadinessFacet {
  id: string;
  label: string;
  state: string;
  meaning: string;
  href: string;
  hrefLabel: string;
}

function buildReadinessFacets(view: ExperimentView): ReadinessFacet[] {
  const laneCount = view.candidates.length;
  const plural = (count: number): string => (count === 1 ? "" : "s");
  const statusCounts: [string, number][] = [];
  for (const candidate of view.candidates) {
    const entry = statusCounts.find(([status]) => status === candidate.runStatus);
    if (entry) entry[1] += 1;
    else statusCounts.push([candidate.runStatus, 1]);
  }
  const sharedCount = view.agreement.sharedAnchors.length;
  const conflictCount = view.agreement.roleConflicts.length;
  const singleLaneSets = view.agreement.candidateSpecific.filter(
    (row) => row.evidenceRefs.length,
  ).length;
  const strategyDivergences = (view.comparison?.divergence ?? []).length;
  const divergenceParts = [
    conflictCount ? `${conflictCount} role conflict${plural(conflictCount)}` : null,
    singleLaneSets ? `${singleLaneSets} single-lane citation set${plural(singleLaneSets)}` : null,
    strategyDivergences
      ? `${strategyDivergences} strategy divergence${plural(strategyDivergences)}`
      : null,
  ].filter((part): part is string => part !== null);
  let unknownMeasurements = 0;
  for (const candidate of view.candidates) {
    if (candidate.observedLatency.status === "unknown") unknownMeasurements += 1;
    if (candidate.cost.status === "unknown") unknownMeasurements += 1;
    if (candidate.usage.status === "unknown") unknownMeasurements += 1;
  }
  let completeTraces = 0;
  let partialTraces = 0;
  let unknownTraces = 0;
  let missingTraces = 0;
  for (const candidate of view.candidates) {
    const trace = (view.traces ?? []).find((row) => row.candidateId === candidate.candidateId);
    if (!trace) missingTraces += 1;
    else if (trace.completeness === "exact") completeTraces += 1;
    else if (trace.completeness === "partial") partialTraces += 1;
    else unknownTraces += 1;
  }
  const traceParts = [
    completeTraces ? `${completeTraces} complete` : null,
    partialTraces ? `${partialTraces} partial` : null,
    unknownTraces ? `${unknownTraces} unknown coverage` : null,
    missingTraces ? `${missingTraces} missing` : null,
  ].filter((part): part is string => part !== null);
  const reviewedLanes = view.candidates.filter((candidate) =>
    view.observations.some((row) => row.candidateId === candidate.candidateId),
  ).length;
  const latestDecision = view.decisions.at(-1);
  const alignmentCounts: [string, number][] = [];
  for (const alignment of view.alignments ?? []) {
    const entry = alignmentCounts.find(([status]) => status === alignment.status);
    if (entry) entry[1] += 1;
    else alignmentCounts.push([alignment.status, 1]);
  }
  return [
    {
      id: "completion",
      label: "Candidate completion",
      state: laneCount
        ? `${laneCount} lane${plural(laneCount)} · ${statusCounts
            .map(([status, count]) => `${count} ${status}`)
            .join(" · ")}`
        : "no candidate lanes recorded",
      meaning:
        "Run status for every candidate lane, exactly as imported. A lane that did not complete contributes partial facts at most.",
      href: "#candidate-comparison-heading",
      hrefLabel: "run facts",
    },
    {
      id: "agreement",
      label: "Shared evidence",
      state: sharedCount
        ? `${sharedCount} shared anchor${plural(sharedCount)} recorded`
        : "none recorded",
      meaning:
        "Evidence anchors more than one lane cites. Agreement is not proof of correctness — it only narrows where to look.",
      href: "#evidence-heading",
      hrefLabel: "evidence map",
    },
    {
      id: "divergence",
      label: "Divergence",
      state: divergenceParts.length ? divergenceParts.join(" · ") : "none recorded",
      meaning:
        "Recorded role conflicts, single-lane evidence, and strategy divergences. Differences are leads to investigate, not a ranking.",
      href: "#cross-exam-heading",
      hrefLabel: "cross-examination",
    },
    {
      id: "measurements",
      label: "Unknown measurements",
      state: unknownMeasurements
        ? `${unknownMeasurements} measurement${plural(unknownMeasurements)} unknown`
        : "no unknown measurements recorded",
      meaning:
        "Latency, cost, and usage facts the record leaves unknown. Unknown stays unknown until an import resolves it.",
      href: "#candidate-comparison-heading",
      hrefLabel: "run facts",
    },
    {
      id: "traces",
      label: "Trace completeness",
      state: traceParts.length ? traceParts.join(" · ") : "no candidate lanes recorded",
      meaning:
        "Whether each lane's interaction trace is complete, partial, or missing. Partial and missing traces cannot prove what happened in unrecorded steps.",
      href: "#strategy-heading",
      hrefLabel: "strategy paths",
    },
    {
      id: "observations",
      label: "Human observations",
      state: `${view.observations.length} recorded · ${reviewedLanes} of ${laneCount} lane${plural(
        laneCount,
      )} reviewed`,
      meaning:
        "Human helpfulness observations recorded per lane. They describe usefulness as judged by a person, separate from any benchmark.",
      href: "#helpfulness-heading",
      hrefLabel: "helpfulness",
    },
    {
      id: "decision",
      label: "Decision state",
      state: latestDecision
        ? `${latestDecision.status} r${latestDecision.revision}${
            latestDecision.status === "accepted" ? "" : " — not accepted"
          }`
        : "none recorded",
      meaning:
        "The latest recorded human decision and its revision. Only an accepted decision is adjudicated; a proposal is not an outcome.",
      href: "#decision-heading",
      hrefLabel: "decision",
    },
    {
      id: "benchmark",
      label: "Benchmark state",
      state: view.gold
        ? `v${view.gold.version} recorded · ${view.gold.evidenceAnchors.length} anchor${plural(
            view.gold.evidenceAnchors.length,
          )}${
            alignmentCounts.length
              ? ` · alignment ${alignmentCounts
                  .map(([status, count]) => `${count} ${status}`)
                  .join(", ")}`
              : ""
          }`
        : "none recorded — alignment stays unknown",
      meaning:
        "The recorded gold benchmark, if any. A gold reference is a human benchmark decision, not an infallible truth claim.",
      href: "#gold-alignment-heading",
      hrefLabel: "gold alignment",
    },
  ];
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error.trim()
    ) {
      const message = body.error.trim();
      if (/(authorization|bearer|api[_-]?key|credential|secret|token|https?:\/\/)/i.test(message)) {
        return fallback;
      }
      return message.length > 240 ? `${message.slice(0, 237)}…` : message;
    }
  } catch {
    // Preserve a useful fallback when the server returned no JSON body.
  }
  return fallback;
}

/**
 * The notes At a glance adds under its own summary, stated once each.
 *
 * `agreement.notes` and `comparison.notes` are independent sources that both
 * routinely carry the agreement-is-not-correctness boundary, and the section
 * states that boundary itself, in full, on the "What agrees" card. Joined
 * as-is the reader met it two or three times in one paragraph, which buries
 * the findings the section exists to show and reads as hedging rather than as
 * a boundary worth respecting.
 *
 * So: the boundary is kept exactly once, where it is stated in full, and every
 * other note survives — deduplicated, in order. Nothing truthful is dropped.
 */
export function scanSectionNotes(
  agreementNotes: readonly string[],
  comparisonNotes: readonly string[],
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const note of [...agreementNotes, ...comparisonNotes]) {
    const text = note.trim();
    if (!text) continue;
    const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(normalized)) continue;
    // Restatements of the boundary the section already prints in full.
    if (normalized.startsWith("agreement is not proof of correctness")) continue;
    if (normalized.startsWith("agreement is not correctness")) continue;
    seen.add(normalized);
    kept.push(text);
  }
  return kept;
}

export function ExperimentLab(props: {
  caseId: string;
  canWrite: boolean;
  canLead: boolean;
  readOnly?: boolean;
  caseTitle?: string;
  caseStatus?: string;
  caseSeverity?: string;
  /**
   * Questions the investigation recorded about itself in Situation. Compare
   * used to read only the unknowns a decision left open, so questions a person
   * had already written down were reported here as "none recorded".
   */
  caseOpenQuestions?: string[];
  participant?: { username: string; roles: string[] };
  /**
   * Which part of the lab to present. "full" (the default, and the behavior
   * existing consumers already rely on) renders everything; "comparison"
   * renders only the review/comparison material; "decision" renders only the
   * human decision journal and share-safe export.
   */
  surface?: "full" | "comparison" | "decision";
  routeFocus?: WorkFocus;
  onDeepNavigate?: (focus: WorkFocus) => void;
}) {
  const surface = props.surface ?? "full";
  const showComparison = surface !== "decision";
  const showDecision = surface !== "comparison";
  const readOnly = props.readOnly === true;
  const canWrite = props.canWrite && !readOnly;
  const canLead = props.canLead && !readOnly;
  const canExport = props.canLead || readOnly;
  const participantName = props.participant?.username || (readOnly ? "read-only viewer" : "authenticated participant");
  const participantRole = props.participant?.roles.join(", ") || (canLead ? "case-lead access" : canWrite ? "contributor access" : "read-only access");
  const [experiments, setExperiments] = useState<ExperimentView[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [benchPayload, setBenchPayload] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<ShareSafeExport | null>(null);
  const [presence, setPresence] = useState<PresenceView | null>(null);
  const [evidenceArtifacts, setEvidenceArtifacts] = useState<EvidenceArtifactView[]>([]);
  const [evidenceExcerpts, setEvidenceExcerpts] = useState<Record<string, LoadedEvidenceExcerpt>>({});
  const requestedEvidenceExcerpts = useRef(new Set<string>());
  // Focus is URL-backed for reload/back/forward, but never filters evidence.
  const [focusedCandidateId, setFocusedCandidateId] = useState<string | null>(null);
  const [workspaceSection, setWorkspaceSection] = useState<CompareWorkspaceId>(() =>
    compareWorkspaceFor(props.routeFocus?.section),
  );
  const [workspaceItem, setWorkspaceItem] = useState<string | null>(
    () => props.routeFocus?.item ?? null,
  );
  const surfaceStage = surface === "decision" ? "decide" : "compare";
  const [navigationTarget, setNavigationTarget] = useState<WorkFocus | null>(() => {
    const routeFocus = props.routeFocus;
    if (!routeFocus || stageForSection(routeFocus.section) !== surfaceStage) return null;
    return routeFocus.navigation === "preserve" ? null : routeFocus;
  });
  const lastNavigationKey = useRef<string | null>(
    props.routeFocus ? navigationKey(props.routeFocus) : null,
  );
  // A routed click updates local state before its parent can echo the new URL
  // focus back through props. While that echo is pending, effects caused by a
  // different local state update must not re-apply the now-stale old route.
  const pendingRouteEchoKey = useRef<string | null>(null);
  const experimentsRef = useRef<ExperimentView[]>(experiments);
  experimentsRef.current = experiments;
  const loadedCaseId = useRef(props.caseId);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async (preferredId?: string) => {
    const generation = ++refreshGeneration.current;
    const isCurrent = () => generation === refreshGeneration.current;
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments`);
      if (!res.ok) {
        const message = await responseError(res, "Experiment history could not be loaded");
        if (isCurrent()) setError(message);
        return;
      }
      const body = (await res.json()) as { experiments?: ExperimentView[] };
      if (!isCurrent()) return;
      const nextExperiments = body.experiments ?? [];
      setExperiments(nextExperiments);
      if (preferredId && nextExperiments.some((row) => row.id === preferredId)) {
        setActive(preferredId);
      }
    } catch {
      if (isCurrent()) setError("Experiment history could not be loaded");
    }
  }, [props.caseId]);

  useEffect(() => {
    let mounted = true;
    setEvidenceArtifacts([]);
    setEvidenceExcerpts({});
    requestedEvidenceExcerpts.current = new Set<string>();
    void protectedApiFetch(`/api/cases/${props.caseId}/evidence`)
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { artifacts?: EvidenceArtifactView[] };
      })
      .then((body) => {
        if (mounted && body) setEvidenceArtifacts(body.artifacts ?? []);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [props.caseId]);

  useEffect(() => {
    function handleExperimentCreated(event: Event) {
      const detail = (event as CustomEvent<{ experimentId?: unknown }>).detail;
      if (!detail || typeof detail.experimentId !== "string" || !detail.experimentId) return;
      setError(null);
      setExported(null);
      void refresh(detail.experimentId);
    }

    window.addEventListener("contextdesk:experiment-created", handleExperimentCreated);
    return () => window.removeEventListener("contextdesk:experiment-created", handleExperimentCreated);
  }, [refresh]);

  useEffect(() => {
    const caseChanged = loadedCaseId.current !== props.caseId;
    loadedCaseId.current = props.caseId;
    const requestedExperiment = props.routeFocus?.experiment;
    const alreadyLoaded = requestedExperiment
      ? experimentsRef.current.some((row) => row.id === requestedExperiment)
      : experimentsRef.current.length > 0;
    if (!caseChanged && alreadyLoaded) {
      if (requestedExperiment) setActive(requestedExperiment);
      return;
    }
    refreshGeneration.current += 1;
    experimentsRef.current = [];
    setExperiments([]);
    setActive(null);
    setExported(null);
    setError(null);
    setPresence(null);
    setFocusedCandidateId(null);
    void refresh(requestedExperiment ?? undefined);
  }, [props.caseId, props.routeFocus?.experiment, refresh]);

  useEffect(() => {
    // A standalone/static consumer owns lane focus locally after pushState.
    // Only a parent-routed consumer should re-project focus from props; otherwise
    // a late experiment refresh can race a click and clear the just-selected lane.
    if (!props.routeFocus) return;
    const incomingRouteKey = navigationKey(props.routeFocus);
    if (pendingRouteEchoKey.current) {
      if (incomingRouteKey !== pendingRouteEchoKey.current) return;
      pendingRouteEchoKey.current = null;
    }
    const requestedExperiment = props.routeFocus?.experiment;
    if (requestedExperiment && experiments.some((row) => row.id === requestedExperiment)) {
      setActive(requestedExperiment);
    }
    const requestedLane = props.routeFocus?.lane;
    const selected = experiments.find((row) =>
      (requestedExperiment
        ? row.id === requestedExperiment
        : row.id === (active ?? defaultExperimentId(experiments))),
    );
    setFocusedCandidateId(
      requestedLane && selected?.candidates.some((row) => row.candidateId === requestedLane)
        ? requestedLane
        : null,
    );
  }, [props.routeFocus, experiments, active]);

  useEffect(() => {
    setWorkspaceSection(compareWorkspaceFor(props.routeFocus?.section));
    setWorkspaceItem(props.routeFocus?.item ?? null);
    if (props.routeFocus) {
      const nextNavigationKey = navigationKey(props.routeFocus);
      if (props.routeFocus.navigation === "preserve") {
        lastNavigationKey.current = nextNavigationKey;
        setNavigationTarget(null);
        return;
      }
      if (lastNavigationKey.current !== nextNavigationKey) {
        lastNavigationKey.current = nextNavigationKey;
        if (stageForSection(props.routeFocus.section) === surfaceStage) {
          setNavigationTarget(props.routeFocus);
        }
      }
    }
  }, [props.routeFocus?.section, props.routeFocus?.itemKind, props.routeFocus?.item, props.routeFocus?.experiment, props.routeFocus?.navigation, surfaceStage]);

  useEffect(() => {
    // Section and item navigation moves keyboard focus to the rendered destination.
    // Lane-only focus never updates navigationTarget, so it cannot move the viewport.
    if (!navigationTarget) return undefined;
    const timer = window.setTimeout(() => {
      const exactItem = matchingRouteItem(navigationTarget);
      const requestedSection = visibleSectionTarget(navigationTarget.section);
      const workspace = COMPARE_WORKSPACE.find(
        (item) => item.id === compareWorkspaceFor(navigationTarget.section),
      );
      const workspaceHeading = workspace ? visibleSectionTarget(workspace.section) : null;
      const destination = exactItem ?? requestedSection ?? workspaceHeading;
      if (destination) {
        destination.focus({ preventScroll: true });
        destination.scrollIntoView?.({
          block: exactItem ? "nearest" : "start",
          inline: "nearest",
        });
      }
      if (destination) setNavigationTarget(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [experiments, navigationTarget, workspaceSection]);

  useEffect(() => {
    // Unit/static consumers without an authenticated participant have no
    // presence session to announce. The real app always supplies one.
    if (!props.participant) return undefined;
    let mounted = true;
    const refreshPresence = async () => {
      if (!readOnly) {
        await protectedApiFetch(`/api/cases/${props.caseId}/presence`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface: "experiment_lab" }),
        }).catch(() => undefined);
      }
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/presence`).catch(() => null);
      if (!mounted || !response?.ok) return;
      const body = (await response.json().catch(() => null)) as PresenceView | null;
      if (mounted && body && Array.isArray(body.members)) setPresence(body);
    };
    void refreshPresence();
    const timer = window.setInterval(() => void refreshPresence(), 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [props.caseId, props.participant?.username, readOnly]);

  // An explicit selection always wins; otherwise the newest comparison is the
  // decision basis, so a stale run can never quietly become one.
  const current =
    experiments.find((row) => row.id === active)
    ?? experiments.find((row) => row.id === defaultExperimentId(experiments))
    ?? null;

  useEffect(() => {
    if (!current) return undefined;
    const artifactIds = new Set(evidenceArtifacts.map((artifact) => artifact.id));
    const pending = evidenceRefsFor(current).filter(
      (evidenceId) => artifactIds.has(evidenceId) && !requestedEvidenceExcerpts.current.has(evidenceId),
    );
    if (!pending.length) return undefined;
    let mounted = true;
    for (const evidenceId of pending) requestedEvidenceExcerpts.current.add(evidenceId);
    void Promise.all(pending.map(async (evidenceId) => {
      try {
        const response = await protectedApiFetch(
          `/api/cases/${props.caseId}/evidence/${evidenceId}/bytes`,
        );
        if (!response.ok) return null;
        const body = (await response.json()) as { contentBase64?: string };
        const excerpt = body.contentBase64 ? decodeEvidenceExcerpt(body.contentBase64) : null;
        return excerpt ? [evidenceId, excerpt] as const : null;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!mounted) return;
      const loaded = entries.filter((entry): entry is readonly [string, LoadedEvidenceExcerpt] => entry !== null);
      if (loaded.length) {
        setEvidenceExcerpts((previous) => ({ ...previous, ...Object.fromEntries(loaded) }));
      }
    });
    return () => {
      mounted = false;
    };
  }, [current, evidenceArtifacts, props.caseId]);

  const evidenceRouteItems = new Set(current ? evidenceRefsFor(current) : []);
  const laneRouteItems = new Set((current?.candidates ?? []).map((row) => row.candidateId));
  const routeFor = (
    section: string,
    item: string | null = null,
    lane: string | null = null,
    itemKind: RouteItemKind | null = !item
      ? null
      : evidenceRouteItems.has(item)
        ? "evidence"
        : laneRouteItems.has(item)
          ? "lane"
          : null,
  ): WorkFocus => ({
    section,
    item,
    itemKind,
    lane,
    experiment: current?.id ?? null,
  });
  const hrefFor = (focus: WorkFocus): string => pathFor({
    area: "investigations",
    caseId: props.caseId,
    stage: stageForSection(focus.section),
    focus,
  });
  const applyFocus = (focus: WorkFocus, navigateDestination: boolean) => {
    setWorkspaceSection(compareWorkspaceFor(focus.section));
    setWorkspaceItem(focus.item);
    setFocusedCandidateId(focus.lane);
    // Record the effective section/item/experiment even for lane-only changes.
    // The parent will pass the same focus back as routeFocus; treating that first
    // URL-backed echo as section navigation would steal focus and scroll.
    lastNavigationKey.current = navigationKey(focus);
    if (navigateDestination) {
      setNavigationTarget(focus);
    } else {
      setNavigationTarget(null);
    }
  };
  const commitFocus = (focus: WorkFocus, navigateDestination = true) => {
    const routedFocus: WorkFocus = navigateDestination
      ? focus
      : { ...focus, navigation: "preserve" };
    applyFocus(routedFocus, navigateDestination);
    if (props.onDeepNavigate) {
      pendingRouteEchoKey.current = navigationKey(routedFocus);
      props.onDeepNavigate(routedFocus);
      return;
    }
    pendingRouteEchoKey.current = null;
    window.history.pushState(routedFocus, "", hrefFor(routedFocus));
  };
  const deepLink = (
    label: ReactNode,
    section: string,
    item: string | null = null,
    lane: string | null = null,
    className?: string,
  ) => {
    const focus = routeFor(section, item, lane);
    return (
      <a
        className={className}
        href={hrefFor(focus)}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (isModifiedClick(event)) return;
          const currentStage = surface === "decision" ? "decide" : "compare";
          if (stageForSection(focus.section) !== currentStage) return;
          event.preventDefault();
          commitFocus(focus);
        }}
      >
        {label}
      </a>
    );
  };
  const candidateLabel = (candidateId: string): string =>
    current?.candidates.find((row) => row.candidateId === candidateId)?.modelLabel ?? "recorded lane";
  const readableSummary = (summary: string): string =>
    (current?.candidates ?? []).reduce(
      (text, row) => text.split(row.candidateId).join(row.modelLabel),
      summary,
    );
  const latestDecision = current?.decisions.at(-1) ?? null;
  const acceptedDecision = current
    ? [...current.decisions].reverse().find((row) => row.status === "accepted") ?? null
    : null;
  // Count the divergences the strategy comparison actually lists; the
  // agreement-derived count misses question/hypothesis divergences and would
  // show a measured-looking zero next to a non-empty divergence list.
  const divergenceCount = current
    ? current.comparison?.divergence
      ? current.comparison.divergence.length
      : current.agreement.candidateSpecific.reduce(
          (count, row) => count + row.evidenceRefs.length,
          0,
        ) + current.agreement.roleConflicts.length
    : 0;
  // Scan-strip projections: every line restates a fact already present in the
  // response. Nothing here ranks, scores, or infers a winner.
  const runFactsSummary = candidateRunSummary(current?.candidates ?? []);
  const scanNotes = scanSectionNotes(
    current?.agreement.notes ?? [],
    current?.comparison?.notes ?? [],
  );
  const goldConvergenceCount = (current?.comparison?.convergence ?? []).filter(
    (row) => row.inGold,
  ).length;
  // Keep investigative unknowns separate from run telemetry. Missing cost,
  // token usage, traces, or a benchmark matters for auditability, but none of
  // those facts is an unanswered question about the incident itself.
  // Both sources are real open questions, and each says where it came from:
  // one was written down when the investigation was framed, the other was left
  // open by the latest decision. Neither is inferred from the other.
  const recordedOpenQuestions = (props.caseOpenQuestions ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => ({ text: item, source: "recorded in Situation" }));
  const decisionUnknowns = (latestDecision?.remainingUnknowns ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => ({ text: item, source: "left open by the latest decision" }));
  const seenUnknowns = new Set<string>();
  const caseUnknowns = [...recordedOpenQuestions, ...decisionUnknowns].filter((row) => {
    if (seenUnknowns.has(row.text)) return false;
    seenUnknowns.add(row.text);
    return true;
  });
  const runDetailGaps: string[] = [];
  const candidateCount = current?.candidates.length ?? 0;
  const unknownLatencyCount = (current?.candidates ?? []).filter(
    (row) => row.observedLatency.status === "unknown",
  ).length;
  const unknownCostCount = (current?.candidates ?? []).filter(
    (row) => row.cost.status === "unknown",
  ).length;
  const unknownUsageCount = (current?.candidates ?? []).filter(
    (row) => row.usage.status === "unknown",
  ).length;
  const showLatencyColumn = (current?.candidates ?? []).some(
    (row) => row.observedLatency.status !== "unknown",
  );
  const showCostColumn = (current?.candidates ?? []).some(
    (row) => row.cost.status !== "unknown",
  );
  const showUsageColumn = (current?.candidates ?? []).some(
    (row) => row.usage.status !== "unknown",
  );
  const telemetryParts = [
    unknownLatencyCount ? `latency for ${unknownLatencyCount}` : null,
    unknownCostCount ? `cost for ${unknownCostCount}` : null,
    unknownUsageCount ? `usage for ${unknownUsageCount}` : null,
  ].filter((item): item is string => item !== null);
  if (telemetryParts.length) {
    runDetailGaps.push(
      `Run telemetry was not reported: ${telemetryParts.join("; ")} of ${candidateCount} lane${candidateCount === 1 ? "" : "s"}.`,
    );
  }
  const missingTraceCount = (current?.candidates ?? []).filter(
    (row) => !(current?.traces ?? []).some((trace) => trace.candidateId === row.candidateId),
  ).length;
  const incompleteTraces = (current?.traces ?? []).filter((trace) => trace.completeness !== "exact");
  const traceUnknownFields = [...new Set(
    incompleteTraces.flatMap((trace) => trace.unknowns.map((item) => item.trim()).filter(Boolean)),
  )];
  if (missingTraceCount || incompleteTraces.length) {
    const traceParts = [
      missingTraceCount ? `${missingTraceCount} not recorded` : null,
      incompleteTraces.length ? `${incompleteTraces.length} incomplete` : null,
    ].filter((item): item is string => item !== null);
    runDetailGaps.push(
      `Interaction traces: ${traceParts.join("; ")}.${traceUnknownFields.length ? ` Unrecorded fields include ${traceUnknownFields.join(", ")}.` : ""}`,
    );
  }
  if (current && !current.gold) {
    runDetailGaps.push("No human benchmark has been recorded for this comparison.");
  } else {
    const unscoredAlignmentCount = (current?.alignments ?? []).filter(
      (row) => row.status === "unknown" || row.status === "unscored",
    ).length;
    if (unscoredAlignmentCount) {
      runDetailGaps.push(
        `${unscoredAlignmentCount} lane${unscoredAlignmentCount === 1 ? " has" : "s have"} no scored benchmark comparison.`,
      );
    }
  }
  // Cockpit projections — pure restatements of the current view (see builders).
  const crossRows = current ? buildEvidenceCrossRows(current) : [];
  const humanFindings = current
    ? buildHumanFindings(current, crossRows, evidenceArtifacts, evidenceExcerpts)
    : [];
  const visibleQueueText = (text: string): string => crossRows.reduce(
    (readable, row) => readable.split(row.evidenceRef).join("the recorded evidence"),
    text,
  );
  const traceCoverage = current ? buildTraceCoverage(current, crossRows) : [];
  const reviewQueue = current ? buildReviewQueue(current) : [];
  const readinessFacets = current ? buildReadinessFacets(current) : [];
  const queuedByFacet = (facetId: string): number =>
    reviewQueue.filter((item) => item.facetId === facetId).length;
  // Guard against a stale id after refresh: focus only ever points at a lane
  // that exists in the current experiment, otherwise it silently resets.
  const focusedCandidate =
    current?.candidates.find((row) => row.candidateId === focusedCandidateId) ?? null;
  const focusedTrace = focusedCandidate
    ? (current?.traces ?? []).find((row) => row.candidateId === focusedCandidate.candidateId) ?? null
    : null;
  const focusedEvents = [...(focusedTrace?.events ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const focusedQuestion = focusedEvents.find(
    (event) => event.actor === "human" && Boolean(event.excerpt?.trim()),
  ) ?? focusedEvents.find((event) => Boolean(event.excerpt?.trim())) ?? null;
  const focusedEvidence = focusedEvents.filter(
    (event) => event.actor === "tool" && Boolean(event.excerpt?.trim()),
  );
  const focusedConclusion = [...focusedEvents].reverse().find(
    (event) => (
      event.actor === "assistant"
      || /assistant_response|answer|result|conclusion|recommendation/i.test(event.kind)
    ) && Boolean(event.excerpt?.trim()),
  ) ?? null;
  const focusedUnknowns = [...new Set([
    ...(focusedTrace?.unknowns ?? []),
    ...focusedEvents.flatMap((event) => event.unknowns),
  ])];
  const focusedObservations = focusedCandidate
    ? (current?.observations ?? []).filter((row) => row.candidateId === focusedCandidate.candidateId)
    : [];
  const focusQueueCount = focusedCandidate
    ? reviewQueue.filter((item) => item.candidateIds.includes(focusedCandidate.candidateId)).length
    : 0;

  function selectExperiment(id: string) {
    const currentWorkspace = COMPARE_WORKSPACE.find((item) => item.id === workspaceSection)
      ?? COMPARE_WORKSPACE[0];
    const focus: WorkFocus = {
      section: currentWorkspace.section,
      item: null,
      lane: null,
      experiment: id,
    };
    setActive(id);
    setExported(null);
    setError(null);
    commitFocus(focus);
  }

  function selectLaneFocus(lane: string | null) {
    const currentWorkspace = COMPARE_WORKSPACE.find((item) => item.id === workspaceSection)
      ?? COMPARE_WORKSPACE[0];
    const section =
      props.routeFocus?.section &&
      compareWorkspaceFor(props.routeFocus.section) === workspaceSection
        ? props.routeFocus.section
        : currentWorkspace.section;
    // Keep the current subsection and item. URL-backed lane focus is shareable,
    // but it is not a jump to a distant panel.
    commitFocus(routeFor(section, workspaceItem, lane), false);
  }

  async function importPackage(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      setError("Package JSON is invalid");
      return;
    }
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await responseError(res, "Experiment import failed"));
        return;
      }
      const json = (await res.json()) as ExperimentView;
      setPayload("");
      selectExperiment(json.id);
      await refresh();
    } catch {
      setError("Experiment import failed");
    }
  }

  async function importBenchArtifact(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let body: unknown;
    try {
      body = JSON.parse(benchPayload);
    } catch {
      setError("Bench artifact JSON is invalid");
      return;
    }
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await responseError(res, "Bench artifact import failed"));
        return;
      }
      const json = (await res.json()) as ExperimentView;
      setBenchPayload("");
      selectExperiment(json.id);
      await refresh();
    } catch {
      setError("Bench artifact import failed");
    }
  }

  async function recordHelpfulness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    // React nulls event.currentTarget once the handler yields; capture the form
    // before the first await or the post-success reset throws and the UI would
    // falsely report a recorded observation as failed.
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments/${current.id}/helpfulness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidateId: String(data.get("candidateId") ?? ""),
          dimension: String(data.get("dimension") ?? ""),
          score: Number(data.get("score")),
          rationale: String(data.get("rationale") ?? ""),
          evidenceRefs: data.getAll("evidenceRefs").map(String),
        }),
      });
      if (!res.ok) {
        setError(await responseError(res, "Helpfulness could not be recorded"));
        return;
      }
      form.reset();
      await refresh();
    } catch {
      setError("Helpfulness could not be recorded");
    }
  }

  async function proposeDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const latest = current.decisions.at(-1);
    setError(null);
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments/${current.id}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: String(data.get("text") ?? ""),
          rationale: String(data.get("rationale") ?? ""),
          evidenceRefs: data.getAll("evidenceRefs").map(String),
          ownerAssignment: String(data.get("ownerAssignment") ?? "unassigned"),
          remainingUnknowns: String(data.get("remainingUnknowns") ?? "")
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean),
          expectedRevision: latest ? latest.revision : null,
        }),
      });
      if (!res.ok) {
        setError(await responseError(res, "Decision proposal could not be recorded"));
        return;
      }
      form.reset();
      await refresh();
    } catch {
      setError("Decision proposal could not be recorded");
    }
  }

  async function acceptDecision() {
    if (!current) return;
    const latest = current.decisions.at(-1);
    if (!latest) return;
    setError(null);
    try {
      const res = await protectedApiFetch(
        `/api/cases/${props.caseId}/experiments/${current.id}/decisions/${latest.id}/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: latest.revision }),
        },
      );
      if (!res.ok) {
        setError(await responseError(res, "Decision could not be accepted"));
        return;
      }
      await refresh();
    } catch {
      setError("Decision could not be accepted");
    }
  }

  async function exportReview() {
    if (!current) return;
    setError(null);
    setExported(null);
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments/${current.id}/export`, {
        method: "POST",
      });
      const body = (await res.json()) as ShareSafeExport & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Share-safe export failed");
        return;
      }
      setExported(body);
    } catch {
      setError("Share-safe export failed because the response could not be read");
    }
  }

  async function promoteGold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const accepted = [...current.decisions].reverse().find((row) => row.status === "accepted");
    if (!accepted) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const evidenceAnchors = data.getAll("evidenceRefs").map(String);
    if (!evidenceAnchors.length) {
      setError("Select at least one recorded evidence item for the human benchmark");
      return;
    }
    const expectedGold = String(data.get("expectedGoldVersion") ?? "").trim();
    setError(null);
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments/${current.id}/gold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decisionId: accepted.id,
          expectedRevision: accepted.revision,
          expectedGoldVersion: expectedGold ? Number(expectedGold) : current.gold?.version ?? 0,
          evidenceAnchors,
          expectedRelationships: evidenceAnchors.flatMap((evidenceRef) => {
            const role = String(data.get(`evidenceRole:${evidenceRef}`) ?? "").trim();
            return role ? [{ evidenceRef, role }] : [];
          }),
          helpfulnessDimensions: String(data.get("helpfulnessDimensions") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      });
      if (!res.ok) {
        setError(await responseError(res, "Gold promotion failed"));
        return;
      }
      form.reset();
      await refresh();
    } catch {
      setError("Gold promotion failed");
    }
  }

  async function importTrace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const raw = String(data.get("trace") ?? "");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      setError("Trace JSON is invalid");
      return;
    }
    try {
      const res = await protectedApiFetch(`/api/cases/${props.caseId}/experiments/${current.id}/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await responseError(res, "Trace import failed"));
        return;
      }
      form.reset();
      await refresh();
    } catch {
      setError("Trace import failed");
    }
  }

  async function annotateTrace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const candidateId = String(data.get("candidateId") ?? "");
    setError(null);
    try {
      const res = await protectedApiFetch(
        `/api/cases/${props.caseId}/experiments/${current.id}/traces/${candidateId}/annotations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: String(data.get("text") ?? ""),
            evidenceRefs: String(data.get("evidenceRefs") ?? "")
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          }),
        },
      );
      if (!res.ok) {
        setError(await responseError(res, "Trace annotation could not be recorded"));
        return;
      }
      form.reset();
      await refresh();
    } catch {
      setError("Trace annotation could not be recorded");
    }
  }

  return (
    <section
      className={`experiment-lab${surface === "decision" ? " experiment-lab--decision" : ""}`}
    >
      <header className="experiment-lab__header">
        <div>
          <p className="experiment-lab__eyebrow">
            {surface === "decision" ? "Human adjudication" : "Comparison lab"}
          </p>
          <h3 className="case-view__title">
            {surface === "decision" ? "Decision journal" : "Experiment lab"}
          </h3>
          {/* The investigation is named in readable case. A bare identifier is
              never presented as if it were a title. */}
          <p className="experiment-lab__case-name">
            {props.caseTitle ? (
              <>Investigation: {props.caseTitle}</>
            ) : (
              <>Investigation title not recorded</>
            )}
          </p>
          <p className="experiment-lab__case-state">
            <span>{props.caseStatus ?? "status unavailable"}</span>
            <span>{props.caseSeverity ?? "severity unavailable"} severity</span>
          </p>
        </div>
        <div className="experiment-lab__presence" aria-label="Case presence">
          <span className="experiment-lab__presence-dot" aria-hidden="true" />
          <div>
            <span className="experiment-lab__eyebrow">Current participant</span>
            <strong>{participantName}</strong>
            <span>{participantRole}</span>
            {presence ? (
              <span aria-live="polite">
                {presence.members.length} active now · {presence.members.map((member) => member.username).join(", ") || "no one else"}
              </span>
            ) : (
              <span>Presence unavailable</span>
            )}
            <span>Presence refreshes periodically</span>
          </div>
          {current ? (
            <span className="experiment-lab__status">{current.candidates.length} candidate lanes</span>
          ) : null}
        </div>
      </header>
      {showComparison ? (
        <p className="experiment-lab__intro">
          Compare recorded analyses from ContextDesk, imported chat, and other triage methods.
          Review the evidence, disagreements, and open questions; a person makes the decision.
        </p>
      ) : null}
      {surface === "decision" ? (
        <p className="experiment-lab__authority">
          Actions in this room are attributed to <strong>{participantName}</strong> ({participantRole}).
          The server remains authoritative for permissions, provenance, and accepted state.
        </p>
      ) : null}
      {readOnly ? (
        <p className="experiment-lab__disclaimer" role="status">
          Static read-only mode: review the seeded comparison or export its share-safe
          projection. Editing, importing, scoring, and benchmark changes are unavailable.
        </p>
      ) : null}
      {showComparison && canWrite ? (
        <details className="experiment-lab__tools">
          <summary>Add or import analysis</summary>
          <details className="experiment-lab__tools">
            <summary>Import another experiment package</summary>
            <form className="composer" onSubmit={(event) => void importPackage(event)}>
              <textarea
                className="login__input"
                rows={6}
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                aria-label="Share-safe experiment, strategy package, or summary JSON"
                placeholder="Paste share-safe experiment, strategy package, or summary JSON"
                required
              />
              <button className="login__submit" type="submit">
                Import experiment
              </button>
            </form>
          </details>
          <details className="experiment-lab__tools">
            <summary>Import bench-compare / recorded artifact</summary>
            <p className="experiment-lab__section-note">
              Paste a share-safe multi-strategy artifact. Imported output remains unverified until a
              person reviews it.
            </p>
            <form className="composer" onSubmit={(event) => void importBenchArtifact(event)}>
              <textarea
                className="login__input"
                rows={6}
                value={benchPayload}
                onChange={(event) => setBenchPayload(event.target.value)}
                aria-label="Recorded multi-strategy comparison"
                placeholder="Paste a recorded multi-strategy comparison"
                required
              />
              <button className="login__submit" type="submit">
                Convert and import onto case
              </button>
            </form>
          </details>
        </details>
      ) : null}
      {error ? (
        <p className="experiment-lab__error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {experiments.length > 1 ? (
        <nav className="experiment-lab__experiments" aria-label="Comparisons on this investigation">
          <p className="experiment-lab__eyebrow">Comparisons on this investigation</p>
          <p className="experiment-lab__section-note">
            Newest first. {surface === "decision" ? "A decision" : "This workspace"} uses the newest
            comparison unless you pick an older one here.
          </p>
          <ul className="case-list__items">
            {newestFirst(experiments).map((row, position) => {
              // The number stays the recording order, so a comparison can be
              // named out loud and keep that name; the row order and the
              // marker carry recency instead.
              const ordinal = experiments.findIndex((item) => item.id === row.id) + 1;
              const latest = position === 0;
              const selected = row.id === current?.id;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    aria-pressed={selected}
                    onClick={() => selectExperiment(row.id)}
                  >
                    <span className="experiment-lab__experiment-name">
                      Comparison {ordinal}:{" "}
                      {candidateModelSummary(row.candidates) || "Unlabeled lanes"}
                    </span>
                    <span className="experiment-lab__experiment-meta">
                      {latest ? "Latest" : "Earlier"} · recorded {recordedAtLabel(row)} ·{" "}
                      {row.candidates.length} lane
                      {row.candidates.length === 1 ? "" : "s"}
                      {candidateRunSummary(row.candidates)
                        ? ` · ${candidateRunSummary(row.candidates)}`
                        : ""}
                    </span>
                    {!latest && selected ? (
                      <span className="experiment-lab__focus-flag">
                        You are reading an earlier comparison, not the latest one
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
      {current ? (
        <>
          <details className="experiment-lab__identity">
            <summary>Comparison provenance</summary>
            <p>
              Recorded package · reproducible task binding · exact frozen evidence binding
            </p>
          </details>
          {showComparison ? (
            <>
          <nav className="experiment-lab__workspace" aria-label="Compare workspace">
            <p className="experiment-lab__workspace-copy">
              Open one Compare workspace at a time. Each item is a real address you can copy or
              open in a new tab.
            </p>
            <ul className="experiment-lab__workspace-tabs">
              {COMPARE_WORKSPACE.map((item) => {
                const focus = routeFor(
                  item.section,
                  null,
                  focusedCandidate?.candidateId ?? null,
                );
                const active = workspaceSection === item.id;
                return (
                  <li key={item.id}>
                    <a
                      className={
                        active
                          ? "experiment-lab__workspace-tab is-active"
                          : "experiment-lab__workspace-tab"
                      }
                      href={hrefFor(focus)}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => {
                        if (isModifiedClick(event)) return;
                        event.preventDefault();
                        commitFocus(focus);
                      }}
                    >
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
            <div className="experiment-lab__focus" role="group" aria-label="Focus a lane">
              <span className="experiment-lab__focus-label">Focus a lane</span>
              <button
                type="button"
                className="experiment-lab__focus-chip"
                aria-pressed={focusedCandidate === null}
                onClick={() => selectLaneFocus(null)}
              >
                All lanes
              </button>
              {current.candidates.map((row) => (
                <button
                  key={row.candidateId}
                  type="button"
                  className="experiment-lab__focus-chip"
                  aria-pressed={focusedCandidate?.candidateId === row.candidateId}
                  onClick={() => {
                    const lane = focusedCandidate?.candidateId === row.candidateId
                      ? null
                      : row.candidateId;
                    selectLaneFocus(lane);
                  }}
                >
                  {row.modelLabel}
                </button>
              ))}
            </div>
            <p className="experiment-lab__focus-legend">
              Focus stays on this section and highlights matching cards, table columns, and review
              references in place. It never filters the other lanes, opens another panel, or
              changes the decision basis.
            </p>
            {focusedCandidate ? (
              <p className="experiment-lab__focus-status" role="status">
                Highlighting {focusedCandidate.modelLabel} in place. You stay in this section, and
                other lanes stay visible in the comparison, benchmark, and accepted decision.
              </p>
            ) : null}
          </nav>
          {workspaceSection === "summary" ? (
            <>
          <section className="experiment-lab__scan" aria-labelledby="scan-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Compare → Decide</p>
                <h4 id="scan-heading" className="experiment-lab__heading" tabIndex={-1}>At a glance</h4>
              </div>
              <span className="experiment-lab__section-kicker">Facts only · no winner implied</span>
            </div>
            <p className="experiment-lab__section-note">
              {current.candidates.length} candidate lane{current.candidates.length === 1 ? "" : "s"}
              {" · runs: "}
              {runFactsSummary || "none recorded"}. Read what agrees, what differs, and what stays
              unknown before the human decision.
              {scanNotes.length ? ` ${scanNotes.join(" ")}` : ""}
              {" "}
              Review queue, Evidence, Strategy paths, and Signals stay one workspace away.
            </p>
            <div className="experiment-lab__scorecards" aria-label="Experiment summary">
              <article>
                <span>Candidates</span>
                <strong>{current.candidates.length}</strong>
              </article>
              <article>
                <span>Shared evidence</span>
                <strong>{current.agreement.sharedAnchors.length}</strong>
              </article>
              <article>
                <span>Divergences</span>
                <strong>{divergenceCount}</strong>
              </article>
              <article>
                <span>Open questions</span>
                <strong>{caseUnknowns.length}</strong>
              </article>
              <article>
                <span>Human reviews</span>
                <strong>{current.observations.length}</strong>
              </article>
              <article>
                <span>Decision</span>
                <strong>
                  {latestDecision ? `${latestDecision.status} r${latestDecision.revision}` : "none yet"}
                </strong>
              </article>
              <article>
                <span>Benchmark</span>
                <strong>{current.gold ? `v${current.gold.version}` : "none yet"}</strong>
              </article>
            </div>
            <div className="experiment-lab__scan-grid">
              <article
                className="experiment-lab__scan-card experiment-lab__scan-card--findings"
                aria-labelledby="scan-findings-heading"
              >
                <h5 id="scan-findings-heading" className="experiment-lab__scan-title">
                  Investigative findings
                </h5>
                {humanFindings.length ? (
                  <ol className="experiment-lab__finding-list">
                    {humanFindings.map((finding) => (
                      <li key={finding.id} className="experiment-lab__finding">
                        <h6 className="experiment-lab__finding-title">{finding.headline}</h6>
                        <p className="experiment-lab__finding-source">
                          <strong>{finding.artifact.label}</strong> · {finding.artifact.source}
                        </p>
                        {finding.artifact.excerpt ? (
                          <ArtifactExcerpt
                            text={finding.artifact.excerpt}
                            label={finding.artifact.label}
                            copyable
                          />
                        ) : (
                          <p className="experiment-lab__artifact-missing" role="note">
                            Supporting excerpt not captured. {finding.artifact.context}
                          </p>
                        )}
                        <p><strong>What the models claim:</strong> {finding.claims}</p>
                        <p><strong>Why this matters:</strong> {finding.why}</p>
                        <p><strong>Next step:</strong> {finding.nextStep}</p>
                        {deepLink(
                          "Inspect supporting artifact",
                          "cross-exam-heading",
                          finding.id,
                          finding.candidateIds.length === 1 ? finding.candidateIds[0] : null,
                        )}
                        <details>
                          <summary>Technical details</summary>
                          <p>{finding.artifact.context}</p>
                        </details>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="experiment-lab__empty">
                    No evidence-level conflict, single-lane citation, or benchmark anchor is recorded.
                  </p>
                )}
                {goldConvergenceCount ? (
                  <p className="experiment-lab__scan-note">
                    {goldConvergenceCount} recorded citation{goldConvergenceCount === 1 ? "" : "s"} also
                    appear{goldConvergenceCount === 1 ? "s" : ""} in the human benchmark.
                  </p>
                ) : null}
                <p className="experiment-lab__scan-caveat">
                  Agreement is not proof of correctness; differences are leads to investigate.
                </p>
              </article>
              <article className="experiment-lab__scan-card" aria-labelledby="scan-unknown-heading">
                <h5 id="scan-unknown-heading" className="experiment-lab__scan-title">
                  What stays unknown
                </h5>
                {caseUnknowns.length ? (
                  <ul className="experiment-lab__scan-list">
                    {caseUnknowns.map((item) => (
                      <li key={item.text}>
                        {item.text} <small className="experiment-lab__finding-source">{item.source}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="experiment-lab__empty">
                    No case-specific open questions have been recorded yet. This does not mean the case is resolved.
                  </p>
                )}
                <p className="experiment-lab__scan-caveat">
                  Unknown stays unknown until evidence resolves it.
                </p>
                {runDetailGaps.length ? (
                  <details className="experiment-lab__run-details">
                    <summary>Run details and evaluation coverage ({runDetailGaps.length})</summary>
                    <ul className="experiment-lab__scan-list">
                      {runDetailGaps.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </article>
              <article className="experiment-lab__scan-card" aria-labelledby="scan-decided-heading">
                <h5 id="scan-decided-heading" className="experiment-lab__scan-title">
                  What a human decided
                </h5>
                {latestDecision ? (
                  <div className="experiment-lab__scan-decision">
                    <p className="experiment-lab__scan-decision-meta">
                      <span
                        className={`experiment-lab__badge experiment-lab__badge--${latestDecision.status}`}
                      >
                        {latestDecision.status}
                      </span>
                      <span>r{latestDecision.revision}</span>
                      {isRestoredAttribution(latestDecision.authorUsername) ? (
                        <span>restored history</span>
                      ) : null}
                    </p>
                    <p className="experiment-lab__scan-decision-text">“{latestDecision.text}”</p>
                    <p className="experiment-lab__scan-decision-rationale">
                      Why: {latestDecision.rationale}
                    </p>
                    <p className="experiment-lab__scan-decision-author">
                      Recorded by {attributionLabel(latestDecision.authorUsername)}
                      {" · owner "}{latestDecision.ownerUsername?.trim()
                        ? attributionLabel(latestDecision.ownerUsername)
                        : "Unassigned"}
                      {" · remaining unknowns "}{(latestDecision.remainingUnknowns ?? []).length}
                    </p>
                  </div>
                ) : (
                  <p className="experiment-lab__empty">No human decision has been proposed yet.</p>
                )}
                <p className="experiment-lab__scan-note">
                  {current.gold
                    ? `Gold benchmark v${current.gold.version} exists — a human benchmark, not a truth claim.`
                    : "No gold benchmark recorded."}
                </p>
                <p className="experiment-lab__scan-caveat">
                  Sharing beyond this room goes through the share-safe export only.
                </p>
              </article>
            </div>
          </section>
          <section
            className="experiment-lab__section experiment-lab__readiness"
            aria-labelledby="readiness-heading"
          >
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">War-room cockpit</p>
                <h4 id="readiness-heading" className="experiment-lab__heading" tabIndex={-1}>
                  Decision readiness
                </h4>
              </div>
              <span className="experiment-lab__section-kicker">Recorded state · you judge sufficiency</span>
            </div>
            <p className="experiment-lab__section-note">
              Eight facets of the record, stated as facts. Whether the record is sufficient for a
              decision is a human judgment — this panel only shows what is recorded and what stays
              unknown. The Review queue workspace lists everything that still needs human eyes.
            </p>
            {focusedCandidate ? (
              <article
                className="experiment-lab__focus-digest"
                aria-labelledby="focus-digest-heading"
              >
                <div className="experiment-lab__section-heading">
                  <div>
                    <p className="experiment-lab__eyebrow">Focused lane digest</p>
                    <h5 id="focus-digest-heading" className="experiment-lab__focus-digest-title" tabIndex={-1}>
                      {focusedCandidate.modelLabel}
                    </h5>
                  </div>
                  <button
                    type="button"
                    className="experiment-lab__focus-chip"
                    onClick={() => selectLaneFocus(null)}
                  >
                    Close lane inspection
                  </button>
                </div>
                <div className="experiment-lab__lane-digest-grid">
                  <article>
                    <h6 className="experiment-lab__card-title">Question or input</h6>
                    {focusedQuestion?.excerpt ? (
                      <ArtifactExcerpt text={focusedQuestion.excerpt} />
                    ) : (
                      <p className="experiment-lab__artifact-missing">
                        No question or starting input was captured for this lane.
                      </p>
                    )}
                  </article>
                  <article>
                    <h6 className="experiment-lab__card-title">Evidence it used</h6>
                    {focusedEvidence.length ? (
                      <ul>
                        {focusedEvidence.slice(0, 3).map((event) => (
                          <li key={event.eventId}>
                            <ArtifactExcerpt text={event.excerpt ?? ""} />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="experiment-lab__artifact-missing">
                        No source log, stack trace, or tool output was captured for this lane.
                      </p>
                    )}
                  </article>
                  <article>
                    <h6 className="experiment-lab__card-title">Latest recorded conclusion</h6>
                    {focusedConclusion?.excerpt ? (
                      <ArtifactExcerpt text={focusedConclusion.excerpt} />
                    ) : (
                      <p className="experiment-lab__artifact-missing">
                        No model conclusion was captured for this lane.
                      </p>
                    )}
                  </article>
                  <article>
                    <h6 className="experiment-lab__card-title">Still unknown</h6>
                    {focusedUnknowns.length ? (
                      <ul>
                        {focusedUnknowns.map((unknown) => (
                          <li key={unknown}>{readableUnknown(unknown)}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>No explicit unknowns were recorded. This is not proof that none remain.</p>
                    )}
                    <p>{focusQueueCount} review queue item{focusQueueCount === 1 ? "" : "s"} mention this lane.</p>
                  </article>
                </div>
                <details className="experiment-lab__focus-metadata">
                  <summary>Run measurements and benchmark state</summary>
                <dl className="experiment-lab__export-facts experiment-lab__focus-facts">
                  <div>
                    <dt>Run status</dt>
                    <dd>{focusedCandidate.runStatus}</dd>
                  </div>
                  <div>
                    <dt>Latency</dt>
                    <dd>{latencyLabel(focusedCandidate.observedLatency)}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>{focusedCandidate.cost.status}</dd>
                  </div>
                  <div>
                    <dt>Usage</dt>
                    <dd>{focusedCandidate.usage.status}</dd>
                  </div>
                  <div>
                    <dt>Helpfulness</dt>
                    <dd>{focusedCandidate.helpfulnessState}</dd>
                  </div>
                  <div>
                    <dt>Gold state</dt>
                    <dd>{focusedCandidate.goldState}</dd>
                  </div>
                </dl>
                </details>
                <section className="experiment-lab__lane-history" aria-label={`${focusedCandidate.modelLabel} lane history`}>
                  <details>
                    <summary>View full chronological lane history</summary>
                    {focusedEvents.length ? (
                      <ol>
                        {focusedEvents.map((event) => (
                          <li key={event.eventId}>
                            <p className="experiment-lab__lane-step">
                              <strong>{event.sequence}. {traceEventMeaning(event.kind)}</strong>
                              {event.authorUsername ? ` · ${event.authorUsername}` : ` · ${event.actor}`}
                            </p>
                            {event.excerpt ? (
                              <ArtifactExcerpt text={event.excerpt} />
                            ) : (
                              <p className="experiment-lab__artifact-missing" role="note">
                                Supporting excerpt not captured. Inspect or attach the source log,
                                stack trace, command output, or review note for this step.
                              </p>
                            )}
                            <details>
                              <summary>Technical details</summary>
                              <p>Recorded kind: {event.kind} · actor: {event.actor}</p>
                              <p>Timestamp and component were not captured by this trace.</p>
                              <p>
                                Evidence: {event.evidenceRefs.length
                                  ? event.evidenceRefs.map((evidenceRef) => supportingArtifact(
                                      current,
                                      evidenceRef,
                                      evidenceArtifacts,
                                      evidenceExcerpts,
                                    ).label).join(", ")
                                  : "none recorded"}
                              </p>
                            </details>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="experiment-lab__artifact-missing" role="note">
                        No chronological trace details were captured for this lane. Import the lane’s
                        prompts, evidence steps, analysis result, review feedback, and decision contribution
                        to make its history inspectable.
                      </p>
                    )}
                  </details>
                  {focusedObservations.length ? (
                    <div className="experiment-lab__lane-observations">
                      <h6 className="experiment-lab__card-title">Human observations</h6>
                      <ul>
                        {focusedObservations.map((observation) => (
                          <li key={observation.id}>
                            <strong>{observation.reviewerUsername}</strong>: {observation.rationale}
                            <span> · {observation.dimension} {observation.score}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="experiment-lab__artifact-missing">
                      No human review feedback is recorded for this lane. Add a helpfulness observation
                      after inspecting its supporting artifacts.
                    </p>
                  )}
                  <p>
                    Review queue entries naming this lane: {focusQueueCount} —{" "}
                    {deepLink("open the exact queue context", "review-queue-heading", null, focusedCandidate.candidateId)}
                  </p>
                  <details>
                    <summary>Lane evidence details</summary>
                    <p>
                      Evidence only this lane cites:{" "}
                      {current.agreement.candidateSpecific
                        .find((row) => row.candidateId === focusedCandidate.candidateId)
                        ?.evidenceRefs.map((evidenceRef) => supportingArtifact(
                          current,
                          evidenceRef,
                          evidenceArtifacts,
                          evidenceExcerpts,
                        ).label).join(", ") || "none recorded"}
                    </p>
                    <p>
                      Evidence with a recorded role conflict:{" "}
                      {current.agreement.roleConflicts
                        .filter((row) => row.assignments.some(
                          (assignment) => assignment.candidateId === focusedCandidate.candidateId,
                        ))
                        .map((row) => supportingArtifact(
                          current,
                          row.evidenceRef,
                          evidenceArtifacts,
                          evidenceExcerpts,
                        ).label)
                        .join(", ") || "none recorded"}
                    </p>
                  </details>
                  <p className="experiment-lab__scan-caveat">
                    Lane inspection restates recorded facts for one lane. It never changes the aggregate
                    comparison, benchmark, or accepted human decision.
                  </p>
                </section>
              </article>
            ) : null}
            <div className="experiment-lab__facets">
              {readinessFacets.map((facet) => (
                <article key={facet.id} className="experiment-lab__facet">
                  <h5 className="experiment-lab__facet-title">{facet.label}</h5>
                  <p className="experiment-lab__facet-state">{facet.state}</p>
                  <p className="experiment-lab__facet-queue">
                    {queuedByFacet(facet.id)
                      ? `${queuedByFacet(facet.id)} item${
                          queuedByFacet(facet.id) === 1 ? "" : "s"
                        } in the review queue`
                      : "nothing queued from this facet"}
                  </p>
                  <details className="experiment-lab__facet-details">
                    <summary>What this measures</summary>
                    <p>{facet.meaning}</p>
                    {deepLink(`Open ${facet.hrefLabel}`, facet.href.replace(/^#/, ""))}
                  </details>
                </article>
              ))}
            </div>
          </section>
            </>
          ) : null}
          {workspaceSection === "review-queue" ? (
          <section
            className="experiment-lab__section experiment-lab__queue"
            aria-labelledby="review-queue-heading"
          >
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Deterministic projection</p>
                <h4 id="review-queue-heading" className="experiment-lab__heading" tabIndex={-1}>
                  Human review queue
                </h4>
              </div>
              <span className="experiment-lab__section-kicker">Fixed order · not a priority ranking</span>
            </div>
            <p className="experiment-lab__section-note">
              Every entry restates a recorded conflict, gap, unknown, incomplete trace, missing
              observation, or decision state — grouped in a fixed category order. The same record
              always produces the same queue; nothing here is scored or ranked.
            </p>
            {reviewQueue.length ? (
              REVIEW_QUEUE_CATEGORIES.map((category) => {
                const items = reviewQueue.filter((item) => item.category === category);
                if (!items.length) return null;
                return (
                  <div key={category} className="experiment-lab__queue-group">
                    <h5 className="experiment-lab__queue-category">
                      {category}
                      <span className="experiment-lab__queue-count">
                        {items.length} item{items.length === 1 ? "" : "s"}
                      </span>
                    </h5>
                    <ol className="experiment-lab__queue-list">
                      {items.map((item) => {
                        const finding = item.evidenceRef
                          ? humanFindings.find((row) => row.id === item.evidenceRef)
                          : null;
                        const artifact = item.evidenceRef
                          ? finding?.artifact ?? supportingArtifact(
                            current,
                            item.evidenceRef,
                            evidenceArtifacts,
                            evidenceExcerpts,
                          )
                          : null;
                        const primary = finding?.headline ?? (item.evidenceRef
                          ? item.text.split(item.evidenceRef).join("this recorded evidence")
                          : visibleQueueText(item.text));
                        return (
                          <li
                            key={item.id}
                            className={
                              workspaceItem === (item.evidenceRef ?? item.id)
                                ? "experiment-lab__queue-item experiment-lab__route-target"
                                : "experiment-lab__queue-item"
                            }
                            data-route-item={
                              item.evidenceRef
                              ?? (item.candidateIds.length === 1 ? item.candidateIds[0] : item.id)
                            }
                            data-route-kind={
                              item.evidenceRef
                                ? "evidence"
                                : item.candidateIds.length === 1
                                  ? "lane"
                                  : undefined
                            }
                            tabIndex={-1}
                          >
                            <h6 className="experiment-lab__queue-text">{primary}</h6>
                            {artifact ? (
                              <>
                                <p className="experiment-lab__finding-source">
                                  <strong>{artifact.label}</strong> · {artifact.source}
                                </p>
                                {artifact.excerpt ? (
                                  <ArtifactExcerpt text={artifact.excerpt} label={artifact.label} copyable />
                                ) : (
                                  <p className="experiment-lab__artifact-missing" role="note">
                                    Supporting excerpt not captured. {artifact.context}
                                  </p>
                                )}
                              </>
                            ) : null}
                            {finding ? (
                              <>
                                <p><strong>What the models claim:</strong> {finding.claims}</p>
                                <p><strong>Why this matters:</strong> {finding.why}</p>
                                <p><strong>Next step:</strong> {finding.nextStep}</p>
                              </>
                            ) : (
                              <p>
                                <strong>Next step:</strong>{" "}
                                {REVIEW_QUEUE_NEXT_STEP[item.category]
                                  ?? "Open the recorded context and record what you find."}
                              </p>
                            )}
                            {deepLink(
                              item.hrefLabel,
                              item.href.replace(/^#/, ""),
                              // Address the resource the entry is about. The
                              // queue position was neither stable across
                              // record changes nor present on any target, so
                              // every link fell back to its section heading.
                              item.evidenceRef
                                ?? (item.candidateIds.length === 1 ? item.candidateIds[0]! : null),
                              item.candidateIds.length === 1 ? item.candidateIds[0] : null,
                              "experiment-lab__queue-link",
                            )}
                            {focusedCandidate && item.candidateIds.includes(focusedCandidate.candidateId) ? (
                              <span className="experiment-lab__focus-flag">involves focused lane</span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                );
              })
            ) : (
              <p className="experiment-lab__empty">
                The recorded facts list no open conflicts, gaps, or unknowns for this experiment.
                An empty queue does not certify correctness — it only means nothing further was
                recorded.
              </p>
            )}
          </section>
          ) : null}
          {workspaceSection === "summary" ? (
            <>
          <section className="experiment-lab__gold" aria-label="Gold reference">
            {current.gold ? (
              <>
                <h4 className="experiment-lab__heading">Gold reference v{current.gold.version}</h4>
                <p className="timeline__meta experiment-lab__gold-summary">
                  Human benchmark from accepted decision{" "}
                  {acceptedDecision && acceptedDecision.id === current.gold.acceptedDecisionId
                    ? `“${truncateText(acceptedDecision.text)}” (r${current.gold.acceptedDecisionRevision})`
                    : `record unavailable in this view (r${current.gold.acceptedDecisionRevision})`}
                  , promoted by {current.gold.promotedByUsername}. Evidence:{" "}
                  {current.gold.evidenceAnchors.length} benchmark anchor
                  {current.gold.evidenceAnchors.length === 1 ? "" : "s"}.
                </p>
                <details className="experiment-lab__technical-details">
                  <summary>Benchmark evidence details</summary>
                  <p>
                    Accepted decision: {acceptedDecision && acceptedDecision.id === current.gold.acceptedDecisionId
                      ? `“${truncateText(acceptedDecision.text)}” (r${current.gold.acceptedDecisionRevision})`
                      : `record unavailable in this view (r${current.gold.acceptedDecisionRevision})`}
                  </p>
                  <p>
                    Evidence anchors:{" "}
                    {current.gold.evidenceAnchors.map((evidenceRef) => supportingArtifact(
                      current,
                      evidenceRef,
                      evidenceArtifacts,
                      evidenceExcerpts,
                    ).label).join(", ") || "none recorded"}
                  </p>
                </details>
                <p className="experiment-lab__disclaimer">
                  A gold reference is a human benchmark decision, not an infallible truth claim.
                  Gold alignment is not a correctness verdict.
                </p>
              </>
            ) : (
              <p className="timeline__meta">
                No gold reference. Gold state stays unknown or absent until a case-lead promotes
                an accepted decision.
              </p>
            )}
          </section>
          <section className="experiment-lab__section" aria-labelledby="candidate-comparison-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Step 1 · Model / method lanes</p>
                <h4 id="candidate-comparison-heading" className="experiment-lab__heading" tabIndex={-1}>
                  Candidate comparison
                </h4>
              </div>
              <span className="experiment-lab__section-kicker">Observed + human signals</span>
            </div>
            <p className="experiment-lab__section-note">
              Recorded run facts are shown beside separate helpfulness and gold signals. Entirely
              unreported measurements stay in the collapsed run details instead of filling this
              table with noise.
            </p>
          <div className="experiment-lab__matrix-wrap">
            <table className="experiment-lab__matrix">
              <caption>Candidate comparison — observed run facts and review signals</caption>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  {showLatencyColumn ? <th scope="col">Latency</th> : null}
                  {showCostColumn ? <th scope="col">Cost</th> : null}
                  {showUsageColumn ? <th scope="col">Usage</th> : null}
                  <th scope="col">Helpfulness</th>
                  <th scope="col">Gold</th>
                </tr>
              </thead>
              <tbody>
                {current.candidates.map((row) => (
                  <tr
                    key={row.candidateId}
                    data-route-lane={row.candidateId}
                    data-route-item={row.candidateId}
                    data-route-kind="lane"
                    tabIndex={-1}
                    className={
                      focusedCandidate?.candidateId === row.candidateId
                        ? "experiment-lab__matrix-row--focused"
                        : undefined
                    }
                  >
                    <th scope="row">
                      {row.modelLabel}
                      {focusedCandidate?.candidateId === row.candidateId ? (
                        <span className="experiment-lab__focus-flag">focused</span>
                      ) : null}
                    </th>
                    <td>{row.role}</td>
                    <td>{row.runStatus}</td>
                    {showLatencyColumn ? <td>{latencyLabel(row.observedLatency)}</td> : null}
                    {showCostColumn ? <td>{row.cost.status}</td> : null}
                    {showUsageColumn ? <td>{row.usage.status}</td> : null}
                    <td>{row.helpfulnessState}</td>
                    <td>{row.goldState}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </section>
            </>
          ) : null}
          {workspaceSection === "evidence" ? (
          <section className="experiment-lab__section" aria-labelledby="evidence-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Step 2 · Evidence map</p>
                <h4 id="evidence-heading" className="experiment-lab__heading" tabIndex={-1}>
                  Shared and different evidence
                </h4>
              </div>
              <span className="experiment-lab__section-kicker">Agreement is not correctness</span>
            </div>
            <p className="experiment-lab__section-note">{current.agreement.notes.join(" ")}</p>
            <div className="experiment-lab__evidence-grid">
              <div className="experiment-lab__evidence-card">
                <h5>Shared evidence</h5>
                {current.agreement.sharedAnchors.length ? (
                  <ul className="experiment-lab__detail-list">
                    {current.agreement.sharedAnchors.map((anchor) => {
                      const artifact = supportingArtifact(
                        current,
                        anchor.evidenceRef,
                        evidenceArtifacts,
                        evidenceExcerpts,
                      );
                      return (
                        <li key={`${anchor.evidenceRef}:${anchor.role}`}>
                          <strong>{artifact.label}</strong> — shared supporting evidence treated as {anchor.role} by {" "}
                          {anchor.candidateIds.map(candidateLabel).join(", ")}.
                          {deepLink(" Inspect artifact", "cross-exam-heading", anchor.evidenceRef)}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="experiment-lab__empty">No shared evidence recorded.</p>
                )}
              </div>
              <div className="experiment-lab__evidence-card">
                <h5>Different evidence</h5>
                {current.agreement.candidateSpecific.length || current.agreement.roleConflicts.length ? (
                  <ul className="experiment-lab__detail-list">
                    {current.agreement.candidateSpecific.map((row) => (
                      <li key={row.candidateId}>
                        {row.evidenceRefs.length ? (
                          <>
                            <strong>{candidateLabel(row.candidateId)} uses evidence no other lane cites.</strong>{" "}
                            Inspect and corroborate it before relying on the lane.
                          </>
                        ) : (
                          // An empty reference list is a gap in the record, not
                          // uncorroborated evidence. Claiming unique evidence
                          // and then reporting none contradicts itself.
                          <>
                            <strong>
                              {candidateLabel(row.candidateId)} is listed as citing evidence no other
                              lane cites, but no evidence reference was recorded for it.
                            </strong>{" "}
                            There is nothing here to inspect; treat the lane as uncorroborated until
                            a reference is attached.
                          </>
                        )}
                        {row.evidenceRefs.length ? (
                          <ul className="experiment-lab__detail-list">
                            {row.evidenceRefs.map((evidenceRef) => {
                              const artifact = supportingArtifact(
                                current,
                                evidenceRef,
                                evidenceArtifacts,
                                evidenceExcerpts,
                              );
                              return (
                                <li key={evidenceRef}>
                                  <strong>{artifact.label}</strong>
                                  {deepLink(" Inspect artifact", "cross-exam-heading", evidenceRef, row.candidateId)}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                    {current.agreement.roleConflicts.map((row) => {
                      const artifact = supportingArtifact(
                        current,
                        row.evidenceRef,
                        evidenceArtifacts,
                        evidenceExcerpts,
                      );
                      return (
                        <li key={row.evidenceRef}>
                          <strong>Models assign different meaning to {artifact.label}:</strong>{" "}
                          {row.assignments.map((a) => `${candidateLabel(a.candidateId)} treats it as ${a.role}`).join("; ")}
                          {deepLink(" Inspect artifact", "cross-exam-heading", row.evidenceRef)}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="experiment-lab__empty">No candidate-specific evidence recorded.</p>
                )}
              </div>
            </div>
            <div className="experiment-lab__crossexam-block">
              <h5 id="cross-exam-heading" className="experiment-lab__subheading experiment-lab__heading" tabIndex={-1}>
                Evidence cross-examination
              </h5>
              <p className="experiment-lab__section-note">
                Every recorded evidence reference, cross-examined lane by lane: who cites it, in
                what recorded role, how it relates to the benchmark anchors, and how far each
                lane&apos;s trace can vouch for it. Absence of a record is stated as “not
                recorded”, never assumed to mean the lane ignored it.
              </p>
              <details className="experiment-lab__tools experiment-lab__crossexam-legend">
                <summary>How to read this table</summary>
                <ul className="experiment-lab__detail-list">
                  <li>
                    <span aria-hidden="true">●</span> cited — the lane&apos;s recorded citations
                    include this evidence, with the recorded role when one exists.
                  </li>
                  <li>
                    <span aria-hidden="true">○</span> not recorded — the record lists no citation
                    of this evidence by that lane. Absence of a record is not proof the lane
                    ignored it.
                  </li>
                  <li>
                    The benchmark column states whether the reference is an anchor of the recorded
                    gold benchmark — a human benchmark decision, not a truth claim. Without a
                    benchmark it stays unknown.
                  </li>
                  <li>
                    Trace coverage counts how many cross-examined references appear in each
                    lane&apos;s recorded trace events. Partial or missing traces leave the rest
                    unknown.
                  </li>
                </ul>
              </details>
              {crossRows.length ? (
                /* Deliberately NOT experiment-lab__matrix / __matrix-wrap: the
                   browser qualification suite strict-locates those classes and
                   must keep resolving to exactly one candidate matrix. */
                <div className="experiment-lab__crossexam-wrap">
                  <table className="experiment-lab__crossexam">
                    <caption>
                      Evidence cross-examination — recorded citations, benchmark anchors, and trace
                      coverage
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Evidence</th>
                        {current.candidates.map((row) => (
                          <th
                            scope="col"
                            key={row.candidateId}
                            className={
                              focusedCandidate?.candidateId === row.candidateId
                                ? "experiment-lab__crossexam-col--focused"
                                : undefined
                            }
                          >
                            {row.modelLabel}
                            {focusedCandidate?.candidateId === row.candidateId ? (
                              <span className="experiment-lab__focus-flag">focused</span>
                            ) : null}
                          </th>
                        ))}
                        <th scope="col">Benchmark anchor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {crossRows.map((row) => {
                        const artifact = supportingArtifact(
                          current,
                          row.evidenceRef,
                          evidenceArtifacts,
                          evidenceExcerpts,
                        );
                        const finding = humanFindings.find((item) => item.id === row.evidenceRef);
                        return (
                        <tr
                          key={row.evidenceRef}
                          data-route-item={row.evidenceRef}
                          data-route-kind="evidence"
                          tabIndex={-1}
                          className={workspaceItem === row.evidenceRef ? "experiment-lab__route-target" : undefined}
                        >
                          <th scope="row">
                            <strong>{finding?.headline ?? artifact.label}</strong>
                            <span className="experiment-lab__crossexam-source">{artifact.source}</span>
                            {artifact.excerpt ? (
                              <ArtifactExcerpt text={artifact.excerpt} label={artifact.label} copyable />
                            ) : (
                              <span className="experiment-lab__artifact-missing">
                                Supporting excerpt not captured. Inspect or attach the source artifact.
                              </span>
                            )}
                            {row.conflict ? (
                              <span className="experiment-lab__crossexam-badge experiment-lab__crossexam-badge--conflict">
                                role conflict
                              </span>
                            ) : null}
                            {row.singleLane ? (
                              <span className="experiment-lab__crossexam-badge">single lane</span>
                            ) : null}
                            {row.uncitedAnchor ? (
                              <span className="experiment-lab__crossexam-badge">
                                anchor no lane cites
                              </span>
                            ) : null}
                          </th>
                          {current.candidates.map((candidate) => {
                            const cell = row.cells[candidate.candidateId];
                            return (
                              <td
                                key={candidate.candidateId}
                                className={
                                  focusedCandidate?.candidateId === candidate.candidateId
                                    ? "experiment-lab__crossexam-col--focused"
                                    : undefined
                                }
                              >
                                {cell?.recorded ? (
                                  <>
                                    <span className="experiment-lab__crossexam-mark" aria-hidden="true">
                                      ●
                                    </span>{" "}
                                    cited
                                    {cell.roles.length
                                      ? ` as ${cell.roles.join(", ")}`
                                      : " — role not recorded"}
                                    {cell.matchedGold ? (
                                      <small>matches a benchmark anchor</small>
                                    ) : null}
                                    {cell.extraGold ? (
                                      <small>outside the benchmark anchors</small>
                                    ) : null}
                                    {cell.benchmarkRoleDiffers ? (
                                      <small>
                                        benchmark records a different relationship
                                      </small>
                                    ) : null}
                                  </>
                                ) : (
                                  <>
                                    <span className="experiment-lab__crossexam-mark" aria-hidden="true">
                                      ○
                                    </span>{" "}
                                    not recorded
                                    {cell?.missingGold ? (
                                      <small>benchmark anchor this lane does not cite</small>
                                    ) : null}
                                  </>
                                )}
                              </td>
                            );
                          })}
                          <td>
                            {row.inGold === null
                              ? "unknown — no benchmark recorded"
                              : row.inGold
                                ? "anchor"
                                : "not an anchor"}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Trace coverage</th>
                        {traceCoverage.map((fact) => (
                          <td
                            key={fact.candidateId}
                            className={
                              focusedCandidate?.candidateId === fact.candidateId
                                ? "experiment-lab__crossexam-col--focused"
                                : undefined
                            }
                          >
                            {traceCoverageLabel(fact)}
                          </td>
                        ))}
                        <td>not applicable</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="experiment-lab__empty">
                  No evidence citations are recorded for this experiment yet.
                </p>
              )}
            </div>
          </section>
          ) : null}
          {workspaceSection === "strategy" ? (
            <>
          <section className="experiment-lab__section" aria-labelledby="strategy-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Step 3 · Strategy lanes</p>
                <h4 id="strategy-heading" className="experiment-lab__heading" tabIndex={-1}>Strategy comparison</h4>
              </div>
              <span className="experiment-lab__section-kicker">Path view</span>
            </div>
            <p className="experiment-lab__disclaimer">
              Textual similarity is not a winner. Ambiguous transcript structure stays unknown.
              Gold alignment and helpfulness stay independent of this projection.
            </p>
            <p className="timeline__meta experiment-lab__strategy-benchmark-summary">
              Gold {current.comparison?.gold.status ?? "unknown"}
              {current.comparison?.gold.acceptedDecisionId
                ? acceptedDecision && acceptedDecision.id === current.comparison.gold.acceptedDecisionId
                  ? ` · accepted decision (r${acceptedDecision.revision}): “${truncateText(acceptedDecision.text)}”`
                  : " · accepted decision record unavailable in this view"
                : " · no accepted gold decision"}
              {" · "}
              Helpfulness {current.candidates.map((row) => `${row.modelLabel}:${row.helpfulnessState}`).join(", ")}
            </p>
            <div className="experiment-lab__signal-groups">
              {(current.comparison?.questionPaths ?? []).length ? (
                <div className="experiment-lab__signal-group">
                  <h6 className="experiment-lab__card-title">Questions asked</h6>
                  <ul className="experiment-lab__signal-list">
                    {(current.comparison?.questionPaths ?? []).map((path) => (
                      <li key={path.pathId} className="timeline__item">
                        Question path: {path.excerpt ?? "unknown"} (
                        {path.candidateIds.map(candidateLabel).join(", ")})
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {(current.comparison?.sharedEvidence ?? []).length ||
              (current.comparison?.uniqueEvidence ?? []).some((row) => row.evidenceRefs.length) ? (
                <div className="experiment-lab__signal-group">
                  <h6 className="experiment-lab__card-title">Evidence overlap</h6>
                  <ul className="experiment-lab__signal-list">
                    {(current.comparison?.sharedEvidence ?? []).map((row) => (
                      <li key={`shared-${row.evidenceRef}`} className="timeline__item">
                        Shared supporting evidence ({row.candidateIds.map(candidateLabel).join(", ")}).
                        {deepLink(" Inspect artifact", "cross-exam-heading", row.evidenceRef)}
                      </li>
                    ))}
                    {(current.comparison?.uniqueEvidence ?? []).map((row) =>
                      row.evidenceRefs.length ? (
                        <li key={`unique-${row.candidateId}`} className="timeline__item">
                          {candidateLabel(row.candidateId)} uses evidence no other lane cites.
                          {row.evidenceRefs[0]
                            ? deepLink(" Inspect artifact", "cross-exam-heading", row.evidenceRefs[0], row.candidateId)
                            : null}
                        </li>
                      ) : null,
                    )}
                  </ul>
                </div>
              ) : null}
              {(current.comparison?.divergence ?? []).length ? (
                <div className="experiment-lab__signal-group">
                  <h6 className="experiment-lab__card-title">Where the strategies disagree</h6>
                  <ul className="experiment-lab__signal-list">
                    {(current.comparison?.divergence ?? []).map((row) => (
                      <li key={`${row.kind}:${row.summary}`} className="timeline__item">
                        Divergence ({row.kind}): {readableSummary(row.summary)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {(current.comparison?.convergence ?? []).some((row) => row.inGold) ? (
                <div className="experiment-lab__signal-group">
                  <h6 className="experiment-lab__card-title">Convergence on the human benchmark</h6>
                  <ul className="experiment-lab__signal-list">
                    {(current.comparison?.convergence ?? [])
                      .filter((row) => row.inGold)
                      .map((row) => (
                        <li key={`gold-${row.evidenceRef}`} className="timeline__item">
                          Models converge on supporting evidence in the human benchmark.
                          {deepLink(" Inspect artifact", "cross-exam-heading", row.evidenceRef)}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <h5 className="experiment-lab__subheading">Strategy paths</h5>
            <div className="experiment-lab__paths">
              {(current.traces ?? []).map((trace) => (
                <article
                  key={trace.candidateId}
                  data-route-lane={trace.candidateId}
                  data-route-item={trace.candidateId}
                  data-route-kind="lane"
                  tabIndex={-1}
                  className={
                    focusedCandidate?.candidateId === trace.candidateId
                      ? "experiment-lab__path experiment-lab__path--focused"
                      : "experiment-lab__path"
                  }
                >
                  <header className="experiment-lab__path-header">
                    <div>
                      <p className="experiment-lab__eyebrow">Candidate path</p>
                      {focusedCandidate?.candidateId === trace.candidateId ? (
                        <span className="experiment-lab__focus-flag">focused</span>
                      ) : null}
                      <h5 className="experiment-lab__path-title">{candidateLabel(trace.candidateId)}</h5>
                    </div>
                    <span
                      className={
                        trace.completeness === "exact"
                          ? "experiment-lab__path-kind"
                          : "experiment-lab__path-kind experiment-lab__path-kind--incomplete"
                      }
                    >
                      {TRACE_SOURCE_LABELS[trace.sourceKind] ?? trace.sourceKind} ·{" "}
                      {TRACE_COMPLETENESS_LABELS[trace.completeness] ?? trace.completeness}
                    </span>
                  </header>
                  <p className="experiment-lab__path-meta">
                    turns {trace.efficiency.turnCount.status === "observed" ? trace.efficiency.turnCount.count : "unknown"}
                    {" · "}
                    evidence steps{" "}
                    {trace.efficiency.evidenceAcquisitionSteps.status === "observed"
                      ? trace.efficiency.evidenceAcquisitionSteps.count
                      : "unknown"}
                    {/* Cost and usage are reported once, in the readiness facet and
                        the run details. Repeating "cost unknown" on every lane
                        card adds a word a reader has to skip, not a fact. */}
                    {trace.unknowns.length
                      ? ` · not recorded: ${trace.unknowns.map(readableUnknown).join(", ")}`
                      : ""}
                  </p>
                  <ol className="experiment-lab__path-events">
                    {trace.events.map((event) => (
                      <li key={event.eventId}>
                        <strong>{traceEventMeaning(event.kind)}</strong>
                        <span> · {actorMeaning(event.actor, event.authorUsername)}</span>
                        {event.excerpt ? (
                          <ArtifactExcerpt text={event.excerpt} />
                        ) : (
                          <p className="experiment-lab__artifact-missing" role="note">
                            Supporting excerpt not captured. Inspect or attach the input, log context,
                            stack trace, or review note used at this step.
                          </p>
                        )}
                        <details>
                          <summary>Trace details</summary>
                          <p>
                            Step {event.sequence} · {traceEventMeaning(event.kind)} ·{" "}
                            {actorMeaning(event.actor, event.authorUsername)}
                          </p>
                          <p className="case-memory__note">
                            Recorded in this transcript as “{event.kind}” by “{event.actor}”.
                          </p>
                          {event.evidenceRefs.length ? (
                            <p>
                              Evidence: {event.evidenceRefs.map((evidenceRef) => supportingArtifact(
                                current,
                                evidenceRef,
                                evidenceArtifacts,
                                evidenceExcerpts,
                              ).label).join(", ")}
                            </p>
                          ) : null}
                        </details>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          </section>
          {canWrite ? (
            <details className="experiment-lab__tools">
              <summary>Add a chat transcript or interaction trace</summary>
              <form className="composer" onSubmit={(event) => void importTrace(event)}>
                <textarea
                  className="login__input"
                  name="trace"
                  rows={4}
                  aria-label="Interaction trace or plain transcript JSON"
                  placeholder="Paste interaction trace or plain transcript JSON"
                  required
                />
                <button className="login__submit" type="submit">
                  Import trace
                </button>
              </form>
            </details>
          ) : null}
          {canWrite && (current.traces ?? []).length > 0 ? (
            <details className="experiment-lab__tools">
              <summary>Annotate a strategy path</summary>
              <form className="composer" onSubmit={(event) => void annotateTrace(event)}>
                <select
                  className="login__input"
                  name="candidateId"
                  aria-label="Strategy path to annotate"
                  defaultValue={current.traces[0]?.candidateId}
                >
                  {current.traces.map((trace) => (
                    <option key={trace.candidateId} value={trace.candidateId}>
                      {candidateLabel(trace.candidateId)}
                    </option>
                  ))}
                </select>
                <input className="login__input" name="evidenceRefs" placeholder="evidence refs, comma separated" />
                <textarea className="login__input" name="text" rows={2} required aria-label="Human annotation" placeholder="Human annotation" />
                <button className="login__submit" type="submit">
                  Annotate trace
                </button>
              </form>
            </details>
          ) : null}
            </>
          ) : null}
          {workspaceSection === "signals" ? (
            <>
          <section className="experiment-lab__section" aria-labelledby="helpfulness-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Step 4 · Reviewer signals</p>
                <h4 id="helpfulness-heading" className="experiment-lab__heading" tabIndex={-1}>Helpfulness</h4>
              </div>
              <span className="experiment-lab__section-kicker">Separate from gold</span>
            </div>
            <p className="experiment-lab__section-note">
              Human helpfulness observations describe response usefulness and do not make live-provider claims.
            </p>
            {canWrite ? (
              <details className="experiment-lab__tools">
                <summary>Score candidate helpfulness</summary>
                <form className="composer" onSubmit={(event) => void recordHelpfulness(event)}>
                  <select
                    className="login__input"
                    name="candidateId"
                    aria-label="Candidate to score"
                    defaultValue={current.candidates[0]?.candidateId}
                  >
                    {current.candidates.map((row) => (
                      <option key={row.candidateId} value={row.candidateId}>
                        {row.modelLabel}
                      </option>
                    ))}
                  </select>
                  <select
                    className="login__input"
                    name="dimension"
                    aria-label="Helpfulness dimension"
                    defaultValue="evidence_support"
                  >
                    <option value="evidence_support">evidence support</option>
                    <option value="actionability">actionability</option>
                    <option value="uncertainty_calibration">uncertainty calibration</option>
                    <option value="unsafe_unsupported_claims">unsafe unsupported claims</option>
                  </select>
                  <input
                    className="login__input"
                    name="score"
                    type="number"
                    min={0}
                    max={3}
                    defaultValue={2}
                    required
                    aria-label="Helpfulness score from 0 to 3"
                  />
                  <EvidencePicker
                    view={current}
                    artifacts={evidenceArtifacts}
                    legend="Evidence supporting this helpfulness review (optional)"
                  />
                  <textarea className="login__input" name="rationale" rows={2} required aria-label="Helpfulness rationale" placeholder="Helpfulness rationale" />
                  <button className="login__submit" type="submit">
                    Record helpfulness
                  </button>
                </form>
              </details>
            ) : null}
          <ul className="experiment-lab__detail-list">
            {current.observations.map((row) => (
              <li key={row.id} className="timeline__item">
                Helpfulness: {row.reviewerUsername} scored {candidateLabel(row.candidateId)}{" "}
                {row.dimension.replaceAll("_", " ")} {row.score}/3: {row.rationale}
              </li>
            ))}
          </ul>
          </section>
          <section className="experiment-lab__section" aria-labelledby="gold-alignment-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Step 5 · Benchmark signal</p>
                <h4 id="gold-alignment-heading" className="experiment-lab__heading" tabIndex={-1}>Gold alignment</h4>
              </div>
              <span className="experiment-lab__section-kicker">Independent signal</span>
            </div>
          <p className="timeline__meta">
            Separate from helpfulness scores. Gold alignment is not a correctness verdict.
          </p>
          <ul className="timeline">
            {(current.alignments ?? []).map((row) => (
              <li
                key={row.candidateId}
                className="timeline__item"
                data-route-item={row.candidateId}
                data-route-kind="lane"
                tabIndex={-1}
              >
                <span className="experiment-lab__alignment-summary">
                  {candidateLabel(row.candidateId)}: {ALIGNMENT_STATUS_LABELS[row.status] ?? row.status}
                  {row.matchedAnchors.length
                    ? ` · matched ${row.matchedAnchors.length} benchmark anchor${row.matchedAnchors.length === 1 ? "" : "s"}`
                    : ""}
                  {row.missingAnchors.length
                    ? ` · missing ${row.missingAnchors.length} benchmark anchor${row.missingAnchors.length === 1 ? "" : "s"}`
                    : ""}
                  {row.extraAnchors.length
                    ? ` · ${row.extraAnchors.length} citation${row.extraAnchors.length === 1 ? "" : "s"} beyond the benchmark`
                    : ""}
                  {(row.roleMismatches ?? []).length
                    ? ` · role differs on ${(row.roleMismatches ?? []).length} benchmark anchor${(row.roleMismatches ?? []).length === 1 ? "" : "s"}`
                    : ""}
                </span>
                {row.matchedAnchors.length || row.missingAnchors.length || row.extraAnchors.length || (row.roleMismatches ?? []).length ? (
                  <details className="experiment-lab__technical-details">
                    <summary>Alignment evidence details</summary>
                    {row.matchedAnchors.length ? <p>Matched: {row.matchedAnchors.map((evidenceRef) => supportingArtifact(current, evidenceRef, evidenceArtifacts, evidenceExcerpts).label).join(", ")}</p> : null}
                    {row.missingAnchors.length ? <p>Missing: {row.missingAnchors.map((evidenceRef) => supportingArtifact(current, evidenceRef, evidenceArtifacts, evidenceExcerpts).label).join(", ")}</p> : null}
                    {row.extraAnchors.length ? <p>Beyond benchmark: {row.extraAnchors.map((evidenceRef) => supportingArtifact(current, evidenceRef, evidenceArtifacts, evidenceExcerpts).label).join(", ")}</p> : null}
                    {(row.roleMismatches ?? []).length ? (
                      <p>
                        Role differences:{" "}
                        {(row.roleMismatches ?? [])
                          .map((mismatch) => `${supportingArtifact(current, mismatch.evidenceRef, evidenceArtifacts, evidenceExcerpts).label} (${mismatch.role})`)
                          .join(", ")}
                      </p>
                    ) : null}
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          </section>
            </>
          ) : null}
            </>
          ) : null}
          {showDecision ? (
            <>
          <section className="experiment-lab__section" aria-labelledby="decision-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Step 6 · Human adjudication</p>
                <h4 id="decision-heading" className="experiment-lab__heading" tabIndex={-1}>Accepted decision</h4>
              </div>
              <span className="experiment-lab__section-kicker">
                {current.decisions.at(-1)?.status ?? "awaiting proposal"}
              </span>
            </div>
            <p className="experiment-lab__section-note">
              {isRestoredAttribution(latestDecision?.authorUsername)
                ? "This decision was restored as historical record. It is not attributed as a new action by the mapped destination user."
                : "Decision revisions and gold promotion remain server-recorded and attributable to the signed-in participant."}
            </p>
          {canWrite ? (
            <details className="experiment-lab__tools">
              <summary>Propose a new human decision</summary>
              <form className="composer" onSubmit={(event) => void proposeDecision(event)}>
                <textarea className="login__input" name="text" rows={2} required aria-label="Proposed decision" placeholder="Proposed decision" />
                <textarea className="login__input" name="rationale" rows={2} required aria-label="Decision rationale" placeholder="Decision rationale" />
                <label>
                  <span>Decision owner</span>
                  <select className="login__input" name="ownerAssignment" defaultValue="unassigned">
                    <option value="unassigned">Unassigned</option>
                    <option value="self">Assign to me ({participantName})</option>
                  </select>
                </label>
                <label>
                  <span>Remaining unknowns or open questions</span>
                  <textarea
                    className="login__input"
                    name="remainingUnknowns"
                    rows={3}
                    placeholder={"One open question per line\nWhat evidence would resolve it?"}
                  />
                </label>
                <EvidencePicker
                  view={current}
                  artifacts={evidenceArtifacts}
                  legend="Evidence supporting this decision (optional)"
                />
                <button className="login__submit" type="submit">
                  Propose decision
                </button>
              </form>
            </details>
          ) : null}
          {current.decisions.length > 0 ? (
            <div className="experiment-lab__decision-card">
              <p className="experiment-lab__decision-line">
                Latest decision r{current.decisions.at(-1)?.revision} ({current.decisions.at(-1)?.status}):{" "}
                {current.decisions.at(-1)?.text}
              </p>
              <p className="experiment-lab__decision-rationale">
                Rationale: {current.decisions.at(-1)?.rationale}
              </p>
              <p className="experiment-lab__decision-author">
                Recorded by {attributionLabel(latestDecision?.authorUsername)}
              </p>
              <p className="experiment-lab__decision-author">
                Decision owner: {latestDecision?.ownerUsername?.trim()
                  ? attributionLabel(latestDecision.ownerUsername)
                  : "Unassigned"}
              </p>
              {(current.decisions.at(-1)?.remainingUnknowns ?? []).length ? (
                <div className="experiment-lab__decision-unknowns">
                  <strong>Remaining unknowns</strong>
                  <ul>
                    {(current.decisions.at(-1)?.remainingUnknowns ?? []).map((unknown) => (
                      <li key={unknown}>{unknown}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="experiment-lab__decision-author">Remaining unknowns: none recorded</p>
              )}
            </div>
          ) : (
            <p className="experiment-lab__empty">
              No decision has been proposed for this experiment yet.
            </p>
          )}
          {current.decisions.length > 1 ? (
            <details className="experiment-lab__tools">
              <summary>Decision history ({current.decisions.length} revisions)</summary>
              <ol className="experiment-lab__decision-history">
                {current.decisions.map((row) => (
                  <li key={row.id}>
                    r{row.revision} · {row.status} — “{row.text}” · why: {row.rationale} · by{" "}
                    {row.authorUsername ?? "identity unavailable in this view"} · owner{" "}
                    {row.ownerUsername?.trim() || "Unassigned"} · remaining unknowns{" "}
                    {(row.remainingUnknowns ?? []).length}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {canLead && current.decisions.at(-1)?.status === "proposed" ? (
            <details className="experiment-lab__tools">
              <summary>Accept the proposed decision</summary>
              <p className="experiment-lab__section-note">
                Accepting records revision {current.decisions.at(-1)?.revision} as the human
                decision for this experiment. The server enforces the revision guard; a stale
                acceptance is rejected, not merged.
              </p>
              <button className="login__submit" type="button" onClick={() => void acceptDecision()}>
                Accept decision
              </button>
            </details>
          ) : null}
          {canLead && current.decisions.some((row) => row.status === "accepted") ? (
            <details className="experiment-lab__tools">
              <summary>Version the human benchmark</summary>
              <form className="composer" onSubmit={(event) => void promoteGold(event)}>
                <EvidencePicker
                  view={current}
                  artifacts={evidenceArtifacts}
                  legend="Evidence anchors for this human benchmark"
                  roles
                />
                <input
                  className="login__input"
                  name="helpfulnessDimensions"
                  placeholder="optional helpfulness dimensions, comma separated"
                />
                {current.gold ? (
                  <input
                    className="login__input"
                    name="expectedGoldVersion"
                    type="number"
                    min={1}
                    defaultValue={current.gold.version}
                    aria-label="expected gold version"
                  />
                ) : null}
                <button className="login__submit" type="submit">
                  Promote accepted decision to gold
                </button>
              </form>
            </details>
          ) : null}
          </section>
          {canExport ? (
            <section className="experiment-lab__export" aria-labelledby="export-heading">
              <div className="experiment-lab__export-action">
                <div>
                  <p className="experiment-lab__eyebrow">Step 7 · Share boundary</p>
                  <h4 id="export-heading" className="experiment-lab__heading" tabIndex={-1}>Export review</h4>
                </div>
                <button className="login__submit" type="button" onClick={() => void exportReview()}>
                  Export share-safe review
                </button>
              </div>
              {exported ? (
                <div className="experiment-lab__export-result" aria-live="polite">
                  <div className="experiment-lab__section-heading">
                    <div>
                      <p className="experiment-lab__eyebrow">Ready to share</p>
                      <h5 className="experiment-lab__export-title">Share-safe export ready</h5>
                    </div>
                    <span className="experiment-lab__privacy-badge">{exported.privacyClass ?? "share_safe"}</span>
                  </div>
                  <p className="experiment-lab__section-note">
                    A concise privacy-safe summary is shown by default. The raw export stays hidden until you choose to view it.
                  </p>
                  <dl className="experiment-lab__export-facts">
                    <div>
                      <dt>Coverage</dt>
                      <dd>
                        {typeof exported.review?.candidates?.length === "number"
                          ? `${exported.review.candidates.length} candidate${exported.review.candidates.length === 1 ? "" : "s"}`
                          : "Not listed in this export"}
                      </dd>
                    </div>
                    <div>
                      <dt>Decision</dt>
                      <dd>
                        {exported.review?.decision
                          ? `${exported.review.decision.status ?? "recorded"}${typeof exported.review.decision.revision === "number" ? ` · revision ${exported.review.decision.revision}` : ""}`
                          : "None recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt>Benchmark</dt>
                      <dd>
                        {exported.review?.gold
                          ? typeof exported.review.gold.version === "number"
                            ? `v${exported.review.gold.version}`
                            : "Present"
                          : "Not present"}
                      </dd>
                    </div>
                    <div>
                      <dt>Trace coverage</dt>
                      <dd>
                        {typeof exported.traces?.length === "number"
                          ? `${exported.traces.length} trace${exported.traces.length === 1 ? "" : "s"}`
                          : "Not listed in this export"}
                      </dd>
                    </div>
                  </dl>
                  {exportOmissionSummary(exported) ? (
                    <p className="experiment-lab__privacy-note">{exportOmissionSummary(exported)}</p>
                  ) : null}
                  <details className="experiment-lab__raw-export">
                    <summary>View raw export</summary>
                    <pre className="imported-run__text">{JSON.stringify(exported, null, 2)}</pre>
                  </details>
                </div>
              ) : null}
            </section>
          ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
