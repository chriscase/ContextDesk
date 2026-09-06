import { expect, test, type Request } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";
import {
  captureCoordinationRequests,
  createQualificationInvestigation,
  expectNoPerRowReads,
  expectOnlyPublicCoordinationWrites,
  expectQueueUrlUnchanged,
  expectSelfBody,
  QUEUE_QUERY_SCHEMA_ID,
} from "../src/operations-queue-coordination-harness.js";

test.describe.configure({ mode: "serial" });

test.describe("Operations Queue self-coordination browser qualification", () => {
  test("claims and releases from the visible row, preserving revision, focus, and URL", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations self coordination");
    const caseId = await createQualificationInvestigation(page, title);
    const requests = captureCoordinationRequests(page, caseId);

    try {
      const queueUrl = `/operations?q=${encodeURIComponent(title)}`;
      await page.goto(queueUrl);
      const initialUrl = page.url();
      await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
      const rowLink = page.getByRole("link", { name: new RegExp(title, "u") });
      const claim = page.getByRole("button", { name: `Claim for me ${title}` });
      await expect(rowLink).toBeVisible();
      await expect(claim).toBeVisible();

      await rowLink.focus();
      await rowLink.press("Tab");
      await expect(claim).toBeFocused();
      await claim.press("Space");
      await expect.poll(() => requests.bodies.length).toBe(1);
      expectSelfBody(requests.bodies[0]!, caseId, "claim_self", 0);
      const claimKey = requests.bodies[0]!.idempotencyKey;
      const release = page.getByRole("button", { name: `Release me ${title}` });
      await expect(release).toBeVisible();
      await expect(release).toBeFocused();
      await release.press("Enter");
      await expect.poll(() => requests.bodies.length).toBe(2);
      expectSelfBody(requests.bodies[1]!, caseId, "release_self", 1);
      expect(requests.bodies[1]!.idempotencyKey).not.toBe(claimKey);
      await expect(page.getByRole("button", { name: `Claim for me ${title}` })).toBeFocused();
      await expectQueueUrlUnchanged(page, initialUrl);
      expectNoPerRowReads(requests.allRequests, caseId);
      expectOnlyPublicCoordinationWrites(requests.allRequests, caseId);
      expect(requests.allRequests.some((request) => {
        const url = new URL(request.url());
        return request.method() === "POST" && url.pathname.endsWith("/coordination");
      })).toBe(true);
    } finally {
      requests.stop();
    }
  });

  test("retries only commit-outcome-unknown with the same request and rejects other failures", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations retry qualification");
    const caseId = await createQualificationInvestigation(page, title);
    const requests = captureCoordinationRequests(page, caseId);
    let applyCount = 0;
    await page.route(`**/api/cases/${caseId}/coordination`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      applyCount += 1;
      if (applyCount === 1) {
        const response = await route.fetch();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "commit_outcome_unknown" }),
        });
        expect(response.ok()).toBeTruthy();
        return;
      }
      await route.continue();
    });

    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      const initialUrl = page.url();
      const claim = page.getByRole("button", { name: `Claim for me ${title}` });
      await expect(claim).toBeVisible();
      await claim.press("Enter");
      await expect(page.getByRole("alert")).toContainText("may have recorded this action");
      expect(requests.bodies).toHaveLength(1);
      const first = requests.bodies[0]!;
      expectSelfBody(first, caseId, "claim_self", 0);
      await expect(page.getByRole("button", { name: `Retry claim for me` })).toBeVisible();
      await page.getByRole("button", { name: "Retry claim for me" }).press("Enter");
      await expect.poll(() => requests.bodies.length).toBe(2);
      expect(requests.bodies[1]).toEqual(first);
      await expect(page.getByRole("button", { name: `Release me ${title}` })).toBeFocused();
      expect(applyCount).toBe(2);
      expectQueueUrlUnchanged(page, initialUrl);
      expectNoPerRowReads(requests.allRequests, caseId);
      expectOnlyPublicCoordinationWrites(requests.allRequests, caseId);
    } finally {
      await page.unroute(`**/api/cases/${caseId}/coordination`);
      requests.stop();
    }
  });

  test("keeps a viewer read-only without emitting coordination writes", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations viewer qualification");
    const caseId = await createQualificationInvestigation(page, title);
    const added = await page.request.post(`/api/cases/${caseId}/participants`, {
      headers: BROWSER_MUTATION_HEADERS,
      data: {
        identityId: FIXTURE_USERS.carol.identityId,
        username: FIXTURE_USERS.carol.username,
      },
    });
    expect(added.ok(), await added.text()).toBeTruthy();
    await loginAs(page, FIXTURE_USERS.carol);
    const requests: Request[] = [];
    const listener = (request: Request) => {
      requests.push(request);
    };
    page.on("request", listener);
    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: title })).toBeVisible();
      expect(requests.some((request) => {
        const url = new URL(request.url());
        return request.method() === "GET"
          && url.pathname === "/api/cases"
          && url.searchParams.get("schemaId") === QUEUE_QUERY_SCHEMA_ID;
      })).toBe(true);
      await expect(page.getByRole("button", { name: /Claim for me|Release me/u })).toHaveCount(0);
      expect(requests.filter((request) => {
        const url = new URL(request.url());
        return request.method() === "POST"
          && (url.pathname === "/api/cases" || /\/api\/cases\/[^/]+\/coordination$/u.test(url.pathname));
      })).toEqual([]);
    } finally {
      page.off("request", listener);
    }
  });
});
