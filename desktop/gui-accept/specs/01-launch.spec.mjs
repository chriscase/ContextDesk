/**
 * Scenario: launch + main-window readiness.
 * Does not require PreLaunch Ready — body + any production chrome is enough.
 */
import {
  reachReadyStep,
  isReadyStepVisible,
  isMainChromeVisible,
  assertNotDevUrlBlank,
  screenshot,
  TIMEOUTS,
} from "./helpers.mjs";

describe("01 launch + main window readiness", () => {
  it("shows application body and launch or main chrome within timeout", async () => {
    const t0 = Date.now();
    const body = await $("body");
    await body.waitForDisplayed({ timeout: TIMEOUTS.launch });
    await expect(body).toBeDisplayed();
    await assertNotDevUrlBlank();

    // Best-effort advance; launch proof needs Ready or main chrome (not blank body)
    try {
      await reachReadyStep();
    } catch (e) {
      // rethrow cfg(dev) failures; soft only for wizard timing
      if (String(e).includes("localhost") || String(e).includes("cfg(dev)")) throw e;
    }

    const ready =
      (await isReadyStepVisible()) || (await isMainChromeVisible());
    if (!ready) {
      throw new Error("launch chrome not visible after timeout (body alone is not enough)");
    }
    await screenshot("01-launch-ready");
    const title = await browser.getTitle();
    if (title && !/context|desk|log/i.test(title) && title.length > 0) {
      console.warn(`unexpected title: ${title}`);
    }
    const ms = Date.now() - t0;
    if (ms > TIMEOUTS.launch) {
      throw new Error(`launch exceeded bound ${TIMEOUTS.launch}ms (actual ${ms})`);
    }
  });
});
