import { expect, test, type Page } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { expectForcedColors, expectReducedMotion } from "../src/investigation-strategy/conformance.js";
import { FIXTURE_USERS } from "../src/users.js";

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

async function strategyPolicy(page: Page): Promise<StrategyPolicy> {
  const current = await page.request.get("/api/admin/ui-strategies");
  expect(current.ok(), await current.text()).toBeTruthy();
  return await current.json() as StrategyPolicy;
}

async function updateStrategyPolicy(
  page: Page,
  policy: Pick<StrategyPolicy, "instance" | "roleRules">,
): Promise<StrategyPolicy> {
  const current = await strategyPolicy(page);
  const update = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: current.revision,
      instance: policy.instance,
      roleRules: policy.roleRules,
    },
  });
  expect(update.ok(), await update.text()).toBeTruthy();
  return await update.json() as StrategyPolicy;
}

async function enableBeacon(page: Page): Promise<StrategyPolicy> {
  const previous = await strategyPolicy(page);
  await updateStrategyPolicy(page, {
    instance: {
      enabledIds: [...ALL_STRATEGIES],
      visibleIds: [...ALL_STRATEGIES],
      defaultId: previous.instance.defaultId,
      selectionMode: "free",
      approvedIds: [...ALL_STRATEGIES],
    },
    roleRules: previous.roleRules,
  });
  return previous;
}

async function makeBeaconFixedDefault(page: Page): Promise<StrategyPolicy> {
  const previous = await strategyPolicy(page);
  await updateStrategyPolicy(page, {
    instance: {
      enabledIds: [...ALL_STRATEGIES],
      visibleIds: [...ALL_STRATEGIES],
      defaultId: "beacon",
      selectionMode: "approved_subset",
      approvedIds: [],
    },
    roleRules: [],
  });
  return previous;
}

async function restoreStrategyPolicy(page: Page, policy: StrategyPolicy): Promise<void> {
  await updateStrategyPolicy(page, {
    instance: policy.instance,
    roleRules: policy.roleRules,
  });
}

async function createInvestigation(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Synthetic browser qualification record.",
      affectedParties: "Fixture users",
      impact: "Qualification only",
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = await created.json() as { id?: string };
  expect(body.id, "case creation did not return an id").toBeTruthy();
  return body.id!;
}

async function addViewer(page: Page, caseId: string): Promise<void> {
  const added = await page.request.post(`/api/cases/${caseId}/participants`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      identityId: FIXTURE_USERS.carol.identityId,
      username: FIXTURE_USERS.carol.username,
    },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
}

async function selectBeacon(page: Page): Promise<void> {
  await page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.dave.username}` }).click();
  const strategy = page.getByRole("radio", { name: /^Beacon\b/u });
  if (!(await strategy.isChecked())) {
    await strategy.check();
    const save = page.getByRole("button", { name: "Use selected experience" });
    await save.scrollIntoViewIfNeeded();
    await save.click();
  }
  await expect(page.locator(".topbar__title-app")).toHaveText("Beacon");
  await page.keyboard.press("Escape");
}

test.describe("Beacon rapid-intake pilot", () => {
  test("rolls Beacon out through the administrator UI", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await strategyPolicy(page);
    try {
      const withoutBeacon = ALL_STRATEGIES.filter((id) => id !== "beacon");
      await updateStrategyPolicy(page, {
        instance: {
          enabledIds: withoutBeacon,
          visibleIds: withoutBeacon,
          defaultId: original.instance.defaultId === "beacon" ? "war-room" : original.instance.defaultId,
          selectionMode: "free",
          approvedIds: withoutBeacon,
        },
        roleRules: [],
      });

      await page.goto("/admin/ui-strategies");
      await expect(page.getByRole("heading", { name: "Investigation experiences" })).toBeVisible();
      const enable = page.getByRole("checkbox", { name: "Enable Beacon" });
      const show = page.getByRole("checkbox", { name: "Show Beacon in selector" });
      await expect(enable).not.toBeChecked();
      await expect(show).toBeDisabled();
      await enable.check();
      await show.check();

      const [saved] = await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith("/api/admin/ui-strategies")
          && response.request().method() === "PUT"),
        page.getByRole("button", { name: "Save rollout policy" }).click(),
      ]);
      expect(saved.ok(), await saved.text()).toBeTruthy();
      await expect(page.getByRole("status")).toContainText("was saved and audited");

      await page.goto("/investigations");
      await page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.dave.username}` }).click();
      await expect(page.getByRole("radio", { name: /^Beacon\b/u })).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });

  test("keeps Overview canonical and performs one explicit append, upload, and promotion at a time", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await enableBeacon(page);
    try {
      await page.goto("/investigations");
      await selectBeacon(page);
      await expect(page.locator(".beacon")).toBeVisible();

      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Overview", exact: true }).click();
      await expect(page.locator(".topbar__title-app")).toHaveText("War Room");
      await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Investigations", exact: true }).click();
      await expect(page.locator(".topbar__title-app")).toHaveText("Beacon");

      const title = uniqueTitle("Beacon browser proof");
      await page.getByRole("textbox", { name: "Investigation title" }).fill(title);
      await page.getByRole("textbox", { name: "What did you observe?" }).fill("Gateway timeouts began after the connection-pool rollout.");
      await page.getByRole("textbox", { name: "Who or what is affected?" }).fill("Checkout traffic");
      await page.getByRole("button", { name: "Create and open" }).click();
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
      const caseId = new URL(page.url()).pathname.split("/")[2]!;

      const writes: Array<{ method: string; url: string; body: unknown }> = [];
      page.on("request", (request) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && request.url().includes(`/api/cases/${caseId}`)) {
          writes.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
        }
      });

      const observation = "Timeout rate rose to 3.2% at 14:26 UTC.";
      await page.getByRole("textbox", { name: "What happened next?" }).fill(observation);
      await page.getByRole("button", { name: "Record entry" }).click();
      await expect(page.getByText(observation)).toBeVisible();
      expect(writes.filter(({ url }) => url.endsWith("/contributions"))).toHaveLength(1);
      expect(writes.filter(({ method, url }) => method === "PATCH" && url.endsWith("/situation"))).toHaveLength(0);

      const fileName = "beacon-gateway-timeouts.log";
      await page.getByLabel(/File \(up to/u).setInputFiles({
        name: fileName,
        mimeType: "text/plain",
        buffer: Buffer.from("timeout=upstream status=504\n", "utf8"),
      });
      await page.getByRole("combobox", { name: "Kind" }).selectOption("log");
      await page.getByRole("textbox", { name: "Why does this matter?" }).fill("Captured during the affected interval.");
      await page.getByRole("button", { name: "Attach evidence" }).click();
      await expect(page.getByText(fileName, { exact: true })).toBeVisible();

      const revisedSituation = "Gateway timeouts increased after the connection-pool rollout.";
      await page.getByRole("textbox", { name: "New problem statement" }).fill(revisedSituation);
      await page.getByRole("button", { name: "Promote to Situation" }).click();
      await expect(page.getByRole("definition").filter({ hasText: revisedSituation })).toBeVisible();
      expect(writes.filter(({ method, url }) => method === "PATCH" && url.endsWith("/situation"))).toHaveLength(1);

      const hypothesis = "The connection-pool rollout is correlated with the timeout increase.";
      await page.getByRole("textbox", { name: "Hypothesis" }).fill(hypothesis);
      await page.getByRole("combobox", { name: "Source entry (optional)" }).selectOption({ index: 1 });
      await page.getByRole("button", { name: "Record hypothesis" }).click();
      await expect(page.getByText(hypothesis)).toBeVisible();
      expect(writes.filter(({ url }) => url.endsWith("/contributions"))).toHaveLength(2);
      expect(writes.filter(({ url }) => url.endsWith("/lifecycle"))).toHaveLength(0);

      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await expect(page.locator(".beacon")).toBeVisible();
    } finally {
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });

  test("does not request case data when a no-read account opens a Beacon detail URL", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const caseId = await createInvestigation(page, uniqueTitle("Beacon denied proof"));
    const original = await makeBeaconFixedDefault(page);
    try {
      await loginAs(page, FIXTURE_USERS.carol);
      // Let the previous canonical Overview finish its War Room reads before
      // measuring the freshly projected no-read detail navigation below.
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
      const caseReads: string[] = [];
      const caseWrites: string[] = [];
      const recordRead = (request: import("@playwright/test").Request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "GET" && (pathname === "/api/cases" || pathname.startsWith("/api/cases/"))) {
          caseReads.push(pathname);
        }
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method())
          && (pathname === "/api/cases" || pathname.startsWith("/api/cases/"))
        ) caseWrites.push(`${request.method()} ${pathname}`);
      };
      page.on("request", recordRead);
      await page.goto(`/investigations/${caseId}/situation`);
      const denied = page.getByRole("heading", { name: "Investigation unavailable in this view" });
      await expect(denied).toBeFocused();
      await expect(page.getByText("Your account cannot read investigations, so no record data was requested.")).toBeVisible();
      await expect(page.getByText("Opening investigation")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
      expect(caseReads, "the denied Beacon detail requested case data").toEqual([]);
      expect(caseWrites, "the denied Beacon detail attempted a durable case write").toEqual([]);
      await page.getByRole("button", { name: "Back to investigations" }).click();
      await expect(page).toHaveURL("/investigations");
      await expect(page.getByText("Your account cannot read investigations, so no investigation data was requested.")).toBeVisible();
      expect(caseReads, "the denied Beacon browse requested case data").toEqual([]);
      expect(caseWrites, "the denied Beacon browse attempted a durable case write").toEqual([]);
      page.off("request", recordRead);
    } finally {
      await page.unroute("**/api/auth/me");
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });

  test("keeps a viewer's Beacon record truthful and emits no durable writes", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Beacon viewer proof");
    const caseId = await createInvestigation(page, title);
    await addViewer(page, caseId);
    const original = await makeBeaconFixedDefault(page);
    try {
      await loginAs(page, FIXTURE_USERS.carol);
      // Exclude the previous Overview's ephemeral presence heartbeat from the
      // fresh read-only investigation navigation measured below.
      await page.waitForLoadState("networkidle");
      const caseWrites: Array<{ method: string; pathname: string }> = [];
      const recordWrite = (request: import("@playwright/test").Request) => {
        const pathname = new URL(request.url()).pathname;
        // Presence is an ephemeral, read-capability-scoped heartbeat rather
        // than an investigation-record mutation. Every durable case write is
        // still in scope for this assertion.
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method())
          && pathname.startsWith(`/api/cases/${caseId}`)
          && !pathname.endsWith("/presence")
        ) {
          caseWrites.push({ method: request.method(), pathname });
        }
      };
      page.on("request", recordWrite);
      await page.goto(`/investigations/${caseId}/situation`);
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
      await expect(page.getByText("You can review recorded entries, but your current access cannot add one.")).toBeVisible();
      await expect(page.getByText("You can review supporting material, but your current access cannot attach a file.")).toBeVisible();
      await expect(page.getByText("Your current access can review this statement but cannot replace it.")).toBeVisible();
      await expect(page.getByText("Your current access can review hypotheses but cannot add one.")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "What happened next?" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Attach evidence" })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "New problem statement" })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Hypothesis" })).toHaveCount(0);
      expect(caseWrites, "opening the read-only Beacon detail emitted a mutation").toEqual([]);
      page.off("request", recordWrite);
    } finally {
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });

  test("keeps the Beacon controls visible in forced colors and removes motion", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await enableBeacon(page);
    try {
      await page.goto("/investigations");
      await selectBeacon(page);
      const root = page.locator(".beacon");
      await expectReducedMotion(page, root);
      await expectForcedColors(page, [
        page.getByRole("textbox", { name: "Investigation title" }),
        page.getByRole("searchbox", { name: "Find an investigation" }),
        page.getByRole("button", { name: "Create and open" }),
      ]);
    } finally {
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });
});
