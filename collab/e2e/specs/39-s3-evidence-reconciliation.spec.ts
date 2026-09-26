import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

/**
 * Public-browser qualification of Investigation First and Beacon evidence
 * upload outcome reconciliation.
 *
 * Route interception is not live S3. These tests never claim object-store
 * durability, bucket identity, or server-side promote behavior. They only
 * qualify the shipped UI against the public HTTP contract:
 *
 * - Upload: POST `/api/cases/:id/evidence/stream` as multipart/form-data when
 *   the runtime prefers `uploadEvidenceStream` (JSON POST `/evidence` with
 *   `contentBase64` remains a valid legacy transport and is treated the same
 *   if the UI uses it).
 * - Authoritative inventory: GET `/api/cases/:id/evidence`
 *   (`cd-collab.evidence_list.v1`).
 * - Unknown commit marker: exact JSON `{ "error": "commit_outcome_unknown" }`
 *   on HTTP 503. Any other 503 body is ordinary unavailable.
 *
 * Nonclaim: this UI upload route does not send a public idempotency key or
 * Idempotency-Key header. Retry identity is the same path plus the canonical
 * field/file payload. Multipart MIME boundaries are browser-generated and are
 * not part of that payload.
 */

const ALL_STRATEGIES = ["war-room", "investigation-first", "keystone", "beacon"] as const;
const UNKNOWN_COMMIT_BODY = JSON.stringify({ error: "commit_outcome_unknown" });
const ORDINARY_503_BODY = JSON.stringify({ error: "storage_unavailable" });
interface StrategyPolicy {
  revision: number;
  instance: {
    enabledIds: string[];
    visibleIds: string[];
    defaultId: string;
    selectionMode: "free" | "approved_subset";
    approvedIds: string[];
  };
  roleRules: Array<{
    role: "viewer" | "contributor" | "case-lead" | "admin";
    approvedIds: string[];
    defaultId: string | null;
  }>;
}

interface Surface {
  readonly id: "investigation-first" | "beacon";
  readonly name: string;
  readonly file: (page: Page) => ReturnType<Page["getByLabel"]>;
  readonly summary: (page: Page) => ReturnType<Page["getByLabel"]>;
  readonly kind: (page: Page) => ReturnType<Page["getByLabel"]>;
  readonly privacy: (page: Page) => ReturnType<Page["getByLabel"]>;
  readonly submit: (page: Page) => ReturnType<Page["getByRole"]>;
}
const SURFACES: readonly Surface[] = [
  { id: "investigation-first", name: "Investigation First" },
  { id: "beacon", name: "Beacon" },
].map((surface) => ({ ...surface,
  file: (page: Page) => page.locator(".evidence-reconciliation").getByLabel(surface.id === "beacon" ? "File (server-configured limit)" : "File", { exact: true }),
  summary: (page: Page) => page.locator(".evidence-reconciliation").getByLabel(surface.id === "beacon" ? "Why does this matter?" : "Summary", { exact: true }),
  kind: (page: Page) => page.locator(".evidence-reconciliation").getByRole("combobox", { name: "Kind", exact: true }),
  privacy: (page: Page) => page.locator(".evidence-reconciliation").getByRole("combobox", { name: "Privacy", exact: true }),
  submit: (page: Page) => page.locator(".evidence-reconciliation").getByRole("button", { name: surface.id === "beacon" ? "Attach evidence" : "Add to evidence inventory" }),
})) as Surface[];

interface CapturedUpload {
  pathname: string;
  headers: Record<string, string>;
  raw: Buffer;
  contentType: string;
}

interface CanonicalUpload {
  pathname: string;
  transport: "json" | "multipart";
  fields: Record<string, string>;
  files: Record<string, { filename?: string; mediaType?: string; bodyHex: string }>;
  idempotency: { headers: Record<string, string>; field: string | null };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function strategyPolicy(page: Page): Promise<StrategyPolicy> {
  const response = await page.request.get("/api/admin/ui-strategies");
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as StrategyPolicy;
}

async function updateStrategyPolicy(
  page: Page,
  policy: Pick<StrategyPolicy, "instance" | "roleRules">,
): Promise<void> {
  const current = await strategyPolicy(page);
  const response = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: current.revision,
      instance: policy.instance,
      roleRules: policy.roleRules,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function useFixedStrategy(page: Page, defaultId: Surface["id"]): Promise<StrategyPolicy> {
  const previous = await strategyPolicy(page);
  await updateStrategyPolicy(page, {
    instance: {
      enabledIds: [...ALL_STRATEGIES],
      visibleIds: [...ALL_STRATEGIES],
      defaultId,
      selectionMode: "approved_subset",
      approvedIds: [],
    },
    roleRules: [],
  });
  return previous;
}

async function restoreStrategyPolicy(page: Page, previous: StrategyPolicy): Promise<void> {
  await loginAs(page, FIXTURE_USERS.dave);
  await updateStrategyPolicy(page, {
    instance: previous.instance,
    roleRules: previous.roleRules,
  });
}

async function createInvestigation(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Synthetic upload-reconciliation browser qualification.",
      affectedParties: "Fixture operators",
      impact: "Qualification only",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id?: string };
  expect(body.id, "case creation did not return an id").toBeTruthy();
  return body.id!;
}

function evidenceUploadPath(pathname: string, caseId: string): boolean {
  return pathname === `/api/cases/${caseId}/evidence`
    || pathname === `/api/cases/${caseId}/evidence/stream`;
}

function evidenceListPath(pathname: string, caseId: string): boolean {
  return pathname === `/api/cases/${caseId}/evidence`;
}

function splitBuffer(haystack: Buffer, needle: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) {
      parts.push(haystack.subarray(start));
      break;
    }
    parts.push(haystack.subarray(start, index));
    start = index + needle.length;
  }
  return parts;
}

function parseMultipart(
  raw: Buffer,
  contentType: string,
): { fields: Record<string, string>; files: CanonicalUpload["files"] } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  expect(match, `multipart upload missing boundary: ${contentType}`).toBeTruthy();
  const boundary = (match![1] ?? match![2]!).trim();
  const fields: Record<string, string> = {};
  const files: CanonicalUpload["files"] = {};
  for (const chunk of splitBuffer(raw, Buffer.from(`--${boundary}`))) {
    if (chunk.length === 0) continue;
    let part = chunk;
    if (part[0] === 0x2d && part[1] === 0x2d) continue;
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    if (
      part.length >= 2
      && part[part.length - 2] === 0x0d
      && part[part.length - 1] === 0x0a
    ) {
      part = part.subarray(0, part.length - 2);
    }
    const headerSep = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerSep === -1) continue;
    const headers = part.subarray(0, headerSep).toString("utf8");
    const body = part.subarray(headerSep + 4);
    const name = /name="([^"]+)"/iu.exec(headers)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/iu.exec(headers)?.[1];
    const mediaType = /^content-type:\s*([^\r\n]+)/imu.exec(headers)?.[1]?.trim();
    if (filename !== undefined) {
      files[name] = {
        filename,
        ...(mediaType === undefined ? {} : { mediaType }),
        bodyHex: body.toString("hex"),
      };
    } else {
      fields[name] = body.toString("utf8");
    }
  }
  return { fields, files };
}

function idempotencyOf(
  headers: Record<string, string>,
  field: string | undefined,
): CanonicalUpload["idempotency"] {
  const matched: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().includes("idempotency")) matched[key.toLowerCase()] = value;
  }
  return { headers: matched, field: field ?? null };
}

function canonicalUpload(captured: CapturedUpload): CanonicalUpload {
  const contentType = captured.contentType;
  if (/\bapplication\/json\b/iu.test(contentType)) {
    const body = JSON.parse(captured.raw.toString("utf8")) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "contentBase64") continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        fields[key] = String(value);
      }
    }
    const files: CanonicalUpload["files"] = {};
    if (typeof body.contentBase64 === "string") {
      files.file = {
        ...(typeof body.filename === "string" ? { filename: body.filename } : {}),
        ...(typeof body.mediaType === "string" ? { mediaType: body.mediaType } : {}),
        bodyHex: Buffer.from(body.contentBase64, "base64").toString("hex"),
      };
    }
    return {
      pathname: captured.pathname,
      transport: "json",
      fields,
      files,
      idempotency: idempotencyOf(
        captured.headers,
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      ),
    };
  }
  expect(
    /\bmultipart\/form-data\b/iu.test(contentType),
    `unexpected upload content-type ${contentType}`,
  ).toBe(true);
  const parsed = parseMultipart(captured.raw, contentType);
  return {
    pathname: captured.pathname,
    transport: "multipart",
    fields: parsed.fields,
    files: parsed.files,
    idempotency: idempotencyOf(captured.headers, parsed.fields.idempotencyKey),
  };
}

function captureUpload(request: Request): CapturedUpload {
  const url = new URL(request.url());
  const raw = request.postDataBuffer();
  expect(raw, `${url.pathname} upload POST had no captured body`).toBeTruthy();
  const headers = request.headers();
  return {
    pathname: url.pathname,
    headers,
    raw: raw!,
    contentType: headers["content-type"] ?? "",
  };
}

function evidenceRoute(caseId: string): (url: URL) => boolean {
  return (url) => evidenceUploadPath(url.pathname, caseId) || evidenceListPath(url.pathname, caseId);
}

async function selectedFile(
  locator: ReturnType<Surface["file"]>,
): Promise<{ name: string; size: number; type: string } | null> {
  return locator.evaluate((node) => {
    const input = node as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return null;
    return { name: file.name, size: file.size, type: file.type };
  });
}

async function expectDraftPreserved(
  surface: Surface,
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  summary: string,
): Promise<void> {
  await expect.poll(async () => selectedFile(surface.file(page))).toEqual({
    name: file.name,
    size: file.buffer.length,
    type: file.mimeType,
  });
  await expect(surface.summary(page)).toHaveValue(summary);
}

async function submitEvenIfBlocked(page: Page, submitName: string): Promise<void> {
  const submit = page.getByRole("button", { name: submitName });
  await submit.evaluate((button) => {
    const form = (button as HTMLButtonElement).closest("form");
    form?.requestSubmit();
  });
}

async function fillUpload(
  surface: Surface,
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  summary: string,
): Promise<void> {
  await surface.file(page).setInputFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: file.buffer,
  });
  await surface.kind(page).selectOption("log");
  await surface.privacy(page).selectOption("share_safe");
  await surface.summary(page).fill(summary);
}

async function openWriterRecord(
  page: Page,
  surface: Surface,
  title: string,
): Promise<string> {
  const caseId = await createInvestigation(page, title);
  await page.goto(`/investigations/${caseId}/situation`);
  await expect(page.locator(".topbar__title-app")).toHaveText(surface.name);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(surface.submit(page)).toBeEnabled();
  return caseId;
}

async function withSurface(page: Page, surface: Surface, work: (caseId: string) => Promise<void>) {
  await loginAs(page, FIXTURE_USERS.dave);
  const preferencesResponse = await page.request.get("/api/ui-strategies/effective");
  const preferences = await preferencesResponse.json() as { preferredId: string | null };
  const previous = await useFixedStrategy(page, surface.id);
  let failure: unknown;
  try { await work(await openWriterRecord(page, surface, uniqueTitle(`${surface.name} synthetic S3`))); }
  catch (error) { failure = error; }
  finally {
    try {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await restoreStrategyPolicy(page, previous);
      // Policy and personal preference are separate authority layers.
      const current = await (await page.request.get("/api/ui-strategies/effective")).json() as { preferredId: string | null; preferenceRevision: number };
      expect(current.preferredId).toBe(preferences.preferredId);
      // Fixed-policy tests do not save a personal preference. Its original
      // null/value state is asserted independently after policy restoration.
    } catch (cleanup) { if (!failure) failure = cleanup; else await test.info().attach("cleanup-failure", { body: String(cleanup), contentType: "text/plain" }); }
  }
  if (failure) throw failure;
}
const syntheticFile = { name: "synthetic-original.log", mimeType: "text/plain", buffer: Buffer.from("synthetic original evidence\n") };
for (const surface of SURFACES) {
  test.describe(`${surface.name} S3 recovery (HTTP-injected presentation proof)`, () => {
    test("causal delayed/failed reads, immutable retries, repeated unknown, success and accessibility", async ({ page }) => {
      await withSurface(page, surface, async (caseId) => {
        const posts: CapturedUpload[] = [];
        const readStarted = deferred(); const release = deferred();
        let reads: "hold" | "failed" | "live" = "hold";
        await page.route(evidenceRoute(caseId), async (route) => {
          const request = route.request();
          if (request.method() === "POST") {
            posts.push(captureUpload(request));
            if (posts.length <= 2) { await route.fulfill({ status: 503, contentType: "application/json", body: UNKNOWN_COMMIT_BODY }); return; }
          } else if (request.method() === "GET" && reads !== "live") {
            readStarted.resolve(); if (reads === "hold") await release.promise;
            await route.fulfill({ status: 503, contentType: "application/json", body: ORDINARY_503_BODY }); return;
          }
          await route.continue();
        });
        try {
          await fillUpload(surface, page, syntheticFile, "original summary");
          await surface.submit(page).click(); await readStarted.promise;
          const form = page.locator(".evidence-reconciliation");
          await expect(form.getByRole("status")).toContainText("unconfirmed");
          await expect(surface.file(page)).toBeDisabled();
          await expectDraftPreserved(surface, page, syntheticFile, "original summary");
          await form.evaluate((node) => { node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
          expect(posts).toHaveLength(1);
          reads = "failed"; release.resolve();
          await expect(form.getByRole("alert")).toContainText("inventory refresh failed");
          await expect(form.getByRole("alert")).toBeFocused();
          expect(posts).toHaveLength(1);
          reads = "live";
          await form.getByRole("button", { name: "Refresh inventory" }).click();
          await expect(form.getByRole("status")).toContainText("Review the refreshed inventory");
          const retry = form.getByRole("button", { name: "Retry original upload" });
          await expect(retry).toBeEnabled();
          // Disabled DOM controls can be changed programmatically; the handler must ignore them.
          await form.evaluate((node) => {
            const controls = (node as HTMLFormElement).elements;
            (controls.namedItem("summary") as HTMLInputElement).value = "edited summary";
            (controls.namedItem("kind") as HTMLSelectElement).value = "email";
            (controls.namedItem("privacyClass") as HTMLSelectElement).value = "owner_only";
            const replacement = new DataTransfer(); replacement.items.add(new File(["edited bytes"], "edited.log", { type: "text/plain" }));
            (controls.namedItem("file") as HTMLInputElement).files = replacement.files;
          });
          await form.evaluate((node) => node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          expect(posts).toHaveLength(1);
          await retry.click();
          await expect.poll(() => posts.length).toBe(2);
          await expect(retry).toBeEnabled(); // second unknown's own successful refresh
          expect(canonicalUpload(posts[1]!)).toEqual(canonicalUpload(posts[0]!));
          await page.emulateMedia({ forcedColors: "active" });
          await form.getByRole("status").focus(); await page.keyboard.press("Tab");
          await expect(retry).toBeFocused();
          const focus = await retry.evaluate((node) => ({ style: getComputedStyle(node).outlineStyle, width: parseFloat(getComputedStyle(node).outlineWidth) }));
          expect(focus.style).not.toBe("none"); expect(focus.width).toBeGreaterThan(0);
          await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
          const motion = await form.evaluate((node) => [node, ...Array.from(node.querySelectorAll("*"))].filter((element) => (element as HTMLElement).getClientRects().length).map((element) => ({ animation: getComputedStyle(element).animationDuration, transition: getComputedStyle(element).transitionDuration })));
          expect(motion.length).toBeGreaterThan(0);
          expect(motion.every((item) => [item.animation, item.transition].every((durations) => durations.split(",").every((duration) => parseFloat(duration) === 0)))).toBe(true);
          await page.setViewportSize({ width: 320, height: 800 });
          expect(await form.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
          await retry.click();
          await expect.poll(() => posts.length).toBe(3);
          expect(canonicalUpload(posts[2]!)).toEqual(canonicalUpload(posts[0]!));
          expect(canonicalUpload(posts[0]!).idempotency).toEqual({ headers: {}, field: null });
          await expect(surface.file(page)).toBeEnabled();
          await expect(surface.summary(page)).toHaveValue("");
          const inventory = await page.request.get(`/api/cases/${caseId}/evidence`);
          expect((await inventory.json() as { artifacts: unknown[] }).artifacts).toHaveLength(1);
        } finally { release.resolve(); }
      });
    });
    test("ordinary 503 remains editable and explicit retry succeeds", async ({ page }) => {
      await withSurface(page, surface, async (caseId) => {
        let posts = 0;
        await page.route(evidenceRoute(caseId), async (route) => {
          if (route.request().method() === "POST" && ++posts === 1) { await route.fulfill({ status: 503, contentType: "application/json", body: ORDINARY_503_BODY }); return; }
          await route.continue();
        });
        await fillUpload(surface, page, syntheticFile, "ordinary retry summary");
        await surface.submit(page).click();
        await expect(page.locator(".evidence-reconciliation").getByRole("alert")).toContainText("No success has been confirmed");
        await expect(surface.file(page)).toBeEnabled(); expect(posts).toBe(1);
        await surface.submit(page).click();
        await expect(surface.summary(page)).toHaveValue(""); expect(posts).toBe(2);
      });
    });
    test("local finish and scope/privacy teardown issue no compensating or obsolete write", async ({ page }) => {
      await withSurface(page, surface, async (caseId) => {
        let posts = 0; let deletes = 0;
        await page.route(evidenceRoute(caseId), async (route) => {
          if (route.request().method() === "POST") { posts++; await route.fulfill({ status: 503, contentType: "application/json", body: UNKNOWN_COMMIT_BODY }); return; }
          if (route.request().method() === "DELETE") deletes++;
          await route.continue();
        });
        await fillUpload(surface, page, syntheticFile, "sensitive synthetic summary");
        await surface.privacy(page).selectOption("owner_only");
        await surface.submit(page).click();
        const form = page.locator(".evidence-reconciliation");
        await expect(form.getByRole("button", { name: "Retry original upload" })).toBeEnabled();
        await form.getByRole("button", { name: "Finish without another write" }).click();
        await expect(surface.file(page)).toBeEnabled(); expect(posts).toBe(1); expect(deletes).toBe(0);
        await fillUpload(surface, page, syntheticFile, "sensitive synthetic summary");
        await surface.privacy(page).selectOption("owner_only"); await surface.submit(page).click();
        await expect(form.getByRole("button", { name: "Retry original upload" })).toBeEnabled();
        const other = await createInvestigation(page, uniqueTitle("Synthetic scope B"));
        await page.goto(`/investigations/${other}/situation`);
        await expect(surface.summary(page)).toHaveValue("");
        await page.goto(`/investigations/${caseId}/situation`);
        await expect(surface.summary(page)).toHaveValue("");
        await expect(form.getByRole("button", { name: "Retry original upload" })).toHaveCount(0);
        const response = await page.request.get("/api/auth/me"); const session = await response.json() as Record<string, unknown>;
        await page.route("**/api/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...session, capabilities: [] }) }));
        const requests: Request[] = [];
        page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/cases")) requests.push(request); });
        await page.goto(`/investigations/${caseId}/situation`);
        await expect(page.getByRole("heading", { name: "Investigation unavailable in this view" })).toBeVisible();
        await expect(page.getByText("sensitive synthetic summary")).toHaveCount(0);
        expect(requests).toHaveLength(0); expect(posts).toBe(2); expect(deletes).toBe(0);
      });
    });
  });
}

test("@joined built client and Runtime through real app/store/installed-SDK response-loss fixture", async ({ page }) => {
  test.skip(!process.env.COLLAB_S3_REPORT_DIR, "Run with s3-joined.playwright.config.ts and a disposable control directory");
  const control = process.env.COLLAB_S3_REPORT_DIR!;
  const readReport = async () => JSON.parse(await readFile(join(control, "report.json"), "utf8")) as { copies: number; pending: number; canonical: number; referenced: number; canonicalDeletes: number };
  const surface = SURFACES[0]!;
  await withSurface(page, surface, async (caseId) => {
    const posts: CapturedUpload[] = [];
    await page.route("**/api/cases/*/evidence{,/stream}", async (route) => { const request = route.request(); if (request.method() === "POST" && evidenceUploadPath(new URL(request.url()).pathname, caseId)) posts.push(captureUpload(request)); await route.continue(); });
    await fillUpload(surface, page, syntheticFile, "joined original summary");
    const response = page.waitForResponse((value) => value.request().method() === "POST" && evidenceUploadPath(new URL(value.url()).pathname, caseId));
    await surface.submit(page).click();
    const unconfirmed = await response;
    expect(unconfirmed.status()).toBe(503); expect(await unconfirmed.json()).toEqual({ error: "commit_outcome_unknown" });
    const form = page.locator(".evidence-reconciliation");
    await expect(form.getByRole("button", { name: "Retry original upload" })).toBeEnabled();
    expect(posts).toHaveLength(1);
    await expect.poll(readReport).toMatchObject({ copies: 1, pending: 1, canonical: 1, referenced: 0, canonicalDeletes: 0 });
    const before = await page.request.get(`/api/cases/${caseId}/evidence`);
    expect((await before.json() as { artifacts: unknown[] }).artifacts).toHaveLength(0);
    await form.getByRole("button", { name: "Refresh inventory" }).click();
    await expect(form.getByRole("button", { name: "Retry original upload" })).toBeEnabled();
    expect(posts).toHaveLength(1);
    await form.getByRole("button", { name: "Retry original upload" }).click();
    await expect(surface.file(page)).toBeEnabled();
    expect(posts).toHaveLength(2); expect(canonicalUpload(posts[1]!)).toEqual(canonicalUpload(posts[0]!));
    const inventory = await (await page.request.get(`/api/cases/${caseId}/evidence`)).json() as { artifacts: Array<{ id: string; contentHash: string }> };
    expect(inventory.artifacts).toHaveLength(1);
    const nonce = uniqueTitle("synthetic-recovery");
    await writeFile(join(control, "recover.next"), nonce, { mode: 0o600 });
    await rename(join(control, "recover.next"), join(control, "recover.request"));
    await expect.poll(async () => { try { return await readFile(join(control, "recover.done"), "utf8"); } catch { return "pending"; } }).toBe(nonce);
    await expect.poll(readReport).toMatchObject({ copies: 1, pending: 0, canonical: 1, referenced: 1, canonicalDeletes: 0 });
    const download = await page.request.get(`/api/cases/${caseId}/evidence/${inventory.artifacts[0]!.id}/content`);
    expect(download.ok(), await download.text()).toBe(true);
    expect(await download.body()).toEqual(syntheticFile.buffer);
  });
});
