import { expect, test } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  fixtureBytes,
  loginAs,
  openCase,
  openCaseSupport,
  screenshot,
  timeline,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { INVENTED_ROUTES } from "../src/surface-map.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("synthetic evidence upload and content-addressed freeze", () => {
  test("API upload appears on the timeline and export inventory after reload", async ({ page }) => {
    const title = uniqueTitle("Evidence case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    const shared = await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Shared synthetic timeout log",
      filename: "shared-timeout.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "shared-timeout.log"),
      privacyClass: "share_safe",
    });
    const unique = await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Unique worker log",
      filename: "unique-worker.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "unique-worker.log"),
      privacyClass: "owner_only",
    });
    expect(shared.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unique.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(shared.contentHash).not.toBe(unique.contentHash);

    const events = await timeline(page, caseId);
    expect(events.filter((ev) => ev.kind === "evidence_registered")).toHaveLength(2);

    const again = await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Shared synthetic timeout log (replay)",
      filename: "shared-timeout.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "shared-timeout.log"),
      privacyClass: "share_safe",
    });
    expect(again.contentHash).toBe(shared.contentHash);

    await page.reload();
    await openCase(page, title);
    await openCaseSupport(page);
    expect(await page.locator(".timeline__item").count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByText("artifact · shared-timeout.log · share_safe")).toHaveCount(2);
    await expect(page.getByText("artifact · unique-worker.log · owner_only")).toHaveCount(1);
    await screenshot(page, "03-evidence-inventory");
  });

  test("snapshot freeze is available through the war-room board", async ({ page }) => {
    const title = uniqueTitle("Snapshot case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await expect(page.getByRole("heading", { name: "Evidence and snapshots" })).toBeVisible();

    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Shared synthetic timeout log",
      filename: "shared-timeout.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "shared-timeout.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    const include = page.getByRole("checkbox", { name: "Include shared-timeout.log in snapshot" });
    await expect(include).toBeVisible();
    await include.check();
    await page.getByRole("button", { name: "Freeze selected evidence (1)" }).click();
    await expect(page.getByText(/1 items ·/)).toBeVisible();
    await expect(page.getByText(/Runs bound to a snapshot never silently widen/)).toBeVisible();
  });

  test("unscoped snapshot routes remain absent", async ({ request }) => {
    for (const path of INVENTED_ROUTES.filter((row) => row === "/api/snapshots" || row.includes("/freeze"))) {
      const res = await request.post(path, {
        headers: BROWSER_MUTATION_HEADERS,
        data: {},
      });
      expect(res.status(), path).toBe(404);
    }
  });

  test("the war-room exposes an evidence upload control", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, uniqueTitle("Upload widget"));
    await expect(page.getByRole("heading", { name: "Upload evidence" })).toBeVisible();
    await expect(page.locator("#case-evidence-file")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Upload evidence" })).toBeVisible();
  });

  test("uploads evidence through the war-room form and renders its privacy class", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, uniqueTitle("UI evidence upload"));
    const file = page.locator("#case-evidence-file");
    await file.setInputFiles({
      name: "ui-upload.log",
      mimeType: "text/plain",
      buffer: fixtureBytes("evidence", "shared-timeout.log"),
    });
    await page.locator(".case-memory__upload-form").getByLabel("Summary").fill("Uploaded through the war-room form");
    await page.locator(".case-memory__upload-form").getByLabel("Artifact kind").selectOption("log");
    await page.locator(".case-memory__upload-form").getByLabel("Privacy class").selectOption("share_safe");
    const [posted] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/cases/") && res.url().endsWith("/evidence/stream") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Upload evidence" }).click(),
    ]);
    expect(posted.ok(), await posted.text()).toBeTruthy();
    // Scoped to the evidence board: Analyze now also lists an uploaded log in
    // the Log workbench beside it, so a page-wide match is ambiguous by design.
    await expect(
      page.getByLabel("Evidence and snapshots").getByText("ui-upload.log", { exact: true }),
    ).toBeVisible();
    // The privacy class leads; the digest does not. A truncated hash cannot be
    // matched against another system, so it is not what the card opens with.
    await expect(page.getByText("share_safe", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/hash [0-9a-f]{12}…/)).toHaveCount(0);
    // The exact value is still there, in full, one disclosure away. A closed
    // disclosure is out of the accessibility tree, so it is opened rather than
    // asserted through — which also proves the disclosure itself works.
    const identifiers = page.locator("details.technical-id").filter({
      has: page.locator('button[aria-label="Copy content hash for ui-upload.log"]'),
    });
    await expect(identifiers).toBeAttached();
    await identifiers.locator("summary").click();
    await expect(
      identifiers.getByRole("button", { name: "Copy content hash for ui-upload.log" }),
    ).toBeVisible();
    // Complete, never truncated.
    await expect(identifiers.locator("code.technical-id__value").first()).toHaveText(/^[0-9a-f]{64}$/);
  });
});
