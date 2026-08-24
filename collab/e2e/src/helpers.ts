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

export type StageName = "Situation" | "Capture" | "Analyze" | "Compare" | "Decide";

function accessSummary(roles: FixtureUser["expectedRoles"]): string {
  const labels = roles.map((role) =>
    role === "case-lead" ? "Case lead" : role[0]?.toUpperCase() + role.slice(1),
  );
  return `Access: ${labels.join(", ") || "None"}`;
}

/**
 * On narrow viewports the primary nav and account menu collapse behind the
 * Menu toggle. Returns a closer so flows leave the shell as they found it.
 */
async function revealTopbar(page: Page): Promise<() => Promise<void>> {
  const toggle = page.getByRole("button", { name: "Menu" });
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
    return async () => {
      await toggle.click();
    };
  }
  return async () => {};
}

/** Switch the focused investigation to one of its work stages. */
export async function gotoStage(page: Page, stage: StageName): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Investigation stages" });
  const link = nav.getByRole("button", { name: new RegExp(`^${stage}`) });
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}

export async function loginAs(page: Page, user: FixtureUser): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "ContextDesk War Room" }).first(),
  ).toBeVisible();

  const signIn = page.getByRole("button", { name: "Sign in" });
  if (!(await signIn.isVisible())) {
    // Already inside the authenticated shell — reuse or replace the session.
    const closeTopbar = await revealTopbar(page);
    const accountTrigger = page.getByRole("button", { name: /^Signed in as / });
    await expect(accountTrigger).toBeVisible();
    const sameUser = page.getByRole("button", { name: `Signed in as ${user.username}` });
    if (await sameUser.isVisible()) {
      await sameUser.click();
      await expect(page.getByText(accessSummary(user.expectedRoles))).toBeVisible();
      await sameUser.click();
      await closeTopbar();
      return;
    }
    await accountTrigger.click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  }

  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Wait for the authenticated shell before probing its (possibly collapsed)
  // top bar, otherwise the reveal check races the post-login render.
  await expect(page.locator("header.topbar")).toBeVisible();
  const closeTopbar = await revealTopbar(page);
  const accountTrigger = page.getByRole("button", { name: `Signed in as ${user.username}` });
  await expect(accountTrigger).toBeVisible();
  await accountTrigger.click();
  await expect(page.getByText(accessSummary(user.expectedRoles))).toBeVisible();
  await accountTrigger.click();
  await closeTopbar();
}

export async function createCase(page: Page, title: string): Promise<void> {
  const field = page.getByPlaceholder("New investigation title");
  if (!(await field.isVisible())) {
    const closeTopbar = await revealTopbar(page);
    await page.getByRole("button", { name: "Start investigation" }).click();
    await closeTopbar();
  }
  await field.fill(title);
  const [created] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith("/api/cases") && res.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create investigation" }).click(),
  ]);
  expect(created.ok(), await created.text()).toBeTruthy();
  await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
  // Land on Analyze — the evidence board and lane runner most flows need next.
  await gotoStage(page, "Analyze");
}

export async function openCase(page: Page, title: string): Promise<void> {
  const current = page.locator("h2.case-view__title").filter({ hasText: title });
  const onCanonicalCaseRoute = /^\/investigations\/[^/]+(?:\/|$)/.test(
    new URL(page.url()).pathname,
  );
  if (onCanonicalCaseRoute) {
    await expect(current).toBeVisible();
  } else if (!(await current.isVisible())) {
    const closeTopbar = await revealTopbar(page);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Investigations", exact: true })
      .click();
    await closeTopbar();
    await page.locator(".case-list").getByRole("button", { name: title, exact: true }).click();
  }
  await expect(current).toBeVisible();
  await gotoStage(page, "Analyze");
}

/** Capture holds the timeline, note composer, and external-run import form. */
export async function openCaseSupport(page: Page): Promise<void> {
  await gotoStage(page, "Capture");
}

export async function openExportSupport(page: Page): Promise<void> {
  await gotoStage(page, "Decide");
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
