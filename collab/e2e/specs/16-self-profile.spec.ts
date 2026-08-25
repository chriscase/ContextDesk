import { expect, test } from "@playwright/test";
import { loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("self-service profile journey", () => {
  test("opens from the account menu, saves a local field, and restores it after navigation and reload", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE_USERS.dave);

    await page.getByRole("button", { name: /^Signed in as / }).click();
    await page.getByRole("link", { name: "My profile" }).click();

    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("heading", { name: "My profile" })).toBeFocused();
    await expect(page.getByText("Local account").first()).toBeVisible();
    await expect(page.getByText(/Historical authored records stay as they were written/)).toBeVisible();

    const savedContact = `Synthetic incident desk ${Date.now()}`;
    await page.getByLabel("Other contact").fill(savedContact);
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/profile/me") &&
          response.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: "Save changes" }).click(),
    ]);
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await expect(page.getByText(/Profile saved/)).toBeVisible();

    await page.getByRole("button", { name: "Sources" }).click();
    await expect(page).toHaveURL(/\/sources$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByLabel("Other contact")).toHaveValue(savedContact);

    await page.reload();
    await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
    await expect(page.getByLabel("Other contact")).toHaveValue(savedContact);
  });
});
