import { expect, test } from "@playwright/test";
import {
  createCase,
  gotoStage,
  loginAs,
  openCase,
  openCaseSupport,
  screenshot,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("create and open an investigation", () => {
  test("contributor creates an investigation and reopens it from the overview", async ({ page }) => {
    const title = uniqueTitle("Fixture case");
    await loginAs(page, FIXTURE_USERS.alice);
    await createCase(page, title);
    await expect(page.locator(".focus-head .status-pill")).toHaveText("open");
    await expect(page.locator(".focus-head")).toContainText("medium severity");
    await openCaseSupport(page);
    await expect(page.locator(".timeline__item").filter({ hasText: "case_created" })).toBeVisible();

    const accountTrigger = page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.alice.username}` });
    await accountTrigger.click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await loginAs(page, FIXTURE_USERS.alice);
    await openCase(page, title);
    await expect(page.locator(".focus-head .status-pill")).toHaveText("open");
    // Breadcrumb reflects War Room / Investigations / title / stage.
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toContainText("War Room");
    await expect(crumbs).toContainText("Investigations");
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("Analyze");
    await screenshot(page, "02-case-open");
  });

  test("admin can cycle shipped case statuses from the Decide stage", async ({ page }) => {
    const title = uniqueTitle("Status case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await gotoStage(page, "Decide");
    const statusForm = page.locator("form.composer").filter({
      has: page.getByRole("button", { name: "Update status" }),
    });

    // monitoring claims nothing about the question, so it stays a plain
    // transition through the ordinary status control.
    await statusForm.locator('select[name="status"]').selectOption("monitoring");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("monitoring");

    // resolved claims the question was answered, so it needs a record. The
    // status does not move until one is written.
    await statusForm.locator('select[name="status"]').selectOption("resolved");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    const resolutionForm = page.getByRole("form", { name: "Record why this is resolved" });
    await expect(resolutionForm).toBeVisible();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("monitoring");

    await resolutionForm
      .getByLabel("Why")
      .fill("Synthetic fixture conclusion reached from the recorded notes.");
    await resolutionForm.getByRole("button", { name: "Resolve with this record" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("resolved");
    await screenshot(page, "02-case-status-resolved");
  });

  test("admin archives an investigation and restores it to the status it held", async ({ page }) => {
    const title = uniqueTitle("Archive case");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await gotoStage(page, "Decide");

    // Archiving is deliberately not one of the ordinary status options: it
    // leaves the working list, so it asks first and says what it does.
    const statusForm = page.locator("form.composer").filter({
      has: page.getByRole("button", { name: "Update status" }),
    });
    await expect(statusForm.locator('select[name="status"] option[value="archived"]')).toHaveCount(0);

    await statusForm.locator('select[name="status"]').selectOption("monitoring");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("monitoring");

    const lifecycle = page.getByRole("region", { name: "Archive and restore" });
    await expect(lifecycle).toContainText("Nothing is deleted");

    // The first click only asks; the status has not moved.
    await lifecycle.getByRole("button", { name: "Archive investigation" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("monitoring");
    await lifecycle.getByRole("button", { name: "Yes, archive it" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("archived");
    await screenshot(page, "02-case-archived");

    // The ordinary status control is gone while archived, so a stray submit
    // cannot silently un-archive the investigation.
    await expect(
      page.locator("form.composer").filter({
        has: page.getByRole("button", { name: "Update status" }),
      }),
    ).toHaveCount(0);

    // Restore names where it lands, and lands there: monitoring, not open.
    await expect(lifecycle).toContainText("back in the working list as monitoring");
    await lifecycle.getByRole("button", { name: "Restore investigation" }).click();
    await lifecycle.getByRole("button", { name: "Yes, restore to monitoring" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("monitoring");
  });

  test("viewer gets the overview without any creation entry points", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.carol);
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page.getByPlaceholder("New investigation title")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create investigation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start investigation" })).toHaveCount(0);
  });
});
