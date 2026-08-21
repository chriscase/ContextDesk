import { describe, expect, it } from "vitest";
import { PgExperimentStore } from "./store.js";
import type { InteractionTraceV1 } from "@cd-collab/contracts";

describe("PgExperimentStore trace identity boundary", () => {
  it("stores a database UUID separately from a public trace alias", async () => {
    let params: unknown[] | undefined;
    const db = {
      query: async (_text: string, values: unknown[]) => {
        params = values;
        return { rows: [] };
      },
    };
    const store = new PgExperimentStore(db as never);
    const trace = {
      traceId: "trace-programmatic-diverge-v1",
      candidateId: "candidate-programmatic",
      createdAt: "2026-08-20T00:00:00.000Z",
    } as unknown as InteractionTraceV1;

    await store.insertTrace(
      "00000000-0000-0000-0000-000000000001",
      trace,
      "fingerprint",
    );

    expect(params?.[0]).not.toBe(trace.traceId);
    expect(params?.[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(params?.[5]).toContain(trace.traceId);
  });
});
