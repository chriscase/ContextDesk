/**
 * Honest Investigation Team readiness summary.
 *
 * This is intentionally a settings/readiness surface, not an execution
 * control. It reads host-recorded role assignments and measured qualification
 * labels, then keeps configuration, measured readiness, and actual execution
 * visibly separate. A future host-produced qualification report can extend
 * this matrix without changing its honesty rules.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostGetInvestigationTeamQualification,
  hostGetMultiModelSettings,
  hostRunSyntheticInvestigationTeamQualification,
  type ContributionAssignmentDto,
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
  const [syntheticPhase, setSyntheticPhase] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [syntheticError, setSyntheticError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "absent" | "error">(
    "loading",
  );

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const [next, report] = await Promise.all([
        hostGetMultiModelSettings(),
        hostGetInvestigationTeamQualification(),
      ]);
      if (next) {
        setSettings(next);
        setQualification(report);
        setPhase("ready");
      } else {
        setSettings(null);
        setQualification(null);
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
      setSyntheticPhase("idle");
    } catch (error) {
      setQualification(null);
      setSyntheticPhase("error");
      setSyntheticError(
        error instanceof Error
          ? error.message
          : "The host could not run the synthetic check.",
      );
    }
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
            <strong>Host qualification report: {qualification.status}</strong>
            <p className="it-readiness__detail">
              {qualification.stale
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
          <p className="it-readiness__detail">
            Redacted JSON and Markdown are available from the host-owned result;
            evaluator truth and provider credentials are not exposed here.
          </p>
        </div>
      ) : (
        <p className="it-readiness__detail" data-testid="investigation-team-no-report">
          No host-produced team qualification report is attached yet. Configuration
          and capability checks below must not be mistaken for a full team run.
        </p>
      )}

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

      <div
        className="it-readiness__synthetic"
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

      <p className="mm-team__honesty">
        Exact pipeline identity, evidence binding, budgets, stale reports, and
        actual execution remain host checks at investigation time. This panel is
        a preflight aid, not a provider call or a guarantee of completion.
      </p>
    </section>
  );
}
