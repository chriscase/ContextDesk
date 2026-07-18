/**
 * Settings → Modules (#136). Local install only (NON_GOALS #7).
 * Enable triggers #135 capability approval when grants are missing.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostApproveModuleEnable,
  hostInstallModule,
  hostListModules,
  hostRemoveModule,
  hostSetModuleEnabled,
  type ModuleDto,
} from "../../lib/host";

export type ModulesSectionProps = {
  baseId: string;
};

export function ModulesSection({ baseId }: ModulesSectionProps) {
  const [modules, setModules] = useState<ModuleDto[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [pending, setPending] = useState<{
    id: string;
    preview: string;
    reason: string;
    typeConfirm: string | null;
  } | null>(null);
  const [typed, setTyped] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await hostListModules();
      setModules(list);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not list modules");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInstall = async () => {
    const p = pathDraft.trim();
    if (!p) {
      setNote("Enter a local path to a directory with module.toml");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      // Local path only — no network install (NON_GOALS #7).
      const m = await hostInstallModule(p);
      setNote(`Installed module ${m.id} v${m.version}`);
      setPathDraft("");
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Install failed");
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (m: ModuleDto, enabled: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await hostSetModuleEnabled(m.id, enabled);
      if (r.needs_approval) {
        setPending({
          id: r.module_id,
          preview: r.preview,
          reason: r.reason,
          typeConfirm: r.type_confirm_phrase,
        });
        setTyped("");
        return;
      }
      setNote(
        r.enabled
          ? `Enabled ${m.id} (tools attach on next host rebuild).`
          : `Disabled ${m.id}`,
      );
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Enable failed");
    } finally {
      setBusy(false);
    }
  };

  const onApprove = async (allow: boolean) => {
    if (!pending) return;
    setBusy(true);
    try {
      const ok = await hostApproveModuleEnable(
        pending.id,
        allow ? "allow_once" : "deny",
        pending.typeConfirm ? typed : undefined,
      );
      setPending(null);
      setNote(
        ok
          ? `Module ${pending.id} enabled after capability approval.`
          : `Capability grant denied for ${pending.id}.`,
      );
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (m: ModuleDto) => {
    const { dialogConfirm } = await import("../../lib/dialogs");
    const ok = await dialogConfirm(
      `Remove installed module ${m.id}? This deletes local files under the modules directory.`,
      { title: "Remove module", kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await hostRemoveModule(m.id);
      setNote(`Removed ${m.id}`);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="section-lead">
        External modules use the MCP subprocess substrate (ADR 0001). Install is{" "}
        <strong>local path only</strong> — no marketplace auto-install. Enabling
        a module requests capability approval before tools attach.
      </p>

      <h3 className="settings-connector-block__title">Install (local)</h3>
      <p className="field__hint">
        Path to a directory containing <code>module.toml</code> (
        <code>cd.module.v1</code>).
      </p>
      <div className="workspace-root-actions">
        <input
          id={`${baseId}-mod-path`}
          className="field__control"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          placeholder="/absolute/path/to/module"
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => void onInstall()}
        >
          Install
        </button>
      </div>

      {pending ? (
        <div className="settings-connector-block" role="alertdialog">
          <h3 className="settings-connector-block__title">
            Approve module capabilities
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

      <h3 className="settings-connector-block__title">Installed</h3>
      {modules.length === 0 ? (
        <p className="field__hint">No modules installed yet.</p>
      ) : (
        <ul className="preflight-list">
          {modules.map((m) => (
            <li key={m.id} className="preflight-row">
              <div>
                <div className="preflight-row__title">
                  {m.name}{" "}
                  <span className="field__hint">
                    ({m.id} v{m.version})
                  </span>
                </div>
                <div className="preflight-row__detail">
                  entrypoint: <code>{m.entrypoint}</code>
                  <br />
                  tools: {m.provided_tools.join(", ") || "—"}
                  <br />
                  caps: fs=
                  {m.requested_filesystem_roots.length} net=
                  {m.requested_network_hosts.length} secrets=
                  {m.requested_secret_refs.length}
                  {m.granted ? " · granted" : " · not granted"}
                </div>
                <div className="workspace-root-actions">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      disabled={busy}
                      onChange={(e) => void onToggle(m, e.target.checked)}
                    />
                    <span>Enabled</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => void onRemove(m)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="field__hint">{note}</p> : null}
    </div>
  );
}
