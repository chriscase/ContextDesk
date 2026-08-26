import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  gotoStage,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { beginScenario } from "../src/war-room/acceptance.js";
import { syntheticZip } from "../src/synthetic-zip.js";
import { FIXTURE_USERS } from "../src/users.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (...parts: string[]) =>
  readFileSync(join(here, "..", "fixtures", "war-room", "workbench", ...parts));

async function importWorkbenchZip(page: import("@playwright/test").Page) {
  await gotoStage(page, "Capture");
  const zip = syntheticZip([
    { name: "gateway/edge.log", data: fixture("gateway-edge.log") },
    { name: "worker/batch.log", data: fixture("worker-batch.log") },
    { name: "worker/batch.log.1", data: fixture("worker-batch.log.1") },
    { name: "mailer/offset.log", data: fixture("mailer-offset.log") },
    { name: "notes/support-thread.eml", data: fixture("support-thread.eml") },
    { name: "notes/pasted-chat.txt", data: fixture("pasted-chat.txt") },
    { name: '<img src=x onerror=alert(1)>.log', data: fixture("html-looking.log") },
  ]);
  await page.getByRole("radio", { name: "ZIP archive" }).check();
  await page.getByLabel("ZIP file to upload").setInputFiles({
    name: "synthetic-workbench.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  await page.getByRole("button", { name: "Preview intake" }).click();
  await expect(page.getByText("gateway/edge.log")).toBeVisible();
  const [committed] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/corpus-intake")
        && !res.url().includes("preview")
        && res.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Commit accepted files" }).click(),
  ]);
  expect(committed.ok(), await committed.text()).toBeTruthy();
}

test.describe("investigation log workbench", () => {
  test("imports logs, searches, opens two panes, and round-trips a saved view", async ({
    page,
  }) => {
    const record = beginScenario("log-workbench-triage");
    const title = uniqueTitle("Log workbench");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await importWorkbenchZip(page);

    await gotoStage(page, "Analyze");
    record.recordDeepLink("log-workbench", page.url());
    const workbench = page.locator("#log-workbench");
    await record.check("workbench-named-on-analyze", async () => {
      await expect(workbench.getByRole("heading", { name: "Log workbench" })).toBeVisible();
      await expect(workbench.getByText("edge.log", { exact: true })).toBeVisible();
      expect(await workbench.locator("img").count()).toBe(0);
      return "Log workbench listed investigation files by human names";
    });

    await workbench.getByLabel("Show edge.log in a pane", { exact: true }).check();
    await workbench.getByLabel("Show batch.log in a pane", { exact: true }).check();
    await expect(workbench.locator("[data-workbench-pane]")).toHaveCount(2);
    await record.check("workbench-two-panes", async () => {
      await expect(workbench.getByLabel("Show edge.log in a pane", { exact: true })).toBeChecked();
      await expect(workbench.getByLabel("Show batch.log in a pane", { exact: true })).toBeChecked();
      return "two files selected for side-by-side panes";
    });

    await record.check("workbench-virtual-row-contract", async () => {
      const metrics = await workbench
        .locator("[data-workbench-pane]")
        .first()
        .locator(".log-workbench__lines li")
        .evaluateAll((rows) =>
          rows.map((row) => ({
            height: row.getBoundingClientRect().height,
            whiteSpace: getComputedStyle(row.querySelector(".log-workbench__text")!).whiteSpace,
          })),
        );
      expect(metrics.length).toBeGreaterThan(1);
      expect(new Set(metrics.map(({ height }) => height)).size).toBe(1);
      expect(metrics[0]?.height).toBe(40);
      expect(new Set(metrics.map(({ whiteSpace }) => whiteSpace))).toEqual(new Set(["pre"]));
      return "virtualized rows keep one measured height and long records scroll instead of drifting match offsets";
    });

    await workbench.getByLabel("Find in logs").fill("timeout");
    await workbench.getByRole("button", { name: "Search" }).click();
    await record.check("workbench-search-timeout", async () => {
      // The count states whether it is complete: an exact count says so, and a
      // bounded or partly read one says what it did not count.
      await expect(workbench.locator(".log-workbench__search-summary")).toContainText(
        /\d+ match(es)?\b.*(every match in the read lines|Load more|were not counted)/,
      );
      await expect(workbench.getByRole("list", { name: "Search matches" })).toContainText(
        /upstream timeout/,
      );
      return "timeout line visible with a match count that states its completeness";
    });

    await workbench.getByRole("button", { name: "Show merged chronology" }).click();
    await expect(workbench.getByRole("heading", { name: "Merged chronology" })).toBeVisible();
    await workbench.getByRole("button", { name: "Save view" }).click();
    await expect(workbench.getByText(/Saved view .*recorded for this investigation/)).toBeVisible();
    await page.reload();
    await gotoStage(page, "Analyze");
    await record.check("workbench-saved-view-reload", async () => {
      await expect(page.locator("#log-workbench").getByRole("button", { name: "Timeout window" })).toBeVisible();
      return "saved view still listed after reload";
    });
    record.finish();
  });

  test("treats email and chat as evidence that is not a log chronology claim", async ({
    page,
  }) => {
    const record = beginScenario("workbench-email-chat");
    const title = uniqueTitle("Workbench email chat");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await importWorkbenchZip(page);
    await gotoStage(page, "Analyze");
    record.recordDeepLink("log-workbench", page.url());
    const workbench = page.locator("#log-workbench");
    await record.check("workbench-email-visible", async () => {
      await expect(workbench.getByText("support-thread.eml", { exact: true })).toBeVisible();
      await expect(workbench.getByText("pasted-chat.txt", { exact: true })).toBeVisible();
      return "email and chat listed in the workbench";
    });
    await workbench.getByLabel("Find in logs").fill("human conversation");
    await workbench.getByRole("button", { name: "Search" }).click();
    await record.check("workbench-chat-not-a-log", async () => {
      await expect(workbench.getByRole("list", { name: "Search matches" })).toContainText(
        /human conversation, not a log/,
      );
      return "conversation text searchable without a guessed timestamp";
    });
    record.finish();
  });

  test("privacy-safe locator resolve hides existence from an unauthorized reader", async ({
    page,
  }) => {
    const record = beginScenario("workbench-locator-privacy");
    const title = uniqueTitle("Workbench locator privacy");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await importWorkbenchZip(page);
    await gotoStage(page, "Analyze");
    record.recordDeepLink("log-workbench", page.url());
    const workbench = page.locator("#log-workbench");
    await workbench.getByLabel("Show edge.log in a pane", { exact: true }).check();
    await expect(workbench.locator(".log-workbench__lines li").first()).toBeVisible();
    const bookmark = workbench.getByRole("button", { name: "Bookmark" }).first();
    await expect(bookmark).toBeVisible();
    await bookmark.click();
    await expect(workbench.getByText(/Bookmark recorded/)).toBeVisible();

    const caseId = await caseIdForTitle(page, title);
    const list = await page.request.get(`/api/cases/${caseId}/workbench/bookmarks`);
    expect(list.ok()).toBeTruthy();
    const body = (await list.json()) as { bookmarks?: { shareSafeToken: string }[] };
    const token = body.bookmarks?.[0]?.shareSafeToken;
    await record.check("workbench-locator-authorized", async () => {
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      return "share-safe bookmark token minted";
    });

    await page.goto("/");
    // A mapped viewer who is not on this investigation — not an unmapped
    // account, which the workspace refuses at sign-in.
    await loginAs(page, FIXTURE_USERS.carol);
    const denied = await page.request.post("/api/workbench/locators/resolve", {
      headers: { ...BROWSER_MUTATION_HEADERS, "content-type": "application/json" },
      data: {
        schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
        token,
      },
    });
    expect(denied.status()).toBe(200);
    const resolved = (await denied.json()) as {
      found: boolean;
      relativePath: string | null;
      investigationId: string | null;
    };
    await record.check("workbench-locator-unauthorized-404", async () => {
      expect(resolved.found).toBe(false);
      expect(resolved.relativePath).toBeNull();
      expect(resolved.investigationId).toBeNull();
      return "unauthorized resolve disclosed neither path nor investigation";
    });
    record.finish();
  });

  test("keeps the log pane DOM bounded on a large file", async ({ page }) => {
    const title = uniqueTitle("Workbench bounds");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const lines = Array.from({ length: 400 }, (_, index) => `INFO line ${index} timeout`);
    await gotoStage(page, "Capture");
    const zip = syntheticZip([{ name: "bulk/app.log", data: Buffer.from(`${lines.join("\n")}\n`) }]);
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "bulk.zip",
      mimeType: "application/zip",
      buffer: zip,
    });
    await page.getByRole("button", { name: "Preview intake" }).click();
    await page.getByRole("button", { name: "Commit accepted files" }).click();
    await gotoStage(page, "Analyze");
    const workbench = page.locator("#log-workbench");
    await workbench.getByLabel(/Show app.log/).check();
    await expect(workbench.locator(".log-workbench__lines li").first()).toBeVisible();
    const count = await workbench.locator(".log-workbench__lines li").count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(120);
  });

  test("is usable from the keyboard on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const title = uniqueTitle("Workbench a11y");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await importWorkbenchZip(page);
    await gotoStage(page, "Analyze");
    const workbench = page.locator("#log-workbench");
    const advanced = workbench.locator("details.log-workbench__search-advanced");
    await expect(advanced).not.toHaveAttribute("open", "");
    await expect(workbench.getByText("Details", { exact: true })).toHaveCount(7);

    await workbench.getByLabel("Find in logs").focus();
    await page.keyboard.type("timeout");
    await page.keyboard.press("Enter");
    await expect(workbench.locator(".log-workbench__search-summary")).toContainText(
      /\d+ match(es)?\b/,
    );

    const navigation = workbench.getByRole("group", {
      name: "Search match navigation",
    });
    await expect(navigation.getByRole("button", { name: "Previous match" })).toBeVisible();
    await expect(navigation.getByText(/\d+ of \d+/)).toBeVisible();
    await expect(navigation.getByRole("button", { name: "Next match" })).toBeVisible();

    const geometry = await navigation.evaluate((element) => {
      const children = Array.from(element.children).map((child) => {
        const rect = child.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      });
      const rect = element.getBoundingClientRect();
      return { children, left: rect.left, right: rect.right };
    });
    expect(geometry.children).toHaveLength(3);
    expect(Math.max(...geometry.children.map((child) => child.top))
      - Math.min(...geometry.children.map((child) => child.top))).toBeLessThan(2);
    expect(Math.max(...geometry.children.map((child) => child.bottom))
      - Math.min(...geometry.children.map((child) => child.bottom))).toBeLessThan(2);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(390);

    const pageWidths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(pageWidths.scroll).toBeLessThanOrEqual(pageWidths.client);
    await page.keyboard.press("Escape");
  });

  test("filters investigations by involved entity and observed date", async ({ page }) => {
    const label = `Synthetic workbench party ${Date.now()}`;
    const title = uniqueTitle("Workbench historical entity");
    await loginAs(page, FIXTURE_USERS.alice);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Entities" }).click();
    const entityForm = page.getByRole("form", { name: "Add an entity" });
    await entityForm.getByLabel("Entity kind").selectOption("service");
    await entityForm.getByLabel("Entity name").fill(label);
    await entityForm.getByRole("button", { name: "Add entity" }).click();
    await expect(page.getByText(label)).toBeVisible();

    const field = page.getByPlaceholder("New investigation title");
    if (!(await field.isVisible())) {
      await page.getByRole("button", { name: "Start investigation" }).click();
    }
    await page.getByLabel("When it happened").fill("2024-03-10");
    await field.fill(title);
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith("/api/cases") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create investigation" }).click(),
    ]);

    await gotoStage(page, "Situation");
    await expect(page.getByTestId("occurred-at")).toContainText("2024-03-10");
    const involvementForm = page.getByRole("form", { name: "Add an involved entity" });
    await involvementForm.getByLabel("Entity").selectOption({ label: `${label} · Service` });
    await involvementForm.getByLabel("How it is involved").selectOption("affected");
    await involvementForm.getByLabel("Involved since").fill("2024-03-10");
    await involvementForm.getByRole("button", { name: "Add involved entity" }).click();
    await expect(
      page.locator(".catalog__item").filter({ hasText: label }).first(),
    ).toBeVisible();
    const menu = page.getByRole("button", { name: "Menu" });
    if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) === "false") {
      await menu.click();
    }
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Investigations", exact: true })
      .click();
    const filter = page.getByLabel("Filter investigations by involved entity");
    await expect(filter).toBeVisible();
    const entityValue = await filter.locator("option").filter({ hasText: label }).first().getAttribute("value");
    expect(entityValue).toBeTruthy();
    await filter.selectOption(entityValue as string);
    await expect(page.getByRole("button", { name: title })).toBeVisible();
    await page.getByLabel("Filter investigations by observed date").fill("2024-03-10");
    await expect(page.getByRole("button", { name: title })).toBeVisible();
  });
});

const hostConfigured = Boolean(process.env.COLLAB_E2E_LOG_TIME_BIN?.trim());

test.describe("host-backed log workbench chronology", () => {
  test.skip(
    !hostConfigured,
    "set COLLAB_E2E_LOG_TIME_BIN to the contextdesk binary to prove timezone apply changes workbench UTC",
  );

  test("timezone apply changes workbench UTC then freeze binds that revision", async ({
    page,
  }) => {
    const worker = [
      "2024-03-10 01:30:00 INFO  batch worker starting scheduled sweep",
      "2024-03-10 02:30:00 WARN  batch worker heartbeat late",
      "2024-03-10 03:05:00 ERROR batch worker sweep failed retry 1",
      "",
    ].join("\n");
    const edge = [
      "2024-03-10T07:30:00Z INFO  edge accepted request rid-0001",
      "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
      "",
    ].join("\n");
    const title = uniqueTitle("Workbench host chronology");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await gotoStage(page, "Capture");
    const zip = syntheticZip([
      { name: "worker/batch.log", data: Buffer.from(worker) },
      { name: "gateway/edge.log", data: Buffer.from(edge) },
    ]);
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "host-workbench.zip",
      mimeType: "application/zip",
      buffer: zip,
    });
    await page.getByRole("button", { name: "Preview intake" }).click();
    await page.getByRole("button", { name: "Commit accepted files" }).click();
    await gotoStage(page, "Analyze");
    const panel = page.locator("#log-time");
    await panel.getByRole("button", { name: "Build the log corpus" }).click();
    await expect(panel.getByText(/timezone not stated/)).toBeVisible();
    const workerRow = panel.locator('[data-route-item="worker/batch.log"]');
    await workerRow.getByRole("button", { name: "Declare a timezone" }).click();
    await panel.getByLabel("Which timezone was this file written in?").fill("America/Chicago");
    await panel.getByRole("button", { name: "Show me what this would do" }).click();
    await expect(panel.getByText("2024-03-10T07:30:00Z")).toBeVisible();
    await panel.getByRole("button", { name: "Apply America/Chicago to this file" }).click();
    await expect(workerRow.locator(".log-time__chip--declared")).toHaveText("America/Chicago");

    const workbench = page.locator("#log-workbench");
    await workbench.getByRole("button", { name: "Show merged chronology" }).click();
    await expect(workbench.getByRole("heading", { name: "Merged chronology" })).toBeVisible();
    await expect(workbench.getByText(/2024-03-10T07:30:00/)).toBeVisible();

    await page.getByLabel("Include worker/batch.log in snapshot").check();
    await page.getByRole("button", { name: /Freeze selected evidence/ }).click();
    await expect(page.getByText(/Frozen evidence set/)).toBeVisible();
    const caseId = await caseIdForTitle(page, title);
    const snapshots = await page.request.get(`/api/cases/${caseId}/snapshots`);
    expect(snapshots.ok()).toBeTruthy();
    const body = (await snapshots.json()) as {
      snapshots?: { normalizationRevision?: number | null }[];
    };
    expect(body.snapshots?.[0]?.normalizationRevision).toBeGreaterThan(0);
    await gotoStage(page, "Compare");
    await expect(page.getByText(/Frozen evidence set/)).toBeVisible();
    await gotoStage(page, "Decide");
    await expect(page.getByRole("heading", { name: /Decide/i }).first()).toBeVisible();
  });
});
