import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildDemoApp, DEMO_PASSWORD, DEMO_USERNAME } from "./demo.js";

const here = dirname(fileURLToPath(import.meta.url));

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
): Promise<unknown> {
  const response = await app.inject({ method, url, headers: { cookie: session } });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`static demo snapshot failed: ${method} ${url} returned ${response.statusCode}`);
  }
  return JSON.parse(response.body) as unknown;
}

async function snapshots(app: FastifyInstance, caseId: string): Promise<Record<string, unknown>> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
  });
  if (login.statusCode !== 200) throw new Error("static demo login failed");
  const session = cookie(login.headers);
  const experiments = (await json(
    app,
    "GET",
    `/api/cases/${caseId}/experiments`,
    session,
  )) as { experiments?: { id: string }[] };
  const routes: Record<string, unknown> = {
    "GET /api/auth/me": {
      identity: { username: "demo", displayName: "Demo case lead" },
      roles: ["case-lead"],
    },
    "POST /api/auth/login": { status: "synthetic_demo" },
    "POST /api/auth/logout": { status: "synthetic_demo" },
    "GET /api/cases": await json(app, "GET", "/api/cases", session),
    "GET /api/catalog/sources": await json(app, "GET", "/api/catalog/sources", session),
    [`GET /api/cases/${caseId}/timeline`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/timeline`,
      session,
    ),
    [`GET /api/cases/${caseId}/imports`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/imports`,
      session,
    ),
    [`GET /api/cases/${caseId}/experiments`]: experiments,
    [`GET /api/cases/${caseId}/export/inventory`]: await json(
      app,
      "GET",
      `/api/cases/${caseId}/export/inventory`,
      session,
    ),
  };
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

function escapeScript(value: string): string {
  return value.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
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
  const [javascript, css] = await Promise.all([
    readFile(join(assets, jsName), "utf8"),
    readFile(join(assets, cssName), "utf8"),
  ]);
  const demo = await buildDemoApp({ staticDir: null });
  try {
    const routes = await snapshots(demo.app, demo.caseId);
    const routeJson = JSON.stringify(routes).replaceAll("<", "\\u003c");
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ContextDesk Experiment Lab — synthetic fallback</title>
    <style>${css}</style>
    <script>
      window.__CONTEXTDESK_STATIC_READ_ONLY__ = true;
      const contextDeskDemoRoutes = ${routeJson};
      window.fetch = async (input, init = {}) => {
        const raw = typeof input === "string" ? input : input.url;
        const path = raw.startsWith("http") ? new URL(raw).pathname : raw.split("?")[0];
        const method = String(init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase();
        const body = contextDeskDemoRoutes[method + " " + path];
        if (body !== undefined) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "POST") {
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
