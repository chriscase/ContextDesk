/**
 * Shared settings draft / dirty / save / reset state for SettingsModal shell (#147).
 * Sections stay presentational; secrets stay transient (never in setup / localStorage).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { shouldResetSettingsOnOpen } from "../../lib/settingsOpenGate";
import {
  hostCheckOllama,
  hostConfluenceHasToken,
  hostEnsureDefaultWorkspace,
  hostGetConfluence,
  hostGetRouterBudget,
  hostGetWebResearchEnabled,
  hostGetX,
  hostListConnectors,
  hostListConnectorKinds,
  hostSetConnectorSecret,
  hostListLocalCandidates,
  hostListWebResearchSources,
  hostSaveConnectors,
  hostSetRouterBudget,
  hostPreflight,
  hostProbeUrl,
  hostProviderHasSecret,
  hostSaveActiveProvider,
  hostSaveConfluence,
  hostSaveX,
  hostSetWebResearchEnabled,
  hostSetWebResearchSources,
  hostSuggestDefaultWorkspace,
  hostValidateWorkspacePath,
  hostXHasToken,
  profileIdForKind,
  type ConnectorDto,
  type DefaultWorkspaceDto,
  type LocalCandidateDto,
  type NewsSourceDto,
  type RouterBudgetDto,
} from "../../lib/host";
import {
  runClientPreflight,
  validateBaseUrl,
  type AppSetupState,
  type PreflightItem,
  type PreflightReport,
} from "../../lib/preflight";
import { useDebouncedAsyncCheck } from "../forms";

/** NAV section ids for SettingsModal shell (#147). */
export type SettingsSection =
  | "preflight"
  | "workspace"
  | "ai"
  | "connectors"
  | "appearance"
  | "general";

export type UseSettingsControllerArgs = {
  open: boolean;
  initialSection: SettingsSection;
  setup: AppSetupState;
  onClose: () => void;
  onSaveSetup: (next: AppSetupState) => void;
  onRecheckHost?: () => void | Promise<void>;
  hostReport?: PreflightReport | null;
};

export function useSettingsController({
  open,
  initialSection,
  setup,
  onClose,
  onSaveSetup,
  onRecheckHost,
  hostReport,
}: UseSettingsControllerArgs) {
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
  const [routerBudget, setRouterBudget] = useState<RouterBudgetDto>({
    max_sources: 3,
    max_tool_rounds: 8,
    max_results_per_source: 8,
    deadline_ms: 60_000,
  });
  /** Workspace connector registry (#127). */
  const [connectors, setConnectors] = useState<ConnectorDto[]>([]);
  const [connectorKinds, setConnectorKinds] = useState<string[]>([]);
  const [newConnectorKind, setNewConnectorKind] = useState("sqlite");
  const [connectorsNote, setConnectorsNote] = useState<string | null>(null);
  /** Postgres passwords keyed by connector id (keychain on Save; never in config). */
  const [pgPasswordDrafts, setPgPasswordDrafts] = useState<Record<string, string>>({});
  /** HTTP bearer drafts (keychain on Save). */
  const [httpBearerDrafts, setHttpBearerDrafts] = useState<Record<string, string>>({});
  const baseId = useId();
  /** True after an open→true transition; avoids wiping typed secrets on setup re-renders (#157). */
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    // Already open: parent `setup` identity churn must not clear drafts/secrets.
    if (!shouldResetSettingsOnOpen(open, wasOpenRef.current)) {
      return;
    }
    wasOpenRef.current = true;
    setDraft(setup);
    setSection(initialSection);
    setCfTokenDraft("");
    setCfStatus(null);
    setXTokenDraft("");
    setXStatus(null);
    setApiKeyDraft("");
    void (async () => {
      // Abort if modal closed before host fetches return.
      const stillOpen = () => wasOpenRef.current;
      const cf = await hostGetConfluence();
      const has = await hostConfluenceHasToken();
      const x = await hostGetX();
      const xHas = await hostXHasToken();
      const webOn = await hostGetWebResearchEnabled();
      const sources = await hostListWebResearchSources();
      const budget = await hostGetRouterBudget();
      if (!stillOpen()) return;
      if (budget) setRouterBudget(budget);
      if (sources.length) setNewsSources(sources);
      const [clist, ckinds] = await Promise.all([
        hostListConnectors(),
        hostListConnectorKinds(),
      ]);
      if (!stillOpen()) return;
      setConnectors(clist);
      if (ckinds.length) {
        setConnectorKinds(ckinds);
        setNewConnectorKind(ckinds[0] ?? "sqlite");
      }
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
        if (!stillOpen()) return;
        if (keyOk !== null) {
          setDraft((d) => ({ ...d, hasApiKey: keyOk }));
        }
      }
      const cands = await hostListLocalCandidates();
      if (!stillOpen()) return;
      setCandidates(cands);
      const suggested = await hostSuggestDefaultWorkspace();
      if (!stillOpen()) return;
      setDefaultWs(suggested);
    })();
  }, [open, setup, initialSection]);

  const urlError = useMemo(() => {
    if (
      draft.providerKind !== "openai_compatible" &&
      draft.providerKind !== "anthropic"
    ) {
      return null;
    }
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
    draft.providerKind === "openai_compatible" ||
      draft.providerKind === "anthropic",
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
    void (async () => {
      if (dirty) {
        const { dialogConfirm } = await import("../../lib/dialogs");
        const ok = await dialogConfirm(
          "You have unsaved settings changes. Discard them?",
          { title: "Discard changes", kind: "warning" },
        );
        if (!ok) return;
      }
      setApiKeyDraft("");
      setCfTokenDraft("");
      setXTokenDraft("");
      onClose();
    })();
  };

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
      } else if (
        draft.providerKind === "openai_compatible" ||
        draft.providerKind === "anthropic"
      ) {
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
      const { dialogMessage } = await import("../../lib/dialogs");
      await dialogMessage(
        "Folder pick requires the desktop app. Use Browse… under Tauri, or paste a path is not available here — run npm run tauri:dev.",
        { title: "Add folder", kind: "info" },
      );
      return;
    }
    if (!path?.trim()) return;
    const trimmed = path.trim();
    const check = await hostValidateWorkspacePath(trimmed);
    if (!check.ok) {
      const { dialogMessage } = await import("../../lib/dialogs");
      await dialogMessage(`Cannot add folder: ${check.detail}`, {
        title: "Add folder",
        kind: "error",
      });
      return;
    }
    appendRoot(trimmed);
  };

  /**
   * Create/use OS Documents/<product> as a workspace root.
   * When `persist` is true (preflight accept), write through to host/parent immediately
   * so first-run does not require a separate Save click.
   */
  const applyDefaultWorkspace = async (opts?: { persist?: boolean }) => {
    setDefaultWsBusy(true);
    try {
      const ensured = await hostEnsureDefaultWorkspace();
      if (!ensured) {
        const { dialogMessage } = await import("../../lib/dialogs");
        await dialogMessage(
          "Default workspace is available in the desktop app (Tauri). Pick a folder instead.",
          { title: "Default workspace", kind: "info" },
        );
        fix("workspace");
        return;
      }
      const check = await hostValidateWorkspacePath(ensured.path);
      if (!check.ok) {
        const { dialogMessage } = await import("../../lib/dialogs");
        await dialogMessage(`Cannot use default folder: ${check.detail}`, {
          title: "Default workspace",
          kind: "error",
        });
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
        const { dialogMessage } = await import("../../lib/dialogs");
        await dialogMessage(
          `Could not save AI provider: ${e instanceof Error ? e.message : String(e)}`,
          { title: "AI provider", kind: "error" },
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

    try {
      const savedBudget = await hostSetRouterBudget(routerBudget);
      setRouterBudget(savedBudget);
    } catch {
      /* browser mode */
    }

    // Persist connector registry (#127) — rebuilds host via ensure_host.
    try {
      const saved = await hostSaveConnectors(
        connectors.map((c) => ({
          id: c.id,
          kind: c.kind,
          enabled: c.enabled,
          settings: c.settings ?? {},
        })),
      );
      setConnectors(saved);
      setConnectorsNote(null);
      // Keychain secrets for Postgres (never written to config.json).
      for (const c of saved.filter((x) => x.kind === "postgres")) {
        const secretDraft = pgPasswordDrafts[c.id]?.trim();
        if (secretDraft && !secretDraft.split("").every((ch) => ch === "•")) {
          try {
            await hostSetConnectorSecret(c.id, "postgres_password", secretDraft);
          } catch (err) {
            setConnectorsNote(
              err instanceof Error
                ? err.message
                : "Could not store Postgres password in keychain",
            );
          }
        }
      }
      setPgPasswordDrafts({});
      for (const c of saved.filter((x) => x.kind === "http")) {
        const secretDraft = httpBearerDrafts[c.id]?.trim();
        if (secretDraft && !secretDraft.split("").every((ch) => ch === "•")) {
          try {
            await hostSetConnectorSecret(c.id, "http_bearer", secretDraft);
          } catch (err) {
            setConnectorsNote(
              err instanceof Error
                ? err.message
                : "Could not store HTTP bearer in keychain",
            );
          }
        }
      }
      setHttpBearerDrafts({});
    } catch (e) {
      setConnectorsNote(
        e instanceof Error ? e.message : "Could not save connectors",
      );
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

  return {
    baseId,
    section,
    setSection,
    draft,
    setDraft,
    checking,
    cfStatus,
    setCfStatus,
    cfTokenDraft,
    setCfTokenDraft,
    xTokenDraft,
    setXTokenDraft,
    xStatus,
    setXStatus,
    apiKeyDraft,
    setApiKeyDraft,
    candidates,
    probeNote,
    defaultWs,
    defaultWsBusy,
    newsSources,
    setNewsSources,
    routerBudget,
    setRouterBudget,
    connectors,
    setConnectors,
    connectorKinds,
    newConnectorKind,
    setNewConnectorKind,
    connectorsNote,
    pgPasswordDrafts,
    setPgPasswordDrafts,
    httpBearerDrafts,
    setHttpBearerDrafts,
    urlError,
    remoteUrlCheck,
    report,
    dirty,
    confluenceUrlError,
    newsByGroup,
    requestClose,
    recheck,
    fix,
    addRoot,
    applyDefaultWorkspace,
    save,
    setSourceEnabled,
    setGroupEnabled,
  };
}
