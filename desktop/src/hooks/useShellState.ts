/**
 * Theme, UI scale, sidebar width, setup, settings modal, pane routing (#146).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsSection } from "../components/SettingsModal";
import {
  hostCheckOllama,
  hostGetBranding,
  hostGetConfig,
  hostGetDefaultChatModel,
  hostListChatModels,
  hostListMemory,
  hostPreflight,
  hostSetWorkspace,
  type BrandingDto,
  type ModelOptionDto,
} from "../lib/host";
import {
  runClientPreflight,
  type AppSetupState,
  type PreflightReport,
} from "../lib/preflight";
import type { MemoryDoc } from "../components/panes/MemoryPane";
import type { PaneId, UiScale } from "../lib/session";

function loadTheme(): "dark" | "light" {
  const t = localStorage.getItem("cd-theme");
  return t === "light" ? "light" : "dark";
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
  const [theme, setTheme] = useState<"dark" | "light">(loadTheme);
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

  const refreshMemory = useCallback(async () => {
    try {
      const files = await hostListMemory();
      setMemoryDocs(
        files.map((f) => ({
          path: f.path,
          title: f.title,
          body: f.body,
        })),
      );
      if (files.length && !memoryPath) {
        setMemoryPath(files[0].path);
      }
    } catch {
      /* browser */
    }
  }, [memoryPath]);

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
