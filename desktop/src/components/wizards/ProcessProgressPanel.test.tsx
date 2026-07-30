import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProcessProgressPanel } from "./ProcessProgressPanel";
import {
  LOG_INGEST_PIPELINE,
  SESSION_IMPORT_PIPELINE,
  formatElapsedMs,
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

  it("includes publication after optional embedding for log ingest (#824)", () => {
    expect(LOG_INGEST_PIPELINE).toContain("publish");
    expect(LOG_INGEST_PIPELINE).toContain("validate");
    expect(LOG_INGEST_PIPELINE.indexOf("validate")).toBeGreaterThan(
      LOG_INGEST_PIPELINE.indexOf("embed"),
    );
    expect(LOG_INGEST_PIPELINE.indexOf("publish")).toBeGreaterThan(
      LOG_INGEST_PIPELINE.indexOf("validate"),
    );
    expect(phaseLabel("publish")).toBe("Publication");
    expect(phaseLabel("validate")).toBe("Validate");
    expect(phaseLabel("scan")).toBe("Discover / read");
    expect(phaseLabel("embed")).toBe("Optional embedding");
  });

  it("keeps prior steps done when host is on validate (no rewind to scan) (#824)", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel
        progress={progress({
          phase: "store",
          message: "Persisting",
          fraction: null,
        })}
      />,
    );
    const phaseLi = (name: string) =>
      container.querySelector(`[data-phase="${name}"]`);

    expect(phaseLi("store")?.getAttribute("data-active")).toBe("true");
    expect(phaseLi("scan")?.getAttribute("data-active")).toBe("false");

    // Core always emits Validate before Publish; chrome must not reset.
    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "validate",
          message: "validating staged corpus before publication",
          fraction: null,
        })}
      />,
    );
    expect(phaseLi("validate")?.getAttribute("data-active")).toBe("true");
    expect(phaseLi("scan")?.getAttribute("data-active")).toBe("false");
    expect(phaseLi("scan")?.getAttribute("data-done")).toBe("true");
    expect(phaseLi("store")?.getAttribute("data-done")).toBe("true");
    expect(phaseLi("validate")?.getAttribute("data-done")).toBe("false");
  });

  it("does not checkmark optional embedding when it was never emitted (#824)", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel
        progress={progress({
          phase: "store",
          message: "Persisting",
          fraction: null,
        })}
      />,
    );
    const phaseLi = (name: string) =>
      container.querySelector(`[data-phase="${name}"]`);

    // Deferred / keyword-only path: store → validate → publish → completed
    // without ever emitting embed.
    for (const phase of ["validate", "publish", "completed"] as const) {
      rerender(
        <ProcessProgressPanel
          progress={progress({
            phase,
            message:
              phase === "completed"
                ? "ingested 40 events; optional embedding deferred"
                : phase,
            fraction: null,
            cancellable: false,
          })}
        />,
      );
    }

    expect(phaseLi("embed")?.getAttribute("data-seen")).toBe("false");
    expect(phaseLi("embed")?.getAttribute("data-done")).toBe("false");
    expect(phaseLi("embed")?.getAttribute("data-active")).toBe("false");
    expect(phaseLi("store")?.getAttribute("data-done")).toBe("true");
    expect(phaseLi("validate")?.getAttribute("data-done")).toBe("true");
    expect(phaseLi("publish")?.getAttribute("data-done")).toBe("true");
  });

  it("checkmarks optional embedding only after the host emits embed", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel
        progress={progress({
          phase: "embed",
          message: "Embedding templates",
          fraction: null,
        })}
      />,
    );
    const phaseLi = (name: string) =>
      container.querySelector(`[data-phase="${name}"]`);
    expect(phaseLi("embed")?.getAttribute("data-active")).toBe("true");
    expect(phaseLi("embed")?.getAttribute("data-seen")).toBe("true");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "validate",
          message: "validating",
          fraction: null,
        })}
      />,
    );
    expect(phaseLi("embed")?.getAttribute("data-done")).toBe("true");
  });

  it("shows wall-clock elapsed when the host reports it (#824)", () => {
    render(
      <ProcessProgressPanel
        progress={progress({ elapsed_ms: 3_450, phase: "store" })}
      />,
    );
    expect(screen.getByTestId("process-progress-elapsed").textContent).toBe(
      "3.5 s",
    );
    expect(formatElapsedMs(850)).toBe("850 ms");
    expect(formatElapsedMs(12_450)).toBe("12 s");
    expect(formatElapsedMs(null)).toBeNull();
  });

  it("shows only a finite host-reported fraction as determinate progress", () => {
    const { rerender } = render(
      <ProcessProgressPanel progress={progress({ fraction: 0.354 })} />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Process progress",
    });

    expect(bar.tagName).toBe("PROGRESS");
    expect(bar.getAttribute("value")).toBe("35");
    expect(bar.getAttribute("aria-valuenow")).toBe("35");
    expect(bar.getAttribute("data-indeterminate")).toBe("false");

    rerender(
      <ProcessProgressPanel progress={progress({ fraction: Number.NaN })} />,
    );
    expect(bar.hasAttribute("value")).toBe(false);
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("data-indeterminate")).toBe("true");
  });

  it("does not infer progress from phase position and clears stale width", () => {
    const { rerender } = render(
      <ProcessProgressPanel
        progress={progress({ phase: "template", fraction: 0.8 })}
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Process progress",
    });

    expect(bar.getAttribute("value")).toBe("80");
    expect(bar.getAttribute("aria-valuenow")).toBe("80");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "store",
          message: "Publishing corpus",
          fraction: null,
        })}
      />,
    );
    expect(bar.hasAttribute("value")).toBe(false);
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("data-indeterminate")).toBe("true");
  });

  it("does not invent a determinate value for terminal host state", () => {
    const { container, rerender } = render(
      <ProcessProgressPanel
        progress={progress({
          phase: "failed",
          message: "Import failed",
          fraction: null,
        })}
      />,
    );
    expect(
      screen.queryByRole("progressbar", { name: "Process progress" }),
    ).toBeNull();
    expect(
      container
        .querySelector(".process-progress__bar-track")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "completed",
          message: "Complete",
          fraction: null,
        })}
      />,
    );
    expect(
      screen.queryByRole("progressbar", { name: "Process progress" }),
    ).toBeNull();
    expect(
      container
        .querySelector(".process-progress__bar-track")
        ?.getAttribute("data-indeterminate"),
    ).toBe("false");
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
        .querySelector(".process-progress__bar-track")
        ?.getAttribute("data-indeterminate"),
    ).toBe("false");
    expect(
      container
        .querySelector(".process-progress")
        ?.getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("announces phase changes without putting counter ticks in the live region", () => {
    const { rerender } = render(
      <ProcessProgressPanel
        progress={progress({
          phase: "parse",
          message: "Parsing file 1",
          files_processed: 1,
        })}
      />,
    );
    const status = screen.getByRole("status");

    expect(status.textContent).toBe("Current phase: Parse / frame");
    expect(status.textContent).not.toContain("file 1");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "parse",
          message: "Parsing file 2",
          files_processed: 2,
        })}
      />,
    );
    expect(status.textContent).toBe("Current phase: Parse / frame");
    expect(status.textContent).not.toContain("file 2");

    rerender(
      <ProcessProgressPanel
        progress={progress({
          phase: "store",
          message: "Writing corpus",
          fraction: null,
        })}
      />,
    );
    expect(status.textContent).toBe("Current phase: Persist / index");
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
