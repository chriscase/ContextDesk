/** Client-side preflight mirror (host will call cd-core later). */

export type PreflightLevel = "pass" | "warn" | "fail";

export type PreflightItem = {
  id: string;
  title: string;
  level: PreflightLevel;
  detail: string;
  fixAction?: "general" | "workspace" | "ai" | "appearance";
};

export type PreflightReport = {
  items: PreflightItem[];
  hasBlocking: boolean;
};

export type AppSetupState = {
  dataDirWritable: boolean;
  workspaceName: string | null;
  workspaceRoots: string[];
  providerLabel: string | null;
  providerKind: "ollama" | "openai_compatible" | "none";
  chatModel: string;
  baseUrl: string;
  hasApiKey: boolean;
  /** Simulated / later real probes */
  ollamaReachable: boolean | null;
  remoteReachable: boolean | null;
};

export function runClientPreflight(s: AppSetupState): PreflightReport {
  const items: PreflightItem[] = [];

  items.push(
    s.dataDirWritable
      ? {
          id: "app.data_dir",
          title: "App data directory",
          level: "pass",
          detail: "Configuration directory is writable.",
        }
      : {
          id: "app.data_dir",
          title: "App data directory",
          level: "fail",
          detail: "Cannot write app data. Check disk permissions.",
          fixAction: "general",
        },
  );

  if (!s.workspaceName || s.workspaceRoots.length === 0) {
    items.push({
      id: "workspace.roots",
      title: "Workspace roots",
      level: "fail",
      detail: "Add at least one folder in Settings → Workspace.",
      fixAction: "workspace",
    });
  } else {
    items.push({
      id: "workspace.roots",
      title: "Workspace roots",
      level: "pass",
      detail: `${s.workspaceRoots.length} root(s) in “${s.workspaceName}”.`,
      fixAction: "workspace",
    });
  }

  if (!s.providerLabel || s.providerKind === "none") {
    items.push({
      id: "provider.active",
      title: "AI provider",
      level: "fail",
      detail: "Choose a model provider in Settings → AI.",
      fixAction: "ai",
    });
  } else {
    items.push({
      id: "provider.active",
      title: "AI provider",
      level: "pass",
      detail: `Active: ${s.providerLabel}`,
      fixAction: "ai",
    });

    if (!s.chatModel.trim()) {
      items.push({
        id: "provider.model",
        title: "Chat model",
        level: "fail",
        detail: "Select or enter a chat model id.",
        fixAction: "ai",
      });
    } else {
      items.push({
        id: "provider.model",
        title: "Chat model",
        level: "pass",
        detail: `Model: ${s.chatModel}`,
        fixAction: "ai",
      });
    }

    if (s.providerKind === "ollama") {
      if (s.ollamaReachable === true) {
        items.push({
          id: "provider.ollama",
          title: "Ollama",
          level: "pass",
          detail: `Reachable at ${s.baseUrl || "localhost"}.`,
          fixAction: "ai",
        });
      } else if (s.ollamaReachable === false) {
        items.push({
          id: "provider.ollama",
          title: "Ollama",
          level: "fail",
          detail: "Ollama not reachable. Start it or switch provider.",
          fixAction: "ai",
        });
      } else {
        items.push({
          id: "provider.ollama",
          title: "Ollama",
          level: "warn",
          detail: "Not checked yet — use Recheck or Test connection.",
          fixAction: "ai",
        });
      }
    }

    if (s.providerKind === "openai_compatible") {
      if (!s.baseUrl.trim()) {
        items.push({
          id: "provider.url",
          title: "Gateway URL",
          level: "fail",
          detail: "Base URL is required.",
          fixAction: "ai",
        });
      } else if (!looksLikeUrl(s.baseUrl)) {
        items.push({
          id: "provider.url",
          title: "Gateway URL",
          level: "fail",
          detail: "Enter a valid http(s) URL.",
          fixAction: "ai",
        });
      } else {
        items.push({
          id: "provider.url",
          title: "Gateway URL",
          level: "pass",
          detail: s.baseUrl,
          fixAction: "ai",
        });
      }

      if (!s.hasApiKey) {
        items.push({
          id: "provider.key",
          title: "API key",
          level: "fail",
          detail: "Paste a key — stored in the OS keychain (not a config file).",
          fixAction: "ai",
        });
      } else {
        items.push({
          id: "provider.key",
          title: "API key",
          level: "pass",
          detail: "Key on file in secure storage (masked in UI).",
          fixAction: "ai",
        });
      }

      if (s.remoteReachable === true) {
        items.push({
          id: "provider.remote",
          title: "Connection test",
          level: "pass",
          detail: "Endpoint responded.",
          fixAction: "ai",
        });
      } else if (s.remoteReachable === false) {
        items.push({
          id: "provider.remote",
          title: "Connection test",
          level: "fail",
          detail: "Last test failed — check URL and key.",
          fixAction: "ai",
        });
      } else {
        items.push({
          id: "provider.remote",
          title: "Connection test",
          level: "warn",
          detail: "Run Test connection for a live check.",
          fixAction: "ai",
        });
      }
    }
  }

  return {
    items,
    hasBlocking: items.some((i) => i.level === "fail"),
  };
}

export function looksLikeUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Debounced “instant” URL field validation. */
export function validateBaseUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "Base URL is required for this provider.";
  if (!looksLikeUrl(t)) return "Use an http:// or https:// URL.";
  return null;
}
