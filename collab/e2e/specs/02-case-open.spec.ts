import { expect, test } from "@playwright/test";
import { createCase, loginAs, openCase, screenshot, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("create and open a case", () => {
  test("contributor creates a case and reopens it from the list", async ({ page }) => {
    const title = uniqueTitle("Fixture case");
    await loginAs(page, FIXTURE_USERS.alice);
    await createCase(page, title);
    await expect(page.getByText(/open \/ medium/)).toBeVisible();
    await expect(page.locator(".timeline__item").filter({ hasText: "case_created" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await loginAs(page, FIXTURE_USERS.alice);
    await openCase(page, title);
    await expect(page.getByText(/open \/ medium/)).toBeVisible();
    await screenshot(page, "02-case-open");
  });

  test("admin can cycle shipped case statuses", async ({ page }) => {
    const title = uniqueTitle("Status case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const statusForm = page.locator("form.composer").filter({
      has: page.getByRole("button", { name: "Update status" }),
    });
    await statusForm.locator('select[name="status"]').selectOption("monitoring");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    await expect(page.locator(".case-view__title")).toContainText("monitoring");
    await statusForm.locator('select[name="status"]').selectOption("resolved");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    await expect(page.locator(".case-view__title")).toContainText("resolved");
    await screenshot(page, "02-case-status-resolved");
  });

  test("viewer does not persist a created case (write is server-denied)", async ({ page }) => {
    const title = uniqueTitle("Viewer should not create");
    await loginAs(page, FIXTURE_USERS.carol);
    await page.getByPlaceholder("New case title").fill(title);
    await page.getByRole("button", { name: "Create case" }).click();
    await expect(page.locator(".case-list").getByRole("button", { name: title })).toHaveCount(0);
    await expect(page.getByText("Select or create a case.")).toBeVisible();
  });
});
