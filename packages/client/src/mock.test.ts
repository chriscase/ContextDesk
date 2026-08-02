import { describe, expect, it } from "vitest";
import { parseImportPreviewReport } from "@contextdesk/contracts";
import { engineClientConformance } from "./conformance";
import { createMockEngineClient, defaultMockPreview } from "./mock";

const IMPORTABLE_LOG_IDENTITIES = [
  "api/api-gateway.log",
  "api/payments.jsonl",
  "support.zip!/host-a.zip!/logs/app.log",
  "notes/console-notes.txt",
];

describe("mock engine client conformance", () => {
  const checks = engineClientConformance({
    createClient: () => createMockEngineClient(),
    previewPath: "/incidents/checkout-outage",
    allImportableIdentities: IMPORTABLE_LOG_IDENTITIES,
    nonEventIdentity: "metrics/gateway-metrics.json",
    unresolvedSources: ["api/api-gateway.log", "support.zip!/host-a.zip!/logs/app.log"],
  });

  for (const check of checks) {
    it(check.name, async () => {
      await check.run();
    });
  }
});

describe("mock formats.apply parity", () => {
  const sampleFormat = {
    schemaId: "contextdesk.reviewed_format.v1",
    formatId: "mock.app-log",
    version: 1,
    name: "Mock app log",
  };

  it("applies revision-bound bindings and fails closed on stale revision", async () => {
    const client = createMockEngineClient();
    const saved = await client.formats.save(sampleFormat);
    const rev = await client.formats.revision();
    const applied = await client.formats.apply({
      expectedStoreRevision: rev,
      bindings: [
        {
          sourceIdentity: "api/api-gateway.log",
          formatId: saved.formatId,
          version: saved.version,
          digest: saved.digest,
        },
      ],
    });
    expect(applied.storeRevision).toBe(rev);
    expect(applied.bindings).toHaveLength(1);
    expect(applied.bindings[0].sourceIdentity).toBe("api/api-gateway.log");

    await expect(
      client.formats.apply({
        expectedStoreRevision: rev - 1,
        bindings: [
          {
            sourceIdentity: "api/api-gateway.log",
            formatId: saved.formatId,
            version: saved.version,
            digest: saved.digest,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("import.run re-checks formatApply before staging", async () => {
    const client = createMockEngineClient();
    const saved = await client.formats.save(sampleFormat);
    const rev = await client.formats.revision();
    const plan = await client.import.preview("/incidents");
    await expect(
      client.import.run({
        path: "/incidents",
        planToken: plan.planToken,
        planVersion: plan.planVersion,
        selected: IMPORTABLE_LOG_IDENTITIES,
        formatApply: {
          expectedStoreRevision: 0,
          bindings: [
            {
              sourceIdentity: IMPORTABLE_LOG_IDENTITIES[0],
              formatId: saved.formatId,
              version: saved.version,
              digest: saved.digest,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Fresh matching revision succeeds.
    const report = await client.import.run({
      path: "/incidents",
      planToken: plan.planToken,
      planVersion: plan.planVersion,
      selected: IMPORTABLE_LOG_IDENTITIES,
      formatApply: {
        expectedStoreRevision: rev,
        bindings: [
          {
            sourceIdentity: IMPORTABLE_LOG_IDENTITIES[0],
            formatId: saved.formatId,
            version: saved.version,
            digest: saved.digest,
          },
        ],
      },
    });
    expect(report.corpusId).toBeTruthy();
  });
});

describe("mock engine client determinism", () => {
  it("returns the same preview plan bytes on every call", async () => {
    const client = createMockEngineClient();
    const first = await client.import.preview("/a");
    const second = await client.import.preview("/b");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.planToken).toMatch(/^mock-plan-[0-9a-f]{8}$/);
  });

  it("default preview is a valid frozen-contract report with every ledger state", () => {
    const report = parseImportPreviewReport(
      JSON.parse(JSON.stringify(defaultMockPreview())),
    );
    const statuses = new Set(report.items.map((item) => item.status));
    for (const status of [
      "ready",
      "review",
      "raw_fallback",
      "supporting",
      "ignored",
      "unsupported",
      "blocked",
    ]) {
      expect(statuses.has(status as never), `status ${status} present`).toBe(true);
    }
  });

  it("counts unselected importable sources as not_selected, never silently", async () => {
    const client = createMockEngineClient();
    const plan = await client.import.preview("/incidents");
    const report = await client.import.run({
      path: "/incidents",
      planToken: plan.planToken,
      planVersion: plan.planVersion,
      selected: IMPORTABLE_LOG_IDENTITIES.filter(
        (identity) => identity !== "notes/console-notes.txt",
      ),
    });
    expect(report.exclusionCounts).toEqual({ not_selected: 1 });
  });

  it("scripted failure emits a failed phase and preserves the message", async () => {
    const client = createMockEngineClient({ failNextRun: "disk full while staging" });
    const phases: string[] = [];
    client.events.onProcessProgress((progress) => phases.push(progress.phase));
    const plan = await client.import.preview("/incidents");
    const request = {
      path: "/incidents",
      planToken: plan.planToken,
      planVersion: plan.planVersion,
      selected: IMPORTABLE_LOG_IDENTITIES,
    };
    await expect(client.import.run(request)).rejects.toMatchObject({
      code: "failed",
      message: "disk full while staging",
    });
    expect(phases).toEqual(["failed"]);
    // Retry succeeds: the failure script is one-shot.
    const retry = await client.import.run(request);
    expect(retry.corpusId).toBe("mock-corpus-0001");
  });
});
