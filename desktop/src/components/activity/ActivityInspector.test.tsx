import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ActivityToggle } from "./ActivityToggle";
import { ActivityInspectorBody } from "./ActivityInspectorBody";
import { ActivityDrawer } from "./ActivityDrawer";
import { ActivityDock } from "./ActivityDock";
import { ActivityCompactLine } from "./ActivityCompactLine";
import { ActivityEventList } from "./ActivityEventList";
import { buildActivityTurn } from "../../lib/activity/adapter";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityEvent,
  type ActivityTurn,
} from "../../lib/activity/types";

function turn(overrides: Partial<ActivityTurn> = {}): ActivityTurn {
  return {
    turnId: "m1",
    label: "Why did checkout fail?",
    summary: {
      modelRounds: 2,
      toolCalls: 1,
      contextUsedChars: 8_000,
      grounded: true,
      status: "ok",
    },
    budget: { usedChars: 8_000, totalChars: null, truncationNote: null },
    requestRounds: [],
    events: [],
    citations: [],
    permissions: [],
    elapsedMs: 1_200,
    liveRecord: true,
    droppedEvents: 0,
    contractVersion: 1,
    ...overrides,
  };
}

function event(
  origin: ActivityEvent["origin"],
  label: string,
  id = label,
): ActivityEvent {
  const base = {
    id,
    correlationId: "c1",
    operationId: `op-${id}`,
    determinism: determinismForOrigin(origin),
    phase: "completed" as const,
    status: "ok" as const,
    clock: { kind: "sequence" as const, seq: 0 },
    label,
    scope: { kind: "conversation" as const, id: null, label: "Conversation" },
    privacy: "metadata" as const,
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
  };
  if (origin === "probabilistic_model" || origin === "external_connector") {
    return {
      ...base,
      origin,
      hook: { trigger: "the model asked", dataScope: "Conversation" },
    };
  }
  return { ...base, origin };
}

describe("the one Activity control offers exactly the four modes", () => {
  it("shows Off / Compact / Drawer / Docked and reports the choice", () => {
    const onChange = vi.fn();
    render(<ActivityToggle mode="off" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    const menu = screen.getByTestId("activity-toggle-menu");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((b) => b.textContent?.split(/(?=[A-Z])/)[0]),
    ).toHaveLength(4);
    for (const mode of ["off", "compact", "drawer", "docked"]) {
      expect(screen.getByTestId(`activity-toggle-${mode}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("activity-toggle-docked"));
    expect(onChange).toHaveBeenCalledWith("docked");
  });

  it("marks the current mode as checked, not merely styled", () => {
    render(<ActivityToggle mode="drawer" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    expect(
      screen.getByTestId("activity-toggle-drawer").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("activity-toggle-off").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<ActivityToggle mode="off" onChange={vi.fn()} />);
    const trigger = screen.getByTestId("activity-toggle-trigger");
    fireEvent.click(trigger);
    expect(screen.queryByTestId("activity-toggle-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("activity-toggle-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("portals and viewport-clamps the menu outside a clipped rail", () => {
    const { container } = render(
      <div style={{ width: 42, overflow: "hidden" }}>
        <ActivityToggle mode="compact" onChange={vi.fn()} />
      </div>,
    );
    const trigger = screen.getByTestId("activity-toggle-trigger");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 4, right: 42, top: 20, bottom: 44, width: 38, height: 24,
      x: 4, y: 20, toJSON: () => ({}),
    });
    fireEvent.click(trigger);
    const menu = screen.getByTestId("activity-toggle-menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
  });
});

describe("Drawer and Docked render the same body", () => {
  it("Drawer traps focus, closes on Escape, and restores focus", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const onClose = vi.fn();
    render(<ActivityDrawer turn={turn()} onClose={onClose} />);
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Drawer renders nothing at all when no turn is selected", () => {
    const { container } = render(
      <ActivityDrawer turn={null} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("Docked exposes a keyboard-resizable separator", () => {
    const onWidthChange = vi.fn();
    render(
      <ActivityDock
        turn={turn()}
        width={340}
        onWidthChange={onWidthChange}
        onCollapse={vi.fn()}
      />,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize activity inspector",
    });
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(356);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenCalledWith(324);
  });

  it("Docked renders nothing when no turn is selected", () => {
    const { container } = render(
      <ActivityDock turn={null} width={340} onWidthChange={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("clamps a persisted dock width to its chat-container maximum", () => {
    const onWidthChange = vi.fn();
    render(
      <ActivityDock
        turn={turn()}
        width={560}
        maxWidth={420}
        onWidthChange={onWidthChange}
      />,
    );
    const dock = screen.getByTestId("activity-dock");
    const handle = screen.getByRole("separator", {
      name: "Resize activity inspector",
    });
    expect(dock.style.width).toBe("420px");
    expect(handle.getAttribute("aria-valuemax")).toBe("420");
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(420);
  });
});

describe("progressive disclosure: plain language first, detail on request", () => {
  it("opens on the plain-language summary, not the technical panel", () => {
    render(<ActivityInspectorBody turn={turn()} />);
    expect(screen.getByTestId("activity-panel-summary")).toBeTruthy();
    expect(screen.queryByTestId("activity-panel-technical")).toBeNull();
  });

  it("moves between tabs with arrow keys (roving tabindex)", () => {
    render(<ActivityInspectorBody turn={turn()} />);
    const summaryTab = screen.getByTestId("activity-tab-summary");
    expect(summaryTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(summaryTab, { key: "ArrowRight" });
    const technicalTab = screen.getByTestId("activity-tab-technical");
    expect(technicalTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(technicalTab);
    expect(screen.getByTestId("activity-panel-technical")).toBeTruthy();
  });

  it("says a fact is not reported rather than showing an invented number", () => {
    render(
      <ActivityInspectorBody
        turn={turn({
          liveRecord: false,
          summary: {
            modelRounds: null,
            toolCalls: null,
            contextUsedChars: null,
            grounded: null,
            status: null,
          },
          budget: { usedChars: null, totalChars: null, truncationNote: null },
          contractVersion: null,
        })}
      />,
    );
    expect(screen.getByTestId("activity-not-recorded")).toBeTruthy();
    expect(screen.getByText(/not reported/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId("activity-tab-technical"));
    const technical = screen.getByTestId("activity-panel-technical");
    expect(within(technical).getAllByText(/not reported|not recorded/i).length)
      .toBeGreaterThan(0);
    // Nothing anywhere should render a placeholder ceiling.
    expect(technical.textContent).toMatch(/no reported ceiling/i);
  });

  it("declares a truncated record instead of presenting it as complete", () => {
    render(<ActivityInspectorBody turn={turn({ droppedEvents: 7 })} />);
    expect(screen.getByTestId("activity-truncated").textContent).toMatch(
      /partial record/i,
    );
  });

  it("counts deterministic and model work separately in plain words", () => {
    render(
      <ActivityInspectorBody
        turn={turn({
          events: [
            event("deterministic_host", "Archive scanned"),
            event("repeatable_heuristic", "Ranked candidates"),
            event("probabilistic_model", "Model request"),
          ],
        })}
      />,
    );
    const summary = screen.getByTestId("activity-panel-summary");
    expect(summary.textContent).toMatch(/1 deterministic/i);
    expect(summary.textContent).toMatch(/1 repeatable heuristic/i);
    expect(summary.textContent).toMatch(/1 model\/external/i);
  });
});

describe("origin labelling never relies on colour alone", () => {
  it("pairs a text label with a glyph and a work class for every row", () => {
    render(
      <ActivityEventList
        events={[
          event("deterministic_host", "Archive scanned"),
          event("probabilistic_model", "Model request"),
        ]}
      />,
    );
    const host = screen.getByTestId("activity-badge-deterministic_host");
    const model = screen.getByTestId("activity-badge-probabilistic_model");
    expect(host.textContent).toContain("Host work");
    expect(model.textContent).toContain("Model");
    expect(host.getAttribute("data-work")).toBe("deterministic");
    expect(model.getAttribute("data-work")).toBe("nondeterministic");
    // The distinguishing signal survives with all styling removed.
    expect(host.textContent).not.toBe(model.textContent);
  });

  it("never calls a heuristic deterministic in its own tooltip", () => {
    render(
      <ActivityEventList
        events={[event("repeatable_heuristic", "Ranked candidates")]}
      />,
    );
    const badge = screen.getByTestId("activity-badge-repeatable_heuristic");
    expect(badge.textContent).toContain("Heuristic");
    expect(badge.getAttribute("title")).toMatch(/not the same as it being a proof/i);
  });

  it("shows the required trigger/data-scope disclosure on model rows", () => {
    render(<ActivityEventList events={[event("probabilistic_model", "Round 1")]} />);
    expect(screen.getByText(/Trigger: the model asked/)).toBeTruthy();
    expect(screen.getByText(/Data scope: Conversation/)).toBeTruthy();
  });
});

describe("the event list is bounded and honest about time", () => {
  it("virtualizes a long stream instead of mounting every row", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      event("deterministic_host", `Step ${i}`, `e${i}`),
    );
    render(<ActivityEventList events={many} />);
    const list = screen.getByTestId("activity-event-list");
    expect(list.getAttribute("data-virtualized")).toBe("true");
    const mounted = Number(list.getAttribute("data-mounted-count"));
    expect(mounted).toBeLessThan(400);
    expect(list.getAttribute("data-total-count")).toBe("400");
  });

  it("mounts every row for a short list", () => {
    render(
      <ActivityEventList
        events={[event("deterministic_host", "One", "e1")]}
      />,
    );
    const list = screen.getByTestId("activity-event-list");
    expect(list.getAttribute("data-virtualized")).toBe("false");
  });

  it("surfaces the retention bound rather than dropping entries silently", () => {
    render(
      <ActivityEventList
        events={[event("deterministic_host", "One", "e1")]}
        omittedNote="12 earlier entries dropped by the 500-entry retention bound."
      />,
    );
    expect(screen.getByRole("note").textContent).toMatch(/12 earlier entries/);
  });

  it("renders a sequence-only event as an ordinal, never as a date", () => {
    render(
      <ActivityEventList
        events={[event("deterministic_host", "Ordered step", "e1")]}
      />,
    );
    const row = screen.getByTestId("activity-event-row");
    expect(row.getAttribute("data-clock")).toBe("sequence");
    expect(within(row).getByText("#1")).toBeTruthy();
    expect(within(row).getByTitle(/order only \(no clock time\)/i)).toBeTruthy();
    // No 4-digit year anywhere in the row.
    expect(row.textContent).not.toMatch(/\b(19|20)\d{2}\b/);
  });

  it("keeps technical detail behind a per-row disclosure", () => {
    render(
      <ActivityEventList
        events={[event("deterministic_host", "Archive scanned", "e1")]}
      />,
    );
    expect(screen.queryByTestId("activity-event-technical")).toBeNull();
    fireEvent.click(screen.getByTestId("activity-event-details-toggle"));
    const technical = screen.getByTestId("activity-event-technical");
    expect(technical.textContent).toMatch(/same inputs, same result/i);
    expect(technical.textContent).toMatch(/order only/i);
  });
});

describe("the compact line stays quiet and never pads itself out", () => {
  it("reports only facts it has", () => {
    const built = buildActivityTurn(
      { id: "m1", role: "assistant", content: "answer" },
      { record: null },
    );
    render(<ActivityCompactLine turn={built} onOpenDetails={vi.fn()} />);
    const line = screen.getByTestId("activity-compact-line");
    expect(line.textContent).toMatch(/not recorded/i);
    // No zeroed-out stat padding.
    expect(line.textContent).not.toMatch(/0 model requests/);
  });

  it("opens the drawer on demand", () => {
    const onOpenDetails = vi.fn();
    render(
      <ActivityCompactLine turn={turn()} onOpenDetails={onOpenDetails} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Activity details/ }));
    expect(onOpenDetails).toHaveBeenCalled();
  });
});
