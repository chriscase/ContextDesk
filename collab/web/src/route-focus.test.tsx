import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkFocus } from "./app-location.js";
import { useRouteFocus } from "./route-focus.js";

afterEach(cleanup);

const LANE_FOCUS: WorkFocus = {
  section: "workstreams",
  item: "run-1:lane-a",
  itemKind: "workstream",
  lane: "run-1:lane-a",
  experiment: null,
};

/**
 * Mirrors the shipped shape: a section wrapper that owns the address, with the
 * routed record rendered inside it once its data arrives.
 */
function Surface(props: { ready: boolean; recordPresent: boolean; recordKey?: string }) {
  useRouteFocus(LANE_FOCUS, props.ready);
  return (
    <section id="workstreams" aria-label="Workstreams" tabIndex={-1}>
      {props.recordPresent ? (
        <article
          key={props.recordKey ?? "stable"}
          data-testid="record"
          data-route-item="run-1:lane-a"
          data-route-kind="workstream"
          tabIndex={-1}
        >
          Reviewer workstream
        </article>
      ) : null}
      <button type="button">Elsewhere</button>
    </section>
  );
}

describe("route focus restoration", () => {
  it("upgrades a provisional section landing once the routed record arrives", () => {
    const view = render(<Surface ready recordPresent={false} />);
    // Nothing to focus but the section that owns the address.
    expect(document.activeElement).toBe(document.getElementById("workstreams"));

    view.rerender(<Surface ready recordPresent />);
    expect(document.activeElement).toBe(view.getByTestId("record"));
  });

  it("reclaims focus the browser dropped to the wrapping section", () => {
    const view = render(<Surface ready recordPresent />);
    expect(document.activeElement).toBe(view.getByTestId("record"));

    // A background refresh replaces the record's element; the browser moves
    // focus up to the nearest focusable ancestor.
    document.getElementById("workstreams")?.focus();
    view.rerender(<Surface ready recordPresent recordKey="replaced" />);
    expect(document.activeElement).toBe(view.getByTestId("record"));
  });

  it("never takes focus back from a reader who moved it themselves", () => {
    const view = render(<Surface ready recordPresent />);
    expect(document.activeElement).toBe(view.getByTestId("record"));

    const elsewhere = view.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    view.rerender(<Surface ready recordPresent recordKey="replaced" />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("does not upgrade a provisional landing a reader has already left", () => {
    const view = render(<Surface ready recordPresent={false} />);
    const elsewhere = view.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    view.rerender(<Surface ready recordPresent />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("waits for the surface to report it is ready before focusing anything", () => {
    const view = render(<Surface ready={false} recordPresent />);
    expect(document.activeElement).toBe(document.body);
    view.rerender(<Surface ready recordPresent />);
    expect(document.activeElement).toBe(view.getByTestId("record"));
  });
});
