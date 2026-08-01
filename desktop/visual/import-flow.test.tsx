/**
 * Visual acceptance for the unified import flow (#751/#813).
 *
 * Renderer-level proof (headless Chromium): the preflight "Ready to import"
 * panel, the virtualized evidence selector, and the corpus-wide timezone
 * card hold their layout at narrow/normal/wide in both themes with no
 * horizontal page overflow and no axe violations. Not native packaged
 * acceptance.
 */
import "./support/styles";
import "../src/styles/components/import-flow.css";
import { beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createMockEngineClient, defaultMockPreview } from "@contextdesk/client";
import { ImportFlow } from "../src/components/importFlow/ImportFlow";
import { TimeReviewCard } from "../src/components/importFlow/TimeReviewCard";
import {
  INITIAL_IMPORT_FLOW_STATE,
  preselectedIdentities,
  type ImportFlowState,
} from "../src/components/importFlow/importFlowState";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  renderVisual,
  resetVisualState,
  setViewport,
  visualStage,
} from "./support/harness";

function fixtureState(stage: "preflight" | "selector"): ImportFlowState {
  const report = defaultMockPreview();
  return {
    ...INITIAL_IMPORT_FLOW_STATE,
    stage,
    path: "/incidents/checkout-outage",
    report,
    selected: preselectedIdentities(report),
  };
}

function renderFlow(stage: "preflight" | "selector") {
  return renderVisual(
    <ImportFlow
      engine={createMockEngineClient()}
      variant="pane"
      initialState={fixtureState(stage)}
    />,
  );
}

async function renderTimeCard() {
  const client = createMockEngineClient();
  const plan = await client.import.preview("/incidents");
  const report = await client.import.run({
    path: "/incidents",
    planToken: plan.planToken,
    planVersion: plan.planVersion,
    selected: plan.report.items
      .filter((item) => item.role === "log" && item.status !== "blocked")
      .map((item) => item.identity),
  });
  return renderVisual(<TimeReviewCard engine={client} report={report} />);
}

describe("import flow visual acceptance", () => {
  beforeEach(async () => {
    await resetVisualState();
  });

  const WIDTHS = ["narrow", "normal", "wide"] as const;
  const THEMES = ["dark", "light"] as const;

  // The full claimed matrix: three surfaces × three widths × two themes,
  // every cell a committed baseline with a page-overflow assertion.
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      it(`preflight panel: ${width} ${theme}`, async () => {
        await setViewport(width);
        await applyTheme(theme);
        renderFlow("preflight");
        expectNoHorizontalPageOverflow();
        await expect(page.elementLocator(visualStage())).toMatchScreenshot(
          `import-preflight-${theme}-${width}`,
        );
      });

      it(`evidence selector: ${width} ${theme}`, async () => {
        await setViewport(width);
        await applyTheme(theme);
        renderFlow("selector");
        expectNoHorizontalPageOverflow();
        await expect(page.elementLocator(visualStage())).toMatchScreenshot(
          `import-selector-${theme}-${width}`,
        );
      });

      it(`timezone card: ${width} ${theme}`, async () => {
        await setViewport(width);
        await applyTheme(theme);
        await renderTimeCard();
        expectNoHorizontalPageOverflow();
        await expect(page.elementLocator(visualStage())).toMatchScreenshot(
          `import-time-card-${theme}-${width}`,
        );
      });
    }
  }

  it("evidence selector viewport owns horizontal scroll at narrow", async () => {
    await setViewport("narrow");
    await applyTheme("dark");
    renderFlow("selector");
    const viewport = document.querySelector(".import-selector__viewport");
    expect(viewport).not.toBeNull();
    expect(getComputedStyle(viewport as Element).overflowX).toBe("auto");
  });

  it("has no axe violations on preflight, selector, and time card", async () => {
    await setViewport("normal");
    await applyTheme("dark");
    const preflight = renderFlow("preflight");
    await expectNoAxeViolations(visualStage());
    preflight.unmount();

    const selector = renderFlow("selector");
    await expectNoAxeViolations(visualStage());
    selector.unmount();

    await renderTimeCard();
    await expectNoAxeViolations(visualStage());
  });
});
