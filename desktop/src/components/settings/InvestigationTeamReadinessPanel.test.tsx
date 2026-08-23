import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationTeamReadinessPanel } from "./InvestigationTeamReadinessPanel";
import type { MultiModelSettingsDto } from "../../lib/host";

const host = vi.hoisted(() => ({
  get: vi.fn(),
  qualification: vi.fn(),
  runSynthetic: vi.fn(),
}));

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostGetMultiModelSettings: (...args: unknown[]) => host.get(...args),
    hostGetInvestigationTeamQualification: (...args: unknown[]) =>
      host.qualification(...args),
    hostRunSyntheticInvestigationTeamQualification: (...args: unknown[]) =>
      host.runSynthetic(...args),
  };
});

function settings(over: Partial<MultiModelSettingsDto> = {}): MultiModelSettingsDto {
  return {
    mode: "review",
    reviewer_profile_id: "reviewer-1",
    reviewer_model: null,
    reviewer_allow_remote: false,
    reviewer_require_qualified: true,
    reviewer_qualification: "qualified",
    active_profile_id: "investigator-1",
    candidate_profiles: [
      { id: "investigator-1", label: "Investigator", chat_model: "model-a", local_only: true },
      { id: "reviewer-1", label: "Reviewer", chat_model: "model-b", local_only: true },
    ],
    contribution_assignments: [],
    contribution_policy: {
      max_contributors: 4,
      max_parallel: 3,
      max_rounds: 2,
      max_context_chars: 120_000,
      max_total_provider_rounds: 12,
      max_semantic_corrections_per_stage: 1,
      max_context_chars_total: null,
    },
    ...over,
  };
}

beforeEach(() => {
  host.get.mockReset();
  host.qualification.mockReset();
  host.runSynthetic.mockReset();
  host.get.mockResolvedValue(settings());
  host.qualification.mockResolvedValue(null);
  host.runSynthetic.mockResolvedValue(null);
});

describe("InvestigationTeamReadinessPanel", () => {
  it("separates configured investigator from measured reviewer readiness", async () => {
    render(<InvestigationTeamReadinessPanel />);
    const panel = await screen.findByTestId("investigation-team-readiness");
    expect(panel.textContent).toMatch(/configured; team qualification evidence is not attached/i);
    expect(panel.textContent).toMatch(/measured qualified/i);
    expect(panel.textContent).toMatch(/never claims that a configured role actually ran/i);
  });

  it("shows honest degradation when the reviewer is unconfigured", async () => {
    host.get.mockResolvedValue(
      settings({ reviewer_profile_id: "", reviewer_qualification: "unconfigured" }),
    );
    render(<InvestigationTeamReadinessPanel />);
    const panel = await screen.findByTestId("investigation-team-readiness");
    expect(panel.textContent).toMatch(/will degrade or wait/i);
    expect(panel.textContent).toMatch(/no reviewer profile is assigned/i);
  });

  it("shows a host-published fingerprint without exposing evaluator truth", async () => {
    host.qualification.mockResolvedValue({
      status: "partial",
      schema_id: "contextdesk.investigation_team_qualification.v1",
      suite_version: "contextdesk.investigation_team_qualification.suite.v1",
      observed_at: 1_777_000_000,
      stale: false,
      incomplete_attempts: true,
      fingerprint_digest: "a".repeat(64),
      scoring_digest: "b".repeat(64),
      capability: { contract_met: true, metrics: {}, notes: [] },
      quality: { contract_met: false, metrics: {}, notes: ["partial"] },
      speed: { contract_met: true, metrics: {}, notes: [] },
      resource: { contract_met: true, metrics: {}, notes: [] },
      redacted_json: "{\"safe\":true}",
      redacted_markdown: "safe",
    });
    render(<InvestigationTeamReadinessPanel />);
    const report = await screen.findByTestId("investigation-team-qualification-report");
    expect(report.getAttribute("data-status")).toBe("partial");
    expect(report.textContent).toMatch(/incomplete attempts remain/i);
    expect(report.textContent).toMatch(/pipeline fingerprint/i);
    expect(report.textContent).toMatch(/evaluator truth and provider credentials are not exposed/i);
  });

  it("does not call the provider and can retry a host read failure", async () => {
    host.get.mockRejectedValueOnce(new Error("ipc down"));
    render(<InvestigationTeamReadinessPanel />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    host.get.mockResolvedValue(settings({ mode: "single", reviewer_profile_id: null }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("investigation-team-readiness")).toBeTruthy());
    expect(host.get).toHaveBeenCalledTimes(2);
  });

  it("keeps browser preview absent when the host is unavailable", async () => {
    host.get.mockResolvedValue(null);
    const { container } = render(<InvestigationTeamReadinessPanel />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("runs the explicit provider-free synthetic check and refreshes the report", async () => {
    host.runSynthetic.mockResolvedValue({
      status: "qualified",
      schema_id: "contextdesk.investigation_team_qualification.v1",
      suite_version: "contextdesk.investigation_team_qualification.suite.v1",
      observed_at: 1_777_000_000,
      stale: false,
      incomplete_attempts: false,
      fingerprint_digest: "c".repeat(64),
      scoring_digest: "d".repeat(64),
      capability: { contract_met: true, metrics: {}, notes: [] },
      quality: { contract_met: true, metrics: {}, notes: [] },
      speed: { contract_met: true, metrics: {}, notes: [] },
      resource: { contract_met: true, metrics: {}, notes: [] },
      redacted_json: "{\"safe\":true}",
      redacted_markdown: "safe",
    });
    render(<InvestigationTeamReadinessPanel />);
    await screen.findByTestId("investigation-team-readiness");
    fireEvent.click(screen.getByTestId("investigation-team-run-synthetic"));
    await waitFor(() => {
      expect(
        screen
          .getByTestId("investigation-team-qualification-report")
          .getAttribute("data-status"),
      ).toBe("qualified");
    });
    expect(host.runSynthetic).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/does not qualify a real model/i)).toBeTruthy();
  });

  it("surfaces a trusted-host synthetic check failure without claiming a report", async () => {
    host.runSynthetic.mockRejectedValue(new Error("no active provider profile"));
    render(<InvestigationTeamReadinessPanel />);
    await screen.findByTestId("investigation-team-readiness");
    fireEvent.click(screen.getByTestId("investigation-team-run-synthetic"));
    expect(
      (await screen.findByTestId("investigation-team-synthetic-error")).textContent,
    ).toContain("no active provider profile");
    expect(screen.queryByTestId("investigation-team-qualification-report")).toBeNull();
  });
});
