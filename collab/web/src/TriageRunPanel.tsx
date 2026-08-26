import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  isTriageProducingStatus,
  triageJobExecutionState,
  triageLanePhaseCounts,
  type TriageCandidateStatus,
} from "@cd-collab/contracts/triage-lifecycle";
import {
  triageEvidenceBudgetExplanation,
  type TriageEvidenceBudgetFailureV1,
} from "@cd-collab/contracts/triage-capacity";
import {
  advanceTriageRunState,
  triageRetryEligibility,
  triageRunObservation,
  type TriageRunObservedState,
} from "@cd-collab/contracts/triage-run-state";
import { EvidenceSnapshotCockpit } from "./EvidenceSnapshotCockpit.js";
import { protectedApiFetch } from "./protected-api.js";
import { TechnicalIdentifiers, recordNickname } from "./technical-identity.js";
import type { WorkFocus } from "./app-location.js";
import { useRouteFocus } from "./route-focus.js";

// Metadata fields beyond `id`/`fingerprint`/`evidence`/`createdBy` are already
// part of the snapshot API response (cd-collab.snapshot.v1) but stay optional
// here: the cockpit renders "unknown" instead of guessing when one is absent.
interface SnapshotView {
  id: string;
  fingerprint: string;
  evidence: { evidenceId: string; verificationStatus?: string | null }[];
  createdBy: string;
  createdAt?: string;
  status?: string;
  visibility?: string;
  parentSnapshotId?: string | null;
  protocolVersion?: string;
  fairnessClass?: "same_snapshot" | "unknown";
}

interface ArtifactView {
  id: string;
  kind: string;
  filename: string | null;
  verificationStatus: string | null;
}

interface ExternalChatRunView {
  id: string;
  promptText: string | null;
  promptCompleteness: string;
  importerUsername: string;
  operatorUsername: string;
  snapshotBinding: string | null;
  evidenceVisibility: string;
  corroborationState: string;
}

interface TriageProfileOption {
  id: string;
  profileId?: string;
  modelId?: string;
  alias?: string;
  label: string;
  provider: string;
}

interface TriagePolicyView {
  purposes: Record<string, { enabled: boolean; allowedSubjects: string[]; maxLanes?: number }>;
  revision: number;
}

interface TriageCapabilitiesView {
  syntheticAvailable: boolean;
  gatewayAvailable: boolean;
  gatewayMinCandidates: number;
  gatewayMaxCandidates: number;
  profileCatalogConfigured: boolean;
  profileCount: number;
  progressEventsPerLane?: number;
  maxProgressEvents?: number;
  maxEvidenceItemBytes?: number;
  maxEvidenceAggregateBytes?: number;
  cancellationSupported?: boolean;
  retrySemantics?: string;
  usageAvailable?: boolean;
  costAvailable?: boolean;
  unavailable?: string[];
}

interface CandidateView {
  candidateId: string;
  role: string;
  provider: string;
  profileId: string | null;
  model: string;
  version: string | null;
  status: string;
  benchmarkRunId: string | null;
  outputHash: string | null;
  summary: string | null;
  evidenceRefs: string[];
  unknowns: string[];
  errorCode: string | null;
  privacyClass: string;
  /**
   * When the host admitted this lane. Optional here because a stored job from
   * an older record may omit it; absent stays absent rather than becoming a
   * guessed start time.
   */
  startedAt?: string | null;
}

interface CandidateOption {
  candidateId: string;
  role: string;
  provider: string;
  profileId: string | null;
  model: string;
  version: string | null;
}

interface JobView {
  id: string;
  snapshotId: string;
  snapshotFingerprint: string;
  requestFingerprint: string;
  parentJobId?: string | null;
  request: {
    strategyId: string;
    question: string;
    taskFingerprint: string;
    mode: "deterministic_mock" | "gateway";
    concurrency?: number;
    candidates: CandidateOption[];
  };
  status: string;
  candidates: CandidateView[];
  sameSnapshot: boolean | null;
  agreementNotice: string;
  requestedByUsername?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  /** Absent on records written before the host tracked lane movement. */
  lastProgressAt?: string | null;
  leaseExpiresAt?: string | null;
  failure?: TriageEvidenceBudgetFailureV1 | null;
}

interface LaunchReceipt {
  jobId: string;
  snapshotFingerprint: string;
  evidenceCount: number;
}

const DEFAULT_CANDIDATES: CandidateOption[] = [
  { candidateId: "qwen-reviewer", role: "reviewer", provider: "synthetic", profileId: null, model: "qwen-3.6-27b", version: null },
  { candidateId: "gpt-oss-contributor", role: "contributor", provider: "synthetic", profileId: null, model: "gpt-oss-120b", version: null },
  { candidateId: "ministral-challenger", role: "challenger", provider: "synthetic", profileId: null, model: "ministral-3-14b-instruct-2512", version: null },
];
const DEFAULT_GATEWAY_CONCURRENCY = 2;
const GATEWAY_CONCURRENCY_OPTIONS = [1, 2, 3, 4] as const;
const INITIAL_EVIDENCE_REFS = 8;
// A slow gateway can hold a run for minutes. Polling twice a second for all of
// it is load without information, so the gap widens as the wait lengthens while
// staying responsive for the fast, common case.
//
// The tier counts this panel's own consecutive polls rather than the job's
// timestamp age: the browser clock and the server clock need not agree, and a
// skewed comparison would either hammer a long wait or throttle a fresh launch.
const BASE_POLL_MS = 500;
const POLL_TIERS = [
  { afterPolls: 30, everyMs: 5_000 },
  { afterPolls: 20, everyMs: 2_000 },
] as const;
/** How long a run may wait before the panel says so in words. */
const SLOW_WAIT_MS = 60_000;
const MAX_ERROR_LENGTH = 240;
// Synthetic fixture labels; suggestions only — the operator may type any
// non-DeepSeek model id their configured gateway connection actually serves.
const SUGGESTED_MODEL_IDS = [
  "qwen-3.6-27b",
  "gpt-oss-120b",
  "ministral-3-14b-instruct-2512",
] as const;
const LANE_ROLES = ["reviewer", "contributor", "challenger", "single"] as const;
const DEEPSEEK_PATTERN = /deepseek/i;
const DEEPSEEK_REJECTION = "DeepSeek lanes are not permitted in this deployment.";

function externalChatRunLabel(run: ExternalChatRunView, index: number): string {
  const operator = run.operatorUsername || run.importerUsername || "unknown participant";
  const normalizedPrompt = run.promptText?.trim().replace(/\s+/g, " ") ?? "";
  const prompt = normalizedPrompt
    ? `“${normalizedPrompt.length > 72 ? `${normalizedPrompt.slice(0, 71)}…` : normalizedPrompt}”`
    : "prompt not recorded";
  return `Pasted chat ${index + 1} · ${operator} · ${prompt}`;
}

function boundedError(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (
    lower.includes("bearer ")
    || lower.includes("api_key")
    || lower.includes("apikey")
    || lower.includes("authorization")
    || lower.includes("ai-gateway.vercel.sh")
  ) return fallback;
  return trimmed.length > MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : trimmed;
}

function errorText(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (typeof body === "object" && body !== null && "error" in body) {
        const error = (body as { error?: unknown }).error;
        if (typeof error === "string") return boundedError(error, fallback);
      }
      return fallback;
    })
    .catch(() => fallback);
}

/** Plain words for how a comparison was executed. */
function modeLabel(mode: JobView["request"]["mode"]): string {
  return mode === "gateway" ? "Gateway run" : "Built-in synthetic run";
}

function localTimestamp(stamp: string | null | undefined): string | null {
  if (!stamp) return null;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

/**
 * When a comparison started, in local time.
 *
 * Run history is read to answer "which of these is the current one", so the
 * ordering fact has to be on the row rather than implied by its position.
 *
 * A run that has not started has no start time. Falling back to the creation
 * time made a run still waiting on a slow gateway read as one that had already
 * begun, which is the reading a reader most needs to be able to trust here.
 */
function startedAtLabel(job: JobView): string {
  const started = localTimestamp(job.startedAt);
  if (started) return `started ${started}`;
  const created = localTimestamp(job.createdAt);
  return created ? `created ${created}, not started yet` : "start time not recorded";
}

function laneCounts(job: JobView) {
  return triageLanePhaseCounts(
    job.candidates.map((candidate) => ({ status: candidate.status as TriageCandidateStatus })),
  );
}

/** Lanes that actually produced something a reader can review. */
function producedLaneCount(job: JobView): number {
  return job.candidates.filter((candidate) =>
    isTriageProducingStatus(candidate.status as TriageCandidateStatus),
  ).length;
}

/**
 * What the host actually did, as distinct from what was configured.
 *
 * Selecting gateway mode is a request, never proof that a provider was reached;
 * a gateway that never admitted a lane must not leave a row that reads like a
 * run which happened.
 */
function executionStateLabel(job: JobView): string {
  const state = triageJobExecutionState({
    candidates: job.candidates.map((candidate) => ({
      status: candidate.status as TriageCandidateStatus,
      startedAt: candidate.startedAt ?? null,
    })),
  });
  if (state === "configured") return "configured — no lane executed";
  return state === "executing" ? "executing" : "executed";
}

/** Byte bounds as the operator reads them, never as a raw count. */
function mib(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown";
  const value = bytes / (1024 * 1024);
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)} MiB`;
}

function elapsedLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function waitedMs(job: JobView, nowMs: number): number | null {
  const since = Date.parse(job.startedAt ?? job.createdAt);
  return Number.isFinite(since) ? nowMs - since : null;
}

/** How long the panel should wait before asking the server again. */
function pollDelayMs(pollsSoFar: number): number {
  for (const tier of POLL_TIERS) if (pollsSoFar >= tier.afterPolls) return tier.everyMs;
  return BASE_POLL_MS;
}

/**
 * The persisted facts the shared rules read, and nothing else.
 *
 * Built once here so the reader's state, its progress line, and its retry
 * advice cannot be derived from three slightly different views of one run.
 */
function observationInput(job: JobView) {
  return {
    status: job.status as never,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cancelRequestedAt: job.cancelRequestedAt,
    parentJobId: job.parentJobId ?? null,
    leaseExpiresAt: job.leaseExpiresAt ?? null,
    lastProgressAt: job.lastProgressAt ?? null,
    failure: job.failure ?? null,
    candidates: job.candidates.map((candidate) => ({
      status: candidate.status as TriageCandidateStatus,
      role: candidate.role,
      candidateId: candidate.candidateId,
      startedAt: candidate.startedAt ?? null,
    })),
  };
}

/** The shared durable observation for one run, from persisted facts only. */
function observe(job: JobView, nowMs: number) {
  return triageRunObservation(observationInput(job), nowMs);
}

/** Whether repeating this run is safe or repeats work of unknown outcome. */
function retryView(job: JobView) {
  return triageRetryEligibility(observationInput(job));
}

/**
 * The primary progress line for an unfinished run.
 *
 * Deliberately five facts and nothing else: which lane, what stage, how many
 * lanes are done out of how many, how long it has been running, and how long
 * since anything actually moved. A slow company gateway is exactly the case
 * where a reader starts hunting through traces, usage counters, and cost
 * estimates for a signal that is not in any of them — so none of that appears
 * here. The operator's next step is stated in words rather than implied.
 */
function waitingText(job: JobView, nowMs: number): string {
  const view = observe(job, nowMs);
  const parts = [
    view.lane ? `Lane ${view.lane}` : "No lane in flight",
    view.stage,
    `${view.completed}/${view.total} lanes produced a result`,
  ];
  if (view.elapsedMs !== null) parts.push(`running ${elapsedLabel(view.elapsedMs)}`);
  parts.push(
    view.sinceLastProgressMs === null
      ? "nothing has moved yet"
      : `last movement ${elapsedLabel(view.sinceLastProgressMs)} ago`,
  );
  return `${parts.join(" · ")}.`;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function isTerminal(status: string): boolean {
  return ["completed", "partial", "failed", "timed_out", "cancelled"].includes(status);
}

/**
 * A run is reviewable only when a lane actually produced something.
 *
 * A stored `partial` from before the lifecycle rule was shared could mean every
 * lane failed or timed out, and offering a review of a run with nothing in it
 * invites a reader to treat an absence of output as a result.
 */
function isReviewable(job: JobView): boolean {
  return (job.status === "completed" || job.status === "partial") && producedLaneCount(job) > 0;
}

function laneLifecycleLabel(status: string): string {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (isTerminal(status)) return "settled";
  return statusLabel(status);
}

function candidateLifecycleText(status: string): string {
  const lifecycle = laneLifecycleLabel(status);
  return isTerminal(status) && status !== "completed"
    ? `${lifecycle} · ${statusLabel(status)}`
    : lifecycle;
}

function evidenceLabel(ref: string, artifacts: ArtifactView[]): string {
  const artifact = artifacts.find((item) => item.id === ref);
  return artifact ? artifact.filename ?? artifact.kind : "Unresolved evidence";
}

function sharedEvidence(jobs: JobView[]): string[] {
  const counts = new Map<string, Set<string>>();
  for (const job of jobs) {
    for (const ref of new Set(job.candidates.flatMap((candidate) => candidate.evidenceRefs))) {
      const jobIds = counts.get(ref) ?? new Set<string>();
      jobIds.add(job.id);
      counts.set(ref, jobIds);
    }
  }
  return [...counts.entries()]
    .filter(([, jobIds]) => jobIds.size > 1)
    .map(([ref]) => ref)
    .sort();
}

export function TriageRunPanel(props: {
  caseId: string;
  canLead: boolean;
  readOnly: boolean;
  participants?: { identityId?: string; username?: string }[];
  routeFocus?: WorkFocus;
  /**
   * Opens the comparison workspace on a freshly created comparison.
   *
   * Creating one and announcing it "ready" somewhere else left the reader to
   * find that somewhere themselves; clicking again only created another.
   */
  onOpenComparison?: (experimentId: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotView[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [externalChatRuns, setExternalChatRuns] = useState<ExternalChatRunView[]>([]);
  const [gatewayProfiles, setGatewayProfiles] = useState<TriageProfileOption[]>([]);
  const [triagePolicy, setTriagePolicy] = useState<TriagePolicyView | null>(null);
  const [triageCapabilities, setTriageCapabilities] = useState<TriageCapabilitiesView | null>(null);
  const [compareJobIds, setCompareJobIds] = useState<string[]>([]);
  const [candidateOptions, setCandidateOptions] = useState<CandidateOption[]>(DEFAULT_CANDIDATES);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>("");
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>(
    DEFAULT_CANDIDATES.map((candidate) => candidate.candidateId),
  );
  const [mode, setMode] = useState<"deterministic_mock" | "gateway">("deterministic_mock");
  const [concurrency, setConcurrency] = useState(DEFAULT_GATEWAY_CONCURRENCY);
  const [laneProfiles, setLaneProfiles] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      DEFAULT_CANDIDATES
        .filter((candidate) => candidate.profileId)
        .map((candidate) => [candidate.candidateId, candidate.profileId as string]),
    ),
  );
  const [parentJobId, setParentJobId] = useState<string | null>(null);
  // A new investigation starts with its own question. Prefilling one from an
  // unrelated demo made every launch look pre-answered and put a foreign
  // fingerprint on the run record.
  const [taskFingerprint, setTaskFingerprint] = useState("");
  const [question, setQuestion] = useState("");
  const [strategyId, setStrategyId] = useState("contextdesk.standard");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [launchReceipt, setLaunchReceipt] = useState<LaunchReceipt | null>(null);
  const [selectedExternalRunId, setSelectedExternalRunId] = useState("");
  const [handoffJobId, setHandoffJobId] = useState<string | null>(null);
  const [handoffExperimentId, setHandoffExperimentId] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [lanePickerError, setLanePickerError] = useState<string | null>(null);
  const [benchArtifactText, setBenchArtifactText] = useState("");
  const [benchImportBusy, setBenchImportBusy] = useState(false);
  const [benchImportExperimentId, setBenchImportExperimentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Advanced only by the poll tick, so the wait a reader sees is the wait the
  // panel last actually confirmed with the server.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const loadRequestToken = useRef(0);
  const launchFocusApplied = useRef<string | null>(null);
  // Terminal-state monotonicity for the reader.
  //
  // The panel polls, so an in-flight response can land after a newer one, and
  // a late progress frame for a run the host already settled would otherwise
  // move the row back out of its terminal state. The state is still derived
  // from the record on every render — this only refuses to walk a run
  // backwards out of completed, failed, or cancelled once it has been there.
  const observedState = useRef(new Map<string, TriageRunObservedState>());
  const runState = useCallback((job: JobView, at: number): TriageRunObservedState => {
    const next = advanceTriageRunState(
      observedState.current.get(job.id) ?? null,
      observe(job, at).state,
    );
    observedState.current.set(job.id, next);
    return next;
  }, []);
  useRouteFocus(props.routeFocus, !loading);

  const load = useCallback(async (preferredSnapshotId?: string | null) => {
    const requestToken = ++loadRequestToken.current;
    setError(null);
    try {
      const [snapshotResponse, evidenceResponse, jobsResponse, importsResponse, profilesResponse, capabilitiesResponse] = await Promise.all([
        protectedApiFetch(`/api/cases/${props.caseId}/snapshots`),
        protectedApiFetch(`/api/cases/${props.caseId}/evidence`),
        protectedApiFetch(`/api/cases/${props.caseId}/triage-runs`),
        protectedApiFetch(`/api/cases/${props.caseId}/imports`),
        protectedApiFetch("/api/triage-profiles"),
        protectedApiFetch("/api/triage-capabilities"),
      ]);
      if (requestToken !== loadRequestToken.current) return;
      if (!snapshotResponse.ok) throw new Error(await errorText(snapshotResponse, "Snapshots could not be loaded."));
      if (!evidenceResponse.ok) throw new Error(await errorText(evidenceResponse, "Evidence could not be loaded."));
      if (!jobsResponse.ok) throw new Error(await errorText(jobsResponse, "Run history could not be loaded."));
      if (!importsResponse.ok) throw new Error(await errorText(importsResponse, "Imported chat runs could not be loaded."));
      const snapshotBody = (await snapshotResponse.json()) as { snapshots?: SnapshotView[] };
      const evidenceBody = (await evidenceResponse.json()) as { artifacts?: ArtifactView[] };
      const jobBody = (await jobsResponse.json()) as { jobs?: JobView[] };
      const importsBody = (await importsResponse.json()) as { runs?: ExternalChatRunView[] };
      const profilesBody = profilesResponse.ok
        ? (await profilesResponse.json()) as { profiles?: TriageProfileOption[]; policy?: TriagePolicyView }
        : { profiles: [] };
      const capabilitiesBody = capabilitiesResponse.ok
        ? (await capabilitiesResponse.json()) as TriageCapabilitiesView & { schemaId?: string }
        : null;
      const nextSnapshots = snapshotBody.snapshots ?? [];
      const nextArtifacts = evidenceBody.artifacts ?? [];
      const nextJobs = jobBody.jobs ?? [];
      const nextExternalChatRuns = importsBody.runs ?? [];
      if (requestToken !== loadRequestToken.current) return;
      setSnapshots(nextSnapshots);
      setArtifacts(nextArtifacts);
      setSelectedSnapshotId((current) => {
        if (preferredSnapshotId && nextSnapshots.some((snapshot) => snapshot.id === preferredSnapshotId)) {
          return preferredSnapshotId;
        }
        if (current && nextSnapshots.some((snapshot) => snapshot.id === current)) return current;
        return nextSnapshots.at(-1)?.id || "";
      });
      setJobs(nextJobs);
      setExternalChatRuns(nextExternalChatRuns);
      setGatewayProfiles(profilesBody.profiles ?? []);
      setTriagePolicy(profilesBody.policy ?? null);
      setTriageCapabilities(capabilitiesBody);
      setSelectedExternalRunId((current) =>
        current && nextExternalChatRuns.some((run) => run.id === current) ? current : "",
      );
      setCompareJobIds((current) => current.filter((id) => nextJobs.some((job) => job.id === id)));
      setCandidateOptions((current) => {
        const merged = [...current];
        for (const candidate of nextJobs.flatMap((job) => job.request.candidates ?? [])) {
          if (!merged.some((item) => item.candidateId === candidate.candidateId)) merged.push(candidate);
        }
        return merged;
      });
      setLaneProfiles((current) => {
        const next = { ...current };
        for (const candidate of nextJobs.flatMap((job) => job.request.candidates ?? [])) {
          if (candidate.profileId && !next[candidate.candidateId]) next[candidate.candidateId] = candidate.profileId;
        }
        return next;
      });
    } catch (cause) {
      if (requestToken === loadRequestToken.current) {
        setError(cause instanceof Error ? boundedError(cause.message, "Triage runs could not be loaded.") : "Triage runs could not be loaded.");
      }
    } finally {
      if (requestToken === loadRequestToken.current) setLoading(false);
    }
  }, [props.caseId]);

  useEffect(() => {
    setLoading(true);
    setSelectedSnapshotId("");
    void load();
  }, [load]);

  useEffect(() => {
    const refreshExternalRuns = () => void load();
    window.addEventListener("contextdesk:external-run-imported", refreshExternalRuns);
    return () => window.removeEventListener("contextdesk:external-run-imported", refreshExternalRuns);
  }, [load]);

  useEffect(() => {
    const refreshSnapshots = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: string; snapshotId?: string }>).detail;
      if (detail?.caseId === props.caseId) void load(detail.snapshotId);
    };
    window.addEventListener("contextdesk:snapshot-frozen", refreshSnapshots);
    return () => window.removeEventListener("contextdesk:snapshot-frozen", refreshSnapshots);
  }, [load, props.caseId]);

  const hasActiveJob = useMemo(
    () => jobs.some((job) => job.status === "queued" || job.status === "running"),
    [jobs],
  );
  const completedJobs = useMemo(() => jobs.filter((job) => isTerminal(job.status)), [jobs]);
  const comparedJobs = useMemo(
    () => completedJobs.filter((job) => compareJobIds.includes(job.id)),
    [compareJobIds, completedJobs],
  );
  const sharedRefs = useMemo(() => sharedEvidence(comparedJobs), [comparedJobs]);
  const comparedRunBindingsMatch = comparedJobs.length > 1
    && comparedJobs.every((job) => job.sameSnapshot === true && job.snapshotFingerprint === comparedJobs[0]?.snapshotFingerprint);
  const selectedGatewayCandidates = useMemo(
    () => candidateOptions.filter((candidate) => selectedCandidates.includes(candidate.candidateId)),
    [candidateOptions, selectedCandidates],
  );
  const gatewayAvailable = triageCapabilities?.gatewayAvailable ?? true;
  const selectableGatewayProfiles = useMemo(() => {
    if (!triagePolicy) return gatewayProfiles;
    const rule = triagePolicy.purposes.comparison;
    if (!rule) return gatewayProfiles;
    return gatewayProfiles.filter((profile) => rule.allowedSubjects.includes(profile.id));
  }, [gatewayProfiles, triagePolicy]);
  const gatewayProfilesReady = mode !== "gateway"
    || selectedGatewayCandidates.every((candidate) => Boolean(profileFor(candidate)));

  useEffect(() => {
    if (mode === "gateway" && triageCapabilities?.gatewayAvailable === false) {
      setMode("deterministic_mock");
    }
  }, [mode, triageCapabilities]);

  function selectedProfileFor(candidate: CandidateOption): TriageProfileOption | undefined {
    const selected = (laneProfiles[candidate.candidateId] ?? candidate.profileId ?? "").trim();
    const exactSelection = selectableGatewayProfiles.find((profile) => profile.id === selected);
    if (exactSelection) return exactSelection;

    const hostProfileId = selected || candidate.profileId || "";
    return selectableGatewayProfiles.find((profile) =>
      (profile.profileId ?? profile.id) === hostProfileId
      && (profile.modelId === candidate.model || profile.alias === candidate.model),
    ) ?? selectableGatewayProfiles.find((profile) =>
      profile.modelId === candidate.model || profile.alias === candidate.model,
    );
  }

  function profileFor(candidate: CandidateOption): string {
    return selectedProfileFor(candidate)?.id
      ?? (triagePolicy && gatewayProfiles.length > 0
        ? ""
        : (laneProfiles[candidate.candidateId] ?? candidate.profileId ?? "").trim());
  }

  function hostProfileFor(candidate: CandidateOption): string {
    const profile = selectedProfileFor(candidate);
    return (profile?.profileId ?? profile?.id ?? profileFor(candidate)).trim();
  }

  function providerFor(candidate: CandidateOption, fallback: string): string {
    return selectedProfileFor(candidate)?.provider ?? fallback;
  }

  function modelFor(candidate: CandidateOption): string {
    return selectedProfileFor(candidate)?.modelId ?? candidate.model;
  }

  function profileLabelFor(candidate: Pick<CandidateOption, "profileId" | "model">): string | null {
    if (!candidate.profileId) return null;
    const profile = selectableGatewayProfiles.find((item) =>
      (item.profileId ?? item.id) === candidate.profileId
      && (!item.modelId || item.modelId === candidate.model || item.alias === candidate.model),
    );
    return profile?.label ?? candidate.profileId;
  }

  useEffect(() => {
    if (!hasActiveJob) return undefined;
    let stopped = false;
    let polls = 0;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        polls += 1;
        setNowMs(Date.now());
        void load();
        schedule();
      }, pollDelayMs(polls));
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [hasActiveJob, load]);

  useEffect(() => {
    if (!launchReceipt || launchFocusApplied.current === launchReceipt.jobId) return;
    if (!jobs.some((job) => job.id === launchReceipt.jobId)) return;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(`triage-run-${launchReceipt.jobId}`);
      if (!element) return;
      launchFocusApplied.current = launchReceipt.jobId;
      element.focus({ preventScroll: true });
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [jobs, launchReceipt]);

  function addLane(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const alias = String(data.get("laneAlias") ?? "").trim();
    const model = String(data.get("laneModel") ?? "").trim();
    const role = String(data.get("laneRole") ?? "").trim() || "single";
    const profileSelectionId = String(data.get("laneProfile") ?? "").trim();
    const selectedProfile = selectableGatewayProfiles.find((profile) => profile.id === profileSelectionId);
    const profileId = selectedProfile?.profileId ?? selectedProfile?.id ?? profileSelectionId;
    const chosenModel = selectedProfile?.modelId ?? model;
    setLanePickerError(null);
    if (!alias || !model) {
      setLanePickerError("Lane alias and model id are required.");
      return;
    }
    if ([alias, chosenModel, profileId].some((value) => DEEPSEEK_PATTERN.test(value))) {
      setLanePickerError(DEEPSEEK_REJECTION);
      return;
    }
    if (candidateOptions.some((candidate) => candidate.candidateId === alias)) {
      setLanePickerError("A lane with this alias already exists.");
      return;
    }
    setCandidateOptions((current) => [
      ...current,
      {
        candidateId: alias,
        role,
        provider: mode === "gateway" ? selectedProfile?.provider ?? "openai-compatible" : "synthetic",
        profileId: profileId || null,
        model: chosenModel,
        version: null,
      },
    ]);
    setSelectedCandidates((current) => [...current, alias]);
    if (profileSelectionId) {
      setLaneProfiles((current) => ({ ...current, [alias]: profileSelectionId }));
    }
    form.reset();
  }

  async function launch() {
    const launchSnapshot = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId);
    if (!launchSnapshot) {
      setError("Choose a currently available frozen snapshot before starting a run.");
      return;
    }
    setRunning(true);
    setError(null);
    setLaunchReceipt(null);
    const candidates = candidateOptions.filter((candidate) =>
      selectedCandidates.includes(candidate.candidateId),
    );
    if (
      candidates.some((candidate) =>
        [candidate.candidateId, candidate.model, mode === "gateway" ? profileFor(candidate) : ""]
          .some((value) => DEEPSEEK_PATTERN.test(value)),
      )
    ) {
      setError(DEEPSEEK_REJECTION);
      setRunning(false);
      return;
    }
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/triage-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: "cd-collab.triage_job_request.v1",
          snapshotId: selectedSnapshotId,
          mode,
          ...(mode === "gateway" ? { concurrency } : {}),
          strategyId,
          question,
          policyFingerprint: null,
          taskFingerprint,
          ...(parentJobId ? { parentJobId } : {}),
          candidates: candidates.map((candidate) => ({
            ...candidate,
            provider: mode === "gateway" ? providerFor(candidate, "openai-compatible") : candidate.provider,
            profileId: mode === "gateway" ? hostProfileFor(candidate) : null,
            model: mode === "gateway" ? modelFor(candidate) : candidate.model,
          })),
        }),
      });
      if (!response.ok) {
        setError(await errorText(response, "Triage run could not be started."));
        return;
      }
      const created = (await response.json()) as Partial<JobView>;
      if (
        typeof created.id !== "string"
        || created.snapshotId !== launchSnapshot.id
        || created.snapshotFingerprint !== launchSnapshot.fingerprint
      ) {
        setError("The run did not confirm the selected snapshot. Do not rely on this run; refresh and try again.");
        return;
      }
      setParentJobId(null);
      launchFocusApplied.current = null;
      setLaunchReceipt({
        jobId: created.id,
        snapshotFingerprint: launchSnapshot.fingerprint,
        evidenceCount: launchSnapshot.evidence.length,
      });
      await load(launchSnapshot.id);
      // Workstreams presents the same runs as readable investigative work;
      // tell it the recorded set changed instead of making it poll blindly.
      window.dispatchEvent(new Event("contextdesk:triage-run-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? boundedError(cause.message, "Triage run could not be started.") : "Triage run could not be started.");
    } finally {
      setRunning(false);
    }
  }

  async function cancel(jobId: string) {
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/triage-runs/${jobId}/cancel`, { method: "POST" });
    if (!response.ok) setError(await errorText(response, "Cancellation could not be requested."));
    await load();
    window.dispatchEvent(new Event("contextdesk:triage-run-changed"));
  }

  async function reviewInExperimentLab(jobId: string) {
    if (handoffJobId) return;
    setHandoffJobId(jobId);
    setHandoffExperimentId(null);
    setHandoffError(null);
    try {
      const response = await protectedApiFetch(
        `/api/cases/${props.caseId}/experiments/from-triage/${jobId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ externalRunId: selectedExternalRunId || null }),
        },
      );
      if (!response.ok) {
        setHandoffError(await errorText(response, "Experiment review could not be created."));
        return;
      }
      const experiment = (await response.json()) as { id?: unknown };
      if (typeof experiment.id !== "string" || !experiment.id) {
        setHandoffError("Experiment review returned no experiment id.");
        return;
      }
      setHandoffExperimentId(experiment.id);
      window.dispatchEvent(
        new CustomEvent("contextdesk:experiment-created", {
          detail: { experimentId: experiment.id },
        }),
      );
      props.onOpenComparison?.(experiment.id);
    } catch (cause) {
      setHandoffError(cause instanceof Error ? boundedError(cause.message, "Experiment review could not be created.") : "Experiment review could not be created.");
    } finally {
      setHandoffJobId(null);
    }
  }

  async function importBenchArtifact() {
    if (benchImportBusy) return;
    setBenchImportBusy(true);
    setBenchImportExperimentId(null);
    setError(null);
    let body: unknown;
    try {
      body = JSON.parse(benchArtifactText);
    } catch {
      setError("Bench artifact JSON is invalid.");
      setBenchImportBusy(false);
      return;
    }
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await errorText(response, "Bench artifact could not be imported."));
        return;
      }
      const experiment = (await response.json()) as { id?: unknown };
      if (typeof experiment.id !== "string" || !experiment.id) {
        setError("Bench artifact import returned no experiment id.");
        return;
      }
      setBenchArtifactText("");
      setBenchImportExperimentId(experiment.id);
      window.dispatchEvent(
        new CustomEvent("contextdesk:experiment-created", {
          detail: { experimentId: experiment.id },
        }),
      );
      props.onOpenComparison?.(experiment.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? boundedError(cause.message, "Bench artifact could not be imported.")
          : "Bench artifact could not be imported.",
      );
    } finally {
      setBenchImportBusy(false);
    }
  }

  function reuse(job: JobView) {
    setSelectedSnapshotId(job.snapshotId);
    setMode(job.request.mode);
    setConcurrency(job.request.concurrency ?? DEFAULT_GATEWAY_CONCURRENCY);
    setStrategyId(job.request.strategyId);
    setQuestion(job.request.question);
    setTaskFingerprint(job.request.taskFingerprint);
    setParentJobId(job.id);
    setSelectedCandidates(job.request.candidates.map((candidate) => candidate.candidateId));
    setLaneProfiles((current) => ({
      ...current,
      ...Object.fromEntries(
        job.request.candidates
          .filter((candidate) => candidate.profileId)
          .map((candidate) => [candidate.candidateId, candidate.profileId as string]),
      ),
    }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const cockpit = snapshots.length > 0 || jobs.length > 0 ? (
    <EvidenceSnapshotCockpit
      snapshots={snapshots}
      selectedRuns={comparedJobs}
      finishedRunCount={completedJobs.length}
      focusSnapshotId={selectedSnapshotId}
      canAct={!props.readOnly && props.canLead}
      {...(props.participants ? { participants: props.participants } : {})}
    />
  ) : null;

  return (
    <section className="triage-runs" aria-labelledby="triage-runs-heading">
      <div className="triage-runs__header">
        <div>
          <p className="case-memory__eyebrow">Connected triage foundation</p>
          <h3 id="triage-runs-heading">Run history</h3>
          <p className="triage-runs__copy">
            Launch a reproducible comparison against one frozen evidence snapshot. Synthetic runs are offline; gateway runs use the configured host bridge and the same job record.
          </p>
        </div>
        <span className="case-memory__badge">{jobs.length} runs</span>
      </div>
      {error ? <p className="case-memory__error" role="alert">{error}</p> : null}
      {loading ? <p className="case-memory__empty">Loading run history…</p> : null}
      {!loading ? (
        <>
          {!props.readOnly && props.canLead ? (
            <div className="triage-runs__launcher">
              <div className="triage-runs__launcher-heading">
                <div>
                  <h4>Start a snapshot-bound comparison</h4>
                  <p className="case-memory__note">
                    {mode === "gateway"
                      ? gatewayAvailable
                        ? "Your War Room host owns provider calls and credentials; choose the gateway model each lane should run."
                        : "Gateway execution is not configured on this deployment; synthetic mode remains available."
                      : "Synthetic runs are offline and make no provider calls."}
                  </p>
                </div>
                <span className="triage-runs__mode">{mode === "gateway" ? "configured gateway" : "synthetic / offline"}</span>
              </div>
              {snapshots.length === 0 ? (
                <p className="case-memory__empty">Freeze evidence above before launching a run.</p>
              ) : (
                <>
                  <label className="triage-runs__field">
                    Snapshot
                    <select value={selectedSnapshotId} onChange={(event) => setSelectedSnapshotId(event.target.value)}>
                      {snapshots.map((snapshot, index) => (
                        <option key={snapshot.id} value={snapshot.id}>
                          Snapshot {index} · {snapshot.evidence.length} evidence item
                          {snapshot.evidence.length === 1 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="triage-runs__field">
                    Execution mode
                    <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                      <option value="deterministic_mock">Synthetic / offline</option>
                      <option value="gateway" disabled={!gatewayAvailable}>
                        {gatewayAvailable ? "Configured gateway" : "Gateway unavailable on this host"}
                      </option>
                    </select>
                  </label>
                  {mode === "gateway" ? (
                    <label className="triage-runs__field">
                      Lane concurrency
                      <select
                        aria-label="Lane concurrency"
                        value={concurrency}
                        onChange={(event) => setConcurrency(Number(event.target.value))}
                      >
                        {GATEWAY_CONCURRENCY_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option} {option === 1 ? "lane (sequential)" : "lanes"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="triage-runs__field">
                    Question
                    <textarea
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      rows={3}
                      required
                      placeholder="What do you want each lane to answer about this investigation?"
                    />
                  </label>
                  <label className="triage-runs__field">
                    Task fingerprint
                    <input
                      value={taskFingerprint}
                      onChange={(event) => setTaskFingerprint(event.target.value)}
                      required
                      placeholder="A short label reruns of this same question will share"
                    />
                  </label>
                  <label className="triage-runs__field">
                    Strategy
                    <input value={strategyId} onChange={(event) => setStrategyId(event.target.value)} />
                  </label>
                  <fieldset className="triage-runs__candidates">
                    <legend>Model lanes</legend>
                    {candidateOptions.map((candidate) => (
                      <div className="triage-runs__lane" key={candidate.candidateId}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedCandidates.includes(candidate.candidateId)}
                            onChange={(event) =>
                              setSelectedCandidates((current) =>
                                event.target.checked
                                  ? [...current, candidate.candidateId]
                                  : current.filter((id) => id !== candidate.candidateId),
                              )
                            }
                          />
                          <span>
                            <strong>{candidate.model}</strong>
                            <small>{candidate.candidateId} · {candidate.role}</small>
                          </span>
                        </label>
                        {mode === "gateway" && selectedCandidates.includes(candidate.candidateId) ? (
                          selectableGatewayProfiles.length > 0 ? (
                            <label className="triage-runs__lane-profile">
                              Gateway model
                              <select
                                aria-label={`${candidate.model} gateway model`}
                                value={profileFor(candidate)}
                                onChange={(event) => setLaneProfiles((current) => ({ ...current, [candidate.candidateId]: event.target.value }))}
                              >
                                <option value="" disabled>Select a profile</option>
                                {selectableGatewayProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.label} · {profile.provider}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : gatewayProfiles.length > 0 ? (
                            <p className="case-memory__note">
                              No gateway model is approved for comparison by the current workspace policy.
                              Ask an administrator to approve a model before starting this run.
                            </p>
                          ) : (
                            <label className="triage-runs__lane-profile">
                              Gateway connection ID
                              <input
                                aria-label={`${candidate.model} gateway connection ID`}
                                value={profileFor(candidate)}
                                onChange={(event) => setLaneProfiles((current) => ({ ...current, [candidate.candidateId]: event.target.value }))}
                                placeholder="profile:employer-gateway"
                              />
                            </label>
                          )
                        ) : null}
                      </div>
                    ))}
                    {mode === "gateway" ? (
                      <span className="case-memory__note">
                        Each selected lane chooses its own gateway model. Credentials and endpoints stay on the War Room host.
                        {!gatewayAvailable ? " Configure COLLAB_TRIAGE_RUNNER to enable gateway execution." : ""}
                        {selectedCandidates.length < 2 ? " Gateway comparisons require at least two lanes." : ""}
                        {triagePolicy ? ` Workspace model-use policy revision ${triagePolicy.revision} is applied.` : ""}
                        {triagePolicy?.purposes.comparison?.enabled === false ? " Model comparison is disabled by workspace policy." : ""}
                        {triagePolicy && selectableGatewayProfiles.length === 0 && gatewayProfiles.length > 0
                          ? " No approved gateway models are available for comparison."
                          : ""}
                      </span>
                    ) : null}
                    {triageCapabilities ? (
                      <span className="case-memory__note triage-runs__readiness" data-testid="triage-readiness">
                        {/* Stated from what the host reports it can execute, not
                            from what it will merely accept: every count listed
                            here runs to completion. */}
                        This host runs {triageCapabilities.gatewayMinCandidates}–
                        {triageCapabilities.gatewayMaxCandidates} gateway lanes, and every count in
                        that range is executable. Evidence limit{" "}
                        {mib(triageCapabilities.maxEvidenceAggregateBytes)} per run and{" "}
                        {mib(triageCapabilities.maxEvidenceItemBytes)} per item; an over-limit run is
                        refused before anything is sent.{" "}
                        {triageCapabilities.cancellationSupported === false
                          ? "Cancellation is not supported on this host."
                          : "Cancellation is durable: no further lane is dispatched once you request it."}{" "}
                        A retry is an explicit rerun bound to the run it repeats; an identical run
                        already in flight is refused rather than duplicated.{" "}
                        {(triageCapabilities.unavailable ?? []).length > 0
                          ? `Not reported by this host: ${(triageCapabilities.unavailable ?? []).join("; ")}.`
                          : ""}
                      </span>
                    ) : null}
                    <details className="triage-runs__lane-picker">
                      <summary>Add a model lane</summary>
                      <form className="triage-runs__lane-picker-form" onSubmit={addLane}>
                        <p className="case-memory__note">
                          Identifiers only: lane alias, model id, and (for gateway runs) a host
                          gateway connection. Endpoints, credentials, and raw provider traffic never enter
                          the browser. DeepSeek lanes are rejected.
                        </p>
                        <label className="triage-runs__field">
                          Lane alias
                          <input
                            name="laneAlias"
                            aria-label="New lane alias"
                            placeholder="e.g. qwen-reviewer"
                            required
                          />
                        </label>
                        <label className="triage-runs__field">
                          Model id
                          <input
                            name="laneModel"
                            aria-label="New lane model id"
                            list="triage-model-suggestions"
                            placeholder="e.g. qwen-3.6-27b"
                            required
                          />
                        </label>
                        <datalist id="triage-model-suggestions">
                          {SUGGESTED_MODEL_IDS.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                        <label className="triage-runs__field">
                          Role
                          <select name="laneRole" aria-label="New lane role" defaultValue="reviewer">
                            {LANE_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        </label>
                        {mode === "gateway" ? (
                          selectableGatewayProfiles.length > 0 ? (
                            <label className="triage-runs__field">
                              Gateway model
                              <select name="laneProfile" aria-label="New lane gateway model" defaultValue="">
                                <option value="" disabled>
                                  Select a profile
                                </option>
                                {selectableGatewayProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.label} · {profile.provider}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : gatewayProfiles.length > 0 ? (
                            <p className="case-memory__note">
                              No gateway model is approved for comparison by the current workspace policy.
                            </p>
                          ) : (
                            <label className="triage-runs__field">
                              Gateway connection ID
                              <input
                                name="laneProfile"
                                aria-label="New lane gateway connection ID"
                                placeholder="profile:employer-gateway"
                              />
                            </label>
                          )
                        ) : null}
                        {lanePickerError ? (
                          <p className="case-memory__error" role="alert">
                            {lanePickerError}
                          </p>
                        ) : null}
                        <button className="case-memory__secondary-button" type="submit">
                          Add lane
                        </button>
                      </form>
                    </details>
                  </fieldset>
                  <button
                    className="login__submit"
                    type="button"
                    disabled={running || !selectedSnapshotId || selectedCandidates.length === 0 || (mode === "gateway" && (!gatewayAvailable || selectedCandidates.length < 2 || !gatewayProfilesReady || triagePolicy?.purposes.comparison?.enabled === false || (gatewayProfiles.length > 0 && selectableGatewayProfiles.length === 0)))}
                    onClick={() => void launch()}
                  >
                    {running ? "Starting…" : mode === "gateway" ? "Run gateway comparison" : "Run synthetic comparison"}
                  </button>
                  {launchReceipt ? (
                    <div
                    className="triage-runs__launch-receipt"
                    role="status"
                    aria-live="polite"
                    aria-label="Launch receipt"
                  >
                      <strong>Last run recorded on the selected snapshot.</strong>
                      <span>
                        {launchReceipt.evidenceCount} frozen evidence item{launchReceipt.evidenceCount === 1 ? "" : "s"}
                        {" · "}{recordNickname("run", launchReceipt.jobId)}
                      </span>
                      <button
                        className="case-memory__secondary-button"
                        type="button"
                        onClick={() => {
                          const element = document.getElementById(`triage-run-${launchReceipt.jobId}`);
                          element?.focus({ preventScroll: true });
                          if (typeof element?.scrollIntoView === "function") {
                            element.scrollIntoView({ behavior: "smooth", block: "center" });
                          }
                        }}
                      >
                        Open the last run
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          {!props.readOnly && props.canLead ? (
            <section className="triage-runs__handoff" aria-labelledby="triage-runs-bench-import-heading">
              <div>
                <p className="case-memory__eyebrow">Recorded / bench-compare import</p>
                <h4 id="triage-runs-bench-import-heading">Land a hermetic multi-strategy artifact on this case</h4>
                <p className="case-memory__note">
                  Convert share-safe bench-compare or recorded-replay lanes into Experiment Lab
                  candidates and traces. The primary review stays the readable candidate table;
                  raw JSON is only the import input.
                </p>
              </div>
              <label className="triage-runs__field">
                Artifact JSON
                <textarea
                  rows={5}
                  value={benchArtifactText}
                  onChange={(event) => setBenchArtifactText(event.target.value)}
                  placeholder="cd-collab.bench_run_artifact.v1 with synthetic lane labels"
                />
              </label>
              <button
                className="case-memory__secondary-button"
                type="button"
                disabled={benchImportBusy || !benchArtifactText.trim()}
                onClick={() => void importBenchArtifact()}
              >
                {benchImportBusy ? "Importing…" : "Import into Experiment Lab"}
              </button>
              {benchImportExperimentId ? (
                <p
                  className="triage-runs__handoff-success"
                  role="status"
                  aria-label="Recorded artifact import"
                >
                  Recorded artifact imported as a comparison. It is now the newest comparison on
                  this investigation and is selected in Compare.
                </p>
              ) : null}
            </section>
          ) : null}
          {jobs.length === 0 ? (
            <>
              <p className="case-memory__empty">No triage runs yet. The first run will be bound to the selected snapshot and ready for later comparison.</p>
              {cockpit}
            </>
          ) : (
            <>
              {completedJobs.some((job) => isReviewable(job)) ? (
                <section className="triage-runs__handoff" aria-labelledby="triage-runs-handoff-heading">
                  <div>
                    <p className="case-memory__eyebrow">Unified comparison handoff</p>
                    <h4 id="triage-runs-handoff-heading">Compare a connected run with a pasted chat</h4>
                    <p className="case-memory__note">
                      Choose an imported chat when available. Missing turns, tools, evidence, or the original question remain partial and unknown; the handoff never guesses them.
                    </p>
                  </div>
                  <label className="triage-runs__field">
                    External chat run (optional)
                    <select
                      aria-label="External chat run to compare"
                      value={selectedExternalRunId}
                      onChange={(event) => setSelectedExternalRunId(event.target.value)}
                    >
                      <option value="">No external chat — review connected lanes only</option>
                      {externalChatRuns.map((run, index) => (
                        <option key={run.id} value={run.id}>
                          {externalChatRunLabel(run, index)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {handoffError ? <p className="case-memory__error" role="alert">{handoffError}</p> : null}
                  {handoffExperimentId ? (
                    <p
                      className="triage-runs__handoff-success"
                      role="status"
                      aria-label="Comparison handoff"
                    >
                      This run is ready in Compare, opened as the newest comparison on this
                      investigation.
                    </p>
                  ) : null}
                </section>
              ) : null}
              {completedJobs.length > 1 ? (
                <section className="triage-runs__comparison" aria-labelledby="triage-runs-comparison-heading">
                  <div className="triage-runs__comparison-heading">
                    <div>
                      <h4 id="triage-runs-comparison-heading">Compare finished runs</h4>
                      <p className="case-memory__note">Select two or more finished runs — including partial or failed ones — to see their evidence overlap and lane outcomes. Agreement is not proof of correctness.</p>
                    </div>
                    <span className="case-memory__badge">{comparedJobs.length} selected</span>
                  </div>
                  <div className="triage-runs__compare-picker">
                    {completedJobs.map((job) => (
                      <label key={job.id}>
                        <input
                          type="checkbox"
                          checked={compareJobIds.includes(job.id)}
                          onChange={(event) => setCompareJobIds((current) =>
                            event.target.checked
                              ? [...current, job.id]
                              : current.filter((id) => id !== job.id),
                          )}
                        />
                        {job.request.strategyId} · {statusLabel(job.status)} · {startedAtLabel(job)}
                      </label>
                    ))}
                  </div>
                  {comparedJobs.length < 2 ? (
                    <p className="case-memory__empty">Choose at least two finished runs.</p>
                  ) : (
                    <>
                      <p className={comparedRunBindingsMatch ? "triage-runs__comparison-note" : "triage-runs__comparison-note is-warning"}>
                        {comparedRunBindingsMatch
                          ? "Selected run records report one snapshot fingerprint. The Evidence Snapshot Cockpit below verifies whether the underlying snapshots also establish content equivalence."
                          : "Selected run records differ or lack settled binding proof; treat overlap as exploratory. The Evidence Snapshot Cockpit below explains the exact limitation."}
                      </p>
                      <div className="triage-runs__comparison-grid">
                        {comparedJobs.map((job) => (
                          <article className="triage-runs__comparison-card" key={job.id}>
                            <strong>{job.request.strategyId}</strong>
                            <span>{statusLabel(job.status)} · {startedAtLabel(job)}</span>
                            <ul>
                              {job.candidates.map((candidate) => (
                                <li key={candidate.candidateId}>
                                  {candidate.model} · {statusLabel(candidate.status)} · {candidate.evidenceRefs.length} evidence
                                </li>
                              ))}
                            </ul>
                          </article>
                        ))}
                      </div>
                      <div className="triage-runs__shared-evidence">
                        <strong>Shared evidence:</strong>{" "}
                        {sharedRefs.length > 0
                          ? <>
                              {sharedRefs.slice(0, INITIAL_EVIDENCE_REFS).map((ref) => evidenceLabel(ref, artifacts)).join(", ")}
                              {sharedRefs.length > INITIAL_EVIDENCE_REFS ? (
                                <details>
                                  <summary>
                                    Show {sharedRefs.length - INITIAL_EVIDENCE_REFS} more shared evidence items
                                  </summary>
                                  <ul>
                                    {sharedRefs.slice(INITIAL_EVIDENCE_REFS).map((ref) => (
                                      <li key={ref}>{evidenceLabel(ref, artifacts)}</li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                            </>
                          : "none established"}
                      </div>
                    </>
                  )}
                </section>
              ) : null}
              {cockpit}
              <div className="triage-runs__history" aria-live="polite">
              {jobs.map((job) => (
                <article
                  id={`triage-run-${job.id}`}
                  className="triage-runs__job"
                  key={job.id}
                  data-route-item={job.id}
                  data-route-kind="triage-run"
                  tabIndex={-1}
                >
                  <div className="triage-runs__job-header">
                    <div>
                      <h4>{job.request.strategyId}</h4>
                      <p className="case-memory__note">
                        {modeLabel(job.request.mode)} · {executionStateLabel(job)} ·{" "}
                        {job.candidates.length} lane
                        {job.candidates.length === 1 ? "" : "s"} · {startedAtLabel(job)}
                      </p>
                      {job.parentJobId ? (
                        <p className="case-memory__note">
                          Rerun of an earlier comparison on this investigation
                        </p>
                      ) : null}
                    </div>
                    <span className={`triage-runs__status triage-runs__status--${job.status}`}>
                      {statusLabel(job.status)}
                    </span>
                  </div>
                  <p className="triage-runs__provenance">
                    {job.sameSnapshot === true
                      ? "Same frozen snapshot"
                      : job.sameSnapshot === false
                        ? "Snapshot mismatch"
                        : "Snapshot proof pending"}
                    {job.cancelRequestedAt ? " · cancellation requested" : ""}
                    {job.requestedByUsername ? ` · requested by ${job.requestedByUsername}` : ""}
                  </p>
                  <TechnicalIdentifiers
                    className="triage-runs__identifiers"
                    record={recordNickname("run", job.id)}
                    items={[
                      { label: "Run id", value: job.id, hint: "addresses this comparison" },
                      {
                        label: "Task fingerprint",
                        value: job.request.taskFingerprint,
                        hint: "binds reruns to the same question",
                      },
                      {
                        label: "Snapshot fingerprint",
                        value: job.snapshotFingerprint,
                        hint: "binds every lane to the same frozen evidence",
                      },
                      { label: "Request fingerprint", value: job.requestFingerprint },
                      { label: "Rerun of", value: job.parentJobId },
                    ]}
                  />
                  {!isTerminal(job.status) ? (
                    <div
                      className="triage-runs__waiting"
                      role="status"
                      aria-live="polite"
                      aria-label={`${job.request.strategyId} wait state`}
                      data-run-state={runState(job, nowMs)}
                    >
                      <span>{waitingText(job, nowMs)}</span>
                      <small className="triage-runs__next-action">
                        Next: {observe(job, nowMs).nextAction}
                      </small>
                      {(waitedMs(job, nowMs) ?? 0) >= SLOW_WAIT_MS ? (
                        <small>
                          The host owns this run&apos;s deadline and will stop it on its own. You
                          can request cancellation now; lanes that already settled keep their
                          recorded results, and starting the same run again is refused while this
                          one is still in flight.
                        </small>
                      ) : null}
                    </div>
                  ) : null}
                  {isTerminal(job.status) && job.failure ? (
                    <p
                      className="case-memory__note triage-runs__refusal"
                      role="status"
                      data-run-failure={job.failure.code}
                    >
                      {triageEvidenceBudgetExplanation(job.failure)}
                    </p>
                  ) : null}
                  {isTerminal(job.status) ? (
                    <p
                      className="case-memory__note triage-runs__retry-note"
                      data-retry-disposition={retryView(job).disposition}
                    >
                      Retry: {retryView(job).reason} {retryView(job).nextAction}
                    </p>
                  ) : null}
                  {isTerminal(job.status) && producedLaneCount(job) === 0 && !job.failure ? (
                    <p className="case-memory__note triage-runs__no-result" role="status">
                      No lane produced a result on this run. There is nothing here to review or
                      compare — rerun it or read the per-lane reasons below.
                    </p>
                  ) : null}
                  <p className="case-memory__note">Lanes settle independently; final same-snapshot proof waits for all lanes.</p>
                  <div className="triage-runs__results">
                    {job.candidates.map((candidate) => (
                              <div
                                className="triage-runs__candidate"
                                key={candidate.candidateId}
                                data-route-item={`${job.id}:${candidate.candidateId}`}
                                data-route-kind="triage-candidate"
                                tabIndex={-1}
                              >
                                <div className="triage-runs__candidate-heading">
                                  <strong>{candidate.model}</strong>
                                  <span>{candidate.role} · {candidateLifecycleText(candidate.status)}</span>
                                </div>
                                {candidate.profileId ? <p className="case-memory__note">Gateway model {profileLabelFor(candidate)}</p> : null}
                                {candidate.summary ? <p>{candidate.summary}</p> : null}
                        {candidate.benchmarkRunId ? (
                          <p className="case-memory__note">
                            Recorded in the comparison workspace as{" "}
                            {recordNickname("run", candidate.benchmarkRunId)}
                          </p>
                        ) : null}
                        {candidate.evidenceRefs.length > 0 ? (
                          <div className="triage-runs__evidence-group">
                            <ul className="triage-runs__evidence" aria-label={`${candidate.model} evidence`}>
                              {candidate.evidenceRefs.slice(0, INITIAL_EVIDENCE_REFS).map((ref) => (
                                <li key={ref} title={ref}>{evidenceLabel(ref, artifacts)}</li>
                              ))}
                            </ul>
                            {candidate.evidenceRefs.length > INITIAL_EVIDENCE_REFS ? (
                              <details className="triage-runs__evidence-more">
                                <summary>Show {candidate.evidenceRefs.length - INITIAL_EVIDENCE_REFS} more cited evidence items</summary>
                                <ul className="triage-runs__evidence" aria-label={`${candidate.model} additional evidence`}>
                                  {candidate.evidenceRefs.slice(INITIAL_EVIDENCE_REFS).map((ref) => (
                                    <li key={ref} title={ref}>{evidenceLabel(ref, artifacts)}</li>
                                  ))}
                                </ul>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                        <small>
                          {candidate.evidenceRefs.length} evidence refs · usage unknown · cost unknown
                          {candidate.errorCode ? ` · ${candidate.errorCode}` : ""}
                        </small>
                      </div>
                    ))}
                  </div>
                  <div className="triage-runs__job-footer">
                    <div>
                      <small>{job.agreementNotice}</small>
                      <div className="triage-runs__progress" aria-label={`${job.id} lane progress`}>
                        <progress max={laneCounts(job).total} value={laneCounts(job).settled} />
                        <small>
                          {laneCounts(job).settled}/{laneCounts(job).total} lanes settled ·{" "}
                          {laneCounts(job).running} running · {laneCounts(job).queued} queued ·{" "}
                          {laneCounts(job).produced} produced a result
                        </small>
                      </div>
                    </div>
                    {!props.readOnly && props.canLead && isTerminal(job.status) ? (
                      <button className="case-memory__secondary-button" type="button" onClick={() => reuse(job)}>
                        Use this setup again
                      </button>
                    ) : null}
                    {!props.readOnly && props.canLead && isReviewable(job) ? (
                      <button
                        className="case-memory__secondary-button triage-runs__handoff-button"
                        type="button"
                        disabled={handoffJobId !== null}
                        onClick={() => void reviewInExperimentLab(job.id)}
                      >
                        {handoffJobId === job.id ? "Preparing review…" : "Review in Experiment Lab"}
                      </button>
                    ) : null}
                    {!props.readOnly && props.canLead && (job.status === "queued" || job.status === "running") ? (
                      <button className="case-memory__secondary-button" type="button" onClick={() => void cancel(job.id)}>
                        Request cancellation
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
