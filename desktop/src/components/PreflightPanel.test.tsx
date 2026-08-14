import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreflightPanel } from "./PreflightPanel";

describe("PreflightPanel model catalog drift", () => {
  it("offers an explicit path to review and qualify changed models", () => {
    const onFix = vi.fn();
    render(
      <PreflightPanel
        report={{
          hasBlocking: false,
          items: [
            {
              id: "provider.catalog_changed",
              title: "Model catalog changed",
              level: "warn",
              detail:
                "2 added (deepseek-v4-flash, bge-m3); 0 removed. Review the additions and qualify only models you may use.",
              fixAction: "ai",
            },
          ],
        }}
        onRecheck={() => {}}
        onFix={onFix}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /open ai settings/i }),
    );
    expect(onFix).toHaveBeenCalledWith("ai");
  });
});
