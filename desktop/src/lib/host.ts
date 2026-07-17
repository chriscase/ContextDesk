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

/** Run research turn — real agent path via Tauri host. */
export async function agentTurn(
  sessionId: string,
  text: string,
  forceLocal = false,
  chatModel?: string | null,
  providerProfileId?: string | null,
): Promise<EventDto[]> {
  if (!isTauri()) {
    // Browser-only: use same offline research contract via local server if present,
    // else return structured error (no demo shell text).
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
        return j.events as EventDto[];
      }
    } catch {
      /* fall through */
    }
    throw new Error(
      "Agent host unavailable. Run via `npm run tauri:dev` or start cd-server on :8787.",
    );
  }
  return invoke<EventDto[]>("agent_turn", {
    req: {
      session_id: sessionId,
      text,
      force_local: forceLocal,
      chat_model: chatModel?.trim() || null,
      provider_profile_id: providerProfileId?.trim() || null,
    },
  });
}

export async function completePermission(
  requestId: string,
  decision: "deny" | "allow_once" | "allow_session_path",
  toolName: string,
  argumentsJson: Record<string, unknown>,
  typed?: string,
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
};

export async function hostListSkills(): Promise<SkillDto[]> {
  if (!isTauri()) return [];
  return invoke<SkillDto[]>("list_skills_cmd");
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
): "ollama" | "openai_compatible" | "xai_grok_build" | "none" {
  const k = kind.trim().toLowerCase().replace(/-/g, "_");
  if (k === "ollama") return "ollama";
  if (k === "openai_compatible" || k === "openaicompatible") return "openai_compatible";
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

/** Durable chat session (host Session JSON). */
export type StoredMessageDto = {
  id: string;
  role: string;
  content: string;
  tools?: unknown;
  citations?: unknown;
  trail?: string[] | null;
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
  pinned: boolean;
  created_at: string;
  updated_at: string;
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
  opts?: { limit?: number; includeArchived?: boolean },
): Promise<SessionSearchHitDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionSearchHitDto[]>("search_chat_sessions", {
    query,
    limit: opts?.limit ?? 50,
    includeArchived: opts?.includeArchived ?? false,
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

export async function hostGetWebResearchEnabled(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("get_web_research_enabled");
}

export async function hostSetWebResearchEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Web research settings require Tauri host");
  }
  return invoke<boolean>("set_web_research_enabled", { enabled });
}

export function setupToWorkspaceRoots(setup: AppSetupState): string[] {
  return setup.workspaceRoots;
}
