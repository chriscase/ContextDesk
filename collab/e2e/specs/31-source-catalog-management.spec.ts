import { expect, test, type Page, type Request } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

const CATALOG_ROUTE = "/api/catalog/sources";
const PERMANENT_UNKNOWN_SOURCE_ID = "00000000-0000-0000-0000-000000000001";
const SOURCE_CREATE_REQUEST_SCHEMA_ID = "cd-collab.source_create_request.v1";
const SOURCE_RETIRE_REQUEST_SCHEMA_ID = "cd-collab.source_retire_request.v1";
const SOURCE_RESTORE_REQUEST_SCHEMA_ID = "cd-collab.source_restore_request.v1";
const SOURCE_MUTATION_SUCCESS_SCHEMA_ID = "cd-collab.source_mutation_success.v1";

interface SourceMutationBody {
  readonly schemaId: string;
  readonly sourceId?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly description?: string | null;
  readonly identityId?: string | null;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

interface SourceMutationSuccess {
  readonly schemaId: string;
  readonly action: "create" | "retire" | "restore";
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly appliedRevision: number;
  readonly replayed: boolean;
  readonly applied: {
    readonly id: string;
    readonly name: string;
    readonly lifecycle: "active" | "retired";
    readonly revision: number;
  };
}

function isCatalogRequest(request: Request): boolean {
  const url = new URL(request.url());
  return url.pathname === CATALOG_ROUTE || url.pathname.startsWith(`${CATALOG_ROUTE}/`);
}

function catalogRow(page: Page, name: string) {
  return page.getByRole("list", { name: "Attribution labels" })
    .getByRole("listitem")
    .filter({ hasText: name });
}

function mutationBody(request: Request): SourceMutationBody {
  return request.postDataJSON() as SourceMutationBody;
}

async function createStrictSource(page: Page, name: string): Promise<SourceMutationSuccess> {
  const response = await page.request.post(CATALOG_ROUTE, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name,
      kind: "external-tool",
      description: "Synthetic source for browser qualification.",
      identityId: null,
      expectedRevision: 0,
      idempotencyKey: `source-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json() as SourceMutationSuccess;
  expect(body.schemaId).toBe(SOURCE_MUTATION_SUCCESS_SCHEMA_ID);
  expect(body.action).toBe("create");
  expect(body.appliedRevision).toBe(1);
  return body;
}

test.describe("Source Catalog Console", () => {
  test("gates denied users before transport and separates browse from write authority", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.carol);
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
    const deniedCalls: string[] = [];
    const recordDenied = (request: Request) => {
      if (isCatalogRequest(request)) deniedCalls.push(`${request.method()} ${request.url()}`);
    };
    page.on("request", recordDenied);
    await page.goto("/sources");
    const denied = page.getByRole("status").filter({ hasText: "no catalog data was requested" });
    await expect(denied).toBeVisible();
    await expect(page.locator(".source-catalog")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("button", { name: /try|retry/iu })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add|retire|restore/iu })).toHaveCount(0);
    expect(deniedCalls).toEqual([]);
    page.off("request", recordDenied);

    await page.unroute("**/api/auth/me");
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...session,
          capabilities: ["investigation:read", "run:strategies"],
        }),
      });
    });
    const viewerCalls: string[] = [];
    const recordViewer = (request: Request) => {
      if (isCatalogRequest(request)) viewerCalls.push(request.method());
    };
    page.on("request", recordViewer);
    try {
      await page.goto("/sources");
      await expect(catalogRow(page, SEEDED_SOURCES.chatA)).toBeVisible();
      await expect(page.getByRole("note")).toContainText("requires catalog write access");
      await expect(page.getByRole("button", { name: "Add label" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Retire|Restore/u })).toHaveCount(0);
      expect(viewerCalls).toEqual(["GET"]);
    } finally {
      page.off("request", recordViewer);
      await page.unroute("**/api/auth/me");
    }
  });

  test("keeps a list failure distinct from empty and retries without exposing response text", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.carol);
    let attempts = 0;
    const privateMarker = "private-catalog-database-diagnostic";
    await page.route("**/api/catalog/sources", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal", detail: privateMarker }),
        });
        return;
      }
      await route.continue();
    });
    try {
      await page.goto("/sources");
      const failure = page.getByRole("alert");
      await expect(failure).toContainText("could not be loaded or validated");
      await expect(page.getByText("No attribution labels are registered yet")).toHaveCount(0);
      await expect(page.getByText(privateMarker)).toHaveCount(0);
      await failure.getByRole("button", { name: "Try loading the catalog again" }).press("Enter");
      await expect(catalogRow(page, SEEDED_SOURCES.chatA)).toBeVisible();
      expect(attempts).toBe(2);
    } finally {
      await page.unroute("**/api/catalog/sources");
    }
  });

  test("creates, retires, and restores a versioned label with strict CAS requests", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.erin);
    await page.goto("/sources");
    await expect(catalogRow(page, SEEDED_SOURCES.chatA)).toBeVisible();

    const unknown = catalogRow(page, "Unknown");
    await expect(unknown).toContainText("Permanent · protected");
    await expect(unknown).toContainText("Legacy record · read-only");
    await expect(unknown.getByRole("button", { name: /Retire|Restore/u })).toHaveCount(0);
    const legacy = catalogRow(page, SEEDED_SOURCES.chatA);
    await expect(legacy).toContainText("Legacy record · read-only");
    await expect(legacy.getByRole("button", { name: /Retire|Restore/u })).toHaveCount(0);

    const name = uniqueTitle("Catalog lifecycle source");
    await page.getByRole("combobox", { name: "Source kind" }).selectOption("internal-system");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await page.getByRole("textbox", { name: /Description/u }).fill("Fixture system used by the on-call team.");
    const createResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(CATALOG_ROUTE)
      && response.request().method() === "POST"
      && response.request().postDataJSON()?.schemaId === SOURCE_CREATE_REQUEST_SCHEMA_ID
    );
    await page.getByRole("button", { name: "Add label" }).press("Enter");
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const createRequest = mutationBody(createResponse.request());
    expect(createRequest).toMatchObject({
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name,
      kind: "internal-system",
      description: "Fixture system used by the on-call team.",
      identityId: null,
      expectedRevision: 0,
    });
    expect(createRequest.idempotencyKey).toMatch(/^source-[0-9a-f-]{36}$/u);
    expect(createResponse.request().headers()["x-cd-collab-csrf"]).toBe("1");
    const created = await createResponse.json() as SourceMutationSuccess;
    expect(created).toMatchObject({
      schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
      action: "create",
      sourceId: created.applied.id,
      expectedRevision: 0,
      appliedRevision: 1,
      replayed: false,
      applied: { name, lifecycle: "active", revision: 1 },
    });
    const addedNotice = page.getByRole("status").filter({ hasText: `Added ${name}.` });
    await expect(addedNotice).toBeFocused();
    await addedNotice.getByRole("button", { name: "Dismiss" }).click();

    const activeRow = catalogRow(page, name);
    await expect(activeRow).toContainText("Active");
    await activeRow.getByRole("button", { name: new RegExp(`^Retire ${name}`, "u") }).press("Enter");
    await expect(activeRow).toContainText("Past attribution is preserved");
    const retireResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/${created.sourceId}/retire`)
      && response.request().method() === "POST"
    );
    await activeRow.getByRole("button", { name: `Confirm retire ${name}` }).press("Enter");
    const retireResponse = await retireResponsePromise;
    expect(retireResponse.status()).toBe(200);
    expect(mutationBody(retireResponse.request())).toMatchObject({
      schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
      sourceId: created.sourceId,
      expectedRevision: 1,
    });
    const retiredNotice = page.getByRole("status").filter({ hasText: `Retired ${name}.` });
    await expect(retiredNotice).toBeFocused();
    await retiredNotice.getByRole("button", { name: "Dismiss" }).click();
    const retiredRow = catalogRow(page, name);
    await expect(retiredRow).toContainText("Retired");

    const restoreResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/${created.sourceId}/restore`)
      && response.request().method() === "POST"
    );
    await retiredRow.getByRole("button", { name: `Restore ${name}` }).press("Enter");
    const restoreResponse = await restoreResponsePromise;
    expect(restoreResponse.status()).toBe(200);
    expect(mutationBody(restoreResponse.request())).toMatchObject({
      schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
      sourceId: created.sourceId,
      expectedRevision: 2,
    });
    const restoredNotice = page.getByRole("status").filter({ hasText: `Restored ${name}.` });
    await expect(restoredNotice).toBeFocused();
    await expect(catalogRow(page, name)).toContainText("Active");
  });

  test("reconciles a stale lifecycle action from the authoritative 409 record", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.erin);
    const name = uniqueTitle("Catalog conflict source");
    const created = await createStrictSource(page, name);
    await page.goto("/sources");
    const staleRow = catalogRow(page, name);
    await expect(staleRow).toContainText("Active");

    const external = await page.request.post(`${CATALOG_ROUTE}/${created.sourceId}/retire`, {
      headers: BROWSER_MUTATION_HEADERS,
      data: {
        schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
        sourceId: created.sourceId,
        expectedRevision: 1,
        idempotencyKey: `source-external-${Date.now()}`,
      },
    });
    expect(external.status(), await external.text()).toBe(200);

    const uiMutations: Request[] = [];
    const recordMutation = (request: Request) => {
      if (request.method() === "POST" && request.url().endsWith(`/${created.sourceId}/retire`)) {
        uiMutations.push(request);
      }
    };
    page.on("request", recordMutation);
    try {
      await staleRow.getByRole("button", { name: new RegExp(`^Retire ${name}`, "u") }).click();
      const refusalPromise = page.waitForResponse((response) =>
        response.url().endsWith(`/${created.sourceId}/retire`)
        && response.request().method() === "POST"
      );
      await staleRow.getByRole("button", { name: `Confirm retire ${name}` }).click();
      const refusalResponse = await refusalPromise;
      expect(refusalResponse.status()).toBe(409);
      expect(mutationBody(refusalResponse.request())).toMatchObject({
        schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
        sourceId: created.sourceId,
        expectedRevision: 1,
      });
      const alert = page.getByRole("alert").filter({ hasText: "latest confirmed record is shown" });
      await expect(alert).toBeFocused();
      await expect(alert).toContainText("already retired");
      const reconciled = catalogRow(page, name);
      await expect(reconciled).toContainText("Retired");
      await expect(reconciled.getByRole("button", { name: `Restore ${name}` })).toBeVisible();
      expect(uiMutations).toHaveLength(1);
    } finally {
      page.off("request", recordMutation);
    }
  });

  test("retries a post-commit 503 with the exact frozen payload and idempotency key", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.erin);
    await page.goto("/sources");
    await expect(catalogRow(page, SEEDED_SOURCES.chatA)).toBeVisible();
    const name = uniqueTitle("Catalog uncertain source");
    const bodies: SourceMutationBody[] = [];
    let replayed: SourceMutationSuccess | null = null;
    await page.route("**/api/catalog/sources", async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST"
        || request.postDataJSON()?.schemaId !== SOURCE_CREATE_REQUEST_SCHEMA_ID
      ) {
        await route.continue();
        return;
      }
      bodies.push(mutationBody(request));
      const response = await route.fetch();
      if (bodies.length === 1) {
        expect(response.status()).toBe(201);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "commit_outcome_unknown" }),
        });
        return;
      }
      expect(response.status()).toBe(200);
      replayed = await response.json() as SourceMutationSuccess;
      await route.fulfill({ response });
    });
    try {
      const nameField = page.getByRole("textbox", { name: "Name", exact: true });
      const descriptionField = page.getByRole("textbox", { name: /Description/u });
      await nameField.fill(name);
      await descriptionField.fill("Response deliberately replaced after commit.");
      await page.getByRole("button", { name: "Add label" }).click();
      const uncertain = page.getByRole("alert").filter({ hasText: "may have completed this action" });
      await expect(uncertain).toBeFocused();
      await expect(nameField).toHaveValue(name);
      await expect(descriptionField).toHaveValue("Response deliberately replaced after commit.");
      await expect(nameField).toBeDisabled();
      await expect(descriptionField).toBeDisabled();
      expect(await page.locator("body").innerText()).not.toContain(bodies[0]!.idempotencyKey);

      await uncertain.getByRole("button", { name: "Retry the same request" }).press("Enter");
      await expect(catalogRow(page, name)).toHaveCount(1);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({
        schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
        name,
        expectedRevision: 0,
      });
      expect(replayed).toMatchObject({
        schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
        action: "create",
        replayed: true,
        applied: { name, lifecycle: "active", revision: 1 },
      });
      await expect(page.getByRole("status").filter({ hasText: `Added ${name}.` })).toBeFocused();
    } finally {
      await page.unroute("**/api/catalog/sources");
    }
  });

  test("tears down the protected tree on a catalog read 401", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await page.goto("/sources");
    await expect(catalogRow(page, SEEDED_SOURCES.chatA)).toBeVisible();
    const marker = "private-read-auth-body";
    await page.route("**/api/catalog/sources", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthenticated", detail: marker }),
        });
      } else {
        await route.continue();
      }
    });
    try {
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page).toHaveURL(/\/signin$/u);
      await expect(page.locator(".source-catalog")).toHaveCount(0);
      await expect(page.getByText(marker)).toHaveCount(0);
    } finally {
      await page.unroute("**/api/catalog/sources");
    }
  });

  test("tears down the protected tree on a catalog mutation 403", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.erin);
    await page.goto("/sources");
    await expect(catalogRow(page, SEEDED_SOURCES.chatA)).toBeVisible();
    const marker = "private-write-auth-body";
    await page.route("**/api/catalog/sources", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "forbidden", detail: marker }),
        });
      } else {
        await route.continue();
      }
    });
    try {
      await page.getByRole("textbox", { name: "Name", exact: true })
        .fill(uniqueTitle("Catalog denied write"));
      await page.getByRole("button", { name: "Add label" }).click();
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page).toHaveURL(/\/signin$/u);
      await expect(page.locator(".source-catalog")).toHaveCount(0);
      await expect(page.getByText(marker)).toHaveCount(0);
    } finally {
      await page.unroute("**/api/catalog/sources");
    }
  });

  test("remains compact, semantic, keyboard-visible, and reflow-safe", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const name = `${uniqueTitle("Long catalog source")} ${"source-segment-".repeat(9)}`.slice(0, 190);
    await createStrictSource(page, name);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/sources");

    const root = page.getByRole("region", { name: "Attribution labels" });
    await expect(root).toBeVisible();
    await expect(page.getByRole("search")).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search" });
    const kind = page.getByRole("combobox", { name: "Kind", exact: true });
    const lifecycle = page.getByRole("combobox", { name: "Lifecycle" });
    await expect(kind).toBeVisible();
    await expect(lifecycle).toBeVisible();
    await expect(page.getByRole("list", { name: "Attribution labels" })).toBeVisible();
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);

    await search.focus();
    await search.pressSequentially(name.slice(0, 28));
    await expect(search).toBeFocused();
    const row = catalogRow(page, name);
    await expect(row).toBeVisible();
    await expect(row).toContainText("External tool");
    await expect(row).toContainText("Active");
    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(await row.locator("strong").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await search.focus();
    await expect(search).toBeFocused();
    expect(await search.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
    await kind.focus();
    expect(await kind.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");

    await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    for (const control of [search, kind, lifecycle]) {
      const durations = await control.evaluate((node) => getComputedStyle(node).transitionDuration);
      expect(durations.split(",").every((value) => value.trim() === "0s")).toBe(true);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(390);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add label" })).toBeVisible();
  });

  test("keeps the permanent Unknown identity stable in the real fixture", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const response = await page.request.get(CATALOG_ROUTE);
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.json() as {
      sources: Array<{ id: string; name: string; lifecycle: string }>;
    };
    expect(body.sources.find(({ id }) => id === PERMANENT_UNKNOWN_SOURCE_ID)).toEqual(
      expect.objectContaining({ name: "Unknown", lifecycle: "active" }),
    );
  });
});
