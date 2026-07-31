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
  const report = await client.import.run({ path: "/incidents", deselected: [] });
  return renderVisual(<TimeReviewCard engine={client} report={report} />);
}

describe("import flow visual acceptance", () => {
  beforeEach(async () => {
    await resetVisualState();
  });

  it("preflight panel: normal width, dark and light", async () => {
    await setViewport("normal");
    await applyTheme("dark");
    const { unmount } = renderFlow("preflight");
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-preflight-dark",
    );
    unmount();

    await applyTheme("light");
    renderFlow("preflight");
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-preflight-light",
    );
  });

  it("evidence selector: wide and normal, dark and light", async () => {
    await setViewport("wide");
    await applyTheme("dark");
    const { unmount } = renderFlow("selector");
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-selector-dark-wide",
    );
    unmount();

    await setViewport("normal");
    await applyTheme("light");
    renderFlow("selector");
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-selector-light",
    );
  });

  it("evidence selector: narrow sheet keeps its own scroll, page never overflows", async () => {
    await setViewport("narrow");
    await applyTheme("dark");
    renderFlow("selector");
    expectNoHorizontalPageOverflow();
    // The virtualized viewport owns horizontal scroll for wide identities.
    const viewport = document.querySelector(".import-selector__viewport");
    expect(viewport).not.toBeNull();
    expect(getComputedStyle(viewport as Element).overflowX).toBe("auto");
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-selector-dark-narrow",
    );
  });

  it("timezone card: normal dark/light and narrow dark", async () => {
    await setViewport("normal");
    await applyTheme("dark");
    const first = await renderTimeCard();
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-time-card-dark",
    );
    first.unmount();

    await applyTheme("light");
    const second = await renderTimeCard();
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-time-card-light",
    );
    second.unmount();

    await setViewport("narrow");
    await applyTheme("dark");
    await renderTimeCard();
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "import-time-card-dark-narrow",
    );
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
