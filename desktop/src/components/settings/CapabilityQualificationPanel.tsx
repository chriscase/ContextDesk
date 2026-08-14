/**
 * Explicit synthetic capability qualification control (#724).
 * User-triggered only — never starts probes on mount.
 */
import { useCallback, useEffect, useId, useState } from "react";
import type {
  CapabilityCheckDto,
  QualificationReportDto,
  QualificationSelectArgs,
} from "../../lib/host";
import {
  hostCancelCapabilityQualification,
  hostClearCapabilityQualification,
  hostGetCapabilityQualification,
  hostStartCapabilityQualification,
} from "../../lib/host";
import { classifyModelRole } from "../../lib/modelRoleHints";
import type { ModelReadinessUpdate } from "../../lib/modelReadiness";

export type CapabilityQualificationPanelProps = {
  baseId: string;
  profileId?: string | null;
  modelId: string;
  baseUrl: string;
  apiKeyDraft: string;
  /** When false, controls are disabled (no provider). */
  enabled: boolean;
  /** Update already-listed pickers without another provider or credential request. */
  onReadinessChanged?: ModelReadinessUpdate;
};

function statusClass(status: string): string {
  switch (status) {
    case "pass":
      return "cap-qual__status cap-qual__status--pass";
    case "degraded":
      return "cap-qual__status cap-qual__status--degraded";
    case "fail":
      return "cap-qual__status cap-qual__status--fail";
    default:
      return "cap-qual__status cap-qual__status--untested";
  }
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

export function CapabilityQualificationPanel({
  baseId,
  profileId,
  modelId,
  baseUrl,
  apiKeyDraft,
  enabled,
  onReadinessChanged,
}: CapabilityQualificationPanelProps) {
  const reactId = useId();
  const statusId = `${baseId}-cap-qual-status-${reactId}`;
  const [report, setReport] = useState<QualificationReportDto | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityArgs = useCallback((): QualificationSelectArgs => {
    return {
      profileId: profileId ?? null,
      modelId: modelId.trim() || null,
      baseUrl: baseUrl.trim() || null,
    };
  }, [profileId, modelId, baseUrl]);

  const liveArgs = useCallback((): QualificationSelectArgs => {
    return {
      ...identityArgs(),
      apiKey: apiKeyDraft.trim() || null,
    };
  }, [identityArgs, apiKeyDraft]);

  // Cache peek only — never starts probes (get is local store).
  useEffect(() => {
    if (!enabled || !modelId.trim()) {
      setReport(null);
      return;
    }
    let cancelled = false;
    void hostGetCapabilityQualification(identityArgs()).then((cached) => {
      if (!cancelled) setReport(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, modelId, baseUrl, profileId, identityArgs]);

  const onStart = async () => {
    if (!enabled || !modelId.trim() || running) return;
    setError(null);
    setRunning(true);
    try {
      const next = await hostStartCapabilityQualification(liveArgs());
      setReport(next);
      onReadinessChanged?.(next.profile_id, next.model_id, next.readiness);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const onCancel = async () => {
    await hostCancelCapabilityQualification();
  };

  const onClear = async () => {
    setError(null);
    try {
      await hostClearCapabilityQualification(identityArgs());
      if (report) {
        onReadinessChanged?.(report.profile_id, report.model_id, null);
      }
      setReport(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRetry = async () => {
    setError(null);
    try {
      await hostClearCapabilityQualification(identityArgs());
      if (report) {
        onReadinessChanged?.(report.profile_id, report.model_id, null);
      }
      setReport(null);
    } catch {
      /* continue to start */
    }
    if (!enabled || !modelId.trim() || running) return;
    setRunning(true);
    try {
      const next = await hostStartCapabilityQualification(liveArgs());
      setReport(next);
      onReadinessChanged?.(next.profile_id, next.model_id, next.readiness);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const canRun = enabled && modelId.trim().length > 0 && !running;
  const roleHint = modelId.trim() ? classifyModelRole(modelId.trim()) : null;

  return (
    <div className="cap-qual" data-testid="capability-qualification">
      <div className="field-row cap-qual__actions">
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="cap-qual-start"
          onClick={() => void onStart()}
          disabled={!canRun}
          aria-describedby={statusId}
        >
          {running ? "Qualifying…" : "Qualify selected model…"}
        </button>
        {running ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="cap-qual-cancel"
            onClick={() => void onCancel()}
          >
            Cancel
          </button>
        ) : null}
        {report && !running ? (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid="cap-qual-retry"
              onClick={() => void onRetry()}
              disabled={!enabled || !modelId.trim()}
            >
              Retry
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid="cap-qual-clear"
              onClick={() => void onClear()}
            >
              Clear
            </button>
          </>
        ) : null}
      </div>
      <p className="field__hint" id={statusId} role="status" aria-live="polite">
        {running
          ? "Running synthetic probes against the configured provider. No workspace, logs, or credentials are sent in probe text."
          : "Optional: measure contracts with synthetic, data-free probes. Name hints never produce a measured pass. Contacts the configured provider only when you click Qualify."}
      </p>
      {roleHint ? (
        <p className="field__hint" data-testid="cap-qual-basis">
          Basis: <strong>Name hint</strong> suggests probes for “
          {roleHint.suggestedFor}”. Measured results (below) use basis{" "}
          <strong>Measured locally</strong> only.
        </p>
      ) : null}
      {error ? (
        <p className="field__error" role="alert" data-testid="cap-qual-error">
          {error}
        </p>
      ) : null}
      {report ? (
        <div
          className="cap-qual__report"
          data-testid="cap-qual-report"
          data-stale={report.stale ? "true" : "false"}
          data-cancelled={report.cancelled ? "true" : "false"}
        >
          <p className="field__hint" data-testid="cap-qual-summary">
            <strong>{report.readiness.state}</strong> for {report.readiness.role}
            {" — "}
            {report.readiness.detail}
          </p>
          {report.stale ? (
            <p className="field__hint" role="status">
              Cached result is stale (profile, endpoint, model, or probe schema
              changed). Run Qualify again.
            </p>
          ) : null}
          {report.cancelled ? (
            <p className="field__hint" role="status">
              Run cancelled — remaining checks are untested.
            </p>
          ) : null}
          <ul className="cap-qual__list">
            {report.checks.map((c: CapabilityCheckDto) => (
              <li key={c.kind} className="cap-qual__item">
                <span className={statusClass(c.status)}>{c.status}</span>
                <span className="cap-qual__kind">{kindLabel(c.kind)}</span>
                <span className="cap-qual__meta">
                  {c.elapsed_ms}ms · {c.reason}
                  {c.request_mode ? ` · mode=${c.request_mode}` : ""}
                  {c.dialect ? ` · dialect=${c.dialect}` : ""}
                  {c.schema_strict != null
                    ? ` · strict=${c.schema_strict ? "true" : "false"}`
                    : ""}
                  {c.schema_probe_id ? ` · schema=${c.schema_probe_id}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="field__hint cap-qual__footer">
            schema {report.schema_version} · role_hint={report.role_hint} ·
            model={report.model_id}
          </p>
        </div>
      ) : null}
    </div>
  );
}
