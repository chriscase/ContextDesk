/** Renderer-only proof. Native Save/packaged shell acceptance is separate. */
import "./support/styles";
import "../src/styles/components/import-flow.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createMockEngineClient } from "@contextdesk/client";
import { ImportFlow } from "../src/components/importFlow/ImportFlow";
import { applyTheme, expectNoAxeViolations, expectNoHorizontalPageOverflow, renderVisual, resetVisualState, setViewport, visualStage } from "./support/harness";

vi.mock("../src/lib/dialogs", () => ({
  openDirectoryDialog: async () => "/synthetic/logs",
  openFileDialog: async () => null,
}));
beforeEach(resetVisualState);
for (const theme of ["dark", "light"] as const) {
  it(`exports the current attempt without layout overflow: narrow ${theme}`, async () => {
    await setViewport("narrow");
    await applyTheme(theme);
    const base = createMockEngineClient();
    const saveDiagnostic = vi.fn(async () => ({ status: "saved" as const }));
    const engine = { ...base, import: { ...base.import, beginDiagnostic: async () => "synthetic-handle", saveDiagnostic } };
    renderVisual(<ImportFlow engine={engine} variant="pane" />);
    await page.getByRole("button", { name: "Choose folder…" }).click();
    await expect.element(page.getByRole("region", { name: "Import diagnostic" })).toBeVisible();
    expectNoHorizontalPageOverflow();
    await expectNoAxeViolations(visualStage());
    await page.getByRole("button", { name: "Export import diagnostic…" }).click();
    await expect.element(page.getByText("Import diagnostic saved.")).toBeVisible();
    expect(saveDiagnostic).toHaveBeenCalledWith("synthetic-handle");
    await page.screenshot({ path: `.vitest-attachments/import-diagnostic-${theme}.png` });
  });
}
