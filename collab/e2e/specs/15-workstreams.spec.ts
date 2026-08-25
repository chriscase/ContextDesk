import { expect, test, type Page } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  fixtureBytes,
  gotoStage,
  loginAs,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

/**
 * A triage engineer opens a shared workstream link and has to understand the
 * work without decoding identifiers or scrolling one opaque page. Everything
 * asserted here is synthetic fixture data created by the test itself.
 */

const TRACE = fixtureBytes("evidence", "checkout-timeout-trace.log").toString("utf8");

async function frozenRunFor(page: Page, title: string): Promise<string> {
  await createCase(page, title);
  const caseId = await caseIdForTitle(page, title);
  await uploadEvidence(page, caseId, {
    kind: "log",
    summary: "Synthetic checkout timeout log with the failing stack trace.",
    filename: "checkout-timeout-trace.log",
    mediaType: "text/plain",
    bytes: fixtureBytes("evidence", "checkout-timeout-trace.log"),
    privacyClass: "share_safe",
  });
  // The evidence board mounted with this investigation before the API upload;
  // reload so the shipped surface reads the registered evidence.
  await page.reload();
  await gotoStage(page, "Analyze");
  const include = page.getByRole("checkbox", {
    name: "Include checkout-timeout-trace.log in snapshot",
  });
  await expect(include).toBeVisible();
  await include.check();
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
    ),
    page.getByRole("button", { name: "Freeze selected evidence (1)" }).click(),
  ]);
  await page.getByRole("button", { name: "Run synthetic comparison" }).click();
  await expect(page.locator(".triage-runs__status--completed").first()).toBeVisible({
    timeout: 30_000,
  });
  return caseId;
}

test.describe("workstreams read like investigative work", () => {
  test("opens a shared workstream address, survives reload and history, and reads as human work", async ({
    page,
  }) => {
    const title = uniqueTitle("Workstream journey");
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await frozenRunFor(page, title);

    // ————— The list reads as investigative work, not a model dashboard —————
    const workstreams = page.locator(".workstreams").first();
    await expect(workstreams.getByRole("heading", { name: "Workstreams" })).toBeVisible();
    await expect(workstreams.getByText(/^Asked:/)).toBeVisible();
    await expect(workstreams.getByText(/requested by dave/)).toBeVisible();
    await expect(workstreams.getByText(/Frozen evidence set 1 · 1 evidence item/)).toBeVisible();

    const firstWorkstream = workstreams.getByRole("link", { name: /workstream — / }).first();
    const workstreamName = (await firstWorkstream.textContent())!.trim();
    const href = await firstWorkstream.getAttribute("href");
    expect(href).toContain(`/investigations/${caseId}/analyze`);
    expect(href).toContain("section=workstreams");
    expect(href).toContain("lane=");

    // ————— Opening one is a real navigation to a focused record —————
    await firstWorkstream.click();
    await expect(page).toHaveURL(/section=workstreams/);
    await expect(page).toHaveURL(/lane=/);
    const detail = page.locator(".workstreams__detail");
    await expect(detail.getByRole("heading", { name: workstreamName })).toBeVisible();
    // The rest of Analyze steps aside instead of staying mixed together.
    await expect(page.getByRole("heading", { name: "Evidence and snapshots" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Run history" })).toBeHidden();

    // ————— What a reader needs, in human words —————
    await expect(detail.getByText(/^Asked to find out:/)).toBeVisible();
    await expect(detail.getByText("Performed by")).toBeVisible();
    await expect(detail.getByText("Requested by")).toBeVisible();
    await expect(detail.getByText("dave", { exact: true })).toBeVisible();
    await expect(
      detail.getByText("Ran against the exact frozen evidence set, proven by the host."),
    ).toBeVisible();
    await expect(detail.getByRole("heading", { name: "What it reported" })).toBeVisible();
    await expect(detail.getByRole("heading", { name: /^Evidence it cited/ })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "What it left unknown" })).toBeVisible();
    await expect(detail.getByText("Agreement is not proof of correctness.")).toBeVisible();

    // ————— Chronological history with real timestamps and actors —————
    const activity = detail.locator(".workstreams__activity > li");
    await expect(activity.first()).toContainText("Run queued");
    await expect(activity.first()).toContainText("dave");
    expect(await activity.count()).toBeGreaterThanOrEqual(2);
    const stamps = await detail.locator(".workstreams__activity time").allTextContents();
    expect(stamps.length).toBeGreaterThanOrEqual(2);

    // ————— Familiar evidence: filename, context, and a long expandable trace —————
    const evidence = detail.locator(".workstreams__evidence-item").first();
    await expect(evidence.getByRole("heading", { name: "checkout-timeout-trace.log" })).toBeVisible();
    await expect(evidence).toContainText("in the frozen evidence set");
    await expect(evidence).toContainText(
      "Synthetic checkout timeout log with the failing stack trace.",
    );
    const preview = evidence.locator(".experiment-lab__artifact-preview");
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText("InventoryClient.fetch");
    const disclosure = evidence.locator("details").first();
    await expect(disclosure.locator("summary")).toHaveAttribute(
      "aria-label",
      /checkout-timeout-trace\.log/,
    );
    // Keyboard-reachable: focus the summary and open it with the keyboard.
    await disclosure.locator("summary").focus();
    await page.keyboard.press("Enter");
    const full = evidence.locator(".experiment-lab__artifact-full");
    await expect(full).toBeVisible();
    await expect(full).toContainText("TimeoutError: synthetic inventory lookup exceeded 30000ms");
    await expect(full).toContainText("at InventoryClient.fetch (fixtures/inventory-client.ts:118:15)");
    expect((await full.innerText()).trim()).toBe(TRACE.trim());
    await expect(
      evidence.getByRole("button", { name: "Copy checkout-timeout-trace.log text" }),
    ).toBeVisible();

    // ————— Identifiers stay behind Technical details —————
    const technical = detail.locator("details.workstreams__technical");
    expect(await technical.evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);
    const readingView = await detail.locator(".workstreams__facts").innerText();
    expect(readingView).not.toMatch(/[0-9a-f]{64}/);
    await technical.locator("summary").click();
    await expect(technical).toContainText("Snapshot fingerprint");
    await expect(technical.locator("code").first()).toBeVisible();
    expect(await technical.innerText()).toMatch(/[0-9a-f]{64}/);

    // ————— A shared link reloads onto the same workstream —————
    const sharedUrl = page.url();
    await page.reload();
    await expect(page.locator(".workstreams__detail").getByRole("heading", { name: workstreamName })).toBeVisible();
    expect(page.url()).toBe(sharedUrl);

    // ————— Back and Forward keep the context —————
    await page.getByRole("link", { name: "All workstreams" }).click();
    await expect(page.locator(".workstreams").first().getByRole("heading", { name: "Workstreams" })).toBeVisible();
    await expect(page).not.toHaveURL(/lane=/);
    await page.goBack();
    await expect(page).toHaveURL(/lane=/);
    await expect(page.locator(".workstreams__detail").getByRole("heading", { name: workstreamName })).toBeVisible();
    await page.goForward();
    await expect(page).not.toHaveURL(/lane=/);
    await expect(page.getByRole("heading", { name: "Evidence and snapshots" })).toBeVisible();
  });

  test("a workstream address this investigation does not have fails closed", async ({ page }) => {
    const title = uniqueTitle("Workstream miss");
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await frozenRunFor(page, title);

    await page.goto(
      `/investigations/${caseId}/analyze?section=workstreams&item=run-nope%3Alane-nope&kind=workstream&lane=run-nope%3Alane-nope#workstreams`,
    );
    await expect(
      page.getByText(/That workstream is not part of this investigation/),
    ).toBeVisible();
    // It stays on the investigation instead of collapsing to the list of all.
    await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
    await page.getByRole("link", { name: "Back to all workstreams" }).click();
    await expect(page.locator(".workstreams").first().getByRole("heading", { name: "Workstreams" })).toBeVisible();
  });

  test("stays readable and reachable on a narrow viewport", async ({ page }) => {
    const title = uniqueTitle("Workstream narrow");
    await loginAs(page, FIXTURE_USERS.dave);
    await frozenRunFor(page, title);

    await page.setViewportSize({ width: 390, height: 844 });
    const workstreams = page.locator(".workstreams").first();
    await workstreams.getByRole("link", { name: /workstream — / }).first().click();
    const detail = page.locator(".workstreams__detail");
    await expect(detail.getByRole("heading", { name: /workstream — / })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "What happened, in order" })).toBeVisible();
    // No horizontal overflow of the page itself on a phone-width viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
