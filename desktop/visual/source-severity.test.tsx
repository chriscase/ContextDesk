/** Renderer-only synthetic proof. This is NOT packaged native acceptance. */
import "./support/styles";
import { beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SourceSeverityGlyph } from "../src/components/logExplorer/SourceSeverityGlyph";
import { applyTheme, expectNoAxeViolations, expectNoHorizontalPageOverflow, expectWithinViewport, renderVisual, resetVisualState, setViewport } from "./support/harness";
beforeEach(resetVisualState);
for (const theme of ["dark", "light", "forest", "sand", "slate", "grokptah"] as const) {
  for (const viewport of ["narrow", "normal", "wide"] as const) {
    it(`supports hover, activation and focus in ${theme} ${viewport}`, async () => {
      await setViewport(viewport); await applyTheme(theme);
      renderVisual(<div><SourceSeverityGlyph source={"synthetic/long-source/".repeat(8) + "service.log"} total={10}
        counts={{errorFatal:2,warn:1,info:5,debugTrace:1,unknown:1}} /><button>Next control</button></div>);
      const button = page.getByRole("button", {name:/Severity breakdown/});
      await button.hover();
      await button.click(); // Native pointer down/focus/up/click must not close.
      await expect.element(page.getByRole("tooltip")).toBeVisible();
      await page.getByRole("tooltip").hover();
      await new Promise((resolve) => setTimeout(resolve, 180));
      await expect.element(page.getByRole("tooltip")).toBeVisible();
      const tooltip = document.querySelector('[data-testid="source-severity-tooltip"]') as HTMLElement;
      expectWithinViewport(tooltip); expectNoHorizontalPageOverflow();
      await expectNoAxeViolations(tooltip);
      await page.screenshot({path:`.vitest-attachments/source-severity-${theme}-${viewport}.png`});
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
      await page.getByRole("button", {name:"Next control"}).click();
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await expect.element(page.getByRole("tooltip")).toBeVisible();
      await userEvent.keyboard("{Tab}");
      await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
    });
  }
}
