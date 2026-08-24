import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationTeamReadinessPanel } from "./InvestigationTeamReadinessPanel";
import type {
  InvestigationTeamKnownAnswerDto,
  InvestigationTeamQualificationDto,
  MultiModelSettingsDto,
} from "../../lib/host";

const host = vi.hoisted(() => ({
  get: vi.fn(),
  qualification: vi.fn(),
  history: vi.fn(),
  runSynthetic: vi.fn(),
  runLive: vi.fn(),
  cancelLive: vi.fn(),
  knownAnswerHistory: vi.fn(),
  runKnownAnswer: vi.fn(),
  cancelKnownAnswer: vi.fn(),
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
    hostListInvestigationTeamQualifications: (...args: unknown[]) =>
      host.history(...args),
    hostRunSyntheticInvestigationTeamQualification: (...args: unknown[]) =>
      host.runSynthetic(...args),
    hostRunLiveInvestigationTeamQualification: (...args: unknown[]) =>
      host.runLive(...args),
    hostCancelLiveInvestigationTeamQualification: (...args: unknown[]) =>
      host.cancelLive(...args),
    hostListInvestigationTeamKnownAnswerQualifications: (...args: unknown[]) =>
      host.knownAnswerHistory(...args),
    hostRunLiveInvestigationTeamKnownAnswerQualification: (...args: unknown[]) =>
      host.runKnownAnswer(...args),
    hostCancelLiveInvestigationTeamKnownAnswerQualification: (...args: unknown[]) =>
      host.cancelKnownAnswer(...args),
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

function report(
  over: Partial<InvestigationTeamQualificationDto> = {},
): InvestigationTeamQualificationDto {
  return {
    run_kind: "measured",
    status: "qualified",
    schema_id: "contextdesk.investigation_team_qualification.v1",
    suite_version: "contextdesk.investigation_team_qualification.suite.v1",
    observed_at: 1_777_000_000,
    stale: false,
    incomplete_attempts: false,
    fingerprint_digest: "h".repeat(64),
    scoring_digest: "i".repeat(64),
    capability: { contract_met: true, metrics: {}, notes: [] },
    quality: { contract_met: true, metrics: {}, notes: [] },
    speed: { contract_met: true, metrics: {}, notes: [] },
    resource: { contract_met: true, metrics: {}, notes: [] },
    members: [],
    failures: [],
    redacted_json: "{\"safe\":true}",
    redacted_markdown: "safe",
    ...over,
  };
}

function knownAnswerReport(
  over: Partial<InvestigationTeamKnownAnswerDto> = {},
): InvestigationTeamKnownAnswerDto {
  return {
    status: "qualified",
    reported_status: "qualified",
    stale: false,
    stale_reasons: [],
    observed_at: 1_777_000_000,
    role: "investigator",
    build_identity: "build-a",
    subject_storage_id: "subject-a",
    profile_id: "investigator-1",
    model_id: "model-a",
    endpoint_fingerprint: "a".repeat(64),
    suite_id: "open-v1",
    suite_digest: "b".repeat(64),
    prompt_set_hash: "c".repeat(64),
    orchestration_policy_fingerprint: "d".repeat(64),
    metrics: {
      required_scenarios: 14,
      executed_scenarios: 14,
      passed_scenarios: 14,
      failed_scenarios: 0,
      cancelled_scenarios: 0,
      blocked_scenarios: 0,
      total_latency_ms: 1_400,
      total_message_content_bytes: 14_000,
      total_provider_content_bytes: 7_000,
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_tokens: null,
      cost_microusd: null,
    },
    scenarios: Array.from({ length: 14 }, (_, index) => ({
      scenario_id: `scenario-${String(index + 1).padStart(3, "0")}`,
      status: "executed",
      passed: true,
      failed_dimensions: [],
      latency_ms: 100,
      message_content_bytes: 1_000,
      provider_content_bytes: 500,
      failure_code: null,
    })),
    redacted_json: "{\"known_answer\":true}",
    redacted_markdown: "known answer safe",
    ...over,
  };
}

beforeEach(() => {
  host.get.mockReset();
  host.qualification.mockReset();
  host.history.mockReset();
  host.runSynthetic.mockReset();
  host.runLive.mockReset();
  host.cancelLive.mockReset();
  host.knownAnswerHistory.mockReset();
  host.runKnownAnswer.mockReset();
  host.cancelKnownAnswer.mockReset();
  host.get.mockResolvedValue(settings());
  host.qualification.mockResolvedValue(null);
  host.history.mockResolvedValue([]);
  host.runSynthetic.mockResolvedValue(null);
  host.runLive.mockResolvedValue(null);
  host.cancelLive.mockResolvedValue(true);
  host.knownAnswerHistory.mockResolvedValue([]);
  host.runKnownAnswer.mockResolvedValue([]);
  host.cancelKnownAnswer.mockResolvedValue(true);
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
      run_kind: "measured",
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
      members: [
        {
          role: "investigator",
          subject_storage_id: "subject-investigator",
          profile_id: "run-investigator",
          model_id: "run-model-a",
          endpoint_fingerprint: "1".repeat(64),
        },
        {
          role: "reviewer",
          subject_storage_id: "subject-reviewer",
          profile_id: "run-reviewer",
          model_id: "run-model-b",
          endpoint_fingerprint: "2".repeat(64),
        },
      ],
      failures: [],
      redacted_json: "{\"safe\":true}",
      redacted_markdown: "safe",
    });
    render(<InvestigationTeamReadinessPanel />);
    const report = await screen.findByTestId("investigation-team-qualification-report");
    expect(report.getAttribute("data-status")).toBe("partial");
    expect(report.textContent).toMatch(/incomplete attempts remain/i);
    expect(report.textContent).toMatch(/pipeline fingerprint/i);
    expect(report.textContent).toMatch(/evaluator truth and provider credentials are not exposed/i);
    expect(screen.getByTestId("investigation-team-qualification-members").textContent).toMatch(
      /investigator.*run-investigator.*run-model-a/s,
    );
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

  it("blocks providers until a repaired evidence store reloads in-process", async () => {
    host.knownAnswerHistory.mockRejectedValueOnce(
      new Error("existing evidence is unavailable; repair or remove the invalid owner store"),
    );
    render(<InvestigationTeamReadinessPanel />);

    await screen.findByTestId("investigation-team-readiness");
    const alert = screen.getByTestId("investigation-team-known-answer-error");
    expect(alert.textContent).toMatch(/existing evidence is unavailable/i);
    expect(
      (screen.getByRole("button", {
        name: /evidence store unavailable/i,
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(host.runKnownAnswer).not.toHaveBeenCalled();
    expect(alert.textContent).toMatch(/retry this secure read/i);
    expect(alert.textContent).toMatch(/will not call a provider unless that reload succeeds/i);

    fireEvent.click(
      screen.getByRole("button", { name: /retry secure evidence store read/i }),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", {
          name: /assess 14-scenario suite/i,
        }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(host.knownAnswerHistory).toHaveBeenCalledTimes(2);
    expect(host.runKnownAnswer).not.toHaveBeenCalled();
  });

  it("labels stale host evidence as unusable for a new run", async () => {
    host.qualification.mockResolvedValue({
      run_kind: "measured",
      status: "stale",
      schema_id: "contextdesk.investigation_team_qualification.v1",
      suite_version: "contextdesk.investigation_team_qualification.suite.v1",
      observed_at: 1_777_000_000,
      stale: true,
      incomplete_attempts: false,
      fingerprint_digest: "s".repeat(64),
      scoring_digest: "t".repeat(64),
      capability: { contract_met: true, metrics: {}, notes: [] },
      quality: { contract_met: true, metrics: {}, notes: [] },
      speed: { contract_met: true, metrics: {}, notes: [] },
      resource: { contract_met: true, metrics: {}, notes: [] },
      members: [],
      failures: [],
      redacted_json: "{\"safe\":true}",
      redacted_markdown: "safe",
    });
    render(<InvestigationTeamReadinessPanel />);
    const report = await screen.findByTestId("investigation-team-qualification-report");
    expect(report.getAttribute("data-status")).toBe("stale");
    expect(report.textContent).toMatch(/stale evidence.*do not use it for a new run/i);
  });

  it("keeps durable measured and provider-free history visibly distinct", async () => {
    const measured = report();
    const synthetic = report({
      run_kind: "synthetic",
      observed_at: 1_777_000_100,
      fingerprint_digest: "j".repeat(64),
      scoring_digest: "k".repeat(64),
    });
    host.qualification.mockResolvedValue(measured);
    host.history.mockResolvedValue([synthetic, measured]);
    render(<InvestigationTeamReadinessPanel />);

    const history = await screen.findByTestId("investigation-team-qualification-history");
    expect(history.textContent).toMatch(/wiring check/i);
    expect(history.textContent).toMatch(/measured/i);
    expect(
      screen.getByTestId("investigation-team-qualification-report").textContent,
    ).toMatch(/measured team qualification/i);

    fireEvent.click(screen.getByRole("button", { name: /wiring check/i }));
    expect(
      screen.getByTestId("investigation-team-qualification-report").textContent,
    ).toMatch(/not model or pipeline performance evidence/i);
  });

  it("keeps browser preview absent when the host is unavailable", async () => {
    host.get.mockResolvedValue(null);
    const { container } = render(<InvestigationTeamReadinessPanel />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("runs the explicit provider-free synthetic check and refreshes the report", async () => {
    host.runSynthetic.mockResolvedValue({
      run_kind: "synthetic",
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
      members: [],
      failures: [],
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

  it("shows measured role failures instead of hiding a partial result", async () => {
    host.runLive.mockResolvedValue({
      run_kind: "measured",
      status: "partial",
      schema_id: "contextdesk.investigation_team_qualification.v1",
      suite_version: "contextdesk.investigation_team_qualification.suite.v1",
      observed_at: 1_777_000_000,
      stale: false,
      incomplete_attempts: true,
      fingerprint_digest: "e".repeat(64),
      scoring_digest: "f".repeat(64),
      capability: { contract_met: true, metrics: {}, notes: [] },
      quality: { contract_met: false, metrics: {}, notes: [] },
      speed: { contract_met: true, metrics: {}, notes: [] },
      resource: { contract_met: true, metrics: {}, notes: [] },
      members: [],
      failures: [
        {
          attempt_id: "live-qualification-attempt-2",
          role: "reviewer",
          reason: "response_contract_failed",
        },
      ],
      redacted_json: "{\"safe\":true}",
      redacted_markdown: "safe",
    });
    render(<InvestigationTeamReadinessPanel />);
    await screen.findByTestId("investigation-team-readiness");
    fireEvent.click(screen.getByTestId("investigation-team-run-live"));
    const failures = await screen.findByTestId(
      "investigation-team-qualification-failures",
    );
    expect(failures.textContent).toMatch(/reviewer/i);
    expect(failures.textContent).toMatch(/required qualification format/i);
    expect(failures.textContent).not.toMatch(/response_contract_failed/i);
    expect(screen.getByTestId("investigation-team-qualification-axes").textContent).toMatch(
      /capability/i,
    );
    expect(screen.getByTestId("investigation-team-redacted-json").textContent).toContain(
      '"safe":true',
    );
    expect(host.runLive).toHaveBeenCalledTimes(1);
  });

  it("surfaces measured-host setup errors without retaining an old report", async () => {
    host.runLive.mockRejectedValue(new Error("reviewer remote evidence egress is not acknowledged"));
    render(<InvestigationTeamReadinessPanel />);
    await screen.findByTestId("investigation-team-readiness");
    fireEvent.click(screen.getByTestId("investigation-team-run-live"));
    expect(
      (await screen.findByTestId("investigation-team-live-error")).textContent,
    ).toContain("remote evidence egress");
    expect(screen.queryByTestId("investigation-team-qualification-report")).toBeNull();
  });

  it("shows exact known-answer identity, honest unknown usage, and stale reasons", async () => {
    const stale = knownAnswerReport({
      status: "stale",
      reported_status: "failed",
      stale: true,
      stale_reasons: ["build_changed", "pipeline_changed"],
      metrics: {
        ...knownAnswerReport().metrics,
        passed_scenarios: 13,
        failed_scenarios: 1,
      },
      scenarios: knownAnswerReport().scenarios.map((scenario, index) =>
        index === 4
          ? {
              ...scenario,
              status: "failed",
              passed: false,
              failed_dimensions: ["causal_role_contract"],
              reported_model_id: "provider/model-b",
              failure_code: "provider_response_vocabulary_rejected",
            }
          : scenario,
      ),
    });
    host.knownAnswerHistory.mockResolvedValue([stale]);
    render(<InvestigationTeamReadinessPanel />);

    const quality = await screen.findByTestId("investigation-team-known-answer-quality");
    expect(quality.textContent).toMatch(/13\/14 scenarios passed/i);
    expect(quality.textContent).toMatch(/tokens: unknown input.*cost: unknown/i);
    expect(quality.textContent).toMatch(/not audited billing records/i);
    expect(quality.textContent).toMatch(/private owner-only host store/i);
    expect(quality.textContent).toMatch(/stable owner-only parent directory/i);
    expect(quality.textContent).toMatch(/deleted together with their redacted history/i);
    expect(quality.textContent).toMatch(/entire persisted quality feature fails closed/i);
    expect(quality.textContent).toMatch(/before any provider call/i);
    expect(quality.textContent).toMatch(/reloads it without restarting the app/i);
    expect(quality.textContent).toMatch(/message-content bytes.*provider-content bytes/i);
    expect(quality.textContent).toMatch(/app build changed.*configured role or deployment changed/i);
    expect(quality.textContent).toMatch(/stale · recorded failed/i);
    expect(quality.textContent).toContain("investigator-1");
    expect(quality.textContent).toContain("model-a");
    expect(quality.textContent).not.toMatch(/evaluator_truth|answer_key|sk-/i);

    fireEvent.click(screen.getByText("Inspect 14 scenario outcomes"));
    expect(quality.textContent).toContain("scenario-005");
    expect(quality.textContent).toContain("causal_role_contract");
    expect(quality.textContent).toMatch(/provider reported provider\/model-b/i);
    expect(quality.textContent).toMatch(/differs from configured model/i);
    expect(quality.textContent).toMatch(/unsupported vocabulary/i);
  });

  it("runs the trusted-host known-answer suite and publishes returned history", async () => {
    host.runKnownAnswer.mockResolvedValue([knownAnswerReport()]);
    render(<InvestigationTeamReadinessPanel />);
    await screen.findByTestId("investigation-team-readiness");
    fireEvent.click(screen.getByTestId("investigation-team-run-known-answer"));

    await waitFor(() => {
      expect(screen.getByTestId("investigation-team-known-answer-quality").textContent)
        .toMatch(/14\/14 scenarios passed/i);
    });
    expect(host.runKnownAnswer).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/tokens and cost remain “unknown”/i)).toBeTruthy();
    expect(screen.getByText(/shown as blocked rather than counted as model failures/i)).toBeTruthy();
  });

  it("names unavailable host diagnostics and does not imply all scenarios dispatch", async () => {
    const blocked = knownAnswerReport({
      status: "partial",
      reported_status: "partial",
      metrics: {
        ...knownAnswerReport().metrics,
        passed_scenarios: 10,
        executed_scenarios: 10,
        blocked_scenarios: 4,
      },
      scenarios: knownAnswerReport().scenarios.map((scenario, index) =>
        index >= 10
          ? {
              ...scenario,
              status: "blocked",
              passed: false,
              failure_code: "host_diagnostic_pipeline_unavailable",
            }
          : scenario,
      ),
    });
    host.knownAnswerHistory.mockResolvedValue([blocked]);
    render(<InvestigationTeamReadinessPanel />);

    const quality = await screen.findByTestId("investigation-team-known-answer-quality");
    expect(
      screen.getByRole("button", { name: /assess 14-scenario suite/i }),
    ).toBeTruthy();
    expect(quality.textContent).toMatch(/dispatches only work it can execute and observe honestly/i);
    expect(quality.textContent).toMatch(/4 blocked/i);

    fireEvent.click(screen.getByText("Inspect 14 scenario outcomes"));
    expect(quality.textContent).toMatch(/required host diagnostic execution is not available/i);
    expect(quality.textContent).not.toMatch(/did not produce a usable score/i);
  });

  it("offers cooperative cancellation while the known-answer suite is running", async () => {
    host.runKnownAnswer.mockReturnValue(new Promise(() => undefined));
    render(<InvestigationTeamReadinessPanel />);
    await screen.findByTestId("investigation-team-readiness");
    fireEvent.click(screen.getByTestId("investigation-team-run-known-answer"));
    const cancel = await screen.findByRole("button", { name: /cancel after active call/i });
    fireEvent.click(cancel);
    await waitFor(() => expect(host.cancelKnownAnswer).toHaveBeenCalledTimes(1));
  });
});
