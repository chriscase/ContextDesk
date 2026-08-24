import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_HEALTH_COMPONENT_IDS,
  COMPONENT_HEALTH_SCHEMA_ID,
  parseComponentHealthResponse,
  projectComponentHealth,
} from "./component-health.js";

const here = dirname(fileURLToPath(import.meta.url));

function fixture(): unknown {
  return JSON.parse(
    readFileSync(join(here, "..", "fixtures", "component-health.synthetic.json"), "utf8"),
  ) as unknown;
}

describe("component health contract", () => {
  it("accepts the bounded synthetic fixture in canonical order", () => {
    const parsed = parseComponentHealthResponse(fixture());
    expect(parsed.schemaId).toBe(COMPONENT_HEALTH_SCHEMA_ID);
    expect(parsed.components.map((component) => component.id)).toEqual([
      ...COMPONENT_HEALTH_COMPONENT_IDS,
    ]);
    expect(parsed.components[0]?.storageMigration.state).toBe("current");
    expect(parsed.components[0]?.update.state).toBe("available");
    expect(parsed.components[2]?.reportStatus).toBe("not_reported");
  });

  it("projects missing peer reports to unknown without inferring compatibility", () => {
    const projected = projectComponentHealth({
      generatedAt: "2026-08-24T12:00:00.000Z",
      dataMode: "runtime",
      observations: [
        {
          id: "war_room_service",
          source: "runtime",
          version: "0.0.1",
          protocol: { name: "cd", version: "v1" },
          compatibility: {
            status: "compatible",
            scope: "component_health_contract",
            detail: "The response conforms to component-health.v1.",
          },
        },
      ],
    });

    expect(projected.components[0]).toMatchObject({
      reportStatus: "reported",
      version: "0.0.1",
    });
    expect(projected.components[0]?.compatibility.status).toBe("compatible");
    expect(projected.components[1]).toMatchObject({
      source: "not_reported",
      reportStatus: "not_reported",
      version: null,
      commit: null,
      protocol: null,
    });
    expect(projected.components[1]?.compatibility.status).toBe("not_evaluated");
    expect(projected.components[1]?.update.state).toBe("unknown");
  });

  it("rejects duplicate components, unknown fields, and false not-reported claims", () => {
    expect(() =>
      projectComponentHealth({
        generatedAt: "2026-08-24T12:00:00.000Z",
        dataMode: "runtime",
        observations: [
          { id: "desktop", source: "runtime", version: "0.0.1" },
          { id: "desktop", source: "runtime", version: "0.0.2" },
        ],
      }),
    ).toThrow(/duplicate component desktop/);

    const valid = fixture() as Record<string, unknown>;
    expect(() =>
      parseComponentHealthResponse({ ...valid, unexpected: true }),
    ).toThrow(/unknown key/);
    const components = [...(valid.components as Record<string, unknown>[])];
    components[2] = { ...components[2], reportStatus: "reported", version: "0.0.1" };
    expect(() => parseComponentHealthResponse({ ...valid, components })).toThrow(
      /not_reported source cannot claim a report/,
    );
  });

  it("rejects unknown projector ids, mixed data modes, and misleading labels", () => {
    expect(() =>
      projectComponentHealth({
        generatedAt: "2026-08-24T12:00:00.000Z",
        dataMode: "runtime",
        observations: [
          {
            id: "unknown-component",
            source: "runtime",
            version: "0.0.1",
          } as never,
        ],
      }),
    ).toThrow(/unknown component unknown-component/);

    expect(() =>
      projectComponentHealth({
        generatedAt: "2026-08-24T12:00:00.000Z",
        dataMode: "runtime",
        observations: [
          { id: "desktop", source: "synthetic_fixture", version: "0.0.1" },
        ],
      }),
    ).toThrow(/source must match dataMode runtime/);

    const valid = fixture() as Record<string, unknown>;
    const components = [...(valid.components as Record<string, unknown>[])];
    components[1] = { ...components[1], label: "War Room service" };
    expect(() => parseComponentHealthResponse({ ...valid, components })).toThrow(
      /expected Desktop/,
    );
  });

  it("does not allow an available update without a target", () => {
    const valid = fixture() as Record<string, unknown>;
    const components = [...(valid.components as Record<string, unknown>[])];
    components[0] = {
      ...components[0],
      update: { state: "available", targetVersion: null },
    };
    expect(() => parseComponentHealthResponse({ ...valid, components })).toThrow(
      /available update must include a target version/,
    );
  });
});
