import { randomUUID } from "node:crypto";
import {
  DEFAULT_SNAPSHOT_VISIBILITY_POLICY,
  deriveCaseBoard,
  parseSnapshot,
  snapshotFairness,
  snapshotFingerprint,
  snapshotItemContentHash,
  type CaseBoardExperimentSource,
  type CaseBoardV1,
  type SnapshotItemVisibility,
  type SnapshotV1,
  type SnapshotVisibilityPolicyV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { Actor, CaseService } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import type { ImportService } from "../import/index.js";
import { MemorySnapshotStore, type SnapshotStore } from "./store.js";

export class SnapshotNotFoundError extends Error {
  constructor(message = "snapshot not found") {
    super(message);
    this.name = "SnapshotNotFoundError";
  }
}

export class SnapshotConflictError extends Error {
  readonly code: "stale_parent";

  constructor(code: SnapshotConflictError["code"], message: string) {
    super(message);
    this.name = "SnapshotConflictError";
    this.code = code;
  }
}

export interface FreezeSnapshotInput {
  evidenceIds: string[];
  parentSnapshotId?: string | null;
  visibilityByEvidenceId?: Readonly<Record<string, SnapshotItemVisibility>>;
  visibilityPolicy?: SnapshotVisibilityPolicyV1;
  protocolId?: string | null;
  protocolVersion?: string | null;
  expectedParentFingerprint?: string;
}

export class SnapshotService {
  private readonly store: SnapshotStore;
  private readonly experiments: ExperimentService | null;
  private readonly imports: ImportService | null;

  constructor(
    private readonly deps: {
      cases: CaseService;
      audit: AuditStore;
      snapshots?: SnapshotStore;
      experiments?: ExperimentService;
      imports?: ImportService;
    },
  ) {
    this.store = deps.snapshots ?? new MemorySnapshotStore();
    this.experiments = deps.experiments ?? null;
    this.imports = deps.imports ?? null;
  }

  async freeze(
    caseId: string,
    actor: Actor,
    input: FreezeSnapshotInput,
    origin: string,
    isAdmin: boolean,
  ): Promise<SnapshotV1> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new SnapshotNotFoundError("case not found");
    }
    const evidenceIds = input.evidenceIds;
    if (evidenceIds.length === 0) {
      throw new Error("at least one evidence item is required");
    }
    const seen = new Set<string>();
    for (const id of evidenceIds) {
      if (!id.trim()) throw new Error("evidenceId must not be empty");
      if (seen.has(id)) throw new Error(`duplicate evidenceId: ${id}`);
      seen.add(id);
    }

    const parentSnapshotId = input.parentSnapshotId ?? null;
    if (parentSnapshotId) {
      const parent = await this.store.get(parentSnapshotId);
      if (!parent || parent.caseId !== caseId) {
        throw new SnapshotNotFoundError("parent snapshot not found");
      }
      if (
        input.expectedParentFingerprint !== undefined &&
        input.expectedParentFingerprint !== parent.fingerprint
      ) {
        throw new SnapshotConflictError(
          "stale_parent",
          "parent snapshot fingerprint does not match the expected value",
        );
      }
    } else if (input.expectedParentFingerprint !== undefined) {
      throw new Error("expectedParentFingerprint requires parentSnapshotId");
    }

    const artifacts = await this.deps.cases.listArtifacts(caseId, actor, isAdmin);
    const byId = new Map(artifacts.map((row) => [row.id, row]));
    const items = evidenceIds.map((evidenceId) => {
      const artifact = byId.get(evidenceId);
      if (!artifact) throw new Error(`unknown evidenceId: ${evidenceId}`);
      return {
        evidenceId,
        contentHash: snapshotItemContentHash(artifact),
        visibility: input.visibilityByEvidenceId?.[evidenceId] ?? "strategy_visible",
        privacyClass: artifact.privacyClass,
      };
    });

    const visibilityPolicy = input.visibilityPolicy ?? {
      includeSummaries: DEFAULT_SNAPSHOT_VISIBILITY_POLICY.includeSummaries,
      includeRawBytes: DEFAULT_SNAPSHOT_VISIBILITY_POLICY.includeRawBytes,
    };
    const protocolId = input.protocolId ?? null;
    const protocolVersion = input.protocolVersion ?? null;
    const fingerprint = snapshotFingerprint({
      caseId,
      parentSnapshotId,
      items,
      visibilityPolicy,
      protocolId,
      protocolVersion,
    });
    const existing = await this.store.findByFingerprint(caseId, fingerprint);
    if (existing) {
      await this.deps.audit.append({
        identity: actor.id,
        action: "snapshot_freeze_idempotent",
        target: existing.snapshotId,
        origin,
        outcome: "success",
      });
      return existing;
    }

    const snapshot = parseSnapshot({
      schemaId: "cd-collab.snapshot.v1",
      snapshotId: randomUUID(),
      caseId,
      fingerprint,
      parentSnapshotId,
      items,
      visibilityPolicy,
      protocolId,
      protocolVersion,
      fairness: snapshotFairness(items),
      status: "frozen",
      privacyClass: "owner_only",
      createdAt: new Date().toISOString(),
      createdBy: actor.id,
      createdByUsername: actor.username,
    });
    await this.store.insert(snapshot);
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "snapshot_frozen",
      actor,
      targetId: snapshot.snapshotId,
      clientTime: null,
      payload: {
        snapshotId: snapshot.snapshotId,
        fingerprint: snapshot.fingerprint,
        parentSnapshotId: snapshot.parentSnapshotId,
        itemCount: snapshot.items.length,
        fairness: snapshot.fairness,
      },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "snapshot_freeze",
      target: snapshot.snapshotId,
      origin,
      outcome: "success",
    });
    return snapshot;
  }

  async list(caseId: string, actor: Actor, isAdmin: boolean): Promise<SnapshotV1[]> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return [];
    return this.store.listByCase(caseId);
  }

  async get(
    caseId: string,
    snapshotId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<SnapshotV1 | null> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return null;
    const row = await this.store.get(snapshotId);
    if (!row || row.caseId !== caseId) return null;
    return row;
  }

  async deriveBoard(
    caseId: string,
    actor: Actor,
    input: { snapshotId?: string | null; generatedAt?: string },
    isAdmin: boolean,
  ): Promise<CaseBoardV1> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new SnapshotNotFoundError("case not found");
    }
    const snapshotId: string | null = input.snapshotId ?? null;
    let artifacts = await this.deps.cases.listArtifacts(caseId, actor, isAdmin);
    if (snapshotId) {
      const snapshot = await this.get(caseId, snapshotId, actor, isAdmin);
      if (!snapshot) throw new SnapshotNotFoundError("snapshot not found");
      const allowed = new Set(snapshot.items.map((item) => item.evidenceId));
      artifacts = artifacts.filter((row) => allowed.has(row.id));
    }
    const contributions = await this.deps.cases.listContributions(caseId, actor, isAdmin);
    const generatedAt = input.generatedAt ?? new Date().toISOString();

    const boardInput: Parameters<typeof deriveCaseBoard>[0] = {
      caseId,
      snapshotId,
      generatedAt,
      artifacts,
      contributions,
    };
    if (this.experiments) {
      const views = await this.experiments.list(caseId, actor, isAdmin);
      const experiments: CaseBoardExperimentSource[] = views.map((view) => ({
        experimentId: view.id,
        agreement: view.agreement,
        decisions: view.decisions,
        gold: view.gold,
        traces: view.traces,
      }));
      boardInput.experiments = experiments;
    }
    if (this.imports) {
      boardInput.imports = await this.imports.listRuns(caseId, actor, isAdmin);
    }
    return deriveCaseBoard(boardInput);
  }
}
