/**
 * Disposable production-server proof for collection discovery.
 *
 * Boots the built `dist/index.js` entry against a new sqlite file. The
 * database, evidence directory, and process live only for this run.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const proofDir = process.env.PROOF_DIR;
if (!proofDir) throw new Error("PROOF_DIR is required");
const port = Number(process.env.PORT ?? 8791);
const root = await mkdtemp(join(proofDir, "production-server-"));
const sqlitePath = join(root, "discovery.sqlite");
const evidenceRoot = join(root, "evidence");
await mkdir(evidenceRoot, { recursive: true });

const admin = {
  username: "synth-admin",
  password: "fixture-synth-admin-secret",
  displayName: "Synthetic admin",
  groups: ["cn=admins,ou=groups,dc=example,dc=test"],
};
const denied = {
  username: "synth-reader",
  password: "fixture-synth-reader-secret",
  displayName: "Synthetic reader",
  groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
};

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    COLLAB_STORAGE: "sqlite",
    COLLAB_SQLITE_PATH: sqlitePath,
    COLLAB_AUTH_MODE: "local",
    COLLAB_LOCAL_USERS: JSON.stringify([admin, denied]),
    COLLAB_GROUP_ROLE_MAP: "cn=admins,ou=groups,dc=example,dc=test=admin;cn=viewers,ou=groups,dc=example,dc=test=viewer",
    COLLAB_EVIDENCE_ROOT: evidenceRoot,
    COLLAB_HOST: "127.0.0.1",
    COLLAB_PORT: String(port),
    COLLAB_STATIC_DIR: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

const base = `http://127.0.0.1:${port}`;
async function stop() {
  if (!child.killed) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => child.kill("SIGKILL")),
  ]);
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) { healthy = true; break; }
    } catch { /* server still binding */ }
    await delay(200);
  }
  if (!healthy) {
    throw new Error(`production server did not become healthy\n${logs}`);
  }

  async function login(user) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user.username, password: user.password }),
    });
    if (!response.ok) throw new Error(`login ${user.username} failed ${response.status} ${await response.text()}`);
    const cookie = response.headers.getSetCookie?.()
      ?? [response.headers.get("set-cookie") ?? ""];
    const session = cookie.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("cd_collab_session="));
    if (!session) throw new Error(`login ${user.username} did not set a session cookie`);
    return session;
  }

  const adminCookie = await login(admin);
  const deniedCookie = await login(denied);
  const headers = {
    cookie: adminCookie,
    "content-type": "application/json",
    "x-cd-collab-csrf": "1",
  };

  async function createCase(title) {
    const response = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title,
        problemStatement: "Synthetic disposable production record.",
        affectedParties: "Synthetic operators",
        impact: "Qualification only",
      }),
    });
    if (!response.ok) throw new Error(`create failed ${response.status} ${await response.text()}`);
    return await response.json();
  }

  const impact = {
    productName: "Disposable Desk",
    version: "1.0",
    build: "",
    component: "worker",
    environment: "",
  };
  const matched = await createCase("Disposable matched investigation");
  const other = await createCase("Disposable other investigation");
  const impactResponse = await fetch(`${base}/api/cases/${matched.id}/software-impact`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...impact, status: "observed", note: "Synthetic impact" }),
  });
  if (!impactResponse.ok) throw new Error(`impact failed ${impactResponse.status} ${await impactResponse.text()}`);
  const participant = await fetch(`${base}/api/cases/${matched.id}/participants`, {
    method: "POST",
    headers,
    body: JSON.stringify({ identityId: "local:synth-admin", username: "synth-admin" }),
  });
  if (!participant.ok && participant.status !== 409) {
    throw new Error(`participant failed ${participant.status} ${await participant.text()}`);
  }
  const loaded = await fetch(`${base}/api/cases/${matched.id}`, { headers: { cookie: adminCookie } });
  if (!loaded.ok) throw new Error(`read case failed ${loaded.status} ${await loaded.text()}`);
  const record = await loaded.json();
  const contributorId = record.participants?.find((participant) => participant.identityId === "local:synth-admin")?.identityId
    ?? record.participants?.[0]?.identityId;
  if (!contributorId) throw new Error(`matched case has no participant ${JSON.stringify(record.participants)}`);
  const params = new URLSearchParams({
    schemaId: "cd-collab.investigation_collection_query.v1",
    q: "Disposable matched",
    impactIdentity: JSON.stringify(impact),
    contributorId,
    recordedFrom: record.createdAt,
    recordedTo: record.createdAt,
  });
  async function query() {
    const response = await fetch(`${base}/api/cases?${params.toString()}`, {
      headers: { cookie: adminCookie },
    });
    const body = await response.json();
    return { status: response.status, body };
  }
  const first = await query();
  const second = await query();
  if (first.status !== 200 || second.status !== 200) {
    throw new Error(`query status ${first.status}/${second.status}`);
  }
  if (JSON.stringify(first.body) !== JSON.stringify(second.body)) {
    throw new Error("repeated production queries diverged");
  }
  const body = first.body;
  if (body.items?.map((item) => item.id).join(",") !== matched.id) {
    throw new Error(`items ${JSON.stringify(body.items?.map((item) => item.id))} did not match ${matched.id}`);
  }
  if (body.items.some((item) => item.id === other.id)) throw new Error("other case leaked into the filtered page");
  if (body.hiddenArchivedCount !== 0) throw new Error(`hidden archive ${body.hiddenArchivedCount}`);
  const impactCount = body.facets?.impactIdentity?.top?.find((bucket) => bucket.identity?.productName === impact.productName)?.count;
  if (impactCount !== 1) throw new Error(`impact facet ${impactCount}`);
  const openCount = body.facets?.status?.top?.find((bucket) => bucket.key === "open")?.count;
  if (openCount !== 2) throw new Error(`status facet recount ${openCount}`);
  const revoked = await fetch(`${base}/api/authz/group-role-map`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ group: "cn=viewers,ou=groups,dc=example,dc=test" }),
  });
  if (!revoked.ok) throw new Error(`revoke viewer role failed ${revoked.status} ${await revoked.text()}`);
  const deniedResponse = await fetch(`${base}/api/cases?${params.toString()}`, {
    headers: { cookie: deniedCookie },
  });
  const deniedBody = await deniedResponse.json();
  if (deniedResponse.status !== 403 || deniedBody.items) {
    throw new Error(`denied reader received ${deniedResponse.status} ${JSON.stringify(deniedBody)}`);
  }
  const evidence = {
    entry: "collab/server/dist/index.js",
    sqlite: "disposable",
    runs: [first.body, second.body],
    denied: { status: deniedResponse.status, body: deniedBody },
    matchedId: matched.id,
    otherId: other.id,
  };
  await writeFile(join(proofDir, "production-server.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("production-server proof ok");
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
