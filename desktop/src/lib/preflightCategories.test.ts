import { describe, expect, it } from "vitest";
import {
  categoryForId,
  filterWorkContextItems,
  isLaunchBlockingLevel,
  preflightReadiness,
  unverifiedProbeItems,
} from "./preflightCategories";
import type { PreflightItem } from "./preflight";

describe("preflightCategories", () => {
  it("classifies work vs optional vs launch", () => {
    expect(categoryForId("confluence.pat")).toBe("work");
    expect(categoryForId("connector.mcp.x")).toBe("work");
    expect(categoryForId("memory.store")).toBe("work");
    expect(categoryForId("provider.ollama")).toBe("launch");
    expect(categoryForId("web_research.sources")).toBe("optional");
    expect(categoryForId("x.search")).toBe("optional");
  });

  it("filters work-context strip without news/X", () => {
    const items: PreflightItem[] = [
      {
        id: "provider.ollama",
        title: "Ollama",
        level: "pass",
        detail: "ok",
      },
      {
        id: "memory.store",
        title: "Memory",
        level: "pass",
        detail: "ok",
      },
      {
        id: "confluence.pat",
        title: "Confluence",
        level: "warn",
        detail: "no pat",
        fixAction: "connectors",
      },
      {
        id: "web_research.sources",
        title: "News",
        level: "pass",
        detail: "n",
      },
      {
        id: "x.search",
        title: "X",
        level: "pass",
        detail: "x",
      },
    ];
    const work = filterWorkContextItems(items);
    expect(work.map((i) => i.id)).toEqual(["memory.store", "confluence.pat"]);
    expect(
      work.every(
        (i) => !i.id.includes("web_research") && !i.id.startsWith("x."),
      ),
    ).toBe(true);
  });

  it("only launch fails block", () => {
    expect(isLaunchBlockingLevel("fail", "workspace.roots")).toBe(true);
    expect(isLaunchBlockingLevel("warn", "confluence.pat")).toBe(false);
    expect(isLaunchBlockingLevel("fail", "confluence.pat")).toBe(false);
  });
});

describe("readiness truthfulness (#746)", () => {
  const item = (
    id: string,
    level: PreflightItem["level"],
    detail = "",
  ): PreflightItem => ({ id, title: id, level, detail });

  it("never calls a configured-but-unprobed provider ready", () => {
    // Exactly what cd-core emits when provider_reachable is None: honest at the
    // item level, but hasBlocking is fail-only so it stayed invisible.
    const items = [
      item("provider.key", "pass", "Credential present in secure storage."),
      item(
        "provider.remote",
        "warn",
        "Not live-tested yet — use Test connection in Settings (URL shape alone is not a probe).",
      ),
    ];
    expect(preflightReadiness(items, false)).toBe("unverified");
    expect(unverifiedProbeItems(items).map((i) => i.id)).toEqual([
      "provider.remote",
    ]);
  });

  it("reports ready only once a probe actually succeeded", () => {
    const items = [
      item("provider.key", "pass"),
      item("provider.remote", "pass", "Live probe succeeded."),
    ];
    expect(preflightReadiness(items, false)).toBe("ready");
    expect(unverifiedProbeItems(items)).toEqual([]);
  });

  it("keeps blocked ahead of unverified", () => {
    const items = [item("provider.remote", "warn")];
    expect(preflightReadiness(items, true)).toBe("blocked");
  });

  it("does not mistake other launch warnings for unmeasured readiness", () => {
    // provider.embed warns on a malformed embed URL and provider.grok_session
    // warns when optional session material is simply absent. Neither means
    // "never measured", so neither may downgrade Ready.
    const items = [
      item("provider.remote", "pass", "Live probe succeeded."),
      item(
        "provider.embed",
        "warn",
        "Embedding base URL is set but not valid.",
      ),
      item(
        "provider.grok_session",
        "warn",
        "No local Grok session file (optional).",
      ),
      item("confluence.pat", "warn", "Paste a personal access token."),
    ];
    expect(unverifiedProbeItems(items)).toEqual([]);
    expect(preflightReadiness(items, false)).toBe("ready");
  });

  it("treats an unprobed local Ollama and an unchecked key as unverified", () => {
    expect(
      preflightReadiness(
        [item("provider.ollama", "warn", "Reachability not probed yet.")],
        false,
      ),
    ).toBe("unverified");
    expect(
      preflightReadiness(
        [item("provider.key", "warn", "Key presence not checked yet.")],
        false,
      ),
    ).toBe("unverified");
  });

  it("reports ready for an empty report rather than inventing doubt", () => {
    expect(preflightReadiness([], false)).toBe("ready");
  });
});
