import { expect, test } from "@playwright/test";
import {
  addTimelineEntry,
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  fixtureText,
  importChat,
  loginAs,
  screenshot,
  timeline,
  uniqueTitle,
  stagePanel,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

test.describe("plain-text external chat import", () => {
  test("imports two transcripts and records corroboration vs contradiction", async ({ page }) => {
    const title = uniqueTitle("Chat import case");
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await createCase(page, title);
    await addTimelineEntry(page, "note", "On-call observation: mailer timeouts around syn-1.");
    const caseId = await caseIdForTitle(page, title);
    const note = (await timeline(page, caseId)).find((ev) => ev.kind === "contribution_created");
    expect(note?.targetId).toBeTruthy();

    await importChat(page, {
      output: fixtureText("chats", "external-triage-a.txt"),
      prompt: "Triage the mailer timeout using only the pasted log facts.",
      sourceLabel: SEEDED_SOURCES.chatA,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
      visibility: "importer_described",
    });
    await importChat(page, {
      output: fixtureText("chats", "external-triage-b.txt"),
      sourceLabel: SEEDED_SOURCES.chatB,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
    });
    await expect(page.getByText("Unverified imported run")).toHaveCount(2);
    const captureStage = stagePanel(page, "Capture");
    await expect(captureStage.getByText(/queue depth is the root cause/)).toBeVisible();
    await expect(captureStage.getByText(/DNS NXDOMAIN/)).toBeVisible();

    const first = page.locator(".imported-run").filter({ hasText: "queue depth is the root cause" });
    const firstDetails = first.locator("details.imported-run__technical");
    await firstDetails.getByText("Inspect recorded provenance").click();
    await expect(firstDetails).toContainText("Prompt coverage");
    await expect(firstDetails).toContainText("Output coverage");
    await expect(firstDetails).toContainText("Evidence visibility");
    await expect(firstDetails).toContainText("Described by the importer");
    await expect(firstDetails).toContainText("Importer recorded that secrets were redacted");
    await expect(firstDetails).not.toContainText("Verified");
    await first.locator('select[name="state"]').selectOption("corroborated");
    await first.getByRole("combobox", { name: "Supporting record" }).selectOption(note!.targetId!);
    await first.getByRole("button", { name: "Save review" }).click();
    await expect(first.locator(".imported-run__banner")).toHaveText("Corroborated by a human");

    const second = page.locator(".imported-run").filter({ hasText: "DNS NXDOMAIN" });
    await second.locator('select[name="state"]').selectOption("contradicted");
    await second.getByRole("combobox", { name: "Supporting record" }).selectOption(note!.targetId!);
    await second.getByRole("button", { name: "Save review" }).click();
    await expect(second.locator(".imported-run__banner")).toHaveText("Contradicted");
    await screenshot(page, "04-imported-chats-judgment");
  });

  test("inspects rich recorded provenance beside Human Assessments without treating claims as proof", async ({
    page,
  }) => {
    const title = uniqueTitle("Imported provenance inspector");
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await addTimelineEntry(page, "note", "Human observation available for legacy Save review.");

    const catalogResponse = await page.request.get("/api/catalog/sources");
    expect(catalogResponse.ok(), await catalogResponse.text()).toBeTruthy();
    const catalog = await catalogResponse.json() as {
      sources?: Array<{ id?: string; name?: string }>;
    };
    const sourceId = catalog.sources?.find((source) => source.name === SEEDED_SOURCES.chatA)?.id;
    expect(sourceId).toBeTruthy();

    const output = "Recorded imported analysis with a claimed provider trace.";
    const importedResponse = await page.request.post(`/api/cases/${caseId}/imports`, {
      headers: BROWSER_MUTATION_HEADERS,
      data: {
        outputText: output,
        promptText: "Inspect only the recorded synthetic mailer evidence.",
        sourceId,
        operatorId: dave.identityId,
        operatorUsername: dave.username,
        promptCompleteness: "partial",
        outputCompleteness: "exact",
        workflowCompleteness: "partial",
        evidenceVisibility: "importer_described",
        visibilityNote: "The importer described one bounded evidence window.",
        snapshotBinding: "fixture-snapshot-provenance-v1",
        provider: "Fixture assistant",
        model: "Fixture model",
        version: "2026-09",
        claimedTraces: ["provider trace claim 42"],
        uncertainty: "The provider trace has not been independently checked.",
        timing: "8 seconds",
        cost: "$0.02 recorded by importer",
        redacted: true,
      },
    });
    expect(importedResponse.ok(), await importedResponse.text()).toBeTruthy();
    const importedBody = await importedResponse.json() as { id?: string };
    expect(importedBody.id).toBeTruthy();

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(
      `/investigations/${caseId}/capture?section=triage-capture&item=${encodeURIComponent(importedBody.id!)}&kind=imported-run#triage-capture`,
    );
    const imported = page.locator(".imported-run").filter({ hasText: output });
    await expect(imported).toBeVisible();
    await expect(imported).toHaveAttribute("data-focused", "true");
    const details = imported.locator("details.imported-run__technical");
    await expect(details).toHaveAttribute("open", "");
    await expect(details).toContainText("Prompt coveragePartial");
    await expect(details).toContainText("Output coverageExact");
    await expect(details).toContainText("Workflow coveragePartial");
    await expect(details).toContainText("Evidence visibilityDescribed by the importer");
    await expect(details).toContainText("Evidence itemsNot recorded");
    await expect(details).toContainText("Tool identityFixture assistant · Fixture model · 2026-09");
    await expect(details).toContainText("Run timing8 seconds");
    await expect(details).toContainText("Recorded cost$0.02 recorded by importer");
    await expect(details).toContainText("PrivacyPrivate to this case");
    await expect(details).toContainText(
      "Importer recorded that secrets were redacted; ContextDesk did not verify that claim",
    );
    await expect(details.getByRole("heading", { name: "Claimed traces — not independently verified" })).toBeVisible();
    await expect(details).toContainText("provider trace claim 42");
    await expect(details).not.toContainText("Verified");
    await expect(page.getByRole("heading", { name: "Human assessments", exact: true })).toBeVisible();
    await expect(imported.getByRole("button", { name: "Save review" })).toBeVisible();

    const summary = details.locator("summary");
    await summary.focus();
    await expect(summary).toBeFocused();
    await summary.press("Space");
    await expect(details).not.toHaveAttribute("open", "");
    await summary.press("Enter");
    await expect(details).toHaveAttribute("open", "");

    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await summary.focus();
    expect(await summary.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    const motion = await imported.evaluate((root) => Array.from(root.querySelectorAll("*"))
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.animationName !== "none"
          || style.transitionDuration.split(",").some((duration) => duration.trim() !== "0s");
      }).length);
    expect(motion).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  test("keeps output-only provenance visibly incomplete", async ({ page }) => {
    const title = uniqueTitle("Output-only import case");
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await createCase(page, title);
    await page.setViewportSize({ width: 320, height: 900 });
    await importChat(page, {
      output: "Output copied from a tool without its original prompt.",
      sourceLabel: SEEDED_SOURCES.chatA,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
      visibility: "unknown",
    });

    const imported = page.locator(".imported-run").filter({ hasText: "Output copied from a tool" });
    const details = imported.locator("details.imported-run__technical");
    await details.locator("summary").click();
    await expect(imported.locator(".imported-run__banner")).toHaveText("Unverified imported run");
    await expect(details).toContainText("Prompt coverageUnknown");
    await expect(details).toContainText("Output coverageUnknown");
    await expect(details).toContainText("Evidence visibilityUnknown — not recorded");
    await expect(details).toContainText("Original prompt was not recorded.");
    await expect(details).not.toContainText("Output coverageExact");
    await expect(details).not.toContainText("Verified");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
