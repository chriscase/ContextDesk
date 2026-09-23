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

  page.setDefaultTimeout(30_000);
  const token = `built${Date.now().toString(36)}`;
  const corpus = await page.evaluate(async (prefix) => {
    async function send(path, body) {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-cd-collab-csrf": "1" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`${response.status} ${path} ${JSON.stringify(payload)}`);
      }
      return payload;
    }
    const records = [];
    for (let index = 0; index < 52; index += 1) {
      const title = `${prefix} ${String(index).padStart(2, "0")}`;
      const created = await send("/api/cases", {
        title,
        problemStatement: "Built-server browser proof.",
        affectedParties: "Synthetic operators",
        impact: "Qualification only",
      });
      records.push({ id: created.id, title, createdAt: created.createdAt });
    }
    await send(`/api/cases/${records[0].id}/software-impact`, {
      productName: `${prefix}-alpha`,
      version: "1",
      build: "",
      component: "worker",
      environment: "lab",
      status: "observed",
      note: "First impact",
    });
    await send(`/api/cases/${records[1].id}/software-impact`, {
      productName: `${prefix}-beta`,
      version: "2",
      build: "",
      component: "api",
      environment: "stage",
      status: "observed",
      note: "Second impact",
    });
    await send(`/api/cases/${records[0].id}/participants`, {
      identityId: "identity-synth-eve",
      username: "synth-eve",
    });
    const lifecycle = await fetch(`/api/cases/${records[2].id}/lifecycle`, { credentials: "same-origin" });
    const preview = await lifecycle.json();
    if (!lifecycle.ok) throw new Error(`lifecycle ${lifecycle.status} ${JSON.stringify(preview)}`);
    await send(`/api/cases/${records[2].id}/lifecycle`, {
      schemaId: "cd-collab.investigation_lifecycle_action_request.v1",
      investigationId: preview.investigationId,
      action: "archive",
      expected: {
        status: preview.status,
        legalHold: preview.legalHold,
        restoreTarget: preview.restoreTarget,
      },
    });
    return records;
  }, token);

  const createdAts = corpus.map((record) => Date.parse(record.createdAt)).sort((left, right) => left - right);
  const earliest = new Date(createdAts[0]).toISOString();
  const latest = new Date(createdAts[createdAts.length - 1]).toISOString();
  const recordedDay = earliest.slice(0, 10);
  const outsideDay = new Date(createdAts[0] - 86_400_000).toISOString().slice(0, 10);
  const oldest = corpus[0];
  const newest = corpus[corpus.length - 1];
  const filtered = `${base}/investigations?q=${encodeURIComponent(token)}&recordedFrom=${recordedDay}T00:00:00.000Z&recordedTo=${recordedDay}T23:59:59.999Z`;

  async function enablePresentations() {
    const policy = await page.evaluate(async () => {
      const response = await fetch("/api/admin/ui-strategies", { credentials: "same-origin" });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
    const ids = ["war-room", "investigation-first", "keystone", "beacon"];
    const update = await page.evaluate(async ({ revision, ids: strategyIds }) => {
      const response = await fetch("/api/admin/ui-strategies", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-cd-collab-csrf": "1" },
        body: JSON.stringify({
          schemaId: "cd-collab.ui_strategy_policy_update.v1",
          expectedRevision: revision,
          instance: {
            enabledIds: strategyIds,
            visibleIds: strategyIds,
            defaultId: "war-room",
            selectionMode: "free",
            approvedIds: strategyIds,
          },
          roleRules: [],
        }),
      });
      return { status: response.status, body: await response.text() };
    }, { revision: policy.revision, ids });
    if (update.status >= 300) throw new Error(`strategy policy ${update.status} ${update.body}`);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  async function selectExperience(name) {
    const topbar = page.locator(".topbar__title-app");
    await topbar.waitFor();
    const menu = page.getByRole("button", { name: "Menu" });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole("button", { name: /^Signed in as / }).click();
    const fieldset = page.getByRole("group", { name: "Investigation experience" });
    await fieldset.waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes("Loading the workspace investigation-experience policy"));
    const applied = (await topbar.innerText()).trim();
    const appliedRadio = fieldset.getByRole("radio", { name: new RegExp(`^${escapeRegExp(applied)}\\b`, "u") });
    await appliedRadio.waitFor();
    if (applied === name) {
      await page.keyboard.press("Escape");
      return;
    }
    const save = page.getByRole("button", { name: "Use selected experience" });
    await fieldset.getByRole("radio", { name: new RegExp(`^${escapeRegExp(name)}\\b`, "u") }).check();
    if (!(await save.isEnabled())) throw new Error(`save stayed disabled for ${name}`);
    await save.click();
    await topbar.filter({ hasText: name }).waitFor();
    await page.keyboard.press("Escape");
  }

  await enablePresentations();
  await page.goto(`${base}/investigations`);
  const collectionRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/cases?") && url.includes("investigation_collection_query")) {
      collectionRequests.push(url);
    }
  });

  await page.goto(`${base}/investigations?q=${encodeURIComponent(token)}&recordedTo=${outsideDay}T23:59:59.999Z`);
  await page.getByText("No investigations match the current search or filter.").waitFor();
  await page.goto(filtered);
  const presentations = [
    { name: "War Room", row: ".case-card__open" },
    { name: "Investigation First", row: ".investigation-first__list-button" },
    { name: "Keystone", row: ".keystone-strategy__collection-list button" },
    { name: "Beacon", row: ".beacon__case-list button" },
  ];
  const shotDir = process.env.SCREENSHOT_DIR;
  if (shotDir) await mkdir(shotDir, { recursive: true });
  const journeys = [];
  for (const presentation of presentations) {
    await selectExperience(presentation.name);
    if (!page.url().includes(`q=${encodeURIComponent(token)}`) && !page.url().includes(`q=${token}`)) {
      await page.goto(filtered);
    }
    const rows = page.locator(presentation.row);
    await rows.filter({ hasText: newest.title }).waitFor();
    const before = await rows.allInnerTexts();
    if (before.some((text) => text.includes(oldest.title))) {
      throw new Error(`${presentation.name} showed the oldest row before continuation`);
    }
    const beforeCount = collectionRequests.length;
    await page.getByRole("button", { name: "Load next page" }).click();
    await rows.filter({ hasText: oldest.title }).waitFor();
    const continuation = collectionRequests.slice(beforeCount).find((url) => url.includes("cursor="));
    if (!continuation) throw new Error(`${presentation.name} continuation did not send a server cursor`);
    if (new URL(page.url()).searchParams.has("cursor")) {
      throw new Error(`${presentation.name} put the cursor in the browser URL`);
    }
    await page.reload();
    await rows.filter({ hasText: newest.title }).waitFor();
    if (new URL(page.url()).searchParams.get("q") !== token) {
      throw new Error(`${presentation.name} dropped the query on reload`);
    }
    const filteredUrl = page.url();
    await page.goto(`${base}/investigations`);
    await page.goBack();
    await page.waitForURL(filteredUrl);
    if (new URL(page.url()).searchParams.get("q") !== token) {
      throw new Error(`${presentation.name} did not restore the query on back`);
    }
    await page.goForward();
    await page.waitForURL(`${base}/investigations`);
    await page.goBack();
    await rows.filter({ hasText: newest.title }).waitFor();
    if (shotDir) {
      const fileName = `built-server-${presentation.name.toLowerCase().replace(/\s+/gu, "-")}-1280.png`;
      await page.screenshot({ path: join(shotDir, fileName), fullPage: false });
    }
    journeys.push({ presentation: presentation.name, continuationHasCursor: true, openedAfterClear: false });
  }

  await page.getByRole("button", { name: /Clear Recorded to / }).click();
  await page.getByRole("button", { name: /Clear Recorded from / }).click();
  await page.getByRole("button", { name: `Clear Search: ${token}` }).click();
  await page.getByText("No collection filters are active.").waitFor();
  const openRow = page.locator(".beacon__case-list button").filter({ hasText: newest.title });
  await openRow.waitFor();
  await openRow.click();
  await page.waitForURL(new RegExp(`/investigations/${newest.id}/`));
  journeys[journeys.length - 1].openedAfterClear = true;
  if (shotDir) {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.screenshot({ path: join(shotDir, "built-server-320-forced-colors.png"), fullPage: false });
  }
  const report = {
    kind: "built-server-browser-runtime",
    base,
    routeInjected: false,
    pageSize: 50,
    recordCount: corpus.length,
    archivedId: corpus[2].id,
    distinctImpacts: [`${token}-alpha`, `${token}-beta`],
    contributorId: "identity-synth-eve",
    earliest,
    latest,
    recordedDay,
    outsideDay,
    oldestId: oldest.id,
    newestId: newest.id,
    url: page.url(),
    journeys,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
  await stop();
  await rm(root, { recursive: true, force: true });
}
