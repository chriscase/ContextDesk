import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHealthResponse, parseReadyResponse } from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testConfig } from "./config.js";
import { latestMigrationVersion } from "./db/migrate.js";
import { FilesystemEvidenceStore } from "./evidence/store.js";

describe("health and readiness", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("responds on /health without a database", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-health-"));
    dirs.push(root);
    const store = new FilesystemEvidenceStore({ rootDir: root });
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root }),
      pool: null,
      store,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = parseHealthResponse(JSON.parse(res.body));
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cd-collab");
    await app.close();
  });

  it("reports not_ready when the database is down", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ready-"));
    dirs.push(root);
    const store = new FilesystemEvidenceStore({ rootDir: root });
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root }),
      pool: {
        query: async () => {
          throw new Error("db down");
        },
      },
      store,
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = parseReadyResponse(JSON.parse(res.body));
    expect(body.status).toBe("not_ready");
    expect(body.database).toBe("down");
    expect(body.evidenceStore).toBe("up");
    await app.close();
  });

  it("reports ready when database and store are up", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ready-ok-"));
    dirs.push(root);
    const store = new FilesystemEvidenceStore({ rootDir: root });
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root }),
      pool: {
        query: async (text: string, values?: unknown[]) => {
          queries.push({ text, values });
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        },
      },
      store,
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = parseReadyResponse(JSON.parse(res.body));
    expect(body.status).toBe("ready");
    expect(body.database).toBe("up");
    expect(body.evidenceStore).toBe("up");
    expect(queries).toEqual([
      {
        text: "SELECT 1 FROM schema_migrations WHERE version = $1",
        values: [latestMigrationVersion()],
      },
    ]);
    await app.close();
  });

  it("reports not_ready when the latest migration is not applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ready-migration-"));
    dirs.push(root);
    const store = new FilesystemEvidenceStore({ rootDir: root });
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root }),
      pool: {
        query: async () => ({ rows: [], rowCount: 0 }),
      },
      store,
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = parseReadyResponse(JSON.parse(res.body));
    expect(body.status).toBe("not_ready");
    expect(body.database).toBe("down");
    expect(body.evidenceStore).toBe("up");
    await app.close();
  });
});
