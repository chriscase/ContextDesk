import { expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseIdForTitle,
  createCase,
  exportPanel,
  fixtureBytes,
  loginAs,
  openCase,
  openExportSupport,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("portable investigation apply", () => {
  test("dry-run, typed restore, deep link, and reload keep the imported investigation", async ({
    page,
  }) => {
    const title = uniqueTitle("Portable apply");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic portable apply log",
      filename: "synthetic-apply.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "shared-timeout.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    await openExportSupport(page);
    const panel = exportPanel(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "Download portable investigation archive" }).click(),
    ]);
    const folder = await mkdtemp(join(tmpdir(), "cd-portable-apply-"));
    const archivePath = join(folder, download.suggestedFilename());
    await download.saveAs(archivePath);

    await panel.locator("#portable-archive-file").setInputFiles(archivePath);
    await expect(panel.getByText(/historical (person|people)/)).toBeVisible();
    await panel.getByRole("button", { name: "Run dry-run check" }).click();
    await expect(panel.getByText(/can be reconstructed and the archive can be restored/)).toBeVisible();
    await panel.getByLabel("Typed confirmation").fill("RESTORE");
    await panel.getByRole("button", { name: "Restore investigation" }).click();
    const restored = panel.getByRole("link", { name: "Open restored investigation" });
    await expect(restored).toBeVisible();
    const href = await restored.getAttribute("href");
    expect(href).toMatch(/^\/investigations\/[0-9a-f-]{36}\/situation$/);
    await restored.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
    await screenshot(page, "14-portable-apply-restored");
  });
});
