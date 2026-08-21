import { expect, test } from "@playwright/test";
import { createCase, loginAs, uniqueTitle } from "../src/helpers.js";
import { INVENTED_ROUTES, WAR_ROOM_SURFACE_MAP } from "../src/surface-map.js";
import { FIXTURE_USERS } from "../src/users.js";

test.describe("comparison lanes and requested war-room states", () => {
  test("unsupported unscoped shortcuts remain absent", async ({ request }) => {
    for (const path of INVENTED_ROUTES) {
      const get = await request.get(path);
      expect(get.status(), `GET ${path}`).toBe(404);
    }
  });

  test("the current war-room renders connected comparison and review surfaces", async ({ page }) => {
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, uniqueTitle("War-room surfaces"));
    await expect(page.getByRole("heading", { name: "Evidence and snapshots" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Experiment lab", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a snapshot-bound comparison" })).toBeVisible();
    await expect(page.getByText("Freeze evidence above before launching a run.")).toBeVisible();
    await expect(page.getByText(/Compare seeded, connected ContextDesk, and pasted-chat triage candidates/)).toBeVisible();
    await expect(page.getByText(/Sources: seeded · ContextDesk connector · pasted chat/)).toBeVisible();
  });

  test("surface map records the probed branch honestly", () => {
    const byStatus = {
      present: WAR_ROOM_SURFACE_MAP.filter((row) => row.status === "present"),
      adapted: WAR_ROOM_SURFACE_MAP.filter((row) => row.status === "adapted"),
      absent: WAR_ROOM_SURFACE_MAP.filter((row) => row.status === "absent"),
    };
    expect(byStatus.present.map((row) => row.id)).toEqual([
      "case-open",
      "evidence-freeze",
      "comparison-lanes",
      "run-states",
      "import-chat",
      "agreement-board",
      "helpfulness",
      "share-safe-export",
      "responsive-a11y",
    ]);
    expect(byStatus.absent.map((row) => row.id)).toEqual([]);
    expect(WAR_ROOM_SURFACE_MAP.every((row) => !row.actual.includes("37a1579b is present"))).toBe(
      true,
    );
  });
});
