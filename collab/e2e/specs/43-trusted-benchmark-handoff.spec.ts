import { expect, test, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const serverFile = resolve(here, "../../server/dist/index.js");
const staticDir = resolve(here, "../../web/dist");
const benchBin = process.env.CD_GOAL09_BENCH_BIN;
const headers = { "x-cd-collab-csrf": "1" };

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  expect(value && typeof value === "object" && !Array.isArray(value)).toBeTruthy();
  return value as Row;
}
function id(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No disposable port");
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
}
async function startServer(root: string, port: number, password: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: { ...process.env,
      COLLAB_STORAGE: "sqlite", COLLAB_SQLITE_PATH: join(root, "collab.sqlite"),
      COLLAB_EVIDENCE_ROOT: join(root, "evidence"), COLLAB_STATIC_DIR: staticDir,
      COLLAB_AUTH_MODE: "local", COLLAB_LOCAL_USERS: JSON.stringify([{ username: "lead", password,
        groups: ["local:lead"], displayName: "Synthetic lead" }]),
      COLLAB_GROUP_ROLE_MAP: "local:lead=admin", COLLAB_COOKIE_SECURE: "0",
      COLLAB_HOST: "127.0.0.1", COLLAB_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (bytes: Buffer) => {
    diagnostic = (diagnostic + bytes.toString()).slice(-3000);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`SQLite server exited: ${diagnostic}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`SQLite server did not start: ${diagnostic}`);
}
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const stopped = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await stopped;
}
async function api(page: Page, base: string, method: "get" | "post", path: string, data?: Row): Promise<Row> {
  const response = await page.request[method](`${base}${path}`, method === "post" ? { headers, data } : {});
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return row(await response.json());
}
async function putJson(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}
async function fixture(name: string): Promise<Row> {
  return row(JSON.parse(await readFile(join(repo, "crates/cd-triage-bench/fixtures/valid", name), "utf8")) as unknown);
}
function bench(library: string, ...args: string[]): string {
  if (!benchBin) throw new Error("CD_GOAL09_BENCH_BIN must name the compiled offline CLI");
  return execFileSync(benchBin, ["--library", library, ...args], { encoding: "utf8" }).trim();
}
async function signIn(page: Page, base: string, password: string): Promise<void> {
  await page.goto(base);
  await page.getByLabel("Username").fill("lead");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Signed in as Synthetic lead" })).toBeVisible();
}
async function openDecision(page: Page, base: string, caseId: string): Promise<void> {
  await page.goto(`${base}/investigations/${caseId}/situation`);
  await page.getByRole("navigation", { name: "Investigation stages" })
    .getByRole("button", { name: /^Decide/ }).click();
  await expect(page.getByRole("heading", { name: "Accepted decision" })).toBeVisible();
}

test.describe("@joined trusted benchmark handoff", () => {
  test.skip(!process.env.CD_GOAL09_JOINED, "Run explicitly with the built SQLite server and offline bench");
  test("saved owner-only file joins the offline report; lost committed acknowledgment recovers after SQLite restart", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const root = await mkdtemp(join(tmpdir(), "contextdesk-goal09-joined-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const password = randomUUID();
    const library = join(root, "bench");
    let child: ChildProcess | null = null;
    try {
      child = await startServer(root, port, password);
      await signIn(page, base, password);
      const caseId = id((await api(page, base, "post", "/api/cases", { title: "Synthetic benchmark handoff" })).id);
      bench(library, "init");
      const benchCase = await fixture("case.json");
      benchCase.case_id = caseId;
      bench(library, "import-case", await putJson(root, "bench-case.json", benchCase));
      const snapshot = await fixture("snapshot.json");
      snapshot.case_id = caseId;
      const items = snapshot.items as Row[];
      items[0]!.item_id = "ev-demo-checkout-log";
      const snapshotId = bench(library, "import-snapshot", await putJson(root, "snapshot.json", snapshot),
        "--blob", join(repo, "crates/cd-triage-bench/fixtures/blobs/checkout.log"));
      const task = await fixture("task.json");
      task.case_id = caseId;
      task.snapshot_id = snapshotId;
      row(task.visibility).visible_item_ids = ["ev-demo-checkout-log"];
      const taskId = bench(library, "import-task", await putJson(root, "task.json", task));
      const run = await fixture("run.json");
      run.task_id = taskId;
      run.claims = [{ claim: "Synthetic checkout timeout", evidence_item_id: "ev-demo-checkout-log", locator: null }];
      bench(library, "import-run", await putJson(root, "run.json", run));

      const pkg = row(JSON.parse(await readFile(join(repo, "collab/contracts/fixtures/experiment-package.valid.json"), "utf8")) as unknown);
      pkg.taskFingerprint = taskId;
      pkg.snapshotFingerprint = snapshotId;
      const experimentId = id((await api(page, base, "post", `/api/cases/${caseId}/experiments`, pkg)).id);
      const proposal = await api(page, base, "post", `/api/cases/${caseId}/experiments/${experimentId}/decisions`, {
        text: "Human synthetic checkout benchmark", rationale: "Reviewed synthetic evidence",
        evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      });
      await api(page, base, "post", `/api/cases/${caseId}/experiments/${experimentId}/decisions/${id(proposal.id)}/accept`,
        { expectedRevision: proposal.revision });
      await openDecision(page, base, caseId);
      const tools = page.locator(".experiment-lab__benchmark-handoff");
      await tools.getByText("Version the human benchmark").click();
      const choices = tools.getByRole("group", { name: "Evidence anchors for this human benchmark" });
      await expect(choices.locator('input[type="checkbox"]:checked')).toHaveCount(2);
      const goldPath = `/api/cases/${caseId}/experiments/${experimentId}/gold`;
      let promotionPosts = 0;
      page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === goldPath) promotionPosts += 1; });
      await choices.locator('input[value="ev-demo-inventory-timeout"]').uncheck();
      await expect(choices.locator('input[type="checkbox"]:checked')).toHaveCount(1);
      expect(promotionPosts).toBe(0);
      await tools.getByRole("button", { name: "Promote accepted decision to gold" }).click();
      await expect(tools.getByRole("status").filter({ hasText: /Recorded benchmark v1/ })).toBeVisible();
      expect(promotionPosts).toBe(1);
      const firstHistory = await api(page, base, "get", `/api/cases/${caseId}/experiments`);
      const firstView = (firstHistory.experiments as Row[]).find((item) => item.id === experimentId);
      const firstGold = row(firstView?.gold);
      expect(firstGold.version).toBe(1);
      expect(firstGold.evidenceAnchors).toEqual(["ev-demo-checkout-log"]);
      await page.setViewportSize({ width: 320, height: 844 });
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.screenshot({ path: testInfo.outputPath("benchmark-decide-320.png"), fullPage: true });
      const downloadPromise = page.waitForEvent("download");
      const downloadButton = tools.getByRole("button", { name: "Download owner-only benchmark v1" });
      await downloadButton.focus();
      await expect(downloadButton).toBeFocused();
      await page.keyboard.press("Enter");
      const download = await downloadPromise;
      const saved = join(root, "actual-browser-download.json");
      await download.saveAs(saved);
      const bytes = await readFile(saved);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const envelope = row(JSON.parse(bytes.toString("utf8")) as unknown);
      const exportedGold = row(envelope.gold);
      expect(envelope).toMatchObject({ schemaId: "cd-collab.gold_reference_export.v1", privacyClass: "owner_only" });
      expect(exportedGold).toMatchObject({ goldId: firstGold.goldId, caseId, experimentId,
        taskFingerprint: taskId, snapshotFingerprint: snapshotId });
      expect(promotionPosts).toBe(1);
      expect(bench(library, "import-gold", saved)).toContain(`${firstGold.goldId} v1 owner_only`);
      expect(bench(library, "import-gold", saved)).toContain(`${firstGold.goldId} v1 owner_only`);
      const report = row(JSON.parse(bench(library, "report", "--format", "json", "--privacy", "owner-only", "--task", taskId)) as unknown);
      const groups = report.groups as Row[];
      expect(groups).toHaveLength(1);
      expect(row(groups[0]?.gold).gold_id).toBe(firstGold.goldId);
      const matchingReportAgain = bench(library, "report", "--format", "json", "--privacy", "owner-only", "--task", taskId);
      expect(row(JSON.parse(matchingReportAgain) as unknown)).toEqual(report);
      const unrelatedSnapshot = structuredClone(snapshot);
      unrelatedSnapshot.captured_at = "2026-01-16T06:00:00Z";
      (unrelatedSnapshot.items as Row[])[0]!.item_id = "ev-unrelated-log";
      const unrelatedSnapshotId = bench(library, "import-snapshot",
        await putJson(root, "unrelated-snapshot.json", unrelatedSnapshot));
      const unrelatedTask = structuredClone(task);
      unrelatedTask.snapshot_id = unrelatedSnapshotId;
      unrelatedTask.question = "What happened in the unrelated synthetic snapshot?";
      row(unrelatedTask.visibility).visible_item_ids = ["ev-unrelated-log"];
      const unrelatedTaskId = bench(library, "import-task", await putJson(root, "unrelated-task.json", unrelatedTask));
      const unrelatedRun = structuredClone(run);
      unrelatedRun.task_id = unrelatedTaskId;
      unrelatedRun.claims = [{ claim: "Unrelated synthetic observation", evidence_item_id: "ev-unrelated-log", locator: null }];
      bench(library, "import-run", await putJson(root, "unrelated-run.json", unrelatedRun));
      const unrelatedReport = row(JSON.parse(bench(library, "report", "--format", "json", "--privacy", "owner-only", "--task", unrelatedTaskId)) as unknown);
      expect(unrelatedReport.groups as Row[]).toHaveLength(1);
      expect((unrelatedReport.groups as Row[])[0]!.gold).toBeUndefined();
      console.log(`Goal 09 saved file sha256=${digest} gold=${firstGold.goldId} task=${taskId} snapshot=${snapshotId}`);

      // Accepted decisions are immutable. A second comparison supplies a
      // separate committed-acknowledgment-loss probe without modifying v1.
      const secondPackage = { ...pkg, packageId: `${pkg.packageId}-response-loss` };
      const secondExperimentId = id((await api(page, base, "post", `/api/cases/${caseId}/experiments`, secondPackage)).id);
      const proposal2 = await api(page, base, "post", `/api/cases/${caseId}/experiments/${secondExperimentId}/decisions`, {
        text: "Second deliberate synthetic version", rationale: "Human revision for response-loss qualification",
        evidenceRefs: ["ev-demo-checkout-log"],
      });
      await api(page, base, "post", `/api/cases/${caseId}/experiments/${secondExperimentId}/decisions/${id(proposal2.id)}/accept`,
        { expectedRevision: proposal2.revision });
      await page.reload();
      const recovery = page.locator(".experiment-lab__benchmark-handoff");
      await recovery.getByText("Version the human benchmark").click();
      let committed = false;
      const lossPath = `/api/cases/${caseId}/experiments/${secondExperimentId}/gold`;
      await page.route(`**${lossPath}`, async (route) => {
        if (route.request().method() !== "POST" || committed) { await route.continue(); return; }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        committed = true;
        await route.abort("failed");
      });
      await recovery.getByRole("button", { name: "Promote accepted decision to gold" }).click();
      await expect(recovery.getByText(/result is unconfirmed/)).toBeVisible();
      expect(committed).toBe(true);
      await recovery.getByRole("button", { name: "Read current benchmark history" }).click();
      await expect(recovery.getByText(/Recovered recorded benchmark v1/)).toBeVisible();
      await page.unroute(`**${lossPath}`);
      const history = await api(page, base, "get", `/api/cases/${caseId}/experiments`);
      const view = (history.experiments as Row[]).find((item) => item.id === secondExperimentId);
      expect((view?.golds as Row[])).toHaveLength(1);
      const timeline = await api(page, base, "get", `/api/cases/${caseId}/timeline`);
      expect((timeline.events as Row[]).filter((event) => event.kind === "experiment_gold_promoted")).toHaveLength(2);
      await stopServer(child);
      child = await startServer(root, port, password);
      await openDecision(page, base, caseId);
      await expect(page.locator(".experiment-lab__benchmark-handoff")
        .getByRole("combobox", { name: "Recorded benchmark version" })).toBeVisible();
      const afterRestart = await api(page, base, "get", `/api/cases/${caseId}/experiments`);
      const durable = (afterRestart.experiments as Row[]).find((item) => item.id === secondExperimentId);
      expect((durable?.golds as Row[])).toHaveLength(1);
      expect(id(row(durable?.gold).goldId)).toBe(id(row(view?.gold).goldId));
      const exactExport = await api(page, base, "post", `/api/cases/${caseId}/experiments/${experimentId}/gold/${firstGold.goldId}/export`,
        { version: 1 });
      expect(row(exactExport.gold).goldId).toBe(firstGold.goldId);
    } finally {
      if (child) await stopServer(child);
      await rm(root, { recursive: true, force: true });
    }
  });
});
