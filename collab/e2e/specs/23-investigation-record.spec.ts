/**
 * The historical-investigation journey, end to end in a browser.
 *
 * This is the flow the record graph exists for: someone opens a case about
 * work that happened months ago, names the organization it concerned with a
 * label another investigation can reuse, cites the earlier investigation that
 * looks the same, and concludes it by reasoning — with no model run anywhere
 * in the case.
 *
 * Every label, title, and body below is synthetic.
 */
import { expect, test } from "@playwright/test";
import { createCase, gotoStage, loginAs, screenshot, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const ENTITY_LABEL = "Fable Harbor";

async function openEntities(page: import("@playwright/test").Page): Promise<void> {
  const menu = page.getByRole("button", { name: "Menu" });
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) === "false") {
    await menu.click();
  }
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Entities", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Who and what investigations are about" })).toBeVisible();
}

test.describe("the investigation record graph", () => {
  test("a case lead registers a reusable entity and states the boundary", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.alice);
    await openEntities(page);

    // The page itself says what belongs here and what does not.
    await expect(page.getByText(/This area holds labels only/)).toBeVisible();
    await expect(
      page.getByText(/stay inside the investigation where they were captured/),
    ).toBeVisible();
    await expect(
      page.getByText(/where a piece of information came from, not who the work is about/),
    ).toBeVisible();

    const label = `${ENTITY_LABEL} ${Date.now()}`;
    const form = page.getByRole("form", { name: "Add an entity" });
    await form.getByLabel("Entity kind").selectOption("organization");
    await form.getByLabel("Entity name").fill(label);
    await form.getByRole("button", { name: "Add entity" }).click();

    await expect(page.getByText(label)).toBeVisible();
    // Default-deny: a name stays inside the tool until someone says otherwise.
    await expect(
      page.locator(".catalog__item").filter({ hasText: label }).getByText("Stays internal"),
    ).toBeVisible();
    await screenshot(page, "23-entities-registry");
  });

  test("a historical investigation keeps both clocks and never guesses a time zone", async ({
    page,
  }) => {
    const title = uniqueTitle("Synthetic historical case");
    await loginAs(page, FIXTURE_USERS.alice);

    const field = page.getByPlaceholder("New investigation title");
    if (!(await field.isVisible())) {
      await page.getByRole("button", { name: "Start investigation" }).click();
    }
    await page.getByLabel("When it happened").fill("2024-11-04");
    await field.fill(title);
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith("/api/cases") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create investigation" }).click(),
    ]);

    await gotoStage(page, "Situation");
    const happened = page.getByTestId("occurred-at");
    await expect(happened).toContainText("2024-11-04");
    // The literal date is shown as typed, with the missing offset stated
    // rather than filled in.
    await expect(happened).toContainText("time zone not recorded");

    const recorded = page.getByTestId("recorded-at");
    await expect(recorded).not.toContainText("2024-11-04");
    await expect(recorded).not.toHaveText("Not recorded");
    await screenshot(page, "23-occurred-at");
  });

  test("naming an entity makes an investigation findable by that entity later", async ({ page }) => {
    const label = `Synthetic service ${Date.now()}`;
    const title = uniqueTitle("Synthetic involved case");
    await loginAs(page, FIXTURE_USERS.alice);

    await openEntities(page);
    const entityForm = page.getByRole("form", { name: "Add an entity" });
    await entityForm.getByLabel("Entity kind").selectOption("service");
    await entityForm.getByLabel("Entity name").fill(label);
    await entityForm.getByRole("button", { name: "Add entity" }).click();
    await expect(page.getByText(label)).toBeVisible();

    await createCase(page, title);
    await gotoStage(page, "Situation");
    const involvementForm = page.getByRole("form", { name: "Add an involved entity" });
    await involvementForm.getByLabel("Entity").selectOption({ label: `${label} · Service` });
    await involvementForm.getByLabel("How it is involved").selectOption("affected");
    await involvementForm.getByLabel("Involved since").fill("2024-11-04");
    await involvementForm.getByRole("button", { name: "Add involved entity" }).click();

    await expect(
      page.locator(".catalog__item").filter({ hasText: label }).first(),
    ).toBeVisible();

    // The list filter finds the investigation by the entity it involves.
    const menu = page.getByRole("button", { name: "Menu" });
    if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) === "false") {
      await menu.click();
    }
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Investigations", exact: true })
      .click();
    const filter = page.getByLabel("Filter investigations by involved entity");
    await expect(filter).toBeVisible();
    // Options carry a count suffix, so select by the value behind the label
    // rather than matching display text that changes as work accumulates.
    const entityValue = await filter
      .locator("option")
      .filter({ hasText: label })
      .first()
      .getAttribute("value");
    expect(entityValue).toBeTruthy();
    await filter.selectOption(entityValue as string);
    await expect(page.getByRole("button", { name: title })).toBeVisible();
    await screenshot(page, "23-entity-filter");
  });

  test("citing an earlier investigation deep-links to it without copying it", async ({ page }) => {
    const earlier = uniqueTitle("Synthetic earlier case");
    const current = uniqueTitle("Synthetic current case");
    await loginAs(page, FIXTURE_USERS.alice);
    await createCase(page, earlier);
    await createCase(page, current);

    await gotoStage(page, "Situation");
    await expect(
      page.getByText(/does not become supporting evidence here/i),
    ).toBeVisible();

    const referenceForm = page.getByRole("form", { name: "Cite another investigation" });
    await referenceForm.getByLabel("Investigation to cite").selectOption({ label: earlier });
    await referenceForm
      .getByLabel("Why it is relevant")
      .fill("Same synthetic timeout signature as the earlier case.");
    await referenceForm.getByRole("button", { name: "Cite this investigation" }).click();

    const citation = page.locator(".catalog__item").filter({ hasText: earlier }).first();
    await expect(citation).toBeVisible();
    const openLink = citation.getByRole("link", { name: "Open the cited investigation" });
    // The locator is a real in-app address, so it survives being copied.
    await expect(openLink).toHaveAttribute("href", /^\/investigations\/[0-9a-f-]+\/situation\?/);
    await screenshot(page, "23-cross-investigation-reference");
  });

  test("a case lead cannot resolve an investigation without recording why", async ({ page }) => {
    const title = uniqueTitle("Synthetic manual case");
    // Concluding an investigation is case-lead standing; erin holds it.
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    await gotoStage(page, "Decide");

    const statusForm = page.locator("form.composer").filter({
      has: page.getByRole("button", { name: "Update status" }),
    });
    await statusForm.locator('select[name="status"]').selectOption("resolved");
    await statusForm.getByRole("button", { name: "Update status" }).click();

    // The status has not moved, and the record form is what appeared.
    await expect(page.locator(".focus-head .status-pill")).toHaveText("open");
    const resolutionForm = page.getByRole("form", { name: "Record why this is resolved" });
    await expect(resolutionForm).toBeVisible();
    // Human reasoning is the default and needs no comparison.
    await expect(resolutionForm.getByLabel("How was this reached?")).toHaveValue("human_only");
    await expect(page.getByText(/No model run is needed or implied/)).toBeVisible();

    await resolutionForm
      .getByLabel("Why")
      .fill("The synthetic retry window matches the scheduled batch and stopped when it moved.");
    await resolutionForm
      .getByLabel("Still unknown")
      .fill("Which synthetic upstream change moved the batch schedule.");
    await resolutionForm.getByRole("button", { name: "Resolve with this record" }).click();

    await expect(page.locator(".focus-head .status-pill")).toHaveText("resolved");
    await screenshot(page, "23-human-only-resolution");
  });

  test("reopening withdraws the conclusion and a fresh one is required", async ({ page }) => {
    const title = uniqueTitle("Synthetic reopened case");
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    await gotoStage(page, "Decide");

    const statusForm = page.locator("form.composer").filter({
      has: page.getByRole("button", { name: "Update status" }),
    });
    await statusForm.locator('select[name="status"]').selectOption("resolved");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    const resolutionForm = page.getByRole("form", { name: "Record why this is resolved" });
    await resolutionForm.getByLabel("Why").fill("First synthetic conclusion.");
    await resolutionForm.getByRole("button", { name: "Resolve with this record" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("resolved");

    await statusForm.locator('select[name="status"]').selectOption("open");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("open");

    // Resolving again asks for its own record rather than reusing the
    // conclusion that was already withdrawn.
    await statusForm.locator('select[name="status"]').selectOption("resolved");
    await statusForm.getByRole("button", { name: "Update status" }).click();
    await expect(page.getByRole("form", { name: "Record why this is resolved" })).toBeVisible();
    await expect(page.locator(".focus-head .status-pill")).toHaveText("open");
  });

  test("a viewer sees the record without any way to change it", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.carol);
    await openEntities(page);
    await expect(page.getByRole("form", { name: "Add an entity" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Retire / })).toHaveCount(0);
    await screenshot(page, "23-entities-viewer");
  });
});
