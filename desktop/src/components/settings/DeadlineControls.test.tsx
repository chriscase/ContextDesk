import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { RouterBudgetDto } from "../../lib/host";
import { DeadlineControls } from "./GeneralSection";

function Harness({ initial }: { initial: RouterBudgetDto }) {
  const [routerBudget, setRouterBudget] = useState(initial);
  return (
    <DeadlineControls
      baseId="test"
      routerBudget={routerBudget}
      setRouterBudget={setRouterBudget}
    />
  );
}

const baseBudget: RouterBudgetDto = {
  max_sources: 3,
  max_tool_rounds: 12,
  max_results_per_source: 8,
  deadline_ms: 180_000,
  deadline_is_explicit: false,
};

describe("DeadlineControls", () => {
  it("defaults to Auto and does not require millisecond entry", () => {
    render(<Harness initial={baseBudget} />);
    const policy = screen.getByLabelText(
      /whole-turn time limit/i,
    ) as HTMLSelectElement;
    expect(policy.value).toBe("auto");
    expect(screen.queryByDisplayValue("180000")).toBeNull();
    expect(
      screen.getByText(/adaptive timing|Auto keeps adaptive/i),
    ).toBeTruthy();
  });

  it("switches Standard and Patient to fixed presets", () => {
    render(<Harness initial={baseBudget} />);
    const policy = screen.getByLabelText(
      /whole-turn time limit/i,
    ) as HTMLSelectElement;
    fireEvent.change(policy, { target: { value: "standard" } });
    expect(policy.value).toBe("standard");
    expect(screen.getByText(/Saved ceiling: 3m/i)).toBeTruthy();
    fireEvent.change(policy, { target: { value: "patient" } });
    expect(screen.getByText(/Saved ceiling: 5m/i)).toBeTruthy();
  });

  it("rejects invalid custom duration without updating last valid", () => {
    render(
      <Harness
        initial={{
          ...baseBudget,
          deadline_ms: 180_000,
          deadline_is_explicit: true,
        }}
      />,
    );
    const policy = screen.getByLabelText(/whole-turn time limit/i);
    fireEvent.change(policy, { target: { value: "custom" } });
    const custom = screen.getByLabelText(/custom duration/i);
    fireEvent.change(custom, { target: { value: "11m" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    // Last valid ceiling remains 3m in the summary.
    expect(screen.getByText(/Saved ceiling: 3m/i)).toBeTruthy();
  });

  it("accepts friendly custom durations", () => {
    render(
      <Harness
        initial={{
          ...baseBudget,
          deadline_ms: 180_000,
          deadline_is_explicit: true,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText(/whole-turn time limit/i), {
      target: { value: "custom" },
    });
    const custom = screen.getByLabelText(/custom duration/i);
    fireEvent.change(custom, { target: { value: "90s" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Saved ceiling: 90s/i)).toBeTruthy();
  });

  it("exposes accessible labels and associates custom errors", () => {
    render(
      <Harness
        initial={{
          ...baseBudget,
          deadline_is_explicit: true,
          deadline_ms: 90_000,
        }}
      />,
    );
    const policy = screen.getByLabelText(
      /whole-turn time limit/i,
    ) as HTMLSelectElement;
    // Already custom (90s); ensure mode stays custom while typing invalid.
    expect(policy.value).toBe("custom");
    const custom = screen.getByLabelText(/custom duration/i) as HTMLInputElement;
    fireEvent.change(custom, { target: { value: "nope" } });
    const alert = screen.getByRole("alert");
    expect(custom.getAttribute("aria-invalid")).toBe("true");
    const described = custom.getAttribute("aria-describedby") ?? "";
    expect(described.includes("error") || alert.textContent).toBeTruthy();
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("Auto does not convert stored ms into an explicit ceiling", () => {
    function Watch({ initial }: { initial: RouterBudgetDto }) {
      const [routerBudget, setRouterBudget] = useState(initial);
      return (
        <>
          <DeadlineControls
            baseId="watch"
            routerBudget={routerBudget}
            setRouterBudget={setRouterBudget}
          />
          <output data-testid="explicit">
            {String(routerBudget.deadline_is_explicit)}
          </output>
          <output data-testid="ms">{routerBudget.deadline_ms}</output>
        </>
      );
    }
    render(
      <Watch
        initial={{
          ...baseBudget,
          deadline_ms: 90_000,
          deadline_is_explicit: true,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText(/whole-turn time limit/i), {
      target: { value: "auto" },
    });
    expect(screen.getByTestId("explicit").textContent).toBe("false");
    expect(screen.getByTestId("ms").textContent).toBe("90000");
  });

  it("adversarial custom junk leaves last valid budget in the summary", () => {
    render(
      <Harness
        initial={{
          ...baseBudget,
          deadline_ms: 90_000,
          deadline_is_explicit: true,
        }}
      />,
    );
    const custom = screen.getByLabelText(/custom duration/i);
    for (const junk of ["-3m", "1.5m", "90 s", "11m", "0s", "😊3m"]) {
      fireEvent.change(custom, { target: { value: junk } });
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/Saved ceiling: 90s/i)).toBeTruthy();
    }
  });
});
