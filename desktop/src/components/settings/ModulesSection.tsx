/**
 * Settings → Modules (#136). Local install only (NON_GOALS #7).
 * Enable triggers #135 capability approval when grants are missing.
 * Browse-only registry (#139) — metadata only; Install hands off to local #136 path.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostApproveModuleEnable,
  hostBrowseModuleRegistry,
  hostGetModuleRegistrySettings,
  hostInstallModule,
  hostListModules,
  hostRemoveModule,
  hostSetModuleEnabled,
  hostSetModuleRegistrySettings,
  type ModuleDto,
  type ModuleRegistryEntryDto,
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
  const [regEnabled, setRegEnabled] = useState(false);
  const [regUrl, setRegUrl] = useState("");
  const [regFile, setRegFile] = useState("");
  const [regEntries, setRegEntries] = useState<ModuleRegistryEntryDto[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await hostListModules();
      setModules(list);
      const rs = await hostGetModuleRegistrySettings();
      setRegEnabled(rs.enabled);
      setRegUrl(rs.url);
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

  const onSaveRegistry = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await hostSetModuleRegistrySettings(regEnabled, regUrl);
      setRegEnabled(r.enabled);
      setRegUrl(r.url);
      setNote(
        r.enabled && r.url
          ? "Registry opt-in saved (browse is metadata-only; never auto-installs)."
          : "Registry browse disabled.",
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Registry settings failed");
    } finally {
      setBusy(false);
    }
  };

  const onBrowseRegistry = async () => {
    setBusy(true);
    setNote(null);
    try {
      // Metadata only — does not install or run module code (NON_GOALS #7).
      const entries = await hostBrowseModuleRegistry(
        regFile.trim() || undefined,
      );
      setRegEntries(entries);
      setNote(`Found ${entries.length} registry entr${entries.length === 1 ? "y" : "ies"} (metadata only).`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Browse failed");
      setRegEntries([]);
    } finally {
      setBusy(false);
    }
  };

  const onInstallFromRegistry = async (e: ModuleRegistryEntryDto) => {
    if (!e.local_path) {
      setNote(
        `“${e.id}” has no local_path — download/build the module, then use Install (local) with its directory.`,
      );
      return;
    }
    setPathDraft(e.local_path);
    setBusy(true);
    setNote(null);
    try {
      // Explicit hand-off to #136 local install — never silent.
      const m = await hostInstallModule(e.local_path);
      setNote(`Installed ${m.id} v${m.version} from registry hand-off (local path).`);
      await refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Install failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="section-lead">
        External modules use the MCP subprocess substrate (ADR 0001). Install is{" "}
        <strong>local path only</strong> — no marketplace auto-install
        (NON_GOALS #7). Enabling a module requests capability approval before
        tools attach. An optional browse-only index may list metadata; it never
        auto-installs.
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

      <h3 className="settings-connector-block__title">
        Browse-only registry (optional)
      </h3>
      <p className="field__hint">
        Metadata index only — never auto-installs (NON_GOALS #7). URL empty by
        default; no product-hardcoded company index. Opt-in fetch is SSRF-gated.
        Prefer a local JSON file for offline browse.
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={regEnabled}
          disabled={busy}
          onChange={(e) => setRegEnabled(e.target.checked)}
        />
        <span>Enable remote registry URL</span>
      </label>
      <label className="field">
        <span className="field__label">Registry URL (http/https)</span>
        <input
          id={`${baseId}-reg-url`}
          className="field__control"
          value={regUrl}
          onChange={(e) => setRegUrl(e.target.value)}
          placeholder="(empty — no default)"
          disabled={busy}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="field__label">Or local index JSON path</span>
        <input
          id={`${baseId}-reg-file`}
          className="field__control"
          value={regFile}
          onChange={(e) => setRegFile(e.target.value)}
          placeholder="/path/to/registry-fixture.json"
          disabled={busy}
          autoComplete="off"
        />
      </label>
      <div className="workspace-root-actions">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => void onSaveRegistry()}
        >
          Save registry settings
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => void onBrowseRegistry()}
        >
          Browse
        </button>
      </div>
      {regEntries.length > 0 ? (
        <ul className="preflight-list" aria-label="Registry entries">
          {regEntries.map((e) => (
            <li key={`${e.id}@${e.version}`} className="preflight-row">
              <div>
                <div className="preflight-row__title">
                  {e.name}{" "}
                  <span className="field__hint">
                    ({e.id} v{e.version})
                  </span>
                </div>
                <div className="preflight-row__detail">
                  {e.description || "—"}
                </div>
                <div className="workspace-root-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy || !e.can_install_local}
                    title={
                      e.can_install_local
                        ? "Install via local path (#136)"
                        : "No local_path — use Install (local) after download"
                    }
                    onClick={() => void onInstallFromRegistry(e)}
                  >
                    Install
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {note ? <p className="field__hint">{note}</p> : null}
    </div>
  );
}
