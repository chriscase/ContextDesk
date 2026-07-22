/**
 * Theme, UI scale, sidebar width, setup, settings modal, pane routing (#146).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsSection } from "../components/SettingsModal";
import {
  hostCheckOllama,
  hostGetActiveProvider,
  hostGetBranding,
  hostGetConfig,
  hostGetDefaultChatModel,
  hostListChatModels,
  hostListDurableMemories,
  hostListMemory,
  hostPreflight,
  hostSetWorkspace,
  type BrandingDto,
  type MemoryFileDto,
  type ModelOptionDto,
} from "../lib/host";
import {
  runClientPreflight,
  type AppSetupState,
  type PreflightReport,
} from "../lib/preflight";
import type { CompositionTarget } from "../components/panes/CompositionPane";
import type { MemoryDoc } from "../components/panes/MemoryPane";
import type { PaneId, UiScale } from "../lib/session";
import { parseSkinId, type SkinId } from "../lib/skins";

function loadTheme(): SkinId {
  return parseSkinId(localStorage.getItem("cd-theme"));
}

function loadUiScale(): UiScale {
  const s = localStorage.getItem("cd-ui-scale");
  if (s === "90" || s === "110" || s === "100") return s;
  return "100";
}

function loadSetup(): AppSetupState {
  try {
    const raw = localStorage.getItem("cd-setup");
    if (raw) {
      const parsed = JSON.parse(raw) as AppSetupState;
      if (!parsed.confluence) {
        parsed.confluence = {
          enabled: false,
          baseUrl: "",
          spaces: "",
          hasToken: false,
        };
      }
      if (parsed.webResearchEnabled === undefined) {
        parsed.webResearchEnabled = false;
      }
      if (!parsed.x) {
        parsed.x = { enabled: false, hasToken: false };
      }
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return {
    dataDirWritable: true,
    workspaceName: null,
    workspaceRoots: [],
    providerLabel: "Ollama (local)",
    providerKind: "ollama",
    chatModel: "mistral",
    baseUrl: "http://127.0.0.1:11434",
    hasApiKey: false,
    localOnly: true,
    ollamaReachable: null,
    remoteReachable: null,
    confluence: {
      enabled: false,
      baseUrl: "",
      spaces: "",
      hasToken: false,
    },
    x: { enabled: false, hasToken: false },
    webResearchEnabled: false,
  };
}

export function useShellState() {
  const [branding, setBranding] = useState<BrandingDto>({
    name: "ContextDesk",
    slug: "contextdesk",
    tagline: "Developer knowledge workbench — find, synthesize, remember.",
    version: "0.1.0",
    protocol: "cd.v1",
  });
  const [theme, setTheme] = useState<SkinId>(loadTheme);
  const [uiScale, setUiScale] = useState<UiScale>(loadUiScale);
  const [sidebarW, setSidebarW] = useState(() => {
    const n = Number(localStorage.getItem("cd-sidebar-w"));
    if (Number.isFinite(n) && n >= 140 && n <= 420) return n;
    return 200;
  });
  const sidebarDragging = useRef(false);
  const [setup, setSetup] = useState<AppSetupState>(loadSetup);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("preflight");
  const [dismissedBanner, setDismissedBanner] = useState(
    () => sessionStorage.getItem("cd-setup-dismissed") === "1",
  );
  const autoOpenedPreflight = useRef(false);
  const [pane, setPane] = useState<PaneId>(() => {
    const p = localStorage.getItem("cd-pane");
    if (
      p === "memory" ||
      p === "compose" ||
      p === "source" ||
      p === "todos" ||
      p === "chat" ||
      p === "archive"
    ) {
      return p;
    }
    return "chat";
  });
  const [modelOptions, setModelOptions] = useState<ModelOptionDto[]>([]);
  const [defaultModelKey, setDefaultModelKey] = useState("");
  const [memoryDocs, setMemoryDocs] = useState<MemoryDoc[]>([]);
  const [memoryPath, setMemoryPath] = useState<string | null>(null);
  const [composition, setComposition] = useState<CompositionTarget | null>(null);
  const [composeNote, setComposeNote] = useState<string | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState("");
  const [hostPreflightReport, setHostPreflightReport] =
    useState<PreflightReport | null>(null);
  const chatScrollSaveRef = useRef(0);

  const clientPreflight = useMemo(() => runClientPreflight(setup), [setup]);
  const preflight = hostPreflightReport ?? clientPreflight;

  const refreshHostPreflight = useCallback(async () => {
    const report = await hostPreflight();
    if (!report) return;
    setHostPreflightReport({
      items: report.items.map((i) => ({
        id: i.id,
        title: i.title,
        level: i.level,
        detail: i.detail,
        fixAction:
          (i.fix_action as
            | "workspace"
            | "ai"
            | "connectors"
            | "general"
            | "appearance"
            | undefined) ?? undefined,
      })),
      hasBlocking: report.has_blocking,
    });
    if (setup.providerKind === "ollama") {
      const ok = await hostCheckOllama(setup.baseUrl);
      if (ok !== null) {
        setSetup((s) => ({ ...s, ollamaReachable: ok }));
      }
    }
  }, [setup.baseUrl, setup.providerKind]);

  const refreshMemory = useCallback(
    async (opts?: { kind?: string | null; includeSuperseded?: boolean }) => {
      try {
        // Prefer filtered durable list when filters requested
        if (opts?.includeSuperseded || opts?.kind) {
          try {
            const durable = await hostListDurableMemories({
              kind: opts.kind ?? null,
              includeSuperseded: opts.includeSuperseded ?? false,
              includeRetracted: false,
              limit: 200,
            });
            setMemoryDocs(
              durable.map((d) => ({
                path: d.source_id,
                title: d.title || d.kind,
                body: d.content,
                id: d.id,
                kind: d.kind,
                status: d.status,
                scope: d.scope,
              })),
            );
            if (durable.length && !memoryPath) {
              setMemoryPath(durable[0].source_id);
            }
            return;
          } catch {
            /* fall through */
          }
        }
        const files = await hostListMemory();
        setMemoryDocs(
          files.map((f) => {
            const ext = f as MemoryFileDto & {
              id?: string;
              kind?: string;
              status?: string;
              scope?: string;
            };
            return {
              path: f.path,
              title: f.title,
              body: f.body,
              id: ext.id,
              kind: ext.kind,
              status: ext.status,
              scope: ext.scope,
            };
          }),
        );
        if (files.length && !memoryPath) {
          setMemoryPath(files[0].path);
        }
      } catch {
        /* browser */
      }
    },
    [memoryPath],
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cd-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-ui-scale", uiScale);
    localStorage.setItem("cd-ui-scale", uiScale);
  }, [uiScale]);
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarW}px`);
    localStorage.setItem("cd-sidebar-w", String(sidebarW));
  }, [sidebarW]);
  useEffect(() => {
    localStorage.setItem("cd-pane", pane);
  }, [pane]);
  useEffect(() => {
    localStorage.setItem("cd-setup", JSON.stringify(setup));
  }, [setup]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDragging.current) return;
      setSidebarW(Math.min(420, Math.max(140, e.clientX)));
    };
    const onUp = () => {
      if (!sidebarDragging.current) return;
      sidebarDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    void hostGetBranding().then((b) => {
      setBranding(b);
      document.title = b.name;
    });
    void hostGetConfig().then((cfg) => {
      if (!cfg?.workspace) return;
      const roots = (cfg.workspace.roots ?? []).map(String);
      setSetup((s) => ({
        ...s,
        workspaceName: cfg.workspace?.name ?? s.workspaceName,
        workspaceRoots: roots.length ? roots : s.workspaceRoots,
      }));
    });
    // Prefer host-saved AI profile over localStorage ollama/mistral defaults.
    void hostGetActiveProvider().then((p) => {
      if (!p) return;
      const kind = p.kind as AppSetupState["providerKind"];
      if (
        kind !== "ollama" &&
        kind !== "openai_compatible" &&
        kind !== "anthropic" &&
        kind !== "xai_grok_build"
      ) {
        return;
      }
      setSetup((s) => ({
        ...s,
        providerKind: kind,
        providerLabel: p.label || s.providerLabel,
        baseUrl: p.base_url || s.baseUrl,
        chatModel: p.chat_model || s.chatModel,
        hasApiKey: p.has_key,
        localOnly: kind === "ollama",
      }));
    });
    void (async () => {
      try {
        const [listed, def] = await Promise.all([
          hostListChatModels(),
          hostGetDefaultChatModel(),
        ]);
        setModelOptions(listed);
        if (def?.trim()) setDefaultModelKey(def.trim());
      } catch {
        /* browser */
      }
    })();
    void refreshHostPreflight();
  }, [refreshHostPreflight]);

  useEffect(() => {
    void refreshHostPreflight();
  }, [setup.workspaceRoots, setup.providerKind, setup.chatModel]);

  useEffect(() => {
    if (setup.workspaceRoots.length > 0) {
      void refreshMemory();
    }
  }, [setup.workspaceRoots, refreshMemory]);

  useEffect(() => {
    if (!preflight.hasBlocking) {
      autoOpenedPreflight.current = false;
      return;
    }
    if (
      dismissedBanner ||
      settingsOpen ||
      autoOpenedPreflight.current ||
      sessionStorage.getItem("cd-setup-dismissed") === "1"
    ) {
      return;
    }
    autoOpenedPreflight.current = true;
    setSettingsSection("preflight");
    setSettingsOpen(true);
  }, [preflight.hasBlocking, dismissedBanner, settingsOpen]);

  const openSettings = useCallback(
    (section: SettingsSection = "preflight", scrollEl?: HTMLElement | null) => {
      if (scrollEl) {
        chatScrollSaveRef.current = scrollEl.scrollTop;
      }
      setSettingsSection(section);
      setSettingsOpen(true);
    },
    [],
  );

  const dismissSetupPrompt = useCallback(() => {
    sessionStorage.setItem("cd-setup-dismissed", "1");
    setDismissedBanner(true);
  }, []);

  const closeSettings = useCallback(
    (restoreScroll?: (top: number) => void) => {
      setSettingsOpen(false);
      if (preflight.hasBlocking) dismissSetupPrompt();
      const top = chatScrollSaveRef.current;
      window.requestAnimationFrame(() => restoreScroll?.(top));
    },
    [preflight.hasBlocking, dismissSetupPrompt],
  );

  const onSaveSetup = useCallback(
    async (next: AppSetupState) => {
      setSetup(next);
      try {
        await hostSetWorkspace(
          next.workspaceName ?? "Workspace",
          next.workspaceRoots,
        );
      } catch {
        /* browser */
      }
      void refreshHostPreflight();
    },
    [refreshHostPreflight],
  );

  const scopeLabel =
    setup.workspaceRoots.length > 0
      ? `${setup.workspaceRoots.length} root${setup.workspaceRoots.length === 1 ? "" : "s"}`
      : "No workspace";
  const localOnly = setup.localOnly ?? setup.providerKind === "ollama";
  const egressLabel = localOnly
    ? "Local-only"
    : setup.providerKind === "xai_grok_build"
      ? "Grok session"
      : setup.providerKind === "openai_compatible" ||
          setup.providerKind === "anthropic"
        ? "Remote AI"
        : "Local";

  const openComposition = useCallback(
    (target: CompositionTarget) => {
      setComposition(target);
      setComposeNote(null);
      setPane("compose");
    },
    [],
  );

  const openCompositionFromMemoryDoc = useCallback(
    (doc: MemoryDoc) => {
      // Empty path + no id → new scratch draft (Memory "New draft" CTA).
      if (!doc.id && !doc.path) {
        openComposition({
          kind: "scratch",
          title: doc.title || "Untitled draft",
          body: doc.body || "",
        });
        return;
      }
      if (doc.id || doc.path.startsWith("memory:")) {
        const id =
          doc.id ?? doc.path.replace(/^memory:/, "");
        openComposition({
          kind: "memory",
          id,
          sourceId: doc.path.startsWith("memory:")
            ? doc.path
            : `memory:${id}`,
          title: doc.title,
          body: doc.body,
          memKind: doc.kind ?? "project_note",
          scope: doc.scope ?? "workspace",
          status: doc.status,
        });
      } else {
        openComposition({
          kind: "file",
          path: doc.path,
          title: doc.title,
          body: doc.body,
        });
      }
    },
    [openComposition],
  );

  return {
    branding,
    theme,
    setTheme,
    uiScale,
    setUiScale,
    sidebarW,
    setSidebarW,
    sidebarDragging,
    setup,
    settingsOpen,
    settingsSection,
    dismissedBanner,
    pane,
    setPane,
    modelOptions,
    defaultModelKey,
    setDefaultModelKey,
    memoryDocs,
    memoryPath,
    setMemoryPath,
    composition,
    setComposition,
    composeNote,
    setComposeNote,
    composeBusy,
    setComposeBusy,
    openComposition,
    openCompositionFromMemoryDoc,
    sourcePath,
    setSourcePath,
    sourceContent,
    setSourceContent,
    hostPreflightReport,
    preflight,
    refreshHostPreflight,
    refreshMemory,
    openSettings,
    dismissSetupPrompt,
    closeSettings,
    onSaveSetup,
    scopeLabel,
    localOnly,
    egressLabel,
    chatScrollSaveRef,
  };
}
