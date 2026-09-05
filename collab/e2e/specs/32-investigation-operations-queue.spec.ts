import { expect, test, type Page } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const QUEUE_QUERY_SCHEMA_ID = "cd-collab.investigation_operations_queue_query.v1";

interface QueuePage {
  schemaId: string;
  items: Array<{
    investigation: { id: string; title: string; status: string };
    coordination: { coordinator: { username: string } | null };
  }>;
  nextCursor: string | null;
  hiddenArchivedCount: number;
  coordinationScopeCounts: { allVisible: number; mine: number; unassigned: number };
}

async function createInvestigation(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Operations Queue browser qualification record.",
      affectedParties: "Fixture operators",
      impact: "Qualification only",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id?: string };
  expect(body.id).toBeTruthy();
  return body.id!;
}

function isQueueRequest(url: URL): boolean {
  return url.pathname === "/api/cases"
    && url.searchParams.get("schemaId") === QUEUE_QUERY_SCHEMA_ID;
}

test.describe("Investigation Operations Queue", () => {
  test("round-trips canonical location and native links without strategy persistence", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations native queue row");
    const caseId = await createInvestigation(page, title);
    const preferenceWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/ui-strategies/preference") {
        preferenceWrites.push(request.url());
      }
    });

    await page.goto(
      `/operations?q=${encodeURIComponent(title)}&status=open&coordinationScope=unassigned`
        + "&cursor=must-not-survive&limit=1&entityId=hidden&unexpected=yes",
    );
    await expect(page.getByRole("heading", { name: "Operations Queue" })).toBeVisible();
    await expect(page).toHaveTitle("Operations · ContextDesk War Room");
    const canonical = new URL(page.url());
    expect(canonical.pathname).toBe("/operations");
    expect(canonical.searchParams.get("q")).toBe(title);
    expect(canonical.searchParams.get("status")).toBe("open");
    expect(canonical.searchParams.get("coordinationScope")).toBe("unassigned");
    for (const key of ["cursor", "limit", "entityId", "unexpected"]) {
      expect(canonical.searchParams.has(key)).toBe(false);
    }

    const navButtons = await page.getByRole("navigation", { name: "Primary" })
      .getByRole("button")
      .allTextContents();
    expect(navButtons.indexOf("Operations")).toBe(navButtons.indexOf("Investigations") + 1);
    const row = page.getByRole("link", { name: new RegExp(title, "u") });
    await expect(row).toHaveAttribute("href", `/investigations/${caseId}/situation`);
    await expect(row).toContainText("Coordinator: Not recorded");
    const allVisible = page.getByRole("link", { name: /All visible/u });
    const expectedBase = new URLSearchParams({ q: title, status: "open" }).toString();
    await expect(allVisible).toHaveAttribute(
      "href",
      `/operations?${expectedBase}`,
    );
    const mine = page.getByRole("link", { name: /Mine/u });
    await expect(mine).toHaveAttribute(
      "href",
      `/operations?${expectedBase}&coordinationScope=mine`,
    );

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/investigations/${caseId}/situation$`, "u"));
    expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(history.state ?? {}, "uiStrategyId")))
      .toBe(false);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Operations Queue" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: new RegExp(title, "u") })).toBeVisible();
    expect(preferenceWrites).toEqual([]);
  });

  test("preserves server order and focus through failed and successful continuation", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const token = `operations-page-${Date.now()}`;
    await createInvestigation(page, `${token} first`);
    await createInvestigation(page, `${token} second`);
    let source: QueuePage | null = null;
    let continuationAttempts = 0;
    const queueRequests: URL[] = [];

    await page.route("**/api/cases?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (!isQueueRequest(requestUrl)) {
        await route.continue();
        return;
      }
      queueRequests.push(requestUrl);
      if (requestUrl.searchParams.has("cursor")) {
        continuationAttempts += 1;
        if (continuationAttempts === 1) {
          await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
          return;
        }
        expect(source).not.toBeNull();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...source!,
            items: source!.items.slice(1, 2),
            nextCursor: null,
          }),
        });
        return;
      }
      const response = await route.fetch();
      source = await response.json() as QueuePage;
      await route.fulfill({
        response,
        json: {
          ...source,
          items: source.items.slice(0, 1),
          nextCursor: "eyJwYWdlIjoyfQ",
        },
      });
    });

    try {
      await page.goto(`/operations?q=${encodeURIComponent(token)}&coordinationScope=unassigned`);
      const rows = page.getByRole("list", { name: "Operations queue investigations" }).getByRole("listitem");
      await expect(rows).toHaveCount(1);
      await expect.poll(() => source?.items.length ?? 0).toBeGreaterThanOrEqual(2);
      const expected = source!.items.slice(0, 2).map((row) => row.investigation.title);
      await expect(rows.nth(0)).toContainText(expected[0]!);

      const loadMore = page.getByRole("button", { name: "Load more operations" });
      await loadMore.focus();
      await loadMore.press("Enter");
      const failure = page.getByRole("alert");
      await expect(failure).toContainText("Previously loaded rows remain in server order");
      await expect(failure).toBeFocused();
      await expect(rows).toHaveCount(1);
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);

      await failure.getByRole("button", { name: "Try loading more" }).press("Enter");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText(expected[0]!);
      await expect(rows.nth(1)).toContainText(expected[1]!);
      const completion = page.getByText("All operations are shown.");
      await expect(completion).toBeFocused();
      expect(queueRequests.filter((url) => url.searchParams.has("cursor"))).toHaveLength(2);
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
    } finally {
      await page.unroute("**/api/cases?**");
    }
  });

  test("reflows at 320px and retains keyboard focus in forced colors and reduced motion", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations responsive row");
    await createInvestigation(page, title);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/operations?q=${encodeURIComponent(title)}&coordinationScope=unassigned`);
    await expect(page.getByRole("heading", { name: "Operations Queue" })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

    const scope = page.getByRole("link", { name: /Unassigned/u });
    await scope.focus();
    await expect(scope).toBeFocused();
    expect(await scope.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");

    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await scope.focus();
    expect(await scope.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");

    await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const transitionDuration = await scope.evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transitionDuration.split(",").every((value) => value.trim() === "0s")).toBe(true);
  });
});
