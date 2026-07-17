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

export async function hostSaveSecret(profileId: string, secret: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_provider_secret", { profileId, secret });
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
