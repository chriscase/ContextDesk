import { SOURCE_SCHEMA_ID, type SourceV1 } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { directoryAttribution, projectSourceForCaller } from "./project.js";

const aliceDn = "uid=alice,ou=people,dc=example,dc=test";

function source(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: "11111111-1111-1111-1111-111111111111",
    name: "alice",
    kind: "human",
    description: "Directory identity",
    lifecycle: "active",
    identityId: aliceDn,
    createdAt: "2026-08-16T00:00:00.000Z",
    createdBy: aliceDn,
    ...overrides,
  };
}

describe("catalog source projection", () => {
  it("keeps raw directory fields for authorized callers", () => {
    const raw = source();
    expect(projectSourceForCaller(raw, true)).toEqual(raw);
  });

  it("removes DNs and usernames but keeps source id and kind", () => {
    const projected = projectSourceForCaller(source(), false);
    expect(projected.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(projected.kind).toBe("human");
    expect(projected.identityId).toBeNull();
    expect(projected.name).toBe(projected.id);
    expect(projected.createdBy).toBe(directoryAttribution(aliceDn));
    expect(projected.createdBy).not.toContain("uid=");
    expect(projected.createdBy).not.toContain("alice");
  });

  it("preserves non-identity source labels and hashes only directory creators", () => {
    const projected = projectSourceForCaller(
      source({
        name: "Web assistant",
        kind: "external-tool",
        identityId: null,
      }),
      false,
    );
    expect(projected.name).toBe("Web assistant");
    expect(projected.identityId).toBeNull();
    expect(projected.createdBy).toBe(directoryAttribution(aliceDn));
  });
});
