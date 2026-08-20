import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  exportPanel,
  fixtureBytes,
  loginAs,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("share-safe export", () => {
  test("case-lead exports a share_safe brief of synthetic evidence", async ({ page }) => {
    const title = uniqueTitle("Export case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Shared synthetic timeout log",
      filename: "shared-timeout.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "shared-timeout.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await page.locator(".case-list").getByRole("button", { name: title, exact: true }).click();
    const panel = exportPanel(page);
    await expect(panel.getByText("artifact · shared-timeout.log · share_safe")).toBeVisible();
    await panel.locator("select").first().selectOption("share_safe");
    await panel.getByRole("button", { name: "Export triage brief" }).click();
    await expect(panel.locator(".export__markdown")).toContainText("Triage brief");
    await expect(panel.locator(".export__error")).toHaveCount(0);
    await screenshot(page, "05-share-safe-brief");
  });

  test("share_safe fails closed on a planted credential", async ({ page }) => {
    const title = uniqueTitle("Scan fail case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    // The composer has no privacy-class control; share_safe scan only sees
    // share_safe-classed bodies, so the planted action is posted to the existing API.
    const planted = await page.request.post(`/api/cases/${caseId}/contributions`, {
      data: {
        kind: "action",
        body: "Rotate AKIAIOSFODNN7EXAMPLE before sharing.",
        privacyClass: "share_safe",
      },
    });
    expect(planted.ok(), await planted.text()).toBeTruthy();
    await page.reload();
    await page.locator(".case-list").getByRole("button", { name: title, exact: true }).click();
    const panel = exportPanel(page);
    await panel.locator("select").first().selectOption("share_safe");
    await panel.getByRole("button", { name: "Export triage brief" }).click();
    await expect(panel.getByText("privacy_scan_failed")).toBeVisible();
    await expect(panel.locator(".export__findings")).toContainText("credential");
    await screenshot(page, "05-share-safe-scan-fail");
  });

  test("contributor cannot select share_safe", async ({ page }) => {
    const title = uniqueTitle("Contributor export");
    await loginAs(page, FIXTURE_USERS.alice);
    await createCase(page, title);
    const option = exportPanel(page).getByRole("option", { name: "share_safe" });
    await expect(option).toHaveAttribute("disabled", "");
  });
});
