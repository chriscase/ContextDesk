/**
 * Recording why an investigation was resolved. Every fixture is synthetic.
 *
 * The central assertion is that human reasoning is the default path and needs
 * no experiment: a person can conclude an investigation, say why, and record
 * what stayed unknown, with no comparison anywhere in the case.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASIS_LABELS,
  EMPTY_RESOLUTION,
  RESOLUTION_BASES,
  ResolutionForm,
  resolutionPayload,
} from "./ResolutionForm.js";

afterEach(() => cleanup());

describe("the resolution payload", () => {
  it("defaults to human reasoning with no experiment attached", () => {
    expect(EMPTY_RESOLUTION.basis).toBe("human_only");
    const payload = resolutionPayload({
      ...EMPTY_RESOLUTION,
      rationale: "Synthetic conclusion from the recorded notes.",
    });
    expect(payload).toEqual({
      basis: "human_only",
      rationale: "Synthetic conclusion from the recorded notes.",
      unknowns: [],
    });
    expect(payload).not.toHaveProperty("experimentDecisionId");
  });

  it("splits unknowns one per line and drops blank lines", () => {
    const payload = resolutionPayload({
      ...EMPTY_RESOLUTION,
      rationale: "Synthetic.",
      unknowns: "  first  \n\n second \n",
    });
    expect(payload.unknowns).toEqual(["first", "second"]);
  });

  it("attaches only the field its basis owns", () => {
    expect(
      resolutionPayload({
        ...EMPTY_RESOLUTION,
        basis: "reasoned_exception",
        rationale: "Synthetic.",
        exceptionReason: "Duplicate of a consolidated synthetic investigation.",
        experimentDecisionId: "ignored-when-not-that-basis",
      }),
    ).toMatchObject({
      basis: "reasoned_exception",
      exceptionReason: "Duplicate of a consolidated synthetic investigation.",
    });
    expect(
      resolutionPayload({
        ...EMPTY_RESOLUTION,
        basis: "reasoned_exception",
        rationale: "Synthetic.",
        exceptionReason: "Duplicate.",
        experimentDecisionId: "d1",
      }),
    ).not.toHaveProperty("experimentDecisionId");
  });

  it("passes an occurrence date through as typed", () => {
    expect(
      resolutionPayload({
        ...EMPTY_RESOLUTION,
        rationale: "Synthetic.",
        occurredAt: " 2024-11-06 ",
      }).occurredAt,
    ).toBe("2024-11-06");
  });
});

describe("the resolution form", () => {
  it("offers three bases and opens on human reasoning", async () => {
    render(<ResolutionForm prompted={false} error={null} onSubmit={() => undefined} onCancel={() => undefined} />);
    const select = screen.getByLabelText("How was this reached?") as HTMLSelectElement;
    expect([...select.querySelectorAll("option")].map((node) => node.value)).toEqual([
      ...RESOLUTION_BASES,
    ]);
    expect(select.value).toBe("human_only");
    expect(
      await screen.findByText(/No model run is needed or implied/),
    ).toBeTruthy();
    expect(screen.getByText(BASIS_LABELS.human_only)).toBeTruthy();
  });

  it("asks for the exception only when that is the basis", () => {
    render(<ResolutionForm prompted={false} error={null} onSubmit={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByLabelText("What the exception is")).toBeNull();
    fireEvent.change(screen.getByLabelText("How was this reached?"), {
      target: { value: "reasoned_exception" },
    });
    expect(screen.getByLabelText("What the exception is")).toBeTruthy();
    expect(screen.queryByLabelText("Accepted decision")).toBeNull();
  });

  it("asks for the accepted decision only when a comparison is the basis", () => {
    render(<ResolutionForm prompted={false} error={null} onSubmit={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText("How was this reached?"), {
      target: { value: "experiment_decision" },
    });
    expect(screen.getByLabelText("Accepted decision")).toBeTruthy();
    expect(screen.queryByLabelText("What the exception is")).toBeNull();
  });

  it("submits a human-only conclusion with its unknowns", async () => {
    const submitted: unknown[] = [];
    render(
      <ResolutionForm
        prompted={false}
        error={null}
        onSubmit={(payload) => {
          submitted.push(payload);
        }}
        onCancel={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "The synthetic retry window matches the scheduled batch." },
    });
    fireEvent.change(screen.getByLabelText("Still unknown"), {
      target: { value: "Which upstream change moved the batch." },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Record why this is resolved" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toEqual({
      basis: "human_only",
      rationale: "The synthetic retry window matches the scheduled batch.",
      unknowns: ["Which upstream change moved the batch."],
    });
  });

  it("frames a server refusal as the form asking to be filled in", () => {
    render(<ResolutionForm prompted error={null} onSubmit={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText(/Nothing was changed yet/)).toBeTruthy();
  });

  it("shows a conflict without discarding what is typed", () => {
    render(
      <ResolutionForm
        prompted={false}
        error="Someone else recorded a conclusion while this form was open."
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(
      screen.getByText(/Someone else recorded a conclusion while this form was open/),
    ).toBeTruthy();
  });

  it("cancels without submitting anything", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<ResolutionForm prompted error={null} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
