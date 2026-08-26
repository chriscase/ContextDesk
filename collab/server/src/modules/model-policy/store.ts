import type { Pool } from "pg";
import { parseModelPurposePolicy, type ModelPurposePolicyV1 } from "@cd-collab/contracts";

export interface ModelPurposePolicyStore {
  load(): Promise<ModelPurposePolicyV1 | null>;
  save(policy: ModelPurposePolicyV1): Promise<void>;
}

export class MemoryModelPurposePolicyStore implements ModelPurposePolicyStore {
  private current: ModelPurposePolicyV1 | null;

  constructor(initial: ModelPurposePolicyV1 | null = null) {
    this.current = initial ? parseModelPurposePolicy(initial) : null;
  }

  capture(): unknown {
    return structuredClone(this.current);
  }

  restore(snapshot: unknown): void {
    this.current = snapshot === null ? null : parseModelPurposePolicy(snapshot);
  }

  async load(): Promise<ModelPurposePolicyV1 | null> {
    return this.current ? structuredClone(this.current) : null;
  }

  async save(policy: ModelPurposePolicyV1): Promise<void> {
    this.current = parseModelPurposePolicy(policy);
  }
}

export class PgModelPurposePolicyStore implements ModelPurposePolicyStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async load(): Promise<ModelPurposePolicyV1 | null> {
    const result = await this.pool.query(
      `SELECT policy FROM model_purpose_policy_state WHERE id = TRUE`,
    );
    const row = result.rows[0] as { policy?: unknown } | undefined;
    return row?.policy ? parseModelPurposePolicy(row.policy) : null;
  }

  async save(policy: ModelPurposePolicyV1): Promise<void> {
    const parsed = parseModelPurposePolicy(policy);
    await this.pool.query(
      `INSERT INTO model_purpose_policy_state (id, revision, policy, updated_at, updated_by)
       VALUES (TRUE, $1, $2::jsonb, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET revision = EXCLUDED.revision,
           policy = EXCLUDED.policy,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
      [parsed.revision, JSON.stringify(parsed), parsed.updatedAt, parsed.updatedBy],
    );
  }
}

