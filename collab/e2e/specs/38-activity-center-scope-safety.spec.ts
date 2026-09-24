import { expect, test } from "@playwright/test";
import { createCase, loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

/**
 * Overview Activity Center scope safety.
 * The 503 case is ROUTE-INJECTED fault proof. Opening a recorded activity uses
 * the real server resolve route. A login as another account is not same-tree
 * first-render proof; the hook tests own that commit.
 */
test.describe("Activity Center scope safety", () => {
  test("opens recorded activity from Overview and keeps a filtered failure retry honest", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = `Scope safety ${Date.now()}`;
    await createCase(page, title);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);

    const activityLink = page.locator(".activity-feed__open").filter({ hasText: title }).first();
    await expect(activityLink).toBeVisible();
    await activityLink.click();
    await expect(page).toHaveURL(/\/investigations\/[^/]+\//u);

    await page.goto("/?activityKind=investigation_created");
    await page.route("**/api/investigation-activity**", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable" }),
    }));
    await page.getByRole("button", { name: "Apply filters" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Activity could not be refreshed");
    await expect(page.getByText("No recorded activity matches these filters.")).toHaveCount(0);
    await expect(page).not.toHaveURL(/cursor=/u);
    await page.unroute("**/api/investigation-activity**");
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page).toHaveURL(/activityKind=investigation_created/u);
    await expect(page).not.toHaveURL(/cursor=/u);

    await page.setViewportSize({ width: 320, height: 700 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(overflow).toBe(true);

    await page.emulateMedia({ forcedColors: "active" });
    const apply = page.getByRole("button", { name: "Apply filters" });
    await apply.focus();
    const outline = await apply.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outline).not.toBe("none");
    const boundary = await page.locator(".overview__activity").evaluate((element) => getComputedStyle(element).borderTopColor);
    expect(boundary).not.toBe("rgba(0, 0, 0, 0)");

    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "none" });
    const motion = await page.locator(".activity-center").evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(motion === "0s" || motion === "0ms").toBe(true);
  });

  test("a no-read account requests no activity or cases and hides the previous feed", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = `Hidden after denial ${Date.now()}`;
    await createCase(page, title);
    await page.goto("/");
    await expect(page.getByText(title).first()).toBeVisible();

    let activityReads = 0;
    let caseReads = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (path === "/api/investigation-activity") activityReads += 1;
      if (path === "/api/cases") caseReads += 1;
    });
    await loginAs(page, FIXTURE_USERS.bob);
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("cannot read investigations");
    await expect(page.getByText(title)).toHaveCount(0);
    expect(activityReads).toBe(0);
    expect(caseReads).toBe(0);
  });
});
