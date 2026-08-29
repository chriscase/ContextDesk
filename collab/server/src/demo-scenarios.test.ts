/**
 * What a first-time reader actually finds in the synthetic demo.
 *
 * These assertions are about the demo's *shape*, not its wording: that the
 * inventory shows more than one kind of investigation, that an investigation
 * carrying only human notes exists and is legitimate, that correspondence is
 * represented as evidence, that an archived case is present for the lifecycle
 * controls to act on, and that a historical case keeps its occurrence honest.
 *
 * A demo that only demonstrated the most elaborate path taught the wrong
 * lesson about what the product is for. That is the regression these guard.
 */
import { describe, expect, it } from "vitest";
import { captureStaticDemoRoutes } from "./demo-static.js";
import { buildDemoApp, DEMO_PASSWORD, DEMO_USERNAME } from "./demo.js";
import { parseCaseList, parseContributionList } from "@cd-collab/contracts";

function cookieOf(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function withDemo(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildDemoApp>>["app"];
    cookie: string;
    caseId: string;
  }) => Promise<void>,
) {
  const demo = await buildDemoApp({ staticDir: null });
  try {
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    await fn({ app: demo.app, cookie: cookieOf(login.headers), caseId: demo.caseId });
  } finally {
    await demo.app.close();
  }
}

async function listCases(app: Awaited<ReturnType<typeof buildDemoApp>>["app"], cookie: string) {
  const res = await app.inject({ method: "GET", url: "/api/cases", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return parseCaseList(JSON.parse(res.body)).cases;
}

describe("the demo shows more than one kind of investigation", () => {
  it("seeds several investigations, not a single model comparison", async () => {
    await withDemo(async ({ app, cookie }) => {
      const cases = await listCases(app, cookie);
      expect(cases.length).toBeGreaterThanOrEqual(4);
      const titles = cases.map((row) => row.title);
      expect(titles.some((title) => title.includes("Checkout timeouts"))).toBe(true);
      expect(titles.some((title) => title.includes("Overnight statements"))).toBe(true);
      expect(titles.some((title) => title.includes("historical notes only"))).toBe(true);
      expect(titles.some((title) => title.includes("Duplicate report"))).toBe(true);
    });
  });

  it("covers a range of severities rather than one", async () => {
    await withDemo(async ({ app, cookie }) => {
      const severities = new Set((await listCases(app, cookie)).map((row) => row.severity));
      expect(severities.size).toBeGreaterThan(1);
    });
  });
});

describe("an investigation carrying only human notes", () => {
  it("exists, holds notes, and registers no evidence file", async () => {
    await withDemo(async ({ app, cookie }) => {
      const humanOnly = (await listCases(app, cookie)).find((row) =>
        row.title.includes("historical notes only"),
      );
      expect(humanOnly).toBeTruthy();

      const contributions = parseContributionList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${humanOnly?.id}/contributions`,
              headers: { cookie },
            })
          ).body,
        ),
      ).contributions;
      expect(contributions.length).toBeGreaterThanOrEqual(3);
      expect(contributions.every((row) => row.kind === "note")).toBe(true);

      const evidence = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${humanOnly?.id}/evidence`,
            headers: { cookie },
          })
        ).body,
      ) as { artifacts: unknown[] };
      // The point of this scenario: a legitimate investigation with no file.
      expect(evidence.artifacts).toHaveLength(0);
    });
  });

  it("keeps a day-precision historical occurrence without inventing a time zone", async () => {
    await withDemo(async ({ app, cookie }) => {
      const humanOnly = (await listCases(app, cookie)).find((row) =>
        row.title.includes("historical notes only"),
      );
      expect(humanOnly?.occurredAt).toBe("2024-11-04");
      expect(humanOnly?.occurredAtPrecision).toBe("day");
      expect(humanOnly?.occurredAtZone).toBe("unspecified");
      // The recording clock is today's; the occurrence is years earlier. The
      // two never collapse into one.
      expect(Date.parse(humanOnly?.createdAt ?? "")).toBeGreaterThan(
        Date.parse("2024-11-04T00:00:00Z"),
      );
    });
  });
});

describe("an investigation whose evidence is correspondence", () => {
  it("registers email and chat beside a log", async () => {
    await withDemo(async ({ app, cookie }) => {
      const correspondence = (await listCases(app, cookie)).find((row) =>
        row.title.includes("Overnight statements"),
      );
      expect(correspondence).toBeTruthy();

      const evidence = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${correspondence?.id}/evidence`,
            headers: { cookie },
          })
        ).body,
      ) as { artifacts: { kind: string; filename: string | null }[] };
      const kinds = evidence.artifacts.map((row) => row.kind);
      expect(kinds).toContain("email");
      expect(kinds).toContain("attachment");
      expect(kinds).toContain("log");
    });
  });

  it("records an explicit-zone occurrence, unlike the historical case", async () => {
    await withDemo(async ({ app, cookie }) => {
      const correspondence = (await listCases(app, cookie)).find((row) =>
        row.title.includes("Overnight statements"),
      );
      expect(correspondence?.occurredAtPrecision).toBe("second");
      expect(correspondence?.occurredAtZone).toBe("explicit");
    });
  });
});

describe("an archived investigation is present for the lifecycle controls", () => {
  it("is archived, so the working list has something to withhold", async () => {
    await withDemo(async ({ app, cookie }) => {
      const archived = (await listCases(app, cookie)).filter((row) => row.status === "archived");
      expect(archived.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("restores to the status it was archived out of, not to open", async () => {
    await withDemo(async ({ app, cookie }) => {
      const archived = (await listCases(app, cookie)).find((row) => row.status === "archived");
      const lifecycle = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${archived?.id}/lifecycle`,
            headers: { cookie },
          })
        ).body,
      ) as { restoreTarget: string; restore: { allowed: boolean }; archive: { allowed: boolean } };
      expect(lifecycle.restoreTarget).toBe("monitoring");
      expect(lifecycle.restore.allowed).toBe(true);
      expect(lifecycle.archive.allowed).toBe(false);
    });
  });
});

describe("the demo stays synthetic", () => {
  it("addresses no domain outside the reserved test namespace", async () => {
    await withDemo(async ({ app, cookie }) => {
      const cases = await listCases(app, cookie);
      const prose = cases
        .flatMap((row) => [row.title, row.problemStatement, row.affectedParties, row.impact, row.scope])
        .join("\n");
      // `.test` is reserved by RFC 2606 and can never be a real destination.
      for (const address of prose.match(/[\w.+-]+@[\w.-]+/g) ?? []) {
        expect(address.endsWith(".test")).toBe(true);
      }
    });
  });
});

describe("the read-only static fallback covers every investigation it lists", () => {
  it("captures the case view routes for each seeded investigation, not only the primary one", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    try {
      const routes = await captureStaticDemoRoutes(demo.app, demo.caseId);
      const listed = routes["GET /api/cases"] as { cases: { id: string; title: string }[] };
      expect(listed.cases.length).toBeGreaterThanOrEqual(4);
      expect(routes["GET /api/entities"]).toBeDefined();
      expect(routes["GET /api/involvement/index"]).toBeDefined();
      expect(routes["GET /api/profile/me"]).toBeDefined();
      // A case listed in the inventory that 404s when opened is a broken link
      // inside an artefact nobody can fix from the page.
      for (const row of listed.cases) {
        for (const suffix of [
          "",
          "/timeline",
          "/contributions",
          "/evidence",
          "/lifecycle",
          "/workstreams",
          "/workbench",
          "/workbench/views",
          "/workbench/bookmarks",
          "/workbench/review-queue",
        ]) {
          expect(routes[`GET /api/cases/${row.id}${suffix}`]).toBeDefined();
        }
        const evidence = routes[`GET /api/cases/${row.id}/evidence`] as {
          artifacts?: { id: string }[];
        };
        for (const artifact of evidence.artifacts ?? []) {
          expect(routes[`GET /api/cases/${row.id}/evidence/${artifact.id}`]).toBeDefined();
          expect(routes[`GET /api/cases/${row.id}/evidence/${artifact.id}/bytes`]).toBeDefined();
        }
        const workbench = routes[`GET /api/cases/${row.id}/workbench`] as {
          items?: { evidenceId: string }[];
        };
        for (const item of workbench.items ?? []) {
          expect(
            routes[`GET /api/cases/${row.id}/workbench/page?evidenceId=${encodeURIComponent(item.evidenceId)}&startLine=1&limit=80`],
          ).toBeDefined();
        }
      }
    } finally {
      await demo.app.close();
    }
  });
});
