import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseIdForTitle,
  createCase,
  fixtureBytes,
  gotoStage,
  loginAs,
  openCase,
  screenshot,
  uniqueTitle,
} from "../src/helpers.js";
import { syntheticZip } from "../src/synthetic-zip.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("investigation-scoped corpus intake", () => {
  test("uploads a synthetic ZIP and directory, inspects logs, freezes, and runs synthetic lanes", async ({
    page,
  }) => {
    const title = uniqueTitle("Corpus intake");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await gotoStage(page, "Capture");
    await expect(page.getByRole("heading", { name: "Logs and files for this investigation" })).toBeVisible();

    const zip = syntheticZip([
      { name: "mailer/shared-timeout.log", data: fixtureBytes("evidence", "shared-timeout.log") },
      { name: "mailer/payload.bin", data: Buffer.from([0, 1, 2, 255]) },
    ]);
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "fixture-mailer.zip",
      mimeType: "application/zip",
      buffer: zip,
    });
    const [previewed] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/corpus-intake/preview") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Preview intake" }).click(),
    ]);
    expect(previewed.ok(), await previewed.text()).toBeTruthy();
    await expect(page.getByText("mailer/shared-timeout.log")).toBeVisible();
    await expect(page.getByText("1 · Unrecognized file type")).toBeVisible();
    await page.getByText("Review rejected file details").click();
    await expect(page.getByText("mailer/payload.bin", { exact: true })).toBeVisible();
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
    const batch = (await committed.json()) as { id: string; items: Array<{ artifactId: string }> };
    expect(batch.items).toHaveLength(1);
    await expect(page.getByRole("link", { name: "Deep link to this batch" })).toBeVisible();

    await page.getByRole("radio", { name: "Directory" }).check();
    const scratch = mkdtempSync(join(tmpdir(), "cd-corpus-dir-"));
    const directory = join(scratch, "workers");
    mkdirSync(directory);
    writeFileSync(join(directory, "unique-worker.log"), fixtureBytes("evidence", "unique-worker.log"));
    await page.getByLabel("Log directory").setInputFiles(directory);
    await page.getByRole("button", { name: "Preview intake" }).click();
    await expect(page.getByText("workers/unique-worker.log")).toBeVisible();
    await page.getByRole("button", { name: "Commit accepted files" }).click();
    await expect(page.getByText("Committed batch")).toBeVisible();

    await gotoStage(page, "Analyze");
    const analyze = page.locator("#stage-analyze");
    const mailerEvidence = analyze.locator(".case-memory__list > li").filter({
      hasText: "mailer/shared-timeout.log",
    });
    await expect(mailerEvidence.getByText("mailer/shared-timeout.log", { exact: true })).toBeVisible();
    await expect(analyze.locator(".case-memory__list").getByText("workers/unique-worker.log", { exact: true })).toBeVisible();
    await mailerEvidence.getByRole("button", { name: "Inspect log" }).click();
    await expect(mailerEvidence.getByText(/mailer timeout id=syn-1/)).toBeVisible();

    await analyze.getByRole("checkbox", { name: "Include mailer/shared-timeout.log in snapshot" }).check();
    const [firstFrozenResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
      ),
      analyze.getByRole("button", { name: "Freeze selected evidence (1)" }).click(),
    ]);
    const firstSnapshot = (await firstFrozenResponse.json()) as {
      id: string;
      fingerprint: string;
      evidence: unknown[];
    };
    expect(firstSnapshot.evidence).toHaveLength(1);

    await analyze.getByRole("checkbox", { name: "Include mailer/shared-timeout.log in snapshot" }).check();
    await analyze.getByRole("checkbox", { name: "Include workers/unique-worker.log in snapshot" }).check();
    const [secondFrozenResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
      ),
      analyze.getByRole("button", { name: "Freeze selected evidence (2)" }).click(),
    ]);
    const secondSnapshot = (await secondFrozenResponse.json()) as {
      id: string;
      fingerprint: string;
      parentSnapshotId: string | null;
      evidence: unknown[];
    };
    expect(secondSnapshot.parentSnapshotId).toBe(firstSnapshot.id);
    expect(secondSnapshot.evidence).toHaveLength(2);
    await expect(analyze.getByText(/Runs bound to a snapshot never silently widen/)).toBeVisible();
    await expect(analyze.getByRole("combobox", { name: "Snapshot", exact: true })).toHaveValue(secondSnapshot.id);
    await analyze.getByRole("checkbox", { name: /gpt-oss-120b .*contributor/ }).check();
    await analyze.getByRole("checkbox", { name: /ministral-3-14b-instruct-2512 .*challenger/ }).check();
    await expect(analyze.getByRole("button", { name: "Run synthetic triage" })).toBeEnabled();
    const [launchedResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/cases/${caseId}/triage-runs`) && res.request().method() === "POST" && res.ok(),
      ),
      analyze.getByRole("button", { name: "Run synthetic triage" }).click(),
    ]);
    const launched = (await launchedResponse.json()) as {
      id: string;
      snapshotId: string;
      snapshotFingerprint: string;
    };
    expect(launched.snapshotId).toBe(secondSnapshot.id);
    expect(launched.snapshotFingerprint).toBe(secondSnapshot.fingerprint);
    await expect(analyze.getByRole("status", { name: "Launch receipt" })).toContainText(
      "2 frozen evidence items",
    );
    const launchedCard = analyze.locator(`[id="triage-run-${launched.id}"]`);
    await expect(launchedCard.locator(".triage-runs__status--completed")).toBeVisible({
      timeout: 30_000,
    });
    const completedLanes = launchedCard.locator(".triage-runs__candidate");
    await expect(completedLanes.filter({ hasText: "qwen-3.6-27b" })).toContainText("settled");
    await expect(completedLanes.filter({ hasText: "gpt-oss-120b" })).toContainText("settled");
    await expect(completedLanes.filter({ hasText: "ministral-3-14b-instruct-2512" })).toContainText(
      "settled",
    );

    await page.goto(
      `/investigations/${caseId}/capture?section=corpus-intake&item=${batch.id}&kind=intake-batch#corpus-intake`,
    );
    await expect(page.getByRole("heading", { name: "Logs and files for this investigation" })).toBeVisible();
    await page.goto(
      `/investigations/${caseId}/analyze?section=triage-evidence-board&item=${batch.items[0]?.artifactId}&kind=evidence#triage-evidence-board`,
    );
    await expect(
      page.locator("#stage-analyze .case-memory__list").getByText("mailer/shared-timeout.log", { exact: true }),
    ).toBeVisible();
    await screenshot(page, "13-corpus-intake");
    await openCase(page, title);
  });
});
