/**
 * Scenario: Noise → Review suggestions via real pointerdown→click;
 * no preselection; no Accept all; conservative ERROR labeling + evidence fields.
 * Cold-session bootstrap to Explorer (shared HOME may have demo from prior workers).
 */
import {
  bootstrapLogsWithDemoCorpus,
  openExplorer,
  pointerClick,
  assertNoAcceptAll,
  assertNoiseConservativeEvidence,
  screenshot,
  TIMEOUTS,
  SEL,
} from "./helpers.mjs";

describe("04 Noise → Review suggestions", () => {
  it("opens Noise review without preselection or Accept all; asserts ERROR evidence copy", async () => {
    await bootstrapLogsWithDemoCorpus();
    try {
      await openExplorer();
    } catch {
      /* may already be open from prior it in same file */
    }

    const noiseBtns = await $$(`//button[contains(., "Noise")]`);
    if ((await noiseBtns.length) === 0) {
      const snippet = (await $("body").getText()).slice(0, 400);
      throw new Error(
        `Noise control not found in Explorer. Body: ${JSON.stringify(snippet)}`,
      );
    }
    await pointerClick(noiseBtns[0]);
    await screenshot("04-noise-menu");

    try {
      const review = await $(`button=${SEL.reviewSuggestions}`);
      if (await review.isDisplayed()) {
        await pointerClick(review);
      } else {
        const link = await $(
          `//*[contains(normalize-space(.), "Review suggestions")]`,
        );
        await pointerClick(link);
      }
    } catch {
      const link = await $(
        `//*[contains(normalize-space(.), "Review suggestions")]`,
      );
      await pointerClick(link);
    }

    await browser.waitUntil(
      async () => {
        const body = await $("body").getText();
        return (
          /Showing\s+\d+|suggestion|candidate|preselected|ERROR\/WARN|Redacted representatives|unavailable/i.test(
            body,
          )
        );
      },
      {
        timeout: TIMEOUTS.noiseReview,
        timeoutMsg: "noise review panel did not appear",
      },
    );
    await screenshot("04-noise-review");

    await assertNoAcceptAll();
    await assertNoiseConservativeEvidence();

    const checks = await $$(
      `//*[contains(@class,"noise") or contains(@class,"candidate")]//input[@type="checkbox"]`,
    );
    for (const c of checks) {
      if (await c.isSelected()) {
        throw new Error("Noise candidate preselected — forbidden");
      }
    }
  });
});
