import { useEffect, useId, useMemo, useState } from "react";
import {
  hostCheckOllama,
  hostConfluenceHasToken,
  hostGetConfluence,
  hostListLocalCandidates,
  hostPreflight,
  hostProbeUrl,
  hostProviderHasSecret,
  hostSaveActiveProvider,
  hostSaveConfluence,
  hostTestConfluence,
  hostValidateWorkspacePath,
  profileIdForKind,
  type LocalCandidateDto,
} from "../lib/host";
import {
  runClientPreflight,
  validateBaseUrl,
  type AppSetupState,
  type PreflightItem,
  type PreflightReport,
} from "../lib/preflight";
import {
  SecretField,
  SelectField,
  TextField,
  ToggleField,
  useDebouncedAsyncCheck,
} from "./forms";
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
  /** Transient API key typed in UI — never written to localStorage / setup state. */
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [candidates, setCandidates] = useState<LocalCandidateDto[]>([]);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const baseId = useId();

  useEffect(() => {
    if (open) {
      setDraft(setup);
      setSection(initialSection);
      setCfTokenDraft("");
      setCfStatus(null);
      setApiKeyDraft("");
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
        if (setup.providerKind !== "none") {
          const pid = profileIdForKind(setup.providerKind);
          const keyOk = await hostProviderHasSecret(pid);
          if (keyOk !== null) {
            setDraft((d) => ({ ...d, hasApiKey: keyOk }));
          }
        }
        const cands = await hostListLocalCandidates();
        setCandidates(cands);
      })();
    }
  }, [open, setup, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // requestClose closes over dirty/setup — rebind when those change
  });

  const urlError = useMemo(() => {
    if (draft.providerKind !== "openai_compatible") return null;
    return validateBaseUrl(draft.baseUrl);
  }, [draft.providerKind, draft.baseUrl]);

  // Debounced live URL shape check when typing remote gateway base.
  const remoteUrlCheck = useDebouncedAsyncCheck(
    draft.baseUrl,
    async (v) => {
      const err = validateBaseUrl(v);
      if (err) return { error: err };
      if (!v.trim()) return {};
      return { ok: "URL shape looks valid" };
    },
    350,
    draft.providerKind === "openai_compatible",
  );

  const clientReport = useMemo(() => runClientPreflight(draft), [draft, probeTick]);
  const report = hostReport ?? clientReport;

  const dirty = useMemo(() => {
    if (apiKeyDraft.trim() || cfTokenDraft.trim()) return true;
    return JSON.stringify(draft) !== JSON.stringify(setup);
  }, [draft, setup, apiKeyDraft, cfTokenDraft]);

  const requestClose = () => {
    if (dirty) {
      const ok = window.confirm(
        "You have unsaved settings changes. Discard them?",
      );
      if (!ok) return;
    }
    setApiKeyDraft("");
    setCfTokenDraft("");
    onClose();
  };

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
        const probe = await hostProbeUrl(draft.baseUrl, false);
        if (probe.ok) {
          setProbeNote(
            `URL ok · effective ${probe.effective_base} · ${probe.candidates.length} candidate base(s)`,
          );
          setDraft((d) => ({ ...d, remoteReachable: true }));
        } else {
          setProbeNote(probe.error ?? "Probe failed");
          setDraft((d) => ({ ...d, remoteReachable: false }));
        }
        const hostPf = await hostPreflight();
        if (hostPf) {
          const remote = hostPf.items.find((i) => i.id === "provider.remote");
          if (remote) {
            setDraft((d) => ({
              ...d,
              remoteReachable: remote.level === "pass" || probe.ok,
            }));
          }
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

  const addRoot = async () => {
    // Prefer native folder dialog under Tauri; prompt fallback in plain browser.
    let path: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Add workspace folder",
      });
      if (selected && typeof selected === "string") {
        path = selected;
      } else if (Array.isArray(selected) && selected[0]) {
        path = selected[0];
      }
    } catch {
      /* not in Tauri */
    }
    if (!path) {
      path = window.prompt("Folder path to allowlist:");
    }
    if (!path?.trim()) return;
    const trimmed = path.trim();
    const check = await hostValidateWorkspacePath(trimmed);
    if (!check.ok) {
      window.alert(`Cannot add folder: ${check.detail}`);
      return;
    }
    setDraft((d) => ({
      ...d,
      workspaceName: d.workspaceName ?? "Workspace",
      workspaceRoots: d.workspaceRoots.includes(trimmed)
        ? d.workspaceRoots
        : [...d.workspaceRoots, trimmed],
    }));
  };

  const save = async () => {
    let next: AppSetupState = { ...draft };

    // Persist AI provider + optional API key (keychain only; never in setup JSON).
    if (draft.providerKind !== "none") {
      try {
        const saved = await hostSaveActiveProvider({
          kind: draft.providerKind,
          baseUrl: draft.baseUrl,
          chatModel: draft.chatModel,
          label: draft.providerLabel ?? undefined,
          apiKey: apiKeyDraft.trim() || undefined,
        });
        if (saved) {
          next = {
            ...next,
            hasApiKey: saved.has_key,
            baseUrl: saved.base_url,
            chatModel: saved.chat_model,
            providerLabel: saved.label,
          };
        }
      } catch {
        // browser mode: local flags only
        if (apiKeyDraft.trim()) {
          next = { ...next, hasApiKey: true };
        }
      }
    }

    // Persist Confluence to host config + keychain when possible
    try {
      const saved = await hostSaveConfluence({
        enabled: draft.confluence?.enabled ?? false,
        baseUrl: draft.confluence?.baseUrl ?? "",
        spaces: draft.confluence?.spaces ?? "",
        pat: cfTokenDraft.trim() || undefined,
      });
      const has = await hostConfluenceHasToken();
      next = {
        ...next,
        confluence: {
          enabled: saved.enabled,
          baseUrl: saved.base_url,
          spaces: saved.spaces.join(", "),
          hasToken: has ?? Boolean(saved.pat_ref),
        },
      };
    } catch {
      // browser mode: keep in local setup only
    }

    setApiKeyDraft("");
    setCfTokenDraft("");
    onSaveSetup(next);
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
            <button type="button" className="icon-btn" onClick={requestClose} title="Close">
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
                          <div className="session-list__item row--between">
                            <span className="mono mono--sm">
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
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void addRoot()}
                  >
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
                {candidates.length > 0 ? (
                  <div className="field">
                    <span className="field__label">Local candidates</span>
                    <ul className="session-list">
                      {candidates.map((c) => (
                        <li key={c.id}>
                          <div className="session-list__item row--between">
                            <span>
                              {c.label}
                              {c.credentials_present ? " · credentials present" : ""}
                              {c.notes[0] ? ` · ${c.notes[0]}` : ""}
                            </span>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => {
                                const kind =
                                  c.kind === "ollama"
                                    ? "ollama"
                                    : c.kind === "openai_compatible" ||
                                        c.kind === "OpenAiCompatible"
                                      ? "openai_compatible"
                                      : "none";
                                if (kind === "none") return;
                                setDraft((d) => ({
                                  ...d,
                                  providerKind: kind,
                                  providerLabel: c.label,
                                  baseUrl: c.base_url ?? d.baseUrl,
                                }));
                              }}
                            >
                              Use
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <span className="field__hint">
                      Grok session presence is metadata only — never used until
                      explicit Phase 2 opt-in.
                    </span>
                  </div>
                ) : null}
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
                      error={remoteUrlCheck.error ?? urlError}
                      ok={remoteUrlCheck.ok}
                      pending={remoteUrlCheck.pending}
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
                      value={apiKeyDraft}
                      error={
                        !draft.hasApiKey && !apiKeyDraft.trim()
                          ? "Required for remote gateways."
                          : null
                      }
                      ok={
                        draft.hasApiKey && !apiKeyDraft
                          ? "Key in OS keychain (enter a new value to replace)"
                          : apiKeyDraft.trim()
                            ? "Will store in OS keychain on Save"
                            : null
                      }
                      onChange={(e) => {
                        setApiKeyDraft(e.target.value);
                        setDraft((d) => ({
                          ...d,
                          remoteReachable: null,
                        }));
                      }}
                      placeholder={
                        draft.hasApiKey
                          ? "•••••••• (stored securely)"
                          : "Paste key — stored in keychain on Save"
                      }
                      autoComplete="off"
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
                {probeNote ? (
                  <p className="field__hint" role="status">
                    {probeNote}
                  </p>
                ) : null}
              </div>
            ) : null}

            {section === "connectors" ? (
              <div>
                <p className="section-lead">
                  Optional data sources. Confluence is read-only: set the wiki
                  base URL and a personal access token (stored in the OS
                  keychain, never in config files).
                </p>
                <ToggleField
                  id={`${baseId}-cf-enabled`}
                  label="Enable Confluence (read-only)"
                  hint="PAT is stored in the OS keychain only."
                  checked={draft.confluence?.enabled ?? false}
                  onChange={(enabled) =>
                    setDraft((d) => ({
                      ...d,
                      confluence: {
                        enabled,
                        baseUrl: d.confluence?.baseUrl ?? "",
                        spaces: d.confluence?.spaces ?? "",
                        hasToken: d.confluence?.hasToken ?? false,
                      },
                    }))
                  }
                />
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
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
              Cancel{dirty ? " (unsaved)" : ""}
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
