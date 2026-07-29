import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProcessProgressPanel } from "./ProcessProgressPanel";
import {
  LOG_INGEST_PIPELINE,
  SESSION_IMPORT_PIPELINE,
  phaseLabel,
  type ProcessProgressDto,
} from "./types";

function progress(
  overrides: Partial<ProcessProgressDto> = {},
): ProcessProgressDto {
  return {
    kind: "log_ingest",
    phase: "parse",
    message: "Parsing logs",
    fraction: 0.35,
    lines_processed: 10,
    files_processed: 1,
    bytes_processed: 128,
    templates: null,
    cancellable: true,
    ...overrides,
  };
}

describe("ProcessProgressPanel", () => {
  it("maps log ingest phases in pipeline order", () => {
    let last = -1;
    for (const phase of LOG_INGEST_PIPELINE) {
      const index = LOG_INGEST_PIPELINE.indexOf(phase);
      expect(index).toBeGreaterThan(last);
      last = index;
      expect(phaseLabel(phase)).not.toMatch(/\/Users\//);
    }
  });

  it("includes the session import extract phase", () => {
    expect(SESSION_IMPORT_PIPELINE).toContain("extract");
    expect(phaseLabel("extract")).toBe("Extract");
  });

  it("shows only a finite host-reported fraction as determinate progress", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel progress={progress({ fraction: 0.354 })} />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Process progress",
    });
    const fill = container.querySelector(".process-progress__bar-fill");

    expect(bar.getAttribute("aria-valuenow")).toBe("35");
    expect(fill?.getAttribute("style")).toBe("width: 35%;");
    expect(fill?.getAttribute("data-indeterminate")).toBe("false");

    rerender(
      <ProcessProgressPanel progress={progress({ fraction: Number.NaN })} />,
    );
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(fill?.hasAttribute("style")).toBe(false);
    expect(fill?.getAttribute("data-indeterminate")).toBe("true");
  });

  it("does not infer progress from phase position and clears stale width", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel
        progress={progress({ phase: "template", fraction: 0.8 })}
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Process progress",
    });
    const fill = container.querySelector(".process-progress__bar-fill");

    expect(bar.getAttribute("aria-valuenow")).toBe("80");
    expect(fill?.getAttribute("style")).toBe("width: 80%;");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "store",
          message: "Publishing corpus",
          fraction: null,
        })}
      />,
    );
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(fill?.hasAttribute("style")).toBe(false);
    expect(fill?.getAttribute("data-indeterminate")).toBe("true");
  });

  it("uses terminal host state without animating failed or completed work", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel
        progress={progress({
          phase: "failed",
          message: "Import failed",
          fraction: null,
        })}
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Process progress",
    });
    const fill = container.querySelector(".process-progress__bar-fill");

    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(fill?.getAttribute("data-indeterminate")).toBe("false");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "completed",
          message: "Complete",
          fraction: null,
        })}
      />,
    );
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(fill?.getAttribute("style")).toBe("width: 100%;");
    expect(fill?.getAttribute("data-indeterminate")).toBe("false");
  });

  it("stops indeterminate activity when an error is displayed", () => {
    const { container } = render(
      <ProcessProgressPanel
        progress={progress({ fraction: null })}
        error="Import failed"
      />,
    );

    expect(
      container
        .querySelector(".process-progress__bar-fill")
        ?.getAttribute("data-indeterminate"),
    ).toBe("false");
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("false");
  });

  it("offers cancellation only while the host declares the phase cancellable", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ProcessProgressPanel progress={progress()} onCancel={onCancel} />,
    );

    expect(screen.getByRole("button", { name: "Cancel ingest" })).toBeTruthy();

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "store",
          message: "Publishing corpus",
          cancellable: false,
        })}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole("button", { name: "Cancel ingest" })).toBeNull();
  });

  it("sends one cancel request and keeps the affordance pending", async () => {
    let resolveCancel!: () => void;
    const onCancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    render(
      <ProcessProgressPanel
        progress={progress()}
        onCancel={onCancel}
        cancelLabel="Cancel re-analysis"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel re-analysis" }));
    const pending = screen.getByRole("button", {
      name: "Cancel requested…",
    });
    expect(pending.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pending);
    expect(onCancel).toHaveBeenCalledTimes(1);
    resolveCancel();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("removes cancellation for terminal progress", () => {
    render(
      <ProcessProgressPanel
        progress={progress({
          phase: "completed",
          message: "Complete",
          cancellable: true,
        })}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cancel-log-ingest")).toBeNull();
  });
});
