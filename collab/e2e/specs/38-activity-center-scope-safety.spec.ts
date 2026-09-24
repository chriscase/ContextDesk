import { expect, test, type Page } from "@playwright/test";
import { createCase, loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

/**
 * Overview Activity Center scope safety.
 *
 * The filtered 503 is ROUTE-INJECTED fault proof. Opening a recorded activity
 * uses the real server resolve route. The no-read case projects an empty
 * capability set through `/api/auth/me`; an unmapped account cannot open the
 * shell, and a full navigation is not same-tree first-render proof. The hook
 * tests own that commit.
 */
test.describe("Activity Center scope safety", () => {
  test("opens recorded activity from Overview and keeps a filtered failure retry honest", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = `Scope safety ${Date.now()}`;
    await createCase(page, title);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Investigations" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Filter recorded activity" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Latest activity" })).toBeVisible();

    const activityLink = page.locator(".activity-feed__open").filter({ hasText: title }).first();
    await expect(activityLink).toBeVisible();
    await activityLink.focus();
    await expect(activityLink).toBeFocused();
    const [resolved] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/investigation-resources/resolve") && response.ok()),
      page.keyboard.press("Enter"),
    ]);
    expect(resolved.ok()).toBe(true);
    await expect(page).toHaveURL(/\/investigations\/[^/]+\//u);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    let releaseFailure: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let failActivity = true;
    await page.route("**/api/investigation-activity**", async (route) => {
      if (failActivity) await gate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      });
    });
    const filters = page.getByRole("form", { name: "Filter recorded activity" });
    await filters.locator("select").first().selectOption("investigation_created");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("region", { name: "Latest activity" }).getByRole("status")).toHaveText("Loading recorded activity…");
    releaseFailure();
    failActivity = false;
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Activity could not be refreshed");
    await expect(page.getByText("No recorded activity matches these filters.")).toHaveCount(0);
    await expect(page).toHaveURL(/activityKind=investigation_created/u);
    await expect(page).not.toHaveURL(/cursor=/u);
    await page.unroute("**/api/investigation-activity**");
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page).toHaveURL(/activityKind=investigation_created/u);
    await expect(page).not.toHaveURL(/cursor=/u);
    await expect(page.locator(".activity-feed__open").first()).toBeVisible();

    const motionBefore = await page.locator(".activity-feed__open").first().evaluate((element) => {
      const center = element.closest(".activity-center");
      return {
        duration: getComputedStyle(element).transitionDuration,
        scroll: center ? getComputedStyle(center).scrollBehavior : "",
      };
    });
    expect(motionBefore.duration === "0s" || motionBefore.duration === "0ms").toBe(false);
    expect(motionBefore.scroll).toBe("smooth");

    await page.setViewportSize({ width: 320, height: 700 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= 320);
    expect(overflow).toBe(true);
    const applyBox = await page.getByRole("button", { name: "Apply filters" }).boundingBox();
    expect(applyBox).not.toBeNull();
    expect(applyBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((applyBox?.x ?? 0) + (applyBox?.width ?? 0)).toBeLessThanOrEqual(321);

    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const apply = page.getByRole("button", { name: "Apply filters" });
    await page.getByRole("button", { name: "Clear" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(apply).toBeFocused();
    const focus = await apply.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor };
    });
    expect(focus.style).not.toBe("none");
    expect(focus.width).toBeGreaterThan(0);
    expect(focus.color).not.toBe("rgba(0, 0, 0, 0)");
    const boundary = await page.locator(".overview__activity").evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.borderTopStyle, width: Number.parseFloat(style.borderTopWidth), color: style.borderTopColor };
    });
    expect(boundary.style).not.toBe("none");
    expect(boundary.width).toBeGreaterThan(0);
    expect(boundary.color).not.toBe("rgba(0, 0, 0, 0)");

    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "none" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const audit = await page.locator(".activity-center").evaluate((node) => {
      const nonzero = (value: string) => value.split(",").some((part) => {
        const duration = part.trim();
        return duration.endsWith("ms") ? Number.parseFloat(duration) !== 0 : duration.endsWith("s") && Number.parseFloat(duration) !== 0;
      });
      const visible = [node, ...Array.from(node.querySelectorAll("*"))].filter((candidate) => {
        const element = candidate as HTMLElement;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      });
      return {
        inspected: visible.length,
        offenders: visible.flatMap((candidate) => {
          const style = getComputedStyle(candidate);
          return nonzero(style.animationDuration) || nonzero(style.transitionDuration)
            ? [style.transitionDuration]
            : [];
        }),
        scroll: getComputedStyle(node).scrollBehavior,
      };
    });
    expect(audit.inspected).toBeGreaterThan(10);
    expect(audit.offenders).toEqual([]);
    expect(audit.scroll).toBe("auto");
  });

  test("a projected no-read session requests no activity or cases and hides the previous feed", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = `Hidden after denial ${Date.now()}`;
    await createCase(page, title);
    await page.goto("/");
    await expect(page.getByText(title).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await projectNoRead(page);

    let activityReads = 0;
    let caseReads = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (path === "/api/investigation-activity") activityReads += 1;
      if (path === "/api/cases") caseReads += 1;
    });
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("cannot read investigations");
    await expect(page.getByText(title)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load more activity" })).toHaveCount(0);
    expect(activityReads).toBe(0);
    expect(caseReads).toBe(0);
    await page.unroute("**/api/auth/me");
  });
});

async function projectNoRead(page: Page): Promise<void> {
  const authenticated = await page.request.get("/api/auth/me");
  expect(authenticated.ok(), await authenticated.text()).toBeTruthy();
  const session = await authenticated.json() as Record<string, unknown>;
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...session, capabilities: [] }),
    });
  });
}
