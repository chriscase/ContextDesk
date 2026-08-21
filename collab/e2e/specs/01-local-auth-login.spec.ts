import { expect, test } from "@playwright/test";
import { loginAs, screenshot } from "../src/helpers.js";
import { INVENTED_ROUTES } from "../src/surface-map.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("local-auth demo login (MapAuthAdapter fixture)", () => {
  test("maps a contributor through the login form", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.alice);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible();
    await screenshot(page, "01-login-alice");
  });

  test("rejects unknown credentials without leaking account existence", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("nobody");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign-in failed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("denies an unmapped directory user", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill(FIXTURE_USERS.bob.username);
    await page.getByLabel("Password").fill(FIXTURE_USERS.bob.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign-in failed.")).toBeVisible();
  });

  test("invented local-auth routes are absent", async ({ request }) => {
    for (const path of INVENTED_ROUTES.filter((row) => row.includes("auth") || row.includes("local"))) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
    }
  });
});
