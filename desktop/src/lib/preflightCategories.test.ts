import { describe, expect, it } from "vitest";
import {
  categoryForId,
  filterWorkContextItems,
  isLaunchBlockingLevel,
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
    expect(work.every((i) => !i.id.includes("web_research") && !i.id.startsWith("x."))).toBe(
      true,
    );
  });

  it("only launch fails block", () => {
    expect(isLaunchBlockingLevel("fail", "workspace.roots")).toBe(true);
    expect(isLaunchBlockingLevel("warn", "confluence.pat")).toBe(false);
    expect(isLaunchBlockingLevel("fail", "confluence.pat")).toBe(false);
  });
});
