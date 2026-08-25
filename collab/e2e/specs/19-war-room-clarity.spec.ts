import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_MUTATION_HEADERS,
  FIXTURE_ROOT,
  caseIdForTitle,
  createCase,
  fixtureBytes,
  fixtureText,
  gotoStage,
  loginAs,
  openCase,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { syntheticZip } from "../src/synthetic-zip.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

/**
 * Journeys for the people the War Room is actually for.
 *
 * A triage engineer or an IT support colleague arrives without knowing the
 * schema behind any of this. These walks assert what such a reader can see and
 * do: evidence they can tell apart, links that land on the record they name,
 * and honest wording when nothing was recorded. They use synthetic fixtures
 * only and never reach a provider.
 */

const CONTRACTS = join(FIXTURE_ROOT, "..", "..", "contracts", "fixtures");
const contract = (name: string) => JSON.parse(readFileSync(join(CONTRACTS, name), "utf8"));

/** A saved message, exactly as a mail client exports one next to log files. */
const CUSTOMER_EMAIL = [
  "From: dana.customer@example.test",
  "To: support@example.test",
  "Subject: Checkout keeps timing out at payment",
  "Date: Mon, 24 Aug 2026 09:12:00 +0000",
  "",
  "Three of us cannot complete checkout this morning.",
  "The spinner runs for about thirty seconds and then returns to the basket.",
].join("\n");

async function openCompareWorkspace(page: Page, name: string): Promise<void> {
  await page.locator("a.experiment-lab__workspace-tab").filter({ hasText: name }).first().click();
  await expect(page.locator("a.experiment-lab__workspace-tab.is-active")).toContainText(name);
}

/** Load a recorded comparison and its lane transcripts onto an investigation. */
async function seedComparison(
  page: Page,
  caseId: string,
  pkg: string,
  traces: string[],
): Promise<string> {
  const created = await page.request.post(`/api/cases/${caseId}/experiments`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: contract(pkg),
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const experimentId = ((await created.json()) as { id: string }).id;
  for (const trace of traces) {
    const posted = await page.request.post(
      `/api/cases/${caseId}/experiments/${experimentId}/traces`,
      { headers: BROWSER_MUTATION_HEADERS, data: contract(trace) },
    );
    expect(posted.ok(), await posted.text()).toBeTruthy();
  }
  return experimentId;
}

test.describe("War Room clarity for ordinary triage staff", () => {
  test("a ZIP of support files records a saved email as email, not as a log", async ({ page }) => {
    const title = uniqueTitle("ZIP intake");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    await gotoStage(page, "Capture");

    const archive = syntheticZip([
      { name: "support/shared-timeout.log", data: fixtureBytes("evidence", "shared-timeout.log") },
      { name: "support/customer-email.txt", data: Buffer.from(CUSTOMER_EMAIL, "utf8") },
    ]);
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "support-bundle.zip",
      mimeType: "application/zip",
      buffer: archive,
    });
    const [previewed] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/corpus-intake/preview") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Preview intake" }).click(),
    ]);
    expect(previewed.ok(), await previewed.text()).toBeTruthy();
    const preview = (await previewed.json()) as {
      accepted?: { relativePath: string; artifactKind: string }[];
    };
    const kinds = Object.fromEntries(
      (preview.accepted ?? []).map((row) => [row.relativePath, row.artifactKind]),
    );
    // A saved message carries its own headers. Recording it as a log mislabels
    // it on the evidence board, where the kind is the first thing read.
    expect(kinds["support/customer-email.txt"]).toBe("email");
    expect(kinds["support/shared-timeout.log"]).toBe("log");
    await screenshot(page, "19-zip-intake-preview");

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
  });

  test("email and chat evidence read as named records with their own excerpts", async ({ page }) => {
    const title = uniqueTitle("Email and chat");
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await uploadEvidence(page, caseId, {
      kind: "email",
      summary: "Customer report of checkout timeouts",
      filename: "customer-report.eml",
      mediaType: "message/rfc822",
      bytes: Buffer.from(CUSTOMER_EMAIL, "utf8"),
      privacyClass: "share_safe",
    });
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Checkout timeout trace",
      filename: "checkout-timeout-trace.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "checkout-timeout-trace.log"),
      privacyClass: "share_safe",
    });

    await page.reload();
    await openCase(page, title);
    // The evidence board names each record by its filename, so two records of
    // different kinds are never presented under one shared label.
    const board = page.locator("main#war-room-main");
    await expect(board.getByText("customer-report.eml").first()).toBeVisible();
    await expect(board.getByText("checkout-timeout-trace.log").first()).toBeVisible();

    await page.getByRole("combobox", { name: "External chat run source" }).count();
    await gotoStage(page, "Capture");
    const form = page.locator("article.case-view form.composer").filter({
      has: page.locator('button[type="submit"]', { hasText: "Import external run" }),
    });
    await form
      .getByRole("textbox", { name: "External run output" })
      .fill(fixtureText("chats", "external-triage-a.txt"));
    await form.locator('select[name="sourceId"]').selectOption({ label: SEEDED_SOURCES.chatA });
    const details = form.locator("details").filter({
      has: page.locator("summary", { hasText: "Import details" }),
    });
    if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
    await form.getByRole("textbox", { name: "Operator username" }).fill(dave.username);
    await form.getByRole("textbox", { name: "Operator identity" }).fill(dave.identityId);
    await form.getByLabel(/I redacted secrets before save/).check();
    const [imported] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/imports") && res.request().method() === "POST",
      ),
      form.getByRole("button", { name: "Import external run" }).click(),
    ]);
    expect(imported.ok(), await imported.text()).toBeTruthy();
    // An imported chat stays marked unverified until a person reads it.
    await expect(page.getByText("Unverified imported run").first()).toBeVisible();
    await screenshot(page, "19-email-and-chat-evidence");
  });

  test("an investigation with no recorded analysis says so without model wording", async ({
    page,
  }) => {
    const title = uniqueTitle("Human only");
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Worker log a person read by hand",
      filename: "unique-worker.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "unique-worker.log"),
      privacyClass: "share_safe",
    });

    await page.reload();
    await openCase(page, title);
    await gotoStage(page, "Compare");

    // Nothing was run, and the surface says exactly that rather than implying
    // an empty comparison is a finished one.
    const main = page.locator("main#war-room-main");
    await expect(main.getByText(/Add or import analysis/)).toBeVisible();
    await expect(main.getByRole("table", { name: /Candidate comparison/ })).toHaveCount(0);

    await gotoStage(page, "Decide");
    await expect(
      page.getByText(/Decisions are human calls|No human decision has been proposed yet/).first(),
    ).toBeVisible();
    await screenshot(page, "19-human-only-work");
  });

  test("a multi-lane comparison tells its evidence apart and links to the exact lane", async ({
    page,
  }) => {
    const title = uniqueTitle("Multi lane");
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await seedComparison(page, caseId, "experiment-package.two-approach.valid.json", [
      "interaction-trace.programmatic.json",
      "interaction-trace.chat.json",
    ]);

    await page.reload();
    await openCase(page, title);
    await gotoStage(page, "Compare");

    await openCompareWorkspace(page, "Evidence");
    const table = page.getByRole("table", { name: /Evidence cross-examination/ });
    await expect(table).toBeVisible();
    // One entry per row header; the evidence name is its first line.
    const names = await table.locator("tbody tr > th").allInnerTexts();
    const headline = names.map((text) => text.split("\n")[0]!.trim()).filter(Boolean);
    expect(headline.length).toBeGreaterThan(1);
    // Two different references must never arrive under one name: this table is
    // where a reader decides what the lanes actually disagree about.
    expect(new Set(headline).size).toBe(headline.length);
    await expect(table).toContainText("Demo checkout log");
    await expect(table).toContainText("Demo inventory timeout");
    // Identifiers are addresses, not names, and stay out of the reading surface.
    expect(await table.innerText()).not.toMatch(/ev-demo-/);
    await screenshot(page, "19-multi-lane-evidence");

    await openCompareWorkspace(page, "Review queue");
    const queueLink = page.getByRole("link", { name: "open run facts" }).first();
    await expect(queueLink).toBeVisible();
    const href = await queueLink.getAttribute("href");
    expect(href).toMatch(/item=cand-/);
    await queueLink.click();
    // The link lands on the lane's own row, not on the heading above a table
    // the reader would then have to search — and the row is on screen when it
    // gets there. Focus settles asynchronously once the workspace has painted.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            const rect = active?.getBoundingClientRect();
            return {
              routeItem: active?.getAttribute("data-route-item") ?? null,
              routeKind: active?.getAttribute("data-route-kind") ?? null,
              inViewport: rect ? rect.top >= -4 && rect.top < window.innerHeight : false,
            };
          }),
        { timeout: 10_000 },
      )
      .toEqual({
        routeItem: expect.stringMatching(/^cand-/),
        routeKind: "lane",
        inViewport: true,
      });

    await openCompareWorkspace(page, "Strategy paths");
    // Recorded step kinds are the transcript's vocabulary; the reader gets
    // words, and the raw term stays available behind the step's details.
    const paths = page.locator(".experiment-lab__paths");
    await expect(paths).toContainText("Input or evidence considered");
    await expect(paths.locator("summary", { hasText: "Trace details" }).first()).toBeVisible();
    expect(await paths.innerText()).not.toMatch(/actor (assistant|tool|human)\b/);
    await screenshot(page, "19-strategy-paths");
  });

  test("the newest comparison is the decision basis and says so", async ({ page }) => {
    const title = uniqueTitle("Two comparisons");
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await seedComparison(page, caseId, "experiment-package.valid.json", []);
    await seedComparison(page, caseId, "experiment-package.two-approach.valid.json", []);

    await page.reload();
    await openCase(page, title);
    await gotoStage(page, "Decide");

    const picker = page.getByRole("navigation", { name: "Comparisons on this investigation" });
    await expect(picker).toBeVisible();
    const rows = picker.getByRole("button");
    // Newest first, said in words. Reading position as currency is what
    // pointed a human decision at stale analysis.
    await expect(rows.first()).toContainText("Latest");
    await expect(rows.first()).toHaveAttribute("aria-current", "page");
    await expect(rows.nth(1)).toContainText("Earlier");
    await screenshot(page, "19-decision-basis");
  });
});

test.describe("War Room clarity: accessibility and narrow screens", () => {
  test("the comparison workspace keeps landmarks, names, and keyboard order", async ({ page }) => {
    const title = uniqueTitle("A11y compare");
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await seedComparison(page, caseId, "experiment-package.two-approach.valid.json", [
      "interaction-trace.programmatic.json",
      "interaction-trace.chat.json",
    ]);
    await page.reload();
    await openCase(page, title);
    await gotoStage(page, "Compare");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("main#war-room-main")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Compare workspace" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Focus a lane" })).toBeVisible();

    // Every table a reader lands on is named, so screen-reader users hear what
    // they are in rather than "table".
    for (const table of await page.getByRole("table").all()) {
      const name = (await table.getAttribute("aria-label"))
        ?? (await table.locator("caption").first().innerText().catch(() => ""));
      expect(name?.trim().length ?? 0).toBeGreaterThan(0);
    }

    // The identifier disclosures are real, reachable controls, not decoration.
    await openCompareWorkspace(page, "Review queue");
    const firstLink = page.getByRole("link", { name: /^open / }).first();
    await firstLink.focus();
    await expect(firstLink).toBeFocused();

    // No control on the workspace is unlabelled.
    const unnamed = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("main#war-room-main button, main#war-room-main a[href]"),
      );
      return nodes
        .filter((node) => {
          const el = node as HTMLElement;
          if (el.closest("[hidden]")) return false;
          const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
          return label.length === 0;
        })
        .map((node) => (node as HTMLElement).className)
        .slice(0, 5);
    });
    expect(unnamed).toEqual([]);
  });

  test("the comparison reads on a phone without the page scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const title = uniqueTitle("Narrow compare");
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await seedComparison(page, caseId, "experiment-package.valid.json", []);
    await page.reload();
    await openCase(page, title);
    await gotoStage(page, "Compare");

    await expect(page.getByRole("table", { name: /Candidate comparison/ })).toBeVisible();
    // Wide content scrolls inside its own wrapper; the page itself must not.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const wrap = page.locator(".experiment-lab__matrix-wrap").first();
    const metrics = await wrap.evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
      scrolls: el.scrollWidth > el.clientWidth,
    }));
    expect(metrics.overflowX).toBe("auto");
    expect(metrics.scrolls).toBe(true);
    await screenshot(page, "19-responsive-375");

    await openCompareWorkspace(page, "Review queue");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await screenshot(page, "19-responsive-review-queue-375");

    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
    await screenshot(page, "19-responsive-1280");
  });
});
