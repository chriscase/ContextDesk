import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVESTIGATION_RUNTIME_COMPATIBILITY,
  UI_STRATEGIES,
  type UiStrategyDescriptor,
} from "../../ui-strategy.js";
import {
  INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
  defineInvestigationStrategyRegistrations,
  type InvestigationStrategyShellProps,
} from "./contract.js";
import { InvestigationStrategyRenderer } from "./StrategyRenderer.js";

afterEach(cleanup);

function registration(component: ComponentType<InvestigationStrategyShellProps>) {
  return {
    presentationContract: INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
    component,
  } as const;
}

function ReferenceStrategy() {
  return <div data-testid="war-room">War Room</div>;
}

function AlternateStrategy() {
  return <div data-testid="investigation-first">Investigation First</div>;
}

const registrations = defineInvestigationStrategyRegistrations({
  "war-room": {
    id: "war-room",
    ...registration(ReferenceStrategy),
  },
  "investigation-first": {
    id: "investigation-first",
    ...registration(AlternateStrategy),
  },
});

const shellProps: InvestigationStrategyShellProps = {
  view: "investigations",
  focusCaseId: "case-7",
  stage: "analyze",
  focus: {
    section: "evidence",
    item: "artifact-2",
    lane: null,
    experiment: null,
  },
  startSignal: 4,
  onOpenCase: vi.fn(),
  onNavigateInvestigation: vi.fn(),
  onExitFocus: vi.fn(),
  onOpenAdvancedTools: vi.fn(),
  onFocusedCaseTitle: vi.fn(),
};

describe("InvestigationStrategyRenderer", () => {
  it("renders the known selected strategy by id or descriptor", () => {
    const view = render(
      <InvestigationStrategyRenderer
        strategy="investigation-first"
        registrations={registrations}
        {...shellProps}
      />,
    );

    expect(screen.getByTestId("investigation-first")).not.toBeNull();
    expect(screen.queryByTestId("war-room")).toBeNull();

    const descriptor = UI_STRATEGIES.find((strategy) => strategy.id === "war-room")!;
    view.rerender(
      <InvestigationStrategyRenderer
        strategy={descriptor}
        registrations={registrations}
        {...shellProps}
      />,
    );

    expect(screen.getByTestId("war-room")).not.toBeNull();
    expect(screen.queryByTestId("investigation-first")).toBeNull();
  });

  it("fails closed when descriptor metadata requires another runtime contract", () => {
    const strategy = UI_STRATEGIES.find((candidate) => candidate.id === "investigation-first")!;
    const incompatible = {
      ...strategy,
      compatibility: {
        ...strategy.compatibility,
        runtime: { ...INVESTIGATION_RUNTIME_COMPATIBILITY, version: 2 },
      },
    } as unknown as UiStrategyDescriptor;

    render(
      <InvestigationStrategyRenderer
        strategy={incompatible}
        registrations={registrations}
        {...shellProps}
      />,
    );

    expect(screen.getByTestId("war-room")).not.toBeNull();
    expect(screen.queryByTestId("investigation-first")).toBeNull();
  });

  it("fails closed to War Room for unknown, missing, or incompatible registrations", () => {
    const view = render(
      <InvestigationStrategyRenderer
        strategy={"future-strategy" as "war-room"}
        registrations={registrations}
        {...shellProps}
      />,
    );
    expect(screen.getByTestId("war-room")).not.toBeNull();

    view.rerender(
      <InvestigationStrategyRenderer
        strategy="investigation-first"
        registrations={{ "war-room": registrations["war-room"] }}
        {...shellProps}
      />,
    );
    expect(screen.getByTestId("war-room")).not.toBeNull();

    const incompatible = {
      ...registrations,
      "investigation-first": {
        ...registrations["investigation-first"],
        presentationContract: {
          ...INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
          version: 2,
        },
      },
    } as unknown as typeof registrations;
    view.rerender(
      <InvestigationStrategyRenderer
        strategy="investigation-first"
        registrations={incompatible}
        {...shellProps}
      />,
    );
    expect(screen.getByTestId("war-room")).not.toBeNull();
  });

  it("switches exactly one adapter while preserving shell value and callback identity", () => {
    const received: InvestigationStrategyShellProps[] = [];
    function CapturingStrategy(props: InvestigationStrategyShellProps) {
      received.push(props);
      return <div data-testid="capturing-strategy" />;
    }
    const capturingRegistrations = defineInvestigationStrategyRegistrations({
      "war-room": {
        id: "war-room",
        ...registration(CapturingStrategy),
      },
      "investigation-first": {
        id: "investigation-first",
        ...registration(CapturingStrategy),
      },
    });

    const view = render(
      <InvestigationStrategyRenderer
        strategy="war-room"
        registrations={capturingRegistrations}
        {...shellProps}
      />,
    );
    view.rerender(
      <InvestigationStrategyRenderer
        strategy="investigation-first"
        registrations={capturingRegistrations}
        {...shellProps}
      />,
    );

    expect(screen.getAllByTestId("capturing-strategy")).toHaveLength(1);
    expect(received).toHaveLength(2);
    for (const props of received) {
      expect(props.focus).toBe(shellProps.focus);
      expect(props.onOpenCase).toBe(shellProps.onOpenCase);
      expect(props.onNavigateInvestigation).toBe(shellProps.onNavigateInvestigation);
      expect(props.onExitFocus).toBe(shellProps.onExitFocus);
      expect(props.onOpenAdvancedTools).toBe(shellProps.onOpenAdvancedTools);
      expect(props.onFocusedCaseTitle).toBe(shellProps.onFocusedCaseTitle);
    }
    expect(shellProps.onOpenCase).not.toHaveBeenCalled();
    expect(shellProps.onExitFocus).not.toHaveBeenCalled();
    expect(shellProps.onOpenAdvancedTools).not.toHaveBeenCalled();
    expect(shellProps.onFocusedCaseTitle).not.toHaveBeenCalled();
  });
});
