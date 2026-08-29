import { expect, test } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  gotoStage,
  loginAs,
  screenshot,
  uniqueTitle,
} from "../src/helpers.js";
import { syntheticZip } from "../src/synthetic-zip.js";
import { FIXTURE_USERS } from "../src/users.js";

/**
 * Zone-less local timestamps spanning the 2024-03-10 US spring-forward.
 * `02:30:00` does not exist in America/Chicago that day, so the pipeline must
 * refuse to place it and the War Room must say so in plain language.
 */
const WORKER_LOG = [
  "2024-03-10 01:30:00 INFO  batch worker starting scheduled sweep",
  "2024-03-10 01:59:59 INFO  batch worker queue depth 4",
  "2024-03-10 02:30:00 WARN  batch worker heartbeat late",
  "2024-03-10 03:05:00 ERROR batch worker sweep failed retry 1",
  "2024-03-10 03:20:00 INFO  batch worker sweep recovered",
  "",
].join("\n");

/** Explicit UTC. A declaration must never rewrite these. */
const GATEWAY_LOG = [
  "2024-03-10T07:30:00Z INFO  edge accepted request rid-0001",
  "2024-03-10T07:45:00Z INFO  edge accepted request rid-0002",
  "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
  "",
].join("\n");

// Without a host binary there is no pipeline to review with, and the routes are
// deliberately unregistered. Skipping is the honest outcome, not a silent pass.
const hostConfigured = Boolean(process.env.COLLAB_E2E_LOG_TIME_BIN?.trim());

test.describe("war room log-time review", () => {
  test.skip(
    !hostConfigured,
    "set COLLAB_E2E_LOG_TIME_BIN to the contextdesk binary to run log-time review",
  );

  test("declares a timezone for an ambiguous log, seeing the DST gap first", async ({
    page,
  }) => {
    const title = uniqueTitle("Log time review");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);

    // Commit two synthetic logs: one zone-less, one already in UTC.
    await gotoStage(page, "Capture");
    const zip = syntheticZip([
      { name: "worker/batch.log", data: Buffer.from(WORKER_LOG, "utf8") },
      { name: "gateway/edge.log", data: Buffer.from(GATEWAY_LOG, "utf8") },
    ]);
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "synthetic-logs.zip",
      mimeType: "application/zip",
      buffer: zip,
    });
    await page.getByRole("button", { name: "Preview intake" }).click();
    const [committed] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/corpus-intake") &&
          !res.url().includes("preview") &&
          res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Commit accepted files" }).click(),
    ]);
    expect(committed.ok(), await committed.text()).toBeTruthy();

    // Capture is where time is reviewed, before evidence is frozen. The
    // Analyze evidence board offers a direct handoff back to this surface.
    await gotoStage(page, "Capture");
    const panel = page.locator("#stage-capture .log-time");
    await expect(
      panel.getByRole("heading", { name: "When did these log lines happen?" }),
    ).toBeVisible();

    const [built] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/log-time/build") && res.request().method() === "POST",
      ),
      panel.getByRole("button", { name: "Build the log corpus" }).click(),
    ]);
    expect(built.ok(), await built.text()).toBeTruthy();

    // The zone-less source is reported as waiting, and nothing is guessed.
    await expect(panel.getByText(/records a clock time but not which timezone/i)).toBeVisible();
    await expect(panel.getByText(/ContextDesk will not guess/i)).toBeVisible();
    const worker = panel.locator('[data-route-item="worker/batch.log"]');
    await expect(worker).toHaveAttribute("data-unresolved", "true");
    await expect(worker.getByText("timezone not stated")).toBeVisible();
    await screenshot(page, "log-time-awaiting-declaration");

    // Preview America/Chicago. The picker starts empty.
    await worker.getByRole("button", { name: "Declare a timezone" }).click();
    const input = panel.getByLabel("Which timezone was this file written in?");
    await expect(input).toHaveValue("");
    await input.fill("America/Chicago");
    const [previewed] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/log-time/preview") && res.request().method() === "POST",
      ),
      panel.getByRole("button", { name: "Show me what this would do" }).click(),
    ]);
    expect(previewed.ok(), await previewed.text()).toBeTruthy();

    // The DST gap is explained before anything is applied.
    await expect(
      panel.getByText(/fall in the hour this zone skips when clocks go forward/i),
    ).toBeVisible();

    // Raw text and normalized instant sit side by side, and the offset shifts
    // across the transition.
    const table = panel.getByRole("table").first();
    await expect(table.getByText("2024-03-10 01:30:00")).toBeVisible();
    await expect(table.getByText("2024-03-10T07:30:00Z")).toBeVisible();
    // Two lines sit before the transition and two after, so each offset
    // legitimately appears more than once.
    await expect(table.getByText("UTC−06:00").first()).toBeVisible();
    await expect(table.getByText("UTC−05:00").first()).toBeVisible();
    await expect(table.getByText(/clocks jumped forward past it/i)).toBeVisible();
    await screenshot(page, "log-time-preview-dst-gap");

    // Apply, then confirm the unplaceable line survives as order-only evidence.
    const [applied] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/log-time/apply") && res.request().method() === "POST",
      ),
      panel.getByRole("button", { name: "Apply America/Chicago to this file" }).click(),
    ]);
    expect(applied.ok(), await applied.text()).toBeTruthy();

    await expect(worker.locator(".log-time__chip--declared")).toHaveText("America/Chicago");
    await expect(panel.getByText(/4 lines placed at an exact time/)).toBeVisible();
    await expect(panel.getByText(/1 line still in file order only/)).toBeVisible();

    // Provenance is inspectable: who decided, on what basis, at which revision.
    await panel.getByText("How this timezone was decided").click();
    await expect(panel.getByText("A person chose this zone here.")).toBeVisible();
    await screenshot(page, "log-time-applied");

    // Undo restores the earlier reading without deleting history.
    const [undone] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/log-time/undo") && res.request().method() === "POST",
      ),
      panel.getByRole("button", { name: "Undo the last time change" }).click(),
    ]);
    expect(undone.ok(), await undone.text()).toBeTruthy();
    await expect(worker).toHaveAttribute("data-unresolved", "true");
    await expect(panel.getByText(/5 lines still in file order only/)).toBeVisible();
  });

  test("refuses a viewer's attempt to change how time is read", async ({ page }) => {
    const title = uniqueTitle("Log time authz");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    // carol holds `viewer` only. The panel gives her no control, but the
    // guarantee that matters is server-side: a hand-made request from her
    // authenticated session must still be refused.
    await loginAs(page, FIXTURE_USERS.carol);
    const refused = await page.evaluate(
      async ({ id, headers }) => {
        const response = await fetch(`/api/cases/${id}/log-time/apply`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            schemaId: "cd-collab.log_time_apply_request.v1",
            source: "worker/batch.log",
            ianaTimezone: "America/Chicago",
            expectedRevision: 1,
            declarationFingerprint: "a".repeat(64),
            idempotencyKey: "viewer-attempt-0001",
          }),
        });
        return response.status;
      },
      { id: caseId, headers: BROWSER_MUTATION_HEADERS },
    );
    expect(refused).toBe(403);

    // Building a corpus is equally out of reach.
    const buildRefused = await page.evaluate(
      async ({ id, headers }) => {
        const response = await fetch(`/api/cases/${id}/log-time/build`, {
          method: "POST",
          headers,
        });
        return response.status;
      },
      { id: caseId, headers: BROWSER_MUTATION_HEADERS },
    );
    expect(buildRefused).toBe(403);
  });
});
