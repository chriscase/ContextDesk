import { expect, test } from "@playwright/test";
import { loadLiveProfile, redactLiveText } from "../src/live-profile.js";

test.describe("opt-in live profile", () => {
  test("logs into a deployed server without echoing secrets", async ({ browser }) => {
    const loaded = loadLiveProfile();
    test.skip(!loaded.ok, loaded.ok ? "" : loaded.reason);

    if (!loaded.ok) return;
    const { profile, password } = loaded;
    const context = await browser.newContext({ baseURL: profile.baseUrl });
    const page = await context.newPage();
    page.on("console", (msg) => {
      const redacted = redactLiveText(msg.text(), profile.username, password);
      expect(redacted).not.toContain(password);
    });
    await page.goto("/");
    await page.getByLabel("Username").fill(profile.username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/Signed in as/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await context.close();
  });
});
