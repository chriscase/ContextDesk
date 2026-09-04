import { expect, test, type Page } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const COLLECTION_QUERY_SCHEMA_ID = "cd-collab.investigation_collection_query.v1";
const ALL_STRATEGIES = ["war-room", "investigation-first", "keystone", "beacon"];

interface StrategyPolicy {
  revision: number;
  instance: {
    enabledIds: string[];
    visibleIds: string[];
    defaultId: string;
    selectionMode: "free" | "approved_subset";
    approvedIds: string[];
  };
  roleRules: Array<{
    role: "viewer" | "contributor" | "case-lead" | "admin";
    approvedIds: string[];
    defaultId: string | null;
  }>;
}

interface InvestigationCollectionPage {
  schemaId: string;
  items: Array<{ id: string; title: string; status: string }>;
  nextCursor: string | null;
  hiddenArchivedCount: number;
  facets: {
    status: { top: Array<{ key: string; count: number }>; otherCount: number };
  };
}

async function strategyPolicy(page: Page): Promise<StrategyPolicy> {
  const response = await page.request.get("/api/admin/ui-strategies");
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as StrategyPolicy;
}

async function setStrategyDefault(page: Page, defaultId: string): Promise<StrategyPolicy> {
  const previous = await strategyPolicy(page);
  const update = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: previous.revision,
      instance: {
        enabledIds: [...ALL_STRATEGIES],
        visibleIds: [...ALL_STRATEGIES],
        defaultId,
        selectionMode: "approved_subset",
        approvedIds: [],
      },
      roleRules: [],
    },
  });
  expect(update.ok(), await update.text()).toBeTruthy();
  return previous;
}

async function setWarRoomDefault(page: Page): Promise<StrategyPolicy> {
  return setStrategyDefault(page, "war-room");
}

async function restoreStrategyPolicy(page: Page, previous: StrategyPolicy): Promise<void> {
  const update = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: (await strategyPolicy(page)).revision,
      instance: previous.instance,
      roleRules: previous.roleRules,
    },
  });
  expect(update.ok(), await update.text()).toBeTruthy();
}

async function createInvestigation(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Collection query qualification record.",
      affectedParties: "Fixture operators",
      impact: "Qualification only",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id?: string };
  expect(body.id, "case creation did not return an id").toBeTruthy();
  return body.id!;
}

function collectionUrl(params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ schemaId: COLLECTION_QUERY_SCHEMA_ID, ...params });
  return `/api/cases?${search.toString()}`;
}

test.describe("Investigation collection query qualification", () => {
  test("returns a versioned, bounded page with server facts and an opaque cursor", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const token = `query-${Date.now()}`;
    const title = `Collection query ${token}`;
    await createInvestigation(page, title);

    const response = await page.request.get(collectionUrl({ q: token, status: "open", limit: "1" }));
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.json() as InvestigationCollectionPage;
    expect(body.schemaId).toBe("cd-collab.investigation_collection_page.v1");
    expect(body.items.map((item) => item.title)).toContain(title);
    expect(body.items.length).toBeLessThanOrEqual(1);
    expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
    expect(body.hiddenArchivedCount).toEqual(expect.any(Number));
    expect(body.facets.status.top.find((facet) => facet.key === "open")?.count).toBeGreaterThan(0);
  });

  test("drives Beacon from the canonical query URL and keeps an empty result explicit", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const previous = await setStrategyDefault(page, "beacon");
    try {
      const token = `beacon-${Date.now()}`;
      const title = `Beacon query ${token}`;
      await createInvestigation(page, title);
      const collectionRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET") return;
        const url = new URL(request.url());
        if (url.pathname === "/api/cases" && url.searchParams.get("schemaId") === COLLECTION_QUERY_SCHEMA_ID) {
          collectionRequests.push(request.url());
        }
      });

      await page.goto(`/investigations?q=${encodeURIComponent(token)}&status=open`);
      await expect(page.locator(".topbar__title-app")).toHaveText("Beacon");
      await expect(page.getByRole("heading", { name: "Capture the signal. Keep the trail." })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(title, "u") })).toBeVisible();
      await expect(page.getByRole("searchbox", { name: "Find an investigation" })).toHaveValue(token);
      await expect.poll(() => collectionRequests.length).toBeGreaterThan(0);
      const requested = new URL(collectionRequests.at(-1)!);
      expect(requested.searchParams.get("q")).toBe(token);
      expect(requested.searchParams.get("status")).toBe("open");

      await page.goto(`/investigations?q=${encodeURIComponent(`${token}-missing`)}&status=open`);
      await expect(page.getByText("No investigations match this search.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    } finally {
      await restoreStrategyPolicy(page, previous);
    }
  });

  test("keeps the opaque cursor runtime-owned while loading the next War Room page", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const previous = await setWarRoomDefault(page);
    let sourcePage: InvestigationCollectionPage | null = null;
    const queryRequests: URL[] = [];
    await page.route("**/api/cases?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.searchParams.get("schemaId") !== COLLECTION_QUERY_SCHEMA_ID) {
        await route.continue();
        return;
      }
      if (requestUrl.searchParams.has("cursor")) {
        if (sourcePage === null) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...sourcePage,
            items: sourcePage.items.slice(1, 2),
            nextCursor: null,
          }),
        });
        return;
      }
      const response = await route.fetch();
      sourcePage = await response.json() as InvestigationCollectionPage;
      await route.fulfill({
        response,
        json: {
          ...sourcePage,
          items: sourcePage.items.slice(0, 1),
          nextCursor: "eyJwYWdlIjoyfQ",
        },
      });
    });
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const requestUrl = new URL(request.url());
      if (requestUrl.pathname === "/api/cases" && requestUrl.searchParams.get("schemaId") === COLLECTION_QUERY_SCHEMA_ID) {
        queryRequests.push(requestUrl);
      }
    });
    try {
      const token = `war-room-page-${Date.now()}`;
      await createInvestigation(page, `${token} first`);
      await createInvestigation(page, `${token} second`);
      await page.goto(`/investigations?q=${encodeURIComponent(token)}`);
      await expect(page.getByRole("heading", { name: "Investigations" })).toBeVisible();
      await expect(page.locator(".case-card__open")).toHaveCount(1);
      const next = page.getByRole("button", { name: "Load next page" });
      await expect(next).toBeVisible();
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      await next.click();
      await expect.poll(() => queryRequests.some((requestUrl) => requestUrl.searchParams.get("cursor") === "eyJwYWdlIjoyfQ")).toBe(true);
      await expect(page.getByRole("button", { name: "Load next page" })).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
    } finally {
      await page.unroute("**/api/cases?**");
      await restoreStrategyPolicy(page, previous);
    }
  });

  test("keeps cursor continuation consistent across every registered strategy", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const strategies = [
      {
        id: "investigation-first",
        name: "Investigation First",
        row: ".investigation-first__list-button",
        title: "Make the next useful action obvious.",
      },
      {
        id: "keystone",
        name: "Keystone",
        row: ".keystone-strategy__collection-list button",
        title: "Investigations",
      },
      {
        id: "beacon",
        name: "Beacon",
        row: ".beacon__case-list button",
        title: "Capture the signal. Keep the trail.",
      },
    ] as const;
    let sourcePage: InvestigationCollectionPage | null = null;
    const queryRequests: URL[] = [];
    await page.route("**/api/cases?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.searchParams.get("schemaId") !== COLLECTION_QUERY_SCHEMA_ID) {
        await route.continue();
        return;
      }
      queryRequests.push(requestUrl);
      if (requestUrl.searchParams.has("cursor")) {
        if (sourcePage === null) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...sourcePage, items: sourcePage.items.slice(1, 2), nextCursor: null }),
        });
        return;
      }
      const response = await route.fetch();
      sourcePage = await response.json() as InvestigationCollectionPage;
      await route.fulfill({
        response,
        json: { ...sourcePage, items: sourcePage.items.slice(0, 1), nextCursor: "eyJwYWdlIjoyfQ" },
      });
    });
    try {
      for (const strategy of strategies) {
        const previous = await setStrategyDefault(page, strategy.id);
        sourcePage = null;
        queryRequests.length = 0;
        try {
          const token = `${strategy.id}-page-${Date.now()}`;
          await createInvestigation(page, `${token} first`);
          await createInvestigation(page, `${token} second`);
          await page.goto(`/investigations?q=${encodeURIComponent(token)}`);
          await expect(page.locator(".topbar__title-app")).toHaveText(strategy.name);
          await expect(page.getByRole("heading", { name: strategy.title })).toBeVisible();
          await expect(page.locator(strategy.row)).toHaveCount(1);
          const next = page.getByRole("button", { name: "Load next page" });
          await expect(next).toBeVisible();
          expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
          await next.click();
          await expect.poll(() => queryRequests.some((requestUrl) => requestUrl.searchParams.get("cursor") === "eyJwYWdlIjoyfQ")).toBe(true);
          await expect(page.getByRole("button", { name: "Load next page" })).toHaveCount(0);
          expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
        } finally {
          await restoreStrategyPolicy(page, previous);
        }
      }
    } finally {
      await page.unroute("**/api/cases?**");
    }
  });

  test("keeps collection failures explicit and never falls back to the legacy list", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const strategies = [
      {
        id: "investigation-first",
        name: "Investigation First",
        row: ".investigation-first__list-button",
        retry: "Retry loading investigations",
      },
      {
        id: "keystone",
        name: "Keystone",
        row: ".keystone-strategy__collection-list button",
        retry: "Retry loading investigations",
      },
      {
        id: "beacon",
        name: "Beacon",
        row: ".beacon__case-list button",
        retry: "Retry",
      },
    ] as const;
    const collectionRequests: string[] = [];
    await page.route("**/api/cases?**", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (request.method() !== "GET" || requestUrl.searchParams.get("schemaId") !== COLLECTION_QUERY_SCHEMA_ID) {
        await route.continue();
        return;
      }
      collectionRequests.push(request.url());
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary qualification outage" }),
      });
    });
    try {
      for (const strategy of strategies) {
        const previous = await setStrategyDefault(page, strategy.id);
        try {
          const token = `${strategy.id}-failure-${Date.now()}`;
          const title = `${token} should stay hidden`;
          await createInvestigation(page, title);
          collectionRequests.length = 0;
          await page.goto(`/investigations?q=${encodeURIComponent(token)}`);
          await expect(page.locator(".topbar__title-app")).toHaveText(strategy.name);
          await expect.poll(() => collectionRequests.length).toBe(1);
          await expect(page.getByRole("alert").first()).toBeVisible();
          await expect(page.getByRole("alert").first()).toContainText(/could not|unavailable|loaded/iu);
          await expect(page.locator(strategy.row)).toHaveCount(0);
          expect(new URL(page.url()).searchParams.get("q")).toBe(token);
          expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);

          await page.getByRole("button", { name: strategy.retry }).click();
          await expect.poll(() => collectionRequests.length).toBe(2);
          await expect(page.locator(strategy.row)).toHaveCount(0);
          await expect(page.getByRole("alert").first()).toBeVisible();
        } finally {
          await restoreStrategyPolicy(page, previous);
        }
      }
    } finally {
      await page.unroute("**/api/cases?**");
    }
  });

  test("uses server-owned status facets for canonical filters in every strategy", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const strategies = [
      {
        id: "investigation-first",
        name: "Investigation First",
        row: ".investigation-first__list-button",
      },
      {
        id: "keystone",
        name: "Keystone",
        row: ".keystone-strategy__collection-list button",
      },
      {
        id: "beacon",
        name: "Beacon",
        row: ".beacon__case-list button",
      },
    ] as const;
    try {
      for (const strategy of strategies) {
        const previous = await setStrategyDefault(page, strategy.id);
        try {
          const token = `${strategy.id}-facet-${Date.now()}`;
          await createInvestigation(page, `${token} open record`);
          const queryRequests: URL[] = [];
          page.on("request", (request) => {
            if (request.method() !== "GET") return;
            const requestUrl = new URL(request.url());
            if (requestUrl.pathname === "/api/cases" && requestUrl.searchParams.get("schemaId") === COLLECTION_QUERY_SCHEMA_ID) {
              queryRequests.push(requestUrl);
            }
          });

          await page.goto(`/investigations?q=${encodeURIComponent(token)}`);
          await expect(page.locator(".topbar__title-app")).toHaveText(strategy.name);
          await expect(page.locator(strategy.row)).toHaveCount(1);
          await expect.poll(() => queryRequests.length).toBeGreaterThan(0);
          const openFacet = page.getByRole("button", { name: /^open\b/iu });
          await expect(openFacet).toBeVisible();
          expect(new URL(page.url()).searchParams.has("status")).toBe(false);

          await openFacet.click();
          await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe("open");
          await expect.poll(() => queryRequests.some((requestUrl) => (
            requestUrl.searchParams.get("q") === token
            && requestUrl.searchParams.get("status") === "open"
          ))).toBe(true);
          await expect(page.locator(strategy.row)).toHaveCount(1);
          expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
        } finally {
          page.removeAllListeners("request");
          await restoreStrategyPolicy(page, previous);
        }
      }
    } finally {
      page.removeAllListeners("request");
    }
  });

  test("withholds both collection reads when every strategy is projected read-denied", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const strategies = ["investigation-first", "keystone", "beacon"] as const;
    const sessionResponse = await page.request.get("/api/auth/me");
    expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy();
    const session = await sessionResponse.json() as Record<string, unknown>;
    try {
      for (const strategy of strategies) {
        const previous = await setStrategyDefault(page, strategy);
        try {
          await loginAs(page, FIXTURE_USERS.carol);
          await page.waitForLoadState("networkidle");
          const caseReads: string[] = [];
          const recordCaseRead = (request: import("@playwright/test").Request) => {
            const requestUrl = new URL(request.url());
            if (request.method() === "GET" && (requestUrl.pathname === "/api/cases" || requestUrl.pathname.startsWith("/api/cases/"))) {
              caseReads.push(requestUrl.pathname);
            }
          };
          await page.route("**/api/auth/me", async (route) => {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ...session, capabilities: [] }),
            });
          });
          page.on("request", recordCaseRead);
          await page.goto("/investigations");
          await expect(page.getByText(/no investigation data was requested/iu).first()).toBeVisible();
          await expect.poll(() => caseReads).toEqual([]);
          await expect(page.getByRole("button", { name: /Retry/iu })).toHaveCount(0);
          page.off("request", recordCaseRead);
          await page.unroute("**/api/auth/me");
        } finally {
          await page.unroute("**/api/auth/me");
          await loginAs(page, FIXTURE_USERS.dave);
          await restoreStrategyPolicy(page, previous);
        }
      }
    } finally {
      await page.unroute("**/api/auth/me");
    }
  });
});
