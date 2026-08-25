import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ExperimentAgreementV1,
  ExperimentCandidateV1,
  ExperimentDecisionV1,
  GoldReferenceV1,
  HelpfulnessObservationV1,
  InteractionEventV1,
  InteractionTraceV1,
  SnapshotFairnessClass,
  SnapshotLineageClass,
  SnapshotProofBasis,
  NormalizedExperimentDecisionV1,
} from "@cd-collab/contracts";
import {
  SNAPSHOT_FAIRNESS_CLASSES,
  SNAPSHOT_LINEAGE_CLASSES,
  SNAPSHOT_PROOF_BASES,
  parseExperimentDecision,
} from "@cd-collab/contracts";
import {
  activeCaseQueryable,
  overviewVisiblePredicate,
  type OverviewScope,
  type OverviewVisibilityBoundary,
} from "../cases/index.js";

export interface ExperimentSnapshotProof {
  basis: SnapshotProofBasis;
  fairnessClass: SnapshotFairnessClass;
  lineageClass: SnapshotLineageClass;
}

export interface TraceAnnotationRow {
  id: string;
  experimentId: string;
  candidateId: string;
  event: InteractionEventV1;
  authorId: string;
  authorUsername: string;
  createdAt: string;
}

export interface ExperimentRow {
  id: string;
  caseId: string;
  packageId: string;
  sourceSchemaId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  snapshotProof: ExperimentSnapshotProof;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1;
  createdAt: string;
  importerId: string;
  importerUsername: string;
}

export interface LatestProposedDecisionRow {
  caseId: string;
  caseTitle: string;
  experimentId: string;
  packageId: string;
  decision: NormalizedExperimentDecisionV1;
}

export interface ListOverviewProposedQuery extends OverviewScope {
  limit: number;
  authorId?: string;
  excludeAuthorId?: string;
  visibility: OverviewVisibilityBoundary | null;
}

export interface ExperimentStore {
  insert(row: ExperimentRow): Promise<void>;
  get(id: string): Promise<ExperimentRow | null>;
  findByPackage(caseId: string, packageId: string): Promise<ExperimentRow | null>;
  listByCase(caseId: string): Promise<ExperimentRow[]>;
  listOverviewProposed(query: ListOverviewProposedQuery): Promise<LatestProposedDecisionRow[]>;
  listObservations(experimentId: string): Promise<HelpfulnessObservationV1[]>;
  insertObservation(row: HelpfulnessObservationV1): Promise<void>;
  listDecisions(experimentId: string): Promise<NormalizedExperimentDecisionV1[]>;
  insertDecision(row: NormalizedExperimentDecisionV1): Promise<void>;
  listGolds(experimentId: string): Promise<GoldReferenceV1[]>;
  insertGold(row: GoldReferenceV1): Promise<void>;
  listTraces(experimentId: string): Promise<InteractionTraceV1[]>;
  findTrace(experimentId: string, candidateId: string): Promise<InteractionTraceV1 | null>;
  insertTrace(experimentId: string, row: InteractionTraceV1, fingerprint: string): Promise<void>;
  lockExperiment(experimentId: string): Promise<void>;
  listAnnotations(experimentId: string): Promise<TraceAnnotationRow[]>;
  insertAnnotation(row: TraceAnnotationRow): Promise<void>;
}

const UNKNOWN_SNAPSHOT_PROOF: ExperimentSnapshotProof = {
  basis: "unknown",
  fairnessClass: "unknown",
  lineageClass: "unknown",
};

function cloneCandidates(candidates: ExperimentCandidateV1[]): ExperimentCandidateV1[] {
  return candidates.map((c) => ({
    ...c,
    observedLatency: { ...c.observedLatency },
    cost: { ...c.cost },
    usage: { ...c.usage },
  }));
}

function cloneAgreement(agreement: ExperimentAgreementV1): ExperimentAgreementV1 {
  return {
    sharedAnchors: agreement.sharedAnchors.map((a) => ({
      ...a,
      candidateIds: [...a.candidateIds],
    })),
    candidateSpecific: agreement.candidateSpecific.map((row) => ({
      ...row,
      evidenceRefs: [...row.evidenceRefs],
    })),
    roleConflicts: agreement.roleConflicts.map((row) => ({
      ...row,
      assignments: row.assignments.map((a) => ({ ...a })),
    })),
    notes: [...agreement.notes],
  };
}

function cloneSnapshotProof(proof: ExperimentSnapshotProof): ExperimentSnapshotProof {
  return parseSnapshotProof(proof);
}

function parseSnapshotProof(raw: unknown): ExperimentSnapshotProof {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid stored experiment snapshot proof");
  }
  const proof = raw as Record<string, unknown>;
  const keys = Object.keys(proof);
  if (
    keys.length !== 3 ||
    !keys.every((key) => ["basis", "fairnessClass", "lineageClass"].includes(key))
  ) {
    throw new Error("invalid stored experiment snapshot proof fields");
  }
  if (
    typeof proof.fairnessClass !== "string" ||
    !(SNAPSHOT_FAIRNESS_CLASSES as readonly string[]).includes(proof.fairnessClass) ||
    typeof proof.lineageClass !== "string" ||
    !(SNAPSHOT_LINEAGE_CLASSES as readonly string[]).includes(proof.lineageClass) ||
    typeof proof.basis !== "string" ||
    !(SNAPSHOT_PROOF_BASES as readonly string[]).includes(proof.basis)
  ) {
    throw new Error("invalid stored experiment snapshot proof");
  }
  const parsed = {
    basis: proof.basis as SnapshotProofBasis,
    fairnessClass: proof.fairnessClass as SnapshotFairnessClass,
    lineageClass: proof.lineageClass as SnapshotLineageClass,
  };
  if (
    parsed.basis === "unknown" &&
    (parsed.fairnessClass !== "unknown" || parsed.lineageClass !== "unknown")
  ) {
    throw new Error("unknown stored snapshot proof cannot claim fairness or lineage");
  }
  if (parsed.basis === "host_frozen_snapshot" && parsed.lineageClass === "unknown") {
    throw new Error("host stored snapshot proof requires known lineage");
  }
  return parsed;
}

function cloneDecision(row: ExperimentDecisionV1): NormalizedExperimentDecisionV1 {
  return parseExperimentDecision({
    ...row,
    evidenceRefs: [...row.evidenceRefs],
  });
}

function matchesProposedQuery(
  authorId: string,
  query: Pick<ListOverviewProposedQuery, "authorId" | "excludeAuthorId">,
): boolean {
  if (query.authorId !== undefined && authorId !== query.authorId) return false;
  if (query.excludeAuthorId !== undefined && authorId === query.excludeAuthorId) return false;
  return true;
}

function sortProposed(rows: LatestProposedDecisionRow[]): LatestProposedDecisionRow[] {
  return [...rows].sort((left, right) => {
    const byTime = right.decision.createdAt.localeCompare(left.decision.createdAt);
    if (byTime !== 0) return byTime;
    const byExperiment = left.experimentId.localeCompare(right.experimentId);
    return byExperiment !== 0 ? byExperiment : left.decision.id.localeCompare(right.decision.id);
  });
}

function storedAgreement(row: ExperimentRow): object {
  return {
    publicAgreement: row.agreement,
    snapshotProof: cloneSnapshotProof(row.snapshotProof ?? UNKNOWN_SNAPSHOT_PROOF),
  };
}

function decodeStoredAgreement(raw: unknown): {
  agreement: ExperimentAgreementV1;
  snapshotProof: ExperimentSnapshotProof;
} {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if ("publicAgreement" in record || "snapshotProof" in record) {
      if (!("publicAgreement" in record) || !("snapshotProof" in record)) {
        throw new Error("incomplete stored experiment snapshot proof envelope");
      }
      if (
        Object.keys(record).length !== 2 ||
        !Object.keys(record).every((key) => ["publicAgreement", "snapshotProof"].includes(key))
      ) {
        throw new Error("invalid stored experiment snapshot proof envelope fields");
      }
      return {
        agreement: record.publicAgreement as ExperimentAgreementV1,
        snapshotProof: parseSnapshotProof(record.snapshotProof),
      };
    }
  }
  return {
    agreement: raw as ExperimentAgreementV1,
    snapshotProof: { ...UNKNOWN_SNAPSHOT_PROOF },
  };
}

function cloneTrace(row: InteractionTraceV1): InteractionTraceV1 {
  return {
    ...row,
    events: row.events.map((event) => ({
      ...event,
      evidenceRefs: [...event.evidenceRefs],
      unknowns: [...event.unknowns],
      observedAt: { ...event.observedAt },
    })),
    efficiency: {
      turnCount: { ...row.efficiency.turnCount },
      evidenceAcquisitionSteps: { ...row.efficiency.evidenceAcquisitionSteps },
      latency: { ...row.efficiency.latency },
      cost: { ...row.efficiency.cost },
      providerCalls: { ...row.efficiency.providerCalls },
    },
    unknowns: [...row.unknowns],
    notes: [...row.notes],
  };
}

function cloneGold(row: GoldReferenceV1): GoldReferenceV1 {
  return {
    ...row,
    auditRefs: [...row.auditRefs],
    evidenceAnchors: [...row.evidenceAnchors],
    ...(row.expectedRelationships
      ? { expectedRelationships: row.expectedRelationships.map((rel) => ({ ...rel })) }
      : {}),
    ...(row.helpfulnessDimensions ? { helpfulnessDimensions: [...row.helpfulnessDimensions] } : {}),
    notes: [...row.notes],
  };
}

export class MemoryExperimentStore implements ExperimentStore {
  private readonly experiments = new Map<string, ExperimentRow>();
  private readonly observations = new Map<string, HelpfulnessObservationV1[]>();
  private readonly decisions = new Map<string, NormalizedExperimentDecisionV1[]>();
  private readonly golds = new Map<string, GoldReferenceV1[]>();
  private readonly traces = new Map<string, InteractionTraceV1[]>();
  private readonly annotations = new Map<string, TraceAnnotationRow[]>();

  capture(): unknown {
    return structuredClone({
      experiments: [...this.experiments.entries()],
      observations: [...this.observations.entries()],
      decisions: [...this.decisions.entries()],
      golds: [...this.golds.entries()],
      traces: [...this.traces.entries()],
      annotations: [...this.annotations.entries()],
    });
  }

  restore(snapshot: unknown): void {
    const row = structuredClone(snapshot) as {
      experiments: [string, ExperimentRow][];
      observations: [string, HelpfulnessObservationV1[]][];
      decisions: [string, NormalizedExperimentDecisionV1[]][];
      golds: [string, GoldReferenceV1[]][];
      traces: [string, InteractionTraceV1[]][];
      annotations: [string, TraceAnnotationRow[]][];
    };
    this.experiments.clear();
    this.observations.clear();
    this.decisions.clear();
    this.golds.clear();
    this.traces.clear();
    this.annotations.clear();
    for (const [id, value] of row.experiments) this.experiments.set(id, value);
    for (const [id, value] of row.observations) this.observations.set(id, value);
    for (const [id, value] of row.decisions) this.decisions.set(id, value);
    for (const [id, value] of row.golds) this.golds.set(id, value);
    for (const [id, value] of row.traces) this.traces.set(id, value);
    for (const [id, value] of row.annotations) this.annotations.set(id, value);
  }

  async insert(row: ExperimentRow): Promise<void> {
    this.experiments.set(row.id, {
      ...row,
      candidates: cloneCandidates(row.candidates),
      agreement: cloneAgreement(row.agreement),
      // Older in-memory fixtures and callers predate the host proof. Treat only
      // a truly absent field as legacy unknown; present malformed proof still
      // fails closed through cloneSnapshotProof.
      snapshotProof: cloneSnapshotProof(row.snapshotProof ?? UNKNOWN_SNAPSHOT_PROOF),
    });
    this.observations.set(row.id, []);
    this.decisions.set(row.id, []);
    this.golds.set(row.id, []);
    this.traces.set(row.id, []);
    this.annotations.set(row.id, []);
  }

  async get(id: string): Promise<ExperimentRow | null> {
    const row = this.experiments.get(id);
    if (!row) return null;
    return {
      ...row,
      candidates: cloneCandidates(row.candidates),
      agreement: cloneAgreement(row.agreement),
      snapshotProof: cloneSnapshotProof(row.snapshotProof),
    };
  }

  async findByPackage(caseId: string, packageId: string): Promise<ExperimentRow | null> {
    for (const row of this.experiments.values()) {
      if (row.caseId === caseId && row.packageId === packageId) {
        return this.get(row.id);
      }
    }
    return null;
  }

  async listByCase(caseId: string): Promise<ExperimentRow[]> {
    const rows: ExperimentRow[] = [];
    for (const row of this.experiments.values()) {
      if (row.caseId === caseId) {
        const copy = await this.get(row.id);
        if (copy) rows.push(copy);
      }
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listOverviewProposed(
    query: ListOverviewProposedQuery,
  ): Promise<LatestProposedDecisionRow[]> {
    const cap = Math.max(0, Math.trunc(query.limit) || 0);
    if (cap === 0) return [];
    const rows: LatestProposedDecisionRow[] = [];
    const titles = new Map<string, string | null>();
    for (const experiment of this.experiments.values()) {
      if (!titles.has(experiment.caseId)) {
        titles.set(experiment.caseId, query.visibility?.caseTitle(experiment.caseId) ?? null);
      }
      const caseTitle = titles.get(experiment.caseId);
      if (!caseTitle) continue;
      const latest = (this.decisions.get(experiment.id) ?? [])
        .slice()
        .sort((a, b) => a.revision - b.revision)
        .at(-1);
      if (!latest || latest.status !== "proposed") continue;
      if (!matchesProposedQuery(latest.authorId, query)) continue;
      rows.push({
        caseId: experiment.caseId,
        caseTitle,
        experimentId: experiment.id,
        packageId: experiment.packageId,
        decision: cloneDecision(latest),
      });
    }
    return sortProposed(rows).slice(0, cap);
  }

  async listObservations(experimentId: string): Promise<HelpfulnessObservationV1[]> {
    return [...(this.observations.get(experimentId) ?? [])];
  }

  async insertObservation(row: HelpfulnessObservationV1): Promise<void> {
    const list = this.observations.get(row.experimentId) ?? [];
    list.push({ ...row, evidenceRefs: [...row.evidenceRefs] });
    this.observations.set(row.experimentId, list);
  }

  async listDecisions(experimentId: string): Promise<NormalizedExperimentDecisionV1[]> {
    return [...(this.decisions.get(experimentId) ?? [])].sort((a, b) => a.revision - b.revision);
  }

  async insertDecision(row: NormalizedExperimentDecisionV1): Promise<void> {
    const list = this.decisions.get(row.experimentId) ?? [];
    if (list.some((d) => d.revision === row.revision)) {
      throw new Error("decision revision already exists");
    }
    list.push({ ...row, evidenceRefs: [...row.evidenceRefs] });
    this.decisions.set(row.experimentId, list);
  }

  async listGolds(experimentId: string): Promise<GoldReferenceV1[]> {
    return [...(this.golds.get(experimentId) ?? [])]
      .map(cloneGold)
      .sort((a, b) => a.version - b.version || a.goldId.localeCompare(b.goldId));
  }

  async insertGold(row: GoldReferenceV1): Promise<void> {
    const list = this.golds.get(row.experimentId) ?? [];
    const existing = list.find((gold) => gold.goldId === row.goldId || gold.version === row.version);
    if (existing) {
      throw new Error("gold_references is insert-only");
    }
    list.push(cloneGold(row));
    this.golds.set(row.experimentId, list);
  }

  async listTraces(experimentId: string): Promise<InteractionTraceV1[]> {
    return [...(this.traces.get(experimentId) ?? [])]
      .map(cloneTrace)
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  }

  async findTrace(experimentId: string, candidateId: string): Promise<InteractionTraceV1 | null> {
    const found = (this.traces.get(experimentId) ?? []).find((row) => row.candidateId === candidateId);
    return found ? cloneTrace(found) : null;
  }

  async insertTrace(
    experimentId: string,
    row: InteractionTraceV1,
    _fingerprint: string,
  ): Promise<void> {
    const traces = this.traces.get(experimentId) ?? [];
    if (traces.some((trace) => trace.candidateId === row.candidateId || trace.traceId === row.traceId)) {
      throw new Error("experiment_traces is insert-only");
    }
    traces.push(cloneTrace(row));
    this.traces.set(experimentId, traces);
  }

  async lockExperiment(_experimentId: string): Promise<void> {
    // Memory transactions are serialized by CaseStore.atomicBoundary.
  }

  async listAnnotations(experimentId: string): Promise<TraceAnnotationRow[]> {
    return [...(this.annotations.get(experimentId) ?? [])].map((row) => ({
      ...row,
      event: {
        ...row.event,
        evidenceRefs: [...row.event.evidenceRefs],
        unknowns: [...row.event.unknowns],
        observedAt: { ...row.event.observedAt },
      },
    }));
  }

  async insertAnnotation(row: TraceAnnotationRow): Promise<void> {
    const list = this.annotations.get(row.experimentId) ?? [];
    if (
      list.some(
        (existing) =>
          existing.candidateId === row.candidateId && existing.event.sequence === row.event.sequence,
      )
    ) {
      throw new Error("annotation sequence already exists");
    }
    list.push({
      ...row,
      event: {
        ...row.event,
        evidenceRefs: [...row.event.evidenceRefs],
        unknowns: [...row.event.unknowns],
        observedAt: { ...row.event.observedAt },
      },
    });
    this.annotations.set(row.experimentId, list);
  }
}

export type Queryable = Pick<Pool, "query">;

export class PgExperimentStore implements ExperimentStore {
  constructor(private readonly db: Queryable) {}

  private get queryable(): Queryable {
    return activeCaseQueryable() ?? this.db;
  }

  async insert(row: ExperimentRow): Promise<void> {
    await this.queryable.query(
      `INSERT INTO experiment_packages (
        id, case_id, package_id, source_schema_id, task_fingerprint, snapshot_fingerprint,
        candidates, agreement, created_at, importer_id, importer_username
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [
        row.id,
        row.caseId,
        row.packageId,
        row.sourceSchemaId,
        row.taskFingerprint,
        row.snapshotFingerprint,
        JSON.stringify(row.candidates),
        JSON.stringify(storedAgreement(row)),
        row.createdAt,
        row.importerId,
        row.importerUsername,
      ],
    );
  }

  async get(id: string): Promise<ExperimentRow | null> {
    const res = await this.queryable.query(`SELECT * FROM experiment_packages WHERE id = $1`, [id]);
    const raw = res.rows[0] as Record<string, unknown> | undefined;
    return raw ? fromPgExperiment(raw) : null;
  }

  async findByPackage(caseId: string, packageId: string): Promise<ExperimentRow | null> {
    const res = await this.queryable.query(
      `SELECT * FROM experiment_packages WHERE case_id = $1 AND package_id = $2`,
      [caseId, packageId],
    );
    const raw = res.rows[0] as Record<string, unknown> | undefined;
    return raw ? fromPgExperiment(raw) : null;
  }

  async listByCase(caseId: string): Promise<ExperimentRow[]> {
    const res = await this.queryable.query(
      `SELECT * FROM experiment_packages WHERE case_id = $1 ORDER BY created_at, id`,
      [caseId],
    );
    return (res.rows as Record<string, unknown>[]).map(fromPgExperiment);
  }

  async listOverviewProposed(
    query: ListOverviewProposedQuery,
  ): Promise<LatestProposedDecisionRow[]> {
    const cap = Math.max(0, Math.trunc(query.limit) || 0);
    if (cap === 0) return [];
    const res = await this.queryable.query(
      `SELECT e.case_id, c.title AS case_title, e.id AS experiment_id, e.package_id, d.payload
       FROM experiment_decisions d
       INNER JOIN experiment_packages e ON e.id = d.experiment_id
       INNER JOIN cases c ON c.id = e.case_id
       INNER JOIN (
         SELECT experiment_id, MAX(revision) AS revision
         FROM experiment_decisions
         GROUP BY experiment_id
       ) latest
         ON latest.experiment_id = d.experiment_id AND latest.revision = d.revision
       WHERE ${overviewVisiblePredicate("e.case_id", "$1", "$2")}
         AND d.payload->>'status' = 'proposed'
         AND ($3::text IS NULL OR d.payload->>'authorId' = $3)
         AND ($4::text IS NULL OR d.payload->>'authorId' <> $4)
       ORDER BY d.created_at DESC, e.id ASC, d.id ASC
       LIMIT $5`,
      [
        query.isAdmin,
        query.actorId,
        query.authorId ?? null,
        query.excludeAuthorId ?? null,
        cap,
      ],
    );
    return (res.rows as {
      case_id: string;
      case_title: string;
      experiment_id: string;
      package_id: string;
      payload: unknown;
    }[]).map((row) => ({
      caseId: row.case_id,
      caseTitle: row.case_title,
      experimentId: row.experiment_id,
      packageId: row.package_id,
      decision: parseExperimentDecision(row.payload),
    }));
  }

  async listObservations(experimentId: string): Promise<HelpfulnessObservationV1[]> {
    const res = await this.queryable.query(
      `SELECT payload FROM experiment_helpfulness WHERE experiment_id = $1 ORDER BY created_at, id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: HelpfulnessObservationV1 }) => row.payload);
  }

  async insertObservation(row: HelpfulnessObservationV1): Promise<void> {
    await this.queryable.query(
      `INSERT INTO experiment_helpfulness (id, experiment_id, created_at, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [row.id, row.experimentId, row.createdAt, JSON.stringify(row)],
    );
  }

  async listDecisions(experimentId: string): Promise<NormalizedExperimentDecisionV1[]> {
    const res = await this.queryable.query(
      `SELECT payload FROM experiment_decisions WHERE experiment_id = $1 ORDER BY revision, id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: ExperimentDecisionV1 }) =>
      parseExperimentDecision(row.payload),
    );
  }

  async insertDecision(row: NormalizedExperimentDecisionV1): Promise<void> {
    await this.queryable.query(
      `INSERT INTO experiment_decisions (id, experiment_id, revision, created_at, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [row.id, row.experimentId, row.revision, row.createdAt, JSON.stringify(row)],
    );
  }

  async listGolds(experimentId: string): Promise<GoldReferenceV1[]> {
    const res = await this.queryable.query(
      `SELECT payload FROM gold_references WHERE experiment_id = $1 ORDER BY version, gold_id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: GoldReferenceV1 }) => row.payload);
  }

  async insertGold(row: GoldReferenceV1): Promise<void> {
    await this.queryable.query(
      `INSERT INTO gold_references (gold_id, experiment_id, version, created_at, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [row.goldId, row.experimentId, row.version, row.createdAt, JSON.stringify(row)],
    );
  }

  async listTraces(experimentId: string): Promise<InteractionTraceV1[]> {
    const res = await this.queryable.query(
      `SELECT payload FROM experiment_traces WHERE experiment_id = $1 ORDER BY candidate_id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: InteractionTraceV1 }) => row.payload);
  }

  async findTrace(experimentId: string, candidateId: string): Promise<InteractionTraceV1 | null> {
    const res = await this.queryable.query(
      `SELECT payload FROM experiment_traces WHERE experiment_id = $1 AND candidate_id = $2`,
      [experimentId, candidateId],
    );
    return (res.rows[0] as { payload: InteractionTraceV1 } | undefined)?.payload ?? null;
  }

  async insertTrace(
    experimentId: string,
    row: InteractionTraceV1,
    fingerprint: string,
  ): Promise<void> {
    await this.queryable.query(
      `INSERT INTO experiment_traces (id, experiment_id, candidate_id, fingerprint, created_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [randomUUID(), experimentId, row.candidateId, fingerprint, row.createdAt, JSON.stringify(row)],
    );
  }

  async lockExperiment(experimentId: string): Promise<void> {
    const res = await this.queryable.query(
      `SELECT id FROM experiment_packages WHERE id = $1 FOR UPDATE`,
      [experimentId],
    );
    if (res.rowCount !== 1) throw new Error("experiment not found");
  }

  async listAnnotations(experimentId: string): Promise<TraceAnnotationRow[]> {
    const res = await this.queryable.query(
      `SELECT payload FROM experiment_trace_annotations WHERE experiment_id = $1 ORDER BY created_at, id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: TraceAnnotationRow }) => row.payload);
  }

  async insertAnnotation(row: TraceAnnotationRow): Promise<void> {
    await this.lockExperiment(row.experimentId);
    const existing = await this.listAnnotations(row.experimentId);
    if (
      existing.some(
        (item) => item.candidateId === row.candidateId && item.event.sequence === row.event.sequence,
      )
    ) {
      throw new Error("annotation sequence already exists");
    }
    await this.queryable.query(
      `INSERT INTO experiment_trace_annotations (id, experiment_id, candidate_id, created_at, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [row.id, row.experimentId, row.candidateId, row.createdAt, JSON.stringify(row)],
    );
  }
}

function fromPgExperiment(raw: Record<string, unknown>): ExperimentRow {
  const stored = decodeStoredAgreement(raw.agreement);
  return {
    id: String(raw.id),
    caseId: String(raw.case_id),
    packageId: String(raw.package_id),
    sourceSchemaId: String(raw.source_schema_id),
    taskFingerprint: String(raw.task_fingerprint),
    snapshotFingerprint: String(raw.snapshot_fingerprint),
    snapshotProof: stored.snapshotProof,
    candidates: raw.candidates as ExperimentCandidateV1[],
    agreement: stored.agreement,
    createdAt: new Date(String(raw.created_at)).toISOString(),
    importerId: String(raw.importer_id),
    importerUsername: String(raw.importer_username),
  };
}
