import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  fixtureBytes,
  gotoStage,
  loginAs,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("routing, activity locators, and operator UX", () => {
  test("keeps /admin/people canonical and /administration as the roles alias", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await page.goto("/admin/people");
    await expect(page.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/admin\/people$/);

    await page.getByRole("tab", { name: "Group role mappings" }).click();
    await expect(page).toHaveURL(/\/administration$/);
    await expect(page.getByRole("tab", { name: "Group role mappings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.goto("/administration");
    await expect(page.getByRole("tab", { name: "Group role mappings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("keeps /admin/ldap canonical for Directory without exposing a bind password", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await page.goto("/admin/ldap");
    await expect(page.getByRole("tab", { name: "Directory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page).toHaveURL(/\/admin\/ldap$/);
    await expect(
      page.getByRole("heading", { name: "Current directory configuration" }),
    ).toBeVisible();
    await expect(page.getByText(/never shows a bind password/)).toBeVisible();
  });

  test("restores /admin/people after signed-out sign-in", async ({ page }) => {
    await page.goto("/admin/people");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(FIXTURE_USERS.dave.username);
    await page.getByLabel("Password").fill(FIXTURE_USERS.dave.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/admin\/people$/);
  });

  test("opens Discussion from a comment locator and keeps a copyable discussion URL", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Comment locator routing");
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await page.getByRole("button", { name: "Discussion", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Discussion" });
    await expect(panel).toBeVisible();
    await panel.getByRole("textbox", { name: "Message" }).fill("Synthetic discussion comment for locator routing.");
    await panel.getByRole("button", { name: "Post to discussion" }).click();
    await expect(panel.getByLabel("Discussion messages").getByText("Synthetic discussion comment for locator routing.")).toBeVisible();

    const activity = await page.request.get("/api/investigation-activity?limit=30");
    expect(activity.ok(), await activity.text()).toBeTruthy();
    const pageBody = (await activity.json()) as {
      items?: Array<{ activityKind?: string; resolvedRoute?: string; investigationId?: string }>;
    };
    const comment = pageBody.items?.find(
      (item) => item.activityKind === "comment_added" && item.investigationId === caseId,
    );
    expect(comment?.resolvedRoute, "comment activity should project a Discussion route").toBeTruthy();
    expect(comment!.resolvedRoute).toContain("section=discussion");
    expect(comment!.resolvedRoute).not.toContain("case-discussion");

    await page.goto(comment!.resolvedRoute!);
    await expect(page.getByRole("complementary", { name: "Discussion" })).toBeVisible();
    await expect(page.getByText(/Opened Discussion to the comment this activity recorded/)).toBeVisible();
    await expect(
      page.getByLabel("Discussion messages").getByText("Synthetic discussion comment for locator routing."),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/investigations/${caseId}/situation`));
    await expect(page).toHaveURL(/section=discussion/);
  });

  test("job-level activity opens a visible run record instead of a missing workstream", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Job locator");
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic checkout timeout log with the failing stack trace.",
      filename: "checkout-timeout-trace.log",
      mediaType: "text/plain",
      bytes: fixtureBytes("evidence", "checkout-timeout-trace.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await gotoStage(page, "Analyze");
    const include = page.getByRole("checkbox", {
      name: "Include checkout-timeout-trace.log in snapshot",
    });
    await expect(include).toBeVisible();
    await include.check();
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
      ),
      page.getByRole("button", { name: "Freeze selected evidence (1)" }).click(),
    ]);
    await page.getByRole("button", { name: "Run synthetic triage" }).click();
    await expect(page.locator(".triage-runs__status--completed").first()).toBeVisible({
      timeout: 30_000,
    });

    const activity = await page.request.get(`/api/cases/${caseId}/investigation-activity`);
    expect(activity.ok(), await activity.text()).toBeTruthy();
    const body = (await activity.json()) as {
      items?: Array<{ activityKind?: string; locator?: { kind?: string }; resolvedRoute?: string }>;
    };
    const job = body.items?.find(
      (item) => item.activityKind === "workstream_launched" && item.locator?.kind === "workstream",
    );
    const attempt = body.items?.find((item) => item.locator?.kind === "workstream_attempt");
    expect(job?.resolvedRoute).toContain("section=triage-lane-runner");
    expect(job?.resolvedRoute).toContain("kind=triage-run");
    await page.goto(job!.resolvedRoute!);
    await expect(page.getByRole("heading", { name: "Analyze" })).toBeVisible();
    await expect(page.getByText(/Opened the workstream run this activity named/)).toBeVisible();
    await expect(page.getByText(/not part of this investigation/)).toHaveCount(0);
    await expect(page.locator("[data-route-kind='triage-run']").first()).toBeVisible();

    expect(attempt?.resolvedRoute).toContain("section=workstreams");
    await page.goto(attempt!.resolvedRoute!);
    await expect(page.getByText(/Opened this workstream record/)).toBeVisible();
    await expect(page.locator(".workstreams__detail")).toBeVisible();
  });

  test("unauthorized locator resolve is not_found without existence leaks", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Private locator");
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    const activity = await page.request.get(`/api/cases/${caseId}/investigation-activity`);
    const body = (await activity.json()) as {
      items?: Array<{ locator?: { installationId?: string; resourceId?: string } }>;
    };
    const installationId = body.items?.[0]?.locator?.installationId;
    expect(installationId).toMatch(/^inst-/);

    await loginAs(page, FIXTURE_USERS.carol);
    const asViewer = await page.request.get(
      `/api/investigation-resources/resolve?locator=${encodeURIComponent(
        `cdl.v1/${installationId}/${caseId}/evidence_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      )}`,
    );
    expect(asViewer.status()).toBe(404);
    const errorBody = (await asViewer.json()) as { error?: string };
    expect(errorBody.error).toBe("not_found");
    expect(JSON.stringify(errorBody)).not.toContain(title);
    expect(JSON.stringify(errorBody)).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});
