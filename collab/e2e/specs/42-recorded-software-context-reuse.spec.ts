import { expect, test, type Locator, type Page } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";
import { expectForcedColors, expectReducedMotion } from "../src/investigation-strategy/conformance.js";

const PRESENTATIONS = ["war-room", "investigation-first", "keystone", "beacon"] as const;
type Presentation = (typeof PRESENTATIONS)[number];
const NAMES: Record<Presentation, string> = {
  "war-room": "War Room", "investigation-first": "Investigation First", keystone: "Keystone", beacon: "Beacon",
};

interface StrategyPolicy {
  revision: number;
  instance: { enabledIds: string[]; visibleIds: string[]; defaultId: string; selectionMode: "free" | "approved_subset"; approvedIds: string[] };
  roleRules: unknown[];
}

async function policy(page: Page): Promise<StrategyPolicy> {
  const response = await page.request.get("/api/admin/ui-strategies");
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as StrategyPolicy;
}

async function setPolicy(page: Page, instance: StrategyPolicy["instance"], roleRules: unknown[]): Promise<void> {
  const response = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: { schemaId: "cd-collab.ui_strategy_policy_update.v1", expectedRevision: (await policy(page)).revision, instance, roleRules },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function selectPresentation(page: Page, name: string): Promise<void> {
  const account = page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.dave.username}` });
  await account.click();
  const option = page.getByRole("radio", { name: new RegExp(`^${name}\\b`, "u") });
  await expect(option).toBeVisible();
  if (!(await option.isChecked())) {
    await option.check();
    await page.getByRole("button", { name: "Use selected experience" }).click();
  }
  await expect(page.locator(".topbar__title-app")).toHaveText(name);
  await page.keyboard.press("Escape");
  if ((await account.getAttribute("aria-expanded")) === "true") await account.click();
  await expect(account).toHaveAttribute("aria-expanded", "false");
}

async function seed(page: Page, title: string, productName: string, version: string, build: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: { title, problemStatement: "Synthetic recorded software context qualification.",
      investigationContext: { productName, version, build, component: "synthetic-worker", environment: "test", organization: "Synthetic Team" } },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id: string };
  return body.id;
}

function createForm(page: Page, presentation: "war-room" | "investigation-first" | "beacon"): Locator {
  if (presentation === "war-room") return page.getByRole("form", { name: "Start a new investigation" });
  if (presentation === "investigation-first") return page.locator(".investigation-first__create form");
  return page.locator(".beacon__create-form");
}

function productLabel(presentation: "war-room" | "investigation-first" | "beacon"): string {
  return presentation === "war-room" ? "Investigation context: Software or product"
    : presentation === "beacon" ? "Product" : "Product or software";
}

test.describe("recorded software context reuse", () => {
  test("creates through three presentations, deliberately edits in Keystone, and reopens canonical context", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await policy(page);
    await setPolicy(page, { ...original.instance, enabledIds: [...PRESENTATIONS], visibleIds: [...PRESENTATIONS],
      selectionMode: "free", approvedIds: [...PRESENTATIONS] }, []);
    const token = uniqueTitle("recorded-context").replaceAll(" ", "-");
    const alpha = `FixtureDesk-${token}`;
    const beta = `OtherDesk-${token}`;
    try {
      await seed(page, `${token}-source-a`, alpha, "v1", "build-A");
      await seed(page, `${token}-source-b`, beta, "v9", "build-B");
      const createdIds: string[] = [];
      for (const presentation of ["war-room", "investigation-first", "beacon"] as const) {
        console.log(`Goal 08 browser: create in ${presentation}`);
        await page.goto("/investigations");
        await selectPresentation(page, NAMES[presentation]);
        const form = createForm(page, presentation);
        await expect(form).toBeVisible();
        if (presentation === "investigation-first") await form.getByText("Advanced context").click();
        if (presentation === "beacon") await form.getByText("Optional technical context").click();
        const product = form.getByRole("combobox", { name: productLabel(presentation), exact: true });
        await expect(product).toBeVisible();
        await product.fill("No matching product in loaded records");
        const version = form.getByRole("combobox", { name: presentation === "war-room" ? "Investigation context: Version" : "Version", exact: true });
        const build = form.getByRole("combobox", { name: presentation === "war-room" ? "Investigation context: Build" : "Build", exact: true });
        const versionList = await version.getAttribute("list");
        const buildList = await build.getAttribute("list");
        expect(versionList).toBeTruthy();
        expect(buildList).toBeTruthy();
        expect(await page.locator(`#${versionList} option`).count()).toBe(0);
        expect(await page.locator(`#${buildList} option`).count()).toBe(0);
        const writes: unknown[] = [];
        const onRequest = (request: { method(): string; url(): string }) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/api/cases") writes.push(request);
        };
        page.on("request", onRequest);
        const chooser = form.getByRole("combobox", { name: "Recorded product / version / build combination" });
        await chooser.selectOption({ label: `Product: ${alpha} · Version: v1 · Build: build-A` });
        await expect(form.getByText(/Only product, version, and build in this local draft will be replaced/)).toBeVisible();
        expect(writes).toHaveLength(0);
        await form.getByRole("button", { name: "Apply combination to draft" }).click();
        await expect(product).toHaveValue(alpha);
        await expect(version).toHaveValue("v1");
        await expect(build).toHaveValue("build-A");
        expect(writes).toHaveLength(0);
        const title = `${token}-${presentation}-created`;
        if (presentation === "war-room") await form.getByPlaceholder("New investigation title").fill(title);
        else if (presentation === "investigation-first") await form.getByPlaceholder("Short investigation title").fill(title);
        else await form.getByRole("textbox", { name: "Investigation title" }).fill(title);
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/cases");
        await form.getByRole("button", { name: presentation === "war-room" ? "Create investigation" : presentation === "beacon" ? "Create and open" : "Create investigation" }).click();
        const response = await responsePromise;
        expect(response.ok(), await response.text()).toBeTruthy();
        const body = await response.json() as { id: string; investigationContext: { productName: string; version: string; build: string } };
        expect(body.investigationContext).toMatchObject({ productName: alpha, version: "v1", build: "build-A" });
        expect(writes).toHaveLength(1);
        page.off("request", onRequest);
        createdIds.push(body.id);
        await page.goto(`/investigations/${body.id}/situation`);
        await page.reload();
        const canonical = await page.request.get(`/api/cases/${body.id}`);
        expect(canonical.ok(), await canonical.text()).toBeTruthy();
        expect(await canonical.json()).toMatchObject({ investigationContext: { productName: alpha, version: "v1", build: "build-A" } });
      }

      const targetId = createdIds[0]!;
      console.log("Goal 08 browser: Keystone edit and cancel");
      await page.goto(`/investigations/${targetId}/situation`);
      await selectPresentation(page, "Keystone");
      await expect(page.getByRole("button", { name: "Create investigation" })).toHaveCount(0);
      await page.getByRole("button", { name: "Edit situation" }).click();
      const editor = page.locator(".keystone-situation-editor__form");
      const chooser = editor.getByRole("combobox", { name: "Recorded product / version / build combination" });
      await chooser.selectOption({ label: `Product: ${beta} · Version: v9 · Build: build-B` });
      await editor.getByRole("button", { name: "Apply combination to draft" }).click();
      await expect(editor.getByRole("combobox", { name: "Product or software" })).toHaveValue(beta);
      await editor.getByRole("button", { name: "Cancel" }).click();
      console.log("Goal 08 browser: Keystone save");
      const afterCancel = await page.request.get(`/api/cases/${targetId}`);
      expect(await afterCancel.json()).toMatchObject({ investigationContext: { productName: alpha } });
      await page.getByRole("button", { name: "Edit situation" }).click();
      await editor.getByRole("combobox", { name: "Recorded product / version / build combination" })
        .selectOption({ label: `Product: ${beta} · Version: v9 · Build: build-B` });
      await editor.getByRole("button", { name: "Apply combination to draft" }).click();
      const saveResponsePromise = page.waitForResponse((response) => response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/cases/${targetId}/situation`);
      await editor.getByRole("button", { name: "Save changes" }).click();
      const saveResponse = await saveResponsePromise;
      expect(saveResponse.ok(), await saveResponse.text()).toBeTruthy();
      expect(saveResponse.request().postDataJSON()).toMatchObject({ expectedVersion: expect.any(Number),
        investigationContext: { productName: beta, version: "v9", build: "build-B", component: "", environment: "", organization: "" } });
      await page.reload();
      const canonical = await page.request.get(`/api/cases/${targetId}`);
      expect(await canonical.json()).toMatchObject({ investigationContext: { productName: beta, version: "v9", build: "build-B" } });
      for (const presentation of PRESENTATIONS) {
        console.log(`Goal 08 browser: verify ${presentation}`);
        await selectPresentation(page, NAMES[presentation]);
        await expect(page.getByText(beta, { exact: true }).first()).toBeVisible();
      }
      console.log("Goal 08 browser: War Room Situation edit");
      await selectPresentation(page, "War Room");
      await page.getByRole("button", { name: "Edit situation" }).click();
      const warRoomEditor = page.locator(".situation__form");
      await warRoomEditor.getByRole("combobox", { name: "Recorded product / version / build combination" })
        .selectOption({ label: `Product: ${alpha} · Version: v1 · Build: build-A` });
      await warRoomEditor.getByRole("button", { name: "Apply combination to draft" }).click();
      await expect(warRoomEditor.getByRole("combobox", { name: "Investigation context: Software or product" })).toHaveValue(alpha);
      await warRoomEditor.getByRole("button", { name: "Cancel" }).click();
      expect(await (await page.request.get(`/api/cases/${targetId}`)).json()).toMatchObject({ investigationContext: { productName: beta } });
      await page.getByRole("button", { name: "Edit situation" }).click();
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      await page.setViewportSize({ width: 320, height: 844 });
      const warRoomChooser = warRoomEditor.getByRole("combobox", { name: "Recorded product / version / build combination" });
      await warRoomChooser.selectOption({ label: `Product: ${alpha} · Version: v1 · Build: build-A` });
      await expectReducedMotion(page, warRoomEditor);
      await expectForcedColors(page, [warRoomChooser, warRoomEditor.getByRole("button", { name: "Apply combination to draft" })]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await warRoomEditor.getByRole("button", { name: "Apply combination to draft" }).click();
      const warRoomSavePromise = page.waitForResponse((response) => response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/cases/${targetId}/situation`);
      await warRoomEditor.getByRole("button", { name: "Save situation" }).click();
      const warRoomSave = await warRoomSavePromise;
      expect(warRoomSave.ok(), await warRoomSave.text()).toBeTruthy();
      expect(warRoomSave.request().postDataJSON()).toMatchObject({ expectedVersion: expect.any(Number),
        investigationContext: { productName: alpha, version: "v1", build: "build-A" } });
      expect(await (await page.request.get(`/api/cases/${targetId}`)).json()).toMatchObject({ investigationContext: { productName: alpha } });
    } finally {
      if (!page.isClosed()) {
        await loginAs(page, FIXTURE_USERS.dave);
        await setPolicy(page, original.instance, original.roleRules);
      }
    }
  });

  test("keeps manual incomplete context through injected suggestion read failures and a denied second identity", async ({ page }) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(15_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await policy(page);
    await setPolicy(page, { ...original.instance, enabledIds: [...PRESENTATIONS], visibleIds: [...PRESENTATIONS],
      selectionMode: "free", approvedIds: [...PRESENTATIONS] }, []);
    const title = uniqueTitle("manual context after read failure");
    const novel = uniqueTitle("novel software");
    try {
      await page.goto("/investigations");
      await selectPresentation(page, "Investigation First");
      const failRead = async (route: import("@playwright/test").Route) => {
        if (route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/cases") {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic_read_failure" }) });
        } else await route.continue();
      };
      await page.route("**/api/cases", failRead);
      await page.reload();
      const form = createForm(page, "investigation-first");
      await form.getByText("Advanced context").click();
      await expect(form.getByText(/Loaded investigation suggestions could not be read/)).toBeVisible();
      const product = form.getByRole("combobox", { name: "Product or software", exact: true });
      await product.fill(novel);
      await product.press("Enter");
      await expect(product).toHaveValue(novel);
      await expect(form.getByRole("button", { name: "Create investigation" })).toBeEnabled();
      await form.getByRole("button", { name: "Retry recorded values" }).click();
      await expect(form.getByText(/Loaded investigation suggestions could not be read/)).toBeVisible();
      await expect(product).toHaveValue(novel);
      await page.unroute("**/api/cases", failRead);
      await form.getByRole("button", { name: "Retry recorded values" }).click();
      await expect(product).toHaveValue(novel);
      await form.getByPlaceholder("Short investigation title").fill(title);
      const createResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/cases");
      await form.getByRole("button", { name: "Create investigation" }).click();
      const createdResponse = await createResponsePromise;
      expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();
      const created = await createdResponse.json() as { id: string; investigationContext: { productName: string; version: string; build: string } };
      expect(created.investigationContext).toMatchObject({ productName: novel, version: "", build: "" });
      const reloaded = await page.request.get(`/api/cases/${created.id}`);
      expect(await reloaded.json()).toMatchObject({ investigationContext: { productName: novel } });

      await loginAs(page, FIXTURE_USERS.carol);
      const denied = await page.request.get(`/api/cases/${created.id}`);
      expect([403, 404]).toContain(denied.status());
      await page.goto("/investigations");
      await expect(page.getByText(novel, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Apply combination to draft" })).toHaveCount(0);
    } finally {
      if (!page.isClosed()) {
        await loginAs(page, FIXTURE_USERS.dave);
        await setPolicy(page, original.instance, original.roleRules);
      }
    }
  });
});
