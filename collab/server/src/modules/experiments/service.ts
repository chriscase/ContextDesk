import { randomUUID } from "node:crypto";
import {
  AGREEMENT_NOT_CORRECTNESS,
  CANDIDATE_ROLES,
  EXPERIMENT_DECISION_SCHEMA_ID,
  EXPERIMENT_PACKAGE_SCHEMA_ID,
  GOLD_IS_HUMAN_BENCHMARK,
  GOLD_REFERENCE_SCHEMA_ID,
  HELPFULNESS_DIMENSIONS,
  HELPFULNESS_OBSERVATION_SCHEMA_ID,
  INTERACTION_TRACE_SCHEMA_ID,
  STRATEGY_PACKAGE_SCHEMA_ID,
  TRACE_UNKNOWN_STAYS_UNKNOWN,
  goldPromotionFingerprint,
  parseExperimentDecision,
  parseGoldReference,
  parseHelpfulnessObservation,
  parseInteractionTrace,
  parseLabExportV2,
  parseLabImport,
  parsePlainTranscript,
  PLAIN_TRANSCRIPT_SCHEMA_ID,
  buildStrategyComparison,
  boundExcerpt,
  extractPlainTranscript,
  projectShareSafeTrace,
  sha256Hex,
  traceFingerprint,
  type CandidateGoldAlignmentV1,
  type CandidateRole,
  type ExpectedRelationshipV1,
  type ExperimentAgreementV1,
  type ExperimentCandidateV1,
  type ExperimentDecisionV1,
  type ExperimentPackageV1,
  type ExperimentRunStatus,
  type ExperimentSummaryV1,
  type ExternalRunV1,
  type GoldReferenceV1,
  type HelpfulnessDimension,
  type HelpfulnessObservationV1,
  type InteractionTraceV1,
  type NormalizedExperimentDecisionV1,
  type StrategyComparisonV1,
  type TriageJobV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { Actor, CaseService } from "../cases/index.js";
import { alignExperimentCandidates, knownAgreementEvidence } from "./align.js";
import { projectCandidateMatrix, projectExperimentLabExport } from "./project.js";
import {
  MemoryExperimentStore,
  type ExperimentRow,
  type ExperimentSnapshotProof,
  type ExperimentStore,
  type LatestProposedDecisionRow,
  type ListOverviewProposedQuery,
} from "./store.js";

const UNKNOWN_SNAPSHOT_PROOF: ExperimentSnapshotProof = {
  basis: "unknown",
  fairnessClass: "unknown",
  lineageClass: "unknown",
};

export class ExperimentConflictError extends Error {
  readonly code:
    | "revision_conflict"
    | "sequence_conflict"
    | "already_accepted"
    | "stale_revision"
    | "stale_gold"
    | "trace_conflict"
    | "source_not_ready";

  constructor(code: ExperimentConflictError["code"], message: string) {
    super(message);
    this.name = "ExperimentConflictError";
    this.code = code;
  }
}

export class ExperimentNotFoundError extends Error {
  constructor(message = "experiment not found") {
    super(message);
    this.name = "ExperimentNotFoundError";
  }
}

function isDecisionRevisionConflict(error: unknown): boolean {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === "23505"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /decision revision already exists|duplicate key.*experiment_decisions/i.test(message);
}

function isAnnotationSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /annotation sequence already exists/i.test(message);
}

export interface ExperimentView {
  id: string;
  caseId: string;
  packageId: string;
  sourceSchemaId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  snapshotProof: ExperimentSnapshotProof;
  createdAt: string;
  importerUsername: string;
  candidates: ReturnType<typeof projectCandidateMatrix>;
  agreement: ExperimentAgreementV1;
  observations: HelpfulnessObservationV1[];
  decisions: NormalizedExperimentDecisionV1[];
  golds: GoldReferenceV1[];
  gold: GoldReferenceV1 | null;
  alignments: CandidateGoldAlignmentV1[];
  traces: InteractionTraceV1[];
  comparison: StrategyComparisonV1;
}

export interface PromoteGoldInput {
  decisionId: string;
  expectedRevision: number;
  expectedGoldVersion?: number | null;
  evidenceAnchors: string[];
  expectedRelationships?: ExpectedRelationshipV1[];
  helpfulnessDimensions?: HelpfulnessDimension[];
  notes?: string[];
}

function emptyAgreement(): ExperimentAgreementV1 {
  return {
    sharedAnchors: [],
    candidateSpecific: [],
    roleConflicts: [],
    notes: [AGREEMENT_NOT_CORRECTNESS],
  };
}

function withCaveat(agreement: ExperimentAgreementV1): ExperimentAgreementV1 {
  const notes = agreement.notes.includes(AGREEMENT_NOT_CORRECTNESS)
    ? [...agreement.notes]
    : [AGREEMENT_NOT_CORRECTNESS, ...agreement.notes];
  return { ...agreement, notes };
}

function canonicalFingerprint(value: string, prefix: "task" | "snap"): string {
  const normalized = value.trim().toLowerCase();
  const digest = normalized.startsWith(`${prefix}-`)
    ? normalized.slice(prefix.length + 1)
    : normalized;
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(
      `${prefix === "task" ? "taskFingerprint" : "snapshotFingerprint"} must contain a SHA-256 digest`,
    );
  }
  return `${prefix}-${digest}`;
}

function canonicalTimestamp(value: string, path: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${path} must be a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function canonicalDigest(value: string | null, path: string): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${path} must be a SHA-256 digest`);
  }
  return normalized;
}

function canonicalEnvelope<T extends ExperimentPackageV1 | ExperimentSummaryV1>(
  envelope: T,
): T {
  return {
    ...envelope,
    taskFingerprint: canonicalFingerprint(envelope.taskFingerprint, "task"),
    snapshotFingerprint: canonicalFingerprint(envelope.snapshotFingerprint, "snap"),
  };
}

function canonicalTrace(trace: InteractionTraceV1): InteractionTraceV1 {
  return {
    ...trace,
    rawHash: canonicalDigest(trace.rawHash, "rawHash"),
    createdAt: canonicalTimestamp(trace.createdAt, "createdAt"),
    events: trace.events.map((event, index) => ({
      ...event,
      excerptHash: canonicalDigest(event.excerptHash, `events[${index}].excerptHash`),
      observedAt:
        event.observedAt.status === "observed"
          ? {
              status: "observed",
              timestamp: canonicalTimestamp(
                event.observedAt.timestamp,
                `events[${index}].observedAt.timestamp`,
              ),
            }
          : { status: "unknown" },
    })),
  };
}

function prepareTraceForStorage(trace: InteractionTraceV1): InteractionTraceV1 {
  return projectShareSafeTrace(canonicalTrace(trace));
}

function packageFingerprint(value: string, prefix: "task" | "snap"): string {
  const normalized = value.trim().toLowerCase();
  const digest = normalized.startsWith(`${prefix}-`)
    ? normalized.slice(prefix.length + 1)
    : normalized;
  return /^[a-f0-9]{64}$/.test(digest)
    ? `${prefix}-${digest}`
    : `${prefix}-${sha256Hex(value)}`;
}

function experimentRole(value: string): CandidateRole {
  const normalized = value.trim().toLowerCase();
  return (CANDIDATE_ROLES as readonly string[]).includes(normalized)
    ? (normalized as CandidateRole)
    : "contributor";
}

function experimentRunStatus(value: TriageJobV1["candidates"][number]["status"]): ExperimentRunStatus {
  if (value === "completed") return "completed";
  if (value === "partial") return "partial";
  if (value === "timed_out") return "timeout";
  return "failed";
}

function observedLatency(
  startedAt: string | null,
  finishedAt: string | null,
): ExperimentCandidateV1["observedLatency"] {
  if (!startedAt || !finishedAt) return { status: "unknown" };
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
    return { status: "unknown" };
  }
  return { status: "observed", milliseconds: finish - start };
}

function agreementFromTraces(
  candidates: ExperimentCandidateV1[],
  traces: InteractionTraceV1[],
  notes: string[],
): ExperimentAgreementV1 {
  const refs = new Map<string, string[]>();
  for (const trace of traces) {
    for (const ref of new Set(trace.events.flatMap((event) => event.evidenceRefs))) {
      const candidateIds = refs.get(ref) ?? [];
      candidateIds.push(trace.candidateId);
      refs.set(ref, candidateIds);
    }
  }
  const sharedAnchors = [...refs.entries()]
    .filter(([, candidateIds]) => candidateIds.length > 1)
    .map(([evidenceRef, candidateIds]) => ({
      evidenceRef,
      role: "evidence",
      candidateIds: [...candidateIds].sort(),
    }));
  const candidateSpecific = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    evidenceRefs: [...refs.entries()]
      .filter(([, candidateIds]) => candidateIds.length === 1 && candidateIds[0] === candidate.candidateId)
      .map(([evidenceRef]) => evidenceRef)
      .sort(),
  }));
  return {
    sharedAnchors,
    candidateSpecific,
    roleConflicts: [],
    notes: [AGREEMENT_NOT_CORRECTNESS, ...notes],
  };
}

function connectedTrace(
  job: TriageJobV1,
  candidate: TriageJobV1["candidates"][number],
  experimentCandidateId: string,
): InteractionTraceV1 {
  const questionExcerpt = boundExcerpt(job.request.question);
  const responseExcerpt = boundExcerpt(candidate.summary ?? "");
  return parseInteractionTrace({
    schemaId: INTERACTION_TRACE_SCHEMA_ID,
    traceId: `trace-${experimentCandidateId}-${sha256Hex(job.id).slice(0, 12)}`,
    candidateId: experimentCandidateId,
    sourceKind: "programmatic",
    completeness: "partial",
    privacyClass: "share_safe",
    rawHash: candidate.outputHash,
    events: [
      {
        eventId: `evt-${experimentCandidateId}-question`,
        sequence: 1,
        kind: "question",
        actor: "human",
        role: null,
        parentEventId: null,
        evidenceRefs: [],
        observedAt: { status: "unknown" },
        excerpt: questionExcerpt,
        excerptHash: questionExcerpt ? sha256Hex(job.request.question) : null,
        unknowns: [...(questionExcerpt ? [] : ["text"]), "timestamp"],
      },
      {
        eventId: `evt-${experimentCandidateId}-answer`,
        sequence: 2,
        kind: "assistant_response",
        actor: "assistant",
        role: candidate.role,
        parentEventId: `evt-${experimentCandidateId}-question`,
        evidenceRefs: [...candidate.evidenceRefs],
        observedAt: { status: "unknown" },
        excerpt: responseExcerpt,
        excerptHash: candidate.outputHash,
        unknowns: ["timestamp", "raw answer", "tools"],
      },
    ],
    efficiency: {
      turnCount: { status: "unknown" },
      evidenceAcquisitionSteps: { status: "unknown" },
      latency: observedLatency(candidate.startedAt, candidate.finishedAt),
      cost: { status: "unknown" },
      providerCalls: { status: "unknown" },
    },
    unknowns: ["question path", "raw answer", "tools", "usage", "cost"],
    notes: [
      TRACE_UNKNOWN_STAYS_UNKNOWN,
      "Connected ContextDesk run exposes only bounded evidence-linked claims; the raw answer remains host-owned.",
    ],
    createdAt: candidate.finishedAt ?? job.createdAt,
  });
}

function pastedChatTrace(
  externalRun: ExternalRunV1,
  candidateId: string,
): InteractionTraceV1 {
  const extracted = extractPlainTranscript(externalRun.outputText, candidateId, externalRun.createdAt);
  if (!externalRun.promptText) return extracted;
  const questionId = `evt-${candidateId}-supplied-question`;
  const question = {
    eventId: questionId,
    sequence: 1,
    kind: "question" as const,
    actor: "human" as const,
    role: null,
    parentEventId: null,
    evidenceRefs: [],
    observedAt: { status: "unknown" as const },
    excerpt: boundExcerpt(externalRun.promptText),
    excerptHash: sha256Hex(externalRun.promptText),
    unknowns: ["timestamp"],
  };
  const events = extracted.events.map((event, index) => ({
    ...event,
    sequence: event.sequence + 1,
    parentEventId: index === 0 ? questionId : event.parentEventId,
  }));
  return parseInteractionTrace({
    ...extracted,
    completeness: "partial",
    events: [question, ...events],
    notes: [
      ...extracted.notes,
      "The prompt was supplied separately from the pasted transcript; the response path remains only as complete as the pasted output proves.",
    ],
  });
}

export class ExperimentService {
  private readonly store: ExperimentStore;

  constructor(
    private readonly deps: {
      cases: CaseService;
      audit: AuditStore;
      experiments?: ExperimentStore;
    },
  ) {
    this.store = deps.experiments ?? new MemoryExperimentStore();
  }

  private async withExperimentAtomic<T>(operation: () => Promise<T>): Promise<T> {
    const memory = this.store instanceof MemoryExperimentStore ? this.store : null;
    return this.deps.cases.withAtomic(async () => {
      // SQLite wraps every method as async; capture/restore must be awaited
      // or restore receives a Promise and throws DataCloneError.
      const snapshot = memory ? await Promise.resolve(memory.capture()) : undefined;
      try {
        return await operation();
      } catch (error) {
        if (memory && snapshot !== undefined) {
          await Promise.resolve(memory.restore(snapshot));
        }
        throw error;
      }
    });
  }

  async importEnvelope(
    caseId: string,
    actor: Actor,
    raw: unknown,
    origin: string,
    isAdmin: boolean,
    hostSnapshotProof: ExperimentSnapshotProof = UNKNOWN_SNAPSHOT_PROOF,
  ): Promise<ExperimentView> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new ExperimentNotFoundError("case not found");
    }
    const parsed = parseLabImport(raw);
    const envelope = canonicalEnvelope(
      parsed.kind === "strategy" ? parsed.package.experiment : parsed.envelope,
    );
    // Validate and privacy-project every trace before any experiment, timeline,
    // audit, or trace row is written. Strategy-package import is fail-closed.
    const preparedTraces =
      parsed.kind === "strategy"
        ? parsed.package.traces.map((trace) => prepareTraceForStorage(trace))
        : [];
    return this.withExperimentAtomic(async () => {
    const existing = await this.store.findByPackage(caseId, envelope.packageId);
    if (existing) {
      await this.deps.audit.append({
        identity: actor.id,
        action: "experiment_import_idempotent",
        target: existing.id,
        origin,
        outcome: "success",
      });
      if (parsed.kind === "strategy") {
        for (const trace of preparedTraces) {
          await this.attachParsedTrace(existing, actor, trace, origin);
        }
      }
      return this.toView(existing);
    }

    const agreement =
      envelope.schemaId === "cd-collab.experiment_package.v1"
        ? withCaveat((envelope as ExperimentPackageV1).agreement)
        : (envelope as ExperimentSummaryV1).agreement
          ? withCaveat((envelope as ExperimentSummaryV1).agreement as ExperimentAgreementV1)
          : emptyAgreement();

    const now = new Date().toISOString();
    const row: ExperimentRow = {
      id: randomUUID(),
      caseId,
      packageId: envelope.packageId,
      sourceSchemaId: envelope.schemaId,
      taskFingerprint: envelope.taskFingerprint,
      snapshotFingerprint: envelope.snapshotFingerprint,
      snapshotProof: { ...hostSnapshotProof },
      candidates: envelope.candidates.map((c) => ({
        ...c,
        helpfulnessState: "unreviewed",
        goldState: c.goldState === "absent" ? "absent" : "unknown",
        cost: { status: "unknown" },
        usage: { status: "unknown" },
      })),
      agreement,
      createdAt: now,
      importerId: actor.id,
      importerUsername: actor.username,
    };
    await this.store.insert(row);
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "experiment_imported",
      actor,
      targetId: row.id,
      clientTime: null,
      payload: {
        packageId: row.packageId,
        sourceSchemaId: row.sourceSchemaId,
        candidateCount: row.candidates.length,
      },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_import",
      target: row.id,
      origin,
      outcome: "success",
    });
    if (parsed.kind === "strategy") {
      for (const trace of preparedTraces) {
        await this.attachParsedTrace(row, actor, trace, origin);
      }
    }
    return this.toView(row);
    });
  }

  async list(caseId: string, actor: Actor, isAdmin: boolean): Promise<ExperimentView[]> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return [];
    const rows = await this.store.listByCase(caseId);
    const out: ExperimentView[] = [];
    for (const row of rows) out.push(await this.toView(row));
    return out;
  }

  async listOverviewProposed(
    query: ListOverviewProposedQuery,
  ): Promise<LatestProposedDecisionRow[]> {
    return this.store.listOverviewProposed(query);
  }

  /**
   * Join a completed ContextDesk-owned job with an optional pasted chat run
   * in one reviewable Experiment Lab artifact. This is intentionally an
   * import/projection step: it never invents helpfulness, gold, agreement, or
   * a definitive answer from either source.
   */
  async importTriageJob(
    caseId: string,
    actor: Actor,
    job: TriageJobV1,
    externalRun: ExternalRunV1 | null,
    origin: string,
    isAdmin: boolean,
  ): Promise<ExperimentView> {
    if (job.caseId !== caseId) throw new ExperimentNotFoundError("triage job not found");
    if (job.status !== "completed" && job.status !== "partial") {
      throw new ExperimentConflictError(
        "source_not_ready",
        "only completed or partial triage jobs can enter Experiment Lab",
      );
    }
    const successfulCandidates = job.candidates.filter(
      (candidate) => candidate.status === "completed" || candidate.status === "partial",
    );
    if (successfulCandidates.length === 0) {
      throw new ExperimentConflictError(
        "source_not_ready",
        "triage job has no completed or partial candidate to compare",
      );
    }
    if (externalRun && externalRun.caseId !== caseId) {
      throw new ExperimentNotFoundError("external run not found");
    }
    if (
      externalRun?.snapshotBinding &&
      externalRun.snapshotBinding !== job.snapshotFingerprint
    ) {
      throw new Error("pasted chat is bound to a different snapshot");
    }
    const frozenSnapshot = (await this.deps.cases.listSnapshots(caseId, actor, isAdmin)).find(
      (snapshot) =>
        snapshot.id === job.snapshotId && snapshot.fingerprint === job.snapshotFingerprint,
    );
    const snapshotProof: ExperimentSnapshotProof =
      frozenSnapshot && (!externalRun || externalRun.snapshotBinding === job.snapshotFingerprint)
        ? {
            basis: "host_frozen_snapshot",
            fairnessClass: frozenSnapshot.fairnessClass,
            lineageClass: frozenSnapshot.parentSnapshotId ? "derived" : "root",
          }
        : UNKNOWN_SNAPSHOT_PROOF;

    const connectedCandidates = job.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      modelLabel: candidate.model,
      role: experimentRole(candidate.role),
      runStatus: experimentRunStatus(candidate.status),
      observedLatency: observedLatency(candidate.startedAt, candidate.finishedAt),
      cost: { status: "unknown" } as const,
      usage: { status: "unknown" } as const,
      helpfulnessState: "unreviewed" as const,
      goldState: "unknown" as const,
    }));
    const connectedTraces = successfulCandidates.map((candidate) =>
      connectedTrace(job, candidate, candidate.candidateId),
    );
    const candidates = [...connectedCandidates];
    const traces = [...connectedTraces];
    const notes = [
      "Connected ContextDesk lanes and pasted chat are compared as candidates, not as proof of correctness.",
    ];
    if (job.candidates.some((candidate) => candidate.status !== "completed" && candidate.status !== "partial")) {
      notes.push("Failed, timed-out, or cancelled lanes remain visible without an invented trace or answer.");
    }
    if (externalRun) {
      const chatCandidateId = `chat-${externalRun.id}`;
      const chatTrace = pastedChatTrace(externalRun, chatCandidateId);
      candidates.push({
        candidateId: chatCandidateId,
        modelLabel: externalRun.model ?? "Pasted chat session",
        role: "single",
        runStatus: "completed",
        observedLatency: { status: "unknown" },
        cost: { status: "unknown" },
        usage: { status: "unknown" },
        helpfulnessState: "unreviewed",
        goldState: "unknown",
      });
      traces.push(chatTrace);
      notes.push(
        externalRun.promptText
          ? "The pasted chat includes a supplied prompt; its question path and tool history remain only as complete as the transcript proves."
          : "The pasted chat has no supplied prompt; question path and workflow context remain unknown.",
      );
      if (!externalRun.snapshotBinding) {
        notes.push("The pasted chat has no exact snapshot binding; treat snapshot fairness as unknown for that candidate.");
      }
    }

    const envelope: ExperimentPackageV1 = {
      schemaId: EXPERIMENT_PACKAGE_SCHEMA_ID,
      packageId: `pkg-triage-${job.id}${externalRun ? `-${externalRun.id}` : ""}`,
      privacyClass: "share_safe",
      taskFingerprint: packageFingerprint(job.request.taskFingerprint, "task"),
      snapshotFingerprint: packageFingerprint(job.snapshotFingerprint, "snap"),
      candidates,
      agreement: agreementFromTraces(candidates, traces, notes),
    };
    return this.importEnvelope(
      caseId,
      actor,
      {
        schemaId: STRATEGY_PACKAGE_SCHEMA_ID,
        privacyClass: "share_safe",
        experiment: envelope,
        traces,
      },
      origin,
      isAdmin,
      snapshotProof,
    );
  }

  async get(
    caseId: string,
    experimentId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ExperimentView | null> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return null;
    const row = await this.store.get(experimentId);
    if (!row || row.caseId !== caseId) return null;
    return this.toView(row);
  }

  async recordHelpfulness(
    caseId: string,
    experimentId: string,
    actor: Actor,
    input: {
      candidateId: string;
      dimension: HelpfulnessDimension;
      score: number;
      rationale: string;
      evidenceRefs: string[];
    },
    origin: string,
    isAdmin: boolean,
  ): Promise<HelpfulnessObservationV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    if (!row.candidates.some((c) => c.candidateId === input.candidateId)) {
      throw new Error("unknown candidateId");
    }
    await this.assertExportableEvidenceRefs(row, input.evidenceRefs);
    const observation = parseHelpfulnessObservation({
      schemaId: HELPFULNESS_OBSERVATION_SCHEMA_ID,
      id: randomUUID(),
      experimentId,
      candidateId: input.candidateId,
      dimension: input.dimension,
      score: input.score,
      rationale: input.rationale,
      evidenceRefs: input.evidenceRefs,
      reviewerId: actor.id,
      reviewerUsername: actor.username,
      createdAt: new Date().toISOString(),
    });
    return this.withExperimentAtomic(async () => {
    await this.store.insertObservation(observation);
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "experiment_helpfulness_recorded",
      actor,
      targetId: observation.id,
      clientTime: null,
      payload: {
        observationId: observation.id,
        candidateId: observation.candidateId,
        dimension: observation.dimension,
      },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_helpfulness",
      target: observation.id,
      origin,
      outcome: "success",
    });
    return observation;
    });
  }

  async proposeDecision(
    caseId: string,
    experimentId: string,
    actor: Actor,
    input: {
      text: string;
      rationale: string;
      evidenceRefs: string[];
      owner?: Actor | null;
      remainingUnknowns?: string[];
      expectedRevision?: number | null;
    },
    origin: string,
    isAdmin: boolean,
  ): Promise<NormalizedExperimentDecisionV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    return this.withExperimentAtomic(async () => {
    const history = await this.store.listDecisions(experimentId);
    const latest = history.at(-1) ?? null;
    if (latest?.status === "accepted") {
      throw new ExperimentConflictError("already_accepted", "accepted decision is immutable");
    }
    this.assertExpectedRevision(latest, input.expectedRevision, history.length === 0);
    await this.assertExportableEvidenceRefs(row, input.evidenceRefs);
    const revision = latest ? latest.revision + 1 : 1;
    const decision = parseExperimentDecision({
      schemaId: EXPERIMENT_DECISION_SCHEMA_ID,
      id: latest?.id ?? randomUUID(),
      experimentId,
      status: "proposed",
      revision,
      predecessorRevision: latest ? latest.revision : null,
      text: input.text,
      rationale: input.rationale,
      evidenceRefs: input.evidenceRefs,
      packageId: row.packageId,
      authorId: actor.id,
      authorUsername: actor.username,
      ownerId: input.owner === undefined ? latest?.ownerId ?? null : input.owner?.id ?? null,
      ownerUsername:
        input.owner === undefined ? latest?.ownerUsername ?? null : input.owner?.username ?? null,
      remainingUnknowns:
        input.remainingUnknowns === undefined
          ? [...(latest?.remainingUnknowns ?? [])]
          : input.remainingUnknowns,
      createdAt: new Date().toISOString(),
    });
    try {
      await this.store.insertDecision(decision);
    } catch (error) {
      if (isDecisionRevisionConflict(error)) {
        throw new ExperimentConflictError("revision_conflict", "decision revision already exists");
      }
      throw error;
    }
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "experiment_decision_proposed",
      actor,
      targetId: experimentId,
      clientTime: null,
      payload: { decisionId: decision.id, revision: decision.revision, packageId: row.packageId },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_decision_propose",
      target: `${decision.id}:${decision.revision}`,
      origin,
      outcome: "success",
    });
    return decision;
    });
  }

  async acceptDecision(
    caseId: string,
    experimentId: string,
    actor: Actor,
    expectedRevision: number,
    origin: string,
    isAdmin: boolean,
  ): Promise<NormalizedExperimentDecisionV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    return this.withExperimentAtomic(async () => {
    const history = await this.store.listDecisions(experimentId);
    const latest = history.at(-1) ?? null;
    if (!latest) throw new Error("no proposed decision");
    if (latest.status === "accepted") {
      throw new ExperimentConflictError("already_accepted", "accepted decision is immutable");
    }
    if (latest.revision !== expectedRevision) {
      throw new ExperimentConflictError(
        "stale_revision",
        `expected revision ${latest.revision}`,
      );
    }
    const accepted = parseExperimentDecision({
      ...latest,
      status: "accepted",
      revision: latest.revision + 1,
      predecessorRevision: latest.revision,
      authorId: actor.id,
      authorUsername: actor.username,
      createdAt: new Date().toISOString(),
      packageId: row.packageId,
    });
    try {
      await this.store.insertDecision(accepted);
    } catch (error) {
      if (isDecisionRevisionConflict(error)) {
        throw new ExperimentConflictError("revision_conflict", "decision revision already exists");
      }
      throw error;
    }
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "experiment_decision_accepted",
      actor,
      targetId: experimentId,
      clientTime: null,
      payload: {
        decisionId: accepted.id,
        revision: accepted.revision,
        packageId: row.packageId,
        predecessor: latest.revision,
      },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_decision_accept",
      target: `${accepted.id}:${accepted.revision}`,
      origin,
      outcome: "success",
    });
    return accepted;
    });
  }

  async exportShareSafe(
    caseId: string,
    experimentId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ReturnType<typeof parseLabExportV2>> {
    const view = await this.get(caseId, experimentId, actor, isAdmin);
    if (!view) throw new ExperimentNotFoundError();
    return projectExperimentLabExport(view);
  }

  async importTrace(
    caseId: string,
    experimentId: string,
    actor: Actor,
    raw: unknown,
    origin: string,
    isAdmin: boolean,
  ): Promise<InteractionTraceV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    return this.withExperimentAtomic(async () => {
    if (
      raw &&
      typeof raw === "object" &&
      "schemaId" in raw &&
      (raw as { schemaId: unknown }).schemaId === PLAIN_TRANSCRIPT_SCHEMA_ID
    ) {
      const plain = parsePlainTranscript(raw);
      if (!row.candidates.some((c) => c.candidateId === plain.candidateId)) {
        throw new Error("unknown candidateId");
      }
      const extracted = extractPlainTranscript(plain.text, plain.candidateId, new Date().toISOString());
      return this.attachParsedTrace(row, actor, extracted, origin);
    }
    if (
      raw &&
      typeof raw === "object" &&
      "schemaId" in raw &&
      (raw as { schemaId: unknown }).schemaId === INTERACTION_TRACE_SCHEMA_ID
    ) {
      const trace = parseInteractionTrace(raw);
      if (!row.candidates.some((c) => c.candidateId === trace.candidateId)) {
        throw new Error("unknown candidateId");
      }
      return this.attachParsedTrace(row, actor, trace, origin);
    }
    throw new Error("expected interaction trace or plain transcript");
    });
  }

  async annotateTrace(
    caseId: string,
    experimentId: string,
    actor: Actor,
    input: { candidateId: string; text: string; evidenceRefs?: string[]; parentEventId?: string | null },
    origin: string,
    isAdmin: boolean,
  ): Promise<InteractionTraceV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    if (!row.candidates.some((c) => c.candidateId === input.candidateId)) {
      throw new Error("unknown candidateId");
    }
    if (!input.text.trim()) throw new Error("annotation text is required");
    const annotationId = randomUUID();
    return this.withExperimentAtomic(async () => {
    await this.store.lockExperiment(row.id);
    const current = await this.store.findTrace(row.id, input.candidateId);
    if (!current) throw new Error("import a trace before annotating");
    const annotations = await this.store.listAnnotations(row.id);
    const merged = mergeAnnotations(current, annotations);
    const nextSeq = (merged.events.at(-1)?.sequence ?? 0) + 1;
    try {
      await this.store.insertAnnotation({
        id: annotationId,
        experimentId: row.id,
        candidateId: input.candidateId,
        event: {
          eventId: `ann-${annotationId}`,
          sequence: nextSeq,
          kind: "human_annotation",
          actor: "human",
          role: null,
          parentEventId: input.parentEventId ?? merged.events.at(-1)?.eventId ?? null,
          evidenceRefs: input.evidenceRefs ?? [],
          observedAt: { status: "unknown" },
          excerpt: input.text.trim().slice(0, 240),
          excerptHash: null,
          unknowns: ["timestamp"],
        },
        authorId: actor.id,
        authorUsername: actor.username,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if (isAnnotationSequenceConflict(error)) {
        throw new ExperimentConflictError(
          "sequence_conflict",
          "annotation sequence already exists",
        );
      }
      throw error;
    }
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_trace_annotate",
      target: `${row.id}:${input.candidateId}`,
      origin,
      outcome: "success",
    });
    const view = await this.toView(row);
    const trace = view.traces.find((item) => item.candidateId === input.candidateId);
    if (!trace) throw new Error("trace not found after annotation");
    return trace;
    });
  }

  private async attachParsedTrace(
    row: ExperimentRow,
    actor: Actor,
    incoming: InteractionTraceV1,
    origin: string,
  ): Promise<InteractionTraceV1> {
    const safe = prepareTraceForStorage(incoming);
    const fingerprint = traceFingerprint(safe);
    const existing = await this.store.findTrace(row.id, safe.candidateId);
    if (existing) {
      if (traceFingerprint(existing) === fingerprint) {
        await this.deps.audit.append({
          identity: actor.id,
          action: "experiment_trace_import_idempotent",
          target: existing.traceId,
          origin,
          outcome: "success",
        });
        return existing;
      }
      throw new ExperimentConflictError(
        "trace_conflict",
        "candidate already has a different interaction trace",
      );
    }
    await this.store.insertTrace(row.id, safe, fingerprint);
    await this.deps.cases.appendDomainTimeline(row.caseId, {
      kind: "experiment_trace_imported",
      actor,
      targetId: row.id,
      clientTime: null,
      payload: { traceId: safe.traceId, candidateId: safe.candidateId, sourceKind: safe.sourceKind },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_trace_import",
      target: safe.traceId,
      origin,
      outcome: "success",
    });
    return safe;
  }

  async promoteGold(
    caseId: string,
    experimentId: string,
    actor: Actor,
    input: PromoteGoldInput,
    origin: string,
    isAdmin: boolean,
  ): Promise<GoldReferenceV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    const history = await this.store.listDecisions(experimentId);
    const accepted = [...history]
      .reverse()
      .find((decision) => decision.id === input.decisionId && decision.status === "accepted");
    if (!accepted) {
      const proposed = history.some((decision) => decision.id === input.decisionId);
      if (proposed) {
        throw new Error("proposed decisions cannot be promoted to gold");
      }
      throw new ExperimentNotFoundError("decision not found");
    }
    if (accepted.revision !== input.expectedRevision) {
      throw new ExperimentConflictError(
        "stale_revision",
        `expected revision ${accepted.revision}`,
      );
    }
    if (input.evidenceAnchors.length === 0) {
      throw new Error("at least one evidence anchor is required");
    }
    await this.assertExportableEvidenceRefs(row, input.evidenceAnchors);
    if (input.helpfulnessDimensions) {
      for (const dimension of input.helpfulnessDimensions) {
        if (!(HELPFULNESS_DIMENSIONS as readonly string[]).includes(dimension)) {
          throw new Error(`unknown helpfulness dimension ${dimension}`);
        }
      }
    }

    return this.withExperimentAtomic(async () => {
    const golds = await this.store.listGolds(experimentId);
    const fingerprint = goldPromotionFingerprint({
      acceptedDecisionId: accepted.id,
      acceptedDecisionRevision: accepted.revision,
      evidenceAnchors: input.evidenceAnchors,
      ...(input.expectedRelationships
        ? { expectedRelationships: input.expectedRelationships }
        : {}),
      ...(input.helpfulnessDimensions
        ? { helpfulnessDimensions: input.helpfulnessDimensions }
        : {}),
    });
    const same = golds.find((gold) => goldPromotionFingerprint(gold) === fingerprint);
    if (same) {
      await this.deps.audit.append({
        identity: actor.id,
        action: "experiment_gold_promote_idempotent",
        target: `${same.goldId}:${same.version}`,
        origin,
        outcome: "success",
      });
      return same;
    }

    const latest = golds.at(-1) ?? null;
    if (latest) {
      if (input.expectedGoldVersion !== latest.version) {
        throw new ExperimentConflictError(
          "stale_gold",
          `expected gold version ${latest.version}`,
        );
      }
    } else if (
      input.expectedGoldVersion !== undefined &&
      input.expectedGoldVersion !== null &&
      input.expectedGoldVersion !== 0
    ) {
      throw new ExperimentConflictError("stale_gold", "expected gold version 0");
    }

    const goldId = randomUUID();
    const version = latest ? latest.version + 1 : 1;
    const notes = input.notes?.length
      ? input.notes.includes(GOLD_IS_HUMAN_BENCHMARK)
        ? [...input.notes]
        : [GOLD_IS_HUMAN_BENCHMARK, ...input.notes]
      : [
          GOLD_IS_HUMAN_BENCHMARK,
          "Synthetic or human-selected evidence is a benchmark decision, not a proof of correctness.",
        ];
    const gold = parseGoldReference({
      schemaId: GOLD_REFERENCE_SCHEMA_ID,
      goldId,
      version,
      predecessorGoldId: latest?.goldId ?? null,
      caseId: row.caseId,
      experimentId: row.id,
      packageId: row.packageId,
      taskFingerprint: row.taskFingerprint,
      snapshotFingerprint: row.snapshotFingerprint,
      acceptedDecisionId: accepted.id,
      acceptedDecisionRevision: accepted.revision,
      auditRefs: [
        `experiment_decision_accept:${accepted.id}:${accepted.revision}`,
        `experiment_gold_promote:${goldId}:${version}`,
      ],
      evidenceAnchors: [...input.evidenceAnchors],
      ...(input.expectedRelationships ? { expectedRelationships: input.expectedRelationships } : {}),
      ...(input.helpfulnessDimensions ? { helpfulnessDimensions: input.helpfulnessDimensions } : {}),
      notes,
      promotedById: actor.id,
      promotedByUsername: actor.username,
      createdAt: new Date().toISOString(),
    });
    await this.store.insertGold(gold);
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "experiment_gold_promoted",
      actor,
      targetId: gold.goldId,
      clientTime: null,
      payload: {
        goldId: gold.goldId,
        version: gold.version,
        acceptedDecisionId: accepted.id,
        acceptedDecisionRevision: accepted.revision,
        predecessorGoldId: gold.predecessorGoldId,
      },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "experiment_gold_promote",
      target: `${gold.goldId}:${gold.version}`,
      origin,
      outcome: "success",
    });
    return gold;
    });
  }

  private assertExpectedRevision(
    latest: ExperimentDecisionV1 | null,
    expected: number | null | undefined,
    creatingFirst: boolean,
  ): void {
    if (creatingFirst) return;
    if (expected === undefined || expected === null) {
      throw new ExperimentConflictError("revision_conflict", "expectedRevision is required");
    }
    if (!latest || latest.revision !== expected) {
      throw new ExperimentConflictError(
        "stale_revision",
        `expected revision ${latest?.revision ?? 0}`,
      );
    }
  }

  private async exportableEvidenceRefs(
    row: Pick<ExperimentRow, "id" | "agreement">,
  ): Promise<Set<string>> {
    const known = knownAgreementEvidence(row.agreement);
    const [traces, annotations] = await Promise.all([
      this.store.listTraces(row.id),
      this.store.listAnnotations(row.id),
    ]);
    for (const trace of traces) {
      for (const event of trace.events) {
        for (const ref of event.evidenceRefs) known.add(ref);
      }
    }
    for (const annotation of annotations) {
      for (const ref of annotation.event.evidenceRefs) known.add(ref);
    }
    return known;
  }

  private async assertExportableEvidenceRefs(
    row: Pick<ExperimentRow, "id" | "agreement">,
    refs: readonly string[],
  ): Promise<void> {
    if (refs.length === 0) return;
    const known = await this.exportableEvidenceRefs(row);
    for (const ref of refs) {
      if (!known.has(ref)) throw new Error(`unknown experiment evidence ${ref}`);
    }
  }

  private async requireExperiment(
    caseId: string,
    experimentId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ExperimentRow> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new ExperimentNotFoundError("case not found");
    }
    const row = await this.store.get(experimentId);
    if (!row || row.caseId !== caseId) throw new ExperimentNotFoundError();
    return row;
  }

  private async toView(row: ExperimentRow): Promise<ExperimentView> {
    const observations = await this.store.listObservations(row.id);
    const decisions = await this.store.listDecisions(row.id);
    const golds = await this.store.listGolds(row.id);
    const gold = golds.at(-1) ?? null;
    const observed = new Set(observations.map((o) => o.candidateId));
    const candidates: ExperimentCandidateV1[] = row.candidates.map((c) => ({
      ...c,
      helpfulnessState: observed.has(c.candidateId) ? "observed" : "unreviewed",
      goldState: gold ? "present" : c.goldState === "absent" ? "absent" : "unknown",
      cost: { status: "unknown" },
      usage: { status: "unknown" },
    }));
    const alignments = alignExperimentCandidates(candidates, row.agreement, gold);
    const storedTraces = await this.store.listTraces(row.id);
    const annotations = await this.store.listAnnotations(row.id);
    const traces = storedTraces.map((trace) => mergeAnnotations(trace, annotations));
    const comparison = buildStrategyComparison({
      packageId: row.packageId,
      candidates,
      traces,
      agreement: row.agreement,
      gold,
    });
    return {
      id: row.id,
      caseId: row.caseId,
      packageId: row.packageId,
      sourceSchemaId: row.sourceSchemaId,
      taskFingerprint: row.taskFingerprint,
      snapshotFingerprint: row.snapshotFingerprint,
      snapshotProof: { ...row.snapshotProof },
      createdAt: row.createdAt,
      importerUsername: row.importerUsername,
      candidates: projectCandidateMatrix(candidates, Boolean(gold)),
      agreement: row.agreement,
      observations,
      decisions,
      golds,
      gold,
      alignments,
      traces,
      comparison,
    };
  }
}

function mergeAnnotations(
  trace: InteractionTraceV1,
  annotations: {
    id?: string;
    candidateId: string;
    event: InteractionTraceV1["events"][number];
    authorUsername: string;
  }[],
): InteractionTraceV1 {
  const extra = annotations
    .filter((row) => row.candidateId === trace.candidateId)
    .slice()
    .sort((left, right) => {
      const bySequence = left.event.sequence - right.event.sequence;
      if (bySequence !== 0) return bySequence;
      return (left.id ?? "").localeCompare(right.id ?? "");
    });
  if (extra.length === 0) return trace;
  const events = [...trace.events];
  const seen = new Set(events.map((event) => event.sequence));
  for (const row of extra) {
    if (seen.has(row.event.sequence)) {
      throw new Error("annotation sequence already exists");
    }
    seen.add(row.event.sequence);
    const attributedEvent = {
      ...row.event,
      authorUsername: row.authorUsername,
      sequence: row.event.sequence,
      parentEventId: row.event.parentEventId ?? events.at(-1)?.eventId ?? null,
    } as InteractionTraceV1["events"][number] & { authorUsername: string };
    events.push(attributedEvent);
  }
  return { ...trace, events };
}
