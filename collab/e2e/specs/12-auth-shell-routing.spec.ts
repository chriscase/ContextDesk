import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  gotoStage,
  loginAs,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("auth shell pathname routing", () => {
  test("keeps the signed-out surface on a dedicated sign-in path", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "ContextDesk War Room" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start investigation" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/signin$|\/$/);

    await page.goto("/sources");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Source & provenance library" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  });

  test("uses pathnames for area navigation, reload, and history", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();

    await page.getByRole("button", { name: "Sources" }).click();
    await expect(page).toHaveURL(/\/sources$/);
    await expect(page.getByRole("heading", { name: "Source & provenance library" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Source & provenance library" })).toBeVisible();
    await expect(page).toHaveURL(/\/sources$/);

    await page.getByRole("button", { name: "Help" }).click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole("heading", { name: "Help Center" })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/sources$/);
    await expect(page.getByRole("heading", { name: "Source & provenance library" })).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole("heading", { name: "Help Center" })).toBeVisible();
  });

  test("restores a canonical investigation pathname and ignores unknown paths", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = `Routing ${Date.now()}`;
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await gotoStage(page, "Analyze");

    await page.goto(`/investigations/${caseId}/analyze`);
    await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Analyze" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/investigations/${caseId}/analyze$`));

    await page.reload();
    await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Analyze" })).toBeVisible();

    await page.goto("/not-a-real-war-room-page");
    await expect(
      page.getByRole("heading", { name: "This page is not in the War Room" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to overview" }).click();
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test("signs out onto the sign-in path without leaving shell chrome", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await page.getByRole("button", { name: /^Signed in as / }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await expect(page.locator("header.topbar")).toHaveCount(0);
    await expect(page).toHaveURL(/\/signin$/);
  });
});
