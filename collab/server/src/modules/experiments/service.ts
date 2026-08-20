import { randomUUID } from "node:crypto";
import {
  AGREEMENT_NOT_CORRECTNESS,
  EXPERIMENT_DECISION_SCHEMA_ID,
  GOLD_IS_HUMAN_BENCHMARK,
  GOLD_REFERENCE_SCHEMA_ID,
  HELPFULNESS_DIMENSIONS,
  HELPFULNESS_OBSERVATION_SCHEMA_ID,
  goldPromotionFingerprint,
  parseExperimentDecision,
  parseGoldReference,
  parseHelpfulnessObservation,
  parseInteractionTrace,
  parseLabExportV2,
  parseLabImport,
  parsePlainTranscript,
  PLAIN_TRANSCRIPT_SCHEMA_ID,
  INTERACTION_TRACE_SCHEMA_ID,
  buildStrategyComparison,
  extractPlainTranscript,
  projectShareSafeTrace,
  traceFingerprint,
  type CandidateGoldAlignmentV1,
  type ExpectedRelationshipV1,
  type ExperimentAgreementV1,
  type ExperimentCandidateV1,
  type ExperimentDecisionV1,
  type ExperimentPackageV1,
  type ExperimentSummaryV1,
  type GoldReferenceV1,
  type HelpfulnessDimension,
  type HelpfulnessObservationV1,
  type InteractionTraceV1,
  type StrategyComparisonV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { Actor, CaseService } from "../cases/index.js";
import { alignExperimentCandidates, knownAgreementEvidence } from "./align.js";
import { projectCandidateMatrix, projectExperimentLabExport } from "./project.js";
import { MemoryExperimentStore, type ExperimentRow, type ExperimentStore } from "./store.js";

export class ExperimentConflictError extends Error {
  readonly code:
    | "revision_conflict"
    | "already_accepted"
    | "stale_revision"
    | "stale_gold"
    | "trace_conflict";

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

export interface ExperimentView {
  id: string;
  caseId: string;
  packageId: string;
  sourceSchemaId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  createdAt: string;
  importerUsername: string;
  candidates: ReturnType<typeof projectCandidateMatrix>;
  agreement: ExperimentAgreementV1;
  observations: HelpfulnessObservationV1[];
  decisions: ExperimentDecisionV1[];
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

  async importEnvelope(
    caseId: string,
    actor: Actor,
    raw: unknown,
    origin: string,
    isAdmin: boolean,
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
  }

  async list(caseId: string, actor: Actor, isAdmin: boolean): Promise<ExperimentView[]> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return [];
    const rows = await this.store.listByCase(caseId);
    const out: ExperimentView[] = [];
    for (const row of rows) out.push(await this.toView(row));
    return out;
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
    await this.store.insertObservation(observation);
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "experiment_helpfulness_recorded",
      actor,
      targetId: experimentId,
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
  }

  async proposeDecision(
    caseId: string,
    experimentId: string,
    actor: Actor,
    input: {
      text: string;
      rationale: string;
      evidenceRefs: string[];
      expectedRevision?: number | null;
    },
    origin: string,
    isAdmin: boolean,
  ): Promise<ExperimentDecisionV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
    const history = await this.store.listDecisions(experimentId);
    const latest = history.at(-1) ?? null;
    if (latest?.status === "accepted") {
      throw new ExperimentConflictError("already_accepted", "accepted decision is immutable");
    }
    this.assertExpectedRevision(latest, input.expectedRevision, history.length === 0);
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
      createdAt: new Date().toISOString(),
    });
    await this.store.insertDecision(decision);
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
  }

  async acceptDecision(
    caseId: string,
    experimentId: string,
    actor: Actor,
    expectedRevision: number,
    origin: string,
    isAdmin: boolean,
  ): Promise<ExperimentDecisionV1> {
    const row = await this.requireExperiment(caseId, experimentId, actor, isAdmin);
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
    await this.store.insertDecision(accepted);
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
    const traces = await this.store.listTraces(row.id);
    const current = traces.find((trace) => trace.candidateId === input.candidateId);
    if (!current) throw new Error("import a trace before annotating");
    const nextSeq = (current.events.at(-1)?.sequence ?? 0) + 1;
    const annotationId = randomUUID();
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
        parentEventId: input.parentEventId ?? current?.events.at(-1)?.eventId ?? null,
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
    const known = knownAgreementEvidence(row.agreement);
    if (known.size > 0) {
      for (const ref of input.evidenceAnchors) {
        if (!known.has(ref)) {
          throw new Error(`unknown evidence anchor ${ref}`);
        }
      }
    }
    if (input.helpfulnessDimensions) {
      for (const dimension of input.helpfulnessDimensions) {
        if (!(HELPFULNESS_DIMENSIONS as readonly string[]).includes(dimension)) {
          throw new Error(`unknown helpfulness dimension ${dimension}`);
        }
      }
    }

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
      targetId: experimentId,
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
    candidateId: string;
    event: InteractionTraceV1["events"][number];
    authorUsername: string;
  }[],
): InteractionTraceV1 {
  const extra = annotations.filter((row) => row.candidateId === trace.candidateId);
  if (extra.length === 0) return trace;
  let sequence = trace.events.at(-1)?.sequence ?? 0;
  const events = [...trace.events];
  for (const row of extra) {
    sequence += 1;
    const attributedEvent = {
      ...row.event,
      authorUsername: row.authorUsername,
      sequence,
      parentEventId: row.event.parentEventId ?? events.at(-1)?.eventId ?? null,
    } as InteractionTraceV1["events"][number] & { authorUsername: string };
    events.push(attributedEvent);
  }
  return { ...trace, events };
}
