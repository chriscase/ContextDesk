import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureUser } from "./users.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = join(here, "..", "fixtures");

export function uniqueTitle(prefix: string): string {
  return `${prefix} ${randomUUID()}`;
}

export function fixtureText(...parts: string[]): string {
  return readFileSync(join(FIXTURE_ROOT, ...parts), "utf8");
}

export function fixtureBytes(...parts: string[]): Buffer {
  return readFileSync(join(FIXTURE_ROOT, ...parts));
}

export async function loginAs(page: Page, user: FixtureUser): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ContextDesk Experiment Lab" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign (in|out)/ })).toBeVisible();
  const signOut = page.getByRole("button", { name: "Sign out" });
  if (await signOut.isVisible()) {
    const already = page.getByText(new RegExp(`Signed in as\\s+${user.username}`));
    if (await already.isVisible()) {
      await expect(page.getByText(new RegExp(`Roles:\\s+${user.expectedRoles.join(", ")}`))).toBeVisible();
      return;
    }
    await signOut.click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  }
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(new RegExp(`Signed in as\\s+${user.username}`))).toBeVisible();
  await expect(page.getByText(new RegExp(`Roles:\\s+${user.expectedRoles.join(", ")}`))).toBeVisible();
}

export async function createCase(page: Page, title: string): Promise<void> {
  await page.getByPlaceholder("New case title").fill(title);
  const [created] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith("/api/cases") && res.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create case" }).click(),
  ]);
  expect(created.ok(), await created.text()).toBeTruthy();
  await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
}

export async function openCase(page: Page, title: string): Promise<void> {
  await page.locator(".case-list").getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
}

export async function openCaseSupport(page: Page): Promise<void> {
  const support = page.locator("details.case-view__support").first();
  if ((await support.getAttribute("open")) === null) {
    await support.locator("summary").click();
  }
  await expect(support).toHaveAttribute("open", "");
}

export async function openExportSupport(page: Page): Promise<void> {
  const support = page.locator("details.case-view__support").last();
  if ((await support.getAttribute("open")) === null) {
    await support.locator("summary").click();
  }
  await expect(support).toHaveAttribute("open", "");
}

interface CaseRow {
  id: string;
  title: string;
  status: string;
  severity: string;
}

export async function caseIdForTitle(page: Page, title: string): Promise<string> {
  const res = await page.request.get("/api/cases");
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { cases?: CaseRow[] };
  const row = (body.cases ?? []).find((item) => item.title === title);
  expect(row, `missing case titled ${title}`).toBeTruthy();
  return row!.id;
}

interface TimelineEvent {
  seq: number;
  kind: string;
  actorUsername: string;
  targetId: string | null;
  payload: string;
}

export async function timeline(page: Page, caseId: string): Promise<TimelineEvent[]> {
  const res = await page.request.get(`/api/cases/${caseId}/timeline`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { events?: TimelineEvent[] };
  return body.events ?? [];
}

export function importForm(page: Page): Locator {
  return page.locator("article.case-view form.composer").filter({
    has: page.locator('button[type="submit"]', { hasText: "Import external run" }),
  });
}

export function noteForm(page: Page): Locator {
  return page.locator("article.case-view form.composer").filter({
    has: page.locator('button[type="submit"]', { hasText: "Add to timeline" }),
  });
}

export function exportPanel(page: Page): Locator {
  return page.locator("article.case-view section.export");
}

export async function addTimelineEntry(
  page: Page,
  kind: "message" | "note" | "hypothesis" | "action",
  body: string,
): Promise<void> {
  await openCaseSupport(page);
  const form = noteForm(page);
  await form.locator('select[name="kind"]').selectOption(kind);
  await form.locator('textarea[name="body"]').fill(body);
  const [posted] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/contributions") && res.request().method() === "POST",
    ),
    form.getByRole("button", { name: "Add to timeline" }).click(),
  ]);
  expect(posted.ok(), await posted.text()).toBeTruthy();
  await expect(
    page.locator("article.case-view .timeline__item").filter({ hasText: "contribution_created" }).last(),
  ).toContainText(`Current ${kind}`);
}

export async function importChat(
  page: Page,
  opts: {
    output: string;
    prompt?: string;
    sourceLabel: string;
    operatorUsername: string;
    operatorId: string;
    visibility?: "unknown" | "importer_described";
  },
): Promise<void> {
  await openCaseSupport(page);
  const form = importForm(page);
  await form.getByRole("textbox", { name: "External run output" }).fill(opts.output);
  if (opts.prompt) {
    await form.getByRole("textbox", { name: "External run prompt (optional)" }).fill(opts.prompt);
  }
  await form.locator('select[name="sourceId"]').selectOption({
    label: `${opts.sourceLabel} (external-tool)`,
  });
  await form.getByRole("textbox", { name: "Operator username" }).fill(opts.operatorUsername);
  await form.getByRole("textbox", { name: "Operator identity" }).fill(opts.operatorId);
  if (opts.visibility) {
    const provenance = form.locator("details").filter({
      has: page.locator("summary", { hasText: "Provenance details (visibility, snapshot)" }),
    });
    if ((await provenance.getAttribute("open")) === null) {
      await provenance.locator("summary").click();
    }
    await expect(provenance).toHaveAttribute("open", "");
    await form
      .getByRole("combobox", { name: "External run evidence visibility" })
      .selectOption(opts.visibility);
  }
  await form.getByLabel(/I redacted secrets before save/).check();
  const [posted] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/imports") && res.request().method() === "POST",
    ),
    form.getByRole("button", { name: "Import external run" }).click(),
  ]);
  expect(posted.ok(), await posted.text()).toBeTruthy();
  await expect(page.getByText("Unverified imported run").first()).toBeVisible();
  await expect(page.locator(".imported-run").filter({ hasText: opts.output.slice(0, 40) })).toBeVisible();
}

export async function uploadEvidence(
  page: Page,
  caseId: string,
  opts: {
    kind: "log" | "email" | "attachment";
    summary: string;
    filename: string;
    mediaType: string;
    bytes: Buffer;
    privacyClass: "owner_only" | "share_safe";
  },
): Promise<{ id: string; contentHash: string | null }> {
  const res = await page.request.post(`/api/cases/${caseId}/evidence`, {
    data: {
      kind: opts.kind,
      summary: opts.summary,
      filename: opts.filename,
      mediaType: opts.mediaType,
      contentBase64: opts.bytes.toString("base64"),
      privacyClass: opts.privacyClass,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as {
    artifact?: { id: string; contentHash: string | null };
  };
  expect(body.artifact?.id).toBeTruthy();
  return { id: body.artifact!.id, contentHash: body.artifact?.contentHash ?? null };
}

export async function screenshot(page: Page, name: string): Promise<void> {
  const dir = join(here, "..", "test-results", "qualification");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
