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
    req: { session_id: sessionId, text, force_local: forceLocal },
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
  return kind;
}

export async function hostReadFile(path: string): Promise<string> {
  if (!isTauri()) {
    // cd-server fallback: not implemented for arbitrary files; fail honestly
    throw new Error("File read requires Tauri host (npm run tauri:dev)");
  }
  return invoke<string>("read_workspace_file_cmd", { path });
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

export function setupToWorkspaceRoots(setup: AppSetupState): string[] {
  return setup.workspaceRoots;
}
