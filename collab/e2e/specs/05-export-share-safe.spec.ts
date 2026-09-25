import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  exportPanel,
  fixtureBytes,
  importForm,
  loginAs,
  openCase,
  openCaseSupport,
  openExportSupport,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

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
    await openCase(page, title);
    await openExportSupport(page);
    const panel = exportPanel(page);
    await expect(panel.getByText("artifact · shared-timeout.log · share_safe")).toBeVisible();
    await panel.locator("select").first().selectOption("share_safe");
    await panel.getByRole("button", { name: "Export triage brief" }).click();
    await expect(panel.locator(".export__markdown")).toContainText("Triage brief");
    await expect(panel.locator(".export__error")).toHaveCount(0);
    await screenshot(page, "05-share-safe-brief");
  });

  test("downloads a selected-evidence package and binds its snapshot to an imported response", async ({
    page,
  }) => {
    const title = uniqueTitle("Export round trip");
    const externalResponse = "Synthetic external analysis bound to the downloaded package.";
    const folder = await mkdtemp(join(tmpdir(), "cd-export-round-trip-"));
    try {
      await loginAs(page, FIXTURE_USERS.dave);
      await createCase(page, title);
      const caseId = await caseIdForTitle(page, title);
      await uploadEvidence(page, caseId, {
        kind: "log",
        summary: "Share-safe queue trace",
        filename: "round-trip.log",
        mediaType: "text/plain",
        bytes: fixtureBytes("evidence", "shared-timeout.log"),
        privacyClass: "share_safe",
      });
      await page.reload();
      await openCase(page, title);
      await openExportSupport(page);
      const panel = exportPanel(page);
      await panel.locator("select").first().selectOption("share_safe");
      await panel.getByRole("checkbox", { name: /artifact · round-trip\.log · share_safe/ }).check();
      await panel
        .getByRole("button", { name: "Export selected-evidence prompt package" })
        .click();
      await expect(panel.getByRole("heading", { name: "Export files" })).toBeVisible();

      const jsonButton = panel.getByRole("button", { name: "Download canonical JSON" });
      await jsonButton.focus();
      await expect(jsonButton).toBeFocused();
      const [jsonDownload] = await Promise.all([
        page.waitForEvent("download"),
        page.keyboard.press("Enter"),
      ]);
      expect(jsonDownload.suggestedFilename()).toBe(
        `contextdesk-${caseId}-package-share_safe.json`,
      );
      const jsonPath = join(folder, jsonDownload.suggestedFilename());
      await jsonDownload.saveAs(jsonPath);
      const envelope = JSON.parse(await readFile(jsonPath, "utf8")) as {
        schemaId?: string;
        kind?: string;
        privacyClass?: string;
        markdown?: string;
        payload?: {
          schemaId?: string;
          caseId?: string;
          snapshotIdentity?: string;
          manifest?: {
            caseId?: string;
            variant?: string;
            items?: Array<{ id?: string; privacyClass?: string; contentHash?: string }>;
          };
          excerpts?: Array<{ id?: string; sourceLabel?: string; privacyClass?: string }>;
        };
      };
      expect(envelope.schemaId).toBe("cd-collab.export_envelope.v1");
      expect(envelope.kind).toBe("package");
      expect(envelope.privacyClass).toBe("share_safe");
      expect(envelope.payload?.schemaId).toBe("cd-collab.prompt_package.v1");
      expect(envelope.payload?.caseId).toBe(caseId);
      expect(envelope.payload?.manifest?.caseId).toBe(caseId);
      expect(envelope.payload?.manifest?.variant).toBe("share_safe");
      expect(envelope.payload?.snapshotIdentity).toMatch(/^[0-9a-f]{64}$/);
      expect(envelope.payload?.manifest?.items).toHaveLength(1);
      const selectedItem = envelope.payload?.manifest?.items?.[0];
      expect(selectedItem?.privacyClass).toBe("share_safe");
      expect(selectedItem?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const selectedExcerpt = envelope.payload?.excerpts?.find(
        (item) => item.id === selectedItem?.id,
      );
      expect(selectedExcerpt?.privacyClass).toBe("share_safe");
      expect(selectedExcerpt?.sourceLabel).toBeTruthy();

      const [markdownDownload] = await Promise.all([
        page.waitForEvent("download"),
        panel.getByRole("button", { name: "Download Markdown" }).click(),
      ]);
      expect(markdownDownload.suggestedFilename()).toBe(
        `contextdesk-${caseId}-package-share_safe.md`,
      );
      const markdownPath = join(folder, markdownDownload.suggestedFilename());
      await markdownDownload.saveAs(markdownPath);
      expect(await readFile(markdownPath, "utf8")).toBe(envelope.markdown);
      expect(envelope.markdown).toContain("Selected-evidence prompt package");

      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      await expect(panel.getByRole("button", { name: "Download canonical JSON" })).toBeVisible();

      await openCaseSupport(page);
      const form = importForm(page);
      await form.getByRole("textbox", { name: "External run output" }).fill(externalResponse);
      await form.locator('select[name="sourceId"]').selectOption({ label: SEEDED_SOURCES.chatA });
      await form.getByLabel(/I redacted secrets before save/).check();
      const details = form.locator("details");
      if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
      await form
        .getByRole("combobox", { name: "External run evidence visibility" })
        .selectOption("importer_described");
      await form
        .getByRole("textbox", { name: "Package snapshot identity" })
        .fill(envelope.payload!.snapshotIdentity!);
      const [posted] = await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes("/imports") && response.request().method() === "POST",
        ),
        form.getByRole("button", { name: "Import external run" }).click(),
      ]);
      expect(posted.ok(), await posted.text()).toBeTruthy();
      const imported = page
        .locator('[data-route-kind="imported-run"]')
        .filter({ hasText: externalResponse });
      await expect(imported.getByText("Unverified imported run")).toBeVisible();
      const provenance = imported.locator("details").first();
      if ((await provenance.getAttribute("open")) === null) {
        await provenance.locator("summary").click();
      }
      await expect(imported.getByText(/Snapshot binding:/)).toContainText(
        envelope.payload!.snapshotIdentity!,
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("share_safe fails closed on a planted credential", async ({ page }) => {
    const title = uniqueTitle("Scan fail case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    // The composer has no privacy-class control; share_safe scan only sees
    // share_safe-classed bodies, so the planted action is posted to the existing API.
    const planted = await page.request.post(`/api/cases/${caseId}/contributions`, {
      headers: BROWSER_MUTATION_HEADERS,
      data: {
        kind: "action",
        body: "Rotate AKIAIOSFODNN7EXAMPLE before sharing.",
        privacyClass: "share_safe",
      },
    });
    expect(planted.ok(), await planted.text()).toBeTruthy();
    await page.reload();
    await openCase(page, title);
    await openExportSupport(page);
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
