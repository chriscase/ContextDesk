import {
  APP_ROLES,
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  parseUiStrategyPolicy,
  type AppRole,
  type UiStrategyGovernancePolicyV1,
  type UiStrategyId,
  type UiStrategyRoleRuleV1,
} from "@cd-collab/contracts/admin";
import { useCallback, useEffect, useRef, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";
import { UI_STRATEGIES } from "./ui-strategy.js";
import { UI_STRATEGY_POLICY_CHANGED_EVENT } from "./useUiStrategyGovernance.js";

const ROLE_LABELS: Record<AppRole, string> = {
  viewer: "Viewer",
  contributor: "Contributor",
  "case-lead": "Case lead",
  admin: "Administrator",
};

function copyPolicy(policy: UiStrategyGovernancePolicyV1): UiStrategyGovernancePolicyV1 {
  return structuredClone(policy);
}

function sorted(ids: readonly UiStrategyId[]): UiStrategyId[] {
  return UI_STRATEGIES.flatMap(({ id }) => ids.includes(id) ? [id] : []);
}

function ruleFor(
  rules: readonly UiStrategyRoleRuleV1[],
  role: AppRole,
  inheritedApprovedIds: readonly UiStrategyId[],
): UiStrategyRoleRuleV1 {
  return rules.find((candidate) => candidate.role === role) ?? {
    role,
    approvedIds: [...inheritedApprovedIds],
    defaultId: null,
  };
}

function normalizeRoleRules(
  rules: readonly UiStrategyRoleRuleV1[],
  instance: UiStrategyGovernancePolicyV1["instance"],
): UiStrategyRoleRuleV1[] {
  return rules.map((rule) => ({
    ...rule,
    approvedIds: sorted(rule.approvedIds.filter((id) => instance.visibleIds.includes(id))),
    defaultId: rule.defaultId && instance.enabledIds.includes(rule.defaultId) ? rule.defaultId : null,
  }));
}

export function AdminUiStrategyPanel() {
  const [saved, setSaved] = useState<UiStrategyGovernancePolicyV1 | null>(null);
  const [draft, setDraft] = useState<UiStrategyGovernancePolicyV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const dirty = Boolean(saved && draft && JSON.stringify({ instance: saved.instance, roleRules: saved.roleRules }) !== JSON.stringify({ instance: draft.instance, roleRules: draft.roleRules }));

  const refresh = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setFailure("");
    try {
      const response = await protectedApiFetch("/api/admin/ui-strategies", { signal: controller.signal });
      if (!response.ok) throw new Error("request failed");
      const policy = parseUiStrategyPolicy(await response.json());
      if (controller.signal.aborted || loadRequestRef.current !== requestId) return;
      setSaved(policy);
      setDraft(copyPolicy(policy));
    } catch {
      if (controller.signal.aborted || loadRequestRef.current !== requestId) return;
      setSaved(null);
      setDraft(null);
      setFailure("Strategy rollout settings could not be validated. No policy is shown.");
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false);
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      loadRequestRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, [refresh]);

  function updateInstance(
    update: (instance: UiStrategyGovernancePolicyV1["instance"]) => UiStrategyGovernancePolicyV1["instance"],
  ) {
    setDraft((current) => {
      if (!current) return current;
      const instance = update(current.instance);
      return { ...current, instance, roleRules: normalizeRoleRules(current.roleRules, instance) };
    });
    setMessage("");
  }

  function toggleEnabled(id: UiStrategyId, enabled: boolean) {
    if (id === "war-room" && !enabled) return;
    updateInstance((instance) => {
      const enabledIds = sorted(enabled
        ? [...instance.enabledIds, id]
        : instance.enabledIds.filter((candidate) => candidate !== id));
      const visibleIds = instance.visibleIds.filter((candidate) => enabledIds.includes(candidate));
      const approvedIds = instance.approvedIds.filter((candidate) => visibleIds.includes(candidate));
      const defaultId = enabledIds.includes(instance.defaultId) ? instance.defaultId : "war-room";
      return {
        ...instance,
        enabledIds,
        visibleIds,
        approvedIds: instance.selectionMode === "free" ? [...visibleIds] : approvedIds,
        defaultId,
      };
    });
  }

  function toggleVisible(id: UiStrategyId, visible: boolean) {
    updateInstance((instance) => {
      const visibleIds = sorted(visible
        ? [...instance.visibleIds, id]
        : instance.visibleIds.filter((candidate) => candidate !== id));
      const approvedIds = instance.approvedIds.filter((candidate) => visibleIds.includes(candidate));
      return {
        ...instance,
        visibleIds,
        approvedIds: instance.selectionMode === "free" ? [...visibleIds] : approvedIds,
      };
    });
  }

  function toggleInstanceApproved(id: UiStrategyId, approved: boolean) {
    updateInstance((instance) => ({
      ...instance,
      approvedIds: sorted(approved
        ? [...instance.approvedIds, id]
        : instance.approvedIds.filter((candidate) => candidate !== id)),
    }));
  }

  function updateRole(role: AppRole, update: (rule: UiStrategyRoleRuleV1) => UiStrategyRoleRuleV1) {
    setDraft((current) => {
      if (!current) return current;
      const next = update(ruleFor(current.roleRules, role, current.instance.approvedIds));
      return {
        ...current,
        roleRules: APP_ROLES.flatMap((candidate) => candidate === role
          ? [next]
          : current.roleRules.filter((rule) => rule.role === candidate)),
      };
    });
    setMessage("");
  }

  async function save() {
    if (!draft || !saved) return;
    setSaving(true);
    setFailure("");
    setMessage("");
    try {
      const response = await protectedApiFetch("/api/admin/ui-strategies", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
          expectedRevision: saved.revision,
          instance: draft.instance,
          roleRules: draft.instance.selectionMode === "approved_subset" ? draft.roleRules : [],
        }),
      });
      if (response.status === 409) {
        setFailure("Another administrator changed this policy. Refresh before saving again.");
        return;
      }
      if (!response.ok) throw new Error("request failed");
      const policy = parseUiStrategyPolicy(await response.json());
      setSaved(policy);
      setDraft(copyPolicy(policy));
      setMessage(`Strategy rollout policy revision ${policy.revision} was saved and audited.`);
      window.dispatchEvent(new CustomEvent(UI_STRATEGY_POLICY_CHANGED_EVENT, { detail: { revision: policy.revision } }));
      window.setTimeout(() => headingRef.current?.focus(), 0);
    } catch {
      setFailure("Strategy rollout settings were not saved. The previous server policy remains authoritative.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="administration__panel admin-strategies" aria-labelledby="admin-strategies-title">
      <div className="administration__panel-heading">
        <div>
          <h3 id="admin-strategies-title" ref={headingRef} tabIndex={-1}>Investigation experiences</h3>
          <p>Control which presentation strategies this instance exposes. Case data, evidence, permissions, and lifecycle rules never change with the selected experience.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || saving}>Refresh</button>
      </div>
      {failure ? <p className="administration__message administration__message--error" role="alert">{failure}</p> : null}
      {message ? <p className="administration__message" role="status">{message}</p> : null}
      {loading ? <p role="status">Loading strategy rollout policy…</p> : !draft ? null : (
        <>
          <p className="admin-strategies__revision">Policy revision {draft.revision} · last changed by {draft.updatedBy}</p>
          <div className="admin-strategies__cards">
            {UI_STRATEGIES.map((strategy) => {
              const enabled = draft.instance.enabledIds.includes(strategy.id);
              const visible = draft.instance.visibleIds.includes(strategy.id);
              return (
                <article className="admin-strategies__card" key={strategy.id}>
                  <div>
                    <h4>{strategy.name}</h4>
                    <p>{strategy.description}</p>
                    <p className="admin-strategies__meta">{strategy.maturity} · {strategy.status} · v{strategy.version}</p>
                  </div>
                  <label><input aria-label={`Enable ${strategy.name}`} type="checkbox" checked={enabled} disabled={strategy.id === "war-room"} onChange={(event) => toggleEnabled(strategy.id, event.target.checked)} /> Enabled</label>
                  <label><input aria-label={`Show ${strategy.name} in selector`} type="checkbox" checked={visible} disabled={!enabled} onChange={(event) => toggleVisible(strategy.id, event.target.checked)} /> Visible in selector</label>
                  <label><input aria-label={`Make ${strategy.name} the instance default`} type="radio" name="instance-default-strategy" checked={draft.instance.defaultId === strategy.id} disabled={!enabled} onChange={() => updateInstance((instance) => ({ ...instance, defaultId: strategy.id }))} /> Instance default</label>
                </article>
              );
            })}
          </div>

          <fieldset className="admin-strategies__selection">
            <legend>User choice</legend>
            <label><input type="radio" name="strategy-selection-mode" checked={draft.instance.selectionMode === "free"} onChange={() => updateInstance((instance) => ({ ...instance, selectionMode: "free", approvedIds: [...instance.visibleIds] }))} /> Users may choose any visible experience</label>
            <label><input type="radio" name="strategy-selection-mode" checked={draft.instance.selectionMode === "approved_subset"} onChange={() => updateInstance((instance) => ({ ...instance, selectionMode: "approved_subset", approvedIds: [...instance.visibleIds] }))} /> Restrict users to an approved subset</label>
          </fieldset>

          {draft.instance.selectionMode === "approved_subset" ? (
            <div className="admin-strategies__rules">
              <fieldset>
                <legend>Instance approved subset</legend>
                {UI_STRATEGIES.filter(({ id }) => draft.instance.visibleIds.includes(id)).map(({ id, name }) => (
                  <label key={id}><input type="checkbox" checked={draft.instance.approvedIds.includes(id)} onChange={(event) => toggleInstanceApproved(id, event.target.checked)} /> {name}</label>
                ))}
                <p>An empty subset fixes users to the applicable default.</p>
              </fieldset>
              {APP_ROLES.map((role) => {
                const rule = ruleFor(draft.roleRules, role, draft.instance.approvedIds);
                return (
                  <fieldset key={role}>
                    <legend>{ROLE_LABELS[role]} override</legend>
                    {UI_STRATEGIES.filter(({ id }) => draft.instance.visibleIds.includes(id)).map(({ id, name }) => (
                      <label key={id}><input type="checkbox" checked={rule.approvedIds.includes(id)} onChange={(event) => updateRole(role, (current) => ({ ...current, approvedIds: sorted(event.target.checked ? [...current.approvedIds, id] : current.approvedIds.filter((candidate) => candidate !== id)) }))} /> {name}</label>
                    ))}
                    <label>Role default<select value={rule.defaultId ?? ""} onChange={(event) => updateRole(role, (current) => ({ ...current, defaultId: event.target.value === "" ? null : event.target.value as UiStrategyId }))}>
                      <option value="">Use instance default</option>
                      {UI_STRATEGIES.filter(({ id }) => draft.instance.enabledIds.includes(id)).map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                    </select></label>
                  </fieldset>
                );
              })}
            </div>
          ) : null}

          <div className="admin-strategies__actions">
            <button type="button" onClick={() => { setDraft(copyPolicy(saved!)); setFailure(""); setMessage(""); }} disabled={saving || !dirty}>Discard changes</button>
            <button type="button" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "Saving…" : "Save rollout policy"}</button>
          </div>
          <p className="administration__boundary">War Room remains an enabled recovery surface. A hidden strategy can still be an instance default, but users cannot select it directly. Every successful policy change is revision-checked and audited.</p>
        </>
      )}
    </section>
  );
}
