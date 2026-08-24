import { existsSync } from "node:fs";
import {
  LAB_EXPORT_V2_SCHEMA_ID,
  parseCaseBoard,
  parseLabExportV2,
  parseCasePresence,
  parseSnapshot,
  parseSnapshotList,
  parseTriageJobList,
} from "@cd-collab/contracts";
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
    const unauthenticatedPresence = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/presence`,
    });
    expect(unauthenticatedPresence.statusCode).toBe(401);
    const presenceResponse = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/presence`,
      headers,
      payload: { surface: "experiment_lab" },
    });
    expect(presenceResponse.statusCode).toBe(200);
    const presence = parseCasePresence(JSON.parse(presenceResponse.body));
    expect(presence.members.map((member) => member.username)).toContain(DEMO_USERNAME);
    const health = await demo.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).service).toBe("contextdesk-synthetic-demo");
    const ready = await demo.app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);

    const snapshotResponse = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/snapshots`,
      headers,
      payload: { evidenceIds: [], visibility: "owner_only" },
    });
    expect(snapshotResponse.statusCode).toBe(200);
    const snapshot = parseSnapshot(JSON.parse(snapshotResponse.body));
    expect(snapshot.status).toBe("frozen");
    const snapshotsResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/snapshots`,
      headers,
    });
    expect(parseSnapshotList(JSON.parse(snapshotsResponse.body)).snapshots.length).toBeGreaterThanOrEqual(2);
    const jobsResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/triage-runs`,
      headers,
    });
    expect(jobsResponse.statusCode).toBe(200);
    const jobs = parseTriageJobList(JSON.parse(jobsResponse.body)).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.sameSnapshot).toBe(true);
    expect(jobs[0]?.candidates).toHaveLength(3);
    const shareSafeJob = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/triage-runs/${jobs[0]?.id}/share-safe`,
      headers,
    });
    expect(shareSafeJob.statusCode).toBe(200);
    expect(shareSafeJob.body).not.toContain("qwen-3.6-27b");
    expect(shareSafeJob.body).not.toContain("ev-demo-checkout-log");
    const boardResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/board?snapshotId=${snapshot.id}`,
      headers,
    });
    expect(boardResponse.statusCode).toBe(200);
    expect(parseCaseBoard(JSON.parse(boardResponse.body)).snapshotId).toBe(snapshot.id);
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
        traces: {
          candidateId: string;
          events: { excerpt: string | null; evidenceRefs: string[] }[];
        }[];
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
    expect(body.experiments[0]?.traces).toHaveLength(3);
    expect(
      body.experiments[0]?.traces.some((trace) =>
        trace.events.some(
          (event) =>
            event.evidenceRefs.includes("ev-demo-inventory-timeout") &&
            event.excerpt?.includes("TimeoutError"),
        ),
      ),
    ).toBe(true);
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
