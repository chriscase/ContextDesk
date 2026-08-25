import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  PORTABLE_OBJECT_KINDS,
  PORTABLE_TERMINAL_TRIAGE_STATUSES,
  parseCorpusIntakeBatch,
  parsePortableTriageAttemptTarget,
  parsePortableExperimentTraceTarget,
  portableDestinationUuid,
  snapshotFairness,
  snapshotFingerprint,
  type ArchivePreflightReportV1,
  type GoldReferenceV1,
  type HelpfulnessObservationV1,
  type IdentityMapEntryV1,
  type NormalizedExperimentDecisionV1,
  type PortableArchiveV1,
  type PortableObjectKind,
  type PortableTriageCandidateV1,
  type PortableTriageJobV1,
  type TriageJobV1,
} from "@cd-collab/contracts";
import type { EvidenceStore, EvidenceWriteBatch } from "../../evidence/store.js";
import { PgAuditStore, type AuditStore } from "../audit/index.js";
import { PgCatalogStore, type CatalogStore } from "../catalog/index.js";
import { PgCaseStore, type Actor, type CaseStore } from "../cases/index.js";
import { PgExperimentStore, type ExperimentStore } from "../experiments/index.js";
import { PgRunStore, type RunStore } from "../import/index.js";
import { PgTriageJobStore, type TriageJobStore } from "../triage-runs/index.js";

export interface PortablePersistPorts {
  cases: CaseStore;
  catalog: CatalogStore;
  experiments: ExperimentStore;
  runs: RunStore;
  jobs: TriageJobStore;
  evidence: EvidenceStore;
  audit: AuditStore;
  applyState: PortableApplyStateStore;
}

export interface StoredPortableApplyIntent {
  tokenHash: string;
  actorId: string;
  installationId: string;
  transportHash: string;
  semanticFingerprint: string;
  destinationCatalogDigest: string;
  identityMapDigest: string;
  materializedContentDigest: string;
  collisionPolicy: string;
  expiresAt: string;
  appliedInvestigationId: string | null;
}

export interface PortableApplyStateStore {
  putIntent(intent: StoredPortableApplyIntent): Promise<void>;
  getIntent(tokenHash: string): Promise<StoredPortableApplyIntent | null>;
  findApplied(input: {
    actorId: string;
    installationId: string;
    transportHash: string;
  }): Promise<StoredPortableApplyIntent | null>;
  lockApply(input: {
    actorId: string;
    installationId: string;
    transportHash: string;
  }): Promise<void>;
  markApplied(tokenHash: string, investigationId: string): Promise<void>;
}

type CaseRow = Parameters<CaseStore["insertCase"]>[0];
type RevisionRow = Parameters<CaseStore["insertRevision"]>[0];
type ArtifactRow = Parameters<CaseStore["insertArtifact"]>[0];
type SourceRow = Parameters<CatalogStore["insert"]>[0];
type FrozenRunRow = Parameters<RunStore["insert"]>[0];
type ExperimentRow = Parameters<ExperimentStore["insert"]>[0];

interface Capturable {
  capture(): unknown;
  restore(snapshot: unknown): void | Promise<void>;
}

export interface MemoryApplyBoundary {
  withTransaction: <T>(operation: (ports: PortablePersistPorts) => Promise<T>) => Promise<T>;
}

function remapOf(
  report: ArchivePreflightReportV1,
  kind: PortableObjectKind,
  sourceId: string,
): string {
  const hit = report.idRemap.find((row) => row.namespace === kind && row.sourceId === sourceId);
  return hit?.destinationId ?? sourceId;
}

export function remapPortableTimelineTarget(
  report: ArchivePreflightReportV1,
  namespace: PortableObjectKind,
  targetId: string,
): string {
  if (namespace === "triage_job") {
    const attempt = parsePortableTriageAttemptTarget(targetId);
    if (attempt) {
      return `${remapOf(report, "triage_job", attempt.jobId)}:${attempt.candidateId}`;
    }
  }
  if (namespace === "experiment") {
    const parsed = parsePortableExperimentTraceTarget(targetId);
    if (parsed) {
      return `${remapOf(report, "experiment", parsed.experimentId)}:${parsed.traceId}`;
    }
  }
  return remapOf(report, namespace, targetId);
}

function remapHypothesisLinks(
  report: ArchivePreflightReportV1,
  links: readonly { kind: "artifact" | "contribution"; id: string }[] | undefined,
  bundle: PortableArchiveV1["investigation"],
): { kind: "artifact" | "contribution"; id: string }[] {
  const contributionIds = new Set(bundle.contributions.map((row) => row.id));
  const evidenceIds = new Set(bundle.evidence.map((row) => row.id));
  return [...(links ?? [])]
    .slice()
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
    .map((link) => {
      if (link.kind === "artifact") {
        if (!evidenceIds.has(link.id)) {
          throw new Error("hypothesis artifact link is missing a portable evidence target");
        }
        return { kind: link.kind, id: remapOf(report, "evidence", link.id) };
      }
      if (!contributionIds.has(link.id)) {
        throw new Error("hypothesis contribution link is missing a portable contribution target");
      }
      return { kind: link.kind, id: remapOf(report, "contribution", link.id) };
    });
}

function restoredImportedRunBytes(
  digest: string | null | undefined,
  digestBytes: Map<string, Uint8Array>,
  missing: string,
): { hash: string | null; text: string | null } {
  if (!digest) return { hash: null, text: null };
  const bytes = digestBytes.get(digest);
  if (!bytes) throw new Error(missing);
  return { hash: digest, text: Buffer.from(bytes).toString("utf8") };
}

function remappedImportedRunContributionId(
  report: ArchivePreflightReportV1,
  run: PortableArchiveV1["investigation"]["importedAiRuns"][number],
  bundle: PortableArchiveV1["investigation"],
): string {
  if (!run.contributionId) {
    throw new Error("imported run is missing a portable external-run contribution target");
  }
  const hit = bundle.contributions.find((row) => row.id === run.contributionId);
  if (!hit || hit.kind !== "external_run") {
    throw new Error("imported run is missing a portable external-run contribution target");
  }
  return remapOf(report, "contribution", run.contributionId);
}

function isContributionHistoryKind(kind: string): boolean {
  return kind === "contribution_created"
    || kind === "contribution_revised"
    || kind === "contribution_tombstoned"
    || kind === "hypothesis_status";
}

function isDecisionHistoryKind(kind: string): boolean {
  return /^experiment_decision_/.test(kind);
}

function historyRowForEvent<T extends { id: string; revision: number }>(
  rows: readonly T[],
  event: PortableArchiveV1["investigation"]["timeline"][number],
  timeline: PortableArchiveV1["investigation"]["timeline"],
  matchesKind: (kind: string) => boolean,
): T | undefined {
  if (!event.targetId) return undefined;
  const chain = rows
    .filter((row) => row.id === event.targetId)
    .slice()
    .sort((left, right) => left.revision - right.revision);
  const events = timeline
    .filter((row) => row.targetId === event.targetId && matchesKind(row.kind))
    .slice()
    .sort((left, right) => left.seq - right.seq);
  const index = events.findIndex((row) => row.seq === event.seq);
  if (index < 0) return chain[0];
  return chain[index];
}

function importedTimelinePayload(
  event: PortableArchiveV1["investigation"]["timeline"][number],
  bundle: PortableArchiveV1["investigation"],
  report: ArchivePreflightReportV1,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    imported: true,
    sourceSeq: event.seq,
    sourceInstallationId: bundle.sourceInstallationId,
  };
  if (event.targetNamespace === "contribution" && event.targetId) {
    const contribution = isContributionHistoryKind(event.kind)
      ? historyRowForEvent(
        bundle.contributions,
        event,
        bundle.timeline,
        isContributionHistoryKind,
      )
      : bundle.contributions.find((row) => row.id === event.targetId);
    if (contribution) {
      payload.kind = contribution.kind;
      payload.revision = contribution.revision;
      payload.privacyClass = contribution.privacyClass;
      payload.contentHash = contribution.contentHash;
      payload.sourceId = remapOf(report, "source", contribution.sourceId);
      if (contribution.tombstoned) payload.tombstone = true;
      if (contribution.hypothesisStatus) payload.status = contribution.hypothesisStatus;
      if (event.kind === "hypothesis_status") {
        payload.links = remapHypothesisLinks(report, contribution.hypothesisLinks, bundle);
      }
    }
  }
  if (event.targetNamespace === "evidence" && event.targetId) {
    const evidence = bundle.evidence.find((row) => row.id === event.targetId);
    if (evidence) {
      payload.artifactKind = evidence.artifactKind ?? null;
      payload.privacyClass = evidence.privacyClass;
      payload.contentHash = evidence.digest;
    }
  }
  if (event.targetNamespace === "decision" && event.targetId) {
    const decision = historyRowForEvent(
      bundle.decisions,
      event,
      bundle.timeline,
      isDecisionHistoryKind,
    ) ?? bundle.decisions.find((row) => row.id === event.targetId);
    if (decision) {
      payload.decisionId = remapOf(report, "decision", decision.id);
      payload.revision = decision.revision;
      const experiment = bundle.experiments.find((row) => row.id === decision.experimentId);
      if (experiment) payload.packageId = experiment.packageId;
    }
  }
  if (event.targetNamespace === "gold" && event.targetId) {
    const gold = bundle.gold.find((row) => row.goldId === event.targetId);
    payload.goldId = remapOf(report, "gold", event.targetId);
    if (gold) {
      payload.version = gold.version;
      payload.acceptedDecisionId = remapOf(report, "decision", gold.acceptedDecisionId);
      payload.acceptedDecisionRevision = gold.acceptedDecisionRevision;
      payload.predecessorGoldId = gold.predecessorGoldId
        ? remapOf(report, "gold", gold.predecessorGoldId)
        : null;
    }
  }
  if (event.targetNamespace === "helpfulness" && event.targetId) {
    const observation = bundle.helpfulnessObservations.find((row) => row.id === event.targetId);
    payload.observationId = remapOf(report, "helpfulness", event.targetId);
    if (observation) {
      payload.candidateId = observation.candidateId;
      payload.dimension = observation.dimension;
    }
  }
  if (event.targetNamespace === "triage_job" && event.targetId) {
    const attempt = parsePortableTriageAttemptTarget(event.targetId);
    payload.jobId = remapOf(report, "triage_job", attempt?.jobId ?? event.targetId);
    if (attempt) payload.candidateId = attempt.candidateId;
  }
  if (event.targetNamespace === "experiment" && event.targetId) {
    const parsed = parsePortableExperimentTraceTarget(event.targetId);
    if (parsed) {
      payload.traceId = parsed.traceId;
      payload.experimentId = remapOf(report, "experiment", parsed.experimentId);
    }
  }
  if (event.targetNamespace === "snapshot" && event.targetId) {
    payload.snapshotId = remapOf(report, "snapshot", event.targetId);
  }
  if (event.targetNamespace === "intake_batch" && event.targetId) {
    payload.intakeBatchId = remapOf(report, "intake_batch", event.targetId);
  }
  return payload;
}

function actorAttribution(
  sourceActorId: string,
  identityMap: IdentityMapEntryV1[],
  report: ArchivePreflightReportV1,
  archive: PortableArchiveV1,
  destinationUsernames: ReadonlyMap<string, string>,
): { id: string; username: string } {
  const mapped = identityMap.find((row) => row.sourceActorId === sourceActorId);
  const snapshot = archive.investigation.actors.find((row) => row.sourceActorId === sourceActorId);
  const username = snapshot?.username || snapshot?.displayName || "historical-operator";
  if (mapped?.action === "map_existing" && mapped.destinationActorId) {
    const canonical = destinationUsernames.get(mapped.destinationActorId);
    if (!canonical) throw new Error("mapped destination identity is absent from the host catalog");
    return { id: mapped.destinationActorId, username: historicalUsername(canonical) };
  }
  return { id: remapOf(report, "actor", sourceActorId), username: historicalUsername(username) };
}

function historicalUsername(username: string): string {
  const value = username.trim() || "operator";
  return value.startsWith("historical-") ? value : `historical-${value}`;
}

type ExactPortableTriageCandidateFields =
  | "status"
  | "benchmarkRunId"
  | "summary"
  | "unknowns"
  | "errorCode"
  | "startedAt"
  | "finishedAt"
  | "privacyClass";

type ExactPortableTriageCandidate = Omit<
  PortableTriageCandidateV1,
  ExactPortableTriageCandidateFields
> & Required<Pick<PortableTriageCandidateV1, ExactPortableTriageCandidateFields>>;

type ExactPortableTriageJobFields =
  | "requestMode"
  | "question"
  | "policyFingerprint"
  | "taskFingerprint"
  | "concurrency"
  | "sameSnapshot"
  | "agreementNotice"
  | "updatedAt"
  | "startedAt"
  | "finishedAt"
  | "cancelRequestedAt"
  | "stoppedReason";

type ExactPortableTriageJob = Omit<
  PortableTriageJobV1,
  "candidates" | ExactPortableTriageJobFields
> & Required<Pick<
  PortableTriageJobV1,
  ExactPortableTriageJobFields
>> & { candidates: ExactPortableTriageCandidate[] };

function requireExactPortableJobState(
  job: PortableTriageJobV1,
): ExactPortableTriageJob {
  if (!(PORTABLE_TERMINAL_TRIAGE_STATUSES as readonly string[]).includes(job.status)) {
    throw new Error("nonterminal portable triage job cannot be persisted");
  }
  if (
    job.requestMode === undefined ||
    job.question === undefined ||
    job.policyFingerprint === undefined ||
    job.taskFingerprint === undefined ||
    job.concurrency === undefined ||
    job.sameSnapshot === undefined ||
    job.agreementNotice === undefined ||
    job.updatedAt === undefined ||
    job.startedAt === undefined ||
    job.finishedAt === undefined ||
    job.cancelRequestedAt === undefined ||
    job.stoppedReason === undefined
  ) {
    throw new Error("portable triage job is missing exact terminal history");
  }
  for (const candidate of job.candidates) {
    if (
      candidate.status === undefined ||
      !(PORTABLE_TERMINAL_TRIAGE_STATUSES as readonly string[]).includes(candidate.status) ||
      candidate.benchmarkRunId === undefined ||
      candidate.summary === undefined ||
      candidate.unknowns === undefined ||
      candidate.errorCode === undefined ||
      candidate.startedAt === undefined ||
      candidate.finishedAt === undefined ||
      candidate.privacyClass === undefined
    ) {
      throw new Error("portable triage candidate is missing exact terminal history");
    }
  }
  return job as unknown as ExactPortableTriageJob;
}

function asCapturable(store: object): Capturable {
  const candidate = store as Capturable;
  if (typeof candidate.capture !== "function" || typeof candidate.restore !== "function") {
    throw new Error("apply snapshot requires capture/restore on memory stores");
  }
  return candidate;
}

function cloneIntent(intent: StoredPortableApplyIntent): StoredPortableApplyIntent {
  return { ...intent };
}

export class MemoryPortableApplyStateStore implements PortableApplyStateStore {
  private readonly intents = new Map<string, StoredPortableApplyIntent>();

  capture(): unknown {
    return structuredClone({ intents: [...this.intents.entries()] });
  }

  restore(snapshot: unknown): void {
    const row = structuredClone(snapshot) as {
      intents: [string, StoredPortableApplyIntent][];
    };
    this.intents.clear();
    for (const [tokenHash, intent] of row.intents) this.intents.set(tokenHash, intent);
  }

  async putIntent(intent: StoredPortableApplyIntent): Promise<void> {
    this.intents.set(intent.tokenHash, cloneIntent(intent));
  }

  async getIntent(tokenHash: string): Promise<StoredPortableApplyIntent | null> {
    const hit = this.intents.get(tokenHash);
    return hit ? cloneIntent(hit) : null;
  }

  async findApplied(input: {
    actorId: string;
    installationId: string;
    transportHash: string;
  }): Promise<StoredPortableApplyIntent | null> {
    const hit = [...this.intents.values()].find(
      (row) =>
        row.appliedInvestigationId !== null &&
        row.actorId === input.actorId &&
        row.installationId === input.installationId &&
        row.transportHash === input.transportHash,
    );
    return hit ? cloneIntent(hit) : null;
  }

  async lockApply(): Promise<void> {
    // The memory apply coordinator holds one process-wide exclusive section.
  }

  async markApplied(tokenHash: string, investigationId: string): Promise<void> {
    const intent = this.intents.get(tokenHash);
    if (!intent) throw new Error("portable apply intent is missing");
    if (
      intent.appliedInvestigationId !== null &&
      intent.appliedInvestigationId !== investigationId
    ) {
      throw new Error("portable apply intent is already bound to another investigation");
    }
    intent.appliedInvestigationId = investigationId;
  }
}

type ApplyQueryable = Pick<Pool, "query">;

function storedIntentFromRow(row: Record<string, unknown>): StoredPortableApplyIntent {
  return {
    tokenHash: String(row.token_hash),
    actorId: String(row.actor_id),
    installationId: String(row.installation_id),
    transportHash: String(row.transport_hash),
    semanticFingerprint: String(row.semantic_fingerprint),
    destinationCatalogDigest: String(row.destination_catalog_digest),
    identityMapDigest: String(row.identity_map_digest),
    materializedContentDigest: String(row.materialized_content_digest),
    collisionPolicy: String(row.collision_policy),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    appliedInvestigationId:
      row.applied_investigation_id === null || row.applied_investigation_id === undefined
        ? null
        : String(row.applied_investigation_id),
  };
}

export class PgPortableApplyStateStore implements PortableApplyStateStore {
  constructor(
    private readonly db: ApplyQueryable,
    private readonly onMarkedApplied?: (tokenHash: string, investigationId: string) => void,
  ) {}

  async putIntent(intent: StoredPortableApplyIntent): Promise<void> {
    await this.db.query(
      `INSERT INTO portable_apply_intents (
         token_hash, actor_id, installation_id, transport_hash, semantic_fingerprint,
         destination_catalog_digest, identity_map_digest, materialized_content_digest,
         collision_policy, expires_at, applied_investigation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (token_hash) DO NOTHING`,
      [
        intent.tokenHash,
        intent.actorId,
        intent.installationId,
        intent.transportHash,
        intent.semanticFingerprint,
        intent.destinationCatalogDigest,
        intent.identityMapDigest,
        intent.materializedContentDigest,
        intent.collisionPolicy,
        intent.expiresAt,
        intent.appliedInvestigationId,
      ],
    );
  }

  async getIntent(tokenHash: string): Promise<StoredPortableApplyIntent | null> {
    const result = await this.db.query(
      `SELECT token_hash, actor_id, installation_id, transport_hash, semantic_fingerprint,
              destination_catalog_digest, identity_map_digest, materialized_content_digest,
              collision_policy, expires_at, applied_investigation_id
       FROM portable_apply_intents WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? storedIntentFromRow(row) : null;
  }

  async findApplied(input: {
    actorId: string;
    installationId: string;
    transportHash: string;
  }): Promise<StoredPortableApplyIntent | null> {
    const result = await this.db.query(
      `SELECT token_hash, actor_id, installation_id, transport_hash, semantic_fingerprint,
              destination_catalog_digest, identity_map_digest, materialized_content_digest,
              collision_policy, expires_at, applied_investigation_id
       FROM portable_apply_intents
       WHERE actor_id = $1 AND installation_id = $2 AND transport_hash = $3
         AND applied_investigation_id IS NOT NULL
       ORDER BY applied_at ASC, token_hash ASC
       LIMIT 1`,
      [input.actorId, input.installationId, input.transportHash],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? storedIntentFromRow(row) : null;
  }

  async lockApply(input: {
    actorId: string;
    installationId: string;
    transportHash: string;
  }): Promise<void> {
    await this.db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${input.actorId}\u0000${input.installationId}\u0000${input.transportHash}`,
    ]);
  }

  async markApplied(tokenHash: string, investigationId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE portable_apply_intents
       SET applied_investigation_id = COALESCE(applied_investigation_id, $2),
           applied_at = COALESCE(applied_at, CURRENT_TIMESTAMP)
       WHERE token_hash = $1
         AND (applied_investigation_id IS NULL OR applied_investigation_id = $2)`,
      [tokenHash, investigationId],
    );
    if (result.rowCount !== 1) throw new Error("portable apply intent was not claimable");
    this.onMarkedApplied?.(tokenHash, investigationId);
  }
}

export class PortableCommitOutcomeUnknownError extends Error {
  constructor() {
    super("portable apply database commit outcome is unknown");
    this.name = "PortableCommitOutcomeUnknownError";
  }
}

class MemoryApplyCoordinator {
  private readonly context = new AsyncLocalStorage<boolean>();
  private tail: Promise<void> = Promise.resolve();

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await this.context.run(true, operation);
    } finally {
      release();
    }
  }

  wrap(store: object): void {
    const names = new Set<string>();
    let prototype = Object.getPrototypeOf(store) as object | null;
    while (prototype && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) names.add(name);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    for (const name of names) {
      if (name === "constructor" || name === "capture" || name === "restore") continue;
      const original = Reflect.get(store, name);
      if (typeof original !== "function") continue;
      Reflect.set(store, name, (...args: unknown[]) =>
        this.exclusive(() => Promise.resolve(Reflect.apply(original, store, args))),
      );
    }
  }
}

async function beginEvidenceBatch(evidence: EvidenceStore): Promise<EvidenceWriteBatch> {
  if (typeof evidence.beginWriteBatch !== "function") {
    throw new Error("transactional evidence staging is unavailable");
  }
  return evidence.beginWriteBatch();
}

export function memoryApplyBoundary(input: {
  cases: CaseStore;
  catalog: CatalogStore;
  experiments: ExperimentStore;
  runs: RunStore;
  jobs: TriageJobStore;
  evidence: EvidenceStore;
  audit: AuditStore;
  applyState: PortableApplyStateStore;
  runDurably?: <T>(operation: () => Promise<T>) => Promise<T>;
}): MemoryApplyBoundary {
  const cases = asCapturable(input.cases);
  const catalog = asCapturable(input.catalog);
  const experiments = asCapturable(input.experiments);
  const runs = asCapturable(input.runs);
  const jobs = asCapturable(input.jobs);
  const audit = asCapturable(input.audit);
  const applyState = asCapturable(input.applyState);
  const coordinator = new MemoryApplyCoordinator();
  for (const store of [
    input.cases,
    input.catalog,
    input.experiments,
    input.runs,
    input.jobs,
    input.audit,
    input.applyState,
    input.evidence,
  ]) {
    coordinator.wrap(store);
  }
  async function withTransaction<T>(
    operation: (ports: PortablePersistPorts) => Promise<T>,
  ): Promise<T> {
    return coordinator.exclusive(async () => {
      const batch = await beginEvidenceBatch(input.evidence);
      const snapshot = {
        cases: await Promise.resolve(cases.capture()),
        catalog: await Promise.resolve(catalog.capture()),
        experiments: await Promise.resolve(experiments.capture()),
        runs: await Promise.resolve(runs.capture()),
        jobs: await Promise.resolve(jobs.capture()),
        audit: await Promise.resolve(audit.capture()),
        applyState: await Promise.resolve(applyState.capture()),
      };
      const execute = async (): Promise<T> => {
        const result = await operation({ ...input, evidence: batch });
        await batch.promote();
        return result;
      };
      try {
        const result = input.runDurably ? await input.runDurably(execute) : await execute();
        await batch.finalize();
        return result;
      } catch (error) {
        try {
          await Promise.resolve(cases.restore(snapshot.cases));
          await Promise.resolve(catalog.restore(snapshot.catalog));
          await Promise.resolve(experiments.restore(snapshot.experiments));
          await Promise.resolve(runs.restore(snapshot.runs));
          await Promise.resolve(jobs.restore(snapshot.jobs));
          await Promise.resolve(audit.restore(snapshot.audit));
          await Promise.resolve(applyState.restore(snapshot.applyState));
        } finally {
          await batch.rollback();
        }
        throw error;
      }
    });
  }
  return { withTransaction };
}

export async function withPgApplyTransaction<T>(
  db: Pool | Pick<Pool, "query">,
  evidence: EvidenceStore,
  operation: (ports: PortablePersistPorts) => Promise<T>,
): Promise<T> {
  if (evidence.writeCoordination !== "external") {
    throw new Error("PostgreSQL portable apply requires externally coordinated evidence writes");
  }
  const pooled = db instanceof Pool ? await db.connect() : null;
  const tx = pooled ?? db;
  let pooledReleased = false;
  const batch = await beginEvidenceBatch(evidence);
  let began = false;
  let commitAttempted = false;
  let result: T | undefined;
  const marked: Array<{ tokenHash: string; investigationId: string }> = [];
  try {
    await tx.query("BEGIN");
    began = true;
    result = await operation({
      cases: new PgCaseStore(tx),
      catalog: new PgCatalogStore(tx),
      experiments: new PgExperimentStore(tx),
      runs: new PgRunStore(tx),
      jobs: new PgTriageJobStore(tx),
      evidence: batch,
      audit: new PgAuditStore(tx),
      applyState: new PgPortableApplyStateStore(tx, (tokenHash, investigationId) => {
        marked.push({ tokenHash, investigationId });
      }),
    });
    await batch.promote();
    commitAttempted = true;
    await tx.query("COMMIT");
    await batch.finalize();
    return result;
  } catch (error) {
    if (commitAttempted && db instanceof Pool && marked.length > 0) {
      pooled?.release(error instanceof Error ? error : undefined);
      pooledReleased = true;
      began = false;
      try {
        const committed = await Promise.all(
          marked.map(async ({ tokenHash, investigationId }) => {
            const check = await db.query(
              `SELECT 1 FROM portable_apply_intents
               WHERE token_hash = $1 AND applied_investigation_id = $2`,
              [tokenHash, investigationId],
            );
            return check.rowCount === 1;
          }),
        );
        if (committed.every(Boolean)) {
          await batch.finalize();
          return result as T;
        }
      } catch {
        await batch.finalize({ retainPendingJournal: true });
        throw new PortableCommitOutcomeUnknownError();
      }
    } else if (commitAttempted) {
      await batch.finalize({ retainPendingJournal: true });
      throw new PortableCommitOutcomeUnknownError();
    }
    if (began) {
      try {
        await tx.query("ROLLBACK");
      } catch {
        // Preserve the mutation failure.
      }
    }
    await batch.rollback();
    throw error;
  } finally {
    if (!pooledReleased) pooled?.release();
  }
}

export async function persistPortableArchive(input: {
  archive: PortableArchiveV1;
  report: ArchivePreflightReportV1;
  identityMap: IdentityMapEntryV1[];
  actor: Actor;
  destinationUsernames: ReadonlyMap<string, string>;
  contentBytes: ReadonlyMap<string, Uint8Array>;
  ports: PortablePersistPorts;
  now: string;
  origin?: string;
}): Promise<string> {
  const { archive, report, identityMap, actor, destinationUsernames, contentBytes, ports, now } = input;
  const attribution = (sourceActorId: string) =>
    actorAttribution(sourceActorId, identityMap, report, archive, destinationUsernames);
  const investigationId = remapOf(
    report,
    "investigation",
    archive.investigation.investigation.id,
  );
  const bundle = archive.investigation;
  for (const event of bundle.timeline) {
    if (event.kind === "corpus_intake_committed" && (event.targetNamespace !== "intake_batch" || !event.targetId)) {
      throw new Error("corpus intake timeline is missing a portable intake-batch target");
    }
    if (
      /^experiment_decision_/.test(event.kind)
      && (event.targetNamespace !== "decision" || !event.targetId)
    ) {
      throw new Error("experiment decision timeline is missing a portable decision target");
    }
    if (event.kind === "experiment_gold_promoted" && (event.targetNamespace !== "gold" || !event.targetId)) {
      throw new Error("experiment gold timeline is missing a portable gold target");
    }
    if (
      event.kind === "experiment_helpfulness_recorded"
      && (event.targetNamespace !== "helpfulness" || !event.targetId)
    ) {
      throw new Error("experiment helpfulness timeline is missing a portable helpfulness target");
    }
    if (event.kind === "experiment_imported" && (event.targetNamespace !== "experiment" || !event.targetId)) {
      throw new Error("experiment import timeline is missing a portable experiment target");
    }
    if (event.kind === "experiment_trace_imported") {
      const parsed = event.targetId ? parsePortableExperimentTraceTarget(event.targetId) : null;
      if (event.targetNamespace !== "experiment" || !parsed) {
        throw new Error("experiment trace timeline is missing a portable experiment+trace target");
      }
    }
    if (/^triage_candidate_/.test(event.kind)) {
      const parsed = event.targetId ? parsePortableTriageAttemptTarget(event.targetId) : null;
      if (event.targetNamespace !== "triage_job" || !parsed) {
        throw new Error("workstream attempt timeline is missing a portable job target");
      }
    }
    if (event.kind === "snapshot_frozen" && (event.targetNamespace !== "snapshot" || !event.targetId)) {
      throw new Error("snapshot timeline is missing a portable snapshot target");
    }
    if (
      event.kind === "external_run_imported"
      && (event.targetNamespace !== "imported_ai_run" || !event.targetId)
    ) {
      throw new Error("imported-run timeline is missing a portable imported-run target");
    }
    if (event.kind === "run_corroboration") {
      throw new Error("imported-run corroboration is not exact-applyable");
    }
    if (
      (/^contribution_/.test(event.kind) || event.kind === "hypothesis_status")
      && (event.targetNamespace !== "contribution" || !event.targetId)
    ) {
      throw new Error("contribution timeline is missing a portable contribution target");
    }
    if (/^evidence_/.test(event.kind) && (event.targetNamespace !== "evidence" || !event.targetId)) {
      throw new Error("evidence timeline is missing a portable evidence target");
    }
    if (/^triage_job_/.test(event.kind)) {
      const parsed = event.targetId ? parsePortableTriageAttemptTarget(event.targetId) : null;
      if (event.targetNamespace !== "triage_job" || !event.targetId || parsed) {
        throw new Error("workstream job timeline is missing a portable job target");
      }
    }
    if (isContributionHistoryKind(event.kind) && event.targetId) {
      const chain = bundle.contributions.filter((row) => row.id === event.targetId);
      const events = bundle.timeline.filter(
        (row) => row.targetId === event.targetId && isContributionHistoryKind(row.kind),
      );
      if (chain.length !== events.length) {
        throw new Error("contribution timeline cannot be reconstructed onto portable revisions exactly");
      }
    }
    if (isDecisionHistoryKind(event.kind) && event.targetId) {
      const chain = bundle.decisions.filter((row) => row.id === event.targetId);
      const events = bundle.timeline.filter(
        (row) => row.targetId === event.targetId && isDecisionHistoryKind(row.kind),
      );
      if (chain.length !== events.length) {
        throw new Error("decision timeline cannot be reconstructed onto portable revisions exactly");
      }
    }
  }
  const remapCandidateId = (candidateId: string): string => {
    const imported = bundle.importedAiRuns.find((run) => candidateId === `chat-${run.id}`);
    return imported
      ? `chat-${remapOf(report, "imported_ai_run", imported.id)}`
      : candidateId;
  };
  const caseRow: CaseRow = {
    id: investigationId,
    title: bundle.investigation.title,
    problemStatement: bundle.investigation.problemStatement,
    affectedParties: bundle.investigation.affectedParties,
    impact: bundle.investigation.impact,
    scope: bundle.investigation.scope,
    openQuestions: [...bundle.investigation.openQuestions],
    situationVersion: bundle.investigation.situationVersion,
    severity: bundle.investigation.severity,
    status: bundle.investigation.status,
    legalHold: bundle.investigation.legalHold,
    retentionClass: bundle.investigation.retentionClass,
    createdAt: bundle.investigation.createdAt,
    createdBy: attribution(bundle.investigation.createdBy).id,
    createdByUsername: attribution(bundle.investigation.createdBy).username,
    participants: [{ identityId: actor.id, username: actor.username }],
  };
  await ports.cases.insertCase(caseRow);

  for (const source of bundle.sources) {
    const id = remapOf(report, "source", source.id);
    const existing = await ports.catalog.get(id);
    if (existing) continue;
    const createdBy = attribution(source.createdBy);
    const row: SourceRow = {
      id,
      name: source.name,
      kind: source.kind,
      description: null,
      lifecycle: source.lifecycle,
      identityId: null,
      createdAt: source.createdAt,
      createdBy: createdBy.id,
    };
    await ports.catalog.insert(row);
  }

  const fallbackSourceId = bundle.sources[0]
    ? remapOf(report, "source", bundle.sources[0].id)
    : PERMANENT_UNKNOWN_SOURCE_ID;

  for (const contribution of [...bundle.contributions].sort(
    (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
  )) {
    const author = attribution(contribution.authorId);
    const rev: RevisionRow = {
      contributionId: remapOf(report, "contribution", contribution.id),
      caseId: investigationId,
      kind: contribution.kind,
      revision: contribution.revision,
      predecessorRevision: contribution.predecessorRevision,
      body: contribution.body ?? "",
      contentHash: contribution.contentHash,
      privacyClass: contribution.privacyClass,
      tombstone: contribution.tombstoned,
      authorId: author.id,
      authorUsername: author.username,
      createdAt: contribution.createdAt,
      hypothesisStatus: contribution.hypothesisStatus,
      hypothesisLinks: remapHypothesisLinks(report, contribution.hypothesisLinks, bundle),
      sourceId: remapOf(report, "source", contribution.sourceId),
    };
    await ports.cases.insertRevision(rev);
  }

  const digestBytes = new Map<string, Uint8Array>();
  for (const content of bundle.contentObjects) {
    if (content.inclusion === "present") {
      const bytes = contentBytes.get(content.digest);
      if (!bytes) throw new Error("materialized content bytes are missing");
      const stored = await ports.evidence.put(bytes, {
        contentType: content.contentType ?? "application/octet-stream",
      });
      if (stored.hash !== content.digest || stored.byteLength !== content.byteLength) {
        throw new Error("imported evidence digest mismatch");
      }
      digestBytes.set(content.digest, bytes);
    }
  }

  const intakeBatchIds = new Map<string, string>();
  for (const batch of bundle.intakeBatches ?? []) {
    if (!report.idRemap.some((row) => row.namespace === "intake_batch" && row.sourceId === batch.id)) {
      throw new Error("portable corpus intake batch is missing from the destination remap");
    }
    const id = remapOf(report, "intake_batch", batch.id);
    const sourcePayload = parseCorpusIntakeBatch(JSON.parse(batch.payloadJson));
    const createdBy = attribution(batch.createdBy);
    const payload = {
      ...sourcePayload,
      id,
      caseId: investigationId,
      replayed: false,
      createdBy: createdBy.id,
      items: sourcePayload.items.map((item) => ({
        ...item,
        artifactId: remapOf(report, "evidence", item.artifactId),
        sourceId: remapOf(report, "source", item.sourceId),
      })),
    };
    await ports.cases.insertIntakeBatch({
      id,
      caseId: investigationId,
      idempotencyKey: batch.idempotencyKey,
      requestDigest: batch.requestDigest,
      origin: batch.origin,
      sourceLabel: batch.sourceLabel,
      privacyClass: batch.privacyClass,
      createdAt: batch.createdAt,
      createdBy: createdBy.id,
      payloadJson: JSON.stringify(payload),
    });
    intakeBatchIds.set(batch.id, id);
  }

  for (const evidence of bundle.evidence) {
    const id = remapOf(report, "evidence", evidence.id);
    const uploader = attribution(evidence.createdBy);
    let intakeBatchId: string | null = null;
    if (evidence.intakeBatchId) {
      const mapped = intakeBatchIds.get(evidence.intakeBatchId);
      if (!mapped) throw new Error("portable evidence has a dangling corpus intake batch");
      intakeBatchId = mapped;
    }
    const row: ArtifactRow = {
      id,
      caseId: investigationId,
      kind: evidence.artifactKind ?? (
        bundle.attachments.some((item) => item.evidenceId === evidence.id)
          ? "attachment"
          : "log"
      ),
      filename: evidence.title,
      uri: null,
      mediaType: evidence.contentType,
      byteLength: evidence.byteLength,
      contentHash: digestBytes.has(evidence.digest) ? evidence.digest : null,
      expectedHash: evidence.digest,
      verificationStatus: digestBytes.has(evidence.digest) ? "verified" : "unverified",
      refId: null,
      privacyClass: evidence.privacyClass,
      summaryContributionId: evidence.summaryContributionId
        ? remapOf(report, "contribution", evidence.summaryContributionId)
        : null,
      uploaderId: uploader.id,
      uploaderUsername: uploader.username,
      sourceId: evidence.sourceId
        ? remapOf(report, "source", evidence.sourceId)
        : fallbackSourceId,
      relativePath: evidence.relativePath ?? evidence.title,
      intakeBatchId,
    };
    await ports.cases.insertArtifact(row);
  }

  const destSnapshotFingerprints = new Map<string, string>();
  for (const snap of bundle.snapshots) {
    const evidence = snap.evidence.map((item, ordinal) => ({
      evidenceId: remapOf(report, "evidence", item.evidenceId),
      ordinal,
      contentHash: item.contentHash,
      expectedHash: item.contentHash,
      verificationStatus: item.contentHash ? "verified" : null,
      privacyClass: item.privacyClass,
    }));
    const parentSnapshotId = snap.parentSnapshotId
      ? remapOf(report, "snapshot", snap.parentSnapshotId)
      : null;
    const fingerprint = snapshotFingerprint({
      parentSnapshotId,
      evidence,
      visibility: snap.visibility,
      protocolVersion: snap.protocolVersion,
    });
    destSnapshotFingerprints.set(snap.id, fingerprint);
    await ports.cases.insertSnapshot({
      schemaId: "cd-collab.snapshot.v1",
      id: remapOf(report, "snapshot", snap.id),
      caseId: investigationId,
      fingerprint,
      parentSnapshotId,
      evidence,
      visibility: snap.visibility,
      protocolVersion: snap.protocolVersion,
      fairnessClass: snapshotFairness(evidence),
      status: "frozen",
      createdAt: snap.createdAt,
      createdBy: attribution(snap.createdBy).id,
    });
  }

  for (const run of bundle.importedAiRuns) {
    const output = restoredImportedRunBytes(
      run.outputDigest,
      digestBytes,
      "imported output digest is missing from materialized content",
    );
    if (!output.hash || output.text === null) {
      throw new Error("imported run is missing output bytes");
    }
    const prompt = restoredImportedRunBytes(
      run.promptDigest,
      digestBytes,
      "imported prompt digest is missing from materialized content",
    );
    if (run.promptCompleteness === "exact" && (prompt.hash === null || prompt.text === null)) {
      throw new Error("imported run exact prompt completeness requires prompt bytes");
    }
    let snapshotBinding: string | null = null;
    if (run.snapshotId) {
      snapshotBinding = destSnapshotFingerprints.get(run.snapshotId) ?? null;
      if (!snapshotBinding) {
        throw new Error("imported run snapshot binding is missing from the destination snapshots");
      }
    }
    const operator = run.operatorId
      ? attribution(run.operatorId)
      : { id: actor.id, username: actor.username };
    const importer = run.importerId
      ? attribution(run.importerId)
      : { id: actor.id, username: actor.username };
    const row: FrozenRunRow = {
      id: remapOf(report, "imported_ai_run", run.id),
      caseId: investigationId,
      contributionId: remappedImportedRunContributionId(report, run, bundle),
      sourceId: remapOf(report, "source", run.sourceId),
      outputHash: output.hash,
      outputText: output.text,
      promptHash: prompt.hash,
      promptText: prompt.text,
      promptCompleteness: run.promptCompleteness ?? "unknown",
      outputCompleteness: run.outputCompleteness ?? "unknown",
      workflowCompleteness: run.workflowCompleteness ?? "unknown",
      evidenceVisibility: run.evidenceVisibility ?? "unknown",
      snapshotBinding,
      visibilityNote: run.visibilityNote ?? null,
      importerId: importer.id,
      importerUsername: importer.username,
      operatorId: operator.id,
      operatorUsername: operator.username,
      provider: run.providerKind,
      model: run.model,
      version: run.version,
      claimedTraces: [...(run.claimedTraces ?? [])],
      uncertainty: run.uncertainty ?? null,
      timing: run.timing ?? null,
      cost: run.cost ?? null,
      redacted: run.redacted === true,
      privacyClass: run.privacyClass ?? "owner_only",
      createdAt: run.importedAt,
    };
    await ports.runs.insert(row);
  }

  for (const portableJob of bundle.triageJobs) {
    const job = requireExactPortableJobState(portableJob);
    const requester = attribution(job.requestedBy);
    const snapshotFingerprintValue =
      destSnapshotFingerprints.get(job.snapshotId) ?? job.snapshotFingerprint;
    const row: TriageJobV1 = {
      schemaId: "cd-collab.triage_job.v1",
      id: remapOf(report, "triage_job", job.id),
      caseId: investigationId,
      snapshotId: remapOf(report, "snapshot", job.snapshotId),
      snapshotFingerprint: snapshotFingerprintValue,
      requestFingerprint: job.requestFingerprint,
      cancellationId: portableDestinationUuid(
        bundle.sourceInstallationId,
        "triage_job",
        `${job.id}:cancel`,
        0,
      ),
      ...(job.parentJobId
        ? { parentJobId: remapOf(report, "triage_job", job.parentJobId) }
        : {}),
      request: {
        schemaId: "cd-collab.triage_job_request.v1",
        snapshotId: remapOf(report, "snapshot", job.snapshotId),
        mode: job.requestMode,
        strategyId: job.strategyId,
        question: job.question,
        policyFingerprint: job.policyFingerprint,
        taskFingerprint: job.taskFingerprint,
        ...(job.concurrency !== null ? { concurrency: job.concurrency } : {}),
        ...(job.parentJobId ? { parentJobId: remapOf(report, "triage_job", job.parentJobId) } : {}),
        candidates: job.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          role: candidate.role,
          provider: candidate.providerKind,
          profileId: candidate.profileId,
          model: candidate.model,
          version: candidate.version,
        })),
      },
      status: job.status,
      candidates: job.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        role: candidate.role,
        provider: candidate.providerKind,
        profileId: candidate.profileId,
        model: candidate.model,
        version: candidate.version,
        status: candidate.status,
        benchmarkRunId: candidate.benchmarkRunId,
        outputHash: candidate.outputHash,
        summary: candidate.summary,
        evidenceRefs: candidate.evidenceRefs.map((id) => remapOf(report, "evidence", id)),
        unknowns: [...candidate.unknowns],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: candidate.errorCode,
        startedAt: candidate.startedAt,
        finishedAt: candidate.finishedAt,
        privacyClass: candidate.privacyClass,
      })),
      sameSnapshot: job.sameSnapshot,
      agreementNotice: job.agreementNotice,
      requestedBy: requester.id,
      requestedByUsername: requester.username,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      cancelRequestedAt: job.cancelRequestedAt,
      stoppedReason: job.stoppedReason,
      workerId: null,
      leaseExpiresAt: null,
    };
    await ports.jobs.insert(row);
  }

  for (const experiment of bundle.experiments) {
    const id = remapOf(report, "experiment", experiment.id);
    const experimentRow: ExperimentRow = {
      id,
      caseId: investigationId,
      packageId: experiment.packageId,
      sourceSchemaId: "cd-collab.experiment_package.v1",
      taskFingerprint: experiment.taskFingerprint,
      snapshotFingerprint:
        destSnapshotFingerprints.get(
          bundle.snapshots.find((snap) => snap.fingerprint === experiment.snapshotFingerprint)?.id ??
            "",
        ) ?? experiment.snapshotFingerprint,
      snapshotProof: {
        basis: "unknown",
        fairnessClass: "unknown",
        lineageClass: "unknown",
      },
      candidates: experiment.candidateIds.map((candidateId) => ({
        candidateId: remapCandidateId(candidateId),
        modelLabel: "imported-historical",
        role: "reviewer",
        runStatus: "completed",
        observedLatency: { status: "unknown" },
        cost: { status: "unknown" },
        usage: { status: "unknown" },
        helpfulnessState: "unreviewed",
        goldState: "unknown",
      })),
      agreement: { sharedAnchors: [], candidateSpecific: [], roleConflicts: [], notes: [] },
      createdAt: experiment.createdAt,
      importerId: actor.id,
      importerUsername: actor.username,
    };
    await ports.experiments.insert(experimentRow);
  }

  for (const observation of bundle.helpfulnessObservations) {
    const reviewer = attribution(observation.reviewerId);
    const row: HelpfulnessObservationV1 = {
      schemaId: "cd-collab.helpfulness_observation.v1",
      id: remapOf(report, "helpfulness", observation.id),
      experimentId: remapOf(report, "experiment", observation.experimentId),
      candidateId: remapCandidateId(observation.candidateId),
      dimension: observation.dimension,
      score: observation.score,
      rationale: observation.rationale,
      evidenceRefs: observation.evidenceRefs.map((id) => remapOf(report, "evidence", id)),
      reviewerId: reviewer.id,
      reviewerUsername: reviewer.username,
      createdAt: observation.createdAt,
    };
    await ports.experiments.insertObservation(row);
  }

  for (const decision of bundle.decisions) {
    const author = attribution(decision.authorId);
    const owner = decision.ownerId
      ? attribution(decision.ownerId)
      : null;
    const experiment = bundle.experiments.find((row) => row.id === decision.experimentId);
    const row: NormalizedExperimentDecisionV1 = {
      schemaId: "cd-collab.experiment_decision.v1",
      id: remapOf(report, "decision", decision.id),
      experimentId: remapOf(report, "experiment", decision.experimentId),
      status: decision.status,
      revision: decision.revision,
      predecessorRevision: decision.predecessorRevision,
      text: decision.text,
      rationale: decision.rationale,
      evidenceRefs: decision.evidenceRefs.map((id) => remapOf(report, "evidence", id)),
      packageId: experiment?.packageId ?? "pkg-imported",
      authorId: author.id,
      authorUsername: author.username,
      createdAt: decision.createdAt,
      ownerId: owner?.id ?? null,
      ownerUsername: owner?.username ?? null,
      remainingUnknowns: [...(decision.remainingUnknowns ?? [])],
    };
    await ports.experiments.insertDecision(row);
  }

  for (const gold of bundle.gold) {
    const promoter = attribution(gold.promotedById);
    const experiment = bundle.experiments.find((row) => row.id === gold.experimentId);
    const row: GoldReferenceV1 = {
      schemaId: "cd-collab.gold_reference.v1",
      goldId: remapOf(report, "gold", gold.goldId),
      version: gold.version,
      predecessorGoldId: gold.predecessorGoldId
        ? remapOf(report, "gold", gold.predecessorGoldId)
        : null,
      caseId: investigationId,
      experimentId: remapOf(report, "experiment", gold.experimentId),
      packageId: experiment?.packageId ?? "pkg-imported",
      taskFingerprint: experiment?.taskFingerprint ?? "00".repeat(32),
      snapshotFingerprint:
        destSnapshotFingerprints.get(
          bundle.snapshots.find((snap) => snap.fingerprint === experiment?.snapshotFingerprint)?.id ??
            "",
        ) ??
        experiment?.snapshotFingerprint ??
        "00".repeat(32),
      acceptedDecisionId: remapOf(report, "decision", gold.acceptedDecisionId),
      acceptedDecisionRevision: gold.acceptedDecisionRevision,
      auditRefs: [],
      evidenceAnchors: gold.evidenceAnchors.map((id) => remapOf(report, "evidence", id)),
      notes: gold.notes,
      promotedById: promoter.id,
      promotedByUsername: promoter.username,
      createdAt: gold.createdAt,
    };
    await ports.experiments.insertGold(row);
  }

  for (const event of bundle.timeline) {
    const historical = attribution(event.actorId);
    await ports.cases.appendTimeline(investigationId, {
      kind: event.kind,
      actor: historical,
      targetId:
        event.targetId &&
        event.targetNamespace &&
        (PORTABLE_OBJECT_KINDS as readonly string[]).includes(event.targetNamespace)
          ? remapPortableTimelineTarget(
            report,
            event.targetNamespace as PortableObjectKind,
            event.targetId,
          )
          : event.targetId,
      clientTime: null,
      serverTime: event.serverTime,
      payload: importedTimelinePayload(event, bundle, report),
    });
  }

  await ports.cases.appendTimeline(investigationId, {
    kind: "portable_archive_applied",
    actor,
    targetId: investigationId,
    clientTime: null,
    serverTime: now,
    payload: {
      sourceInstallationId: bundle.sourceInstallationId,
      transportHash: archive.transportHash,
      semanticFingerprint: archive.semanticFingerprint,
      sourceInvestigationId: bundle.investigation.id,
      appliedAt: now,
    },
  });

  await ports.audit.append({
    identity: actor.id,
    action: "portable_archive_apply",
    target: investigationId,
    origin: input.origin ?? "apply",
    outcome: "success",
  });

  return investigationId;
}
