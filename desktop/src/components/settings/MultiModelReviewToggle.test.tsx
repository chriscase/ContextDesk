/**
 * Investigation team cockpit.
 *
 * The behaviours that matter here are the honest ones: readiness comes only
 * from recorded settings fields, degradation is explained before a mode is
 * selected, saving is guarded and recoverable, and nothing the surface says
 * implies that picking a team configures profiles or guarantees extra
 * executed models.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MultiModelReviewToggle } from "./MultiModelReviewToggle";
import type { MultiModelSettingsDto } from "../../lib/host";

const host = vi.hoisted(() => ({
  get: vi.fn(),
  setMode: vi.fn(),
}));

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostGetMultiModelSettings: (...args: unknown[]) => host.get(...args),
    hostSetMultiModelMode: (...args: unknown[]) => host.setMode(...args),
  };
});

function dto(over: Partial<MultiModelSettingsDto> = {}): MultiModelSettingsDto {
  return {
    mode: "single",
    reviewer_profile_id: null,
    reviewer_model: null,
    reviewer_allow_remote: false,
    reviewer_require_qualified: true,
    ...over,
  };
}

function describedText(radio: HTMLElement): string {
  const ids = (radio.getAttribute("aria-describedby") ?? "").split(/\s+/);
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

beforeEach(() => {
  host.get.mockReset();
  host.setMode.mockReset();
  host.get.mockResolvedValue(dto());
  host.setMode.mockResolvedValue(undefined);
});

describe("MultiModelReviewToggle", () => {
  it("renders nothing when the host reports no settings (browser preview)", async () => {
    host.get.mockResolvedValue(null);
    const { container } = render(<MultiModelReviewToggle />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("shows a deliberate loading state while the host query is in flight", async () => {
    let resolveGet!: (v: MultiModelSettingsDto) => void;
    host.get.mockImplementation(
      () =>
        new Promise<MultiModelSettingsDto>((r) => {
          resolveGet = r;
        }),
    );
    render(<MultiModelReviewToggle />);
    expect(screen.getByRole("status").textContent).toMatch(
      /checking the current setup/i,
    );
    await act(async () => {
      resolveGet(dto());
    });
    expect(screen.getByRole("radio", { name: "Standard" })).toBeTruthy();
  });

  it("surfaces a load failure with a working retry", async () => {
    host.get.mockRejectedValueOnce(new Error("ipc down"));
    render(<MultiModelReviewToggle />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn’t load/i);

    host.get.mockResolvedValue(dto());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("radio", { name: "Standard" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers all three teams as an accessible radiogroup with Standard recommended and selected by default", async () => {
    render(<MultiModelReviewToggle />);
    const group = await screen.findByRole("radiogroup", {
      name: "Investigation team",
    });
    expect(group).toBeTruthy();

    const standard = screen.getByRole("radio", { name: "Standard" });
    const reviewer = screen.getByRole("radio", { name: "Reviewer" });
    const contributions = screen.getByRole("radio", { name: "Contributions" });
    expect((standard as HTMLInputElement).checked).toBe(true);
    expect((reviewer as HTMLInputElement).checked).toBe(false);
    expect((contributions as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Recommended")).toBeTruthy();

    // Role/process copy is wired to each radio, not just visually nearby.
    expect(describedText(standard)).toMatch(/validates every claim/i);
    expect(describedText(contributions)).toMatch(/explicitly configured/i);
  });

  it("falls back to Standard for an unknown recorded mode", async () => {
    host.get.mockResolvedValue(dto({ mode: "experimental-vote" }));
    render(<MultiModelReviewToggle />);
    const standard = await screen.findByRole("radio", { name: "Standard" });
    expect((standard as HTMLInputElement).checked).toBe(true);
  });

  it("reflects a recorded review mode", async () => {
    host.get.mockResolvedValue(
      dto({ mode: "review", reviewer_profile_id: "prof-1" }),
    );
    render(<MultiModelReviewToggle />);
    const reviewer = await screen.findByRole("radio", { name: "Reviewer" });
    expect((reviewer as HTMLInputElement).checked).toBe(true);
  });

  it("shows recorded reviewer facts — identity, model, qualification, remote", async () => {
    host.get.mockResolvedValue(
      dto({
        reviewer_profile_id: "workspace-reviewer-profile-long-identifier",
        reviewer_model: "org/some-very-long-reviewer-model-build-2026-08",
        reviewer_require_qualified: true,
        reviewer_allow_remote: true,
      }),
    );
    render(<MultiModelReviewToggle />);
    await screen.findByRole("radiogroup", { name: "Investigation team" });

    expect(
      screen.getByText("workspace-reviewer-profile-long-identifier"),
    ).toBeTruthy();
    expect(
      screen.getByText("org/some-very-long-reviewer-model-build-2026-08"),
    ).toBeTruthy();
    expect(screen.getByText("Required before it reviews")).toBeTruthy();
    expect(screen.getByText("Permitted")).toBeTruthy();

    const reviewer = screen.getByRole("radio", { name: "Reviewer" });
    expect(describedText(reviewer)).toMatch(/remote use is permitted/i);
  });

  it("labels a reviewer without a model override as using the profile default", async () => {
    host.get.mockResolvedValue(
      dto({
        reviewer_profile_id: "prof-1",
        reviewer_model: null,
        reviewer_allow_remote: false,
      }),
    );
    render(<MultiModelReviewToggle />);
    await screen.findByRole("radiogroup", { name: "Investigation team" });
    expect(screen.getByText("profile default")).toBeTruthy();
    expect(screen.getByText("Not permitted — local only")).toBeTruthy();
  });

  it("explains reviewer degradation before selection and claims no readiness when unconfigured", async () => {
    render(<MultiModelReviewToggle />);
    const reviewer = await screen.findByRole("radio", { name: "Reviewer" });

    // Guidance is attached to the option itself, readable before choosing it.
    expect(describedText(reviewer)).toMatch(
      /no reviewer profile is configured/i,
    );
    expect(describedText(reviewer)).toMatch(/single-model/i);

    // The readiness panel states the gap instead of fabricating facts.
    expect(screen.getByText(/no reviewer is configured/i)).toBeTruthy();
    expect(screen.queryByText("Reviewer profile")).toBeNull();
    expect(screen.queryByText("Reviewer model")).toBeNull();

    // Configured-vs-executed honesty is always on screen.
    expect(
      screen.getByText(/configured is not the same as executed/i),
    ).toBeTruthy();
  });

  it("saves a new team through the host, refetches, and reports success without execution claims", async () => {
    host.get
      .mockResolvedValueOnce(dto())
      .mockResolvedValueOnce(dto({ mode: "review" }));
    render(<MultiModelReviewToggle />);
    const reviewer = await screen.findByRole("radio", { name: "Reviewer" });

    fireEvent.click(reviewer);
    await waitFor(() =>
      expect((screen.getByRole("radio", { name: "Reviewer" }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect(host.setMode).toHaveBeenCalledTimes(1);
    expect(host.setMode).toHaveBeenCalledWith("review");
    expect(host.get).toHaveBeenCalledTimes(2);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      "Saved — Reviewer is now the default team.",
    );
  });

  it("shows a busy state and ignores further selections while a save is in flight", async () => {
    let resolveSet!: () => void;
    host.setMode.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveSet = r;
        }),
    );
    render(<MultiModelReviewToggle />);
    const reviewer = await screen.findByRole("radio", { name: "Reviewer" });

    fireEvent.click(reviewer);
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/saving investigation team/i);
    expect(
      screen
        .getByRole("radiogroup", { name: "Investigation team" })
        .getAttribute("aria-busy"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Contributions" }));
    expect(host.setMode).toHaveBeenCalledTimes(1);

    host.get.mockResolvedValue(dto({ mode: "review" }));
    await act(async () => {
      resolveSet();
    });
    await waitFor(() =>
      expect(screen.queryByText(/saving investigation team/i)).toBeNull(),
    );
    expect(host.setMode).toHaveBeenCalledTimes(1);
  });

  it("keeps the recorded team, reports the host error, and retries the same mode", async () => {
    host.setMode.mockRejectedValueOnce(new Error("config file locked"));
    render(<MultiModelReviewToggle />);
    const contributions = await screen.findByRole("radio", {
      name: "Contributions",
    });

    fireEvent.click(contributions);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn’t switch to contributions/i);
    expect(alert.textContent).toMatch(/config file locked/i);

    // Selection honestly reverts to what the host recorded.
    expect(
      (screen.getByRole("radio", { name: "Standard" }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    host.setMode.mockResolvedValue(undefined);
    host.get.mockResolvedValue(dto({ mode: "contributions" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("radio", {
            name: "Contributions",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    expect(host.setMode).toHaveBeenLastCalledWith("contributions");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])(
    "treats a %s reviewer profile id as unconfigured — degraded guidance, no blank identity chip",
    async (_label, profileId) => {
      host.get.mockResolvedValue(
        dto({
          reviewer_profile_id: profileId,
          // Even with other reviewer fields recorded, a blank identity must
          // not present as a configured reviewer.
          reviewer_model: "org/some-model",
          reviewer_allow_remote: true,
        }),
      );
      render(<MultiModelReviewToggle />);
      const reviewer = await screen.findByRole("radio", { name: "Reviewer" });

      expect(describedText(reviewer)).toMatch(
        /no reviewer profile is configured/i,
      );
      expect(screen.getByText(/no reviewer is configured/i)).toBeTruthy();
      expect(screen.queryByText("Reviewer profile")).toBeNull();
      expect(screen.queryByText("Reviewer model")).toBeNull();
      expect(screen.queryByText("org/some-model")).toBeNull();
      // No configured-looking empty identity chip in the readiness panel.
      expect(document.querySelector(".mm-team__facts code")).toBeNull();
    },
  );

  it("explains contribution bounds honestly on the option itself", async () => {
    render(<MultiModelReviewToggle />);
    const contributions = await screen.findByRole("radio", {
      name: "Contributions",
    });
    const text = describedText(contributions);
    expect(text).toMatch(/this screen doesn’t create them/i);
    expect(text).toMatch(/skipped and recorded/i);
  });
});
