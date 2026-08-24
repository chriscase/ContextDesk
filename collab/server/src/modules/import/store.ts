import type { Pool } from "pg";
import type { Completeness, EvidenceVisibility } from "@cd-collab/contracts";

export interface FrozenRunRow {
  id: string;
  caseId: string;
  contributionId: string;
  sourceId: string;
  outputHash: string;
  outputText: string;
  promptHash: string | null;
  promptText: string | null;
  promptCompleteness: Completeness;
  outputCompleteness: Completeness;
  workflowCompleteness: Completeness;
  evidenceVisibility: EvidenceVisibility;
  snapshotBinding: string | null;
  visibilityNote: string | null;
  importerId: string;
  importerUsername: string;
  operatorId: string;
  operatorUsername: string;
  provider: string | null;
  model: string | null;
  version: string | null;
  claimedTraces: string[];
  uncertainty: string | null;
  timing: string | null;
  cost: string | null;
  redacted: boolean;
  privacyClass: "owner_only" | "share_safe";
  createdAt: string;
}

export interface CorroborationRow {
  runId: string;
  seq: number;
  state: "corroborated" | "contradicted";
  actorId: string;
  actorUsername: string;
  evidenceLinks: { kind: "artifact" | "contribution"; id: string }[];
  createdAt: string;
}

export interface RunStore {
  insert(row: FrozenRunRow): Promise<void>;
  get(id: string): Promise<FrozenRunRow | null>;
  listByCase(caseId: string): Promise<FrozenRunRow[]>;
  listCorroborations(runId: string): Promise<CorroborationRow[]>;
  appendCorroboration(row: Omit<CorroborationRow, "seq" | "createdAt">): Promise<CorroborationRow>;
}

export type Queryable = Pick<Pool, "query">;

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, FrozenRunRow>();
  private readonly events = new Map<string, CorroborationRow[]>();

  capture(): unknown {
    return structuredClone({
      runs: [...this.runs.entries()],
      events: [...this.events.entries()],
    });
  }

  restore(snapshot: unknown): void {
    const row = structuredClone(snapshot) as {
      runs: [string, FrozenRunRow][];
      events: [string, CorroborationRow[]][];
    };
    this.runs.clear();
    this.events.clear();
    for (const [id, value] of row.runs) this.runs.set(id, value);
    for (const [id, value] of row.events) this.events.set(id, value);
  }

  async insert(row: FrozenRunRow): Promise<void> {
    this.runs.set(row.id, Object.freeze({ ...row, claimedTraces: [...row.claimedTraces] }));
    this.events.set(row.id, []);
  }

  async get(id: string): Promise<FrozenRunRow | null> {
    const row = this.runs.get(id);
    return row ? { ...row, claimedTraces: [...row.claimedTraces] } : null;
  }

  async listByCase(caseId: string): Promise<FrozenRunRow[]> {
    return [...this.runs.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row, claimedTraces: [...row.claimedTraces] }));
  }

  async listCorroborations(runId: string): Promise<CorroborationRow[]> {
    return [...(this.events.get(runId) ?? [])];
  }

  async appendCorroboration(
    row: Omit<CorroborationRow, "seq" | "createdAt">,
  ): Promise<CorroborationRow> {
    const list = this.events.get(row.runId) ?? [];
    const next: CorroborationRow = {
      ...row,
      evidenceLinks: [...row.evidenceLinks],
      seq: list.length + 1,
      createdAt: new Date().toISOString(),
    };
    list.push(next);
    this.events.set(row.runId, list);
    return next;
  }
}

export class PgRunStore implements RunStore {
  constructor(private readonly db: Queryable) {}

  async insert(row: FrozenRunRow): Promise<void> {
    await this.db.query(
      `INSERT INTO imported_runs (
         id, case_id, contribution_id, source_id, output_hash, output_text,
         prompt_hash, prompt_text, prompt_completeness, output_completeness,
         workflow_completeness, evidence_visibility, snapshot_binding, visibility_note,
         importer_id, importer_username, operator_id, operator_username,
         provider, model, version, claimed_traces, uncertainty, timing, cost,
         redacted, privacy_class, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24, $25, $26, $27, $28
       )`,
      [
        row.id,
        row.caseId,
        row.contributionId,
        row.sourceId,
        row.outputHash,
        row.outputText,
        row.promptHash,
        row.promptText,
        row.promptCompleteness,
        row.outputCompleteness,
        row.workflowCompleteness,
        row.evidenceVisibility,
        row.snapshotBinding,
        row.visibilityNote,
        row.importerId,
        row.importerUsername,
        row.operatorId,
        row.operatorUsername,
        row.provider,
        row.model,
        row.version,
        JSON.stringify(row.claimedTraces),
        row.uncertainty,
        row.timing,
        row.cost,
        row.redacted,
        row.privacyClass,
        row.createdAt,
      ],
    );
  }

  async get(id: string): Promise<FrozenRunRow | null> {
    const result = await this.db.query(`SELECT * FROM imported_runs WHERE id = $1`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asRun(row) : null;
  }

  async listByCase(caseId: string): Promise<FrozenRunRow[]> {
    const result = await this.db.query(
      `SELECT * FROM imported_runs WHERE case_id = $1 ORDER BY created_at ASC`,
      [caseId],
    );
    return result.rows.map((row) => asRun(row as Record<string, unknown>));
  }

  async listCorroborations(runId: string): Promise<CorroborationRow[]> {
    const result = await this.db.query(
      `SELECT * FROM imported_run_corroborations WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return result.rows.map((row) => asEvent(row as Record<string, unknown>));
  }

  async appendCorroboration(
    row: Omit<CorroborationRow, "seq" | "createdAt">,
  ): Promise<CorroborationRow> {
    const seqRes = await this.db.query<{ seq: string | number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM imported_run_corroborations WHERE run_id = $1`,
      [row.runId],
    );
    const seq = Number(seqRes.rows[0]?.seq ?? 1);
    const createdAt = new Date().toISOString();
    await this.db.query(
      `INSERT INTO imported_run_corroborations (
         run_id, seq, state, actor_id, actor_username, evidence_links, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        row.runId,
        seq,
        row.state,
        row.actorId,
        row.actorUsername,
        JSON.stringify(row.evidenceLinks),
        createdAt,
      ],
    );
    return { ...row, seq, createdAt };
  }
}

function asRun(row: Record<string, unknown>): FrozenRunRow {
  const traces = row.claimed_traces;
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    contributionId: String(row.contribution_id),
    sourceId: String(row.source_id),
    outputHash: String(row.output_hash),
    outputText: String(row.output_text),
    promptHash: row.prompt_hash === null || row.prompt_hash === undefined ? null : String(row.prompt_hash),
    promptText: row.prompt_text === null || row.prompt_text === undefined ? null : String(row.prompt_text),
    promptCompleteness: row.prompt_completeness as Completeness,
    outputCompleteness: row.output_completeness as Completeness,
    workflowCompleteness: row.workflow_completeness as Completeness,
    evidenceVisibility: row.evidence_visibility as EvidenceVisibility,
    snapshotBinding:
      row.snapshot_binding === null || row.snapshot_binding === undefined
        ? null
        : String(row.snapshot_binding),
    visibilityNote:
      row.visibility_note === null || row.visibility_note === undefined
        ? null
        : String(row.visibility_note),
    importerId: String(row.importer_id),
    importerUsername: String(row.importer_username),
    operatorId: String(row.operator_id),
    operatorUsername: String(row.operator_username),
    provider: row.provider === null || row.provider === undefined ? null : String(row.provider),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    version: row.version === null || row.version === undefined ? null : String(row.version),
    claimedTraces: Array.isArray(traces) ? traces.map((item) => String(item)) : [],
    uncertainty:
      row.uncertainty === null || row.uncertainty === undefined ? null : String(row.uncertainty),
    timing: row.timing === null || row.timing === undefined ? null : String(row.timing),
    cost: row.cost === null || row.cost === undefined ? null : String(row.cost),
    redacted: Boolean(row.redacted),
    privacyClass: row.privacy_class as "owner_only" | "share_safe",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function asEvent(row: Record<string, unknown>): CorroborationRow {
  const links = row.evidence_links;
  return {
    runId: String(row.run_id),
    seq: Number(row.seq),
    state: row.state as "corroborated" | "contradicted",
    actorId: String(row.actor_id),
    actorUsername: String(row.actor_username),
    evidenceLinks: Array.isArray(links)
      ? links.map((item) => {
          const rec = item as Record<string, unknown>;
          return { kind: rec.kind as "artifact" | "contribution", id: String(rec.id) };
        })
      : [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
