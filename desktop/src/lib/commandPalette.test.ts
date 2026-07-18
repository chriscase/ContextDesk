import { describe, expect, it } from "vitest";
import {
  filterPaletteItems,
  fuzzyScore,
  isEditableTarget,
  type PaletteItem,
} from "./commandPalette";

const items: PaletteItem[] = [
  { id: "new", label: "New chat", group: "action", keywords: ["create"] },
  { id: "settings", label: "Open Settings", group: "action", keywords: [","] },
  {
    id: "s1",
    label: "Workspace notes",
    detail: "yesterday",
    group: "session",
  },
  { id: "s2", label: "Rust review", group: "session" },
];

describe("command palette filter (#154)", () => {
  it("returns all items when query empty", () => {
    expect(filterPaletteItems(items, "")).toHaveLength(items.length);
  });

  it("fuzzy-matches label and keywords", () => {
    const byLabel = filterPaletteItems(items, "rust");
    expect(byLabel.map((i) => i.id)).toEqual(["s2"]);
    const byKw = filterPaletteItems(items, "create");
    expect(byKw.map((i) => i.id)).toContain("new");
  });

  it("ranks prefix higher than subsequence", () => {
    expect(fuzzyScore("set", "Open Settings")).toBeGreaterThan(
      fuzzyScore("set", "Workspace notes"),
    );
  });
});

describe("isEditableTarget (#154)", () => {
  it("detects input/textarea", () => {
    const input = document.createElement("input");
    const ta = document.createElement("textarea");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(ta)).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
  });
});
