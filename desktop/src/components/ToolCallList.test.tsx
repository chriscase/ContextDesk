import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallList } from "./ToolCallList";

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
    expect(container.querySelector(".tool-row")?.getAttribute("data-ok")).toBe(
      "pending",
    );
  });

  it("keeps completed failures visibly failed", () => {
    const { container } = render(
      <ToolCallList
        tools={[
          {
            id: "failed",
            name: "save_memory",
            summary: "save_memory failed",
            ok: false,
          },
        ]}
      />,
    );
    expect(container.querySelector(".tool-row")?.getAttribute("data-ok")).toBe(
      "false",
    );
  });
});
