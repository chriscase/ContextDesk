import { expect, test } from "@playwright/test";
import { createCase, loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

function activityRequest(url: string): URL | null {
  const candidate = new URL(url);
  return candidate.pathname === "/api/investigation-activity" ? candidate : null;
}

test.describe("Overview Activity Center canonical filters", () => {
  test("keeps supported filters shareable while transport state stays private", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, `Activity query ${Date.now()}`);

    const activityRequests: URL[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const url = activityRequest(request.url());
      if (url) activityRequests.push(url);
    });

    await page.goto(
      "/?activityKind=investigation_created&from=2020-01-01T00:00:00.000Z"
        + "&to=2030-01-01T23:59:59.999Z&cursor=private-cursor&limit=1&schemaId=private-schema",
    );
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect.poll(() => activityRequests.length).toBeGreaterThan(0);

    const canonical = new URL(page.url());
    expect(canonical.pathname).toBe("/");
    expect(canonical.searchParams.get("activityKind")).toBe("investigation_created");
    expect(canonical.searchParams.get("from")).toBe("2020-01-01T00:00:00.000Z");
    expect(canonical.searchParams.get("to")).toBe("2030-01-01T23:59:59.999Z");
    for (const key of ["cursor", "limit", "schemaId"]) {
      expect(canonical.searchParams.has(key)).toBe(false);
    }

    const request = activityRequests.at(-1)!;
    expect(request.searchParams.get("activityKind")).toBe("investigation_created");
    expect(request.searchParams.get("from")).toBe("2020-01-01T00:00:00.000Z");
    expect(request.searchParams.get("to")).toBe("2030-01-01T23:59:59.999Z");
    expect(request.searchParams.has("cursor")).toBe(false);

    const filters = page.getByRole("form", { name: "Filter recorded activity" });
    await filters.getByLabel("Activity").selectOption("handoff_recorded");
    await filters.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/\/?activityKind=handoff_recorded&from=.+&to=.+$/u);
    expect(await filters.getByLabel("Activity").inputValue()).toBe("handoff_recorded");

    await page.goBack();
    await expect(page).toHaveURL(canonical.toString());
    await page.goForward();
    await expect(page).toHaveURL(/\/?activityKind=handoff_recorded&from=.+&to=.+$/u);
  });

  test("strips malformed filters before the authenticated Activity Center requests data", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    const activityRequests: URL[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const url = activityRequest(request.url());
      if (url) activityRequests.push(url);
    });
    await page.goto(
      "/?activityKind=not-real&stage=not-real&from=not-a-date&to=not-a-date"
        + "&cursor=private-cursor&schemaId=private-schema",
    );
    await expect(page.getByRole("heading", { name: "Operating picture" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);
    await expect.poll(() => activityRequests.length).toBeGreaterThan(0);
    const request = activityRequests.at(-1)!;
    for (const key of ["activityKind", "stage", "from", "to", "cursor", "schemaId"]) {
      expect(request.searchParams.has(key)).toBe(false);
    }
  });
});
