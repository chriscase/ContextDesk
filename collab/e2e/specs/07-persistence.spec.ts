import { expect, test } from "@playwright/test";
import { createCase, loginAs, openCase, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("reload and restart persistence", () => {
  test("reload keeps the session cookie and in-memory case", async ({ page }) => {
    const title = uniqueTitle("Persist case");
    await loginAs(page, FIXTURE_USERS.alice);
    await createCase(page, title);
    await page.reload();
    await expect(page.getByText(`Signed in as ${FIXTURE_USERS.alice.username}`)).toBeVisible();
    await openCase(page, title);
    await expect(page.locator(".timeline__item").filter({ hasText: "case_created" })).toBeVisible();
  });

  test("process restart is a documented checkpoint unless a durable server is provided", async ({
    request,
  }) => {
    const durable = process.env.COLLAB_E2E_RESTART_BASE_URL?.trim();
    test.skip(
      !durable,
      "Manual checkpoint: fixture MapAuthAdapter + memory stores do not survive process restart. Postgres-backed `npm start` is required; /ready is 503 on the fixture server.",
    );
    const health = await request.get(new URL("/health", durable).toString());
    expect(health.ok()).toBeTruthy();
    const ready = await request.get(new URL("/ready", durable).toString());
    expect(ready.ok(), "durable server must report /ready").toBeTruthy();
  });
});
