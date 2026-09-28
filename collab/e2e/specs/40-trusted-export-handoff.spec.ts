import { expect, test } from "@playwright/test";
import { parseExportEnvelope } from "@cd-collab/contracts/export";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseIdForTitle, createCase, exportPanel, fixtureBytes, importForm, loginAs, openCase, openCaseSupport, openExportSupport, uploadEvidence, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

test.describe("trusted export and external-response handoff", () => {
  test("real checked downloads bind a synthetic external response without verification", async ({
    page,
  }) => {
    const title = uniqueTitle("Export round trip");
    const externalResponse = "Synthetic external analysis bound to the downloaded package.";
    const folder = await mkdtemp(join(tmpdir(), "cd-export-round-trip-"));
    try {
      await loginAs(page, FIXTURE_USERS.dave);
      await createCase(page, title);
      const caseId = await caseIdForTitle(page, title);
      const selectedEvidence = await uploadEvidence(page, caseId, {
        kind: "log",
        summary: "Share-safe queue trace",
        filename: "round-trip.log",
        mediaType: "text/plain",
        bytes: fixtureBytes("evidence", "shared-timeout.log"),
        privacyClass: "share_safe",
      });
      const privateEvidence = await uploadEvidence(page, caseId, {
        kind: "log",
        summary: "Private fixture trace omitted from handoff",
        filename: "private-trace.log",
        mediaType: "text/plain",
        bytes: fixtureBytes("evidence", "shared-timeout.log"),
        privacyClass: "owner_only",
      });
      await page.reload();
      await openCase(page, title);
      await openExportSupport(page);
      const panel = exportPanel(page);
      await panel.locator("select").first().selectOption("share_safe");
      await expect(panel.getByRole("checkbox", { name: /private-trace\.log · owner_only/ })).not.toBeChecked();
      const selectedBox = panel.getByRole("checkbox", { name: /artifact · round-trip\.log · share_safe/ });
      await selectedBox.focus();
      await page.keyboard.press("Space");
      await expect(selectedBox).toBeChecked();
      const prepare = panel.getByRole("button", { name: "Export selected-evidence prompt package" });
      await prepare.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("heading", { name: "Export files" })).toBeVisible();

      const jsonButton = panel.getByRole("button", { name: "Download JSON" });
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
      const rawEnvelope = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
      const checkedEnvelope = parseExportEnvelope(rawEnvelope);
      expect(checkedEnvelope).toEqual(rawEnvelope);
      const envelope = checkedEnvelope as typeof checkedEnvelope & {
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
      expect((await readFile(jsonPath, "utf8"))).not.toContain("private-trace.log");
      const selectedItem = envelope.payload?.manifest?.items?.[0];
      expect(selectedItem?.id).toBe(selectedEvidence.id);
      expect(selectedItem?.id).not.toBe(privateEvidence.id);
      expect(selectedItem?.privacyClass).toBe("share_safe");
      expect(selectedItem?.contentHash).toBe(selectedEvidence.contentHash);
      expect(selectedItem?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const selectedExcerpt = envelope.payload?.excerpts?.find(
        (item) => item.id === selectedItem?.id,
      );
      expect(envelope.payload?.excerpts?.some((item) => item.id === privateEvidence.id)).toBe(false);
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
      await page.setViewportSize({ width: 320, height: 780 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      await expect(panel.getByRole("button", { name: "Download JSON" })).toBeVisible();

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
      await page.reload();
      await openCase(page, title);
      await openCaseSupport(page);
      const reopened = page.locator('[data-route-kind="imported-run"]').filter({ hasText: externalResponse });
      await expect(reopened.getByText("Unverified imported run")).toBeVisible();
      const reopenedDetails = reopened.locator("details").first();
      if ((await reopenedDetails.getAttribute("open")) === null) await reopenedDetails.locator("summary").click();
      await expect(reopened.getByText(/Snapshot binding:/)).toContainText(envelope.payload!.snapshotIdentity!);
      await expect(reopened.getByText(/described by the importer/)).toBeVisible();

      await openExportSupport(page);
      await panel.locator("select").first().selectOption("share_safe");
      await panel.getByRole("button", { name: "Export triage brief" }).click();
      await expect(panel.getByText(/Triage brief prepared/)).toBeVisible();
      const [briefDownload] = await Promise.all([
        page.waitForEvent("download"), panel.getByRole("button", { name: "Download JSON" }).click(),
      ]);
      const briefPath = join(folder, briefDownload.suggestedFilename());
      await briefDownload.saveAs(briefPath);
      const checkedBrief = parseExportEnvelope(JSON.parse(await readFile(briefPath, "utf8")) as unknown);
      expect(checkedBrief.kind).toBe("brief");
      expect(checkedBrief.privacyClass).toBe("share_safe");
      expect((checkedBrief.payload as { header: { caseId: string } }).header.caseId).toBe(caseId);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("HTTP-injected malformed, empty and raw-error responses cannot become files", async ({ page }) => {
    const title = uniqueTitle("Export HTTP faults");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await openExportSupport(page);
    const panel = exportPanel(page);
    let intercepted = 0;
    let downloads = 0;
    page.on("download", () => { downloads += 1; });
    await page.route("**/api/cases/*/export/brief", async (route) => {
      intercepted += 1;
      if (intercepted === 1) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          schemaId: "cd-collab.export_envelope.v1", kind: "brief", privacyClass: "owner_only",
          exportedAt: "2026-09-09T12:00:00.000Z", markdown: "synthetic",
          payload: { schemaId: "cd-collab.brief.v1", privacyClass: "owner_only",
            header: { caseId: "wrong-case" }, timeline: [{ rawPrivate: "synthetic" }] },
        }) });
      } else if (intercepted === 2) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "" });
      } else {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "synthetic-private-token-must-not-render" }) });
      }
    });
    const prepare = panel.getByRole("button", { name: "Export triage brief" });
    for (const attempt of [1, 2, 3]) {
      await prepare.focus();
      await page.keyboard.press("Enter");
      await expect(panel.locator(".export__error")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Download JSON" })).toHaveCount(0);
      expect(downloads).toBe(0);
      expect(await panel.textContent()).not.toContain("synthetic-private-token-must-not-render");
      expect(intercepted).toBe(attempt);
    }
    await page.unroute("**/api/cases/*/export/brief");
    await prepare.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: "Download JSON" })).toBeVisible();
    expect(downloads).toBe(0);
  });
});
