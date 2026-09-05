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
    // Finish the Overview activity request before attributing collection reads
    // to the Operations navigation below.
    await page.waitForLoadState("networkidle");
    const preferenceWrites: string[] = [];
    const caseReads: URL[] = [];
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (request.method() === "PUT" && requestUrl.pathname === "/api/ui-strategies/preference") {
        preferenceWrites.push(request.url());
      }
      if (request.method() === "GET" && requestUrl.pathname === "/api/cases") {
        caseReads.push(requestUrl);
      }
    });

    await page.goto(
      `/operations?q=${encodeURIComponent(title)}&status=open&coordinationScope=unassigned`
        + "&cursor=must-not-survive&limit=1&entityId=hidden&unexpected=yes",
    );
    await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
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
    expect(caseReads).toHaveLength(1);
    expect(isQueueRequest(caseReads[0]!)).toBe(true);
    expect(caseReads[0]!.searchParams.has("cursor")).toBe(false);
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
    await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: new RegExp(title, "u") })).toBeVisible();
    expect(preferenceWrites).toEqual([]);
  });

  test("preserves server order and focus through failed and successful continuation", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const token = `operations-page-${Date.now()}`;
    await createInvestigation(page, `${token} first`);
    await createInvestigation(page, `${token} second`);
    await createInvestigation(page, `${token} third`);
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
            items: continuationAttempts === 2
              ? source!.items.slice(1, 2)
              : source!.items.slice(2, 3),
            nextCursor: continuationAttempts === 2 ? "eyJwYWdlIjozfQ" : null,
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
      await expect.poll(() => source?.items.length ?? 0).toBeGreaterThanOrEqual(3);
      const expected = source!.items.slice(0, 3).map((row) => row.investigation.title);
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
      await expect(loadMore).toBeFocused();
      await loadMore.press("Enter");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(2)).toContainText(expected[2]!);
      const completion = page.getByText("All operations are shown.");
      await expect(completion).toBeFocused();
      const search = page.getByRole("searchbox", { name: "Search" });
      await search.focus();
      await search.pressSequentially("x");
      await expect(search).toBeFocused();
      expect(queueRequests
        .filter((url) => url.searchParams.has("cursor"))
        .map((url) => url.searchParams.get("cursor")))
        .toEqual(["eyJwYWdlIjoyfQ", "eyJwYWdlIjoyfQ", "eyJwYWdlIjozfQ"]);
      expect(queueRequests).toHaveLength(4);
      expect(queueRequests.filter((url) => !url.searchParams.has("cursor"))).toHaveLength(1);
      for (const requestUrl of queueRequests) {
        expect(requestUrl.searchParams.get("q")).toBe(token);
        expect(requestUrl.searchParams.get("coordinationScope")).toBe("unassigned");
      }
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
    } finally {
      await page.unroute("**/api/cases?**");
    }
  });

  test("recovers focus and restarts at page one after a concealed continuation failure", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const token = `operations-concealed-${Date.now()}`;
    await createInvestigation(page, token);
    let cursorRequests = 0;
    let baseRequests = 0;

    await page.route("**/api/cases?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (!isQueueRequest(requestUrl)) {
        await route.continue();
        return;
      }
      if (requestUrl.searchParams.has("cursor")) {
        cursorRequests += 1;
        await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
        return;
      }
      baseRequests += 1;
      const response = await route.fetch();
      const source = await response.json() as QueuePage;
      await route.fulfill({
        response,
        json: { ...source, items: source.items.slice(0, 1), nextCursor: "eyJwYWdlIjoyfQ" },
      });
    });

    try {
      await page.goto(`/operations?q=${encodeURIComponent(token)}&coordinationScope=unassigned`);
      const loadMore = page.getByRole("button", { name: "Load more operations" });
      await loadMore.focus();
      await loadMore.press("Enter");

      const unavailable = page.getByRole("alert");
      await expect(unavailable).toContainText("No legacy investigation list was substituted");
      await expect(unavailable).toBeFocused();
      await expect(page.getByRole("button", { name: "Try loading more" })).toHaveCount(0);
      await unavailable.getByRole("button", { name: "Try again" }).press("Enter");
      await expect(page.getByRole("button", { name: "Load more operations" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeFocused();
      expect(cursorRequests).toBe(1);
      expect(baseRequests).toBe(2);
    } finally {
      await page.unroute("**/api/cases?**");
    }
  });

  test("keeps denied and failed first loads truthful without legacy case reads", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.carol);
    await page.waitForLoadState("networkidle");
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
    const deniedReads: URL[] = [];
    const recordDeniedReads = (request: import("@playwright/test").Request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && (url.pathname === "/api/cases" || url.pathname.startsWith("/api/cases/"))) {
        deniedReads.push(url);
      }
    };
    page.on("request", recordDeniedReads);
    try {
      await page.goto("/operations");
      await expect(page.getByText(/no queue data was requested/u)).toBeVisible();
      await expect(page.getByRole("button", { name: /retry|try again/iu })).toHaveCount(0);
      expect(deniedReads).toEqual([]);
    } finally {
      page.off("request", recordDeniedReads);
      await page.unroute("**/api/auth/me");
    }

    await loginAs(page, FIXTURE_USERS.dave);
    await page.waitForLoadState("networkidle");
    const failedReads: URL[] = [];
    const recordFailedReads = (request: import("@playwright/test").Request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/cases") failedReads.push(url);
    };
    page.on("request", recordFailedReads);
    await page.route("**/api/cases?**", async (route) => {
      const url = new URL(route.request().url());
      if (isQueueRequest(url)) {
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      } else {
        await route.continue();
      }
    });
    try {
      await page.goto("/operations");
      await expect(page.getByText("Operations Queue service is unavailable")).toBeVisible();
      await expect(page.getByText(/No legacy investigation list was substituted/u)).toBeVisible();
      expect(failedReads).toHaveLength(1);
      expect(isQueueRequest(failedReads[0]!)).toBe(true);
      await page.getByRole("button", { name: "Try again" }).click();
      await expect.poll(() => failedReads.length).toBe(2);
      expect(failedReads.every(isQueueRequest)).toBe(true);
      await expect(page.getByText(/No legacy investigation list was substituted/u)).toBeVisible();
      await expect(page.getByRole("list", { name: "Operations queue investigations" })).toHaveCount(0);
    } finally {
      page.off("request", recordFailedReads);
      await page.unroute("**/api/cases?**");
    }
  });

  test("reflows at 320px and retains keyboard focus in forced colors and reduced motion", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations responsive row");
    await createInvestigation(page, title);
    const longCoordinator = "coordinator".repeat(12).slice(0, 128);
    await page.route("**/api/cases?**", async (route) => {
      const url = new URL(route.request().url());
      if (!isQueueRequest(url)) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json() as QueuePage;
      await route.fulfill({
        response,
        json: {
          ...body,
          coordinationScopeCounts: {
            ...body.coordinationScopeCounts,
            mine: 0,
            unassigned: 0,
          },
          items: body.items.map((row, index) => index === 0
            ? {
                ...row,
                coordination: {
                  ...row.coordination,
                  coordinator: { identityId: "identity-long-coordinator", username: longCoordinator },
                  revision: 1,
                  updatedAt: "2026-09-04T08:30:00-05:00",
                  updatedBy: { identityId: "identity-long-coordinator", username: longCoordinator },
                },
              }
            : row),
        },
      });
    });
    await page.setViewportSize({ width: 320, height: 720 });
    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
      const coordinatorFact = page.getByText(`Coordinator: ${longCoordinator}`);
      await expect(coordinatorFact).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
      expect(await coordinatorFact.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

      const scope = page.getByRole("link", { name: /All visible/u });
      await scope.focus();
      await expect(scope).toBeFocused();
      expect(await scope.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");

      await page.emulateMedia({ forcedColors: "active" });
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      await scope.focus();
      expect(await scope.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      const inactiveScope = page.getByRole("link", { name: /Unassigned/u });
      expect(await scope.evaluate((element) => getComputedStyle(element).backgroundColor))
        .not.toBe(await inactiveScope.evaluate((element) => getComputedStyle(element).backgroundColor));

      await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      const transitionDuration = await scope.evaluate((element) => getComputedStyle(element).transitionDuration);
      expect(transitionDuration.split(",").every((value) => value.trim() === "0s")).toBe(true);
      const row = page.getByRole("link", { name: new RegExp(title, "u") });
      const rowTransitionDuration = await row.evaluate((element) => getComputedStyle(element).transitionDuration);
      expect(rowTransitionDuration.split(",").every((value) => value.trim() === "0s")).toBe(true);
    } finally {
      await page.unroute("**/api/cases?**");
    }
  });
});
