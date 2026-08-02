import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUiScaleToDocument,
  broadcastUiScaleChange,
  isUiScale,
  parseUiScale,
  subscribeUiScaleChanges,
  UI_SCALE_CHANGED_EVENT,
  UI_SCALE_STORAGE_KEY,
} from "./uiScaleBridge";

describe("cross-window UI scale bridge", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-ui-scale");
    vi.unstubAllGlobals();
  });

  it("validates against the UiScale allow-list", () => {
    expect(isUiScale("90")).toBe(true);
    expect(isUiScale("100")).toBe(true);
    expect(isUiScale("110")).toBe(true);
    expect(isUiScale("120")).toBe(false);
    expect(isUiScale(100)).toBe(false);
    expect(isUiScale(null)).toBe(false);
    expect(parseUiScale("90")).toBe("90");
  });

  it("fails closed to 100 on unknown values", () => {
    expect(parseUiScale("125")).toBe("100");
    expect(parseUiScale(undefined)).toBe("100");
    expect(applyUiScaleToDocument("../unsafe")).toBe("100");
    expect(document.documentElement.getAttribute("data-ui-scale")).toBe("100");
  });

  it("applies a persisted value to the document and storage", () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, "90");
    const applied = applyUiScaleToDocument(
      localStorage.getItem(UI_SCALE_STORAGE_KEY),
    );
    expect(applied).toBe("90");
    expect(document.documentElement.getAttribute("data-ui-scale")).toBe("90");
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe("90");
  });

  it("accepts custom, storage, focus, and Tauri events and unsubscribes", async () => {
    const received: string[] = [];
    const stop = vi.fn();
    let tauriHandler:
      | ((event: { payload: { uiScale?: unknown } }) => void)
      | undefined;
    const listen = vi.fn(async (_name, handler) => {
      tauriHandler = handler;
      return stop;
    });
    const unsubscribe = subscribeUiScaleChanges(
      (uiScale) => received.push(uiScale),
      listen,
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    window.dispatchEvent(
      new CustomEvent(UI_SCALE_CHANGED_EVENT, {
        detail: { uiScale: "110" },
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: UI_SCALE_STORAGE_KEY,
        newValue: "90",
      }),
    );
    localStorage.setItem(UI_SCALE_STORAGE_KEY, "100");
    window.dispatchEvent(new Event("focus"));
    tauriHandler?.({ payload: { uiScale: "110" } });
    // Malformed payloads are ignored, never coerced to "100".
    tauriHandler?.({ payload: { uiScale: "9000" } });
    window.dispatchEvent(
      new CustomEvent(UI_SCALE_CHANGED_EVENT, { detail: { uiScale: 90 } }),
    );

    expect(received).toEqual(["110", "90", "100", "110"]);
    unsubscribe();
    expect(stop).toHaveBeenCalled();

    window.dispatchEvent(
      new CustomEvent(UI_SCALE_CHANGED_EVENT, {
        detail: { uiScale: "90" },
      }),
    );
    tauriHandler?.({ payload: { uiScale: "90" } });
    expect(received).toEqual(["110", "90", "100", "110"]);
  });

  it("ignores storage events for other keys", () => {
    const received: string[] = [];
    const unsubscribe = subscribeUiScaleChanges((uiScale) =>
      received.push(uiScale),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "cd-theme", newValue: "90" }),
    );
    expect(received).toEqual([]);
    unsubscribe();
  });

  it("does not throw outside Tauri for broadcast or subscribe", async () => {
    // No injected emit/listen: the dynamic @tauri-apps import path must fail
    // silently in a plain browser/test environment.
    await expect(broadcastUiScaleChange("110")).resolves.toBeUndefined();
    const unsubscribe = subscribeUiScaleChanges(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => unsubscribe()).not.toThrow();
  });
});
