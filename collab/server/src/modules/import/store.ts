import type { Pool } from "pg";
import type {
  Completeness,
  EvidenceVisibility,
  ExternalRunImportMode,
} from "@cd-collab/contracts";
import { activeCaseQueryable } from "../cases/index.js";

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
  /** Present together on strict manual imports; absent on legacy rows. */
  importMode?: ExternalRunImportMode;
  /** Present together on strict manual imports; absent on legacy rows. */
  sourceRevision?: number;
  /** Present together on strict manual imports; absent on legacy rows. */
  evidenceArtifactIds?: string[];
}

/** Insert-only successful manual-import intent used for exact retry replay. */
export interface ExternalRunImportSuccessIntent {
  caseId: string;
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
  runId: string;
  successJson: string;
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
  listReferencedContentHashes(): Promise<ReadonlySet<string>>;
  listCorroborations(runId: string): Promise<CorroborationRow[]>;
  appendCorroboration(row: Omit<CorroborationRow, "seq" | "createdAt">): Promise<CorroborationRow>;
  /** Caller must already hold the case row lock inside the case transaction. */
  lockImportSuccessIntent(
    caseId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<ExternalRunImportSuccessIntent | null>;
  insertImportSuccessIntent(row: ExternalRunImportSuccessIntent): Promise<void>;
  /**
   * Returns the subset of `ids` that already key a row here. Host-owned and
   * batched: cost follows the probed id count, never the corpus size.
   */
  probeExistingIds(ids: readonly string[]): Promise<string[]>;
}

export type Queryable = Pick<Pool, "query">;

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, FrozenRunRow>();
  private readonly events = new Map<string, CorroborationRow[]>();
  private readonly importSuccessIntents = new Map<string, ExternalRunImportSuccessIntent>();

  capture(): unknown {
    return structuredClone({
      runs: [...this.runs.entries()],
      events: [...this.events.entries()],
      importSuccessIntents: [...this.importSuccessIntents.entries()],
    });
  }

  restore(snapshot: unknown): void {
    const row = structuredClone(snapshot) as {
      runs: [string, FrozenRunRow][];
      events: [string, CorroborationRow[]][];
      importSuccessIntents?: [string, ExternalRunImportSuccessIntent][];
    };
    this.runs.clear();
    this.events.clear();
    this.importSuccessIntents.clear();
    for (const [id, value] of row.runs) this.runs.set(id, value);
    for (const [id, value] of row.events) this.events.set(id, value);
    for (const [key, value] of row.importSuccessIntents ?? []) {
      this.importSuccessIntents.set(key, value);
    }
  }

  async insert(row: FrozenRunRow): Promise<void> {
    this.runs.set(row.id, Object.freeze(cloneRun(row)));
    this.events.set(row.id, []);
  }

  async probeExistingIds(ids: readonly string[]): Promise<string[]> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return [];
    return [...this.runs.keys()].filter((id) => wanted.has(id)).sort();
  }

  async get(id: string): Promise<FrozenRunRow | null> {
    const row = this.runs.get(id);
    return row ? cloneRun(row) : null;
  }

  async listByCase(caseId: string): Promise<FrozenRunRow[]> {
    return [...this.runs.values()]
      .filter((row) => row.caseId === caseId)
      .map(cloneRun);
  }

  async listReferencedContentHashes(): Promise<ReadonlySet<string>> {
    const hashes = new Set<string>();
    for (const row of this.runs.values()) {
      if (/^[0-9a-f]{64}$/.test(row.outputHash)) hashes.add(row.outputHash);
      if (row.promptHash && /^[0-9a-f]{64}$/.test(row.promptHash)) hashes.add(row.promptHash);
    }
    return hashes;
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

  async lockImportSuccessIntent(
    caseId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<ExternalRunImportSuccessIntent | null> {
    const row = this.importSuccessIntents.get(importIntentKey(caseId, actorId, idempotencyKey));
    return row ? { ...row } : null;
  }

  async insertImportSuccessIntent(row: ExternalRunImportSuccessIntent): Promise<void> {
    const key = importIntentKey(row.caseId, row.actorId, row.idempotencyKey);
    if (this.importSuccessIntents.has(key)) {
      throw new Error("external run import success intent already exists");
    }
    this.importSuccessIntents.set(key, Object.freeze({ ...row }));
  }
}

export class PgRunStore implements RunStore {
  constructor(private readonly pool: Queryable) {}

  private get db(): Queryable {
    return activeCaseQueryable() ?? this.pool;
  }

  private get mutationDb(): Queryable {
    const transaction = activeCaseQueryable();
    if (!transaction) throw new Error("strict external run import requires an atomic case boundary");
    return transaction;
  }

  async probeExistingIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query(
      `SELECT id FROM imported_runs WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return result.rows.map((row) => String((row as Record<string, unknown>).id)).sort();
  }

  async insert(row: FrozenRunRow): Promise<void> {
    const db = row.importMode === undefined ? this.db : this.mutationDb;
    await db.query(
      `INSERT INTO imported_runs (
         id, case_id, contribution_id, source_id, output_hash, output_text,
         prompt_hash, prompt_text, prompt_completeness, output_completeness,
         workflow_completeness, evidence_visibility, snapshot_binding, visibility_note,
         importer_id, importer_username, operator_id, operator_username,
         provider, model, version, claimed_traces, uncertainty, timing, cost,
         redacted, privacy_class, created_at, import_mode, source_revision,
         evidence_artifact_ids
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24, $25, $26, $27, $28,
         $29, $30, $31::jsonb
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
        row.importMode ?? null,
        row.sourceRevision ?? null,
        row.evidenceArtifactIds === undefined ? null : JSON.stringify(row.evidenceArtifactIds),
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

  async listReferencedContentHashes(): Promise<ReadonlySet<string>> {
    const result = await this.db.query<{ hash: string | null }>(
      `SELECT hash FROM (
         SELECT output_hash AS hash FROM imported_runs
         UNION
         SELECT prompt_hash FROM imported_runs
       ) hashes
       WHERE hash ~ '^[0-9a-f]{64}$'`,
    );
    return new Set(
      result.rows
        .map((row) => row.hash)
        .filter((hash): hash is string => Boolean(hash && /^[0-9a-f]{64}$/.test(hash))),
    );
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

  async lockImportSuccessIntent(
    caseId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<ExternalRunImportSuccessIntent | null> {
    const result = await this.mutationDb.query(
      `SELECT * FROM external_run_import_success_intents
       WHERE case_id = $1 AND actor_id = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [caseId, actorId, idempotencyKey],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asImportSuccessIntent(row) : null;
  }

  async insertImportSuccessIntent(row: ExternalRunImportSuccessIntent): Promise<void> {
    await this.mutationDb.query(
      `INSERT INTO external_run_import_success_intents (
         case_id, actor_id, idempotency_key, request_digest, run_id, success_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.caseId,
        row.actorId,
        row.idempotencyKey,
        row.requestDigest,
        row.runId,
        row.successJson,
        row.createdAt,
      ],
    );
  }
}

function cloneRun(row: FrozenRunRow): FrozenRunRow {
  assertStrictRunMarkers(row);
  return {
    ...row,
    claimedTraces: [...row.claimedTraces],
    ...(row.evidenceArtifactIds === undefined
      ? {}
      : { evidenceArtifactIds: [...row.evidenceArtifactIds] }),
  };
}

function assertStrictRunMarkers(row: FrozenRunRow): void {
  const markerCount = [row.importMode, row.sourceRevision, row.evidenceArtifactIds]
    .filter((value) => value !== undefined).length;
  if (markerCount !== 0 && markerCount !== 3) {
    throw new Error("strict imported run markers must be present together");
  }
  if (markerCount === 0) return;
  if (row.importMode !== "manual") throw new Error("invalid imported run mode");
  if (!Number.isSafeInteger(row.sourceRevision) || row.sourceRevision! < 1) {
    throw new Error("invalid imported run source revision");
  }
  if (!Array.isArray(row.evidenceArtifactIds) || row.evidenceArtifactIds.length > 64) {
    throw new Error("invalid imported run evidence artifact ids");
  }
}

function importIntentKey(caseId: string, actorId: string, idempotencyKey: string): string {
  return `${caseId}\u0000${actorId}\u0000${idempotencyKey}`;
}

function asRun(row: Record<string, unknown>): FrozenRunRow {
  const traces = row.claimed_traces;
  const markerCount = [row.import_mode, row.source_revision, row.evidence_artifact_ids]
    .filter((value) => value !== null && value !== undefined).length;
  if (markerCount !== 0 && markerCount !== 3) {
    throw new Error("strict imported run markers must be present together");
  }
  const evidenceArtifactIds = row.evidence_artifact_ids;
  const sourceRevision = row.source_revision === null || row.source_revision === undefined
    ? undefined
    : Number(row.source_revision);
  if (
    sourceRevision !== undefined
    && (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1)
  ) {
    throw new Error("invalid imported run source revision");
  }
  if (
    evidenceArtifactIds !== null
    && evidenceArtifactIds !== undefined
    && !Array.isArray(evidenceArtifactIds)
  ) {
    throw new Error("invalid imported run evidence artifact ids");
  }
  const result: FrozenRunRow = {
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
    ...(markerCount === 3
      ? {
          importMode: row.import_mode as ExternalRunImportMode,
          sourceRevision: sourceRevision!,
          evidenceArtifactIds: (evidenceArtifactIds as unknown[]).map((item) => String(item)),
        }
      : {}),
  };
  assertStrictRunMarkers(result);
  return result;
}

function asImportSuccessIntent(row: Record<string, unknown>): ExternalRunImportSuccessIntent {
  return {
    caseId: String(row.case_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    runId: String(row.run_id),
    successJson: String(row.success_json),
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
