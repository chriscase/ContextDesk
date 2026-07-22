import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLastGatewayUrl,
  resolveGatewayUrlPrefill,
  saveLastGatewayUrl,
} from "./aiGatewayPrefs";

/** Minimal in-memory localStorage (happy-dom may lack clear/removeItem). */
function installMemoryStorage() {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(k) {
      return map.has(k) ? map.get(k)! : null;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    removeItem(k) {
      map.delete(k);
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
  };
  vi.stubGlobal("localStorage", store);
}

describe("aiGatewayPrefs", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("remembers non-loopback gateway URLs", () => {
    saveLastGatewayUrl("https://gw.corp.example/llm/v1/");
    expect(loadLastGatewayUrl()).toBe("https://gw.corp.example/llm/v1");
  });

  it("ignores localhost", () => {
    saveLastGatewayUrl("http://127.0.0.1:11434");
    expect(loadLastGatewayUrl()).toBe("");
  });

  it("prefers draft remote URL over soft pref", () => {
    saveLastGatewayUrl("https://old.example/v1");
    expect(
      resolveGatewayUrlPrefill(
        "https://new.example/llm/v1",
        "openai_compatible",
      ),
    ).toBe("https://new.example/llm/v1");
  });

  it("falls back to soft pref when draft is local ollama", () => {
    saveLastGatewayUrl("https://gw.corp.example/v1");
    expect(
      resolveGatewayUrlPrefill("http://127.0.0.1:11434", "ollama"),
    ).toBe("https://gw.corp.example/v1");
  });
});
