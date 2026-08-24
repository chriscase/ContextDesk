import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  OVERVIEW_ACTIVITY_CAP,
  OVERVIEW_ATTENTION_CAP,
  OVERVIEW_NOTICES,
  OVERVIEW_OPEN_CASE_CAP,
  OVERVIEW_PRESENCE_CAP,
  OVERVIEW_RUNNING_JOB_CAP,
  OVERVIEW_SCHEMA_ID,
  OVERVIEW_TERMINAL_JOB_CAP,
  overviewPresenceForStaticSnapshot,
  parseOverview,
} from "./overview.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ??
  addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const schemasDir = join(here, "..", "schemas");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compileOverviewSchema() {
  const ajv = new (Ajv2020 as new (opts: object) => {
    compile: (schema: object) => (data: unknown) => boolean;
  })({ allErrors: true, strict: true });
  (addFormats as (ajv: unknown) => void)(ajv);
  return ajv.compile(
    JSON.parse(readFileSync(join(schemasDir, "overview.v1.json"), "utf8")) as object,
  );
}

function parserRejected(value: unknown): boolean {
  try {
    parseOverview(value);
    return false;
  } catch {
    return true;
  }
}

describe("overview contract", () => {
  it("accepts the synthetic fixture and rejects unknown fields", () => {
    const parsed = parseOverview(loadFixture("overview.valid.json"));
    expect(parsed.schemaId).toBe(OVERVIEW_SCHEMA_ID);
    expect(parsed.notices).toEqual([...OVERVIEW_NOTICES]);
    expect(parsed.presence.reason).toBe("ephemeral_live");
    expect(() => parseOverview(loadFixture("overview.unknown-field.json"))).toThrow(/unknown key/);
  });

  it("fails closed on over-cap arrays, invented cost, and payload-like fields", () => {
    const valid = clone(loadFixture("overview.valid.json")) as Record<string, unknown>;
    const extraOpen = Array.from({ length: OVERVIEW_OPEN_CASE_CAP + 1 }, (_, index) => ({
      id: `case-${index}`,
      title: `Synthetic case ${index}`,
      status: "open",
      severity: "medium",
      createdAt: "2026-08-24T11:00:00.000Z",
    }));
    expect(() => parseOverview({ ...valid, openCases: extraOpen })).toThrow(/at most 12/);
    const extraActivity = Array.from({ length: OVERVIEW_ACTIVITY_CAP + 1 }, (_, index) => ({
      caseId: `case-${index}`,
      title: `Synthetic case ${index}`,
      kind: "case_created",
      actor: "fixture-lead",
      serverTime: "2026-08-24T11:00:00.000Z",
      seq: index + 1,
    }));
    expect(() => parseOverview({ ...valid, recentActivity: extraActivity })).toThrow(/at most 20/);
    const extraRunning = Array.from({ length: OVERVIEW_RUNNING_JOB_CAP + 1 }, (_, index) => ({
      ...((valid.queuedAndRunningJobs as object[])[0] as object),
      id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    }));
    expect(() => parseOverview({ ...valid, queuedAndRunningJobs: extraRunning })).toThrow(/at most 20/);
    const extraTerminal = Array.from({ length: OVERVIEW_TERMINAL_JOB_CAP + 1 }, (_, index) => ({
      ...((valid.recentTerminalJobs as object[])[0] as object),
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    }));
    expect(() => parseOverview({ ...valid, recentTerminalJobs: extraTerminal })).toThrow(/at most 20/);
    const extraAttention = Array.from({ length: OVERVIEW_ATTENTION_CAP + 1 }, (_, index) => ({
      ...((valid.attention as object[])[0] as object),
      decisionId: `55555555-5555-4555-${String(index).padStart(4, "0")}-555555555555`,
    }));
    expect(() => parseOverview({ ...valid, attention: extraAttention })).toThrow(/at most 20/);
    const extraPresence = Array.from({ length: OVERVIEW_PRESENCE_CAP + 1 }, (_, index) => ({
      caseId: `case-${index}`,
      identityId: `uid=fixture-${index}`,
      username: `fixture-${index}`,
      surface: "case_board",
      lastSeenAt: "2026-08-24T11:59:00.000Z",
    }));
    expect(() =>
      parseOverview({
        ...valid,
        presence: { available: true, reason: "ephemeral_live", ttlSeconds: 45, members: extraPresence },
      }),
    ).toThrow(/at most 20/);
    expect(() =>
      parseOverview({
        ...valid,
        queuedAndRunningJobs: [
          {
            ...((valid.queuedAndRunningJobs as object[])[0] as object),
            costUsd: 1.25,
          },
        ],
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseOverview({
        ...valid,
        recentActivity: [
          {
            ...((valid.recentActivity as object[])[0] as object),
            payload: { body: "planted timeline body" },
          },
        ],
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseOverview({
        ...valid,
        attention: [
          {
            ...((valid.attention as object[])[0] as object),
            text: "planted decision body",
          },
        ],
      }),
    ).toThrow(/unknown key/);
  });

  it("fails closed when static presence invents members or claims to be live", () => {
    const valid = clone(loadFixture("overview.valid.json")) as Record<string, unknown>;
    const liveMembers = (valid.presence as { members: unknown[] }).members;
    expect(() =>
      parseOverview({
        ...valid,
        presence: {
          available: false,
          reason: "static_snapshot",
          ttlSeconds: 45,
          members: liveMembers,
        },
      }),
    ).toThrow(/must not invent presence members/);
    expect(() =>
      parseOverview({
        ...valid,
        presence: {
          available: true,
          reason: "static_snapshot",
          ttlSeconds: 45,
          members: [],
        },
      }),
    ).toThrow(/cannot claim live presence/);
    const staticPresence = overviewPresenceForStaticSnapshot(45);
    expect(parseOverview({ ...valid, presence: staticPresence }).presence.available).toBe(false);
  });

  it("rejects missing notices, mixed job status groups, and empty minLength strings", () => {
    const valid = clone(loadFixture("overview.valid.json")) as Record<string, unknown>;
    expect(() => parseOverview({ ...valid, notices: OVERVIEW_NOTICES.slice(0, 5) })).toThrow(
      /each required notice/,
    );
    expect(() =>
      parseOverview({
        ...valid,
        notices: [...OVERVIEW_NOTICES.slice(0, 5), OVERVIEW_NOTICES[0]],
      }),
    ).toThrow(/each required notice/);
    expect(() =>
      parseOverview({
        ...valid,
        queuedAndRunningJobs: [
          {
            ...((valid.recentTerminalJobs as object[])[0] as object),
            status: "completed",
          },
        ],
      }),
    ).toThrow(/queued, running/);
    expect(() =>
      parseOverview({
        ...valid,
        openCases: [{ ...((valid.openCases as object[])[0] as object), title: "" }],
      }),
    ).toThrow(/non-empty string/);
    expect(() =>
      parseOverview({
        ...valid,
        queuedAndRunningJobs: [
          {
            ...((valid.queuedAndRunningJobs as object[])[0] as object),
            strategyVersion: "",
          },
        ],
      }),
    ).toThrow(/non-empty string/);
  });

  it("keeps JSON Schema and the runtime parser identical on accept and reject", () => {
    const schemaOk = compileOverviewSchema();
    const valid = loadFixture("overview.valid.json");
    expect(schemaOk(valid)).toBe(true);
    expect(parserRejected(valid)).toBe(false);

    const cases: unknown[] = [
      loadFixture("overview.unknown-field.json"),
      {
        ...(clone(valid) as Record<string, unknown>),
        queuedAndRunningJobs: [
          {
            ...(((clone(valid) as { queuedAndRunningJobs: object[] }).queuedAndRunningJobs[0] as object)),
            status: "completed",
          },
        ],
      },
      {
        ...(clone(valid) as Record<string, unknown>),
        recentTerminalJobs: [
          {
            ...(((clone(valid) as { recentTerminalJobs: object[] }).recentTerminalJobs[0] as object)),
            status: "running",
          },
        ],
      },
      {
        ...(clone(valid) as Record<string, unknown>),
        presence: {
          available: true,
          reason: "static_snapshot",
          ttlSeconds: 45,
          members: [],
        },
      },
      {
        ...(clone(valid) as Record<string, unknown>),
        presence: {
          available: false,
          reason: "ephemeral_live",
          ttlSeconds: 45,
          members: [],
        },
      },
      {
        ...(clone(valid) as Record<string, unknown>),
        notices: [...OVERVIEW_NOTICES.slice(0, 5), OVERVIEW_NOTICES[0]],
      },
      {
        ...(clone(valid) as Record<string, unknown>),
        openCases: [
          {
            ...(((clone(valid) as { openCases: object[] }).openCases[0] as object)),
            title: "",
          },
        ],
      },
    ];
    for (const value of cases) {
      expect(schemaOk(value)).toBe(false);
      expect(parserRejected(value)).toBe(true);
    }
  });

  it("matches the runtime safe-integer ceiling for every u64 field", () => {
    const schemaOk = compileOverviewSchema();
    const valid = clone(loadFixture("overview.valid.json")) as Record<string, unknown>;
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const invalid: unknown[] = [
      { ...valid, statusCounts: { ...(valid.statusCounts as object), open: unsafe } },
      { ...valid, severityCounts: { ...(valid.severityCounts as object), low: unsafe } },
      {
        ...valid,
        recentActivity: [
          { ...((valid.recentActivity as object[])[0] as object), seq: unsafe },
        ],
      },
      {
        ...valid,
        presence: { ...(valid.presence as object), ttlSeconds: unsafe },
      },
      {
        ...valid,
        attention: [
          { ...((valid.attention as object[])[0] as object), revision: unsafe },
        ],
      },
    ];
    for (const value of invalid) {
      expect(schemaOk(value)).toBe(false);
      expect(parserRejected(value)).toBe(true);
    }

    const atCeiling = {
      ...valid,
      statusCounts: { ...(valid.statusCounts as object), open: Number.MAX_SAFE_INTEGER },
    };
    expect(schemaOk(atCeiling)).toBe(true);
    expect(parserRejected(atCeiling)).toBe(false);
  });
});
