import {
  APP_ROLES,
  MODEL_PRIVATE_EVIDENCE_RULES,
  MODEL_PURPOSES,
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
  type ModelPurpose,
  type ModelPurposePolicyV1,
  type ModelPurposeRuleV1,
} from "@cd-collab/contracts/admin";
import { useEffect, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";

interface SafeSubject {
  id: string;
  label: string;
  provider: string;
  modelId?: string;
  alias?: string;
}

interface PolicyResponse {
  policy: ModelPurposePolicyV1;
  availableSubjects: SafeSubject[];
}

const PURPOSE_LABELS: Record<ModelPurpose, string> = {
  triage: "Triage",
  comparison: "Compare multiple models",
  summarization: "Investigation summaries",
  investigation_chat: "Investigation chat",
  redaction: "Redaction assistance",
};

const PURPOSE_HELP: Record<ModelPurpose, string> = {
  triage: "A model examines one frozen evidence set for the investigation question.",
  comparison: "Multiple approved lanes examine the same frozen evidence for differences.",
  summarization: "A short navigation or handoff summary. It never makes a decision.",
  investigation_chat: "An AI participant in a private or shared investigation conversation.",
  redaction: "Optional assistance while preparing a share-safe export. Privacy gates remain authoritative.",
};

function cloneRule(rule: ModelPurposeRuleV1): ModelPurposeRuleV1 {
  return {
    enabled: rule.enabled,
    allowedSubjects: [...rule.allowedSubjects],
    allowedRoles: [...rule.allowedRoles],
    maxLanes: rule.maxLanes,
    privateEvidence: rule.privateEvidence,
  };
}

export function AdminModelPolicyPanel() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [purposes, setPurposes] = useState<ModelPurposePolicyV1["purposes"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void protectedApiFetch("/api/admin/model-policy")
      .then(async (response) => {
        if (!response.ok) throw new Error("Model-use policy could not be loaded.");
        const body = await response.json() as PolicyResponse;
        if (!alive) return;
        setData(body);
        setPurposes(Object.fromEntries(
          MODEL_PURPOSES.map((purpose) => [purpose, cloneRule(body.policy.purposes[purpose])]),
        ) as ModelPurposePolicyV1["purposes"]);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Model-use policy could not be loaded.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  function updateRule(purpose: ModelPurpose, patch: Partial<ModelPurposeRuleV1>) {
    setPurposes((current) => current ? {
      ...current,
      [purpose]: { ...current[purpose], ...patch },
    } : current);
  }

  async function save() {
    if (!purposes) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await protectedApiFetch("/api/admin/model-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID, purposes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "The model-use policy was not saved.");
      }
      const body = await response.json() as { policy: ModelPurposePolicyV1 };
      setData((current) => current ? { ...current, policy: body.policy } : current);
      setStatus(`Model-use policy saved as revision ${body.policy.revision}. New runs use it immediately.`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The model-use policy was not saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p role="status">Loading model-use policy…</p>;
  if (!data || !purposes) return <p role="alert">{error || "Model-use policy is unavailable."}</p>;

  return (
    <section className="administration__panel" aria-labelledby="model-policy-title">
      <div className="administration__panel-heading">
        <div>
          <h3 id="model-policy-title">Which models may do which work?</h3>
          <p>
            These rules apply to every new run. The host still owns gateway credentials and must
            approve any private-data egress.
          </p>
        </div>
        <span className="administration__limit">Revision {data.policy.revision}</span>
      </div>
      {error ? <p className="administration__message administration__message--error" role="alert">{error}</p> : null}
      {status ? <p className="administration__message" role="status">{status}</p> : null}
      <div className="administration__policy-list">
        {MODEL_PURPOSES.map((purpose) => {
          const rule = purposes[purpose];
          return (
            <fieldset className="administration__panel" key={purpose}>
              <legend>{PURPOSE_LABELS[purpose]}</legend>
              <p>{PURPOSE_HELP[purpose]}</p>
              <label>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => updateRule(purpose, { enabled: event.target.checked })}
                />
                Allow this purpose
              </label>
              <fieldset>
                <legend>Approved models</legend>
                {data.availableSubjects.length === 0 ? <p>No host models are configured.</p> : data.availableSubjects.map((subject) => (
                  <label key={subject.id}>
                    <input
                      type="checkbox"
                      checked={rule.allowedSubjects.includes(subject.id)}
                      onChange={(event) => updateRule(purpose, {
                        allowedSubjects: event.target.checked
                          ? [...rule.allowedSubjects, subject.id]
                          : rule.allowedSubjects.filter((id) => id !== subject.id),
                      })}
                    />
                    {subject.label} {subject.modelId ? `· ${subject.modelId}` : ""}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Allowed roles</legend>
                {APP_ROLES.map((role) => (
                  <label key={role}>
                    <input
                      type="checkbox"
                      checked={rule.allowedRoles.includes(role)}
                      onChange={(event) => updateRule(purpose, {
                        allowedRoles: event.target.checked
                          ? [...rule.allowedRoles, role]
                          : rule.allowedRoles.filter((item) => item !== role),
                      })}
                    />
                    {role === "case-lead" ? "Case lead" : `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`}
                  </label>
                ))}
              </fieldset>
              <label>
                Maximum model lanes
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={rule.maxLanes}
                  onChange={(event) => updateRule(purpose, { maxLanes: Math.max(1, Math.min(16, Number(event.target.value) || 1)) })}
                />
              </label>
              <label>
                Private evidence
                <select
                  value={rule.privateEvidence}
                  onChange={(event) => updateRule(purpose, { privateEvidence: event.target.value as ModelPurposeRuleV1["privateEvidence"] })}
                >
                  {MODEL_PRIVATE_EVIDENCE_RULES.map((value) => (
                    <option key={value} value={value}>
                      {value === "never" ? "Never allow" : "Allow only when the trusted host approves"}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          );
        })}
      </div>
      <button type="button" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Review and save model-use policy"}
      </button>
    </section>
  );
}
