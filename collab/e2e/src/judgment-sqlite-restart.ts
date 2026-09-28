/** Disposable built-server/SQLite judgment restart qualification; no external providers. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builtServer = resolve(here, "../../server/dist/index.js");

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Json;
}

function rows(value: unknown): Json[] {
  assert(Array.isArray(value));
  return value.map(object);
}

function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return address.port;
}

async function startServer(root: string, port: number, password: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [builtServer], {
    cwd: root,
    env: {
      ...process.env,
      COLLAB_STORAGE: "sqlite",
      COLLAB_SQLITE_PATH: join(root, "collab.sqlite"),
      COLLAB_EVIDENCE_ROOT: join(root, "evidence"),
      COLLAB_AUTH_MODE: "local",
      COLLAB_LOCAL_USERS: JSON.stringify([{
        username: "lead", password, groups: ["local:lead"], displayName: "Fixture lead",
      }]),
      COLLAB_GROUP_ROLE_MAP: "local:lead=admin",
      COLLAB_COOKIE_SECURE: "0",
      COLLAB_HOST: "127.0.0.1",
      COLLAB_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`built server exited during startup: ${diagnostic}`);
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/health`);
      if (ready.ok) return child;
    } catch { /* Wait for the process to bind the socket. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`built server did not become healthy: ${diagnostic}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExited) => child.once("exit", () => resolveExited()));
  child.kill("SIGTERM");
  await exited;
}

async function request(
  port: number,
  method: string,
  path: string,
  cookie?: string,
  payload?: Json,
): Promise<{ status: number; body: Json; cookie: string | null }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(method !== "GET" ? { "x-cd-collab-csrf": "1" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = object(await response.json());
  return {
    status: response.status,
    body,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? null,
  };
}

async function required(
  port: number, method: string, path: string, expected: number, cookie?: string, payload?: Json,
): Promise<Json> {
  const response = await request(port, method, path, cookie, payload);
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function login(port: number, password: string): Promise<string> {
  const response = await request(port, "POST", "/api/auth/login", undefined, {
    username: "lead", password,
  });
  assert.equal(response.status, 200);
  assert(response.cookie);
  return response.cookie;
}

async function counts(port: number, cookie: string, caseId: string, runId: string) {
  const list = await required(port, "GET", `/api/cases/${caseId}/runs/${runId}/judgments`, 200, cookie);
  const timeline = await required(port, "GET", `/api/cases/${caseId}/timeline`, 200, cookie);
  const audit = await required(port, "GET", "/api/admin/audit", 200, cookie);
  return {
    judgments: rows(list.judgments),
    eventCount: rows(timeline.events).filter((row) => row.kind === "external_run_judgment_recorded"
      && row.targetId === runId).length,
    auditCount: rows(audit.events).filter((row) => row.action === "external_run_judgment_recorded"
      && row.target === `${runId}:1` && row.outcome === "success").length,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-goal07-sqlite-"));
  const port = await freePort();
  const password = randomUUID();
  let child: ChildProcess | null = null;
  try {
    child = await startServer(root, port, password);
    const firstCookie = await login(port, password);
    const source = object((await required(port, "POST", "/api/catalog/sources", 201, firstCookie, {
      schemaId: "cd-collab.source_create_request.v1",
      name: "Synthetic manual response source", kind: "external-tool", description: null,
      identityId: null, expectedRevision: 0, idempotencyKey: `source-${randomUUID()}`,
    })).applied);
    const caseId = string((await required(port, "POST", "/api/cases", 200, firstCookie, {
      title: "Synthetic assessment restart",
    })).id);
    const imported = await required(port, "POST", `/api/cases/${caseId}/imports`, 201, firstCookie, {
      schemaId: "cd-collab.external_run_import_request.v1",
      importMode: "manual", caseId, sourceId: string(source.id),
      expectedSourceRevision: source.revision,
      outputText: "Synthetic external response for human review.",
      promptText: "Summarize the synthetic incident.",
      promptCompleteness: "exact", outputCompleteness: "exact",
      workflowCompleteness: "partial", evidenceVisibility: "unknown",
      evidenceArtifactIds: [], snapshotBinding: null, visibilityNote: null,
      operator: null, provider: "synthetic", model: "fixture", version: "1",
      claimedTraces: [], uncertainty: null, timing: null, cost: null,
      redacted: false, privacyClass: "owner_only", idempotencyKey: `import-${randomUUID()}`,
    });
    const runId = string(object(imported.applied).id);
    const judgment = {
      schemaId: "cd-collab.external_run_judgment_request.v1",
      caseId, runId, expectedSequence: 0,
      idempotencyKey: `assessment-${randomUUID()}`,
      judgment: "insufficient_evidence", links: [],
      rationale: "Synthetic output needs independent evidence.",
    };

    // The local caller loses the acknowledgment only after the real built server
    // completed its transaction and returned 201 to this disposable fault seam.
    const committed = await request(port, "POST", `/api/cases/${caseId}/runs/${runId}/judgments`,
      firstCookie, judgment);
    assert.equal(committed.status, 201, JSON.stringify(committed.body));
    assert.equal(committed.body.replayed, false);
    const callerObserved = { status: 503, error: "commit_outcome_unknown" };
    assert.equal(callerObserved.status, 503);
    const afterUnknown = await counts(port, firstCookie, caseId, runId);
    assert.equal(afterUnknown.judgments.length, 1);
    assert.equal(afterUnknown.eventCount, 1);
    assert.equal(afterUnknown.auditCount, 1);

    await stopServer(child);
    child = null;
    child = await startServer(root, port, password);
    const secondCookie = await login(port, password);
    assert.notEqual(secondCookie, firstCookie);
    const recovered = await counts(port, secondCookie, caseId, runId);
    assert.deepEqual(recovered, afterUnknown);
    const replay = await request(port, "POST", `/api/cases/${caseId}/runs/${runId}/judgments`,
      secondCookie, judgment);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.applied, committed.body.applied);
    assert.deepEqual(await counts(port, secondCookie, caseId, runId), recovered);
    process.stdout.write(JSON.stringify({
      result: "passed", backend: "built-server/sqlite", reauthenticatedAfterRestart: true,
      withheldAcknowledgmentAfterCommittedStatus: committed.status,
      replayStatus: replay.status, ...{
        judgments: recovered.judgments.length,
        timelineEvents: recovered.eventCount,
        successfulAudits: recovered.auditCount,
      },
    }) + "\n");
  } finally {
    if (child) await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
