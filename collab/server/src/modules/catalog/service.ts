import type { SourceKind, SourceV1 } from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import { isSourceKind } from "./model.js";

export interface CatalogActor {
  id: string;
  username: string;
}
import {
  MemoryCatalogStore,
  newSourceId,
  toSourceV1,
  type CatalogStore,
} from "./store.js";

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
    const now = new Date().toISOString();
    const row = {
      id: newSourceId(),
      name: input.name,
      kind: input.kind as SourceKind,
      description: input.description ?? null,
      lifecycle: "active" as const,
      identityId: input.identityId ?? null,
      createdAt: now,
      createdBy: actor.id,
    };
    await this.store.insert(row);
    await this.audit?.append({
      identity: actor.id,
      action: "catalog_create",
      target: row.id,
      origin,
      outcome: "success",
    });
    return toSourceV1(row);
  }

  async update(
    actor: CatalogActor,
    id: string,
    patch: { name: string; description?: string | null },
    origin: string,
  ): Promise<SourceV1> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error("source not found");
    await this.store.updateMeta(id, {
      name: patch.name,
      description: patch.description ?? null,
    });
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
  }

  async retire(actor: CatalogActor, id: string, origin: string): Promise<SourceV1> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error("source not found");
    await this.store.setLifecycle(id, "retired");
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
  }

  async ensureHumanSource(actor: CatalogActor): Promise<SourceV1> {
    const existing = await this.store.findByIdentity(actor.id);
    if (existing) return toSourceV1(existing);
    return this.create(
      actor,
      {
        name: actor.username,
        kind: "human",
        description: "Directory identity",
        identityId: actor.id,
      },
      "system",
    );
  }

  // Resolves a source for new attributions (imports). Retired sources stay
  // visible via list/get for historical attribution but cannot be reused here.
  async requireSource(id: string): Promise<SourceV1> {
    const found = await this.get(id);
    if (!found) throw new Error("source not found");
    if (found.lifecycle === "retired") throw new Error("source is retired");
    return found;
  }
}
