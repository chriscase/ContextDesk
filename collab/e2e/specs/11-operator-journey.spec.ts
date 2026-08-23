import { expect, test } from "@playwright/test";
import {
  addTimelineEntry,
  caseIdForTitle,
  createCase,
  fixtureBytes,
  fixtureText,
  importChat,
  loginAs,
  openCase,
  screenshot,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

interface SnapshotRow {
  id: string;
  fingerprint: string;
  fairnessClass: string;
  parentSnapshotId: string | null;
  evidence: { evidenceId: string }[];
}

interface ShareSafeExportBody {
  privacyClass?: string;
  review?: {
    snapshotAlias?: string;
    snapshotProof?: {
      basis?: string;
      fairnessClass?: string;
      lineageClass?: string;
      parentSnapshotAlias?: string | null;
    };
    decision?: { status?: string; revision?: number } | null;
    candidates?: unknown[];
    omissions?: {
      modelLabelsIncluded?: boolean;
      participantIdentitiesIncluded?: boolean;
      freeTextIncluded?: boolean;
      privateContentIncluded?: boolean;
      correlatableMetadataIncluded?: boolean;
    };
  };
}

test.describe("complete war-room operator journey", () => {
  test("captures, imports, freezes, compares, decides, exports, and reloads on shipped controls", async ({
    page,
  }) => {
    const title = uniqueTitle("Operator journey");
    const dave = FIXTURE_USERS.dave;
    const humanNote = "On-call observation from the pager: mailer timeouts around syn-1.";
    const acceptedText =
      "Inspect the frozen mailer worker log before changing retries; lane agreement is not proof.";
    const acceptedRationale =
      "Human decision after reading the imported paste and the same-snapshot synthetic lanes.";

    await loginAs(page, dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await addTimelineEntry(page, "note", humanNote);
    await expect(page.getByText("human-authored").first()).toBeVisible();
    await expect(page.getByText(humanNote)).toBeVisible();

    const sharedFile = page.locator("#case-evidence-file");
    await sharedFile.setInputFiles({
      name: "shared-timeout.log",
      mimeType: "text/plain",
      buffer: fixtureBytes("evidence", "shared-timeout.log"),
    });
    await page.getByLabel("Summary").fill("Shared timeout log pasted from the worker host.");
    await page.getByLabel("Artifact kind").selectOption("log");
    await page.getByLabel("Privacy class").selectOption("share_safe");
    const [sharedPosted] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/api/cases/") &&
          res.url().endsWith("/evidence") &&
          res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Upload evidence" }).click(),
    ]);
    expect(sharedPosted.ok(), await sharedPosted.text()).toBeTruthy();
    await expect(page.getByText("shared-timeout.log", { exact: true })).toBeVisible();
    await expect(page.getByText(/hash [0-9a-f]{12}… · share_safe/)).toBeVisible();

    await page.locator("#case-evidence-file").setInputFiles({
      name: "unique-worker.log",
      mimeType: "text/plain",
      buffer: fixtureBytes("evidence", "unique-worker.log"),
    });
    await page.getByLabel("Summary").fill("Owner-only worker log kept off the share-safe snapshot.");
    await page.getByLabel("Artifact kind").selectOption("log");
    await page.getByLabel("Privacy class").selectOption("owner_only");
    const [uniquePosted] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/api/cases/") &&
          res.url().endsWith("/evidence") &&
          res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Upload evidence" }).click(),
    ]);
    expect(uniquePosted.ok(), await uniquePosted.text()).toBeTruthy();
    await expect(page.getByText("unique-worker.log", { exact: true })).toBeVisible();
    await expect(page.getByText(/hash [0-9a-f]{12}… · owner_only/)).toBeVisible();

    await importChat(page, {
      output: fixtureText("chats", "external-triage-a.txt"),
      prompt: "Triage the mailer timeout using only the pasted log facts.",
      sourceLabel: SEEDED_SOURCES.chatA,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
      visibility: "importer_described",
    });
    const imported = page.locator(".imported-run").filter({ hasText: "queue depth is the root cause" });
    await expect(imported.locator(".imported-run__banner")).toHaveText("Unverified imported run");
    await expect(imported).toContainText("Fixture chat assistant");
    await expect(imported).toContainText("kind external-tool");
    await expect(imported).toContainText("visibility importer_described");
    await expect(imported).not.toContainText("human-authored");
    await expect(page.getByText("imported output").first()).toBeVisible();
    await expect(page.getByText("imported · unverified").first()).toBeVisible();
    await expect(page.getByText(/\d+ human (entry|entries)/)).toBeVisible();
    await expect(page.getByText(/1 imported run/)).toBeVisible();

    const includeShared = page.getByRole("checkbox", {
      name: "Include shared-timeout.log in snapshot",
    });
    await includeShared.check();
    await expect(
      page.getByRole("checkbox", { name: "Include unique-worker.log in snapshot" }),
    ).not.toBeChecked();
    const [frozen] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
      ),
      page.getByRole("button", { name: "Freeze selected evidence (1)" }).click(),
    ]);
    const frozenBody = (await frozen.json()) as SnapshotRow;
    expect(frozenBody.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(frozenBody.fairnessClass).toBe("same_snapshot");
    expect(frozenBody.parentSnapshotId).toBeNull();
    expect(frozenBody.evidence).toHaveLength(1);
    const shortFp = `${frozenBody.fingerprint.slice(0, 12)}…`;
    await expect(page.getByRole("heading", { name: "Snapshot lineage" })).toBeVisible();
    await expect(page.getByText(/1 items ·/)).toBeVisible();
    await expect(page.getByText(/Runs bound to a snapshot never silently widen/)).toBeVisible();
    await expect(page.locator(".case-memory__snapshot small")).toHaveText(shortFp);

    const snapshotsRes = await page.request.get(`/api/cases/${caseId}/snapshots`);
    expect(snapshotsRes.ok(), await snapshotsRes.text()).toBeTruthy();
    const snapshots = ((await snapshotsRes.json()) as { snapshots?: SnapshotRow[] }).snapshots ?? [];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.fingerprint).toBe(frozenBody.fingerprint);

    await expect(page.locator(".triage-runs__mode")).toHaveText("synthetic / offline");
    await expect(page.getByRole("button", { name: "Run synthetic comparison" })).toBeEnabled();
    await page.getByRole("button", { name: "Run synthetic comparison" }).click();
    await expect(page.locator(".triage-runs__status--completed").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Same frozen snapshot").first()).toBeVisible();
    await expect(page.getByText(`snapshot ${shortFp}`).first()).toBeVisible();
    const completedLanes = page.locator(".triage-runs__job .triage-runs__candidate");
    await expect(completedLanes).toHaveCount(3);
    await expect(completedLanes.filter({ hasText: "qwen-3.6-27b" })).toContainText("settled");
    await expect(completedLanes.filter({ hasText: "gpt-oss-120b" })).toContainText("settled");
    await expect(completedLanes.filter({ hasText: "ministral-3-14b-instruct-2512" })).toContainText("settled");
    await expect(page.getByText(/usage unknown · cost unknown/).first()).toBeVisible();
    await expect(
      page.getByText(/Synthetic reviewer result: inspect the 1 frozen evidence item/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Review in Experiment Lab" }).first().click();
    await expect(page.getByRole("status")).toContainText("is ready in Experiment Lab", {
      timeout: 30_000,
    });
    await expect(page.getByText(`snapshot ${frozenBody.fingerprint.slice(0, 12)}`).first()).toBeVisible();
    await expect(page.getByText("Agreement is not proof of correctness.").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "What agrees" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What differs" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What stays unknown" })).toBeVisible();
    await expect(page.getByText("Unknown stays unknown until evidence resolves it.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Snapshot lineage" })).toBeVisible();
    await expect(page.getByText("usage unknown").first()).toBeVisible();
    await expect(page.getByText("cost unknown").first()).toBeVisible();

    await page.getByText("Propose a new human decision").click();
    const propose = page.locator("form.composer").filter({
      has: page.getByRole("button", { name: "Propose decision" }),
    });
    await propose.getByPlaceholder("Proposed decision").fill(acceptedText);
    await propose.getByPlaceholder("Decision rationale").fill(acceptedRationale);
    await propose.getByRole("button", { name: "Propose decision" }).click();
    const decisionLine = page.locator(".experiment-lab__decision-card .experiment-lab__decision-line");
    await expect(decisionLine).toContainText(`(proposed): ${acceptedText}`);
    await page.getByText("Accept the proposed decision").click();
    await page.getByRole("button", { name: "Accept decision" }).click();
    await expect(decisionLine).toContainText(`(accepted): ${acceptedText}`);
    await expect(page.locator(".experiment-lab__decision-card .experiment-lab__decision-rationale")).toContainText(
      acceptedRationale,
    );

    await page.getByRole("button", { name: "Export share-safe review" }).click();
    await expect(page.getByText("Share-safe export ready")).toBeVisible();
    await expect(page.getByText(/accepted · revision \d+/)).toBeVisible();
    await page.getByText("View raw export").click();
    const exportedText = await page.locator(".experiment-lab__raw-export pre").innerText();
    const exported = JSON.parse(exportedText) as ShareSafeExportBody;
    expect(exported.privacyClass).toBe("share_safe");
    expect(exported.review?.decision?.status).toBe("accepted");
    expect(exported.review?.decision?.revision).toBeGreaterThanOrEqual(1);
    expect(exported.review?.snapshotAlias).toBe("snapshot-1");
    expect(exported.review?.snapshotProof).toEqual({
      basis: "host_frozen_snapshot",
      fairnessClass: "same_snapshot",
      lineageClass: "root",
      parentSnapshotAlias: null,
    });
    expect(exported.review?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(exported.review?.omissions).toEqual({
      modelLabelsIncluded: false,
      participantIdentitiesIncluded: false,
      freeTextIncluded: false,
      privateContentIncluded: false,
      correlatableMetadataIncluded: false,
    });
    expect(exportedText).not.toContain(dave.password);
    expect(exportedText).not.toContain(frozenBody.fingerprint);
    expect(exportedText).not.toContain(humanNote);
    expect(exportedText).not.toContain(acceptedText);
    await expect(page.getByText("unique-worker.log", { exact: true })).toBeVisible();
    await expect(page.getByText(/hash [0-9a-f]{12}… · owner_only/)).toBeVisible();

    await screenshot(page, "11-operator-journey");
    await page.reload();
    await expect(page.getByText(`Signed in as ${dave.username}`)).toBeVisible();
    await openCase(page, title);
    await expect(page.getByText(humanNote)).toBeVisible();
    await expect(page.getByText("human-authored").first()).toBeVisible();
    await expect(imported.locator(".imported-run__banner")).toHaveText("Unverified imported run");
    await expect(page.getByText("imported output").first()).toBeVisible();
    await expect(page.locator(".case-memory__snapshot small")).toHaveText(shortFp);
    await expect(page.getByText("Same frozen snapshot").first()).toBeVisible();
    await expect(completedLanes).toHaveCount(3);
    await expect(decisionLine).toContainText(`(accepted): ${acceptedText}`);
    await expect(page.getByRole("heading", { name: "Newly concluded" })).toBeVisible();
  });
});
