/**
 * Disposable built-server browser proof.
 *
 * Boots dist/index.js against a new sqlite file and drives the built web
 * application through Playwright. This is the real browser Runtime, not a
 * direct HTTP-only check. Route-injected faults are not used here.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const proofDir = process.env.PROOF_DIR;
if (!proofDir) throw new Error("PROOF_DIR is required");
const port = Number(process.env.PORT ?? 8811);
const chrome = process.env.COLLAB_E2E_CHROMIUM_PATH;
const root = await mkdtemp(join(proofDir, "built-browser-"));
const sqlitePath = join(root, "discovery.sqlite");
const evidenceRoot = join(root, "evidence");
const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const staticDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
await mkdir(evidenceRoot, { recursive: true });

const admin = {
  username: "synth-admin",
  password: "fixture-synth-admin-secret",
  displayName: "Synthetic admin",
  groups: ["cn=admins,ou=groups,dc=example,dc=test"],
};

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    COLLAB_STORAGE: "sqlite",
    COLLAB_SQLITE_PATH: sqlitePath,
    COLLAB_AUTH_MODE: "local",
    COLLAB_LOCAL_USERS: JSON.stringify([admin]),
    COLLAB_GROUP_ROLE_MAP: "cn=admins,ou=groups,dc=example,dc=test=admin",
    COLLAB_EVIDENCE_ROOT: evidenceRoot,
    COLLAB_HOST: "127.0.0.1",
    COLLAB_PORT: String(port),
    COLLAB_STATIC_DIR: staticDir,
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

const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) { healthy = true; break; }
    } catch { /* still binding */ }
    await delay(200);
  }
  if (!healthy) throw new Error(`production server did not become healthy\n${logs}`);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(base);
  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Latest activity").waitFor({ timeout: 20_000 });
  const menu = page.getByRole("button", { name: "Menu" });
  if (await menu.isVisible()) await menu.click();
  const account = page.getByRole("button", { name: /^Signed in as / });
  if (!(await account.isVisible())) {
    throw new Error(`signed-in shell has no account control\n${(await page.locator("body").innerText()).slice(0, 800)}`);
  }

  const token = `built${Date.now().toString(36)}`;
  const created = await page.evaluate(async (title) => {
    const response = await fetch("/api/cases", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-cd-collab-csrf": "1" },
      body: JSON.stringify({
        title,
        problemStatement: "Built-server browser proof.",
        affectedParties: "Synthetic operators",
        impact: "Qualification only",
      }),
    });
    return { status: response.status, body: await response.json() };
  }, `${token} recorded`);
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`create failed ${created.status} ${JSON.stringify(created.body)}`);
  }
  const body = created.body;
  if (!body.id || !body.createdAt) throw new Error("created case did not return id and createdAt");
  const recordedDay = String(body.createdAt).slice(0, 10);

  await page.goto(`${base}/investigations?q=${encodeURIComponent(token)}&recordedFrom=${recordedDay}T00:00:00.000Z&recordedTo=${recordedDay}T23:59:59.999Z`);
  const row = page.locator(".case-card__open").filter({ hasText: `${token} recorded` });
  await row.waitFor();
  const shotDir = process.env.SCREENSHOT_DIR;
  if (shotDir) {
    await mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, "built-server-1280.png"), fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.screenshot({ path: join(shotDir, "built-server-320-forced-colors.png"), fullPage: true });
  }
  await row.click();
  await page.waitForURL(new RegExp(`/investigations/${body.id}/`));
  const report = {
    kind: "built-server-browser-runtime",
    base,
    caseId: body.id,
    createdAt: body.createdAt,
    recordedDay,
    url: page.url(),
    routeInjected: false,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
  await stop();
  await rm(root, { recursive: true, force: true });
}
