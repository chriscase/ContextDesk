/**
 * Composition root for the desktop shell (#146).
 * Thin wiring of session store, turn controller, shell state, and chrome.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CommandPalette } from "./components/CommandPalette";
import { PermissionModal } from "./components/PermissionModal";
import { RenameChatModal } from "./components/RenameChatModal";
import { SettingsModal } from "./components/SettingsModal";
import { Banners } from "./components/shell/Banners";
import { UpdateBanner } from "./components/shell/UpdateBanner";
import { ChatContextMenu } from "./components/shell/ChatContextMenu";
import { SessionSidebar } from "./components/shell/SessionSidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { Titlebar } from "./components/shell/Titlebar";
import { Workspace } from "./components/shell/Workspace";
import { useChatScroll } from "./hooks/useChatScroll";
import { useChatSessions } from "./hooks/useChatSessions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useShellState } from "./hooks/useShellState";
import { useTurnController } from "./hooks/useTurnController";
import {
  hostGetDurableMemory,
  hostSaveCompositionDraft,
  hostSetDefaultChatModel,
  hostWriteMemory,
  modelSelectionKey,
  parseModelSelectionKey,
} from "./lib/host";
import type { CompositionTarget } from "./components/panes/CompositionPane";
import type { PaletteItem } from "./lib/commandPalette";
import { foldPreview, nowIso } from "./lib/session";
import { nextSkinId } from "./lib/skins";
import { SplashScreen } from "./components/launch/SplashScreen";
import { ContextDeskMark } from "./components/launch/ContextDeskMark";
import { IdentityPhase } from "./components/launch/IdentityPhase";
import { PreLaunchScreen } from "./components/launch/PreLaunchScreen";
import { hostSaveActiveProvider } from "./lib/host";
import { saveLastGatewayUrl } from "./lib/aiGatewayPrefs";
import type { WizardApplyPayload } from "./components/settings/AiSetupWizard";
import { shouldSkipSplash } from "./components/launch/splashDuration";

export function App() {
  const shell = useShellState();

  // Dev/screenshot: skip splash without setState during render
  useEffect(() => {
    if (
      shell.launchPhase === "splash" &&
      shouldSkipSplash(window.location.search)
    ) {
      shell.completeSplash();
    }
  }, [shell.launchPhase, shell.completeSplash]);
  const sessionsApi = useChatSessions();
  const {
    sessions,
    setSessions,
    sessionsReady,
    setActiveSessionId,
    resolvedSessionId,
    activeSession,
    messages,
    sessionId,
    openChatSessions,
    persistSession,
    upgradeTitleWithLlm,
    createSession,
    ensureActiveSession,
    applyRename,
    togglePinById,
    trashSessionById,
    openSessionById,
    setShowFullHistory,
    syncSessionsFromHost,
  } = sessionsApi;

  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [chatCtxMenu, setChatCtxMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const compactKeep = activeSession?.compactKeepLast ?? 6;
  const showFullHistory = activeSession?.showFullHistory ?? false;
  const isFolded = !showFullHistory && messages.length > compactKeep;
  const hiddenCount = isFolded ? messages.length - compactKeep : 0;
  const visibleMessages = isFolded ? messages.slice(-compactKeep) : messages;
  const hiddenPreview = isFolded ? foldPreview(messages, compactKeep) : "";

  const scroll = useChatScroll(messages, sessionId, setSessions);
  const {
    chatScrollRef,
    stickToBottomRef,
    unreadBelow,
    pinScrollToEnd,
    scrollChatToBottom,
    onChatScroll,
  } = scroll;

  const turn = useTurnController({
    sessionId,
    resolvedSessionId,
    sessions,
    setSessions,
    ensureActiveSession,
    setup: shell.setup,
    modelOptions: shell.modelOptions,
    defaultModelKey: shell.defaultModelKey,
    preflightBlocking: shell.preflight.hasBlocking,
    onNeedPreflight: () =>
      shell.openSettings("health", chatScrollRef.current),
    persistSession,
    upgradeTitleWithLlm,
    pinScrollToEnd,
    refreshMemory: shell.refreshMemory,
    setSourcePath: shell.setSourcePath,
    setSourceContent: shell.setSourceContent,
    setPaneChat: () => shell.setPane("chat"),
  });

  const effectiveModelKey = (() => {
    if (activeSession?.chatModel && activeSession.providerProfileId) {
      return modelSelectionKey(
        activeSession.providerProfileId,
        activeSession.chatModel,
      );
    }
    if (activeSession?.chatModel) {
      const hit = shell.modelOptions.find(
        (m) => m.id === activeSession.chatModel,
      );
      if (hit) return hit.selection_key;
    }
    return (
      shell.defaultModelKey ||
      shell.modelOptions.find((m) => m.is_default)?.selection_key ||
      shell.modelOptions[0]?.selection_key ||
      ""
    );
  })();
  const effectiveChatModel =
    activeSession?.chatModel ||
    parseModelSelectionKey(effectiveModelKey).modelId ||
    shell.setup.chatModel;

  const setSessionModel = (key: string) => {
    const { providerId, modelId } = parseModelSelectionKey(key);
    // Ensure a chat exists so model selection sticks before first message.
    const target = ensureActiveSession();
    const sid = target.id;
    setSessions((all) => {
      const exists = all.some((s) => s.id === sid);
      if (!exists) {
        return [
          {
            ...target,
            chatModel: modelId,
            providerProfileId: providerId,
          },
          ...all,
        ];
      }
      return all.map((s) =>
        s.id === sid
          ? { ...s, chatModel: modelId, providerProfileId: providerId }
          : s,
      );
    });
  };

  const openChatCtxMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setChatCtxMenu({ x: e.clientX, y: e.clientY, sessionId: id });
  };
  useEffect(() => {
    if (!chatCtxMenu) return;
    const close = () => setChatCtxMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [chatCtxMenu]);

  const ctxTarget = chatCtxMenu
    ? sessions.find((s) => s.id === chatCtxMenu.sessionId)
    : null;

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const switchSessionByDelta = useCallback(
    (delta: number) => {
      if (openChatSessions.length === 0) return;
      const idx = Math.max(
        0,
        openChatSessions.findIndex((s) => s.id === resolvedSessionId),
      );
      const next =
        (idx + delta + openChatSessions.length) % openChatSessions.length;
      setActiveSessionId(openChatSessions[next]!.id);
      shell.setPane("chat");
    },
    [openChatSessions, resolvedSessionId, setActiveSessionId, shell],
  );

  const paletteItems: PaletteItem[] = useMemo(() => {
    const actions: PaletteItem[] = [
      {
        id: "action:new-chat",
        label: "New chat",
        keywords: ["create", "n"],
        group: "action",
      },
      {
        id: "action:settings",
        label: "Open Settings",
        keywords: [",", "health"],
        group: "action",
      },
      {
        id: "action:rename",
        label: "Rename current chat",
        keywords: ["f2"],
        group: "action",
      },
      {
        id: "action:archive",
        label: "Open archive",
        group: "action",
      },
    ];
    const sessionItems: PaletteItem[] = openChatSessions.map((s) => ({
      id: `session:${s.id}`,
      label: s.title,
      detail: s.pinned ? "pinned" : undefined,
      group: "session" as const,
    }));
    return [...actions, ...sessionItems];
  }, [openChatSessions]);

  const onPaletteSelect = useCallback(
    (id: string) => {
      setPaletteOpen(false);
      if (id === "action:new-chat") {
        createSession();
        shell.setPane("chat");
        return;
      }
      if (id === "action:settings") {
        shell.openSettings("health", chatScrollRef.current);
        return;
      }
      if (id === "action:rename" && activeSession) {
        setRenameTarget({ id: activeSession.id, title: activeSession.title });
        return;
      }
      if (id === "action:archive") {
        shell.setPane("archive");
        return;
      }
      if (id.startsWith("session:")) {
        const sid = id.slice("session:".length);
        setActiveSessionId(sid);
        shell.setPane("chat");
      }
    },
    [createSession, shell, chatScrollRef, activeSession, setActiveSessionId],
  );

  useKeyboardShortcuts({
    onNewChat: () => {
      createSession();
      shell.setPane("chat");
    },
    onOpenPalette: openPalette,
    onOpenSettings: () =>
      shell.openSettings("health", chatScrollRef.current),
    onPrevSession: () => switchSessionByDelta(-1),
    onNextSession: () => switchSessionByDelta(1),
    onSessionByIndex: (i) => {
      const s = openChatSessions[i];
      if (s) {
        setActiveSessionId(s.id);
        shell.setPane("chat");
      }
    },
    onRenameActive: () => {
      if (activeSession) {
        setRenameTarget({ id: activeSession.id, title: activeSession.title });
      }
    },
    onEscape: closePalette,
    paletteOpen,
    settingsOpen: shell.settingsOpen,
    permissionOpen: Boolean(turn.permission),
  });

  const applyAiFromLaunch = async (payload: WizardApplyPayload) => {
    const key = payload.apiKey ?? "";
    let next = { ...shell.setup, ...payload.setup };
    if (
      next.providerKind === "openai_compatible" ||
      next.providerKind === "anthropic"
    ) {
      saveLastGatewayUrl(next.baseUrl);
    }
    if (next.providerKind !== "none") {
      try {
        const saved = await hostSaveActiveProvider({
          kind: next.providerKind,
          baseUrl: next.baseUrl,
          chatModel: next.chatModel,
          label: next.providerLabel ?? undefined,
          apiKey:
            next.providerKind === "xai_grok_build"
              ? undefined
              : key.trim() || undefined,
          localOnly:
            next.providerKind === "xai_grok_build"
              ? false
              : (next.localOnly ?? next.providerKind === "ollama"),
          toolsEnabled: next.toolsEnabled,
        });
        if (saved) {
          next = {
            ...next,
            hasApiKey: saved.has_key,
            baseUrl: saved.base_url,
            chatModel: saved.chat_model,
            providerLabel: saved.label,
            toolsEnabled: saved.tools_enabled ?? next.toolsEnabled ?? true,
          };
        }
      } catch {
        /* host may be browser stub */
      }
    }
    shell.onSaveSetup(next);
    await shell.refreshHostPreflight();
  };

  if (shell.launchPhase === "splash") {
    if (shouldSkipSplash(window.location.search)) {
      return (
        <div className="launch-root" aria-busy>
          <IdentityPhase onSelected={() => shell.completeIdentity()} auto />
        </div>
      );
    }
    return (
      <SplashScreen
        icon={<ContextDeskMark size={120} />}
        title={shell.branding.name}
        tagline={
          shell.branding.tagline || "Your workspace, remembered."
        }
        company="Open source"
        accentColor="#4a9eff"
        onComplete={shell.completeSplash}
      />
    );
  }

  if (shell.launchPhase === "identity") {
    return (
      <div className="launch-root">
        <IdentityPhase onSelected={() => shell.completeIdentity()} auto />
      </div>
    );
  }

  if (shell.launchPhase === "prelaunch") {
    if (shell.settingsOpen) {
      return (
        <div className="app-shell">
          <SettingsModal
            open
            initialSection={shell.settingsSection}
            setup={shell.setup}
            theme={shell.theme}
            onThemeChange={shell.setTheme}
            uiScale={shell.uiScale}
            onUiScaleChange={shell.setUiScale}
            onClose={() => shell.closeSettings(() => {})}
            onSaveSetup={shell.onSaveSetup}
            onRecheckHost={shell.refreshHostPreflight}
            hostReport={shell.hostPreflightReport}
          />
        </div>
      );
    }
    return (
      <PreLaunchScreen
        productName={shell.branding.name}
        tagline={
          shell.branding.tagline ||
          "Find, synthesize, remember — without config files."
        }
        setup={shell.setup}
        preflight={shell.preflight}
        onSaveSetup={shell.onSaveSetup}
        onApplyAi={applyAiFromLaunch}
        onRecheck={shell.refreshHostPreflight}
        onEnterApp={shell.enterAppFromPrelaunch}
        onOpenSettings={(sec) =>
          shell.openSettings(
            (sec as "workspace" | "ai" | "connectors" | "health") || "health",
          )
        }
      />
    );
  }

  return (
    <div className="app-shell">
      {shell.settingsOpen ? (
        <SettingsModal
          open={shell.settingsOpen}
          initialSection={shell.settingsSection}
          setup={shell.setup}
          theme={shell.theme}
          onThemeChange={shell.setTheme}
          uiScale={shell.uiScale}
          onUiScaleChange={shell.setUiScale}
          onClose={() =>
            shell.closeSettings((top) => {
              const el = chatScrollRef.current;
              if (!el) return;
              el.scrollTop = top;
              stickToBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
            })
          }
          onSaveSetup={shell.onSaveSetup}
          onRecheckHost={shell.refreshHostPreflight}
          hostReport={shell.hostPreflightReport}
        />
      ) : (
        <div className="app-chrome">
          <Titlebar
            productName={shell.branding.name}
            scopeLabel={shell.scopeLabel}
            egressLabel={shell.egressLabel}
            localOnly={shell.localOnly}
            hasWorkspace={shell.setup.workspaceRoots.length > 0}
            theme={shell.theme}
            onOpenWorkspace={() =>
              shell.openSettings("workspace", chatScrollRef.current)
            }
            onOpenAi={() => shell.openSettings("ai", chatScrollRef.current)}
            onOpenSettings={() =>
              shell.openSettings("health", chatScrollRef.current)
            }
            onToggleTheme={() => shell.setTheme((t) => nextSkinId(t))}
          />
          <UpdateBanner branding={shell.branding} />
          <Banners
            setupIncomplete={shell.preflight.hasBlocking}
            dismissedBanner={shell.dismissedBanner}
            agentError={turn.agentError}
            appVersion={shell.branding.version}
            channel={shell.branding.channel}
            gitSha={shell.branding.git_sha}
            identityLine={shell.branding.identity_line}
            onOpenPreflight={() =>
              shell.openSettings("health", chatScrollRef.current)
            }
            onDismissSetup={shell.dismissSetupPrompt}
            onDismissError={() => turn.setAgentError(null)}
          />
          <div className="app-body">
            <div className="main">
              <SessionSidebar
                sessionsReady={sessionsReady}
                openChatSessions={openChatSessions}
                activeSessionId={resolvedSessionId}
                sidebarW={shell.sidebarW}
                onCreate={() => {
                  createSession();
                  shell.setPane("chat");
                }}
                onSelect={(id) => {
                  setActiveSessionId(id);
                  shell.setPane("chat");
                }}
                onContextMenu={openChatCtxMenu}
                onResizeStart={(e) => {
                  e.preventDefault();
                  shell.sidebarDragging.current = true;
                  document.body.style.cursor = "col-resize";
                  document.body.style.userSelect = "none";
                }}
                onResizeKey={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    shell.setSidebarW((w) => Math.max(140, w - 16));
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    shell.setSidebarW((w) => Math.min(420, w + 16));
                  }
                }}
                onOpenArchive={() => shell.setPane("archive")}
                archiveActive={shell.pane === "archive"}
              />
              <Workspace
                pane={shell.pane}
                onPaneChange={shell.setPane}
                archive={{
                  refreshKey: archiveRefreshKey,
                  activeSessionId: resolvedSessionId,
                  onOpenSession: (id) => {
                    void openSessionById(id);
                    shell.setPane("chat");
                  },
                  onSessionsChanged: () => {
                    setArchiveRefreshKey((n) => n + 1);
                    void syncSessionsFromHost();
                  },
                }}
                chat={{
                  branding: shell.branding,
                  openChatSessions,
                  resolvedSessionId,
                  messages,
                  visibleMessages,
                  isFolded,
                  hiddenCount,
                  compactKeep,
                  hiddenPreview,
                  showFullHistory,
                  setShowFullHistory,
                  setActiveSessionId,
                  openChatCtxMenu,
                  createSession: () => {
                    createSession();
                  },
                  setPane: (p) => shell.setPane(p),
                  chatScrollRef,
                  onChatScroll,
                  unreadBelow,
                  scrollChatToBottom,
                  busy: turn.busy,
                  turnStartedAt: turn.turnStartedAt,
                  effectiveChatModel,
                  effectiveModelKey,
                  modelOptions: shell.modelOptions,
                  setSessionModel,
                  setAppDefaultModel: (k) => {
                    void hostSetDefaultChatModel(k).then(() =>
                      shell.setDefaultModelKey(k),
                    );
                  },
                  onSubmit: turn.startTurn,
                  onStop: turn.stopTurn,
                  preflightBlocking: shell.preflight.hasBlocking,
                  openSettings: (s) =>
                    shell.openSettings(s ?? "health", chatScrollRef.current),
                  setSourcePath: shell.setSourcePath,
                  setSourceContent: shell.setSourceContent,
                  pinnedSkillId: activeSession?.pinnedSkillId ?? null,
                  onPinnedSkillChange: (skillId) => {
                    if (!resolvedSessionId) return;
                    setSessions((all) => {
                      const next = all.map((s) =>
                        s.id === resolvedSessionId
                          ? { ...s, pinnedSkillId: skillId, updatedAt: nowIso() }
                          : s,
                      );
                      const cur = next.find((s) => s.id === resolvedSessionId);
                      if (cur) void persistSession(cur);
                      return next;
                    });
                  },
                  setMemoryPath: shell.setMemoryPath,
                  openCompositionFromMemoryId: (sourceId) => {
                    const id = sourceId.replace(/^memory:/, "");
                    void hostGetDurableMemory(id).then((m) => {
                      if (!m) {
                        shell.setMemoryPath(sourceId);
                        shell.setPane("memory");
                        return;
                      }
                      shell.openComposition({
                        kind: "memory",
                        id: m.id,
                        sourceId: m.source_id,
                        title: m.title,
                        body: m.content,
                        memKind: m.kind,
                        scope: m.scope,
                        status: m.status,
                      });
                    });
                  },
                }}
                memory={{
                  docs: shell.memoryDocs,
                  activePath: shell.memoryPath,
                  onSelect: shell.setMemoryPath,
                  onCreateHint: () => void shell.refreshMemory(),
                  onFilterChange: (opts) =>
                    void shell.refreshMemory({
                      kind: opts.kind,
                      includeSuperseded: opts.includeSuperseded,
                    }),
                  onCompose: (doc) => shell.openCompositionFromMemoryDoc(doc),
                  onSave: (path, body) => {
                    if (path.startsWith("memory:")) {
                      return;
                    }
                    const title =
                      shell.memoryDocs.find((d) => d.path === path)?.title ??
                      "Note";
                    const base =
                      path.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ??
                      "note";
                    void hostWriteMemory(base, title, body)
                      .then(() => shell.refreshMemory())
                      .catch((err) =>
                        turn.setAgentError(
                          err instanceof Error ? err.message : String(err),
                        ),
                      );
                  },
                }}
                compose={{
                  target: shell.composition,
                  onChangeTarget: shell.setComposition,
                  busy: shell.composeBusy,
                  note: shell.composeNote,
                  onOpenMemory: (sourceId) => {
                    shell.setMemoryPath(sourceId);
                    shell.setPane("memory");
                  },
                  onBrowseMemory: () => {
                    shell.setPane("memory");
                  },
                  onSave: async (t: CompositionTarget) => {
                    shell.setComposeBusy(true);
                    shell.setComposeNote(null);
                    try {
                      if (t.kind === "file") {
                        const base =
                          t.path.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ??
                          "note";
                        await hostWriteMemory(base, t.title, t.body);
                        shell.setComposeNote("Saved workspace file.");
                        void shell.refreshMemory();
                        return;
                      }
                      const saved = await hostSaveCompositionDraft({
                        content: t.body,
                        title: t.title,
                        kind:
                          t.kind === "memory"
                            ? t.memKind
                            : (t.memKind ?? "project_note"),
                        scope: t.kind === "memory" ? t.scope : "workspace",
                        supersedeId: t.kind === "memory" ? t.id : null,
                      });
                      shell.setComposition({
                        kind: "memory",
                        id: saved.id,
                        sourceId: saved.source_id,
                        title: saved.title,
                        body: saved.content,
                        memKind: saved.kind,
                        scope: saved.scope,
                        status: saved.status,
                      });
                      shell.setComposeNote(
                        t.kind === "scratch"
                          ? "Saved as durable memory."
                          : "Saved (superseded prior revision).",
                      );
                      void shell.refreshMemory();
                    } catch (err) {
                      shell.setComposeNote(
                        err instanceof Error ? err.message : String(err),
                      );
                      throw err;
                    } finally {
                      shell.setComposeBusy(false);
                    }
                  },
                }}
                source={{
                  path: shell.sourcePath,
                  content: shell.sourceContent,
                }}
                todosKey={sessionId ? `cd-todos-${sessionId}` : null}
              />
            </div>
          </div>
          <StatusBar
            busy={turn.busy}
            setupIncomplete={shell.preflight.hasBlocking}
            scopeLabel={shell.scopeLabel}
            egressLabel={shell.egressLabel}
            effectiveChatModel={effectiveChatModel}
            onOpenPreflight={() =>
              shell.openSettings("health", chatScrollRef.current)
            }
            onOpenWorkspace={() =>
              shell.openSettings("workspace", chatScrollRef.current)
            }
            onOpenAi={() => shell.openSettings("ai", chatScrollRef.current)}
          />
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        items={paletteItems}
        onClose={closePalette}
        onSelect={onPaletteSelect}
      />
      <PermissionModal
        prompt={turn.permission}
        onRespond={turn.respondPermission}
      />
      <RenameChatModal
        open={Boolean(renameTarget)}
        initialTitle={renameTarget?.title ?? ""}
        onCancel={() => setRenameTarget(null)}
        onConfirm={(t) => {
          if (renameTarget) void applyRename(renameTarget.id, t);
          setRenameTarget(null);
        }}
      />
      {chatCtxMenu && ctxTarget ? (
        <ChatContextMenu
          x={chatCtxMenu.x}
          y={chatCtxMenu.y}
          target={ctxTarget}
          onOpen={() => {
            setChatCtxMenu(null);
            setActiveSessionId(ctxTarget.id);
            shell.setPane("chat");
          }}
          onRename={() => {
            setChatCtxMenu(null);
            setRenameTarget({ id: ctxTarget.id, title: ctxTarget.title });
          }}
          onTogglePin={() => {
            setChatCtxMenu(null);
            void togglePinById(ctxTarget.id);
          }}
          onArchive={() => {
            setChatCtxMenu(null);
            shell.setPane("archive");
          }}
          onTrash={() => {
            setChatCtxMenu(null);
            void trashSessionById(ctxTarget.id);
          }}
        />
      ) : null}
    </div>
  );
}
