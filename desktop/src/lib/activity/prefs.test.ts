import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_MODE_CHANGED_EVENT,
  DEFAULT_ACTIVITY_MODE,
  clampDockWidth,
  coerceActivityMode,
  loadActivityMode,
  loadDockWidth,
  saveActivityMode,
  saveDockWidth,
  subscribeActivityMode,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
} from "./prefs";
import { ACTIVITY_MODES } from "./types";

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
  return map;
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = installMemoryStorage();
});

describe("the shared activity display preference", () => {
  it("is quiet by default — nothing appears until asked for", () => {
    expect(DEFAULT_ACTIVITY_MODE).toBe("off");
    expect(loadActivityMode()).toBe("off");
  });

  it("round-trips every one of the four modes", () => {
    for (const mode of ACTIVITY_MODES) {
      saveActivityMode(mode);
      expect(loadActivityMode()).toBe(mode);
    }
    expect(ACTIVITY_MODES).toEqual(["off", "compact", "drawer", "docked"]);
  });

  it("uses ONE key, so a second surface reads what the first wrote", () => {
    // This is the whole "one shared persisted preference" requirement: there
    // is no per-surface namespacing to diverge.
    saveActivityMode("drawer");
    const keys = [...storage.keys()].filter((k) =>
      k.includes("activity-inspector-mode"),
    );
    expect(keys).toHaveLength(1);
    expect(loadActivityMode()).toBe("drawer");
  });

  it("maps the pre-unification \"hidden\" value forward to Off", () => {
    localStorage.setItem("cd-activity-inspector-mode", "hidden");
    expect(loadActivityMode()).toBe("off");
    expect(coerceActivityMode("hidden")).toBe("off");
  });

  it("rejects junk rather than persisting it", () => {
    expect(coerceActivityMode("docked!")).toBeNull();
    expect(coerceActivityMode(7)).toBeNull();
    localStorage.setItem("cd-activity-inspector-mode", "nonsense");
    expect(loadActivityMode()).toBe(DEFAULT_ACTIVITY_MODE);
  });

  it("broadcasts in-process so two open surfaces cannot diverge", () => {
    // `storage` events only fire in OTHER documents, so without this the
    // Explorer would never learn about a change made in chat.
    const seen: string[] = [];
    const stop = subscribeActivityMode((mode) => seen.push(mode));
    saveActivityMode("docked");
    saveActivityMode("compact");
    stop();
    saveActivityMode("drawer");
    expect(seen).toEqual(["docked", "compact"]);
  });

  it("ignores a broadcast carrying an unusable value", () => {
    const onChange = vi.fn();
    const stop = subscribeActivityMode(onChange);
    window.dispatchEvent(
      new CustomEvent(ACTIVITY_MODE_CHANGED_EVENT, { detail: "bogus" }),
    );
    stop();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("survives storage that throws (private mode / quota)", () => {
    vi.stubGlobal("localStorage", {
      get length() {
        return 0;
      },
      clear() {},
      key: () => null,
      removeItem() {},
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    } as Storage);
    expect(loadActivityMode()).toBe(DEFAULT_ACTIVITY_MODE);
    expect(() => saveActivityMode("docked")).not.toThrow();
  });
});

describe("dock width", () => {
  it("clamps to the usable range and rejects non-finite input", () => {
    expect(clampDockWidth(10)).toBe(MIN_DOCK_WIDTH);
    expect(clampDockWidth(99_999)).toBe(MAX_DOCK_WIDTH);
    expect(clampDockWidth(Number.NaN)).toBeGreaterThanOrEqual(MIN_DOCK_WIDTH);
  });

  it("persists a clamped width", () => {
    saveDockWidth(99_999);
    expect(loadDockWidth()).toBe(MAX_DOCK_WIDTH);
  });
});
