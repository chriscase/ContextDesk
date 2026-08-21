import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  fixtureBytes,
  fixtureText,
  importChat,
  loginAs,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

test.describe("provider-free Rust bridge comparison", () => {
  test.skip(process.env.COLLAB_E2E_BRIDGE !== "1", "set COLLAB_E2E_BRIDGE=1 to run the bridge fixture");

  test("launches gateway lanes, records progress, and hands off a pasted chat", async ({ page }) => {
    const title = uniqueTitle("Bridge comparison");
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic bridge evidence",
      filename: "shared-timeout.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "shared-timeout.log"),
      privacyClass: "share_safe",
    });

    await page.reload();
    await page.locator(".case-list").getByRole("button", { name: title, exact: true }).click();
    const include = page.getByRole("checkbox", { name: "Include shared-timeout.log in snapshot" });
    await include.check();
    await page.getByRole("button", { name: "Freeze selected evidence (1)" }).click();
    await expect(page.getByText(/Runs bound to a snapshot never silently widen/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a snapshot-bound comparison" })).toBeVisible();

    await page.getByRole("combobox", { name: "Execution mode" }).selectOption("gateway");
    await expect(page.getByRole("combobox", { name: "qwen-3.6-27b host connector profile" })).toBeVisible();
    await page.getByRole("combobox", { name: "qwen-3.6-27b host connector profile" }).selectOption("profile:fixture-qwen");
    await page.getByRole("combobox", { name: "gpt-oss-120b host connector profile" }).selectOption("profile:fixture-gpt");
    await page.getByRole("combobox", { name: "ministral-3-14b-instruct-2512 host connector profile" }).selectOption("profile:fixture-ministral");
    await page.getByRole("combobox", { name: "Lane concurrency" }).selectOption("2");
    await page.getByRole("button", { name: "Run gateway comparison" }).click();

    await expect(page.locator(".triage-runs__status--completed").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Host profile profile:fixture-qwen")).toBeVisible();
    await expect(page.getByText("Host profile profile:fixture-gpt")).toBeVisible();
    await expect(page.getByText("Host profile profile:fixture-ministral")).toBeVisible();
    await expect(page.getByText("Same frozen snapshot").first()).toBeVisible();

    await importChat(page, {
      output: fixtureText("chats", "external-triage-a.txt"),
      prompt: "Triage the timeout using only the pasted log facts.",
      sourceLabel: SEEDED_SOURCES.chatA,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
    });
    await page.getByRole("combobox", { name: "External chat run to compare" }).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Review in Experiment Lab" }).first().click();
    await expect(page.getByRole("status")).toContainText("is ready in Experiment Lab", { timeout: 30_000 });
  });
});
