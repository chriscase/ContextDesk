import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  fixtureBytes,
  loginAs,
  openCase,
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
    await expect(page.locator(".timeline__item").filter({ hasText: "evidence_registered" })).toHaveCount(3);
    await expect(page.getByText(/shared-timeout\.log/)).toBeVisible();
    await expect(page.getByText(/unique-worker\.log/)).toBeVisible();
    await screenshot(page, "03-evidence-inventory");
  });

  test("snapshot freeze HTTP from unmerged war-room work is not present", async ({ request }) => {
    for (const path of INVENTED_ROUTES.filter((row) => row.includes("snapshot") || row.includes("freeze"))) {
      const res = await request.post(path, { data: {} });
      expect(res.status(), path).toBe(404);
    }
  });

  test("the web shell has no evidence upload control", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, uniqueTitle("No upload widget"));
    await expect(page.getByRole("button", { name: /upload evidence|freeze snapshot/i })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });
});
