/**
 * Composition root for the desktop shell (#146).
 * Thin wiring of session store, turn controller, shell state, and chrome.
 */
import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PermissionModal } from "./components/PermissionModal";
import { RenameChatModal } from "./components/RenameChatModal";
import { SettingsModal } from "./components/SettingsModal";
import { Banners } from "./components/shell/Banners";
import { ChatContextMenu } from "./components/shell/ChatContextMenu";
import { SessionSidebar } from "./components/shell/SessionSidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { Titlebar } from "./components/shell/Titlebar";
import { Workspace } from "./components/shell/Workspace";
import { useChatScroll } from "./hooks/useChatScroll";
import { useChatSessions } from "./hooks/useChatSessions";
import { useShellState } from "./hooks/useShellState";
import { useTurnController } from "./hooks/useTurnController";
import {
  hostSetDefaultChatModel,
  hostWriteMemory,
  modelSelectionKey,
  parseModelSelectionKey,
} from "./lib/host";
import { foldPreview } from "./lib/session";

export function App() {
  const shell = useShellState();
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
    setup: shell.setup,
    modelOptions: shell.modelOptions,
    defaultModelKey: shell.defaultModelKey,
    preflightBlocking: shell.preflight.hasBlocking,
    onNeedPreflight: () =>
      shell.openSettings("preflight", chatScrollRef.current),
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
    setSessions((all) =>
      all.map((s) =>
        s.id === resolvedSessionId
          ? { ...s, chatModel: modelId, providerProfileId: providerId }
          : s,
      ),
    );
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
              shell.openSettings("preflight", chatScrollRef.current)
            }
            onToggleTheme={() =>
              shell.setTheme((t) => (t === "dark" ? "light" : "dark"))
            }
          />
          <Banners
            setupIncomplete={shell.preflight.hasBlocking}
            dismissedBanner={shell.dismissedBanner}
            agentError={turn.agentError}
            onOpenPreflight={() =>
              shell.openSettings("preflight", chatScrollRef.current)
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
                    shell.openSettings(s ?? "preflight", chatScrollRef.current),
                  setSourcePath: shell.setSourcePath,
                  setSourceContent: shell.setSourceContent,
                }}
                memory={{
                  docs: shell.memoryDocs,
                  activePath: shell.memoryPath,
                  onSelect: shell.setMemoryPath,
                  onCreateHint: () => void shell.refreshMemory(),
                  onSave: (path, body) => {
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
              shell.openSettings("preflight", chatScrollRef.current)
            }
            onOpenWorkspace={() =>
              shell.openSettings("workspace", chatScrollRef.current)
            }
            onOpenAi={() => shell.openSettings("ai", chatScrollRef.current)}
          />
        </div>
      )}

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
