import type { Pool } from "pg";
import type {
  ExperimentAgreementV1,
  ExperimentCandidateV1,
  ExperimentDecisionV1,
  HelpfulnessObservationV1,
} from "@cd-collab/contracts";

export interface ExperimentRow {
  id: string;
  caseId: string;
  packageId: string;
  sourceSchemaId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1;
  createdAt: string;
  importerId: string;
  importerUsername: string;
}

export interface ExperimentStore {
  insert(row: ExperimentRow): Promise<void>;
  get(id: string): Promise<ExperimentRow | null>;
  findByPackage(caseId: string, packageId: string): Promise<ExperimentRow | null>;
  listByCase(caseId: string): Promise<ExperimentRow[]>;
  listObservations(experimentId: string): Promise<HelpfulnessObservationV1[]>;
  insertObservation(row: HelpfulnessObservationV1): Promise<void>;
  listDecisions(experimentId: string): Promise<ExperimentDecisionV1[]>;
  insertDecision(row: ExperimentDecisionV1): Promise<void>;
}

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

export class MemoryExperimentStore implements ExperimentStore {
  private readonly experiments = new Map<string, ExperimentRow>();
  private readonly observations = new Map<string, HelpfulnessObservationV1[]>();
  private readonly decisions = new Map<string, ExperimentDecisionV1[]>();

  async insert(row: ExperimentRow): Promise<void> {
    this.experiments.set(row.id, {
      ...row,
      candidates: cloneCandidates(row.candidates),
      agreement: cloneAgreement(row.agreement),
    });
    this.observations.set(row.id, []);
    this.decisions.set(row.id, []);
  }

  async get(id: string): Promise<ExperimentRow | null> {
    const row = this.experiments.get(id);
    if (!row) return null;
    return {
      ...row,
      candidates: cloneCandidates(row.candidates),
      agreement: cloneAgreement(row.agreement),
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

  async listObservations(experimentId: string): Promise<HelpfulnessObservationV1[]> {
    return [...(this.observations.get(experimentId) ?? [])];
  }

  async insertObservation(row: HelpfulnessObservationV1): Promise<void> {
    const list = this.observations.get(row.experimentId) ?? [];
    list.push({ ...row, evidenceRefs: [...row.evidenceRefs] });
    this.observations.set(row.experimentId, list);
  }

  async listDecisions(experimentId: string): Promise<ExperimentDecisionV1[]> {
    return [...(this.decisions.get(experimentId) ?? [])].sort((a, b) => a.revision - b.revision);
  }

  async insertDecision(row: ExperimentDecisionV1): Promise<void> {
    const list = this.decisions.get(row.experimentId) ?? [];
    if (list.some((d) => d.revision === row.revision && d.id === row.id)) {
      throw new Error("decision revision already exists");
    }
    list.push({ ...row, evidenceRefs: [...row.evidenceRefs] });
    this.decisions.set(row.experimentId, list);
  }
}

export type Queryable = Pick<Pool, "query">;

export class PgExperimentStore implements ExperimentStore {
  constructor(private readonly db: Queryable) {}

  async insert(row: ExperimentRow): Promise<void> {
    await this.db.query(
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
        JSON.stringify(row.agreement),
        row.createdAt,
        row.importerId,
        row.importerUsername,
      ],
    );
  }

  async get(id: string): Promise<ExperimentRow | null> {
    const res = await this.db.query(`SELECT * FROM experiment_packages WHERE id = $1`, [id]);
    const raw = res.rows[0] as Record<string, unknown> | undefined;
    return raw ? fromPgExperiment(raw) : null;
  }

  async findByPackage(caseId: string, packageId: string): Promise<ExperimentRow | null> {
    const res = await this.db.query(
      `SELECT * FROM experiment_packages WHERE case_id = $1 AND package_id = $2`,
      [caseId, packageId],
    );
    const raw = res.rows[0] as Record<string, unknown> | undefined;
    return raw ? fromPgExperiment(raw) : null;
  }

  async listByCase(caseId: string): Promise<ExperimentRow[]> {
    const res = await this.db.query(
      `SELECT * FROM experiment_packages WHERE case_id = $1 ORDER BY created_at, id`,
      [caseId],
    );
    return (res.rows as Record<string, unknown>[]).map(fromPgExperiment);
  }

  async listObservations(experimentId: string): Promise<HelpfulnessObservationV1[]> {
    const res = await this.db.query(
      `SELECT payload FROM experiment_helpfulness WHERE experiment_id = $1 ORDER BY created_at, id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: HelpfulnessObservationV1 }) => row.payload);
  }

  async insertObservation(row: HelpfulnessObservationV1): Promise<void> {
    await this.db.query(
      `INSERT INTO experiment_helpfulness (id, experiment_id, created_at, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [row.id, row.experimentId, row.createdAt, JSON.stringify(row)],
    );
  }

  async listDecisions(experimentId: string): Promise<ExperimentDecisionV1[]> {
    const res = await this.db.query(
      `SELECT payload FROM experiment_decisions WHERE experiment_id = $1 ORDER BY revision, id`,
      [experimentId],
    );
    return res.rows.map((row: { payload: ExperimentDecisionV1 }) => row.payload);
  }

  async insertDecision(row: ExperimentDecisionV1): Promise<void> {
    await this.db.query(
      `INSERT INTO experiment_decisions (id, experiment_id, revision, created_at, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [row.id, row.experimentId, row.revision, row.createdAt, JSON.stringify(row)],
    );
  }
}

function fromPgExperiment(raw: Record<string, unknown>): ExperimentRow {
  return {
    id: String(raw.id),
    caseId: String(raw.case_id),
    packageId: String(raw.package_id),
    sourceSchemaId: String(raw.source_schema_id),
    taskFingerprint: String(raw.task_fingerprint),
    snapshotFingerprint: String(raw.snapshot_fingerprint),
    candidates: raw.candidates as ExperimentCandidateV1[],
    agreement: raw.agreement as ExperimentAgreementV1,
    createdAt: new Date(String(raw.created_at)).toISOString(),
    importerId: String(raw.importer_id),
    importerUsername: String(raw.importer_username),
  };
}
