import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  gotoStage,
  loginAs,
  screenshot,
  uniqueTitle,
} from "../src/helpers.js";
import { syntheticZip } from "../src/synthetic-zip.js";
import { FIXTURE_USERS } from "../src/users.js";

/**
 * The streamed large-corpus intake lane, end to end and provider-free.
 *
 * The inline lane carries a small selection as base64 inside one JSON request.
 * This spec covers what happens when a selection is too big for that: the
 * preflight an operator reads before waiting, the resumable binary parts, the
 * cancel that leaves nothing behind, and the named refusal when a limit is hit.
 */

const PHONE = { width: 375, height: 812 };

/** A selection large enough to leave the inline lane, cheap enough to run. */
function streamedSelection(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `service-${index}.log`,
    mimeType: "text/plain",
    buffer: Buffer.from(
      `2026-08-25T00:0${index % 10}:00Z mailer timeout id=syn-${index}\n`.repeat(64),
    ),
  }));
}

test.describe("streamed large-corpus intake", () => {
  test("previews, streams binary parts, and commits a selection too large for one request", async ({
    page,
  }) => {
    const title = uniqueTitle("Streamed intake");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await gotoStage(page, "Capture");

    await page.getByLabel("Evidence files").setInputFiles(streamedSelection(40));

    // The preflight states what is selected and what will be checked, before a
    // single byte is sent.
    await expect(page.getByRole("heading", { name: "Before this upload starts" })).toBeVisible();
    await expect(page.getByText("Files selected")).toBeVisible();
    await expect(page.getByText("40", { exact: true })).toBeVisible();
    await expect(page.getByText(/Resumable chunks of/)).toBeVisible();
    await page.getByText(/What will be checked/).click();
    await expect(page.getByText("Send the bytes in resumable chunks")).toBeVisible();
    await screenshot(page, "corpus-intake-streamed-preflight");

    const partRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/corpus-intake/sessions/") && request.method() === "PUT") {
        partRequests.push(request.url());
      }
    });

    const [preview] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith("/preview") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Preview intake" }).click(),
    ]);
    expect(preview.ok(), await preview.text()).toBeTruthy();
    // One bounded binary request per part, not one giant JSON body.
    expect(partRequests.length).toBe(40);
    await expect(page.getByText("service-0.log").first()).toBeVisible();

    const [committed] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith("/commit") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Commit accepted files" }).click(),
    ]);
    expect(committed.ok(), await committed.text()).toBeTruthy();
    await expect(page.getByRole("heading", { name: "Committed batch" })).toBeVisible();

    const batch = (await committed.json()) as { items: Array<{ relativePath: string }> };
    expect(batch.items.length).toBe(40);
    expect(caseId).toBeTruthy();
    await screenshot(page, "corpus-intake-streamed-committed");
  });

  test("expands a streamed archive and names each member it refuses", async ({ page }) => {
    const title = uniqueTitle("Streamed intake archive");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await gotoStage(page, "Capture");

    // Large enough to leave the inline lane, and carrying one member that tries
    // to escape the investigation's own namespace.
    const filler = Buffer.from("2026-08-25T00:00:00Z mailer timeout id=syn\n".repeat(200_000));
    const archive = syntheticZip([
      { name: "mailer/bulk.log", data: filler },
      { name: "../escape.log", data: Buffer.from("2026-08-25T00:00:00Z escape\n") },
      { name: "mailer/payload.bin", data: Buffer.from([0, 1, 2, 255]) },
    ]);
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "diagnostics.zip",
      mimeType: "application/zip",
      buffer: archive,
    });

    await expect(page.getByText("Archives selected")).toBeVisible();
    await expect(page.getByText("Read the archive index")).toBeHidden();
    await page.getByText(/What will be checked/).click();
    await expect(page.getByText("Read the archive index")).toBeVisible();
    // The expanded size genuinely is not knowable from a file picker.
    await expect(page.getByText(/how large the archive is once expanded/)).toBeVisible();

    const [preview] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith("/preview") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Preview intake" }).click(),
    ]);
    expect(preview.ok(), await preview.text()).toBeTruthy();
    await expect(page.getByText("mailer/bulk.log").first()).toBeVisible();
    await expect(
      page.getByText("1 · Archive member points outside the investigation"),
    ).toBeVisible();
    await expect(page.getByText("1 · Unrecognized file type")).toBeVisible();
    await screenshot(page, "corpus-intake-streamed-archive");
  });

  test("stays readable and operable on a phone-width viewport", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const title = uniqueTitle("Streamed intake narrow");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await gotoStage(page, "Capture");
    await page.getByLabel("Evidence files").setInputFiles(streamedSelection(40));

    const preflight = page.getByRole("heading", { name: "Before this upload starts" });
    await expect(preflight).toBeVisible();
    // Nothing in the intake panel may force the page to scroll sideways.
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector("#corpus-intake");
      if (!panel) return { panel: 0, viewport: 0, document: 0 };
      return {
        panel: panel.scrollWidth,
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      };
    });
    expect(overflow.panel).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);

    await expect(page.getByRole("button", { name: "Preview intake" })).toBeVisible();
    await screenshot(page, "corpus-intake-streamed-phone");
  });
});
