import { expect, test } from "@playwright/test";
import { createCase, loginAs, screenshot, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

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

  test("workbench stacks at a phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Narrow case");
    await createCase(page, title);
    const workbench = page.locator(".workbench");
    await expect(workbench).toBeVisible();
    const box = await workbench.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(375);
    await expect(page.locator(".case-list")).toBeVisible();
    await expect(page.locator(".case-view")).toBeVisible();
    await screenshot(page, "08-responsive-375");
    await page.setViewportSize({ width: 1280, height: 800 });
    await screenshot(page, "08-responsive-1280");
  });
});
