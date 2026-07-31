import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { preflightReadiness } from "../../lib/preflightCategories";
import type { PreflightItem } from "../../lib/preflight";

function baseProps(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  return {
    busy: false,
    readiness: "ready" as const,
    scopeLabel: "Workspace: 1 root",
    egressLabel: "Local only",
    onOpenPreflight: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onOpenAi: vi.fn(),
    ...overrides,
  };
}

const item = (
  id: string,
  level: PreflightItem["level"],
  detail = "",
): PreflightItem => ({ id, title: id, level, detail });

describe("StatusBar readiness honesty (#746)", () => {
  it("does not claim Ready when a configured provider was never probed", () => {
    // The regression this guards: hasBlocking is fail-only, so a provider with
    // a key on file and no successful probe used to render "Ready · Preflight
    // ok" with the healthy dot.
    const readiness = preflightReadiness(
      [
        item("provider.key", "pass", "Credential present in secure storage."),
        item("provider.remote", "warn", "Not live-tested yet."),
      ],
      false,
    );
    const { container } = render(<StatusBar {...baseProps({ readiness })} />);

    expect(screen.getByTestId("status-bar-readiness").textContent).toBe(
      "Not verified",
    );
    expect(screen.queryByText("Preflight ok")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Preflight unverified" }),
    ).toBeTruthy();

    const dot = container.querySelector(".status-bar__dot");
    expect(dot?.getAttribute("data-ok")).toBeNull();
    expect(dot?.getAttribute("data-unverified")).toBe("true");
  });

  it("claims Ready only after a probe succeeded", () => {
    const readiness = preflightReadiness(
      [item("provider.remote", "pass", "Live probe succeeded.")],
      false,
    );
    const { container } = render(<StatusBar {...baseProps({ readiness })} />);

    expect(screen.getByTestId("status-bar-readiness").textContent).toBe(
      "Ready",
    );
    expect(screen.getByRole("button", { name: "Preflight ok" })).toBeTruthy();
    expect(
      container.querySelector(".status-bar__dot")?.getAttribute("data-ok"),
    ).toBe("true");
  });

  it("reports blocked setup ahead of unverified readiness", () => {
    const { container } = render(
      <StatusBar {...baseProps({ readiness: "blocked" })} />,
    );
    expect(screen.getByTestId("status-bar-readiness").textContent).toBe(
      "Setup incomplete",
    );
    expect(
      screen.getByRole("button", { name: "Preflight issues" }),
    ).toBeTruthy();
    expect(
      container.querySelector(".status-bar__dot")?.getAttribute("data-warn"),
    ).toBe("true");
  });

  it("shows the live turn state without asserting readiness either way", () => {
    const { container } = render(
      <StatusBar {...baseProps({ busy: true, readiness: "unverified" })} />,
    );
    expect(screen.getByTestId("status-bar-readiness").textContent).toBe(
      "Live · agent turn",
    );
    const dot = container.querySelector(".status-bar__dot");
    expect(dot?.getAttribute("data-live")).toBe("true");
    expect(dot?.getAttribute("data-unverified")).toBeNull();
    expect(dot?.getAttribute("data-ok")).toBeNull();
  });

  it("distinguishes all three readiness states by more than color", () => {
    const labels = (["blocked", "unverified", "ready"] as const).map((r) => {
      const view = render(<StatusBar {...baseProps({ readiness: r })} />);
      const text = view.getByTestId("status-bar-readiness").textContent;
      view.unmount();
      return text;
    });
    expect(new Set(labels).size).toBe(3);
  });
});
