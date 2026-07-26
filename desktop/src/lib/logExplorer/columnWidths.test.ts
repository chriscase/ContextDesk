import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  autoFitColWidths,
  clampColWidths,
  DEFAULT_COL_WIDTHS,
  loadColWidths,
  resizeCol,
  saveColWidths,
} from "./columnWidths";

const store = new Map<string, string>();

describe("columnWidths", () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
  });

  it("clamps to min/max and never zero-width", () => {
    const c = clampColWidths([0, 0, 0, 0]);
    expect(c[0]).toBeGreaterThan(0);
    expect(c[1]).toBeGreaterThan(0);
    expect(c[2]).toBeGreaterThan(0);
    const wide = clampColWidths([100, 100, 100, 1]);
    expect(wide[0]).toBeLessThanOrEqual(16);
    expect(wide[2]).toBeLessThanOrEqual(20);
  });

  it("persists and reloads preferences", () => {
    const w: [number, number, number, number] = [9, 4, 12, 1];
    saveColWidths(w);
    expect(loadColWidths()).toEqual(w);
  });

  it("defaults when storage empty or corrupt", () => {
    expect(loadColWidths()).toEqual(DEFAULT_COL_WIDTHS);
    localStorage.setItem("contextdesk.logExplorer.colWidths.v1", "not-json");
    expect(loadColWidths()).toEqual(DEFAULT_COL_WIDTHS);
  });

  it("resizeCol nudges one column", () => {
    const next = resizeCol(DEFAULT_COL_WIDTHS, 0, 1);
    expect(next[0]).toBe(DEFAULT_COL_WIDTHS[0] + 1);
    expect(next[1]).toBe(DEFAULT_COL_WIDTHS[1]);
  });

  it("autoFit grows source column for long paths", () => {
    const fit = autoFitColWidths([
      "region-a/very-long-service-name/app.jsonl",
      "api/app.jsonl",
    ]);
    expect(fit[2]).toBeGreaterThan(DEFAULT_COL_WIDTHS[2]);
  });
});
