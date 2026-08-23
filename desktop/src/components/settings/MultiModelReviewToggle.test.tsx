/**
 * Investigation team cockpit.
 *
 * The behaviours that matter here are the honest ones: readiness comes only
 * from recorded settings fields plus the host's cached measured verdict,
 * degradation is explained before a mode is selected, saving is guarded and
 * recoverable, egress consent is explicit and never carried across profiles,
 * and nothing the surface says implies that picking a team or assigning a
 * reviewer configures profiles, qualifies anything, or guarantees extra
 * executed models.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MultiModelReviewToggle } from "./MultiModelReviewToggle";
import type {
  MultiModelSettingsDto,
  ReviewerCandidateDto,
} from "../../lib/host";

const host = vi.hoisted(() => ({
  get: vi.fn(),
  setMode: vi.fn(),
  setReviewer: vi.fn(),
}));

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostGetMultiModelSettings: (...args: unknown[]) => host.get(...args),
    hostSetMultiModelMode: (...args: unknown[]) => host.setMode(...args),
    hostSetMultiModelReviewer: (...args: unknown[]) => host.setReviewer(...args),
  };
});

const LOCAL_CANDIDATE: ReviewerCandidateDto = {
  id: "loc-1",
  label: "Ollama (local)",
  chat_model: "mistral",
  local_only: true,
};

const REMOTE_CANDIDATE: ReviewerCandidateDto = {
  id: "rem-1",
  label: "Workspace API",
  chat_model: "org/big-remote-model",
  local_only: false,
};

function dto(over: Partial<MultiModelSettingsDto> = {}): MultiModelSettingsDto {
  return {
    mode: "single",
    reviewer_profile_id: null,
    reviewer_model: null,
    reviewer_allow_remote: false,
    reviewer_require_qualified: true,
    reviewer_qualification: "unconfigured",
    active_profile_id: null,
    candidate_profiles: [],
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
  host.setReviewer.mockReset();
  host.get.mockResolvedValue(dto());
  host.setMode.mockResolvedValue(undefined);
  host.setReviewer.mockResolvedValue(undefined);
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
        candidate_profiles: [
          {
            id: "workspace-reviewer-profile-long-identifier",
            label: "Workspace reviewer",
            chat_model: "org/base-model",
            local_only: false,
          },
        ],
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
    expect(
      screen.getByText("Remote provider — egress acknowledged"),
    ).toBeTruthy();

    const reviewer = screen.getByRole("radio", { name: "Reviewer" });
    expect(describedText(reviewer)).toMatch(
      /remote evidence egress is acknowledged/i,
    );
  });

  it("labels a reviewer without a model override as using the profile default", async () => {
    host.get.mockResolvedValue(
      dto({
        reviewer_profile_id: "prof-1",
        reviewer_model: null,
        reviewer_allow_remote: false,
        candidate_profiles: [
          {
            id: "prof-1",
            label: "Local reviewer",
            chat_model: "mistral",
            local_only: true,
          },
        ],
      }),
    );
    render(<MultiModelReviewToggle />);
    await screen.findByRole("radiogroup", { name: "Investigation team" });
    expect(screen.getByText("profile default")).toBeTruthy();
    expect(
      screen.getByText("Local-only profile — no remote egress applies"),
    ).toBeTruthy();
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
    // A mode save never touches the reviewer assignment.
    expect(host.setReviewer).not.toHaveBeenCalled();
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

  describe("reviewer assignment", () => {
    it("assigns an existing remote profile with explicit egress consent and reports a recorded save without execution claims", async () => {
      host.get
        .mockResolvedValueOnce(
          dto({ candidate_profiles: [LOCAL_CANDIDATE, REMOTE_CANDIDATE] }),
        )
        .mockResolvedValueOnce(
          dto({
            candidate_profiles: [LOCAL_CANDIDATE, REMOTE_CANDIDATE],
            reviewer_profile_id: "rem-1",
            reviewer_allow_remote: true,
            reviewer_qualification: "unverified",
          }),
        );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "rem-1" },
      });
      // Remote profile: the explicit egress acknowledgement appears, off by
      // default, and explains the consequence before consent.
      const ack = screen.getByRole("checkbox", {
        name: /allow remote evidence egress/i,
      });
      expect((ack as HTMLInputElement).checked).toBe(false);
      fireEvent.click(ack);

      fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));
      await waitFor(() => expect(host.setReviewer).toHaveBeenCalledTimes(1));
      expect(host.setReviewer).toHaveBeenCalledWith({
        profileId: "rem-1",
        model: null,
        allowRemote: true,
      });
      expect(host.get).toHaveBeenCalledTimes(2);

      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toMatch(
          /saved — reviewer assignment recorded/i,
        ),
      );
      // Configured, never promised: no execution claim anywhere.
      expect(screen.queryByText(/will review|will run/i)).toBeNull();
    });

    it("sends a trimmed model override, and empty means profile default", async () => {
      host.get.mockResolvedValue(
        dto({ candidate_profiles: [REMOTE_CANDIDATE] }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      const model = screen.getByLabelText(/model override/i);
      expect((model as HTMLInputElement).disabled).toBe(true);

      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "rem-1" },
      });
      expect((model as HTMLInputElement).disabled).toBe(false);
      expect(screen.getByText(/empty uses the profile default/i).textContent)
        .toContain("org/big-remote-model");

      fireEvent.change(model, { target: { value: "  custom-model  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));
      await waitFor(() => expect(host.setReviewer).toHaveBeenCalledTimes(1));
      expect(host.setReviewer).toHaveBeenCalledWith({
        profileId: "rem-1",
        model: "custom-model",
        allowRemote: false,
      });
    });

    it("clears the reviewer and reports the degradation honestly", async () => {
      host.get
        .mockResolvedValueOnce(
          dto({
            candidate_profiles: [REMOTE_CANDIDATE],
            reviewer_profile_id: "rem-1",
            reviewer_allow_remote: true,
            reviewer_qualification: "qualified",
          }),
        )
        .mockResolvedValueOnce(
          dto({ candidate_profiles: [REMOTE_CANDIDATE] }),
        );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      fireEvent.click(screen.getByRole("button", { name: "Clear reviewer" }));
      await waitFor(() => expect(host.setReviewer).toHaveBeenCalledTimes(1));
      expect(host.setReviewer).toHaveBeenCalledWith({
        profileId: null,
        model: null,
        allowRemote: false,
      });

      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toMatch(
          /saved — reviewer cleared/i,
        ),
      );
      expect(screen.getByRole("status").textContent).toMatch(/single-model/i);
      expect(screen.getByText(/no reviewer is configured/i)).toBeTruthy();
    });

    it("disables clearing when nothing is recorded and nothing is selected", async () => {
      host.get.mockResolvedValue(
        dto({ candidate_profiles: [REMOTE_CANDIDATE] }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });
      expect(
        (screen.getByRole("button", { name: "Clear reviewer" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    it("never offers or submits an egress acknowledgement for a local-only profile", async () => {
      host.get.mockResolvedValue(
        dto({ candidate_profiles: [LOCAL_CANDIDATE, REMOTE_CANDIDATE] }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      // Prime a remote consent first, then switch to the local profile: the
      // consent must not carry over, and no checkbox is offered at all.
      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "rem-1" },
      });
      fireEvent.click(
        screen.getByRole("checkbox", { name: /allow remote evidence egress/i }),
      );
      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "loc-1" },
      });
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(
        screen.getByText(/evidence never leaves this machine/i),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));
      await waitFor(() => expect(host.setReviewer).toHaveBeenCalledTimes(1));
      expect(host.setReviewer).toHaveBeenCalledWith({
        profileId: "loc-1",
        model: null,
        allowRemote: false,
      });
    });

    it("shows a recorded remote reviewer without acknowledgement as not ready — never as willing to review", async () => {
      host.get.mockResolvedValue(
        dto({
          candidate_profiles: [REMOTE_CANDIDATE],
          reviewer_profile_id: "rem-1",
          reviewer_allow_remote: false,
          reviewer_qualification: "qualified",
        }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      const gate = screen.getByText(/not ready —/i);
      expect(gate.textContent).toMatch(/egress is not acknowledged/i);
      expect(gate.textContent).toMatch(/single-model/i);
      expect(screen.queryByText(/will review|will run/i)).toBeNull();
    });

    it("shows measured qualification separately from policy, and unverified is never qualified", async () => {
      host.get.mockResolvedValue(
        dto({
          candidate_profiles: [REMOTE_CANDIDATE],
          reviewer_profile_id: "rem-1",
          reviewer_allow_remote: true,
          reviewer_require_qualified: true,
          reviewer_qualification: "unverified",
        }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      // Policy row and measured row are distinct facts.
      expect(screen.getByText("Required before it reviews")).toBeTruthy();
      expect(screen.getByText("Not measured yet (unverified)")).toBeTruthy();
      expect(screen.queryByText("Measured qualified")).toBeNull();
      expect(
        screen.getByText(/not ready —/i).textContent,
      ).toMatch(/not been measured/i);
    });

    it("shows a measured-qualified reviewer with all gates passed as recorded — still without execution promises", async () => {
      host.get.mockResolvedValue(
        dto({
          candidate_profiles: [REMOTE_CANDIDATE],
          reviewer_profile_id: "rem-1",
          reviewer_allow_remote: true,
          reviewer_qualification: "qualified",
        }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      expect(screen.getByText("Measured qualified")).toBeTruthy();
      expect(screen.queryByText(/not ready —/i)).toBeNull();
      const gate = screen.getByText(/recorded and eligible/i);
      expect(gate.textContent).toMatch(/re-checks qualification and egress/i);
      expect(gate.textContent).toMatch(/log explorer/i);
      expect(screen.queryByText(/will review|will run/i)).toBeNull();
    });

    it("shows a measured failure as unqualified and not ready", async () => {
      host.get.mockResolvedValue(
        dto({
          candidate_profiles: [REMOTE_CANDIDATE],
          reviewer_profile_id: "rem-1",
          reviewer_allow_remote: true,
          reviewer_qualification: "unqualified",
        }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      expect(screen.getByText("Measured — did not qualify")).toBeTruthy();
      expect(screen.getByText(/not ready —/i).textContent).toMatch(
        /measured qualification failed/i,
      );
    });

    it("marks a recorded reviewer whose profile was deleted as not ready", async () => {
      host.get.mockResolvedValue(
        dto({
          candidate_profiles: [REMOTE_CANDIDATE],
          reviewer_profile_id: "ghost-profile",
          reviewer_allow_remote: true,
          reviewer_qualification: "unverified",
        }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      expect(screen.getByText(/not ready —/i).textContent).toMatch(
        /no longer exists/i,
      );
      // The picker keeps the recorded value selectable, honestly labelled.
      expect(
        screen.getByRole("option", { name: "ghost-profile (not found)" }),
      ).toBeTruthy();
    });

    describe("recorded egress identity derives from the profile, never the acknowledgement alone", () => {
      it("describes a genuinely local-only reviewer as local", async () => {
        host.get.mockResolvedValue(
          dto({
            candidate_profiles: [LOCAL_CANDIDATE, REMOTE_CANDIDATE],
            reviewer_profile_id: "loc-1",
            reviewer_allow_remote: false,
            reviewer_qualification: "qualified",
          }),
        );
        render(<MultiModelReviewToggle />);
        await screen.findByRole("group", { name: "Reviewer assignment" });

        expect(
          screen.getByText("Local-only profile — no remote egress applies"),
        ).toBeTruthy();
        const reviewer = screen.getByRole("radio", { name: "Reviewer" });
        expect(describedText(reviewer)).toMatch(
          /local-only; evidence never leaves this machine/i,
        );
        // A local reviewer has no egress gate; qualified means no gate at all.
        expect(screen.queryByText(/not ready —/i)).toBeNull();
      });

      it("describes an acknowledged remote reviewer as remote — never as local", async () => {
        host.get.mockResolvedValue(
          dto({
            candidate_profiles: [REMOTE_CANDIDATE],
            reviewer_profile_id: "rem-1",
            reviewer_allow_remote: true,
            reviewer_qualification: "qualified",
          }),
        );
        render(<MultiModelReviewToggle />);
        await screen.findByRole("group", { name: "Reviewer assignment" });

        expect(
          screen.getByText("Remote provider — egress acknowledged"),
        ).toBeTruthy();
        expect(screen.queryByText(/local only/i)).toBeNull();
      });

      it("never renders a remote reviewer without acknowledgement as local", async () => {
        host.get.mockResolvedValue(
          dto({
            candidate_profiles: [REMOTE_CANDIDATE],
            reviewer_profile_id: "rem-1",
            reviewer_allow_remote: false,
            reviewer_qualification: "qualified",
          }),
        );
        render(<MultiModelReviewToggle />);
        await screen.findByRole("group", { name: "Reviewer assignment" });

        // Identity stays truthful: remote, unacknowledged — nowhere "local".
        expect(
          screen.getByText("Remote provider — egress not acknowledged"),
        ).toBeTruthy();
        expect(screen.queryByText(/local only/i)).toBeNull();
        const reviewer = screen.getByRole("radio", { name: "Reviewer" });
        expect(describedText(reviewer)).toMatch(
          /remote provider and egress is not acknowledged/i,
        );
        // The fail-closed gate is unchanged.
        expect(screen.getByText(/not ready —/i).textContent).toMatch(
          /egress is not acknowledged/i,
        );
      });

      it("says egress cannot be evaluated when the recorded profile is missing", async () => {
        host.get.mockResolvedValue(
          dto({
            candidate_profiles: [REMOTE_CANDIDATE],
            reviewer_profile_id: "ghost-profile",
            reviewer_allow_remote: true,
            reviewer_qualification: "unverified",
          }),
        );
        render(<MultiModelReviewToggle />);
        await screen.findByRole("group", { name: "Reviewer assignment" });

        expect(
          screen.getByText("Profile unavailable — egress cannot be evaluated"),
        ).toBeTruthy();
        expect(screen.queryByText(/local only/i)).toBeNull();
        const reviewer = screen.getByRole("radio", { name: "Reviewer" });
        expect(describedText(reviewer)).toMatch(/profile is unavailable/i);
      });
    });

    it("says honestly that assigning the investigator's own profile is a second role, not a second model", async () => {
      host.get.mockResolvedValue(
        dto({
          candidate_profiles: [REMOTE_CANDIDATE],
          active_profile_id: "rem-1",
        }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "rem-1" },
      });
      expect(
        screen.getByText(/second prompt in a second role, not a second model/i),
      ).toBeTruthy();

      // A different model override on the same profile is a different model —
      // the same-model honesty note no longer applies.
      fireEvent.change(screen.getByLabelText(/model override/i), {
        target: { value: "another-model" },
      });
      expect(
        screen.queryByText(/not a second model/i),
      ).toBeNull();
    });

    it("guards double-submit with a busy state and recovers", async () => {
      host.get.mockResolvedValue(
        dto({ candidate_profiles: [REMOTE_CANDIDATE] }),
      );
      let resolveSet!: () => void;
      host.setReviewer.mockImplementation(
        () =>
          new Promise<void>((r) => {
            resolveSet = r;
          }),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "rem-1" },
      });
      const save = screen.getByRole("button", { name: "Save reviewer" });
      fireEvent.click(save);
      const status = await screen.findByRole("status");
      expect(status.textContent).toMatch(/saving reviewer assignment/i);
      expect(
        screen
          .getByRole("group", { name: "Reviewer assignment" })
          .getAttribute("aria-busy"),
      ).toBe("true");
      expect((save as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(save);
      expect(host.setReviewer).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSet();
      });
      await waitFor(() =>
        expect(screen.queryByText(/saving reviewer assignment/i)).toBeNull(),
      );
    });

    it("reports an assignment failure from the host and retries the same action", async () => {
      host.get.mockResolvedValue(
        dto({ candidate_profiles: [REMOTE_CANDIDATE] }),
      );
      host.setReviewer.mockRejectedValueOnce(
        new Error("unknown provider profile: rem-1"),
      );
      render(<MultiModelReviewToggle />);
      await screen.findByRole("group", { name: "Reviewer assignment" });

      fireEvent.change(screen.getByLabelText("Profile"), {
        target: { value: "rem-1" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(
        /couldn’t save the reviewer assignment/i,
      );
      expect(alert.textContent).toMatch(/unknown provider profile/i);

      host.setReviewer.mockResolvedValue(undefined);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(host.setReviewer).toHaveBeenCalledTimes(2));
      expect(host.setReviewer).toHaveBeenLastCalledWith({
        profileId: "rem-1",
        model: null,
        allowRemote: false,
      });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
  });
});
