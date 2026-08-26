import { expect, test, type Page } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  gotoStage,
  loginAs,
  openCase,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";
import { WAR_ROOM_SCENARIOS, deepLink } from "../src/war-room/scenarios.js";
import { noisySupportBundle, warRoomBytes } from "../src/war-room/fixtures.js";
import { freezeEvidence, runSyntheticComparison } from "../src/war-room/journey.js";

/**
 * Accessibility and responsive coverage for the War Room scenario surfaces.
 *
 * The scenario journeys prove the surfaces say the right things. This spec
 * proves they can be read and operated: on a phone, with a keyboard, and by
 * someone relying on landmarks and accessible names.
 *
 * It is driven from the same catalog as the journeys, so a scenario that adds
 * a deep-link target automatically gets responsive coverage rather than
 * quietly skipping it.
 */

const PHONE = { width: 375, height: 812 };
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };

/** Every stage path a scenario deep link can land on, deduplicated. */
function scenarioStagePaths(caseId: string): string[] {
  const paths = new Set<string>();
  for (const scenario of WAR_ROOM_SCENARIOS) {
    for (const target of scenario.deepLinks) {
      // Substitute placeholders with the reference investigation's real id and
      // harmless stand-ins: this spec exercises layout, not item focus.
      const url = deepLink(target, {
        caseId,
        batchId: "layout-probe",
        artifactId: "layout-probe",
        importId: "layout-probe",
        workstreamKey: "layout-probe",
        firstRunId: "layout-probe",
        rerunId: "layout-probe",
        runId: "layout-probe",
        candidateId: "layout-probe",
      });
      paths.add(url);
    }
  }
  return [...paths].sort();
}

async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

/**
 * Controls with no accessible name, as a screen reader would find them.
 * Uses the same precedence the platform does for the cases this shell uses:
 * aria-label, aria-labelledby, an associated <label>, then visible text.
 */
async function unnamedControls(page: Page, root: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return [`missing region ${selector}`];
    const controls = Array.from(
      scope.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary"),
    ) as HTMLElement[];
    const unnamed: string[] = [];
    for (const control of controls) {
      const style = getComputedStyle(control);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const labelledBy = control.getAttribute("aria-labelledby");
      const named =
        (control.getAttribute("aria-label") ?? "").trim()
        || (labelledBy
          ? labelledBy
            .split(/\s+/)
            .map((id: string) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim()
          : "")
        || (control instanceof HTMLInputElement
          || control instanceof HTMLSelectElement
          || control instanceof HTMLTextAreaElement
          ? Array.from(control.labels ?? []).map((label) => label.textContent ?? "").join(" ").trim()
          : "")
        || (control.textContent ?? "").trim()
        || (control instanceof HTMLInputElement ? (control.value ?? "").trim() : "");
      if (!named) {
        unnamed.push(`${control.tagName.toLowerCase()}${control.className ? `.${String(control.className).split(/\s+/)[0]}` : ""}`);
      }
    }
    return unnamed;
  }, root);
}

/** Build one investigation carrying the material the scenarios produce. */
async function referenceInvestigation(page: Page, title: string): Promise<string> {
  await createCase(page, title);
  const caseId = await caseIdForTitle(page, title);

  await gotoStage(page, "Capture");
  await page.getByRole("radio", { name: "ZIP archive" }).check();
  await page.getByLabel("ZIP file to upload").setInputFiles({
    name: "support-bundle.zip",
    mimeType: "application/zip",
    buffer: noisySupportBundle(),
  });
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/corpus-intake/preview") && res.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Preview intake" }).click(),
  ]);
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/corpus-intake")
        && !res.url().includes("preview")
        && res.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Commit accepted files" }).click(),
  ]);

  await uploadEvidence(page, caseId, {
    kind: "email",
    summary: "Forwarded synthetic support chain.",
    filename: "customer-email-chain.eml",
    mediaType: "message/rfc822",
    bytes: warRoomBytes("customer-email-chain.eml"),
    privacyClass: "owner_only",
  });
  await page.reload();
  await openCase(page, title);
  await freezeEvidence(page, ["bundle/mailer/mailer-offsetless.log"]);
  await runSyntheticComparison(page, caseId);
  return caseId;
}

test.describe("War Room scenario surfaces are readable and operable", () => {
  test("every scenario deep-link surface fits a phone without horizontal scroll", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await referenceInvestigation(page, uniqueTitle("Responsive reference"));

    for (const viewport of [PHONE, TABLET, DESKTOP]) {
      await page.setViewportSize(viewport);
      for (const path of scenarioStagePaths(caseId)) {
        await page.goto(path);
        await expect(page.locator("main#war-room-main")).toBeVisible();
        expect(
          await documentOverflow(page),
          `${path} scrolls horizontally at ${viewport.width}px`,
        ).toBeLessThanOrEqual(viewport.width);
      }
    }
    await page.setViewportSize(PHONE);
    await page.goto(`/investigations/${caseId}/analyze`);
    await screenshot(page, "22-scenario-surfaces-375");
    await page.setViewportSize(DESKTOP);
    await screenshot(page, "22-scenario-surfaces-1280");
  });

  test("scenario intake and evidence controls all carry accessible names", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await referenceInvestigation(page, uniqueTitle("Named controls"));

    for (const stage of ["capture", "analyze", "compare", "decide", "situation"]) {
      await page.goto(`/investigations/${caseId}/${stage}`);
      const region = `#stage-${stage}`;
      await expect(page.locator(region)).toBeVisible();
      expect(
        await unnamedControls(page, region),
        `${stage} has controls a screen reader cannot announce`,
      ).toEqual([]);
    }
  });

  test("the scenario surfaces expose landmarks, language, and a working skip link", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await referenceInvestigation(page, uniqueTitle("Landmarks"));
    await page.goto(`/investigations/${caseId}/analyze`);

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.locator("main#war-room-main")).toBeVisible();

    const skip = page.locator("a.skip-link");
    await expect(skip).toHaveAttribute("href", "#war-room-main");
    await page.keyboard.press("Tab");
    await expect(skip, "the skip link is not the first keyboard stop").toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#war-room-main$/);

    // The stage rail is a real navigation with a current-page marker, so a
    // keyboard or screen-reader user can tell where they are.
    const stages = page.getByRole("navigation", { name: "Investigation stages" });
    await expect(stages).toBeVisible();
    await gotoStage(page, "Compare");
    await expect(
      stages.getByRole("button", { name: /^Compare/ }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("the evidence log viewer is keyboard-operable and its disclosure is announced", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await referenceInvestigation(page, uniqueTitle("Keyboard log"));
    await page.goto(`/investigations/${caseId}/analyze`);

    const row = page.locator("#stage-analyze .case-memory__list > li").filter({
      hasText: "bundle/mailer/mailer-offsetless.log",
    });
    const inspect = row.getByRole("button", { name: "Inspect log" });
    await inspect.focus();
    await expect(inspect).toBeFocused();
    // A visible focus ring is what makes keyboard navigation usable at all.
    const outline = await inspect.evaluate((node) => {
      const style = getComputedStyle(node);
      return `${style.outlineStyle}:${style.outlineWidth}:${style.boxShadow}`;
    });
    expect(outline, "the inspect control has no visible keyboard focus state").not.toBe(
      "none:0px:none",
    );
    await page.keyboard.press("Enter");

    const viewer = row.locator(".log-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer, "the log viewer region is not named").toHaveAttribute(
      "aria-label",
      /^Log /,
    );
    const disclosure = row.locator("details").filter({ hasText: "Expand complete log" });
    await expect(disclosure.locator("summary")).toContainText(/\d+ lines/);
  });

  test("the comparison matrix scrolls inside its own wrapper on a phone", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await referenceInvestigation(page, uniqueTitle("Narrow matrix"));
    await page.goto(`/investigations/${caseId}/analyze`);

    // Wide run content must never push the page itself sideways.
    const runs = page.locator(".triage-runs__results").first();
    await expect(runs).toBeVisible();
    expect(await documentOverflow(page)).toBeLessThanOrEqual(PHONE.width);

    await page.goto(`/investigations/${caseId}/compare`);
    await expect(page.locator("#stage-compare")).toBeVisible();
    expect(await documentOverflow(page)).toBeLessThanOrEqual(PHONE.width);
  });
});
