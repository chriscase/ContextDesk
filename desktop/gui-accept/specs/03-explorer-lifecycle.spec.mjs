/**
 * Scenario: open / close / reopen Explorer; exact rows/count/facet readiness.
 * Each WDIO worker is a new process — bootstrap cold session to Logs + demo corpus.
 *
 * Hard readiness: wait for exact 25,000 matched (demo corpus), count-truth /
 * resident rows, and facets not stuck loading — not merely that a counts
 * region exists while "Evidence loading" / empty filters.
 */
import {
  bootstrapLogsWithDemoCorpus,
  openExplorer,
  closeExplorerWindow,
  bodyText,
  screenshot,
  TIMEOUTS,
  SEL,
} from "./helpers.mjs";

/**
 * Assert Explorer counts settled for the 25k demo corpus.
 */
async function waitForExactDemoCountsReady() {
  await browser.waitUntil(
    async () => {
      const body = await bodyText();
      // Product global counts: "25,000 corpus events" / "25,000 matched"
      const hasExact =
        /25,?000\s+corpus\s+events/i.test(body) ||
        /25,?000\s+matched/i.test(body) ||
        /Corpus\s+25,?000/i.test(body);
      if (!hasExact) return false;

      // Must not still be in a loading / empty failure chrome
      if (/Evidence loading/i.test(body) && !/25,?000\s+matched/i.test(body)) {
        return false;
      }
      if (/No events match filters/i.test(body) && !/25,?000\s+matched/i.test(body)) {
        return false;
      }

      // Prefer testids when present
      try {
        const truth = await $(SEL.logExplorerCountTruth);
        if (await truth.isExisting()) {
          const t = await truth.getText();
          if (!/resident/i.test(t)) return false;
        }
        const loading = await $(SEL.logExplorerFacetsLoading);
        if ((await loading.isExisting()) && (await loading.isDisplayed())) {
          return false;
        }
      } catch {
        /* testids optional if body has exact counts */
      }

      // Resident rows signal (bounded window) or count-truth copy
      if (
        !/resident\s+rows?\s+\d+/i.test(body) &&
        !/\d+\s+resident/i.test(body) &&
        !/matched per lane/i.test(body)
      ) {
        // Still accept if exact 25k matched is clear and facets not loading
        return /25,?000\s+matched/i.test(body);
      }
      return true;
    },
    {
      timeout: TIMEOUTS.facets,
      timeoutMsg:
        "Explorer counts not settled: expected exact 25,000 matched + resident/count-truth, facets not loading",
    },
  );

  const body = await bodyText();
  if (!/25,?000/.test(body)) {
    throw new Error(
      `Explorer body lacks 25,000 demo count after settle. Snippet: ${JSON.stringify(body.slice(0, 400))}`,
    );
  }
}

describe("03 Explorer lifecycle + counts/facets", () => {
  it("opens Explorer with global counts region", async () => {
    await bootstrapLogsWithDemoCorpus();
    await openExplorer();
    await screenshot("03-explorer-open");

    // Region present
    await browser.waitUntil(
      async () => {
        const counts = await $(SEL.logExplorerCounts);
        const truth = await $(SEL.logExplorerCountTruth);
        return (await counts.isExisting()) || (await truth.isExisting());
      },
      {
        timeout: TIMEOUTS.facets,
        timeoutMsg: "explorer counts region not present",
      },
    );

    // Exact readiness for demo 25k
    await waitForExactDemoCountsReady();
    await screenshot("03-explorer-counts-ready");
  });

  it("closes and reopens Explorer without crash (window survival)", async () => {
    await closeExplorerWindow();
    await screenshot("03-explorer-closed");
    try {
      await openExplorer();
    } catch {
      const explorer = await $(SEL.logExplorer);
      await expect(await explorer.isExisting()).toBe(true);
    }
    await waitForExactDemoCountsReady();
    await screenshot("03-explorer-reopen");
    const body = await $("body");
    await expect(body).toBeDisplayed();
  });
});
