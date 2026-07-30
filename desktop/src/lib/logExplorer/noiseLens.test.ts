import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeNoiseExclusionTemplateIds,
  formatNoiseLensDisclosure,
  noiseLensSuspendStorageKey,
  readNoiseLensSuspended,
  writeNoiseLensSuspended,
} from "./noiseLens";

/** Minimal in-memory localStorage (happy-dom may lack clear/removeItem). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe("noiseLens helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists suspend flag per corpus without colliding", () => {
    expect(noiseLensSuspendStorageKey("c-a")).toContain("c-a");
    expect(readNoiseLensSuspended("c-a")).toBe(false);
    writeNoiseLensSuspended("c-a", true);
    expect(readNoiseLensSuspended("c-a")).toBe(true);
    expect(readNoiseLensSuspended("c-b")).toBe(false);
    writeNoiseLensSuspended("c-a", false);
    expect(readNoiseLensSuspended("c-a")).toBe(false);
  });

  it("formats disclosure for active, suspended, and inactive lenses", () => {
    expect(
      formatNoiseLensDisclosure({
        enabledRuleCount: 0,
        policyHiddenCount: 0,
        lensApplying: false,
        lensSuspended: false,
        temporaryReveal: false,
        policyRevision: 1,
      }),
    ).toMatch(/0 rules · 0 excluded/);

    const active = formatNoiseLensDisclosure({
      enabledRuleCount: 2,
      policyHiddenCount: 250,
      lensApplying: true,
      lensSuspended: false,
      temporaryReveal: false,
      policyRevision: 7,
    });
    expect(active).toMatch(/Noise active/);
    expect(active).toMatch(/2 rules/);
    expect(active).toMatch(/250 excluded/);
    expect(active).toMatch(/not analyzed/);
    expect(active).toMatch(/r7/);

    const suspended = formatNoiseLensDisclosure({
      enabledRuleCount: 2,
      policyHiddenCount: 250,
      lensApplying: false,
      lensSuspended: true,
      temporaryReveal: false,
      policyRevision: 7,
    });
    expect(suspended).toMatch(/suspended/i);
    expect(suspended).toMatch(/0 excluded now/);
    expect(suspended).toMatch(/would hide 250/);
    expect(suspended).not.toMatch(/rules disabled/i);
  });

  it("clears exclusion ids when suspended or temporarily revealing", () => {
    expect(
      activeNoiseExclusionTemplateIds({
        enabledTemplateIds: [3, 9],
        lensSuspended: false,
        temporaryReveal: false,
      }),
    ).toEqual([3, 9]);
    expect(
      activeNoiseExclusionTemplateIds({
        enabledTemplateIds: [3, 9],
        lensSuspended: true,
        temporaryReveal: false,
      }),
    ).toEqual([]);
    expect(
      activeNoiseExclusionTemplateIds({
        enabledTemplateIds: [3, 9],
        lensSuspended: false,
        temporaryReveal: true,
      }),
    ).toEqual([]);
  });
});
