import { expect, test } from "@playwright/test";
import { createCase, loginAs, uniqueTitle } from "../src/helpers.js";
import { INVENTED_ROUTES, WAR_ROOM_SURFACE_MAP } from "../src/surface-map.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("comparison lanes and requested war-room states", () => {
  test("comparison-lane APIs from unmerged local work are not present", async ({ request }) => {
    for (const path of INVENTED_ROUTES) {
      const get = await request.get(path);
      expect(get.status(), `GET ${path}`).toBe(404);
    }
  });

  test("the shell does not render comparison lanes or SDK attempt states", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, uniqueTitle("No lanes"));
    await expect(page.getByRole("button", { name: /launch .*lane|add comparison|start lane/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /comparison lanes|question paths|helpfulness/i })).toHaveCount(0);
    await expect(page.getByText(/shared evidence|unique evidence|similarities\/differences/i)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.locator("[data-run-state],[data-lane]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Update status" })).toBeVisible();
    await expect(page.locator('select[name="status"] option[value="open"]')).toHaveCount(1);
    await expect(page.locator('select[name="status"] option[value="monitoring"]')).toHaveCount(1);
    await expect(page.locator('select[name="status"] option[value="resolved"]')).toHaveCount(1);
    await expect(page.locator('select[name="status"] option[value="archived"]')).toHaveCount(1);
  });

  test("surface map records the probed branch honestly", () => {
    const byStatus = {
      present: WAR_ROOM_SURFACE_MAP.filter((row) => row.status === "present"),
      adapted: WAR_ROOM_SURFACE_MAP.filter((row) => row.status === "adapted"),
      absent: WAR_ROOM_SURFACE_MAP.filter((row) => row.status === "absent"),
    };
    expect(byStatus.present.map((row) => row.id)).toEqual([
      "case-open",
      "import-chat",
      "share-safe-export",
      "responsive-a11y",
    ]);
    expect(byStatus.absent.map((row) => row.id)).toEqual([
      "comparison-lanes",
      "agreement-board",
      "helpfulness",
    ]);
    expect(WAR_ROOM_SURFACE_MAP.every((row) => !row.actual.includes("37a1579b is present"))).toBe(
      true,
    );
  });
});
