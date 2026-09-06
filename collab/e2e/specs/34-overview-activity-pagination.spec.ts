import { expect, test } from "@playwright/test";
import { loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const INVESTIGATION_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "inst-activityfixture";
const NOTICE =
  "Activity is a projection of recorded investigation events, not a second source of truth.";
const ACTIVITY_SCHEMA = "cd-collab.investigation_activity_item.v1";
const PAGE_SCHEMA = "cd-collab.investigation_activity_page.v1";
const ERROR_SCHEMA = "cd-collab.investigation_activity_error.v1";
const ACTIVITY_A = "a".repeat(64);
const ACTIVITY_B = "b".repeat(64);
const ACTIVITY_C = "c".repeat(64);
const FILTER_FINGERPRINT = "c".repeat(64);
const ROUTE = `/investigations/${INVESTIGATION_ID}/situation?section=stage-situation#stage-situation`;

function cursor(activityId: string, occurredAt: string, seq: number): string {
  const payload = JSON.stringify({
    activityId,
    filterFingerprint: FILTER_FINGERPRINT,
    investigationId: INVESTIGATION_ID,
    occurredAt,
    seq,
    v: 1,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function item(
  activityId: string,
  occurredAt: string,
  summary: string,
  orderTieBreak: number,
) {
  return {
    schemaId: ACTIVITY_SCHEMA,
    activityId,
    occurredAt,
    orderTieBreak,
    actorId: "fixture-dave",
    actorLabel: "dave",
    investigationId: INVESTIGATION_ID,
    investigationTitle: "Activity pagination fixture",
    activityKind: "investigation_created",
    summary,
    locator: {
      schemaId: "cd-collab.investigation_resource_locator.v1",
      version: 1,
      installationId: INSTALLATION_ID,
      investigationId: INVESTIGATION_ID,
      kind: "investigation",
      resourceId: INVESTIGATION_ID,
      pathname: ROUTE,
    },
    resolvedRoute: ROUTE,
    provenanceClass: "system",
    privacyVisibility: "member",
    revision: null,
    sourceEventId: `fixture-${orderTieBreak}`,
    humanFinding: false,
  };
}

function page(items: readonly unknown[], nextCursor: string | null) {
  return {
    schemaId: PAGE_SCHEMA,
    items,
    nextCursor,
    notices: [
      NOTICE,
      "A resource locator is not an authorization token.",
      "AI or imported output is never a human finding.",
      "Historical restored participants are attribution only.",
    ],
  };
}

function assertPageEnvelope(value: ReturnType<typeof page>): void {
  expect(value.schemaId).toBe(PAGE_SCHEMA);
  expect(value.notices).toContain(NOTICE);
  expect(
    value.items.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "schemaId" in entry &&
        entry.schemaId === ACTIVITY_SCHEMA,
    ),
  ).toBe(true);
}

test.describe("Overview Activity Center cursor continuation", () => {
  test("loads an opaque next page, deduplicates rows, and keeps transport state out of the URL", async ({
    page: browserPage,
  }) => {
    const firstCursor = cursor(ACTIVITY_A, "2026-01-01T00:00:00.000Z", 1);
    const requests: URL[] = [];
    const responses: Array<{ status: number; body: unknown }> = [];
    browserPage.on("response", async (response) => {
      if (!response.url().includes("/api/investigation-activity")) return;
      try {
        responses.push({
          status: response.status(),
          body: await response.json(),
        });
      } catch {
        // The browser may observe an aborted response while the fixture is closing.
      }
    });
    await browserPage.route("**/api/investigation-activity*", async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      if (url.searchParams.get("cursor") === firstCursor) {
        const responseBody = page(
          [
            item(
              ACTIVITY_A,
              "2026-01-01T00:00:00.000Z",
              "opened the investigation",
              1,
            ),
            item(
              ACTIVITY_B,
              "2025-12-31T23:00:00.000Z",
              "recorded a later page event",
              2,
            ),
          ],
          null,
        );
        assertPageEnvelope(responseBody);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(responseBody),
        });
        return;
      }
      if (
        url.searchParams.get("activityKind") !== null &&
        url.searchParams.get("activityKind") !== "investigation_created"
      ) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            schemaId: ERROR_SCHEMA,
            error: "invalid_filter",
          }),
        });
        return;
      }
      const responseBody = page(
        [
          item(
            ACTIVITY_C,
            "2025-12-30T23:00:00.000Z",
            "captured prior page context",
            3,
          ),
          item(
            ACTIVITY_A,
            "2026-01-01T00:00:00.000Z",
            "opened the investigation",
            1,
          ),
        ],
        firstCursor,
      );
      assertPageEnvelope(responseBody);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(responseBody),
      });
    });

    await loginAs(browserPage, FIXTURE_USERS.dave);
    const requestCountBeforeFilteredGoto = requests.length;
    await browserPage.goto("/?activityKind=investigation_created");
    await expect(
      browserPage.getByRole("heading", { name: "Operating picture" }),
    ).toBeVisible();
    await expect(
      browserPage.getByRole("link", { name: /opened the investigation/ }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("link", { name: /captured prior page context/ }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("button", { name: "Load more activity" }),
    ).toBeVisible();

    await browserPage
      .getByRole("button", { name: "Load more activity" })
      .click();
    await expect(
      browserPage.getByRole("link", { name: /recorded a later page event/ }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("link", { name: /opened the investigation/ }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("link", { name: /captured prior page context/ }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("button", { name: "Load more activity" }),
    ).toHaveCount(0);
    const location = new URL(browserPage.url());
    expect(location.pathname).toBe("/");
    expect(location.hash).toBe("");
    expect(location.searchParams.get("activityKind")).toBe(
      "investigation_created",
    );
    expect(location.searchParams.has("cursor")).toBe(false);
    expect(browserPage.url()).not.toContain(firstCursor);
    const postGotoRequests = requests.slice(requestCountBeforeFilteredGoto);
    const firstFilteredRequestIndex = postGotoRequests.findIndex(
      (request) =>
        request.searchParams.get("activityKind") === "investigation_created",
    );
    expect(firstFilteredRequestIndex).toBeGreaterThanOrEqual(0);
    const filteredRequests = postGotoRequests.slice(firstFilteredRequestIndex);
    expect(
      filteredRequests.every(
        (request) =>
          request.searchParams.get("activityKind") === "investigation_created",
      ),
    ).toBe(true);
    expect(filteredRequests[0]?.searchParams.has("cursor")).toBe(false);
    const continuationRequestIndex = filteredRequests.findIndex(
      (request) => request.searchParams.get("cursor") === firstCursor,
    );
    expect(continuationRequestIndex).toBe(filteredRequests.length - 1);
    await expect
      .poll(() =>
        responses.some(
          ({ body }) =>
            typeof body === "object" &&
            body !== null &&
            "schemaId" in body &&
            body.schemaId === PAGE_SCHEMA,
        ),
      )
      .toBe(true);
  });

  test("recovers a stale cursor by restarting the filtered window without mixing pages", async ({
    page: browserPage,
  }) => {
    const firstCursor = cursor(ACTIVITY_A, "2026-01-01T00:00:00.000Z", 1);
    const requests: URL[] = [];
    const responses: Array<{ status: number; body: unknown }> = [];
    let stale = true;
    let restarted = false;
    browserPage.on("response", async (response) => {
      if (!response.url().includes("/api/investigation-activity")) return;
      try {
        responses.push({
          status: response.status(),
          body: await response.json(),
        });
      } catch {
        // The browser may observe an aborted response while the fixture is closing.
      }
    });
    await browserPage.route("**/api/investigation-activity*", async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      if (url.searchParams.get("cursor") === firstCursor && stale) {
        stale = false;
        restarted = true;
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            schemaId: ERROR_SCHEMA,
            error: "stale_cursor",
          }),
        });
        return;
      }
      if (
        url.searchParams.get("activityKind") !== null &&
        url.searchParams.get("activityKind") !== "investigation_created"
      ) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            schemaId: ERROR_SCHEMA,
            error: "invalid_filter",
          }),
        });
        return;
      }
      const responseBody = page(
        [
          item(
            restarted ? ACTIVITY_B : ACTIVITY_A,
            restarted ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
            restarted
              ? "restarted filtered activity window"
              : "opened the investigation",
            restarted ? 2 : 1,
          ),
        ],
        url.searchParams.has("cursor") ? null : firstCursor,
      );
      assertPageEnvelope(responseBody);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(responseBody),
      });
    });

    await loginAs(browserPage, FIXTURE_USERS.dave);
    const requestCountBeforeFilteredGoto = requests.length;
    await browserPage.goto(
      "/?activityKind=investigation_created&stage=situation",
    );
    await expect(
      browserPage.getByRole("link", { name: /opened the investigation/ }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("button", { name: "Load more activity" }),
    ).toBeVisible();
    await browserPage
      .getByRole("button", { name: "Load more activity" })
      .click();

    await expect(
      browserPage.getByRole("link", {
        name: /restarted filtered activity window/,
      }),
    ).toHaveCount(1);
    await expect(
      browserPage.getByRole("link", { name: /opened the investigation/ }),
    ).toHaveCount(0);
    await expect(
      browserPage.getByRole("button", { name: "Load more activity" }),
    ).toBeVisible();
    const location = new URL(browserPage.url());
    expect(location.pathname).toBe("/");
    expect(location.hash).toBe("");
    expect(location.searchParams.get("activityKind")).toBe(
      "investigation_created",
    );
    expect(location.searchParams.get("stage")).toBe("situation");
    expect(location.searchParams.has("cursor")).toBe(false);
    expect(browserPage.url()).not.toContain(firstCursor);
    const postGotoRequests = requests.slice(requestCountBeforeFilteredGoto);
    const firstFilteredRequestIndex = postGotoRequests.findIndex(
      (request) =>
        request.searchParams.get("activityKind") === "investigation_created",
    );
    expect(firstFilteredRequestIndex).toBeGreaterThanOrEqual(0);
    const filteredRequests = postGotoRequests.slice(firstFilteredRequestIndex);
    expect(
      filteredRequests.every(
        (request) =>
          request.searchParams.get("activityKind") ===
            "investigation_created" &&
          request.searchParams.get("stage") === "situation",
      ),
    ).toBe(true);
    const staleCursorIndex = filteredRequests.findIndex(
      (request) => request.searchParams.get("cursor") === firstCursor,
    );
    expect(staleCursorIndex).toBeGreaterThanOrEqual(0);
    expect(staleCursorIndex).toBeGreaterThan(0);
    expect(
      filteredRequests[staleCursorIndex - 1]?.searchParams.has("cursor"),
    ).toBe(false);
    expect(
      filteredRequests[staleCursorIndex + 1]?.searchParams.has("cursor"),
    ).toBe(false);
    await expect
      .poll(() =>
        responses.some(
          ({ status, body }) =>
            status === 400 &&
            typeof body === "object" &&
            body !== null &&
            "schemaId" in body &&
            body.schemaId === ERROR_SCHEMA &&
            "error" in body &&
            body.error === "stale_cursor",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        responses.some(
          ({ body }) =>
            typeof body === "object" &&
            body !== null &&
            "schemaId" in body &&
            body.schemaId === PAGE_SCHEMA,
        ),
      )
      .toBe(true);
  });
});
