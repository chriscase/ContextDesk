/**
 * Test-only fixture process for browser qualification.
 *
 * Uses the existing `MapAuthAdapter` (same seam as collab HTTP tests). This is
 * not a production local-auth endpoint and does not add routes.
 */
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../server/src/app.js";
import { testConfig } from "../../server/src/config.js";
import { FilesystemEvidenceStore } from "../../server/src/evidence/store.js";
import { MemoryAuditStore } from "../../server/src/modules/audit/index.js";
import {
  MapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
} from "../../server/src/modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../../server/src/modules/authz/index.js";
import { CatalogService } from "../../server/src/modules/catalog/index.js";
import { CaseService } from "../../server/src/modules/cases/index.js";
import { ExportService, testExportPrivacyConfig } from "../../server/src/modules/export/index.js";
import { ImportService, MemoryRunStore } from "../../server/src/modules/import/index.js";
import { adapterUsers, FIXTURE_ROLE_MAP, SEEDED_SOURCES } from "./users.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDistEnv = process.env.COLLAB_E2E_STATIC_DIR?.trim();
const webDist = webDistEnv ? webDistEnv : join(here, "..", "..", "web", "dist");

function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? "8788", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COLLAB_E2E_PORT must be 1..65535, got ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(
      `missing collab web build at ${webDist}; run: npm run build -w @cd-collab/web`,
    );
  }
  const root = await mkdtemp(join(tmpdir(), "cd-collab-e2e-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  await store.ping();
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases: domain,
    catalog,
    runs: new MemoryRunStore(),
  });
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: testExportPrivacyConfig(),
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(FIXTURE_ROLE_MAP));
  const actor = { id: "fixture-seed", username: "fixture" };
  await catalog.create(
    actor,
    {
      name: SEEDED_SOURCES.chatA,
      kind: "external-tool",
      description: "Deterministic e2e source A",
    },
    "fixture",
  );
  await catalog.create(
    actor,
    {
      name: SEEDED_SOURCES.chatB,
      kind: "external-tool",
      description: "Deterministic e2e source B",
    },
    "fixture",
  );

  const port = parsePort(process.env.COLLAB_E2E_PORT);
  const app = await buildApp({
    config: testConfig({
      evidenceRoot: root,
      staticDir: webDist,
      host: "127.0.0.1",
      port,
    }),
    pool: null,
    store,
    domain,
    catalog,
    imports,
    exporter,
    security: {
      auth: {
        adapter: new MapAuthAdapter(adapterUsers()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 40, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit,
    },
  });

  const close = async (): Promise<void> => {
    await app.close();
  };
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });

  const address = await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(
    `cd-collab fixture server listening ${address} (MapAuthAdapter test-only; LDAP unused; /ready expects Postgres)\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
