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
  await expect(page.getByRole("heading", { name: "cd-collab" })).toBeVisible();
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
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(title) })).toBeVisible();
}

export async function openCase(page: Page, title: string): Promise<void> {
  await page.locator(".case-list").getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("heading", { name: new RegExp(title) })).toBeVisible();
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
  return page.locator("form.composer").filter({
    has: page.getByRole("button", { name: "Import external run" }),
  });
}

export function noteForm(page: Page): Locator {
  return page.locator("form.composer").filter({
    has: page.getByRole("button", { name: "Add to timeline" }),
  });
}

export function exportPanel(page: Page): Locator {
  return page.locator("section.export");
}

export async function addTimelineEntry(
  page: Page,
  kind: "message" | "note" | "hypothesis" | "action",
  body: string,
): Promise<void> {
  const form = noteForm(page);
  const before = await page.locator(".timeline__item").count();
  await form.locator('select[name="kind"]').selectOption(kind);
  await form.locator('textarea[name="body"]').fill(body);
  await form.getByRole("button", { name: "Add to timeline" }).click();
  // The shipped timeline renders payload JSON (kind/hash), not contribution body.
  await expect(page.locator(".timeline__item")).toHaveCount(before + 1);
  await expect(
    page.locator(".timeline__item").filter({ hasText: "contribution_created" }).last(),
  ).toContainText(`"kind":"${kind}"`);
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
  const form = importForm(page);
  await form.getByPlaceholder("Output").fill(opts.output);
  if (opts.prompt) {
    await form.getByPlaceholder("Prompt (optional)").fill(opts.prompt);
  }
  await form.locator('select[name="sourceId"]').selectOption({
    label: `${opts.sourceLabel} (external-tool)`,
  });
  await form.getByPlaceholder("Operator username").fill(opts.operatorUsername);
  await form.getByPlaceholder("Operator identity").fill(opts.operatorId);
  await form.locator('select[name="evidenceVisibility"]').selectOption(opts.visibility ?? "unknown");
  await form.getByLabel(/I redacted secrets before save/).check();
  await form.getByRole("button", { name: "Import external run" }).click();
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
