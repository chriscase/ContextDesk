/**
 * Model role hint line UI (#723) — real component, synthetic model ids only.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelRoleHintLine } from "./ModelRoleHintLine";

describe("ModelRoleHintLine", () => {
  it("renders Suggested for embedding with name-hint basis and a11y label", () => {
    render(<ModelRoleHintLine modelId="bge-m3" id="hint-1" />);
    const el = screen.getByTestId("model-role-hint");
    expect(el.getAttribute("data-role")).toBe("embedding");
    expect(el.getAttribute("data-source")).toBe("name_hint");
    expect(el.textContent).toMatch(/Suggested for: embedding/);
    expect(el.textContent).toMatch(/Basis: Name hint/);
    expect(el.getAttribute("aria-label")).toMatch(/Not measured capability/);
  });

  it("renders unqualified copy for private aliases", () => {
    render(<ModelRoleHintLine modelId="corp-private-alias" />);
    const el = screen.getByTestId("model-role-hint");
    expect(el.getAttribute("data-role")).toBe("unknown");
    expect(el.textContent).toMatch(/Unqualified/);
  });

  it("renders nothing for empty model id", () => {
    const { container } = render(<ModelRoleHintLine modelId="  " />);
    expect(container.querySelector("[data-testid=model-role-hint]")).toBeNull();
  });

  it("marks investigator suggestions for chat-like ids", () => {
    render(<ModelRoleHintLine modelId="grok-3" />);
    const el = screen.getByTestId("model-role-hint");
    expect(el.getAttribute("data-role")).toBe("investigator");
    expect(el.textContent).toMatch(/investigation chat/);
  });
});
