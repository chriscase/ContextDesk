import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyHero,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "./index.js";

describe("shared investigation strategy presentation kit", () => {
  it("provides labelled, composable presentation without behavior authority", () => {
    render(
      <StrategySurface className="example-strategy" labelledBy="example-title">
        <StrategyHero
          eyebrow="Read-only view"
          title="Example strategy"
          titleId="example-title"
          description={<p>Recorded data only.</p>}
          actions={<button type="button">Leave view</button>}
        />
        <StrategyPanel
          title="Recorded evidence"
          titleId="example-evidence"
          actions={<StrategyBadge tone="success">available</StrategyBadge>}
        >
          <StrategyStateNotice tone="warning" title="Refresh incomplete">
            The last available value remains visible.
          </StrategyStateNotice>
          <StrategyActionRow><button type="button">Retry</button></StrategyActionRow>
        </StrategyPanel>
      </StrategySurface>,
    );

    expect(screen.getByRole("heading", { name: "Example strategy" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recorded evidence" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("last available value");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
