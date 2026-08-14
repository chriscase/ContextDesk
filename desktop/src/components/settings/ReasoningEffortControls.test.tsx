import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../../lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/host")>();
  return {
    ...actual,
    hostGetReasoningEffort: host.get,
    hostSetReasoningEffort: host.set,
  };
});

import { ReasoningEffortControls } from "./GeneralSection";

describe("ReasoningEffortControls", () => {
  beforeEach(() => {
    host.get.mockReset();
    host.set.mockReset();
    host.get.mockResolvedValue({ policy: "explicit", level: "low" });
  });

  it("saves the exact selected token without treating it as readiness", async () => {
    host.set.mockResolvedValue({ policy: "explicit", level: "xhigh" });
    render(<ReasoningEffortControls baseId="effort" />);
    const select = (await screen.findByLabelText(
      /reasoning effort/i,
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("low"));

    fireEvent.change(select, { target: { value: "xhigh" } });
    await waitFor(() => expect(host.set).toHaveBeenCalledWith("xhigh"));
    expect(select.value).toBe("xhigh");
    expect(screen.getByText(/exact model and gateway support/i)).toBeTruthy();
  });

  it("restores the last saved value when host persistence fails", async () => {
    host.set.mockRejectedValue(new Error("save refused"));
    render(<ReasoningEffortControls baseId="effort" />);
    const select = (await screen.findByLabelText(
      /reasoning effort/i,
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("low"));

    fireEvent.change(select, { target: { value: "max" } });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(select.value).toBe("low");
  });

  it("shows malformed host state instead of silently treating it as omit", async () => {
    host.get.mockResolvedValue({ policy: "explicit", level: "future-level" });
    render(<ReasoningEffortControls baseId="effort" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/unsupported/i);
  });
});
