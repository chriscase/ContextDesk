import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CATALOG_IDEMPOTENCY,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  parseSource,
  parseSourceMutationRefused,
  parseSourceMutationSuccess,
  type SourceCreateRequestV1,
  type SourceKind,
  type SourceMutationAction,
  type SourceMutationRefusal,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceRestoreRequestV1,
  type SourceRetireRequestV1,
  type SourceV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import { isSourceKind } from "./model.js";
import {
  CatalogCommitOutcomeUnknownError,
  CatalogIdentityBoundError,
  MemoryCatalogStore,
  newSourceId,
  toSourceV1,
  type CatalogStore,
  type SourceCatalogSuccessIntent,
  type SourceRow,
} from "./store.js";

export interface CatalogActor {
  id: string;
  username: string;
}

export class CatalogMutationRefusedError extends Error {
  constructor(readonly body: SourceMutationRefusedV1) {
    super(body.reason);
    this.name = "CatalogMutationRefusedError";
  }
}

export class CatalogVersionedSourceError extends Error {
  constructor() {
    super("versioned_source");
    this.name = "CatalogVersionedSourceError";
  }
}

export class CatalogPermanentUnknownError extends Error {
  constructor() {
    super("permanent_unknown_protected");
    this.name = "CatalogPermanentUnknownError";
  }
}

export { CatalogCommitOutcomeUnknownError };

const catalogCaseMutation = new AsyncLocalStorage<{ inserted: Set<string> }>();
const humanSourceMint = new AsyncLocalStorage<boolean>();

export function withCatalogCaseMutation<T>(operation: () => Promise<T>): Promise<T> {
  const existing = catalogCaseMutation.getStore();
  if (existing) return operation();
  return catalogCaseMutation.run({ inserted: new Set() }, operation);
}

function catalogIntentDigest(intent: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

function createIntentFields(input: {
  name: string;
  kind: SourceKind;
  description: string | null;
  identityId: string | null;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of SOURCE_CATALOG_IDEMPOTENCY.intentFields.create) {
    if (field === "action") fields.action = "create";
    else if (field === "name") fields.name = input.name;
    else if (field === "kind") fields.kind = input.kind;
    else if (field === "description") fields.description = input.description;
    else if (field === "identityId") fields.identityId = input.identityId;
  }
  return fields;
}

function sourceIntentFields(
  action: "retire" | "restore",
  sourceId: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of SOURCE_CATALOG_IDEMPOTENCY.intentFields[action]) {
    if (field === "action") fields.action = action;
    else if (field === "sourceId") fields.sourceId = sourceId;
  }
  return fields;
}

function refusalDetail(text: string): string {
  return text.normalize("NFKC").trim();
}

function mapLegacyStoreError(error: unknown): never {
  if (error instanceof CatalogIdentityBoundError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message === "versioned_source") throw new CatalogVersionedSourceError();
  if (message === "permanent_unknown_protected") throw new CatalogPermanentUnknownError();
  throw error;
}

export class CatalogService {
  constructor(
    private readonly store: CatalogStore = new MemoryCatalogStore(),
    private readonly audit?: AuditStore,
  ) {}

  async list(): Promise<SourceV1[]> {
    return (await this.store.list()).map(toSourceV1);
  }

  async get(id: string): Promise<SourceV1 | null> {
    const row = await this.store.get(id);
    return row ? toSourceV1(row) : null;
  }

  async findByIdentity(identityId: string): Promise<SourceV1 | null> {
    const row = await this.store.findByIdentity(identityId);
    return row ? toSourceV1(row) : null;
  }

  async rollbackCaseInserts(): Promise<void> {
    const inserted = catalogCaseMutation.getStore()?.inserted;
    if (!inserted || inserted.size === 0) return;
    for (const id of inserted) {
      if (id === PERMANENT_UNKNOWN_SOURCE_ID) continue;
      await this.store.remove(id);
    }
    inserted.clear();
  }

  /**
   * Locked source lookup for a later import slice. The lock is held only for
   * the duration of `operation`, and only inside this atomic callback or an
   * already-active catalog/case transaction.
   */
  async lockSourceForAttribution<T>(
    id: string,
    operation: (source: SourceV1) => Promise<T>,
  ): Promise<T> {
    return this.store.withAtomic(async () => {
      const row = await this.store.lockSource(id);
      if (!row) throw new Error("source not found");
      if (row.lifecycle === "retired") throw new Error("source is retired");
      return operation(toSourceV1(row));
    }, this.audit);
  }

  /**
   * Strict-import source inspection under the catalog row lock. Unlike the
   * legacy attribution helper, this intentionally returns missing, retired,
   * and unversioned states so the strict protocol can map them without
   * leaking raw store errors. When joined to a case transaction, no nested
   * transaction or early unlock is introduced.
   */
  async inspectLockedSourceForImport<T>(
    id: string,
    operation: (source: SourceV1 | null) => Promise<T>,
  ): Promise<T> {
    return this.store.withAtomic(async () => {
      const row = await this.store.lockSource(id);
      return operation(row ? toSourceV1(row) : null);
    }, this.audit);
  }

  async create(
    actor: CatalogActor,
    input: {
      name: string;
      kind: string;
      description?: string | null;
      identityId?: string | null;
    },
    origin: string,
  ): Promise<SourceV1> {
    if (!isSourceKind(input.kind)) {
      throw new Error(`unknown source kind: ${input.kind}`);
    }
    const persist = () =>
      this.persistNewSource(
        actor,
        {
          name: input.name,
          kind: input.kind as SourceKind,
          description: input.description ?? null,
          identityId: input.identityId ?? null,
        },
        origin,
        humanSourceMint.getStore() === true ? 1 : undefined,
      );
    if (this.joinsAmbientCaseMutation()) {
      return persist();
    }
    return this.store.withAtomic(persist, this.audit);
  }

  async update(
    actor: CatalogActor,
    id: string,
    patch: { name: string; description?: string | null },
    origin: string,
  ): Promise<SourceV1> {
    const apply = async () => {
      this.assertLegacyMutableTarget(id, await this.store.get(id));
      try {
        await this.store.updateMeta(id, {
          name: patch.name,
          description: patch.description ?? null,
        });
      } catch (error) {
        mapLegacyStoreError(error);
      }
      await this.audit?.append({
        identity: actor.id,
        action: "catalog_update",
        target: id,
        origin,
        outcome: "success",
      });
      const updated = await this.store.get(id);
      if (!updated) throw new Error("source not found");
      return toSourceV1(updated);
    };
    if (this.joinsAmbientCaseMutation()) return apply();
    return this.store.withAtomic(apply, this.audit);
  }

  async retire(actor: CatalogActor, id: string, origin: string): Promise<SourceV1> {
    const apply = async () => {
      this.assertLegacyMutableTarget(id, await this.store.get(id));
      try {
        await this.store.setLifecycle(id, "retired");
      } catch (error) {
        mapLegacyStoreError(error);
      }
      await this.audit?.append({
        identity: actor.id,
        action: "catalog_retire",
        target: id,
        origin,
        outcome: "success",
      });
      const updated = await this.store.get(id);
      if (!updated) throw new Error("source not found");
      return toSourceV1(updated);
    };
    if (this.joinsAmbientCaseMutation()) return apply();
    return this.store.withAtomic(apply, this.audit);
  }

  async applyCreate(
    actor: CatalogActor,
    request: SourceCreateRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    return this.runStrictMutation(() => this.applyCreateLocked(actor, request, origin));
  }

  async applyRetire(
    actor: CatalogActor,
    request: SourceRetireRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    return this.runStrictMutation(() => this.applyRetireLocked(actor, request, origin));
  }

  async applyRestore(
    actor: CatalogActor,
    request: SourceRestoreRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    return this.runStrictMutation(() => this.applyRestoreLocked(actor, request, origin));
  }

  async ensureHumanSource(actor: CatalogActor): Promise<SourceV1> {
    const existing = await this.store.findByIdentity(actor.id);
    if (existing) return toSourceV1(existing);
    try {
      return await humanSourceMint.run(true, () =>
        this.create(
          actor,
          {
            name: actor.username,
            kind: "human",
            description: "Directory identity",
            identityId: actor.id,
          },
          "system",
        ),
      );
    } catch (error) {
      // Concurrent first use may have won the identity uniqueness race.
      const concurrent = await this.store.findByIdentity(actor.id);
      if (concurrent) return toSourceV1(concurrent);
      throw error;
    }
  }

  // Resolves a source for new attributions (imports). Retired sources stay
  // visible via list/get for historical attribution but cannot be reused here.
  async requireSource(id: string): Promise<SourceV1> {
    const found = await this.get(id);
    if (!found) throw new Error("source not found");
    if (found.lifecycle === "retired") throw new Error("source is retired");
    return found;
  }

  private joinsAmbientCaseMutation(): boolean {
    return catalogCaseMutation.getStore() !== undefined && humanSourceMint.getStore() === true;
  }

  private async runStrictMutation(
    operation: () => Promise<SourceMutationSuccessV1>,
  ): Promise<SourceMutationSuccessV1> {
    if (!this.audit) {
      throw new Error("source catalog strict mutation requires an audit store");
    }
    return this.store.withAtomic(operation, this.audit);
  }

  private async applyCreateLocked(
    actor: CatalogActor,
    request: SourceCreateRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    await this.store.lockActorIdempotency(actor.id, request.idempotencyKey);
    const digest = catalogIntentDigest(
      createIntentFields({
        name: request.name,
        kind: request.kind,
        description: request.description,
        identityId: request.identityId,
      }),
    );
    const prior = await this.store.getSuccessIntent(actor.id, request.idempotencyKey);
    if (prior) {
      return this.replayOrMismatch(prior, digest, {
        action: "create",
        sourceId: null,
        expectedRevision: 0,
      });
    }
    if (request.identityId !== null) {
      await this.store.lockIdentity(request.identityId);
      const bound = await this.store.findByIdentity(request.identityId);
      if (bound) {
        throw this.refuse({
          action: "create",
          sourceId: bound.id,
          expectedRevision: 0,
          reason: "identity_already_bound",
          detail: "A catalog source with this identity already exists.",
          current: toSourceV1(bound),
        });
      }
    }
    const now = new Date().toISOString();
    const row: SourceRow & { revision: number } = {
      id: newSourceId(),
      name: request.name,
      kind: request.kind,
      description: request.description,
      lifecycle: "active",
      identityId: request.identityId,
      createdAt: now,
      createdBy: actor.id,
      revision: 1,
    };
    const success = this.buildSuccess("create", row, 0, 0, 1);
    try {
      await this.store.insert(row);
    } catch (error) {
      if (error instanceof CatalogIdentityBoundError) {
        throw this.refuse({
          action: "create",
          sourceId: error.current.id,
          expectedRevision: 0,
          reason: "identity_already_bound",
          detail: "A catalog source with this identity already exists.",
          current: toSourceV1(error.current),
        });
      }
      throw error;
    }
    await this.appendSuccessAudit(actor, "catalog_create", row.id, origin);
    await this.store.insertSuccessIntent({
      actorId: actor.id,
      idempotencyKey: request.idempotencyKey,
      action: "create",
      requestDigest: digest,
      sourceId: row.id,
      successJson: JSON.stringify(success),
      createdAt: now,
    });
    return success;
  }

  private async applyRetireLocked(
    actor: CatalogActor,
    request: SourceRetireRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    return this.applyLifecycleLocked(actor, "retire", request, origin);
  }

  private async applyRestoreLocked(
    actor: CatalogActor,
    request: SourceRestoreRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    return this.applyLifecycleLocked(actor, "restore", request, origin);
  }

  private async applyLifecycleLocked(
    actor: CatalogActor,
    action: "retire" | "restore",
    request: SourceRetireRequestV1 | SourceRestoreRequestV1,
    origin: string,
  ): Promise<SourceMutationSuccessV1> {
    await this.store.lockActorIdempotency(actor.id, request.idempotencyKey);
    const digest = catalogIntentDigest(sourceIntentFields(action, request.sourceId));
    const prior = await this.store.getSuccessIntent(actor.id, request.idempotencyKey);
    if (prior) {
      return this.replayOrMismatch(prior, digest, {
        action,
        sourceId: request.sourceId,
        expectedRevision: request.expectedRevision,
      });
    }

    const row = await this.store.lockSource(request.sourceId);
    this.assertLifecyclePreconditions(action, request, row);

    const previousRevision = row.revision as number;
    const appliedRevision = previousRevision + 1;
    const nextLifecycle = action === "retire" ? "retired" : "active";
    const appliedRow: SourceRow & { revision: number } = {
      ...row,
      lifecycle: nextLifecycle,
      revision: appliedRevision,
    };
    const success = this.buildSuccess(
      action,
      appliedRow,
      request.expectedRevision,
      previousRevision,
      appliedRevision,
    );
    await this.store.saveLifecycle(appliedRow.id, appliedRow.lifecycle, appliedRevision);
    await this.appendSuccessAudit(
      actor,
      action === "retire" ? "catalog_retire" : "catalog_restore",
      appliedRow.id,
      origin,
    );
    await this.store.insertSuccessIntent({
      actorId: actor.id,
      idempotencyKey: request.idempotencyKey,
      action,
      requestDigest: digest,
      sourceId: appliedRow.id,
      successJson: JSON.stringify(success),
      createdAt: new Date().toISOString(),
    });
    return success;
  }

  private assertLegacyMutableTarget(id: string, existing: SourceRow | null): SourceRow {
    if (!existing) throw new Error("source not found");
    if (id === PERMANENT_UNKNOWN_SOURCE_ID || existing.id === PERMANENT_UNKNOWN_SOURCE_ID) {
      throw new CatalogPermanentUnknownError();
    }
    if (existing.revision !== undefined) throw new CatalogVersionedSourceError();
    return existing;
  }

  private assertLifecyclePreconditions(
    action: "retire" | "restore",
    request: SourceRetireRequestV1 | SourceRestoreRequestV1,
    row: SourceRow | null,
  ): asserts row is SourceRow & { revision: number } {
    if (!row) {
      throw this.refuse({
        action,
        sourceId: request.sourceId,
        expectedRevision: request.expectedRevision,
        reason: "source_not_found",
        detail: "The catalog source does not exist.",
        current: null,
      });
    }
    const current = toSourceV1(row);
    if (row.id === PERMANENT_UNKNOWN_SOURCE_ID) {
      throw this.refuse({
        action,
        sourceId: row.id,
        expectedRevision: request.expectedRevision,
        reason: "permanent_unknown_protected",
        detail: "The permanent unknown source cannot be retired or restored.",
        current,
      });
    }
    if (row.revision === undefined) {
      throw this.refuse({
        action,
        sourceId: row.id,
        expectedRevision: request.expectedRevision,
        reason: "source_revision_unavailable",
        detail: "This catalog source has no revision and cannot be mutated with compare-and-swap.",
        current,
      });
    }
    if (action === "retire" && row.lifecycle === "retired") {
      throw this.refuse({
        action,
        sourceId: row.id,
        expectedRevision: request.expectedRevision,
        reason: "already_retired",
        detail: "The catalog source is already retired.",
        current,
      });
    }
    if (action === "restore" && row.lifecycle === "active") {
      throw this.refuse({
        action,
        sourceId: row.id,
        expectedRevision: request.expectedRevision,
        reason: "not_retired",
        detail: "The catalog source is not retired.",
        current,
      });
    }
    if (row.revision !== request.expectedRevision) {
      throw this.refuse({
        action,
        sourceId: row.id,
        expectedRevision: request.expectedRevision,
        reason: "expected_revision_mismatch",
        detail: "The recorded revision does not match expectedRevision.",
        current,
      });
    }
  }

  private replayOrMismatch(
    prior: SourceCatalogSuccessIntent,
    digest: string,
    context: {
      action: SourceMutationAction;
      sourceId: string | null;
      expectedRevision: number;
    },
  ): SourceMutationSuccessV1 {
    if (prior.requestDigest !== digest) {
      throw this.refuse({
        action: context.action,
        sourceId: context.sourceId,
        expectedRevision: context.expectedRevision,
        reason: "idempotency_intent_mismatch",
        detail: "This idempotency key was already used with a different intent.",
        current: null,
      });
    }
    return this.replaySuccess(prior, context.action, context.sourceId);
  }

  private replaySuccess(
    prior: SourceCatalogSuccessIntent,
    requestAction: SourceMutationAction,
    requestSourceId: string | null,
  ): SourceMutationSuccessV1 {
    let original: SourceMutationSuccessV1;
    try {
      original = parseSourceMutationSuccess(JSON.parse(prior.successJson) as unknown);
    } catch {
      throw new Error("source catalog success intent is corrupt");
    }
    if (
      prior.action !== requestAction ||
      original.action !== requestAction ||
      original.action !== prior.action ||
      original.sourceId !== prior.sourceId ||
      (requestSourceId !== null &&
        (prior.sourceId !== requestSourceId || original.sourceId !== requestSourceId))
    ) {
      throw new Error("source catalog success intent is incoherent");
    }
    return parseSourceMutationSuccess({ ...original, replayed: true });
  }

  private buildSuccess(
    action: SourceMutationAction,
    row: SourceRow & { revision: number },
    expectedRevision: number,
    previousRevision: number,
    appliedRevision: number,
  ): SourceMutationSuccessV1 {
    const applied = parseSource(toSourceV1(row));
    return parseSourceMutationSuccess({
      schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
      action,
      sourceId: row.id,
      expectedRevision,
      previousRevision,
      appliedRevision,
      replayed: false,
      applied,
    });
  }

  private refuse(input: {
    action: SourceMutationAction;
    sourceId: string | null;
    expectedRevision: number;
    reason: SourceMutationRefusal;
    detail: string;
    current: SourceV1 | null;
  }): CatalogMutationRefusedError {
    return new CatalogMutationRefusedError(
      parseSourceMutationRefused({
        schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
        error: "source_catalog_refused",
        action: input.action,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        detail: refusalDetail(input.detail),
        current: input.current,
      }),
    );
  }

  private async appendSuccessAudit(
    actor: CatalogActor,
    action: string,
    target: string,
    origin: string,
  ): Promise<void> {
    await this.audit?.append({
      identity: actor.id,
      action,
      target,
      origin,
      outcome: "success",
    });
  }

  private async persistNewSource(
    actor: CatalogActor,
    input: {
      name: string;
      kind: SourceKind;
      description: string | null;
      identityId: string | null;
    },
    origin: string,
    revision: number | undefined,
  ): Promise<SourceV1> {
    if (input.identityId !== null) {
      await this.store.lockIdentity(input.identityId);
      const bound = await this.store.findByIdentity(input.identityId);
      if (bound) throw new CatalogIdentityBoundError(bound);
    }
    const now = new Date().toISOString();
    const row: SourceRow = {
      id: newSourceId(),
      name: input.name,
      kind: input.kind,
      description: input.description,
      lifecycle: "active",
      identityId: input.identityId,
      createdAt: now,
      createdBy: actor.id,
    };
    if (revision !== undefined) row.revision = revision;
    try {
      await this.store.insert(row);
    } catch (error) {
      if (error instanceof CatalogIdentityBoundError) {
        throw error;
      }
      throw error;
    }
    const caseMutation = catalogCaseMutation.getStore();
    if (caseMutation && humanSourceMint.getStore()) {
      caseMutation.inserted.add(row.id);
    }
    await this.audit?.append({
      identity: actor.id,
      action: "catalog_create",
      target: row.id,
      origin,
      outcome: "success",
    });
    return toSourceV1(row);
  }
}
