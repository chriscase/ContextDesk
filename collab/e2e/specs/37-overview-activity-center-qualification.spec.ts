import { expect, test, type Request } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

function isActivityRead(request: Request): boolean {
  const url = new URL(request.url());
  return request.method() === "GET" && url.pathname === "/api/investigation-activity";
}

function isCaseRead(request: Request): boolean {
  const url = new URL(request.url());
  return request.method() === "GET"
    && (url.pathname === "/api/cases" || url.pathname.startsWith("/api/cases/"));
}

test.describe("Overview Activity Center qualification", () => {
  test("keeps Overview distinct from Investigations and opens recorded work canonically", async ({
    page,
  }) => {
    const title = uniqueTitle("Activity Center separation");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Overview", exact: true })
      .click();

    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Latest activity" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Recorded follow-up" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Filter recorded activity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Investigations", exact: true })).toHaveCount(0);

    const recordedItem = page
      .getByRole("region", { name: "Latest activity" })
      .getByRole("link")
      .filter({ hasText: title })
      .first();
    await expect(recordedItem).toBeVisible();
    const destination = await recordedItem.getAttribute("href");
    expect(destination).toMatch(new RegExp(`^/investigations/${caseId}/`, "u"));

    await recordedItem.focus();
    await expect(recordedItem).toBeFocused();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/investigation-resources/resolve") && response.ok()),
      recordedItem.press("Enter"),
    ]);
    await expect(page).toHaveURL(destination!);
    await expect(page.locator("h2.case-view__title").filter({ hasText: title })).toBeVisible();

    await page.goto("/");
    const investigations = page.getByRole("button", { name: "View investigations" });
    await investigations.focus();
    await expect(investigations).toBeFocused();
    await investigations.press("Enter");
    await expect(page).toHaveURL(/\/investigations$/u);
    await expect(page.getByRole("heading", { name: "Investigations", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Operating picture" })).toHaveCount(0);
    await expect(page.locator(".case-list").getByText(title, { exact: true })).toBeVisible();
  });

  test("reports a failed activity load truthfully and retries only on request", async ({ page }) => {
    const title = uniqueTitle("Activity Center retry");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);

    let serveFailure = true;
    const activityReads: string[] = [];
    await page.route("**/api/investigation-activity*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      activityReads.push(route.request().url());
      if (serveFailure) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "unavailable" }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto("/?activityKind=investigation_created");
      await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
      await expect(page).toHaveURL(/\/?activityKind=investigation_created$/u);
      await expect(
        page.getByRole("form", { name: "Filter recorded activity" }).getByLabel("Activity"),
      ).toHaveValue("investigation_created");
      const failure = page.getByRole("alert").filter({
        hasText: "Activity could not be refreshed",
      });
      await expect(failure).toContainText(
        "Previously loaded activity remains visible when available.",
      );
      await expect(page.getByText("No activity has been recorded yet.")).toHaveCount(0);
      await expect(page.getByText("No recorded activity matches these filters.")).toHaveCount(0);

      const readsBeforeRetry = activityReads.length;
      serveFailure = false;
      const retry = failure.getByRole("button", { name: "Retry", exact: true });
      await retry.focus();
      await expect(retry).toBeFocused();
      await retry.press("Enter");

      await expect.poll(() => activityReads.length).toBeGreaterThan(readsBeforeRetry);
      await expect(
        page.getByRole("region", { name: "Latest activity" }).getByRole("link").filter({ hasText: title }).first(),
      ).toBeVisible();
      await expect(failure).toHaveCount(0);
      expect(activityReads.slice(readsBeforeRetry).every((url) => {
        const requestUrl = new URL(url);
        return requestUrl.searchParams.get("activityKind") === "investigation_created"
          && !requestUrl.searchParams.has("cursor");
      })).toBe(true);
    } finally {
      await page.unroute("**/api/investigation-activity*");
    }
  });

  test("makes a read-denied Overview non-busy without requesting activity or cases", async ({
    page,
  }) => {
    const priorTitle = uniqueTitle("Prior readable activity");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, priorTitle);
    await page.goto("/");
    await expect(
      page.getByRole("region", { name: "Latest activity" }).getByRole("link").filter({ hasText: priorTitle }).first(),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");

    const sessionResponse = await page.request.get("/api/auth/me");
    expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy();
    const session = await sessionResponse.json() as Record<string, unknown>;
    const forbiddenReads: string[] = [];
    const recordForbiddenRead = (request: Request) => {
      if (isActivityRead(request) || isCaseRead(request)) forbiddenReads.push(request.url());
    };
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...session, capabilities: [] }),
      });
    });
    page.on("request", recordForbiddenRead);

    try {
      await page.goto("/");
      const denied = page.getByRole("heading", { name: "Overview unavailable" });
      await expect(denied).toBeVisible();
      const surface = page.locator("section.not-found").filter({ has: denied });
      await expect(surface).toHaveAttribute("aria-busy", "false");
      await expect(surface.getByRole("status")).toHaveText(
        "Your current account cannot read investigations, so no investigation or activity data was requested.",
      );
      await expect(page.getByText(priorTitle, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expect.poll(() => forbiddenReads).toEqual([]);
    } finally {
      page.off("request", recordForbiddenRead);
      await page.unroute("**/api/auth/me");
    }
  });

  test("reflows at 320px with semantic controls in forced colors and reduced motion", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();

    const filters = page.getByRole("form", { name: "Filter recorded activity" });
    const activity = filters.getByLabel("Activity");
    await activity.focus();
    await expect(activity).toBeFocused();
    expect(await activity.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));

    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await activity.focus();
    expect(await activity.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect(await filters.evaluate((element) => getComputedStyle(element).borderTopStyle)).not.toBe("none");

    await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const durations = await activity.evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(durations.split(",").every((value) => value.trim() === "0s")).toBe(true);
  });
});
