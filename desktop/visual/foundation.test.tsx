/**
 * Foundation self-test for the visual acceptance harness.
 *
 * Proves the pipeline itself before any surface suite relies on it: the
 * production CSS chain is actually applied (not hex fallbacks), bundled fonts
 * load, html[data-theme] flips real rendered colors, screenshots produce
 * stable baselines, and axe-core runs in-page. If this file fails, no other
 * visual result in the suite can be trusted.
 *
 * Renderer-level proof only (headless Chromium) — not native packaged
 * acceptance.
 */
import "./support/styles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { AppearanceSection } from "../src/components/settings/AppearanceSection";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  renderVisual,
  resetVisualState,
  visualStage,
} from "./support/harness";

function renderAppearance(theme: "dark" | "light") {
  return renderVisual(
    <AppearanceSection
      baseId="visual-foundation"
      theme={theme}
      onThemeChange={vi.fn()}
      uiScale="100"
      onUiScaleChange={vi.fn()}
    />,
  );
}

describe("visual harness foundation", () => {
  beforeEach(async () => {
    await resetVisualState();
  });

  it("applies the production stylesheet chain and bundled fonts", async () => {
    // The skin token must resolve through a real stylesheet on the painted
    // stage: dark --bg-app is a real opaque color, and it must differ from
    // light. An unresolved var() would compute to transparent (#767's silent
    // failure mode), which this catches.
    const stage = visualStage();
    await applyTheme("dark");
    const darkBg = getComputedStyle(stage).backgroundColor;
    await applyTheme("light");
    const lightBg = getComputedStyle(stage).backgroundColor;
    expect(darkBg).toMatch(/^rgb\(/);
    expect(lightBg).toMatch(/^rgb\(/);
    expect(darkBg).not.toBe(lightBg);

    await document.fonts.ready;
    expect(document.fonts.check('16px "Inter"')).toBe(true);
    expect(document.fonts.check('16px "IBM Plex Mono"')).toBe(true);
  });

  it("renders a real component with stable dark and light baselines", async () => {
    await applyTheme("dark");
    const { unmount } = renderAppearance("dark");
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "appearance-section-dark",
    );
    unmount();

    await applyTheme("light");
    renderAppearance("light");
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "appearance-section-light",
    );
  });

  it("has no axe violations on the appearance surface", async () => {
    await applyTheme("dark");
    renderAppearance("dark");
    await expectNoAxeViolations(visualStage());
  });
});
