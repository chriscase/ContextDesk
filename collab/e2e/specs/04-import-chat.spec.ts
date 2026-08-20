import { expect, test } from "@playwright/test";
import {
  addTimelineEntry,
  caseIdForTitle,
  createCase,
  fixtureText,
  importChat,
  loginAs,
  screenshot,
  timeline,
  uniqueTitle,
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
    await expect(page.getByText(/queue depth is the root cause/)).toBeVisible();
    await expect(page.getByText(/DNS NXDOMAIN/)).toBeVisible();

    const first = page.locator(".imported-run").filter({ hasText: "queue depth is the root cause" });
    await first.locator('select[name="state"]').selectOption("corroborated");
    await first.getByPlaceholder("Evidence or contribution id").fill(note!.targetId!);
    await first.getByRole("button", { name: "Record human judgment" }).click();
    await expect(page.getByText("Corroborated by a human")).toBeVisible();

    const second = page.locator(".imported-run").filter({ hasText: "DNS NXDOMAIN" });
    await second.locator('select[name="state"]').selectOption("contradicted");
    await second.getByPlaceholder("Evidence or contribution id").fill(note!.targetId!);
    await second.getByRole("button", { name: "Record human judgment" }).click();
    await expect(page.getByText("Contradicted")).toBeVisible();
    await screenshot(page, "04-imported-chats-judgment");
  });
});
