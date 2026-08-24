/**
 * Honest Investigation Team readiness summary.
 *
 * This is a settings/readiness surface with explicit, user-triggered checks.
 * It reads host-recorded role assignments and measured qualification labels,
 * then keeps configuration, measured readiness, and actual execution visibly
 * separate. No check runs on mount.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostGetInvestigationTeamQualification,
  hostListInvestigationTeamKnownAnswerQualifications,
  hostListInvestigationTeamQualifications,
  hostGetMultiModelSettings,
  hostCancelLiveInvestigationTeamKnownAnswerQualification,
  hostCancelLiveInvestigationTeamQualification,
  hostRunLiveInvestigationTeamKnownAnswerQualification,
  hostRunLiveInvestigationTeamQualification,
  hostRunSyntheticInvestigationTeamQualification,
  type ContributionAssignmentDto,
  type InvestigationTeamKnownAnswerDto,
  type InvestigationTeamQualificationDto,
  type MultiModelSettingsDto,
  type ReviewerCandidateDto,
} from "../../lib/host";
import "./InvestigationTeamReadinessPanel.css";

type RoleState = "configured" | "qualified" | "unqualified" | "unverified";

type RoleRow = {
  id: string;
  label: string;
  purpose: string;
  profileId: string | null;
  model: string | null;
  state: RoleState;
  detail: string;
};

function qualificationState(value: string | null | undefined): RoleState {
  if (value === "qualified") return "qualified";
  if (value === "unqualified") return "unqualified";
  return "unverified";
}

function stateLabel(state: RoleState): string {
  switch (state) {
    case "configured":
      return "Configured";
    case "qualified":
      return "Measured qualified";
    case "unqualified":
      return "Measured — did not qualify";
    default:
      return "Not measured yet";
  }
}

function failureReasonLabel(reason: string): string {
  switch (reason) {
    case "provider_attempt_cancelled":
      return "The provider attempt was cancelled.";
    case "provider_request_failed":
      return "The provider request failed.";
    case "unknown_evidence_citation":
      return "The response cited evidence outside the qualification packet.";
    case "response_contract_failed":
      return "The response did not match the required qualification format.";
    case "cancelled_before_dispatch":
      return "The attempt was cancelled before it was sent.";
    default:
      return "The role did not complete its qualification attempt.";
  }
}

function knownAnswerFailureLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "provider_attempt_cancelled":
    case "cancelled_before_dispatch":
      return "cancelled";
    case "provider_request_failed":
      return "provider request failed";
    case "provider_response_parse_failed":
      return "provider response did not match the strict schema";
    case "provider_response_privacy_rejected":
      return "provider response failed the privacy gate";
    case "provider_response_vocabulary_rejected":
      return "provider response used unsupported vocabulary";
    case "host_score_failed":
      return "ContextDesk could not score the parsed response";
    case "host_diagnostic_pipeline_unavailable":
      return "required host diagnostic execution is not available";
    default:
      return reason ? "did not produce a usable score" : "";
  }
}

function knownMetric(value: number | null | undefined, suffix = ""): string {
  return value == null ? "unknown" : `${value}${suffix}`;
}

function staleReasonLabel(reason: string): string {
  switch (reason) {
    case "build_changed":
      return "app build changed";
    case "suite_changed":
      return "known-answer suite changed";
    case "prompt_set_changed":
      return "provider prompt set changed";
    case "pipeline_changed":
      return "configured role or deployment changed";
    default:
      return "qualification identity changed";
  }
}

function findCandidate(
  settings: MultiModelSettingsDto,
  profileId: string | null,
): ReviewerCandidateDto | null {
  return profileId
    ? settings.candidate_profiles.find((candidate) => candidate.id === profileId) ??
        null
    : null;
}

function reviewerRow(settings: MultiModelSettingsDto): RoleRow {
  const profileId = settings.reviewer_profile_id?.trim() || null;
  const candidate = findCandidate(settings, profileId);
  if (!profileId) {
    return {
      id: "reviewer",
      label: "Reviewer",
      purpose: "Challenges the primary investigation before reconciliation.",
      profileId: null,
      model: null,
      state: "unverified",
      detail: "No reviewer profile is assigned.",
    };
  }

  const state = qualificationState(settings.reviewer_qualification);
  const egress = candidate && !candidate.local_only && !settings.reviewer_allow_remote
    ? " Remote evidence egress is not acknowledged."
    : "";
  return {
    id: "reviewer",
    label: "Reviewer",
    purpose: "Challenges the primary investigation before reconciliation.",
    profileId,
    model: settings.reviewer_model?.trim() || candidate?.chat_model || null,
    state,
    detail: `${stateLabel(state)}.${egress}`,
  };
}

function contributionRow(
  assignment: ContributionAssignmentDto,
  settings: MultiModelSettingsDto,
  index: number,
): RoleRow {
  const candidate = findCandidate(settings, assignment.profile_id);
  const state = qualificationState(assignment.qualification);
  const egress = candidate && !candidate.local_only && !assignment.allow_remote
    ? " Remote evidence egress is not acknowledged."
    : "";
  return {
    id: `${assignment.role}-${index}`,
    label: assignment.role.replace(/_/g, " "),
    purpose: "Configured contribution role; the host re-checks it at run time.",
    profileId: assignment.profile_id,
    model: assignment.model?.trim() || candidate?.chat_model || null,
    state,
    detail: `${stateLabel(state)}.${egress}`,
  };
}

function rowsFor(settings: MultiModelSettingsDto): RoleRow[] {
  const rows: RoleRow[] = [];
  if (settings.active_profile_id?.trim()) {
    const profileId = settings.active_profile_id.trim();
    const candidate = findCandidate(settings, profileId);
    rows.push({
      id: "investigator",
      label: "Investigator",
      purpose: "Builds the first host-validated investigation answer.",
      profileId,
      model: candidate?.chat_model ?? null,
      state: "configured",
      detail: "Configured; team qualification evidence is not attached here.",
    });
  }
  if (settings.mode === "review") rows.push(reviewerRow(settings));
  if (settings.mode === "contributions") {
    settings.contribution_assignments.forEach((assignment, index) => {
      rows.push(contributionRow(assignment, settings, index));
    });
  }
  return rows;
}

function summaryFor(settings: MultiModelSettingsDto, rows: RoleRow[]): {
  tone: "ok" | "warn" | "neutral";
  title: string;
  detail: string;
} {
  if (settings.mode === "single") {
    return {
      tone: "neutral",
      title: "Standard route selected",
      detail:
        "One model is configured. Investigation Team qualification is not required for this route.",
    };
  }
  const additionalRows = rows.filter((row) => row.id !== "investigator");
  if (
    additionalRows.length === 0 ||
    additionalRows.some(
      (row) =>
        row.state !== "qualified" ||
        row.detail.includes("egress is not acknowledged"),
    )
  ) {
    return {
      tone: "warn",
      title: "Team route will degrade or wait",
      detail:
        "Every additional role must be configured and measured qualified before it can participate. The host records any degradation.",
    };
  }
  return {
    tone: "ok",
    title: "Configured roles are measured qualified",
    detail:
      "This is readiness evidence, not proof that a future investigation will execute every role.",
  };
}

export function InvestigationTeamReadinessPanel() {
  const [settings, setSettings] = useState<MultiModelSettingsDto | null>(null);
  const [qualification, setQualification] =
    useState<InvestigationTeamQualificationDto | null>(null);
  const [history, setHistory] = useState<InvestigationTeamQualificationDto[]>([]);
  const [knownAnswerHistory, setKnownAnswerHistory] = useState<
    InvestigationTeamKnownAnswerDto[]
  >([]);
  const [syntheticPhase, setSyntheticPhase] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [syntheticError, setSyntheticError] = useState<string | null>(null);
  const [livePhase, setLivePhase] = useState<"idle" | "running" | "error">("idle");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [qualityPhase, setQualityPhase] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [qualityHistoryAvailable, setQualityHistoryAvailable] = useState(true);
  const [phase, setPhase] = useState<"loading" | "ready" | "absent" | "error">(
    "loading",
  );

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const [next, report, reports] = await Promise.all([
        hostGetMultiModelSettings(),
        hostGetInvestigationTeamQualification(),
        hostListInvestigationTeamQualifications(),
      ]);
      let knownAnswerReports: InvestigationTeamKnownAnswerDto[] = [];
      try {
        knownAnswerReports = await hostListInvestigationTeamKnownAnswerQualifications();
        setQualityHistoryAvailable(true);
        setQualityError(null);
      } catch (error) {
        setQualityHistoryAvailable(false);
        setQualityError(
          error instanceof Error
            ? error.message
            : "Existing known-answer evidence is unavailable. Repair or remove the owner store, then retry the secure read without restarting ContextDesk.",
        );
      }
      if (next) {
        setSettings(next);
        setQualification(report);
        setHistory(reports);
        setKnownAnswerHistory(knownAnswerReports);
        setPhase("ready");
      } else {
        setSettings(null);
        setQualification(null);
        setHistory([]);
        setKnownAnswerHistory([]);
        setPhase("absent");
      }
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSynthetic = async () => {
    setSyntheticPhase("running");
    setSyntheticError(null);
    try {
      const report = await hostRunSyntheticInvestigationTeamQualification();
      setQualification(report);
      setHistory((current) => [report, ...current.filter(
        (entry) => entry.fingerprint_digest !== report.fingerprint_digest ||
          entry.scoring_digest !== report.scoring_digest ||
          entry.run_kind !== report.run_kind,
      )]);
      setSyntheticPhase("idle");
    } catch (error) {
      setSyntheticPhase("error");
      setSyntheticError(
        error instanceof Error
          ? error.message
          : "The host could not run the synthetic check.",
      );
    }
  };

  const runLive = async () => {
    setLivePhase("running");
    setLiveError(null);
    try {
      const report = await hostRunLiveInvestigationTeamQualification();
      setQualification(report);
      setHistory((current) => [report, ...current.filter(
        (entry) => entry.fingerprint_digest !== report.fingerprint_digest ||
          entry.scoring_digest !== report.scoring_digest ||
          entry.run_kind !== report.run_kind,
      )]);
      setLivePhase("idle");
    } catch (error) {
      setLivePhase("error");
      setLiveError(
        error instanceof Error
          ? error.message
          : "The host could not complete measured qualification.",
      );
    }
  };

  const cancelLive = async () => {
    await hostCancelLiveInvestigationTeamQualification();
  };

  const runKnownAnswer = async () => {
    setQualityPhase("running");
    setQualityError(null);
    try {
      const reports = await hostRunLiveInvestigationTeamKnownAnswerQualification();
      setKnownAnswerHistory(reports);
      setQualityPhase("idle");
    } catch (error) {
      setQualityPhase("error");
      setQualityError(
        error instanceof Error
          ? error.message
          : "The host could not complete known-answer qualification.",
      );
    }
  };

  const cancelKnownAnswer = async () => {
    await hostCancelLiveInvestigationTeamKnownAnswerQualification();
  };

  if (phase === "absent") return null;
  if (phase === "loading") {
    return (
      <p className="field__hint" role="status" data-testid="investigation-team-readiness-loading">
        Reading host-recorded Investigation Team readiness…
      </p>
    );
  }
  if (phase === "error" || !settings) {
    return (
      <div className="mm-team__readiness" data-testid="investigation-team-readiness-error">
        <p className="field__error" role="alert">
          Couldn’t read the host-recorded Investigation Team readiness.
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  const rows = rowsFor(settings);
  const summary = summaryFor(settings, rows);
  const failures = qualification?.failures ?? [];
  return (
    <section
      className="mm-team__readiness it-readiness"
      data-testid="investigation-team-readiness"
      aria-labelledby="investigation-team-readiness-title"
    >
      <div className="it-readiness__title-row">
        <div>
          <h4 className="mm-team__readiness-title" id="investigation-team-readiness-title">
            Investigation Team readiness
          </h4>
          <p className="field__hint">
            A role matrix from host-owned settings and measured evidence. It never
            claims that a configured role actually ran.
          </p>
        </div>
        <span className="mm-team__qual" data-state={summary.tone}>
          {settings.mode === "single" ? "Standard" : settings.mode}
        </span>
      </div>

      <p className="mm-team__gate" data-tone={summary.tone}>
        <strong>{summary.title}.</strong> {summary.detail}
      </p>

      {qualification ? (
        <div
          className="it-readiness__report"
          data-testid="investigation-team-qualification-report"
          data-status={qualification.status}
        >
          <div>
            <strong>
              {qualification.run_kind === "measured"
                ? "Measured team qualification"
                : "Provider-free host wiring check"}: {qualification.status}
            </strong>
            <p className="it-readiness__detail">
              {qualification.run_kind !== "measured"
                ? "This proves host wiring and redaction only; it is not model or pipeline performance evidence."
                : qualification.stale
                ? "Stale evidence — do not use it for a new run."
                : qualification.incomplete_attempts
                  ? "Incomplete attempts remain; this is not a clean qualification."
                  : "The host validated this report and bound it to the fingerprint below."}
            </p>
          </div>
          <dl className="it-readiness__report-facts">
            <div>
              <dt>Pipeline fingerprint</dt>
              <dd><code>{qualification.fingerprint_digest}</code></dd>
            </div>
            <div>
              <dt>Axes</dt>
              <dd>
                {(["capability", "quality", "speed", "resource"] as const)
                  .map((axis) => `${axis}=${qualification[axis].contract_met ? "pass" : "fail"}`)
                  .join(" · ")}
              </dd>
            </div>
          </dl>
          <div
            className="it-readiness__axes"
            data-testid="investigation-team-qualification-axes"
          >
            {(["capability", "quality", "speed", "resource"] as const).map((axis) => {
              const value = qualification[axis];
              const metrics = Object.entries(value.metrics);
              return (
                <article className="it-readiness__axis" key={axis}>
                  <div className="it-readiness__axis-title">
                    <strong>{axis}</strong>
                    <span data-state={value.contract_met ? "pass" : "fail"}>
                      {value.contract_met ? "Pass" : "Needs attention"}
                    </span>
                  </div>
                  {metrics.length > 0 ? (
                    <ul className="it-readiness__metrics">
                      {metrics.map(([key, metric]) => (
                        <li key={key}>
                          <code>{key}</code> {metric}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {value.notes.length > 0 ? (
                    <ul className="it-readiness__notes">
                      {value.notes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                  ) : null}
                </article>
              );
            })}
          </div>
          <div
            className="it-readiness__members"
            data-testid="investigation-team-qualification-members"
          >
            <strong>Executed pipeline identity</strong>
            <p className="it-readiness__detail">
              These role, profile, model, subject, and deployment identities came
              from this host-produced report—not from the current settings snapshot.
            </p>
            {(qualification.members ?? []).length > 0 ? (
              <ul>
                {(qualification.members ?? []).map((member) => (
                  <li key={member.role + ":" + member.profile_id + ":" + member.model_id}>
                    <strong>{member.role}</strong>
                    <code>{member.profile_id}</code>
                    <code>{member.model_id}</code>
                    <small>
                      subject <code>{member.subject_storage_id}</code> · deployment{" "}
                      <code>{member.endpoint_fingerprint}</code>
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="it-readiness__detail">No member identities were recorded.</p>
            )}
          </div>
          <p className="it-readiness__detail">
            Redacted JSON and Markdown are available from the host-owned result;
            evaluator truth and provider credentials are not exposed here.
          </p>
          <div className="it-readiness__exports" data-testid="investigation-team-redacted-exports">
            <details>
              <summary>View redacted JSON</summary>
              <pre data-testid="investigation-team-redacted-json">{qualification.redacted_json}</pre>
            </details>
            <details>
              <summary>View redacted Markdown</summary>
              <pre data-testid="investigation-team-redacted-markdown">{qualification.redacted_markdown}</pre>
            </details>
          </div>
          {failures.length > 0 ? (
            <div
              className="it-readiness__failures"
              data-testid="investigation-team-qualification-failures"
            >
              <strong>Role attempts needing attention</strong>
              <ul>
                {failures.map((failure) => (
                  <li key={failure.attempt_id}>
                    <code>{failure.role}</code>: {failureReasonLabel(failure.reason)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="it-readiness__detail" data-testid="investigation-team-no-report">
          No host-produced team qualification report is attached yet. Configuration
          and capability checks below must not be mistaken for a full team run.
        </p>
      )}

      {history.length > 0 ? (
        <div
          className="it-readiness__history"
          data-testid="investigation-team-qualification-history"
        >
          <strong>Qualification history</strong>
          <p className="it-readiness__detail">
            Each entry is bound to its exact suite and pipeline fingerprint.
            Provider-free checks are kept visibly separate from measured runs.
          </p>
          <ul>
            {history.map((entry) => (
              <li key={`${entry.run_kind}:${entry.fingerprint_digest}:${entry.scoring_digest}`}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-pressed={
                    qualification?.fingerprint_digest === entry.fingerprint_digest &&
                    qualification?.scoring_digest === entry.scoring_digest &&
                    qualification?.run_kind === entry.run_kind
                  }
                  onClick={() => setQualification(entry)}
                >
                  {entry.run_kind === "measured" ? "Measured" : "Wiring check"}
                  {" · "}{entry.status}{" · "}
                  {new Date(entry.observed_at * 1000).toLocaleString()}
                  {" · "}{entry.fingerprint_digest.slice(0, 12)}…
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="it-readiness__table" role="list" aria-label="Investigation Team roles">
          {rows.map((row) => (
            <article className="it-readiness__row" role="listitem" key={row.id}>
              <div>
                <strong>{row.label}</strong>
                <p className="it-readiness__purpose">{row.purpose}</p>
              </div>
              <div className="it-readiness__facts">
                <span className="mm-team__qual" data-state={row.state}>
                  {stateLabel(row.state)}
                </span>
                <code>{row.model ?? "model not recorded"}</code>
                <small className="it-readiness__detail">{row.detail}</small>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="mm-team__readiness-empty">
          No additional roles are configured. Choose Reviewer or Contributions
          above when you want a bounded multi-model route.
        </p>
      )}

      <section
        className="it-readiness__quality"
        data-testid="investigation-team-known-answer-quality"
        aria-busy={qualityPhase === "running"}
        aria-labelledby="investigation-team-known-answer-title"
      >
        <div className="it-readiness__quality-title">
          <div>
            <h5 id="investigation-team-known-answer-title">
              Known-answer quality evidence
            </h5>
            <p className="it-readiness__detail">
              Assesses 14 frozen, opaque triage scenarios for each exact configured
              role. The trusted host dispatches only work it can execute and observe
              honestly; scenarios requiring unavailable attempt, tool, or role
              telemetry remain visibly blocked. Evaluator truth stays separate,
              strict citations and causal claims are scored deterministically, and
              redacted reports plus separate private canonical responses are stored
              only where the host can guarantee the complete secure persistence
              contract.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-testid="investigation-team-run-known-answer"
            onClick={() => void runKnownAnswer()}
            disabled={qualityPhase === "running" || !qualityHistoryAvailable}
          >
            {qualityPhase === "running"
              ? "Assessing quality suite…"
              : !qualityHistoryAvailable
                ? "Evidence store unavailable"
              : "Assess 14-scenario suite"}
          </button>
        </div>
        {qualityPhase === "running" ? (
          <div className="it-readiness__quality-progress" role="status">
            <span>
              Provider calls and supported host diagnostic work run serially for
              each configured role.
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void cancelKnownAnswer()}
            >
              Cancel after active call
            </button>
          </div>
        ) : null}
        {qualityError ? (
          <div>
            <p
              className="field__error"
              role="alert"
              data-testid="investigation-team-known-answer-error"
            >
              {qualityError}
              {!qualityHistoryAvailable
                ? " Repair or remove the owner store, then retry this secure read. ContextDesk reloads it in-process and will not call a provider unless that reload succeeds."
                : ""}
            </p>
            {!qualityHistoryAvailable ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void load()}
              >
                Retry secure evidence store read
              </button>
            ) : null}
          </div>
        ) : null}
        <p className="it-readiness__detail">
          This complements the small wiring check above. It measures deterministic
          answer quality, latency, synthetic message-content bytes, and returned
          provider-content bytes for the recorded
          build, profile, model, endpoint fingerprint, suite, and prompt set.
          Tokens and cost remain “unknown” unless the transport can report them;
          provider-reported usage and cost are not audited billing records, and
          no report is a universal model recommendation. Scenarios that need
          unavailable host attempt, tool, or role telemetry are shown as blocked
          rather than counted as model failures.
          Canonical responses stay in a private owner-only host
          store beneath a stable owner-only parent directory and are deleted together with their redacted history; they are
          not included in these share-safe redacted exports. On hosts that cannot
          guarantee stable no-follow identity, owner-only capture retention, and
          atomic replacement, this entire persisted quality feature fails closed
          before any provider call. If an invalid store is repaired or removed,
          retrying the secure read reloads it without restarting the app.
        </p>

        {knownAnswerHistory.length > 0 ? (
          <div className="it-readiness__quality-history">
            {knownAnswerHistory.map((report, index) => (
              <details
                key={`${report.role}:${report.observed_at}:${report.subject_storage_id}`}
                open={index === 0}
                className="it-readiness__quality-report"
                data-status={report.status}
              >
                <summary>
                  <span>
                    <strong>{report.role}</strong> · <code>{report.model_id}</code>
                  </span>
                  <span className="mm-team__qual" data-state={report.status}>
                    {report.stale
                      ? `stale · recorded ${report.reported_status}`
                      : report.status}
                  </span>
                  <time dateTime={new Date(report.observed_at * 1000).toISOString()}>
                    {new Date(report.observed_at * 1000).toLocaleString()}
                  </time>
                </summary>
                {report.stale ? (
                  <p className="it-readiness__quality-warning" role="note">
                    Stale for the current pipeline: {report.stale_reasons
                      .map(staleReasonLabel)
                      .join(", ")}.
                  </p>
                ) : null}
                <dl className="it-readiness__quality-metrics">
                  <div>
                    <dt>Quality</dt>
                    <dd>
                      {report.metrics.passed_scenarios}/
                      {report.metrics.required_scenarios} scenarios passed
                    </dd>
                  </div>
                  <div>
                    <dt>Lifecycle</dt>
                    <dd>
                      {report.metrics.executed_scenarios} executed · {report.metrics.failed_scenarios} failed · {report.metrics.cancelled_scenarios} cancelled · {report.metrics.blocked_scenarios} blocked
                    </dd>
                  </div>
                  <div>
                    <dt>Speed</dt>
                    <dd>{report.metrics.total_latency_ms} ms total host-observed latency</dd>
                  </div>
                  <div>
                    <dt>Resource proxy</dt>
                    <dd>
                      {report.metrics.total_message_content_bytes} message-content bytes · {report.metrics.total_provider_content_bytes} provider-content bytes · tokens: {knownMetric(report.metrics.input_tokens)} input / {knownMetric(report.metrics.output_tokens)} output / {knownMetric(report.metrics.reasoning_tokens)} reasoning / {knownMetric(report.metrics.cached_tokens)} cached · cost: {knownMetric(report.metrics.cost_microusd, " μUSD")}
                    </dd>
                  </div>
                </dl>
                <dl className="it-readiness__quality-identity">
                  <div><dt>Build</dt><dd><code>{report.build_identity}</code></dd></div>
                  <div><dt>Profile / model</dt><dd><code>{report.profile_id}</code> / <code>{report.model_id}</code></dd></div>
                  <div><dt>Endpoint</dt><dd><code>{report.endpoint_fingerprint}</code></dd></div>
                  <div><dt>Suite</dt><dd><code>{report.suite_id}</code> / <code>{report.suite_digest}</code></dd></div>
                  <div><dt>Prompt set</dt><dd><code>{report.prompt_set_hash}</code></dd></div>
                </dl>
                <details className="it-readiness__quality-scenarios">
                  <summary>Inspect 14 scenario outcomes</summary>
                  <ol>
                    {report.scenarios.map((scenario) => (
                      <li key={scenario.scenario_id} data-status={scenario.status}>
                        <code>{scenario.scenario_id}</code>
                        <span>{scenario.passed ? "passed" : scenario.status}</span>
                        <small>{scenario.latency_ms} ms</small>
                        {scenario.reported_model_id ? (
                          <small>
                            provider reported <code>{scenario.reported_model_id}</code>
                            {scenario.reported_model_id !== report.model_id
                              ? " (differs from configured model)"
                              : ""}
                          </small>
                        ) : (
                          <small>provider-reported model unknown</small>
                        )}
                        {scenario.failure_code ? (
                          <small>{knownAnswerFailureLabel(scenario.failure_code)}</small>
                        ) : null}
                        {scenario.failed_dimensions.length > 0 ? (
                          <small>
                            failed: {scenario.failed_dimensions.join(", ")}
                          </small>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </details>
                <div className="it-readiness__exports">
                  <details>
                    <summary>View redacted quality JSON</summary>
                    <pre>{report.redacted_json}</pre>
                  </details>
                  <details>
                    <summary>View redacted quality Markdown</summary>
                    <pre>{report.redacted_markdown}</pre>
                  </details>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p
            className="it-readiness__detail"
            data-testid="investigation-team-known-answer-empty"
          >
            No provider-backed known-answer evidence has been recorded yet.
          </p>
        )}
      </section>

      <div
        className="it-readiness__check"
        aria-busy={syntheticPhase === "running"}
      >
        <div>
          <strong>Local contract check</strong>
          <p className="it-readiness__detail">
            Runs an opaque, provider-free fixture through the trusted host. It verifies
            wiring and redaction only; it does not qualify a real model.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          data-testid="investigation-team-run-synthetic"
          onClick={() => void runSynthetic()}
          disabled={syntheticPhase === "running"}
        >
          {syntheticPhase === "running" ? "Running local check…" : "Run local check"}
        </button>
        {syntheticPhase === "running" ? (
          <span className="it-readiness__detail" role="status">
            No provider call is being made.
          </span>
        ) : null}
        {syntheticError ? (
          <p
            className="field__error"
            role="alert"
            data-testid="investigation-team-synthetic-error"
          >
            {syntheticError}
          </p>
        ) : null}
      </div>

      <div className="it-readiness__check" aria-busy={livePhase === "running"}>
        <div>
          <strong>Measured provider check</strong>
          <p className="it-readiness__detail">
            Sends one bounded opaque fixture per configured V1 role. It records
            exact model identity, latency, resource proxy, and any failed or
            incomplete attempt; it never uses workspace evidence.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          data-testid="investigation-team-run-live"
          onClick={() => void runLive()}
          disabled={livePhase === "running"}
        >
          {livePhase === "running" ? "Running measured check…" : "Run measured check"}
        </button>
        {livePhase === "running" ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void cancelLive()}
          >
            Cancel check
          </button>
        ) : null}
        {livePhase === "running" ? (
          <span className="it-readiness__detail" role="status">
            Provider calls are limited to the configured role set.
          </span>
        ) : null}
        {liveError ? (
          <p className="field__error" role="alert" data-testid="investigation-team-live-error">
            {liveError}
          </p>
        ) : null}
      </div>

      <p className="mm-team__honesty">
        Exact pipeline identity, evidence binding, budgets, stale reports, and
        actual execution remain host checks at investigation time. This panel is
        a preflight aid, not a provider call or a guarantee of completion.
      </p>
    </section>
  );
}
