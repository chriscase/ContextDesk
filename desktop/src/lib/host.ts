/** Host bridge: Tauri invoke when available; offline research via test hook. */

import type { AppSetupState } from "./preflight";

export type EventDto = {
  kind: string;
  payload: Record<string, unknown>;
};

export type PreflightItemDto = {
  id: string;
  title: string;
  level: "pass" | "warn" | "fail";
  detail: string;
  fix_action?: string | null;
};

export type PreflightReportDto = {
  items: PreflightItemDto[];
  has_blocking: boolean;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Open an http(s) URL in the **system** default browser.
 * In Tauri, `window.open` does not launch the OS browser — host IPC does.
 */
export async function hostOpenExternalUrl(url: string): Promise<void> {
  const u = url.trim();
  if (!u) return;
  if (!isTauri()) {
    window.open(u, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke<void>("open_external_url", { url: u });
}

export type BrandingDto = {
  name: string;
  slug: string;
  tagline: string;
  version: string;
  protocol: string;
};

/** Product identity from Rust host / branding.toml (fallback for browser-only). */
export async function hostGetBranding(): Promise<BrandingDto> {
  if (!isTauri()) {
    return {
      name: "ContextDesk",
      slug: "contextdesk",
      tagline: "Developer knowledge workbench — find, synthesize, remember.",
      version: "0.1.0",
      protocol: "cd.v1",
    };
  }
  return invoke<BrandingDto>("get_branding");
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

/**
 * Run research turn — real agent path via Tauri host.
 *
 * In Tauri: streams each EventDto through a Channel as produced (#108);
 * `onEvent` is invoked per message, and the returned array is the full
 * collected sequence (resolves after the host command completes).
 *
 * Browser / cd-server fallback: batched HTTP only (no Channel) — still
 * calls `onEvent` once per event after the batch arrives, then resolves.
 */
export async function agentTurn(
  sessionId: string,
  text: string,
  forceLocal = false,
  chatModel?: string | null,
  providerProfileId?: string | null,
  onEvent?: (ev: EventDto) => void,
): Promise<EventDto[]> {
  const req = {
    session_id: sessionId,
    text,
    force_local: forceLocal,
    chat_model: chatModel?.trim() || null,
    provider_profile_id: providerProfileId?.trim() || null,
  };

  if (!isTauri()) {
    // Browser-only: batched path via local server if present (no Channel).
    try {
      const r = await fetch("http://127.0.0.1:8787/v1/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "default",
          query: text,
          session_id: sessionId,
          force_local: true,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        const events = (j.events as EventDto[]) ?? [];
        for (const ev of events) {
          onEvent?.(ev);
        }
        return events;
      }
    } catch {
      /* fall through */
    }
    throw new Error(
      "Agent host unavailable. Run via `npm run tauri:dev` or start cd-server on :8787.",
    );
  }

  const { Channel, invoke: inv } = await import("@tauri-apps/api/core");
  const collected: EventDto[] = [];
  // Tauri 2 Channel: host sends EventDto as each stream event is produced.
  const channel = new Channel<EventDto>((ev) => {
    collected.push(ev);
    onEvent?.(ev);
  });
  await inv<void>("agent_turn", {
    req,
    onEvent: channel,
  });
  return collected;
}

/** Cooperative cancel for an in-flight agent turn (#109). */
export async function hostCancelTurn(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("cancel_turn", { sessionId });
}

export async function completePermission(
  requestId: string,
  decision: "deny" | "allow_once" | "allow_session_path",
  toolName: string,
  argumentsJson: Record<string, unknown>,
  typed?: string,
  sessionId?: string | null,
): Promise<EventDto[]> {
  if (!isTauri()) {
    throw new Error("Permission grants require Tauri host");
  }
  return invoke<EventDto[]>("complete_permission_cmd", {
    req: {
      request_id: requestId,
      decision,
      typed: typed ?? null,
      tool_name: toolName,
      arguments: argumentsJson,
      // So grant outcome is appended to this session's model history (#111).
      session_id: sessionId?.trim() || null,
    },
  });
}

export async function hostPreflight(): Promise<PreflightReportDto | null> {
  if (!isTauri()) return null;
  return invoke<PreflightReportDto>("run_preflight_cmd");
}

export async function hostCheckOllama(baseUrl: string): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("check_ollama", { baseUrl });
}

export async function hostSetWorkspace(
  name: string,
  roots: string[],
): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_workspace_roots", { name, roots });
}

export type HostConfigDto = {
  workspace?: { id: string; name: string; roots: string[] } | null;
  theme?: string;
};

/** Load non-secret app config from host (hydrate workspace roots). */
export async function hostGetConfig(): Promise<HostConfigDto | null> {
  if (!isTauri()) return null;
  return invoke<HostConfigDto>("get_config");
}

/** Workspace connector registry entry (#127). No secrets. */
export type ConnectorDto = {
  id: string;
  kind: string;
  enabled: boolean;
  label: string;
  /** Non-secret kind settings (MCP command/args, etc.). */
  settings?: Record<string, unknown>;
  /** Tools discovered after host attach (MCP names like mcp__server__tool). */
  discovered_tools?: string[];
};

export async function hostListConnectors(): Promise<ConnectorDto[]> {
  if (!isTauri()) return [];
  return invoke<ConnectorDto[]>("list_connectors");
}

export async function hostListConnectorKinds(): Promise<string[]> {
  if (!isTauri()) {
    return [
      "files",
      "memory",
      "sqlite",
      "postgres",
      "mcp",
      "http",
      "confluence",
    ];
  }
  return invoke<string[]>("list_connector_kinds");
}

/** Store connector secret in keychain (Postgres password). Bool-only status via has. */
export async function hostSetConnectorSecret(
  connectorId: string,
  kind: "postgres_password" | "password" | "http_bearer" | "bearer",
  secret: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_connector_secret", {
    connectorId,
    kind,
    secret,
  });
}

export async function hostConnectorHasSecret(
  connectorId: string,
  kind:
    | "postgres_password"
    | "password"
    | "http_bearer"
    | "bearer" = "postgres_password",
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("connector_has_secret", { connectorId, kind });
}

/** Persist connector list (id/kind/enabled/settings only). Rebuilds host. */
export async function hostSaveConnectors(
  connectors: {
    id: string;
    kind: string;
    enabled: boolean;
    settings?: unknown;
  }[],
): Promise<ConnectorDto[]> {
  if (!isTauri()) {
    return connectors.map((c) => ({
      id: c.id,
      kind: c.kind,
      enabled: c.enabled,
      label: c.kind,
      settings: (c.settings as Record<string, unknown>) ?? {},
    }));
  }
  return invoke<ConnectorDto[]>("save_connectors", {
    connectors: connectors.map((c) => ({
      id: c.id,
      kind: c.kind,
      enabled: c.enabled,
      settings: c.settings ?? {},
    })),
  });
}

/** Instant exists + readable directory check (Tauri host). */
export async function hostValidateWorkspacePath(
  path: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!isTauri()) {
    if (!path.trim()) return { ok: false, detail: "Path is empty" };
    return { ok: true, detail: "Browser mode — host will recheck under Tauri" };
  }
  try {
    const detail = await invoke<string>("validate_workspace_path", { path });
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export type DefaultWorkspaceDto = {
  path: string;
  label: string;
  exists: boolean;
};

/** OS Documents/<product> suggestion (does not create the folder). */
export async function hostSuggestDefaultWorkspace(): Promise<DefaultWorkspaceDto | null> {
  if (!isTauri()) return null;
  return invoke<DefaultWorkspaceDto>("suggest_default_workspace");
}

/** Create Documents/<product> if needed and return its path. */
export async function hostEnsureDefaultWorkspace(): Promise<DefaultWorkspaceDto | null> {
  if (!isTauri()) return null;
  return invoke<DefaultWorkspaceDto>("ensure_default_workspace");
}

export async function hostSaveSecret(profileId: string, secret: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_provider_secret", { profileId, secret });
}

export async function hostProviderHasSecret(profileId: string): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("provider_has_secret", { profileId });
}

export type LocalCandidateDto = {
  id: string;
  label: string;
  kind: string;
  base_url: string | null;
  credentials_present: boolean;
  notes: string[];
};

/** Local AI candidates (no secrets — presence flags only). */
export async function hostListLocalCandidates(): Promise<LocalCandidateDto[]> {
  if (!isTauri()) {
    return [
      {
        id: "ollama-local",
        label: "Ollama (local)",
        kind: "ollama",
        base_url: "http://127.0.0.1:11434",
        credentials_present: false,
        notes: ["Browser mode stub"],
      },
    ];
  }
  return invoke<LocalCandidateDto[]>("list_local_candidates");
}

export async function hostProbeUrl(
  baseUrl: string,
  allowPrivate = false,
): Promise<{ ok: boolean; effective_base: string; candidates: string[]; error?: string | null }> {
  if (!isTauri()) {
    return { ok: false, effective_base: baseUrl, candidates: [], error: "Requires Tauri host" };
  }
  return invoke("probe_url", { req: { base_url: baseUrl, allow_private: allowPrivate } });
}

export type ProviderDto = {
  id: string;
  kind: string;
  base_url: string;
  chat_model: string;
  label: string;
  api_key_ref: string | null;
  has_key: boolean;
};

/** Persist active provider profile (refs only) + optional API key to OS keychain. */
export type SkillDto = {
  id: string;
  name: string;
  description: string;
  disabled: boolean;
  allows_write: boolean;
  path: string;
  /** Sibling module.toml present (#137). */
  has_module: boolean;
  module_id: string | null;
};

export type SetSkillEnabledResult = {
  id: string;
  enabled: boolean;
  needs_module_approval: boolean;
  module_id: string | null;
  preview: string | null;
  reason: string | null;
  type_confirm_phrase: string | null;
};

export async function hostListSkills(): Promise<SkillDto[]> {
  if (!isTauri()) return [];
  return invoke<SkillDto[]>("list_skills_cmd");
}

/** Persist enable/disable; may return module capability approval for tool-shipping skills (#137). */
export async function hostSetSkillEnabled(
  id: string,
  enabled: boolean,
): Promise<SetSkillEnabledResult> {
  if (!isTauri()) throw new Error("Skill enable requires Tauri host");
  return invoke<SetSkillEnabledResult>("set_skill_enabled_cmd", { id, enabled });
}

/** SoftWrite path: returns permission_required events until grant + re-execute. */
export async function hostProposeSaveSkill(args: {
  id: string;
  name: string;
  description: string;
  body: string;
  allowsWrite?: boolean;
}): Promise<EventDto[]> {
  if (!isTauri()) {
    throw new Error("Skill authoring requires Tauri host");
  }
  return invoke<EventDto[]>("propose_save_skill_cmd", {
    id: args.id,
    name: args.name,
    description: args.description,
    body: args.body,
    allowsWrite: args.allowsWrite ?? false,
  });
}

export async function hostSaveActiveProvider(args: {
  kind: string;
  baseUrl: string;
  chatModel: string;
  label?: string;
  /** Raw key once; never stored in React setup / localStorage after save. */
  apiKey?: string;
  localOnly?: boolean;
}): Promise<ProviderDto | null> {
  if (!isTauri()) return null;
  return invoke<ProviderDto>("save_active_provider", {
    req: {
      kind: args.kind,
      base_url: args.baseUrl,
      chat_model: args.chatModel,
      label: args.label ?? null,
      api_key: args.apiKey ?? null,
      local_only: args.localOnly ?? null,
    },
  });
}

/** Stable profile ids used by the host for keychain refs. */
export function profileIdForKind(kind: string): string {
  if (kind === "ollama") return "ollama-local";
  if (kind === "openai_compatible") return "openai-compatible";
  if (kind === "anthropic") return "anthropic";
  if (kind === "xai_grok_build") return "xai-grok-build";
  return kind;
}

/** Normalize host/discovery kind strings into AppSetup providerKind. */
export function normalizeProviderKind(
  kind: string,
): "ollama" | "openai_compatible" | "anthropic" | "xai_grok_build" | "none" {
  const k = kind.trim().toLowerCase().replace(/-/g, "_");
  if (k === "ollama") return "ollama";
  if (k === "openai_compatible" || k === "openaicompatible") return "openai_compatible";
  if (k === "anthropic") return "anthropic";
  if (k === "xai_grok_build" || k === "xaigrokbuild" || k === "grok" || k === "xai") {
    return "xai_grok_build";
  }
  return "none";
}

export async function hostReadFile(path: string): Promise<string> {
  if (!isTauri()) {
    // cd-server fallback: not implemented for arbitrary files; fail honestly
    throw new Error("File read requires Tauri host (npm run tauri:dev)");
  }
  return invoke<string>("read_workspace_file_cmd", { path });
}

/** Per-response generation provenance (footer). */
export type MessageMetaDto = {
  model?: string;
  provider_label?: string;
  provider_id?: string;
  base_url?: string;
  provider_kind?: string;
  /** Model requested at send (client snapshot) when host fact is missing. */
  requested_model?: string;
  /**
   * True when `model` came from a host `turn_started` event (not send-time guess).
   * Footer uses honest "requested:" label when false (#155).
   */
  host_confirmed?: boolean;
};

/** Durable chat session (host Session JSON). */
export type StoredMessageDto = {
  id: string;
  role: string;
  content: string;
  tools?: unknown;
  citations?: unknown;
  trail?: string[] | null;
  meta?: MessageMetaDto | null;
};

export type ChatSessionDto = {
  id: string;
  title: string;
  messages: StoredMessageDto[];
  compact_summary?: string | null;
  compact_keep_last: number;
  show_full_history: boolean;
  created_at: string;
  updated_at: string;
  archived: boolean;
  trashed?: boolean;
  trashed_at?: string | null;
  pinned: boolean;
  title_locked: boolean;
  chat_model?: string | null;
  provider_profile_id?: string | null;
  last_read_message_id?: string | null;
};

export type ModelOptionDto = {
  id: string;
  label: string;
  /** Unique select value: `provider_id::model_id`. */
  selection_key: string;
  provider_id: string;
  provider_label: string;
  group: string;
  is_default: boolean;
};

export function parseModelSelectionKey(key: string): {
  providerId: string | null;
  modelId: string;
} {
  const i = key.indexOf("::");
  if (i > 0) {
    return {
      providerId: key.slice(0, i),
      modelId: key.slice(i + 2),
    };
  }
  return { providerId: null, modelId: key };
}

export function modelSelectionKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export async function hostListChatModels(): Promise<ModelOptionDto[]> {
  if (!isTauri()) return [];
  return invoke<ModelOptionDto[]>("list_chat_models");
}

export async function hostGetDefaultChatModel(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("get_default_chat_model");
}

export async function hostSetDefaultChatModel(model: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("set_default_chat_model", { model });
}

export type SessionMetaDto = {
  id: string;
  title: string;
  archived: boolean;
  trashed?: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  trashed_at?: string | null;
  message_count: number;
  preview: string;
};

export type SessionSearchHitDto = {
  meta: SessionMetaDto;
  score: number;
  snippet: string;
};

export async function hostListChatSessions(): Promise<SessionMetaDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionMetaDto[]>("list_chat_sessions");
}

export async function hostLoadChatSession(id: string): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("load_chat_session", { id });
}

export async function hostSaveChatSession(
  session: ChatSessionDto,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("save_chat_session", { session });
}

export async function hostRenameChatSession(
  id: string,
  title: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("rename_chat_session", { id, title });
}

/** Soft-delete: move chat to trash (recoverable). */
export async function hostTrashChatSession(
  id: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("trash_chat_session", { id });
}

/** Restore chat from trash. */
export async function hostRestoreChatSession(
  id: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("restore_chat_session", { id });
}

/** Permanently delete chat file. Prefer trash for user-facing delete. */
export async function hostDeleteChatSession(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_chat_session", { id });
}

export async function hostPinChatSession(
  id: string,
  pinned: boolean,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("pin_chat_session", { id, pinned });
}

export async function hostArchiveChatSession(
  id: string,
  archived: boolean,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("archive_chat_session", { id, archived });
}

/** Keyword search over chat archive (title + body scoring). */
export async function hostSearchChatSessions(
  query: string,
  opts?: {
    limit?: number;
    includeArchived?: boolean;
    includeTrashed?: boolean;
    onlyTrashed?: boolean;
  },
): Promise<SessionSearchHitDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionSearchHitDto[]>("search_chat_sessions", {
    query,
    limit: opts?.limit ?? 50,
    includeArchived: opts?.includeArchived ?? false,
    includeTrashed: opts?.includeTrashed ?? false,
    onlyTrashed: opts?.onlyTrashed ?? false,
  });
}

/** Brief title via active model (heuristic fallback if model down). */
export async function hostSuggestChatTitle(prompt: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("suggest_chat_title", { prompt });
}

/** LLM-retitle a saved session (no-op if user renamed / title_locked). */
export async function hostRetitleChatSession(id: string): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("retitle_chat_session", { id });
}

export type MemoryFileDto = {
  path: string;
  relative: string;
  title: string;
  body: string;
};

export async function hostListMemory(): Promise<MemoryFileDto[]> {
  if (!isTauri()) return [];
  return invoke<MemoryFileDto[]>("list_memory_notes");
}

export async function hostWriteMemory(
  filename: string,
  title: string,
  body: string,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Memory write requires Tauri host");
  }
  return invoke<string>("write_memory_note", { filename, title, body });
}

export type ConfluenceSettingsDto = {
  enabled: boolean;
  base_url: string;
  spaces: string[];
  pat_ref: string | null;
};

export async function hostGetConfluence(): Promise<ConfluenceSettingsDto | null> {
  if (!isTauri()) return null;
  return invoke<ConfluenceSettingsDto>("get_confluence_settings");
}

export async function hostSaveConfluence(args: {
  enabled: boolean;
  baseUrl: string;
  spaces: string;
  pat?: string;
}): Promise<ConfluenceSettingsDto> {
  if (!isTauri()) {
    throw new Error("Confluence settings require Tauri host");
  }
  return invoke<ConfluenceSettingsDto>("save_confluence_settings", {
    req: {
      enabled: args.enabled,
      base_url: args.baseUrl,
      spaces: args.spaces,
      pat: args.pat ?? null,
    },
  });
}

export async function hostConfluenceHasToken(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("confluence_has_token");
}

export async function hostTestConfluence(): Promise<string> {
  if (!isTauri()) {
    throw new Error("Test requires Tauri host");
  }
  return invoke<string>("test_confluence_config");
}

export type XSettingsDto = {
  enabled: boolean;
  api_key_ref: string | null;
};

export async function hostGetX(): Promise<XSettingsDto | null> {
  if (!isTauri()) return null;
  return invoke<XSettingsDto>("get_x_settings");
}

export async function hostSaveX(args: {
  enabled: boolean;
  apiKey?: string;
}): Promise<XSettingsDto> {
  if (!isTauri()) {
    throw new Error("X settings require Tauri host");
  }
  return invoke<XSettingsDto>("save_x_settings", {
    req: {
      enabled: args.enabled,
      api_key: args.apiKey ?? null,
    },
  });
}

export async function hostXHasToken(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("x_has_token");
}

export async function hostTestX(): Promise<string> {
  if (!isTauri()) {
    throw new Error("Test requires Tauri host");
  }
  return invoke<string>("test_x_config");
}

export async function hostGetWebResearchEnabled(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("get_web_research_enabled");
}

export type RouterBudgetDto = {
  max_sources: number;
  max_tool_rounds: number;
  max_results_per_source: number;
  deadline_ms: number;
};

export async function hostGetRouterBudget(): Promise<RouterBudgetDto | null> {
  if (!isTauri()) return null;
  return invoke<RouterBudgetDto>("get_router_budget");
}

export async function hostSetRouterBudget(
  budget: RouterBudgetDto,
): Promise<RouterBudgetDto> {
  if (!isTauri()) {
    throw new Error("Router budget requires Tauri host");
  }
  return invoke<RouterBudgetDto>("set_router_budget", { req: budget });
}

export async function hostSetWebResearchEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Web research settings require Tauri host");
  }
  return invoke<boolean>("set_web_research_enabled", { enabled });
}

/** Hybrid search_kb opt-in (#119). Default off = keyword-only. */
export async function hostGetHybridRetrieval(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("get_hybrid_retrieval");
}

export async function hostSetHybridRetrieval(enabled: boolean): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Hybrid retrieval requires Tauri host");
  }
  return invoke<boolean>("set_hybrid_retrieval", { enabled });
}

/** External module DTO (#136). No secrets. */
export type ModuleDto = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  granted: boolean;
  path: string;
  entrypoint: string;
  requested_filesystem_roots: string[];
  requested_network_hosts: string[];
  requested_secret_refs: string[];
  hard_write_tools: string[];
  provided_tools: string[];
};

export type SetModuleEnabledResult = {
  enabled: boolean;
  needs_approval: boolean;
  module_id: string;
  risk: string;
  type_confirm_phrase: string | null;
  preview: string;
  reason: string;
  request_id: string;
};

export async function hostListModules(): Promise<ModuleDto[]> {
  if (!isTauri()) return [];
  return invoke<ModuleDto[]>("list_modules");
}

/** Local path install only (NON_GOALS #7). */
export async function hostInstallModule(path: string): Promise<ModuleDto> {
  if (!isTauri()) throw new Error("Module install requires Tauri host");
  return invoke<ModuleDto>("install_module", { path });
}

export async function hostSetModuleEnabled(
  id: string,
  enabled: boolean,
): Promise<SetModuleEnabledResult> {
  if (!isTauri()) throw new Error("Module enable requires Tauri host");
  return invoke<SetModuleEnabledResult>("set_module_enabled", { id, enabled });
}

export async function hostApproveModuleEnable(
  id: string,
  decision: string,
  typed?: string,
): Promise<boolean> {
  if (!isTauri()) throw new Error("Module approve requires Tauri host");
  return invoke<boolean>("approve_module_enable", { id, decision, typed });
}

export async function hostRemoveModule(id: string): Promise<boolean> {
  if (!isTauri()) throw new Error("Module remove requires Tauri host");
  return invoke<boolean>("remove_module", { id });
}

/** Browse-only registry settings (#139). Default: disabled + empty URL. */
export type ModuleRegistrySettingsDto = {
  enabled: boolean;
  url: string;
};

export type ModuleRegistryEntryDto = {
  id: string;
  name: string;
  version: string;
  description: string;
  homepage: string | null;
  local_path: string | null;
  can_install_local: boolean;
};

export async function hostGetModuleRegistrySettings(): Promise<ModuleRegistrySettingsDto> {
  if (!isTauri()) return { enabled: false, url: "" };
  return invoke<ModuleRegistrySettingsDto>("get_module_registry_settings");
}

export async function hostSetModuleRegistrySettings(
  enabled: boolean,
  url: string,
): Promise<ModuleRegistrySettingsDto> {
  if (!isTauri()) throw new Error("Registry settings require Tauri host");
  return invoke<ModuleRegistrySettingsDto>("set_module_registry_settings", {
    enabled,
    url,
  });
}

/**
 * Browse registry metadata only — never auto-installs (NON_GOALS #7).
 * Pass `filePath` for offline local JSON; otherwise uses configured URL when enabled.
 */
export async function hostBrowseModuleRegistry(
  filePath?: string,
): Promise<ModuleRegistryEntryDto[]> {
  if (!isTauri()) return [];
  return invoke<ModuleRegistryEntryDto[]>("browse_module_registry", {
    filePath: filePath ?? null,
  });
}

export async function hostUpdateModule(
  id: string,
  path: string,
): Promise<ModuleDto> {
  if (!isTauri()) throw new Error("Module update requires Tauri host");
  return invoke<ModuleDto>("update_module", { id, path });
}

export type NewsSourceDto = {
  id: string;
  label: string;
  group: string;
  group_label: string;
  enabled: boolean;
  default_enabled: boolean;
  hint: string;
  feed_url: string;
};

export async function hostListWebResearchSources(): Promise<NewsSourceDto[]> {
  if (!isTauri()) return [];
  return invoke<NewsSourceDto[]>("list_web_research_sources");
}

export async function hostSetWebResearchSources(
  sources: Record<string, boolean>,
): Promise<NewsSourceDto[]> {
  if (!isTauri()) {
    throw new Error("Web research sources require Tauri host");
  }
  return invoke<NewsSourceDto[]>("set_web_research_sources", { sources });
}

export function setupToWorkspaceRoots(setup: AppSetupState): string[] {
  return setup.workspaceRoots;
}

/** Update check result for Settings (#173). No install until user confirms. */
export type UpdateCheckDto = {
  available: boolean;
  currentVersion: string;
  version?: string;
  body?: string | null;
  date?: string | null;
};

/**
 * Opt-in signed updater check (#173). Uses tauri-plugin-updater; never installs.
 * Returns `available: false` when not in Tauri or no update / network failure.
 */
export async function hostCheckForUpdates(): Promise<UpdateCheckDto> {
  if (!isTauri()) {
    return { available: false, currentVersion: "browser" };
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const { getVersion } = await import("@tauri-apps/api/app");
  const currentVersion = await getVersion();
  const update = await check();
  if (!update) {
    return { available: false, currentVersion };
  }
  return {
    available: true,
    currentVersion,
    version: update.version,
    body: update.body,
    date: update.date,
  };
}

/**
 * Download + install after explicit UI confirm (#173). Re-checks so install is
 * never silent; user confirmation is required by the caller first.
 */
export async function hostInstallUpdate(): Promise<void> {
  if (!isTauri()) {
    throw new Error("Updates require the desktop app");
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) {
    throw new Error("No update available");
  }
  await update.downloadAndInstall();
}
