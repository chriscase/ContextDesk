import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOverview } from "@cd-collab/contracts";
import type { FastifyInstance } from "fastify";
import { buildDemoApp, DEMO_PASSWORD, DEMO_USERNAME } from "./demo.js";
import { projectOverviewForStaticSnapshot } from "./modules/overview/index.js";

const here = dirname(fileURLToPath(import.meta.url));

const SEEDED_DISCUSSION_MESSAGES = [
  "Inventory timeout is the leading cause to investigate.",
  "Checkout and inventory pool pressure should be investigated together.",
] as const;

function cookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function json(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  session: string,
  payload?: object,
): Promise<unknown> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie: session },
    ...(payload === undefined ? {} : { payload }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`static demo snapshot failed: ${method} ${url} returned ${response.statusCode}`);
  }
  return JSON.parse(response.body) as unknown;
}

function terminalJob(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

async function waitForTriageJobs(
  app: FastifyInstance,
  caseId: string,
  session: string,
): Promise<{ jobs?: { id?: string; status?: string }[] }> {
  let last: { jobs?: { id?: string; status?: string }[] } = { jobs: [] };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = (await json(app, "GET", `/api/cases/${caseId}/triage-runs`, session)) as {
      jobs?: { id?: string; status?: string }[];
    };
    const jobs = last.jobs ?? [];
    if (jobs.length > 0 && jobs.every((job) => terminalJob(job.status))) {
      return last;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return last;
}

async function seedDiscussionMessages(
  app: FastifyInstance,
  caseId: string,
  session: string,
): Promise<void> {
  const existing = (await json(app, "GET", `/api/cases/${caseId}/contributions`, session)) as {
    contributions?: { kind?: string }[];
  };
  if ((existing.contributions ?? []).some((row) => row.kind === "message")) {
    return;
  }
  for (const body of SEEDED_DISCUSSION_MESSAGES) {
    await json(app, "POST", `/api/cases/${caseId}/contributions`, session, {
      kind: "message",
      body,
      privacyClass: "share_safe",
    });
  }
}

async function snapshots(app: FastifyInstance, caseId: string): Promise<Record<string, unknown>> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
  });
  if (login.statusCode !== 200) throw new Error("static demo login failed");
  const session = cookie(login.headers);
  await waitForTriageJobs(app, caseId, session);
  await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/presence`,
    headers: { cookie: session },
    payload: { surface: "experiment_lab" },
  });
  await seedDiscussionMessages(app, caseId, session);

  const experiments = (await json(
    app,
    "GET",
    `/api/cases/${caseId}/experiments`,
    session,
  )) as { experiments?: { id: string }[] };
  const snapshotList = (await json(app, "GET", `/api/cases/${caseId}/snapshots`, session)) as {
    snapshots?: { id?: string }[];
  };
  const routes: Record<string, unknown> = {
    "GET /api/auth/me": await json(app, "GET", "/api/auth/me", session),
    "POST /api/auth/login": { status: "synthetic_demo" },
    "POST /api/auth/logout": { status: "synthetic_demo" },
    "GET /api/cases": await json(app, "GET", "/api/cases", session),
    "GET /api/entities": await json(app, "GET", "/api/entities", session),
    "GET /api/involvement/index": await json(app, "GET", "/api/involvement/index", session),
    "GET /api/profile/me": await json(app, "GET", "/api/profile/me", session),
    "GET /api/investigation-activity?limit=30": await json(
      app,
      "GET",
      "/api/investigation-activity?limit=30",
      session,
    ),
    [`GET /api/cases/${caseId}`]: await json(app, "GET", `/api/cases/${caseId}`, session),
    "GET /api/catalog/sources": await json(app, "GET", "/api/catalog/sources", session),
    "GET /api/triage-profiles": await json(app, "GET", "/api/triage-profiles", session),
    "GET /api/triage-capabilities": await json(app, "GET", "/api/triage-capabilities", session),
    [`GET /api/cases/${caseId}/timeline`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/timeline`,
      session,
    ),
    [`GET /api/cases/${caseId}/contributions`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/contributions`,
      session,
    ),
    [`GET /api/cases/${caseId}/imports`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/imports`,
      session,
    ),
    [`GET /api/cases/${caseId}/evidence`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/evidence`,
      session,
    ),
    [`GET /api/cases/${caseId}/snapshots`]: snapshotList,
    [`GET /api/cases/${caseId}/board`]: await json(app, "GET", `/api/cases/${caseId}/board`, session),
    [`GET /api/cases/${caseId}/triage-runs`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/triage-runs`,
      session,
    ),
    [`GET /api/cases/${caseId}/experiments`]: experiments,
    [`GET /api/cases/${caseId}/presence`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/presence`,
      session,
    ),
    [`GET /api/cases/${caseId}/export/inventory`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/export/inventory`,
      session,
    ),
    [`GET /api/cases/${caseId}/lifecycle`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/lifecycle`,
      session,
    ),
  };
  // The demo seeds several investigations, and `GET /api/cases` lists all of
  // them. A static fallback that captured detail routes for only the primary
  // case would render the others in the inventory and then 404 the moment
  // anyone clicked one — a broken link in a read-only artefact nobody can fix
  // from the page. So every listed investigation gets the read routes the case
  // view opens with. The elaborate per-experiment and per-snapshot captures
  // above stay scoped to the primary case, which is the only one that has them.
  const listed = (routes["GET /api/cases"] ?? {}) as { cases?: { id?: string }[] };
  for (const row of listed.cases ?? []) {
    if (!row.id) continue;
    for (const suffix of [
      "",
      "/timeline",
      "/contributions",
      "/imports",
      "/evidence",
      "/snapshots",
      "/board",
      "/triage-runs",
      "/experiments",
      "/presence",
      "/lifecycle",
      "/export/inventory",
      "/workstreams",
      "/workbench",
      "/workbench/views",
      "/workbench/bookmarks",
      "/workbench/review-queue",
    ]) {
      const url = `/api/cases/${row.id}${suffix}`;
      routes[`GET ${url}`] = await json(app, "GET", url, session);
    }
    const evidence = routes[`GET /api/cases/${row.id}/evidence`] as {
      artifacts?: { id?: string }[];
    };
    for (const artifact of evidence.artifacts ?? []) {
      if (!artifact.id) continue;
      for (const suffix of ["", "/bytes"]) {
        const url = `/api/cases/${row.id}/evidence/${artifact.id}${suffix}`;
        routes[`GET ${url}`] = await json(app, "GET", url, session);
      }
    }
    const workbench = routes[`GET /api/cases/${row.id}/workbench`] as {
      items?: { evidenceId?: string }[];
    };
    for (const item of workbench.items ?? []) {
      if (!item.evidenceId) continue;
      const url = `/api/cases/${row.id}/workbench/page?evidenceId=${encodeURIComponent(item.evidenceId)}&startLine=1&limit=80`;
      routes[`GET ${url}`] = await json(app, "GET", url, session);
    }
  }

  const liveOverview = parseOverview(await json(app, "GET", "/api/overview", session));
  routes["GET /api/overview"] = projectOverviewForStaticSnapshot(liveOverview);
  for (const snapshot of snapshotList.snapshots ?? []) {
    if (!snapshot.id) continue;
    const boardUrl = `/api/cases/${caseId}/board?snapshotId=${encodeURIComponent(snapshot.id)}`;
    routes[`GET ${boardUrl}`] = await json(app, "GET", boardUrl, session);
  }
  for (const experiment of experiments.experiments ?? []) {
    routes[`POST /api/cases/${caseId}/experiments/${experiment.id}/export`] = await json(
      app,
      "POST",
      `/api/cases/${caseId}/experiments/${experiment.id}/export`,
      session,
    );
  }
  return routes;
}

export async function captureStaticDemoRoutes(
  app: FastifyInstance,
  caseId: string,
): Promise<Record<string, unknown>> {
  return snapshots(app, caseId);
}

function escapeScript(value: string): string {
  return value.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
}

async function inlineHelpIllustrations(javascript: string): Promise<string> {
  const illustrationDir = join(here, "..", "..", "web", "public", "help", "war-room");
  const illustrations = (await readdir(illustrationDir))
    .filter((name) => name.endsWith(".png"))
    .sort();
  let inlined = javascript;
  for (const name of illustrations) {
    const bytes = await readFile(join(illustrationDir, name));
    inlined = inlined.replaceAll(`/help/war-room/${name}`, `data:image/png;base64,${bytes.toString("base64")}`);
  }
  if (inlined.includes("/help/war-room/")) {
    throw new Error("static demo contains an un-inlined War Room help illustration");
  }
  return inlined;
}

export async function writeStaticDemo(outputPath: string): Promise<string> {
  const webDist = join(here, "..", "..", "web", "dist-demo");
  const assets = join(webDist, "assets");
  const names = await readdir(assets);
  const jsName = names.find((name) => name.endsWith(".js"));
  const cssName = names.find((name) => name.endsWith(".css"));
  if (!jsName || !cssName) {
    throw new Error("synthetic web bundle is missing; run the demo web build first");
  }
  const [javascriptSource, css] = await Promise.all([
    readFile(join(assets, jsName), "utf8"),
    readFile(join(assets, cssName), "utf8"),
  ]);
  const javascript = await inlineHelpIllustrations(javascriptSource);
  const demo = await buildDemoApp({ staticDir: null });
  try {
    const routes = await snapshots(demo.app, demo.caseId);
    const routeJson = JSON.stringify(routes).replaceAll("<", "\\u003c");
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ContextDesk War Room — synthetic read-only fallback</title>
    <style>${css}</style>
    <script>
      window.__CONTEXTDESK_STATIC_READ_ONLY__ = true;
      try {
        var path = location.pathname;
        if (
          path !== "/" &&
          path.indexOf("/investigations") !== 0 &&
          path !== "/entities" &&
          path !== "/sources" &&
          path !== "/help" &&
          path !== "/profile" &&
          path !== "/signin" &&
          path !== "/sign-in" &&
          path !== "/login"
        ) {
          history.replaceState(null, "", "/");
        }
      } catch (e) {}
      const contextDeskDemoRoutes = ${routeJson};
      window.fetch = async (input, init = {}) => {
        const raw = typeof input === "string" ? input : input.url;
        const parsed = raw.startsWith("http") ? new URL(raw) : new URL(raw, "http://static.local");
        const path = parsed.pathname;
        const search = parsed.search;
        const method = String(init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase();
        const body = contextDeskDemoRoutes[method + " " + path + search] || contextDeskDemoRoutes[method + " " + path];
        if (body !== undefined) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
          return new Response(JSON.stringify({ error: "Static fallback is read-only; use the local demo server for edits." }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      };
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${escapeScript(javascript)}</script>
  </body>
</html>`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, "utf8");
    return outputPath;
  } finally {
    await demo.app.close();
  }
}

async function main(): Promise<void> {
  const output = resolve(
    process.argv[2] ?? join(here, "..", "..", ".demo", "contextdesk-synthetic-demo.html"),
  );
  await writeStaticDemo(output);
  process.stdout.write(
    `ContextDesk static synthetic fallback is ready:\n${output}\nIt is read-only, self-contained, and contains synthetic data only.\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
