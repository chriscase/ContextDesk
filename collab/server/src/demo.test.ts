import { existsSync } from "node:fs";
import { LAB_EXPORT_V2_SCHEMA_ID, parseLabExportV2 } from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDemoApp,
  DEMO_PASSWORD,
  DEMO_USERNAME,
} from "./demo.js";

const apps: Awaited<ReturnType<typeof buildDemoApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ app }) => app.close()));
});

function cookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

describe("synthetic demo server", () => {
  it("seeds the three-model and interaction-strategy review stories", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    apps.push(demo);
    const root = await demo.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const headers = { cookie: cookie(login) };
    const session = await demo.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).roles).toEqual(["case-lead"]);
    const health = await demo.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).service).toBe("contextdesk-synthetic-demo");
    const ready = await demo.app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    const experiments = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/experiments`,
      headers,
    });
    expect(experiments.statusCode).toBe(200);
    const body = JSON.parse(experiments.body) as {
      experiments: {
        id: string;
        packageId: string;
        candidates: unknown[];
        traces: unknown[];
        observations: unknown[];
        decisions: { status: string }[];
        gold: { version: number } | null;
      }[];
    };
    expect(body.experiments.map((row) => row.packageId)).toEqual([
      "pkg-synth-three-model-checkout-v1",
      "pkg-synth-strategy-paths-v1",
    ]);
    expect(body.experiments[0]?.candidates).toHaveLength(3);
    expect(body.experiments[0]?.observations).toHaveLength(3);
    expect(body.experiments[1]?.traces).toHaveLength(2);
    expect(body.experiments.every((row) => row.decisions.at(-1)?.status === "accepted")).toBe(
      true,
    );
    expect(body.experiments.every((row) => row.gold?.version === 1)).toBe(true);

    const exported = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/experiments/${body.experiments[0]?.id}/export`,
      headers,
    });
    expect(exported.statusCode).toBe(200);
    const shareSafe = parseLabExportV2(JSON.parse(exported.body));
    expect(shareSafe.schemaId).toBe(LAB_EXPORT_V2_SCHEMA_ID);
    expect(shareSafe.review.candidates.map((row) => row.candidateAlias)).toEqual([
      "approach-1",
      "approach-2",
      "approach-3",
    ]);
    expect(shareSafe.review.omissions).toEqual({
      modelLabelsIncluded: false,
      participantIdentitiesIncluded: false,
      freeTextIncluded: false,
      privateContentIncluded: false,
      correlatableMetadataIncluded: false,
    });
    for (const withheld of [
      "uid=demo",
      "apiKey",
      "qwen-3.6-27b",
      "gpt-oss-120b",
      "ministral-14b",
      '"modelLabel"',
      '"rationale"',
      '"text"',
    ]) {
      expect(exported.body).not.toContain(withheld);
    }
  });

  it("removes its temporary evidence root when closed", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    expect(existsSync(demo.evidenceRoot)).toBe(true);
    await demo.app.close();
    expect(existsSync(demo.evidenceRoot)).toBe(false);
  });

  it("removes its temporary evidence root when app construction fails", async () => {
    let evidenceRoot = "";
    await expect(
      buildDemoApp({
        staticDir: null,
        onEvidenceRootCreated: (root) => {
          evidenceRoot = root;
        },
        appBuilder: () => Promise.reject(new Error("synthetic construction failure")),
      }),
    ).rejects.toThrow("synthetic construction failure");
    expect(evidenceRoot).not.toBe("");
    expect(existsSync(evidenceRoot)).toBe(false);
  });
});
