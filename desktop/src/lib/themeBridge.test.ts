import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeToDocument,
  broadcastThemeChange,
  subscribeThemeChanges,
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
} from "./themeBridge";

describe("cross-window theme bridge", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it("applies only registered skins", () => {
    expect(applyThemeToDocument("light")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(applyThemeToDocument("../unsafe")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("accepts custom, storage, focus, and Tauri events and unsubscribes", async () => {
    const received: string[] = [];
    const stop = vi.fn();
    let tauriHandler:
      | ((event: { payload: { theme?: unknown } }) => void)
      | undefined;
    const listen = vi.fn(async (_name, handler) => {
      tauriHandler = handler;
      return stop;
    });
    const unsubscribe = subscribeThemeChanges(
      (theme) => received.push(theme),
      listen,
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    window.dispatchEvent(
      new CustomEvent(THEME_CHANGED_EVENT, {
        detail: { theme: "slate" },
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: "light",
      }),
    );
    localStorage.setItem(THEME_STORAGE_KEY, "sand");
    window.dispatchEvent(new Event("focus"));
    tauriHandler?.({ payload: { theme: "forest" } });
    tauriHandler?.({ payload: { theme: "../../bad" } });

    expect(received).toEqual(["slate", "light", "sand", "forest"]);
    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(new Event("focus"));
    expect(received).toEqual(["slate", "light", "sand", "forest"]);
  });

  it("broadcasts the canonical payload", async () => {
    const custom = vi.fn();
    const emit = vi.fn(async () => undefined);
    window.addEventListener(THEME_CHANGED_EVENT, custom);
    await broadcastThemeChange("sand", emit);
    window.removeEventListener(THEME_CHANGED_EVENT, custom);

    expect(custom).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(THEME_CHANGED_EVENT, { theme: "sand" });
  });
});
