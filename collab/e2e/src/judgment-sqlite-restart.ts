/** Disposable built-server/SQLite judgment restart qualification; no external providers. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExternalRunJudgmentListV1,
  ExternalRunJudgmentRequestV1,
  ExternalRunJudgmentSuccessV1,
} from "@cd-collab/contracts/external-run-judgment";

const here = dirname(fileURLToPath(import.meta.url));
const builtServer = resolve(here, "../../server/dist/index.js");

type Json = Record<string, unknown>;
type GatewayResult<T> = { ok: true; value: T } | { ok: false; error: { kind: string } };
type JudgmentGateway = {
  createExternalRunJudgment: (
    caseId: string, runId: string, input: ExternalRunJudgmentRequestV1,
    options: { signal: AbortSignal },
  ) => Promise<GatewayResult<ExternalRunJudgmentSuccessV1>>;
  listExternalRunJudgments: (
    caseId: string, runId: string, options: { signal: AbortSignal },
  ) => Promise<GatewayResult<ExternalRunJudgmentListV1>>;
};

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

/** Route the production browser gateway to this disposable server, with one optional post-commit loss. */
async function throughGateway<T>(
  port: number,
  cookie: string,
  call: () => Promise<T>,
  loseFirstPostAcknowledgment = false,
): Promise<{ outcome: T; posts: number; postStatus: number | null; committedBody: Json | null }> {
  const nativeFetch = globalThis.fetch;
  let posts = 0;
  let postStatus: number | null = null;
  let committedBody: Json | null = null;
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, `http://127.0.0.1:${port}`);
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    const response = await nativeFetch(url, { ...init, headers });
    if (init?.method?.toUpperCase() === "POST" && url.pathname.endsWith("/judgments")) {
      posts += 1;
      postStatus = response.status;
      if (loseFirstPostAcknowledgment) {
        assert.equal(response.status, 201);
        committedBody = object(await response.clone().json());
        throw new TypeError("synthetic acknowledgment lost after committed response");
      }
    }
    return response;
  };
  try {
    return { outcome: await call(), posts, postStatus, committedBody };
  } finally {
    globalThis.fetch = nativeFetch;
  }
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
  // Load the production web gateway at runtime across the E2E package's
  // separate TypeScript rootDir.
  const gateway = (await import(new URL(
    "../../web/src/investigations/runtime/gateway.ts", import.meta.url,
  ).href) as { investigationGateway: JudgmentGateway }).investigationGateway;
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
    const judgment: ExternalRunJudgmentRequestV1 = {
      schemaId: "cd-collab.external_run_judgment_request.v1",
      caseId, runId, expectedSequence: 0,
      idempotencyKey: `assessment-${randomUUID()}`,
      judgment: "insufficient_evidence", links: [],
      rationale: "Synthetic output needs independent evidence.",
    };

    // A real server commit returns 201 to the disposable fetch seam. The seam
    // drops only that acknowledgment; the production gateway caller receives
    // a network/unconfirmed result, never the successful response bytes.
    const first = await throughGateway(port, firstCookie, () =>
      gateway.createExternalRunJudgment(caseId, runId, judgment, {
        signal: new AbortController().signal,
      }), true);
    assert.equal(first.posts, 1);
    assert.equal(first.postStatus, 201);
    assert.deepEqual(first.outcome, { ok: false, error: { kind: "network" } });
    const committed = object(first.committedBody);
    assert.equal(committed.replayed, false);
    const initialIntent = { ...judgment };
    const freshRead = await throughGateway(port, firstCookie, () =>
      gateway.listExternalRunJudgments(caseId, runId, {
        signal: new AbortController().signal,
      }));
    assert.equal(freshRead.posts, 0);
    assert(freshRead.outcome.ok);
    assert.equal(freshRead.outcome.value.judgments.length, 1);
    assert.deepEqual(judgment, initialIntent);
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
    const recoveredRead = await throughGateway(port, secondCookie, () =>
      gateway.listExternalRunJudgments(caseId, runId, {
        signal: new AbortController().signal,
      }));
    assert(recoveredRead.outcome.ok);
    assert.equal(recoveredRead.outcome.value.judgments.length, 1);
    const replay = await throughGateway(port, secondCookie, () =>
      gateway.createExternalRunJudgment(caseId, runId, {
        ...judgment,
        expectedSequence: recoveredRead.outcome.ok
          ? recoveredRead.outcome.value.judgments.length : 0,
      }, { signal: new AbortController().signal }));
    assert.equal(replay.posts, 1);
    assert.equal(replay.postStatus, 200);
    assert(replay.outcome.ok);
    assert.equal(replay.outcome.value.replayed, true);
    assert.deepEqual(replay.outcome.value.applied, committed.applied);
    assert.deepEqual(judgment, initialIntent);
    assert.deepEqual(await counts(port, secondCookie, caseId, runId), recovered);
    process.stdout.write(JSON.stringify({
      result: "passed", backend: "built-server/sqlite", reauthenticatedAfterRestart: true,
      withheldAcknowledgmentAfterCommittedStatus: first.postStatus,
      productionCallerOutcome: "network/unconfirmed",
      postFailureAuthoritativeRead: true,
      automaticRetryPosts: first.posts - 1,
      replayStatus: replay.postStatus, ...{
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
