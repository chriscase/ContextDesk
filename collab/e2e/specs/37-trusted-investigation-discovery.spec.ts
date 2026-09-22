import { expect, test, type Page, type Route } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const COLLECTION_QUERY_SCHEMA_ID = "cd-collab.investigation_collection_query.v1";
const OPAQUE_CURSOR = "eyJwYWdlIjoyfQ";
const CONTRIBUTOR_ID = "identity-carol";

interface CollectionItem {
  id: string;
  title: string;
}

interface CollectionPage {
  items: CollectionItem[];
  nextCursor: string | null;
  hiddenArchivedCount: number;
  facets: {
    status: { top: Array<{ key: string; count: number }>; otherCount: number };
    entity: { top: Array<{ key: string; count: number }>; otherCount: number };
    impactIdentity: {
      top: Array<{ key: string; count: number; identity: Record<string, string> }>;
      otherCount: number;
    };
    contributor: { top: Array<{ key: string; count: number }>; otherCount: number };
  };
}

const PRESENTATIONS = [
  {
    id: "war-room",
    name: "War Room",
    row: ".case-card__open",
    next: "investigation-first",
    nextName: "Investigation First",
    nextRow: ".investigation-first__list-button",
  },
  {
    id: "investigation-first",
    name: "Investigation First",
    row: ".investigation-first__list-button",
    next: "keystone",
    nextName: "Keystone",
    nextRow: ".keystone-strategy__collection-list button",
  },
  {
    id: "keystone",
    name: "Keystone",
    row: ".keystone-strategy__collection-list button",
    next: "beacon",
    nextName: "Beacon",
    nextRow: ".beacon__case-list button",
  },
  {
    id: "beacon",
    name: "Beacon",
    row: ".beacon__case-list button",
    next: "war-room",
    nextName: "War Room",
    nextRow: ".case-card__open",
  },
] as const;

async function strategyPolicy(page: Page) {
  const response = await page.request.get("/api/admin/ui-strategies");
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as {
    revision: number;
    instance: {
      enabledIds: string[];
      visibleIds: string[];
      defaultId: string;
      selectionMode: "free" | "approved_subset";
      approvedIds: string[];
    };
    roleRules: unknown[];
  };
}

async function enableEveryPresentation(page: Page) {
  const previous = await strategyPolicy(page);
  const update = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: previous.revision,
      instance: {
        enabledIds: PRESENTATIONS.map((item) => item.id),
        visibleIds: PRESENTATIONS.map((item) => item.id),
        defaultId: previous.instance.defaultId,
        selectionMode: "free",
        approvedIds: PRESENTATIONS.map((item) => item.id),
      },
      roleRules: [],
    },
  });
  expect(update.ok(), await update.text()).toBeTruthy();
  return previous;
}

async function restoreStrategyPolicy(page: Page, previous: Awaited<ReturnType<typeof strategyPolicy>>) {
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

async function selectExperience(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.dave.username}` }).click();
  const strategy = page.getByRole("radio", { name: new RegExp(`^${name}\\b`, "u") });
  if (!(await strategy.isChecked())) {
    await strategy.check();
    await page.getByRole("button", { name: "Use selected experience" }).click();
  }
  await expect(page.locator(".topbar__title-app")).toHaveText(name);
  await page.keyboard.press("Escape");
}

test.describe("trusted investigation discovery journey", () => {
  for (const presentation of PRESENTATIONS) {
    test(`filters, reloads, switches, and opens from ${presentation.name}`, async ({ page }) => {
      test.setTimeout(90_000);
      await loginAs(page, FIXTURE_USERS.dave);
      const previous = await enableEveryPresentation(page);
      const token = `disc${Date.now().toString(36)}`;
      const impact = {
        productName: `Desk${token}`,
        version: "1.0",
        build: "",
        component: "worker",
        environment: "",
      };
      const titles = [`${token} alpha`, `${token} beta`];
      const ids: string[] = [];
      try {
        for (const title of titles) {
          const created = await page.request.post("/api/cases", {
            headers: BROWSER_MUTATION_HEADERS,
            data: {
              title,
              problemStatement: "Synthetic discovery record.",
              affectedParties: "Fixture operators",
              impact: "Qualification only",
            },
          });
          expect(created.ok(), await created.text()).toBeTruthy();
          const body = await created.json() as { id?: string };
          expect(body.id).toBeTruthy();
          ids.push(body.id!);
          const impactResponse = await page.request.post(`/api/cases/${body.id}/software-impact`, {
            headers: BROWSER_MUTATION_HEADERS,
            data: { ...impact, status: "observed", note: "Synthetic impact" },
          });
          expect(impactResponse.ok(), await impactResponse.text()).toBeTruthy();
          const participant = await page.request.post(`/api/cases/${body.id}/participants`, {
            headers: BROWSER_MUTATION_HEADERS,
            data: {
              identityId: CONTRIBUTOR_ID,
              username: FIXTURE_USERS.carol.username,
            },
          });
          expect(participant.ok(), await participant.text()).toBeTruthy();
        }

        let sourcePage: CollectionPage | null = null;
        const continuePage = async (route: Route) => {
          const requestUrl = new URL(route.request().url());
          if (requestUrl.searchParams.get("schemaId") !== COLLECTION_QUERY_SCHEMA_ID) {
            await route.continue();
            return;
          }
          if (requestUrl.searchParams.has("cursor")) {
            expect(sourcePage).not.toBeNull();
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ...sourcePage,
                items: sourcePage!.items.slice(1, 2),
                nextCursor: null,
              }),
            });
            return;
          }
          const response = await route.fetch();
          sourcePage = await response.json() as CollectionPage;
          await route.fulfill({
            response,
            json: {
              ...sourcePage,
              items: sourcePage.items.slice(0, 1),
              nextCursor: OPAQUE_CURSOR,
            },
          });
        };
        await page.route("**/api/cases?**", continuePage);

        await page.goto("/investigations");
        await selectExperience(page, presentation.name);
        await page.goto(`/investigations?q=${encodeURIComponent(token)}`);
        const impactSelect = page.getByLabel("Filter investigations by software impact");
        await expect.poll(async () => impactSelect.locator("option", { hasText: impact.productName }).count()).toBeGreaterThan(0);
        await impactSelect.selectOption({ label: await impactSelect.locator("option", { hasText: impact.productName }).innerText() });
        const contributorSelect = page.getByLabel("Filter investigations by contributor");
        await expect.poll(async () => contributorSelect.locator("option", { hasText: CONTRIBUTOR_ID }).count()).toBeGreaterThan(0);
        await contributorSelect.selectOption(CONTRIBUTOR_ID);
        const recordedDay = new Date().toISOString().slice(0, 10);
        await page.getByLabel("Filter investigations by recorded date from").fill(recordedDay);
        await page.getByLabel("Filter investigations by recorded date to").fill(recordedDay);
        await expect(page.getByLabel("Filter investigations by involved entity")).toBeVisible();
        await expect(page.getByText("Observed from")).toHaveCount(presentation.id === "war-room" ? 1 : 0);

        await expect.poll(() => sourcePage?.items.length ?? 0).toBeGreaterThanOrEqual(2);
        const serverPage = sourcePage!;
        const first = serverPage.items[0]!;
        const second = serverPage.items[1]!;
        const impactFacet = serverPage.facets.impactIdentity.top.find((bucket) => bucket.key.includes(impact.productName));
        const contributorFacet = serverPage.facets.contributor.top.find((bucket) => bucket.key === CONTRIBUTOR_ID);
        expect(impactFacet?.count).toBeGreaterThan(0);
        expect(contributorFacet?.count).toBeGreaterThan(0);
        await expect(page.getByRole("option", { name: `${impactFacet!.key} (${impactFacet!.count})` })).toHaveCount(1);
        await expect(page.getByRole("option", { name: `${contributorFacet!.key} (${contributorFacet!.count})` })).toHaveCount(1);
        await expect(page.locator(presentation.row).filter({ hasText: first.title })).toBeVisible();
        await expect(page.locator(presentation.row).filter({ hasText: second.title })).toHaveCount(0);

        const shared = new URL(page.url());
        expect(shared.searchParams.get("q")).toBe(token);
        expect(shared.searchParams.get("contributorId")).toBe(CONTRIBUTOR_ID);
        expect(shared.searchParams.get("recordedFrom")).toBe(`${recordedDay}T00:00:00.000Z`);
        expect(shared.searchParams.get("recordedTo")).toBe(`${recordedDay}T23:59:59.999Z`);
        expect(shared.searchParams.get("impactIdentity")).toContain(impact.productName);
        for (const forbidden of ["cursor", "limit", "schemaId"]) {
          expect(shared.searchParams.has(forbidden)).toBe(false);
        }

        await page.reload();
        await expect(page.locator(presentation.row).filter({ hasText: first.title })).toBeVisible();
        expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
        expect(page.url()).toContain("contributorId=");

        await selectExperience(page, presentation.nextName);
        await expect(page.locator(presentation.nextRow).filter({ hasText: first.title })).toBeVisible();
        expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
        await page.getByRole("button", { name: "Load next page" }).click();
        await expect(page.locator(presentation.nextRow).filter({ hasText: second.title })).toBeVisible();
        expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
        await page.locator(presentation.nextRow).filter({ hasText: second.title }).click();
        await expect(page).toHaveURL(new RegExp(`/investigations/${second.id}/`, "u"));
        await expect(page.getByText(second.title).first()).toBeVisible();
      } finally {
        await page.unroute("**/api/cases?**");
        await restoreStrategyPolicy(page, previous);
      }
    });
  }
});
