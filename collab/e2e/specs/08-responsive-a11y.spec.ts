import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  caseIdForTitle,
  createCase,
  loginAs,
  openCase,
  screenshot,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const TWO_APPROACH_PACKAGE = JSON.parse(
  readFileSync(
    join(FIXTURE_ROOT, "..", "..", "contracts", "fixtures", "experiment-package.two-approach.valid.json"),
    "utf8",
  ),
) as Record<string, unknown>;

test.describe("responsive layout and basic accessibility", () => {
  test("login form exposes labeled controls and a main landmark", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("main.shell")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "ContextDesk Experiment Lab" })).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    await screenshot(page, "08-login-a11y");
  });

  test("workbench contains the real comparison matrix at a phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Narrow case");
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    const imported = await page.request.post(`/api/cases/${caseId}/experiments`, {
      data: TWO_APPROACH_PACKAGE,
    });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    await page.reload();
    await openCase(page, title);

    const workbench = page.locator(".workbench");
    await expect(workbench).toBeVisible();
    const box = await workbench.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(375);
    await expect(page.locator(".case-list")).toBeVisible();
    await expect(page.locator(".case-view")).toBeVisible();
    await expect(page.locator("table.experiment-lab__matrix")).toBeVisible();

    const narrowDocWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(narrowDocWidth).toBeLessThanOrEqual(375);

    const wrap = page.locator(".experiment-lab__matrix-wrap");
    const wrapMetrics = await wrap.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(wrapMetrics.overflowX).toBe("auto");
    expect(wrapMetrics.scrollWidth).toBeGreaterThan(wrapMetrics.clientWidth);
    await screenshot(page, "08-responsive-375");

    await page.setViewportSize({ width: 1280, height: 800 });
    const wideDocWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wideDocWidth).toBeLessThanOrEqual(1280);
    await screenshot(page, "08-responsive-1280");
  });
});
