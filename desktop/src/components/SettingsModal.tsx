import { useEffect, useId, useMemo, useState } from "react";
import {
  hostCheckOllama,
  hostConfluenceHasToken,
  hostEnsureDefaultWorkspace,
  hostGetConfluence,
  hostGetWebResearchEnabled,
  hostGetX,
  hostListLocalCandidates,
  hostListWebResearchSources,
  hostPreflight,
  hostProbeUrl,
  hostProviderHasSecret,
  hostSaveActiveProvider,
  hostSaveConfluence,
  hostSaveX,
  hostSetWebResearchEnabled,
  hostSetWebResearchSources,
  hostSuggestDefaultWorkspace,
  hostTestConfluence,
  hostTestX,
  hostValidateWorkspacePath,
  hostXHasToken,
  normalizeProviderKind,
  profileIdForKind,
  type DefaultWorkspaceDto,
  type LocalCandidateDto,
  type NewsSourceDto,
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
import { HelpTip, HelpTitle } from "./HelpTip";
import { PreflightPanel } from "./PreflightPanel";
import type { ReactNode } from "react";
import {
  IconAi,
  IconAppearance,
  IconClose,
  IconConnectors,
  IconPreflight,
  IconSliders,
  IconWorkspace,
} from "./icons";

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

const NAV: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "preflight", label: "Preflight", icon: <IconPreflight /> },
  { id: "workspace", label: "Workspace", icon: <IconWorkspace /> },
  { id: "ai", label: "AI / Models", icon: <IconAi /> },
  { id: "connectors", label: "Connectors", icon: <IconConnectors /> },
  { id: "appearance", label: "Appearance", icon: <IconAppearance /> },
  { id: "general", label: "General", icon: <IconSliders /> },
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
  const [xTokenDraft, setXTokenDraft] = useState("");
  const [xStatus, setXStatus] = useState<string | null>(null);
  /** Transient API key typed in UI — never written to localStorage / setup state. */
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [candidates, setCandidates] = useState<LocalCandidateDto[]>([]);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [defaultWs, setDefaultWs] = useState<DefaultWorkspaceDto | null>(null);
  const [defaultWsBusy, setDefaultWsBusy] = useState(false);
  const [newsSources, setNewsSources] = useState<NewsSourceDto[]>([]);
  const baseId = useId();

  useEffect(() => {
    if (open) {
      setDraft(setup);
      setSection(initialSection);
      setCfTokenDraft("");
      setCfStatus(null);
      setXTokenDraft("");
      setXStatus(null);
      setApiKeyDraft("");
      void (async () => {
        const cf = await hostGetConfluence();
        const has = await hostConfluenceHasToken();
        const x = await hostGetX();
        const xHas = await hostXHasToken();
        const webOn = await hostGetWebResearchEnabled();
        const sources = await hostListWebResearchSources();
        if (sources.length) setNewsSources(sources);
        setDraft((d) => ({
          ...d,
          confluence: cf
            ? {
                enabled: cf.enabled,
                baseUrl: cf.base_url,
                spaces: cf.spaces.join(", "),
                hasToken: has ?? Boolean(cf.pat_ref),
              }
            : d.confluence,
          x: x
            ? {
                enabled: x.enabled,
                hasToken: xHas ?? Boolean(x.api_key_ref),
              }
            : d.x ?? { enabled: false, hasToken: false },
          webResearchEnabled: webOn ?? d.webResearchEnabled ?? false,
        }));
        if (setup.providerKind !== "none") {
          const pid = profileIdForKind(setup.providerKind);
          const keyOk = await hostProviderHasSecret(pid);
          if (keyOk !== null) {
            setDraft((d) => ({ ...d, hasApiKey: keyOk }));
          }
        }
        const cands = await hostListLocalCandidates();
        setCandidates(cands);
        const suggested = await hostSuggestDefaultWorkspace();
        setDefaultWs(suggested);
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
    if (apiKeyDraft.trim() || cfTokenDraft.trim() || xTokenDraft.trim()) return true;
    return JSON.stringify(draft) !== JSON.stringify(setup);
  }, [draft, setup, apiKeyDraft, cfTokenDraft, xTokenDraft]);

  // Must stay above any early return — Rules of Hooks.
  const confluenceUrlError = useMemo(() => {
    if (!draft.confluence?.enabled) return null;
    const u = draft.confluence.baseUrl.trim();
    if (!u) return "Base URL is required when Confluence is enabled.";
    return validateBaseUrl(u);
  }, [draft.confluence]);

  const newsByGroup = useMemo(() => {
    const groups: { key: string; label: string; items: NewsSourceDto[] }[] =
      [];
    const order: string[] = [];
    for (const s of newsSources) {
      if (!order.includes(s.group)) {
        order.push(s.group);
        groups.push({ key: s.group, label: s.group_label, items: [] });
      }
      groups.find((g) => g.key === s.group)?.items.push(s);
    }
    return groups;
  }, [newsSources]);

  const requestClose = () => {
    if (dirty) {
      const ok = window.confirm(
        "You have unsaved settings changes. Discard them?",
      );
      if (!ok) return;
    }
    setApiKeyDraft("");
    setCfTokenDraft("");
    setXTokenDraft("");
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

  const appendRoot = (path: string, nameFallback?: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setDraft((d) => ({
      ...d,
      workspaceName: d.workspaceName ?? nameFallback ?? "Workspace",
      workspaceRoots: d.workspaceRoots.includes(trimmed)
        ? d.workspaceRoots
        : [...d.workspaceRoots, trimmed],
    }));
  };

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
    appendRoot(trimmed);
  };

  /**
   * Create/use OS Documents/<product> as a workspace root.
   * When `persist` is true (preflight accept), write through to host/parent immediately
   * so first-run does not require a separate Save click.
   */
  const useDefaultWorkspace = async (opts?: { persist?: boolean }) => {
    setDefaultWsBusy(true);
    try {
      const ensured = await hostEnsureDefaultWorkspace();
      if (!ensured) {
        window.alert(
          "Default workspace is available in the desktop app (Tauri). Pick a folder instead.",
        );
        fix("workspace");
        return;
      }
      const check = await hostValidateWorkspacePath(ensured.path);
      if (!check.ok) {
        window.alert(`Cannot use default folder: ${check.detail}`);
        return;
      }
      setDefaultWs(ensured);
      const folderName =
        ensured.label.split("/").pop() ||
        ensured.path.split(/[/\\]/).pop() ||
        "Workspace";
      const next: AppSetupState = {
        ...draft,
        workspaceName: draft.workspaceName ?? folderName,
        workspaceRoots: draft.workspaceRoots.includes(ensured.path)
          ? draft.workspaceRoots
          : [...draft.workspaceRoots, ensured.path],
      };
      setDraft(next);
      if (opts?.persist) {
        onSaveSetup(next);
      }
    } finally {
      setDefaultWsBusy(false);
    }
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
          apiKey:
            draft.providerKind === "xai_grok_build"
              ? undefined
              : apiKeyDraft.trim() || undefined,
          localOnly:
            draft.providerKind === "xai_grok_build"
              ? false
              : (draft.localOnly ?? draft.providerKind === "ollama"),
        });
        if (saved) {
          next = {
            ...next,
            hasApiKey: saved.has_key,
            baseUrl: saved.base_url,
            chatModel: saved.chat_model,
            providerLabel: saved.label,
            providerKind: draft.providerKind,
            localOnly: saved.kind === "xai_grok_build" ? false : next.localOnly,
          };
        }
      } catch (e) {
        // Host present but save failed (e.g. no Grok session, bad URL) — don't silent-close.
        window.alert(
          `Could not save AI provider: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
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

    // Persist X connector (keychain only for bearer)
    try {
      const saved = await hostSaveX({
        enabled: draft.x?.enabled ?? false,
        apiKey: xTokenDraft.trim() || undefined,
      });
      const has = await hostXHasToken();
      next = {
        ...next,
        x: {
          enabled: saved.enabled,
          hasToken: has ?? Boolean(saved.api_key_ref),
        },
      };
    } catch {
      next = {
        ...next,
        x: draft.x ?? { enabled: false, hasToken: false },
      };
    }

    // Persist web research toggle + publisher source map (rebuilds tool host)
    try {
      const webOn = await hostSetWebResearchEnabled(
        draft.webResearchEnabled ?? false,
      );
      next = { ...next, webResearchEnabled: webOn };
      if (newsSources.length) {
        const map: Record<string, boolean> = {};
        for (const s of newsSources) map[s.id] = s.enabled;
        const savedSources = await hostSetWebResearchSources(map);
        if (savedSources.length) setNewsSources(savedSources);
      }
    } catch {
      next = {
        ...next,
        webResearchEnabled: draft.webResearchEnabled ?? false,
      };
    }

    setApiKeyDraft("");
    setCfTokenDraft("");
    setXTokenDraft("");
    onSaveSetup(next);
    onClose();
  };

  const setSourceEnabled = (id: string, enabled: boolean) => {
    setNewsSources((all) =>
      all.map((s) => (s.id === id ? { ...s, enabled } : s)),
    );
  };

  const setGroupEnabled = (group: string, enabled: boolean) => {
    setNewsSources((all) =>
      all.map((s) => (s.group === group ? { ...s, enabled } : s)),
    );
  };

  return (
    <div
      className="settings-page"
      role="region"
      aria-label="Settings"
    >
      <div className="settings-panel settings-panel--page">
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
              <span className="settings-nav__icon" aria-hidden>
                {item.icon}
              </span>
              <span className="settings-nav__label">{item.label}</span>
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
                defaultWorkspace={defaultWs}
                defaultWorkspaceBusy={defaultWsBusy}
                onUseDefaultWorkspace={() =>
                  void useDefaultWorkspace({ persist: true })
                }
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
                  <div className="workspace-root-actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void addRoot()}
                    >
                      Add folder…
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={defaultWsBusy}
                      onClick={() => void useDefaultWorkspace({ persist: false })}
                      title={
                        defaultWs
                          ? `Create or use ${defaultWs.path}`
                          : "Use the platform Documents folder (desktop app)"
                      }
                    >
                      {defaultWsBusy
                        ? "Setting default…"
                        : defaultWs
                          ? `Use default (${defaultWs.label})`
                          : "Use default folder"}
                    </button>
                  </div>
                  {defaultWs ? (
                    <p className="field__hint">
                      Default on this OS:{" "}
                      <span className="mono mono--sm">{defaultWs.path}</span>
                      {defaultWs.exists ? " (exists)" : " (will be created)"}
                      . Never uses your whole home directory.
                    </p>
                  ) : (
                    <p className="field__hint">
                      In the desktop app, one click sets a Documents/ContextDesk
                      folder (macOS, Windows, and Linux).
                    </p>
                  )}
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
                      {candidates.map((c) => {
                        const candKind = normalizeProviderKind(c.kind);
                        const inUse =
                          candKind !== "none" &&
                          draft.providerKind === candKind &&
                          (candKind !== "openai_compatible" ||
                            !c.base_url ||
                            draft.baseUrl === c.base_url);
                        return (
                          <li key={c.id}>
                            <div className="session-list__item row--between">
                              <span>
                                {c.label}
                                {c.credentials_present ? " · credentials present" : ""}
                                {c.notes[0] ? ` · ${c.notes[0]}` : ""}
                                {inUse ? " · selected" : ""}
                              </span>
                              <button
                                type="button"
                                className={
                                  inUse ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"
                                }
                                disabled={inUse}
                                onClick={() => {
                                  const kind = normalizeProviderKind(c.kind);
                                  if (kind === "none") {
                                    window.alert(
                                      `This candidate (${c.kind}) is not supported yet.`,
                                    );
                                    return;
                                  }
                                  if (kind === "xai_grok_build") {
                                    const ok = window.confirm(
                                      [
                                        "Use Grok Build session credentials?",
                                        "",
                                        "ContextDesk will call api.x.ai using your local",
                                        "~/.grok/auth.json session (not auto-enabled until you Save).",
                                        "Tokens stay on this machine and are never written to settings JSON.",
                                      ].join("\n"),
                                    );
                                    if (!ok) return;
                                    setDraft((d) => ({
                                      ...d,
                                      providerKind: "xai_grok_build",
                                      providerLabel: c.label,
                                      baseUrl: c.base_url ?? "https://api.x.ai/v1",
                                      chatModel:
                                        d.providerKind === "xai_grok_build" && d.chatModel.trim()
                                          ? d.chatModel
                                          : "grok-3",
                                      localOnly: false,
                                      hasApiKey: c.credentials_present,
                                      ollamaReachable: null,
                                      remoteReachable: null,
                                    }));
                                    return;
                                  }
                                  setDraft((d) => ({
                                    ...d,
                                    providerKind: kind,
                                    providerLabel: c.label,
                                    baseUrl:
                                      c.base_url ??
                                      (kind === "ollama"
                                        ? "http://127.0.0.1:11434"
                                        : d.baseUrl),
                                    localOnly: kind === "ollama",
                                    hasApiKey: c.credentials_present || d.hasApiKey,
                                    chatModel:
                                      kind === "ollama" && !d.chatModel.trim()
                                        ? "mistral"
                                        : d.chatModel,
                                    ollamaReachable: null,
                                    remoteReachable: null,
                                  }));
                                }}
                              >
                                {inUse ? "Selected" : "Use"}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <span className="field__hint">
                      Candidates are discovered on this machine. Grok requires an
                      explicit Use + Save opt-in before session credentials are sent
                      to api.x.ai.
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
                            : kind === "xai_grok_build"
                              ? "Grok Build session"
                              : null,
                      ollamaReachable: null,
                      remoteReachable: null,
                      localOnly: kind === "ollama",
                      baseUrl:
                        kind === "ollama"
                          ? "http://127.0.0.1:11434"
                          : kind === "xai_grok_build"
                            ? "https://api.x.ai/v1"
                            : d.baseUrl,
                      chatModel:
                        kind === "xai_grok_build" && !d.chatModel.trim()
                          ? "grok-3"
                          : d.chatModel,
                    }));
                  }}
                >
                  <option value="none">Select…</option>
                  <option value="ollama">Ollama (local)</option>
                  <option value="openai_compatible">OpenAI-compatible gateway</option>
                  <option value="xai_grok_build">Grok Build session</option>
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
                      help={{
                        label: "API key storage",
                        title: "API key",
                        body: (
                          <>
                            <p>
                              Required for most OpenAI-compatible gateways.
                              ContextDesk stores the key in the OS keychain —
                              never in local config files or chat history.
                            </p>
                            <ol>
                              <li>Paste the key from your provider dashboard.</li>
                              <li>
                                Click <strong>Save</strong> so it is written to
                                the keychain.
                              </li>
                              <li>
                                Leave blank later to keep the existing key;
                                paste a new value only to replace.
                              </li>
                            </ol>
                          </>
                        ),
                      }}
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

                {draft.providerKind === "xai_grok_build" ? (
                  <>
                    <TextField
                      id={`${baseId}-grok-url`}
                      label="API base (api.x.ai only)"
                      hint="Session credentials only against api.x.ai after opt-in Save."
                      help={{
                        label: "Grok Build session",
                        title: "Grok Build setup",
                        body: (
                          <>
                            <p>
                              Uses your local Grok Build session (
                              <code>~/.grok/auth.json</code>) after you opt in
                              with Save — not a pasted API key.
                            </p>
                            <ol>
                              <li>Sign in with Grok Build / CLI on this machine.</li>
                              <li>
                                Choose <strong>Grok Build session</strong> and
                                leave the base as <code>https://api.x.ai/v1</code>.
                              </li>
                              <li>
                                Click <strong>Save</strong> so ContextDesk may
                                use the session for chat.
                              </li>
                            </ol>
                          </>
                        ),
                      }}
                      value={draft.baseUrl}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          baseUrl: e.target.value,
                          remoteReachable: null,
                        }))
                      }
                      placeholder="https://api.x.ai/v1"
                    />
                    <p className="field__hint" role="status">
                      {draft.hasApiKey
                        ? "Grok session file detected — Save to activate this profile."
                        : "No session file — run `grok login` in a terminal, then re-open Settings."}
                    </p>
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
                      draft.providerKind === "ollama"
                        ? "mistral"
                        : draft.providerKind === "xai_grok_build"
                          ? "grok-3"
                          : "provider/model"
                    }
                  />
                ) : null}

                {draft.providerKind !== "none" &&
                draft.providerKind !== "xai_grok_build" ? (
                  <ToggleField
                    id={`${baseId}-local-only`}
                    label="Local-only profile"
                    hint="Refuse non-loopback base URLs (recommended for Ollama). Remote gateways need this off."
                    checked={
                      draft.localOnly ?? draft.providerKind === "ollama"
                    }
                    onChange={(localOnly) =>
                      setDraft((d) => ({ ...d, localOnly }))
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
                  Optional data sources. Use the{" "}
                  <span className="section-lead__help-hint" aria-hidden>
                    ?
                  </span>{" "}
                  icons for setup steps where extra configuration is required.
                </p>
                <ToggleField
                  id={`${baseId}-web-research`}
                  label="Enable web research"
                  hint="Adds web_search / web_fetch. No API key. Public web only; SSRF-gated."
                  checked={draft.webResearchEnabled ?? false}
                  onChange={(webResearchEnabled) =>
                    setDraft((d) => ({ ...d, webResearchEnabled }))
                  }
                  help={{
                    label: "web research setup",
                    title: "Web research",
                    body: (
                      <>
                        <p>
                          Turns on agent tools that search and fetch public web
                          pages. No account or API key is required.
                        </p>
                        <ol>
                          <li>
                            Toggle <strong>Enable web research</strong> on.
                          </li>
                          <li>
                            Optionally disable individual publisher feeds you do
                            not want used (groups match{" "}
                            <code>packs</code> the model can pass).
                          </li>
                          <li>
                            Click <strong>Save</strong>. New chat turns can call{" "}
                            <code>web_search</code> and <code>web_fetch</code>.
                          </li>
                        </ol>
                        <p>
                          Backends: Google News RSS, curated publisher RSS, then
                          DuckDuckGo fallbacks. Private/loopback URLs are blocked.
                        </p>
                      </>
                    ),
                  }}
                />
                {draft.webResearchEnabled && newsSources.length > 0 ? (
                  <div className="news-sources">
                    <div className="news-sources__lead-row">
                      <p className="field__hint news-sources__lead">
                        Publisher allowlist. Groups map to agent{" "}
                        <code>packs</code>. Cached ~8 minutes.
                      </p>
                      <HelpTip
                        label="publisher packs"
                        title="Publisher feeds & packs"
                      >
                        <p>
                          These feeds supply real article URLs alongside Google
                          News. Everything is on by default.
                        </p>
                        <ul>
                          <li>
                            <strong>User toggles</strong> are the hard max —
                            disabled sources never run.
                          </li>
                          <li>
                            The model may pass{" "}
                            <code>
                              packs: [&quot;middle_east&quot;,
                              &quot;security&quot;]
                            </code>{" "}
                            to narrow fan-in further.
                          </li>
                          <li>
                            Pack ids:{" "}
                            <code>public_intl</code>,{" "}
                            <code>us_mainstream</code>,{" "}
                            <code>middle_east</code>, <code>security</code>,{" "}
                            <code>progressive</code>,{" "}
                            <code>conservative</code>.
                          </li>
                        </ul>
                      </HelpTip>
                    </div>
                    <div className="news-sources__bulk">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          setNewsSources((all) =>
                            all.map((s) => ({ ...s, enabled: true })),
                          )
                        }
                      >
                        Enable all
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          setNewsSources((all) =>
                            all.map((s) => ({ ...s, enabled: false })),
                          )
                        }
                      >
                        Disable all
                      </button>
                    </div>
                    {newsByGroup.map((g) => (
                      <div key={g.key} className="news-sources__group">
                        <div className="news-sources__group-head">
                          <span className="news-sources__group-label">
                            {g.label}
                          </span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              const allOn = g.items.every((i) => i.enabled);
                              setGroupEnabled(g.key, !allOn);
                            }}
                          >
                            {g.items.every((i) => i.enabled)
                              ? "Disable group"
                              : "Enable group"}
                          </button>
                        </div>
                        {g.items.map((s) => (
                          <ToggleField
                            key={s.id}
                            id={`${baseId}-src-${s.id}`}
                            label={s.label}
                            hint={s.hint}
                            checked={s.enabled}
                            onChange={(enabled) =>
                              setSourceEnabled(s.id, enabled)
                            }
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="settings-connector-block">
                  <HelpTitle
                    title="X (Twitter)"
                    helpLabel="X search setup"
                    helpTitle="Set up X search"
                  >
                    <p>
                      Optional connector for recent posts via the official X
                      API. This is <strong>not free RSS</strong> — search needs
                      a paid/usable X API plan. Free tier is effectively
                      unusable for reading/search.
                    </p>
                    <ol>
                      <li>
                        Create an app at{" "}
                        <strong>developer.x.com</strong> and subscribe to a plan
                        that includes recent search.
                      </li>
                      <li>
                        Copy a <strong>Bearer token</strong> (OAuth 2.0 app
                        token).
                      </li>
                      <li>
                        Toggle <strong>Enable X search</strong> on, paste the
                        token below, then <strong>Save</strong>.
                      </li>
                      <li>
                        Use <strong>Test X config</strong> to confirm a key is
                        on file (does not call the live API).
                      </li>
                    </ol>
                    <p>
                      The token is stored only in the OS keychain — never in{" "}
                      <code>config.json</code>. When both enable + key are set,
                      the agent gets the <code>x_search</code> tool.
                    </p>
                  </HelpTitle>
                  <ToggleField
                    id={`${baseId}-x-enabled`}
                    label="Enable X search"
                    hint="Tool appears only when a bearer is also saved."
                    checked={draft.x?.enabled ?? false}
                    onChange={(enabled) =>
                      setDraft((d) => ({
                        ...d,
                        x: {
                          enabled,
                          hasToken: d.x?.hasToken ?? false,
                        },
                      }))
                    }
                  />
                  <SecretField
                    id={`${baseId}-x-key`}
                    label="X API bearer token"
                    hint="Stored in keychain on Save."
                    help={{
                      label: "X API bearer",
                      title: "Where the bearer goes",
                      body: (
                        <>
                          <p>
                            Paste the Bearer token from the X developer
                            portal. ContextDesk sends it only as{" "}
                            <code>Authorization: Bearer …</code> to{" "}
                            <code>api.x.com</code>.
                          </p>
                          <p>
                            Leave blank on later saves to keep the existing
                            key. Masked dots mean a key is already stored.
                          </p>
                        </>
                      ),
                    }}
                    value={
                      xTokenDraft
                        ? xTokenDraft
                        : draft.x?.hasToken
                          ? "••••••••••••"
                          : ""
                    }
                    error={
                      draft.x?.enabled && !draft.x.hasToken && !xTokenDraft
                        ? "Required when X search is enabled."
                        : null
                    }
                    ok={
                      draft.x?.hasToken && !xTokenDraft
                        ? "Token on file (masked)"
                        : null
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.includes("•") && draft.x?.hasToken) return;
                      setXTokenDraft(v);
                      if (v.trim()) {
                        setDraft((d) => ({
                          ...d,
                          x: {
                            enabled: d.x?.enabled ?? true,
                            hasToken: true,
                          },
                        }));
                      }
                    }}
                    placeholder="Paste bearer token"
                  />
                  <div className="field-row">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        void (async () => {
                          try {
                            const msg = await hostTestX();
                            setXStatus(msg);
                          } catch (e) {
                            setXStatus(
                              e instanceof Error ? e.message : String(e),
                            );
                          }
                        })();
                      }}
                    >
                      Test X config
                    </button>
                  </div>
                  {xStatus ? (
                    <p className="field__hint" role="status">
                      {xStatus}
                    </p>
                  ) : null}
                </div>

                <div className="settings-connector-block">
                  <HelpTitle
                    title="Confluence (read-only)"
                    helpLabel="Confluence setup"
                    helpTitle="Set up Confluence"
                  >
                    <p>
                      Read-only access to a Confluence wiki. The agent can
                      search and open pages; it cannot create or edit content.
                    </p>
                    <ol>
                      <li>
                        Note your wiki base URL (e.g.{" "}
                        <code>https://wiki.example.com</code> — no{" "}
                        <code>/wiki</code> or API path required).
                      </li>
                      <li>
                        Create a personal access token (PAT) or API token in
                        your Atlassian/Confluence account.
                      </li>
                      <li>
                        Toggle enable on, enter base URL + PAT, optionally
                        restrict to space keys (e.g. <code>ENG, DOCS</code>).
                      </li>
                      <li>
                        <strong>Save</strong>, then Test configuration.
                      </li>
                    </ol>
                    <p>
                      The PAT is stored only in the OS keychain. Tools:{" "}
                      <code>confluence_search</code>,{" "}
                      <code>confluence_get_page</code>.
                    </p>
                  </HelpTitle>
                <ToggleField
                  id={`${baseId}-cf-enabled`}
                  label="Enable Confluence"
                  hint="PAT stays in the OS keychain only."
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
                  help={{
                    label: "Confluence URL",
                    title: "Base URL format",
                    body: (
                      <>
                        <p>
                          Use the site origin only. ContextDesk appends the
                          REST paths it needs.
                        </p>
                        <ul>
                          <li>
                            Good: <code>https://wiki.company.com</code>
                          </li>
                          <li>
                            Good:{" "}
                            <code>https://yoursite.atlassian.net/wiki</code>{" "}
                            if that is how your Cloud wiki is reached
                          </li>
                          <li>
                            Avoid pasting full page or API URLs with query
                            strings
                          </li>
                        </ul>
                      </>
                    ),
                  }}
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
                  hint="Stored in keychain only."
                  help={{
                    label: "Confluence PAT",
                    title: "Personal access token",
                    body: (
                      <>
                        <p>
                          Create a PAT or API token in your Atlassian/Confluence
                          account settings with read access to the spaces you
                          need.
                        </p>
                        <p>
                          Paste once and Save. Leave blank later to keep the
                          existing token; masked dots mean a token is already
                          stored.
                        </p>
                      </>
                    ),
                  }}
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
