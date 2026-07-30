import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallList, toolCallVisualState } from "./ToolCallList";

describe("ToolCallList pending state", () => {
  it("renders persisted awaiting-permission calls as neutral", () => {
    const { container } = render(
      <ToolCallList
        tools={[
          {
            id: "pending",
            name: "save_memory",
            summary: "awaiting permission",
            ok: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("awaiting permission")).toBeTruthy();
    const row = container.querySelector(".tool-row");
    expect(row?.getAttribute("data-ok")).toBe("pending");
    expect(row?.getAttribute("data-state")).toBe("permission");
    expect(row?.getAttribute("aria-busy")).toBeNull();
  });

  it("keeps completed failures visibly failed with diagnostics expandable", () => {
    const { container } = render(
      <ToolCallList
        tools={[
          {
            id: "failed",
            name: "save_memory",
            summary: "save_memory failed",
            detail: "permission denied",
            ok: false,
          },
        ]}
      />,
    );
    const row = container.querySelector(".tool-row");
    expect(row?.getAttribute("data-ok")).toBe("false");
    expect(row?.getAttribute("data-state")).toBe("failure");
    expect(screen.getByText("permission denied")).toBeTruthy();
  });

  it("treats in-flight tools as running with aria-busy, not warning", () => {
    const { container } = render(
      <ToolCallList
        tools={[
          {
            id: "run",
            name: "search_logs",
            summary: "searching…",
            ok: undefined,
          },
        ]}
      />,
    );
    const row = container.querySelector(".tool-row");
    expect(row?.getAttribute("data-ok")).toBe("running");
    expect(row?.getAttribute("data-state")).toBe("running");
    expect(row?.getAttribute("aria-busy")).toBe("true");
    // Warning icon is reserved for true warnings/failures — running uses tool mark.
    expect(toolCallVisualState({ id: "r", name: "t", summary: "…" })).toBe(
      "running",
    );
  });

  it("maps success distinctly from running and permission", () => {
    expect(
      toolCallVisualState({
        id: "1",
        name: "t",
        summary: "ok",
        ok: true,
      }),
    ).toBe("success");
    expect(
      toolCallVisualState({
        id: "2",
        name: "t",
        summary: "awaiting permission",
        ok: false,
      }),
    ).toBe("permission");
    expect(
      toolCallVisualState({
        id: "3",
        name: "t",
        summary: "boom failed",
        ok: false,
      }),
    ).toBe("failure");
  });
});
