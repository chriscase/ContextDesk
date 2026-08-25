import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cases } from "./Cases.js";
import {
  BrandMark,
  EmptyState,
  STAGE_FLOW_STEPS,
  StageFlowDiagram,
  StageIcon,
} from "./graphics.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Every SVG in the shared visual language is decoration: hidden from the
 * accessibility tree and free of text nodes, so it can never change an
 * accessible name, a textContent assertion, or what a screen reader announces.
 */
function expectDecorative(svg: Element | null): void {
  expect(svg).toBeTruthy();
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("focusable")).toBe("false");
  expect((svg?.textContent ?? "").trim()).toBe("");
}

describe("brand mark", () => {
  it("renders as pure decoration with no text and no accessible name", () => {
    const { container } = render(<BrandMark />);
    expectDecorative(container.querySelector("svg.brand-mark"));
  });
});

describe("stage icons", () => {
  it("renders a decorative glyph for every stage without adding name text", () => {
    for (const stage of ["situation", "capture", "analyze", "compare", "decide"] as const) {
      const { container, unmount } = render(<StageIcon stage={stage} />);
      const svg = container.querySelector(`svg.stage-icon[data-stage="${stage}"]`);
      expectDecorative(svg);
      unmount();
    }
  });
});

describe("stage flow diagram", () => {
  it("presents Capture, Analyze, Compare, Decide as a real list in workflow order", () => {
    render(<StageFlowDiagram />);
    const list = screen.getByRole("list", { name: "Capture to Decide stages" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".stage-flow__name")?.textContent);
    expect(names).toEqual(["Capture", "Analyze", "Compare", "Decide"]);
  });

  it("marks only Decide as the human call and keeps its artwork decorative", () => {
    const { container } = render(<StageFlowDiagram />);
    const humanCards = container.querySelectorAll(".stage-flow__card--human");
    expect(humanCards.length).toBe(1);
    expect(humanCards[0]?.getAttribute("data-stage")).toBe("decide");
    expect(STAGE_FLOW_STEPS.filter((step) => step.human).map((step) => step.stage)).toEqual([
      "decide",
    ]);
    for (const svg of container.querySelectorAll("svg")) {
      expectDecorative(svg);
    }
  });

  it("renders a caption only when one is given", () => {
    const { container, rerender } = render(<StageFlowDiagram caption="How work flows." />);
    expect(screen.getByText("How work flows.")).toBeTruthy();
    rerender(<StageFlowDiagram />);
    expect(container.querySelector("figcaption")).toBeNull();
  });
});

describe("empty states", () => {
  it("keeps the recorded-state wording intact beside a decorative illustration", () => {
    const { container } = render(
      <EmptyState art="activity">
        <p>No activity has been recorded yet.</p>
      </EmptyState>,
    );
    expect(screen.getByText("No activity has been recorded yet.")).toBeTruthy();
    expectDecorative(container.querySelector('svg.empty-art[data-art="activity"]'));
  });
});

// ————— Shell integration: the polish must not change recorded-state truth —————

const emptyRoomFetch = () => {
  const stub = vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url === "/api/cases") {
      return { ok: true, json: async () => ({ cases: [] }) };
    }
    if (url === "/api/catalog/sources") {
      return { ok: true, json: async () => ({ sources: [] }) };
    }
    if (url === "/api/investigation-activity?limit=30") {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
};

describe("overview onboarding hero", () => {
  it("shows the Capture. Analyze. Compare. Decide. figure only while no investigation is recorded", async () => {
    emptyRoomFetch();
    render(<Cases roles={["case-lead"]} />);
    expect(
      await screen.findByRole("heading", { name: "Capture. Analyze. Compare. Decide." }),
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: "Capture to Decide stages" });
    expect(within(list).getAllByRole("listitem").length).toBe(4);
    // The empty room still states its recorded-state facts in plain text.
    expect(screen.getByText("No activity has been recorded yet.")).toBeTruthy();
    expect(
      screen.getByText("No high-impact active investigations are recorded."),
    ).toBeTruthy();
  });

  it("stands down as soon as an investigation is recorded", async () => {
    const stub = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") {
        return {
          ok: true,
          json: async () => ({
            cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
          }),
        };
      }
      if (url === "/api/catalog/sources") {
        return { ok: true, json: async () => ({ sources: [] }) };
      }
      if (url === "/api/investigation-activity?limit=30") {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);
    render(<Cases roles={["case-lead"]} />);
    await screen.findByRole("button", { name: "Fixture incident" });
    expect(
      screen.queryByRole("heading", { name: "Capture. Analyze. Compare. Decide." }),
    ).toBeNull();
  });
});

describe("stage stepper", () => {
  it("keeps every stage button's accessible name while adding only decorative badges", async () => {
    const stub = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") {
        return {
          ok: true,
          json: async () => ({
            cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
          }),
        };
      }
      if (url === "/api/catalog/sources") {
        return { ok: true, json: async () => ({ sources: [] }) };
      }
      if (
        url.endsWith("/timeline") ||
        url.endsWith("/contributions") ||
        url.endsWith("/imports")
      ) {
        return {
          ok: true,
          json: async () => ({ events: [], contributions: [], runs: [] }),
        };
      }
      if (url.endsWith("/experiments") || url.endsWith("/export/inventory")) {
        return { ok: true, json: async () => ({ experiments: [], items: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);
    render(
      <Cases
        roles={["case-lead"]}
        focusCaseId="c1"
        stage="situation"
        onOpenCase={vi.fn()}
        onStageChange={vi.fn()}
      />,
    );
    const nav = await screen.findByRole("navigation", { name: "Investigation stages" });
    const expectations: [RegExp, string][] = [
      [/Situation/, "situation"],
      [/Capture/, "capture"],
      [/Analyze/, "analyze"],
      [/Compare/, "compare"],
      [/Decide/, "decide"],
    ];
    for (const [name, stage] of expectations) {
      const button = within(nav).getByRole("button", { name });
      const badge = button.querySelector(`svg.stage-icon[data-stage="${stage}"]`);
      expectDecorative(badge);
    }
    expect(
      within(nav)
        .getByRole("button", { name: /Situation/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});
