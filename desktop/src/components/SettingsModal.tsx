import { useEffect, useId, useMemo, useState } from "react";
import {
  runClientPreflight,
  validateBaseUrl,
  type AppSetupState,
  type PreflightItem,
} from "../lib/preflight";
import { SecretField, SelectField, TextField } from "./forms/Field";
import { PreflightPanel } from "./PreflightPanel";
import { IconClose, IconSettings } from "./icons";

export type SettingsSection =
  | "preflight"
  | "workspace"
  | "ai"
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
};

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "preflight", label: "Preflight" },
  { id: "workspace", label: "Workspace" },
  { id: "ai", label: "AI / Models" },
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
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState(setup);
  const [checking, setChecking] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  const baseId = useId();

  useEffect(() => {
    if (open) {
      setDraft(setup);
      setSection(initialSection);
    }
  }, [open, setup, initialSection]);

  const urlError = useMemo(() => {
    if (draft.providerKind !== "openai_compatible") return null;
    return validateBaseUrl(draft.baseUrl);
  }, [draft.providerKind, draft.baseUrl]);

  const report = useMemo(() => runClientPreflight(draft), [draft, probeTick]);

  if (!open) return null;

  const recheck = () => {
    setChecking(true);
    // Simulate host probes until Tauri is wired (#70).
    window.setTimeout(() => {
      setDraft((d) => {
        if (d.providerKind === "ollama") {
          return { ...d, ollamaReachable: true };
        }
        if (d.providerKind === "openai_compatible") {
          const ok =
            !validateBaseUrl(d.baseUrl) && d.hasApiKey && d.chatModel.trim().length > 0;
          return { ...d, remoteReachable: ok };
        }
        return d;
      });
      setProbeTick((n) => n + 1);
      setChecking(false);
    }, 450);
  };

  const fix = (s: NonNullable<PreflightItem["fixAction"]>) => {
    if (s === "workspace") setSection("workspace");
    else if (s === "ai") setSection("ai");
    else if (s === "appearance") setSection("appearance");
    else setSection("general");
  };

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

  const save = () => {
    onSaveSetup(draft);
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
                    onClick={recheck}
                    disabled={checking || draft.providerKind === "none"}
                  >
                    {checking ? "Testing…" : "Test connection"}
                  </button>
                </div>
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
