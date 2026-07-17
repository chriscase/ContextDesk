import { useEffect, useId, useMemo, useState } from "react";
import {
  hostCheckOllama,
  hostConfluenceHasToken,
  hostGetConfluence,
  hostPreflight,
  hostSaveConfluence,
  hostTestConfluence,
} from "../lib/host";
import {
  runClientPreflight,
  validateBaseUrl,
  type AppSetupState,
  type PreflightItem,
  type PreflightReport,
} from "../lib/preflight";
import { SecretField, SelectField, TextField } from "./forms/Field";
import { PreflightPanel } from "./PreflightPanel";
import { IconClose, IconSettings } from "./icons";

export type SettingsSection =
  | "preflight"
  | "workspace"
  | "ai"
  | "connectors"
  | "appearance"
  | "general";

type Props = {
  open: boolean;
  initialSection?: SettingsSection;
  setup: AppSetupState;
  theme: "dark" | "light";
  onThemeChange: (t: "dark" | "light") => void;
  onClose: () => void;
  onSaveSetup: (next: AppSetupState) => void;
  onRecheckHost?: () => void | Promise<void>;
  hostReport?: PreflightReport | null;
};

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "preflight", label: "Preflight" },
  { id: "workspace", label: "Workspace" },
  { id: "ai", label: "AI / Models" },
  { id: "connectors", label: "Connectors" },
  { id: "appearance", label: "Appearance" },
  { id: "general", label: "General" },
];

export function SettingsModal({
  open,
  initialSection = "preflight",
  setup,
  theme,
  onThemeChange,
  onClose,
  onSaveSetup,
  onRecheckHost,
  hostReport,
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState(setup);
  const [checking, setChecking] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  const [cfStatus, setCfStatus] = useState<string | null>(null);
  const [cfTokenDraft, setCfTokenDraft] = useState("");
  const baseId = useId();

  useEffect(() => {
    if (open) {
      setDraft(setup);
      setSection(initialSection);
      setCfTokenDraft("");
      setCfStatus(null);
      void (async () => {
        const cf = await hostGetConfluence();
        const has = await hostConfluenceHasToken();
        if (cf) {
          setDraft((d) => ({
            ...d,
            confluence: {
              enabled: cf.enabled,
              baseUrl: cf.base_url,
              spaces: cf.spaces.join(", "),
              hasToken: has ?? Boolean(cf.pat_ref),
            },
          }));
        }
      })();
    }
  }, [open, setup, initialSection]);

  const urlError = useMemo(() => {
    if (draft.providerKind !== "openai_compatible") return null;
    return validateBaseUrl(draft.baseUrl);
  }, [draft.providerKind, draft.baseUrl]);

  const clientReport = useMemo(() => runClientPreflight(draft), [draft, probeTick]);
  const report = hostReport ?? clientReport;

  if (!open) return null;

  const recheck = async () => {
    setChecking(true);
    try {
      if (onRecheckHost) {
        await onRecheckHost();
      }
      // Live Ollama probe from host when available
      if (draft.providerKind === "ollama") {
        const ok = await hostCheckOllama(draft.baseUrl);
        if (ok !== null) {
          setDraft((d) => ({ ...d, ollamaReachable: ok }));
        } else {
          // Browser without Tauri: mark warn via null, not fake true
          setDraft((d) => ({ ...d, ollamaReachable: null }));
        }
      } else if (draft.providerKind === "openai_compatible") {
        const hostPf = await hostPreflight();
        if (hostPf) {
          const remote = hostPf.items.find((i) => i.id === "provider.remote");
          setDraft((d) => ({
            ...d,
            remoteReachable: remote?.level === "pass",
          }));
        } else {
          const ok =
            !validateBaseUrl(draft.baseUrl) &&
            draft.hasApiKey &&
            draft.chatModel.trim().length > 0;
          setDraft((d) => ({ ...d, remoteReachable: ok ? null : false }));
        }
      }
      setProbeTick((n) => n + 1);
    } finally {
      setChecking(false);
    }
  };

  const fix = (s: NonNullable<PreflightItem["fixAction"]>) => {
    if (s === "workspace") setSection("workspace");
    else if (s === "ai") setSection("ai");
    else if (s === "connectors") setSection("connectors");
    else if (s === "appearance") setSection("appearance");
    else setSection("general");
  };

  const confluenceUrlError = useMemo(() => {
    if (!draft.confluence?.enabled) return null;
    const u = draft.confluence.baseUrl.trim();
    if (!u) return "Base URL is required when Confluence is enabled.";
    return validateBaseUrl(u);
  }, [draft.confluence]);

  const addRoot = () => {
    // Native picker lands with Tauri; prompt keeps the form usable in browser.
    const path = window.prompt("Folder path to allowlist (native picker later):");
    if (!path?.trim()) return;
    setDraft((d) => ({
      ...d,
      workspaceName: d.workspaceName ?? "Workspace",
      workspaceRoots: [...d.workspaceRoots, path.trim()],
    }));
  };

  const save = async () => {
    // Persist Confluence to host config + keychain when possible
    try {
      const saved = await hostSaveConfluence({
        enabled: draft.confluence?.enabled ?? false,
        baseUrl: draft.confluence?.baseUrl ?? "",
        spaces: draft.confluence?.spaces ?? "",
        pat: cfTokenDraft.trim() || undefined,
      });
      const has = await hostConfluenceHasToken();
      draft.confluence = {
        enabled: saved.enabled,
        baseUrl: saved.base_url,
        spaces: saved.spaces.join(", "),
        hasToken: has ?? Boolean(saved.pat_ref),
      };
    } catch {
      // browser mode: keep in local setup only
    }
    onSaveSetup({ ...draft });
    onClose();
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav__title">Settings</div>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className="settings-nav__item"
              data-active={section === item.id ? "true" : "false"}
              onClick={() => setSection(item.id)}
            >
              {item.id === "preflight" ? "◎" : <IconSettings />}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-header__title">
              {NAV.find((n) => n.id === section)?.label}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} title="Close">
              <IconClose />
            </button>
          </header>
          <div className="settings-content">
            {section === "preflight" ? (
              <PreflightPanel
                report={report}
                onRecheck={recheck}
                onFix={fix}
                checking={checking}
              />
            ) : null}

            {section === "workspace" ? (
              <div>
                <p className="section-lead">
                  Choose folders ContextDesk may search. Nothing is indexed
                  outside these roots. Prefer the picker over editing JSON.
                </p>
                <TextField
                  id={`${baseId}-ws-name`}
                  label="Workspace name"
                  value={draft.workspaceName ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      workspaceName: e.target.value || null,
                    }))
                  }
                  placeholder="My project"
                />
                <div className="field">
                  <span className="field__label">Allowlisted roots</span>
                  {draft.workspaceRoots.length === 0 ? (
                    <span className="field__error">Add at least one folder.</span>
                  ) : (
                    <ul className="session-list">
                      {draft.workspaceRoots.map((r) => (
                        <li key={r}>
                          <div className="session-list__item" style={{ display: "flex", justifyContent: "space-between" }}>
                            <span className="mono" style={{ fontSize: "0.8rem" }}>
                              {r}
                            </span>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  workspaceRoots: d.workspaceRoots.filter((x) => x !== r),
                                }))
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="btn btn--primary" onClick={addRoot}>
                    Add folder…
                  </button>
                </div>
              </div>
            ) : null}

            {section === "ai" ? (
              <div>
                <p className="section-lead">
                  Discover or configure models here. Keys go to the OS keychain;
                  profiles never need a hand-edited secrets file.
                </p>
                <SelectField
                  id={`${baseId}-kind`}
                  label="Provider"
                  value={draft.providerKind}
                  onChange={(e) => {
                    const kind = e.target.value as AppSetupState["providerKind"];
                    setDraft((d) => ({
                      ...d,
                      providerKind: kind,
                      providerLabel:
                        kind === "ollama"
                          ? "Ollama (local)"
                          : kind === "openai_compatible"
                            ? "OpenAI-compatible gateway"
                            : null,
                      ollamaReachable: null,
                      remoteReachable: null,
                      baseUrl:
                        kind === "ollama" ? "http://127.0.0.1:11434" : d.baseUrl,
                    }));
                  }}
                >
                  <option value="none">Select…</option>
                  <option value="ollama">Ollama (local)</option>
                  <option value="openai_compatible">OpenAI-compatible gateway</option>
                </SelectField>

                {draft.providerKind === "openai_compatible" ? (
                  <>
                    <TextField
                      id={`${baseId}-url`}
                      label="Base URL"
                      hint="Paste origin or …/v1/models — we normalize and probe."
                      value={draft.baseUrl}
                      error={urlError}
                      ok={!urlError && draft.baseUrl ? "Looks like a valid URL" : null}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          baseUrl: e.target.value,
                          remoteReachable: null,
                        }))
                      }
                      placeholder="https://gateway.example.com/v1"
                    />
                    <SecretField
                      id={`${baseId}-key`}
                      label="API key"
                      value={draft.hasApiKey ? "••••••••••••" : ""}
                      error={
                        !draft.hasApiKey ? "Required for remote gateways." : null
                      }
                      ok={draft.hasApiKey ? "Key saved securely (masked)" : null}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v.includes("•")) return;
                        setDraft((d) => ({
                          ...d,
                          hasApiKey: v.trim().length > 0,
                          remoteReachable: null,
                        }));
                      }}
                      placeholder="Paste key"
                    />
                  </>
                ) : null}

                {draft.providerKind === "ollama" ? (
                  <TextField
                    id={`${baseId}-ollama-url`}
                    label="Ollama URL"
                    value={draft.baseUrl}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        baseUrl: e.target.value,
                        ollamaReachable: null,
                      }))
                    }
                    placeholder="http://127.0.0.1:11434"
                  />
                ) : null}

                {draft.providerKind !== "none" ? (
                  <TextField
                    id={`${baseId}-model`}
                    label="Chat model"
                    value={draft.chatModel}
                    error={!draft.chatModel.trim() ? "Model id is required." : null}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, chatModel: e.target.value }))
                    }
                    placeholder={
                      draft.providerKind === "ollama" ? "mistral" : "provider/model"
                    }
                  />
                ) : null}

                <div className="field-row">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void recheck()}
                    disabled={checking || draft.providerKind === "none"}
                  >
                    {checking ? "Testing…" : "Test connection"}
                  </button>
                </div>
              </div>
            ) : null}

            {section === "connectors" ? (
              <div>
                <p className="section-lead">
                  Optional data sources. Confluence is read-only: set the wiki
                  base URL and a personal access token (stored in the OS
                  keychain, never in config files).
                </p>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={draft.confluence?.enabled ?? false}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        confluence: {
                          enabled: e.target.checked,
                          baseUrl: d.confluence?.baseUrl ?? "",
                          spaces: d.confluence?.spaces ?? "",
                          hasToken: d.confluence?.hasToken ?? false,
                        },
                      }))
                    }
                  />
                  Enable Confluence (read-only)
                </label>
                <TextField
                  id={`${baseId}-cf-url`}
                  label="Confluence base URL"
                  hint="e.g. https://wiki.example.com — no API path required"
                  value={draft.confluence?.baseUrl ?? ""}
                  error={confluenceUrlError}
                  ok={
                    draft.confluence?.enabled &&
                    draft.confluence.baseUrl &&
                    !confluenceUrlError
                      ? "Looks like a valid URL"
                      : null
                  }
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      confluence: {
                        enabled: d.confluence?.enabled ?? true,
                        baseUrl: e.target.value,
                        spaces: d.confluence?.spaces ?? "",
                        hasToken: d.confluence?.hasToken ?? false,
                      },
                    }))
                  }
                  placeholder="https://your-confluence.example.com"
                />
                <SecretField
                  id={`${baseId}-cf-pat`}
                  label="Personal access token"
                  hint="Atlassian/Confluence PAT or API token. Stored in keychain only."
                  value={
                    cfTokenDraft
                      ? cfTokenDraft
                      : draft.confluence?.hasToken
                        ? "••••••••••••"
                        : ""
                  }
                  error={
                    draft.confluence?.enabled && !draft.confluence.hasToken && !cfTokenDraft
                      ? "Required when Confluence is enabled."
                      : null
                  }
                  ok={
                    draft.confluence?.hasToken && !cfTokenDraft
                      ? "Token on file (masked)"
                      : null
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v.includes("•") && draft.confluence?.hasToken) return;
                    setCfTokenDraft(v);
                    if (v.trim()) {
                      setDraft((d) => ({
                        ...d,
                        confluence: {
                          enabled: d.confluence?.enabled ?? true,
                          baseUrl: d.confluence?.baseUrl ?? "",
                          spaces: d.confluence?.spaces ?? "",
                          hasToken: true,
                        },
                      }));
                    }
                  }}
                  placeholder="Paste token"
                />
                <TextField
                  id={`${baseId}-cf-spaces`}
                  label="Space keys (optional allowlist)"
                  hint="Comma-separated, e.g. ENG, DOCS. Empty = no extra filter."
                  value={draft.confluence?.spaces ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      confluence: {
                        enabled: d.confluence?.enabled ?? true,
                        baseUrl: d.confluence?.baseUrl ?? "",
                        spaces: e.target.value,
                        hasToken: d.confluence?.hasToken ?? false,
                      },
                    }))
                  }
                  placeholder="ENG, DOCS"
                />
                <div className="field-row">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      void (async () => {
                        try {
                          // Save first so test sees latest URL/token
                          await hostSaveConfluence({
                            enabled: draft.confluence?.enabled ?? false,
                            baseUrl: draft.confluence?.baseUrl ?? "",
                            spaces: draft.confluence?.spaces ?? "",
                            pat: cfTokenDraft.trim() || undefined,
                          });
                          const msg = await hostTestConfluence();
                          setCfStatus(msg);
                        } catch (e) {
                          setCfStatus(
                            e instanceof Error ? e.message : String(e),
                          );
                        }
                      })();
                    }}
                  >
                    Test configuration
                  </button>
                </div>
                {cfStatus ? (
                  <p className="section-lead" role="status">
                    {cfStatus}
                  </p>
                ) : null}
              </div>
            ) : null}

            {section === "appearance" ? (
              <div>
                <p className="section-lead">Dark is default. Light is available; more skins later.</p>
                <SelectField
                  id={`${baseId}-theme`}
                  label="Theme"
                  value={theme}
                  onChange={(e) =>
                    onThemeChange(e.target.value === "light" ? "light" : "dark")
                  }
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </SelectField>
              </div>
            ) : null}

            {section === "general" ? (
              <div>
                <p className="section-lead">
                  ContextDesk is configured through this UI. Config on disk is an
                  implementation detail — not the workflow.
                </p>
                <p className="section-lead">
                  Data directory status:{" "}
                  {draft.dataDirWritable ? "writable" : "not writable"}.
                </p>
              </div>
            ) : null}
          </div>
          <footer className="settings-footer">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={save}>
              Save
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
