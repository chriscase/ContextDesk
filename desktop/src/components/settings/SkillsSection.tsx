/**
 * Settings → Skills (#137 / #38 follow-through).
 * Enable/disable is UI-originated and persisted in SKILL.md frontmatter.
 * Skills that ship module.toml may request module capability approval on enable.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostApproveModuleEnable,
  hostListSkills,
  hostSetSkillEnabled,
  type SkillDto,
} from "../../lib/host";

export type SkillsSectionProps = {
  baseId: string;
};

export function SkillsSection({ baseId }: SkillsSectionProps) {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    skillId: string;
    moduleId: string;
    preview: string;
    reason: string;
    typeConfirm: string | null;
  } | null>(null);
  const [typed, setTyped] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await hostListSkills();
      setSkills(list);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not list skills");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = async (s: SkillDto, enable: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await hostSetSkillEnabled(s.id, enable);
      if (r.needs_module_approval && r.module_id) {
        setPending({
          skillId: s.id,
          moduleId: r.module_id,
          preview: r.preview ?? "",
          reason: r.reason ?? "Module capability grant required",
          typeConfirm: r.type_confirm_phrase,
        });
        setTyped("");
        setNote(
          `Skill ${s.id} enabled; approve module capabilities to attach tools.`,
        );
        await refresh();
        return;
      }
      setNote(
        r.enabled
          ? r.module_id
            ? `Enabled ${s.id} (module ${r.module_id} ready).`
            : `Enabled ${s.id} — visible in agent catalog on next turn.`
          : `Disabled ${s.id}`,
      );
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Skill toggle failed");
    } finally {
      setBusy(false);
    }
  };

  const onApprove = async (allow: boolean) => {
    if (!pending) return;
    setBusy(true);
    try {
      const ok = await hostApproveModuleEnable(
        pending.moduleId,
        allow ? "allow_once" : "deny",
        pending.typeConfirm ? typed : undefined,
      );
      setPending(null);
      setNote(
        ok
          ? `Module ${pending.moduleId} granted for skill ${pending.skillId}.`
          : `Capability grant denied for ${pending.moduleId}. Skill stays enabled as text-only.`,
      );
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="section-lead">
        Skills are markdown playbooks injected into the agent. Write-claiming
        skills start <strong>disabled</strong> until you enable them here
        (closes the #38 dead-end). Enabling is persisted in frontmatter so
        re-discovery does not silently re-disable. Skills never grant HardWrite
        or expand allowlists — host policy still applies.
      </p>

      {note ? (
        <p className="field__hint" role="status">
          {note}
        </p>
      ) : null}

      {pending ? (
        <div
          className="settings-connector-block"
          role="dialog"
          aria-labelledby={`${baseId}-skill-mod-title`}
        >
          <h3
            className="settings-connector-block__title"
            id={`${baseId}-skill-mod-title`}
          >
            Module capability approval
          </h3>
          <p className="field__hint">{pending.reason}</p>
          <pre className="tool-row__detail">{pending.preview}</pre>
          {pending.typeConfirm ? (
            <label className="field">
              <span className="field__label">
                Type <code>{pending.typeConfirm}</code> to confirm
              </span>
              <input
                className="field__control"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </label>
          ) : null}
          <div className="workspace-root-actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void onApprove(false)}
            >
              Deny
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                busy ||
                Boolean(
                  pending.typeConfirm && typed.trim() !== pending.typeConfirm,
                )
              }
              onClick={() => void onApprove(true)}
            >
              Allow
            </button>
          </div>
        </div>
      ) : null}

      <h3 className="settings-connector-block__title">Installed skills</h3>
      {skills.length === 0 ? (
        <p className="field__hint">
          No skills found. Save one via the agent{" "}
          <code>save_skill</code> tool (SoftWrite) or add{" "}
          <code>SKILL.md</code> under the workspace skills directory.
        </p>
      ) : (
        <ul className="preflight-list" aria-label="Skills">
          {skills.map((s) => (
            <li key={s.id} className="preflight-row">
              <div>
                <div className="preflight-row__title">
                  {s.name}{" "}
                  <span className="field__hint">
                    ({s.id}
                    {s.allows_write ? " · write-claiming" : ""}
                    {s.has_module
                      ? ` · ships tools${s.module_id ? ` ${s.module_id}` : ""}`
                      : ""}
                    )
                  </span>
                </div>
                <div className="preflight-row__detail">
                  {s.description || "—"}
                  <br />
                  {s.disabled ? "disabled" : "enabled"} ·{" "}
                  <code>{s.path}</code>
                </div>
                <div className="workspace-root-actions">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={!s.disabled}
                      disabled={busy}
                      onChange={(e) => void onToggle(s, e.target.checked)}
                      aria-label={`${s.disabled ? "Enable" : "Disable"} skill ${s.id}`}
                    />
                    <span>Enabled</span>
                  </label>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
