import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { EvidenceSnapshotCockpit } from "./EvidenceSnapshotCockpit.js";
import { protectedApiFetch } from "./protected-api.js";
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

interface TriageCapabilitiesView {
  syntheticAvailable: boolean;
  gatewayAvailable: boolean;
  gatewayMinCandidates: number;
  gatewayMaxCandidates: number;
  profileCatalogConfigured: boolean;
  profileCount: number;
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

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "not available";
}

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

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function isTerminal(status: string): boolean {
  return ["completed", "partial", "failed", "timed_out", "cancelled"].includes(status);
}

function isReviewable(status: string): boolean {
  return status === "completed" || status === "partial";
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
  onExperimentReady?: (experimentId: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotView[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [externalChatRuns, setExternalChatRuns] = useState<ExternalChatRunView[]>([]);
  const [gatewayProfiles, setGatewayProfiles] = useState<TriageProfileOption[]>([]);
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
  const [taskFingerprint, setTaskFingerprint] = useState("demo-checkout-v1");
  const [question, setQuestion] = useState("What caused the checkout timeout and what should we inspect next?");
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
  const loadRequestToken = useRef(0);
  const launchFocusApplied = useRef<string | null>(null);
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
        ? (await profilesResponse.json()) as { profiles?: TriageProfileOption[] }
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
  const gatewayProfilesReady = mode !== "gateway"
    || selectedGatewayCandidates.every((candidate) => Boolean(profileFor(candidate)));
  const gatewayAvailable = triageCapabilities?.gatewayAvailable ?? true;

  useEffect(() => {
    if (mode === "gateway" && triageCapabilities?.gatewayAvailable === false) {
      setMode("deterministic_mock");
    }
  }, [mode, triageCapabilities]);

  function selectedProfileFor(candidate: CandidateOption): TriageProfileOption | undefined {
    const selected = (laneProfiles[candidate.candidateId] ?? candidate.profileId ?? "").trim();
    const exactSelection = gatewayProfiles.find((profile) => profile.id === selected);
    if (exactSelection) return exactSelection;

    const hostProfileId = selected || candidate.profileId || "";
    return gatewayProfiles.find((profile) =>
      (profile.profileId ?? profile.id) === hostProfileId
      && (profile.modelId === candidate.model || profile.alias === candidate.model),
    ) ?? gatewayProfiles.find((profile) =>
      profile.modelId === candidate.model || profile.alias === candidate.model,
    );
  }

  function profileFor(candidate: CandidateOption): string {
    return selectedProfileFor(candidate)?.id
      ?? (laneProfiles[candidate.candidateId] ?? candidate.profileId ?? "").trim();
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
    const profile = gatewayProfiles.find((item) =>
      (item.profileId ?? item.id) === candidate.profileId
      && (!item.modelId || item.modelId === candidate.model || item.alias === candidate.model),
    );
    return profile?.label ?? candidate.profileId;
  }

  useEffect(() => {
    if (!hasActiveJob) return undefined;
    const timer = window.setInterval(() => void load(), 500);
    return () => window.clearInterval(timer);
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
    const selectedProfile = gatewayProfiles.find((profile) => profile.id === profileSelectionId);
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
      props.onExperimentReady?.(experiment.id);
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
                          S{index} · {snapshot.evidence.length} evidence · {shortHash(snapshot.fingerprint)}
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
                    <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} />
                  </label>
                  <label className="triage-runs__field">
                    Task fingerprint
                    <input value={taskFingerprint} onChange={(event) => setTaskFingerprint(event.target.value)} />
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
                          gatewayProfiles.length > 0 ? (
                            <label className="triage-runs__lane-profile">
                              Gateway model
                              <select
                                aria-label={`${candidate.model} gateway model`}
                                value={profileFor(candidate)}
                                onChange={(event) => setLaneProfiles((current) => ({ ...current, [candidate.candidateId]: event.target.value }))}
                              >
                                <option value="" disabled>Select a profile</option>
                                {gatewayProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.label} · {profile.provider}
                                  </option>
                                ))}
                              </select>
                            </label>
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
                          gatewayProfiles.length > 0 ? (
                            <label className="triage-runs__field">
                              Gateway model
                              <select name="laneProfile" aria-label="New lane gateway model" defaultValue="">
                                <option value="" disabled>
                                  Select a profile
                                </option>
                                {gatewayProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.label} · {profile.provider}
                                  </option>
                                ))}
                              </select>
                            </label>
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
                    disabled={running || !selectedSnapshotId || selectedCandidates.length === 0 || (mode === "gateway" && (!gatewayAvailable || selectedCandidates.length < 2 || !gatewayProfilesReady))}
                    onClick={() => void launch()}
                  >
                    {running ? "Starting…" : mode === "gateway" ? "Run gateway comparison" : "Run synthetic comparison"}
                  </button>
                  {launchReceipt ? (
                    <div className="triage-runs__launch-receipt" role="status" aria-live="polite">
                      <strong>Last run recorded on the selected snapshot.</strong>
                      <span>
                        {launchReceipt.evidenceCount} frozen evidence item{launchReceipt.evidenceCount === 1 ? "" : "s"}
                        {" · snapshot "}{shortHash(launchReceipt.snapshotFingerprint)}
                        {" · run "}{shortHash(launchReceipt.jobId)}
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
                <p className="triage-runs__handoff-success" role="status">
                  Experiment {shortHash(benchImportExperimentId)} imported from the bench artifact.
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
              {completedJobs.some((job) => isReviewable(job.status)) ? (
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
                    <p className="triage-runs__handoff-success" role="status">
                      Experiment {shortHash(handoffExperimentId)} is ready in Experiment Lab.
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
                        {job.request.strategyId} · {statusLabel(job.status)} · {shortHash(job.snapshotFingerprint)}
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
                            <span>{statusLabel(job.status)} · {shortHash(job.snapshotFingerprint)}</span>
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
                        {job.request.mode} · task {shortHash(job.request.taskFingerprint)} · snapshot {shortHash(job.snapshotFingerprint)}
                      </p>
                      {job.parentJobId ? (
                        <p className="case-memory__note">Rerun of {shortHash(job.parentJobId)}</p>
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
                        : "Snapshot proof pending"} · request {shortHash(job.requestFingerprint)}
                    {job.cancelRequestedAt ? " · cancellation requested" : ""}
                    {job.requestedByUsername ? ` · requested by ${job.requestedByUsername}` : ""}
                  </p>
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
                        {candidate.benchmarkRunId ? <p className="case-memory__note">Experiment Lab run {shortHash(candidate.benchmarkRunId)}</p> : null}
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
                        <progress
                          max={job.candidates.length}
                          value={job.candidates.filter((candidate) => isTerminal(candidate.status)).length}
                        />
                        <small>
                          {job.candidates.filter((candidate) => isTerminal(candidate.status)).length}/{job.candidates.length} lanes settled
                        </small>
                      </div>
                    </div>
                    {!props.readOnly && props.canLead && isTerminal(job.status) ? (
                      <button className="case-memory__secondary-button" type="button" onClick={() => reuse(job)}>
                        Use this setup again
                      </button>
                    ) : null}
                    {!props.readOnly && props.canLead && isReviewable(job.status) ? (
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
