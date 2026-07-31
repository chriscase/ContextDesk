/**
 * Fixtures owned exclusively by visual/shell-settings.test.tsx.
 *
 * DTO shapes are copied/adapted from the reference unit suites so the visual
 * suite renders the same states the behavioural tests pin:
 * - ChatPane props builder: src/components/shell/ChatPane.empty.test.tsx:20-83
 * - AppSetupState + ProviderDto: src/components/SettingsModal.test.tsx:53-95
 * - ModelOptionDto factory: src/lib/modelCuration.contract.test.tsx:16-38
 * - PreflightReport: src/components/launch/PreLaunchScreen.test.tsx:67-90
 */
import { createRef } from "react";
import { vi } from "vitest";
import type { ChatPaneProps } from "../../src/components/shell/ChatPane";
import type { ChatSession, Msg } from "../../src/lib/session";
import type {
  BrandingDto,
  ModelOptionDto,
  ProviderDto,
} from "../../src/lib/host";
import type { AppSetupState, PreflightReport } from "../../src/lib/preflight";

export const branding: BrandingDto = {
  name: "ContextDesk",
  tagline: "Developer knowledge workbench",
  slug: "contextdesk",
  version: "0.1.0",
  protocol: "cd.v1",
  // Keep "dev": channel "installed" makes UpdateBanner dynamically import the
  // updater plugin (updatePoll.ts), which is unmockable here.
  channel: "dev",
};

/** Ollama setup — providerKind "ollama" puts AiSection in ADVANCED mode. */
export function appSetup(): AppSetupState {
  return {
    dataDirWritable: true,
    workspaceName: "Workspace",
    workspaceRoots: ["/workspace"],
    providerLabel: "Local model",
    providerKind: "ollama",
    chatModel: "mistral",
    baseUrl: "http://127.0.0.1:11434",
    hasApiKey: false,
    toolsEnabled: true,
    localOnly: true,
    ollamaReachable: true,
    remoteReachable: null,
    confluence: {
      enabled: false,
      baseUrl: "",
      spaces: "",
      hasToken: false,
      writeEnabled: false,
    },
    x: { enabled: false, hasToken: false },
    webResearchEnabled: false,
  };
}

export function activeProviderDto(): ProviderDto {
  return {
    id: "ollama-local",
    kind: "ollama",
    base_url: "http://127.0.0.1:11434",
    chat_model: "mistral",
    label: "Local model",
    api_key_ref: null,
    has_key: false,
    tools_enabled: true,
    deadline_preference: "auto",
  };
}

/**
 * Deterministic transcript: 8 alternating user/assistant turns, long enough
 * that six visible rows overflow a ~600px scrollport (the fold keeps the last
 * six when compact_keep_last is 6 and showFullHistory is false).
 */
export function transcriptMessages(): Msg[] {
  const paragraphs = (n: number) =>
    [
      `Looking at window ${n}: the ingest worker retries climb right after the deploy marker, and the p95 latency for the same route doubles inside two minutes.`,
      `The queue depth graph shows the same knee. Nothing in the error log is new — the failures are all the existing timeout class, just at a much higher rate than the previous window.`,
      `If we normalize by request volume the anomaly survives, so this is not a traffic artifact.`,
    ].join("\n\n");
  const asks = [
    "Where does the latency spike start in this log window?",
    "Does the retry storm correlate with the deploy at 02:10?",
    "Summarize what changed between window 3 and window 4.",
    "Which service should we page for the queue backlog?",
  ];
  const msgs: Msg[] = [];
  for (let i = 0; i < 4; i += 1) {
    msgs.push({
      id: `m-user-${i + 1}`,
      role: "user",
      content: asks[i]!,
    });
    msgs.push({
      id: `m-assistant-${i + 1}`,
      role: "assistant",
      content: paragraphs(i + 1),
    });
  }
  return msgs;
}

export function chatSession(
  messages: Msg[],
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id: "s-visual",
    title: messages.length > 0 ? "Log triage deep dive" : "New chat",
    messages,
    compactKeepLast: 6,
    showFullHistory: false,
    titleLocked: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    trashed: false,
    trashedAt: null,
    pinned: false,
    chatModel: null,
    providerProfileId: null,
    lastReadMessageId: null,
    pinnedSkillId: null,
    linkedCorpusId: null,
    ...overrides,
  };
}

/** Fully-typed ChatPane props (the reference builder is untyped Record). */
export function chatPaneProps(
  overrides: Partial<ChatPaneProps> = {},
): ChatPaneProps {
  const session = chatSession([]);
  return {
    branding,
    openChatSessions: [session],
    resolvedSessionId: session.id,
    messages: [],
    visibleMessages: [],
    isFolded: false,
    hiddenCount: 0,
    compactKeep: 6,
    hiddenPreview: "",
    showFullHistory: false,
    setShowFullHistory: vi.fn(),
    openChatCtxMenu: vi.fn(),
    createSession: vi.fn(),
    setPane: vi.fn(),
    chatScrollRef: createRef<HTMLDivElement>(),
    onChatScroll: vi.fn(),
    showJumpToLatest: false,
    hasNewResponseBelow: false,
    scrollChatToBottom: vi.fn(),
    busy: false,
    turnStartedAt: null,
    effectiveChatModel: null,
    effectiveModelKey: "default",
    modelOptions: [],
    setSessionModel: vi.fn(),
    setAppDefaultModel: vi.fn(),
    onSubmit: vi.fn(async () => true),
    onStop: vi.fn(),
    preflightBlocking: false,
    openSettings: vi.fn(),
    setSourcePath: vi.fn(),
    setSourceContent: vi.fn(),
    ...overrides,
  };
}

/** ModelOptionDto factory — mirror of modelCuration.contract.test.tsx:16-38. */
export function modelOption(
  provider: string,
  id: string,
  overrides: Partial<ModelOptionDto> = {},
): ModelOptionDto {
  return {
    id,
    label: id,
    selection_key: `${provider}::${id}`,
    provider_id: provider,
    provider_label: provider === "ollama" ? "Ollama (local)" : "Gateway",
    group: provider === "ollama" ? "Ollama (local)" : "Gateway",
    is_default: false,
    tools_enabled: true,
    tools_disabled_reason: null,
    availability: "discovered",
    availability_detail: null,
    hidden: false,
    hidden_by: null,
    pinned_rank: null,
    ...overrides,
  };
}

/**
 * Long curated inventory for the Manage… dialog: 40 models total, of which
 * 1 is pinned (the default) and 2 are hidden — matching the mocked
 * get_curation_summary of { hidden: 2, pinned: 1 }. Visible rows = 38.
 */
export function modelInventory(): ModelOptionDto[] {
  const inventory: ModelOptionDto[] = [
    modelOption("ollama", "mistral", { is_default: true, pinned_rank: 0 }),
    modelOption("ollama", "llama3.1"),
    modelOption("ollama", "qwen2.5"),
    modelOption("gw", "legacy-chat-a", { hidden: true, hidden_by: "model" }),
    modelOption("gw", "legacy-chat-b", { hidden: true, hidden_by: "model" }),
  ];
  for (let i = 1; i <= 35; i += 1) {
    inventory.push(
      modelOption("gw", `gateway-model-${String(i).padStart(2, "0")}`),
    );
  }
  return inventory;
}

/**
 * Pre-launch preflight. Launch-critical rows are the provider/workspace
 * items; memory.store (warn) is a work-context row only.
 */
export function launchPreflight(blocking: boolean): PreflightReport {
  const items: PreflightReport["items"] = [
    {
      id: "workspace.roots",
      title: "Workspace roots",
      level: "pass",
      detail: "One allowlisted root.",
    },
    {
      id: "provider.active",
      title: "AI provider",
      level: "pass",
      detail: "Local model via Ollama.",
    },
    {
      id: "memory.store",
      title: "Memory",
      level: "warn",
      detail: "Optional memory setup.",
      fixAction: "connectors",
    },
  ];
  if (blocking) {
    items.push({
      id: "provider.key",
      title: "Provider credentials",
      level: "fail",
      detail: "The saved key was rejected by the gateway.",
      fixAction: "ai",
    });
  }
  return { items, hasBlocking: blocking };
}
