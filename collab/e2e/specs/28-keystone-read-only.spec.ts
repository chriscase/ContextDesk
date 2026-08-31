import { expect, test, type Page } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const DESKTOP = { width: 1280, height: 900 };
const NARROW = [560, 390] as const;

async function selectStrategy(page: Page, name: "War Room" | "Keystone"): Promise<void> {
  const account = page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.dave.username}` });
  await account.click();
  const strategy = page.getByRole("radio", { name: new RegExp(`^${name}\\b`, "u") });
  await strategy.check();
  await expect(strategy).toBeChecked();
  await page.keyboard.press("Escape");
}

async function documentScrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

test.describe("Keystone K2 engineer workflow", () => {
  test("keeps the strategy surface scoped to Investigations", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    await selectStrategy(page, "Keystone");

    await page.getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await expect(page.locator(".topbar__title-app")).toHaveText("War Room");
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page.locator(".keystone-strategy")).toHaveCount(0);

    await page.getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Investigations", exact: true })
      .click();
    await expect(page.locator(".topbar__title-app")).toHaveText("Keystone");
    await expect(page.locator(".keystone-strategy")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Investigations" })).toBeVisible();
  });

  test("browses evidence without writes and keeps canonical inspector navigation", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    // Creation and upload remain War Room-owned operations. This setup
    // deliberately proves Keystone consumes the resulting shared record rather
    // than quietly adding a strategy-owned write path.
    await selectStrategy(page, "War Room");
    const title = uniqueTitle("Keystone browser proof");
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    const filename = "keystone-browser-proof.log";
    const uploaded = await page.request.post(`/api/cases/${caseId}/evidence`, {
      headers: BROWSER_MUTATION_HEADERS,
      data: {
        kind: "log",
        summary: "Synthetic evidence for the Keystone browser proof.",
        filename,
        mediaType: "text/plain",
        contentBase64: Buffer.from("keystone browser proof\\n", "utf8").toString("base64"),
        privacyClass: "owner_only",
      },
    });
    expect(uploaded.ok(), await uploaded.text()).toBeTruthy();

    await page.goto("/investigations");
    await selectStrategy(page, "Keystone");
    await expect(page.locator(".keystone-strategy")).toBeVisible();

    const result = page.locator(".keystone-strategy__collection-list button").filter({ hasText: title });
    await expect(result).toBeVisible();
    await result.click();
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();

    // The table is labelled by its enclosing StrategyPanel, not by an
    // aria-label of its own; keep the selector tied to Keystone's presentation
    // surface rather than manufacturing an inaccessible table name.
    const grid = page.locator(".keystone-strategy__evidence-table");
    await expect(grid).toBeVisible();
    const row = grid.locator("tbody tr").filter({ hasText: filename });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: filename, exact: true })).toBeVisible();

    const writes: string[] = [];
    const recordWrite = (request: import("@playwright/test").Request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method());
    };
    page.on("request", recordWrite);
    const checkbox = row.getByRole("checkbox");
    await checkbox.check();
    await expect(page.getByRole("button", { name: "Clear working set" })).toBeVisible();
    await row.getByRole("button", { name: filename, exact: true }).click();
    await expect(page.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(writes, "Keystone selection/inspection emitted a mutation").toEqual([]);
    page.off("request", recordWrite);

    const reasoning = page.getByRole("tab", { name: "Reasoning" });
    await reasoning.click();
    await expect(page).toHaveURL(`/investigations/${caseId}/analyze`);
    await expect(reasoning).toHaveAttribute("aria-selected", "true");
    const record = page.getByRole("tab", { name: "Record" });
    await record.click();
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
    await expect(record).toHaveAttribute("aria-selected", "true");

    await expect(page.getByRole("button", { name: "Create investigation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add to evidence inventory" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Archive investigation|Restore investigation/u })).toHaveCount(0);

    for (const width of NARROW) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await documentScrollWidth(page),
        `Keystone has page-level horizontal overflow at ${width}px`,
      ).toBeLessThanOrEqual(width);
      await expect(page.locator(".keystone-strategy")).toBeVisible();
      await expect(page.locator(".keystone-strategy__evidence-table")).toBeVisible();
    }
  });

  test("records one cited hypothesis and one explicit situation correction", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    await selectStrategy(page, "War Room");
    const title = uniqueTitle("Keystone K2 write proof");
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    const filename = "keystone-k2-citation.log";
    const uploaded = await page.request.post(`/api/cases/${caseId}/evidence`, {
      headers: BROWSER_MUTATION_HEADERS,
      data: {
        kind: "log",
        summary: "Synthetic evidence for the Keystone K2 write proof.",
        filename,
        mediaType: "text/plain",
        contentBase64: Buffer.from("keystone K2 citation proof\n", "utf8").toString("base64"),
        privacyClass: "owner_only",
      },
    });
    expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
    const uploadPayload = await uploaded.json() as { artifact: { id: string } };

    await page.goto("/investigations");
    await selectStrategy(page, "Keystone");
    await page.locator(".keystone-strategy__collection-list button").filter({ hasText: title }).click();
    const row = page.locator(".keystone-strategy__evidence-table tbody tr").filter({ hasText: filename });
    await row.getByRole("checkbox").check();

    const contributionRequests: Array<Record<string, unknown>> = [];
    page.on("request", async (request) => {
      if (request.method() === "POST" && request.url().endsWith(`/api/cases/${caseId}/contributions`)) {
        contributionRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await page.getByRole("tab", { name: "Reasoning" }).click();
    const hypothesisBody = "The timeout evidence aligns with the rollout window.";
    await page.getByRole("textbox", { name: "Hypothesis" }).fill(hypothesisBody);
    await page.getByRole("button", { name: "Record hypothesis" }).click();
    await expect(page.getByText("Hypothesis recorded")).toBeVisible();
    await expect(page.getByText(hypothesisBody)).toBeVisible();
    expect(contributionRequests).toHaveLength(1);
    expect(contributionRequests[0]).toMatchObject({
      kind: "hypothesis",
      body: hypothesisBody,
      hypothesisLinks: [{ kind: "artifact", id: uploadPayload.artifact.id }],
    });

    const situationRequests: Array<Record<string, unknown>> = [];
    page.on("request", async (request) => {
      if (request.method() === "PATCH" && request.url().endsWith(`/api/cases/${caseId}/situation`)) {
        situationRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await page.getByRole("tab", { name: "Record" }).click();
    await page.getByRole("button", { name: "Edit situation" }).click();
    const problemStatement = "Checkout requests exceed the revised latency objective.";
    await page.getByRole("textbox", { name: "Problem statement" }).fill(problemStatement);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(problemStatement)).toBeVisible();
    expect(situationRequests).toHaveLength(1);
    expect(situationRequests[0]).toMatchObject({
      problemStatement,
      expectedVersion: expect.any(Number),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Reasoning" }).click();
    await expect(page.getByRole("textbox", { name: "Hypothesis" })).toBeVisible();
    expect(await documentScrollWidth(page)).toBeLessThanOrEqual(390);
    await page.getByRole("tab", { name: "Record" }).click();
    await page.getByRole("button", { name: "Edit situation" }).click();
    await expect(page.getByRole("textbox", { name: "Problem statement" })).toBeVisible();
    expect(await documentScrollWidth(page)).toBeLessThanOrEqual(390);
  });
});
