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
const WAITING_COPY =
  "The upload result was not confirmed. The evidence inventory is being refreshed; check it before uploading again. This is not confirmation that the file was stored or rolled back.";
const FAILED_REFRESH_COPY =
  "The upload result was not confirmed, and the evidence inventory could not be refreshed. Retry loading the inventory, then check it before uploading again. This is not confirmation that the file was stored or rolled back.";
const READY_COPY =
  "The upload result was not confirmed. The evidence inventory has been refreshed; check it before retrying. This is not confirmation that the file was stored or rolled back.";

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
  readonly file: (page: Page) => ReturnType<Page["getByRole"]> | ReturnType<Page["getByLabel"]>;
  readonly summary: (page: Page) => ReturnType<Page["getByLabel"]> | ReturnType<Page["getByRole"]>;
  readonly kind: (page: Page) => ReturnType<Page["getByLabel"]>;
  readonly privacy: (page: Page) => ReturnType<Page["getByLabel"]>;
  readonly submit: (page: Page) => ReturnType<Page["getByRole"]>;
  readonly inventoryRetry: (page: Page) => ReturnType<Page["getByRole"]>;
  readonly search: (page: Page) => ReturnType<Page["getByRole"]>;
  readonly ordinaryAlert: RegExp;
}

const SURFACES: readonly Surface[] = [
  {
    id: "investigation-first",
    name: "Investigation First",
    file: (page) => page.getByRole("button", { name: "File", exact: true }),
    summary: (page) => page.getByLabel("Annotation"),
    kind: (page) => page.locator(".investigation-first__upload").getByLabel("Kind"),
    privacy: (page) => page.locator(".investigation-first__upload").getByLabel("Privacy"),
    submit: (page) => page.getByRole("button", { name: "Add to evidence inventory" }),
    inventoryRetry: (page) => page.getByRole("button", { name: "Retry evidence inventory" }),
    search: (page) => page.getByRole("searchbox", { name: "Search investigations" }),
    ordinaryAlert: /The evidence could not be loaded right now/u,
  },
  {
    id: "beacon",
    name: "Beacon",
    file: (page) => page.getByLabel(/File \((?:up to|server-configured limit)/u),
    summary: (page) => page.getByRole("textbox", { name: "Why does this matter?" }),
    kind: (page) => page.locator(".beacon__upload").getByLabel("Kind"),
    privacy: (page) => page.locator(".beacon__upload").getByLabel("Privacy"),
    submit: (page) => page.getByRole("button", { name: "Attach evidence" }),
    inventoryRetry: (page) => page
      .locator('section[aria-labelledby="beacon-evidence-title"]')
      .getByRole("button", { name: "Retry" }),
    search: (page) => page.getByRole("searchbox", { name: "Find an investigation" }),
    ordinaryAlert: /The upload could not be completed right now/u,
  },
];

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
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  await expect(surface.submit(page)).toBeEnabled();
  return caseId;
}

test.describe("Investigation evidence upload outcome reconciliation", () => {
  for (const surface of SURFACES) {
    test.describe(surface.name, () => {
      test("gates an unknown upload until a human inventory refresh enables one identical retry", async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1280, height: 900 });
        await loginAs(page, FIXTURE_USERS.dave);
        const previousPolicy = await useFixedStrategy(page, surface.id);
        const title = uniqueTitle(`${surface.name} unknown upload`);
        const summary = `${surface.id} unknown-commit draft`;
        const file = {
          name: `${surface.id}-unknown.log`,
          mimeType: "text/plain",
          buffer: Buffer.from(`${surface.id} unknown commit bytes\n`, "utf8"),
        };
        const posts: CapturedUpload[] = [];
        const refreshStarted = deferred();
        let inventoryReads: "hold-then-fail" | "live" = "hold-then-fail";
        const releaseRefresh = deferred();
        let caseId = "";
        let match: ReturnType<typeof evidenceRoute> | undefined;

        try {
          caseId = await openWriterRecord(page, surface, title);
          match = evidenceRoute(caseId);
          await page.route(match, async (route) => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            if (request.method() === "POST" && evidenceUploadPath(pathname, caseId)) {
              posts.push(captureUpload(request));
              if (posts.length === 1) {
                await route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: UNKNOWN_COMMIT_BODY,
                });
                return;
              }
              await route.continue();
              return;
            }
            if (request.method() === "GET" && evidenceListPath(pathname, caseId)) {
              if (inventoryReads === "hold-then-fail") {
                refreshStarted.resolve();
                await releaseRefresh.promise;
                await route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: ORDINARY_503_BODY,
                });
                return;
              }
            }
            await route.continue();
          });

          await fillUpload(surface, page, file, summary);
          await surface.submit(page).click();
          await refreshStarted.promise;
          await expect(page.getByRole("alert").filter({ hasText: WAITING_COPY })).toBeVisible();
          await expect(page.getByRole("button", { name: "Upload blocked until inventory refresh" }))
            .toBeDisabled();
          await expectDraftPreserved(surface, page, file, summary);
          expect(posts, "a second POST ran while inventory refresh was still loading").toHaveLength(1);
          await submitEvenIfBlocked(page, "Upload blocked until inventory refresh");
          expect(posts).toHaveLength(1);

          releaseRefresh.resolve();
          await expect(page.getByRole("alert").filter({ hasText: FAILED_REFRESH_COPY })).toBeVisible();
          await expect(page.getByRole("button", { name: "Upload blocked until inventory refresh" }))
            .toBeDisabled();
          await expectDraftPreserved(surface, page, file, summary);
          await submitEvenIfBlocked(page, "Upload blocked until inventory refresh");
          expect(posts, "a failed inventory refresh retried the upload").toHaveLength(1);

          inventoryReads = "live";
          await surface.inventoryRetry(page).click();
          const retry = page.getByRole("button", { name: "Retry upload after checking inventory" });
          await expect(page.getByRole("alert").filter({ hasText: READY_COPY })).toBeVisible();
          await expect(retry).toBeEnabled();
          await expectDraftPreserved(surface, page, file, summary);
          expect(posts).toHaveLength(1);

          await retry.click();
          await expect.poll(() => posts.length).toBe(2);
          const first = canonicalUpload(posts[0]!);
          const second = canonicalUpload(posts[1]!);
          expect(second).toEqual(first);
          expect(
            first.idempotency,
            "Nonclaim: this UI evidence upload route has no public idempotency key/header; equality records that absence rather than inventing one.",
          ).toEqual({ headers: {}, field: null });
          expect(first.files.file?.bodyHex).toBe(file.buffer.toString("hex"));
          expect(first.fields.summary).toBe(summary);
          expect(first.fields.kind).toBe("log");
          await expect.poll(async () => selectedFile(surface.file(page))).toEqual(null);
        } finally {
          if (match && !page.isClosed()) await page.unroute(match);
          await restoreStrategyPolicy(page, previousPolicy);
        }
      });

      test("treats an ordinary 503 without the unknown marker as retryable", async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1280, height: 900 });
        await loginAs(page, FIXTURE_USERS.dave);
        const previousPolicy = await useFixedStrategy(page, surface.id);
        const title = uniqueTitle(`${surface.name} ordinary 503`);
        const summary = `${surface.id} ordinary unavailable draft`;
        const file = {
          name: `${surface.id}-ordinary.log`,
          mimeType: "text/plain",
          buffer: Buffer.from(`${surface.id} ordinary 503 bytes\n`, "utf8"),
        };
        const posts: CapturedUpload[] = [];
        let caseId = "";
        let match: ReturnType<typeof evidenceRoute> | undefined;

        try {
          caseId = await openWriterRecord(page, surface, title);
          match = evidenceRoute(caseId);
          await page.route(match, async (route) => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            if (request.method() === "POST" && evidenceUploadPath(pathname, caseId)) {
              posts.push(captureUpload(request));
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: ORDINARY_503_BODY,
              });
              return;
            }
            await route.continue();
          });

          await fillUpload(surface, page, file, summary);
          await surface.submit(page).click();
          await expect.poll(() => posts.length).toBe(1);
          const alert = page.getByRole("alert").filter({ hasText: surface.ordinaryAlert });
          await expect(alert).toBeVisible();
          await expect(alert).not.toContainText(/not confirmed|stored or rolled back/u);
          await expect(page.getByRole("button", { name: /Retry upload|Upload blocked/u })).toHaveCount(0);
          await expect(surface.submit(page)).toBeEnabled();
          await expectDraftPreserved(surface, page, file, summary);

          await surface.submit(page).click();
          await expect.poll(() => posts.length).toBe(2);
          expect(canonicalUpload(posts[1]!)).toEqual(canonicalUpload(posts[0]!));
        } finally {
          if (match && !page.isClosed()) await page.unroute(match);
          await restoreStrategyPolicy(page, previousPolicy);
        }
      });

      test("does not carry an unknown upload draft across identity, case, or no-read transitions", async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1280, height: 900 });
        await loginAs(page, FIXTURE_USERS.dave);
        const previousPolicy = await useFixedStrategy(page, surface.id);
        await loginAs(page, FIXTURE_USERS.erin);
        const titleA = uniqueTitle(`${surface.name} draft case A`);
        const titleB = uniqueTitle(`${surface.name} draft case B`);
        const summary = `${surface.id} must not leave case A`;
        const file = {
          name: `${surface.id}-scope.log`,
          mimeType: "text/plain",
          buffer: Buffer.from(`${surface.id} scoped draft\n`, "utf8"),
        };
        const postsA: CapturedUpload[] = [];
        const postsB: CapturedUpload[] = [];
        let caseA = "";
        let caseB = "";
        let matchA: ReturnType<typeof evidenceRoute> | undefined;
        let matchB: ReturnType<typeof evidenceRoute> | undefined;

        try {
          caseA = await createInvestigation(page, titleA);
          caseB = await createInvestigation(page, titleB);
          await page.goto(`/investigations/${caseA}/situation`);
          await expect(page.getByRole("heading", { level: 2, name: titleA })).toBeVisible();
          await expect(surface.submit(page)).toBeEnabled();

          matchA = evidenceRoute(caseA);
          await page.route(matchA, async (route) => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            if (request.method() === "POST" && evidenceUploadPath(pathname, caseA)) {
              postsA.push(captureUpload(request));
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: UNKNOWN_COMMIT_BODY,
              });
              return;
            }
            await route.continue();
          });

          await fillUpload(surface, page, file, summary);
          await surface.submit(page).click();
          await expect(page.getByRole("button", { name: "Retry upload after checking inventory" }))
            .toBeEnabled();
          expect(postsA).toHaveLength(1);
          await expectDraftPreserved(surface, page, file, summary);

          await loginAs(page, FIXTURE_USERS.dave);
          await page.goto(`/investigations/${caseA}/situation`);
          await expect(page.getByRole("heading", { level: 2, name: titleA })).toBeVisible();
          await expect(page.getByRole("button", { name: /Retry upload|Upload blocked/u })).toHaveCount(0);
          await expect.poll(async () => selectedFile(surface.file(page))).toEqual(null);
          await expect(surface.summary(page)).toHaveValue("");

          await fillUpload(surface, page, file, summary);
          await surface.submit(page).click();
          await expect(page.getByRole("button", { name: "Retry upload after checking inventory" }))
            .toBeEnabled();
          expect(postsA).toHaveLength(2);

          await page.getByRole("button", { name: /Back to investigations/u }).click();
          await surface.search(page).fill(titleB);
          await page.getByRole("button", { name: titleB }).click();
          await expect(page.getByRole("heading", { level: 2, name: titleB })).toBeVisible();
          await expect(page.getByRole("button", { name: /Retry upload|Upload blocked/u })).toHaveCount(0);
          await expect.poll(async () => selectedFile(surface.file(page))).toEqual(null);
          await expect(surface.summary(page)).toHaveValue("");
          await expect(surface.submit(page)).toBeEnabled();
          await surface.submit(page).click();
          expect(postsA, "case B reused case A's unknown upload POST").toHaveLength(2);

          matchB = evidenceRoute(caseB);
          await page.route(matchB, async (route) => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            if (request.method() === "POST" && evidenceUploadPath(pathname, caseB)) {
              postsB.push(captureUpload(request));
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: UNKNOWN_COMMIT_BODY,
              });
              return;
            }
            await route.continue();
          });
          await fillUpload(surface, page, file, summary);
          await surface.submit(page).click();
          await expect(page.getByRole("button", { name: "Retry upload after checking inventory" }))
            .toBeEnabled();
          expect(postsB).toHaveLength(1);

          const authenticated = await page.request.get("/api/auth/me");
          expect(authenticated.ok(), await authenticated.text()).toBeTruthy();
          const session = await authenticated.json() as Record<string, unknown>;
          await page.route("**/api/auth/me", async (route) => {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ...session, capabilities: [] }),
            });
          });
          const caseReads: string[] = [];
          const caseWrites: string[] = [];
          const record = (request: Request) => {
            const pathname = new URL(request.url()).pathname;
            if (pathname !== "/api/cases" && !pathname.startsWith("/api/cases/")) return;
            if (request.method() === "GET") caseReads.push(pathname);
            if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
              caseWrites.push(`${request.method()} ${pathname}`);
            }
          };
          page.on("request", record);
          await page.goto(`/investigations/${caseA}/situation`);
          await expect(page.getByRole("heading", { name: "Investigation unavailable in this view" }))
            .toBeVisible();
          await expect(page.getByText(/no (?:investigation|record) data was requested/iu)).toBeVisible();
          await expect(page.getByRole("button", { name: /Retry upload|Upload blocked/u })).toHaveCount(0);
          await expect(page.getByText(summary)).toHaveCount(0);
          await expect(page.getByText(file.name)).toHaveCount(0);
          expect(caseReads, "the no-read projection requested case data").toEqual([]);
          expect(caseWrites, "the no-read projection attempted a case write").toEqual([]);
          page.off("request", record);
        } finally {
          await page.unroute("**/api/auth/me");
          if (matchB && !page.isClosed()) await page.unroute(matchB);
          if (matchA && !page.isClosed()) await page.unroute(matchA);
          await restoreStrategyPolicy(page, previousPolicy);
        }
      });
    });
  }
});
