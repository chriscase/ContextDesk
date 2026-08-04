import { describe, expect, it, vi } from "vitest";
import {
  broadcastTimeRevisionChanged,
  subscribeTimeRevisionChanged,
  TIME_REVISION_CHANGED_EVENT,
} from "./timeRevisionBridge";

describe("cross-window time-revision bridge (#875)", () => {
  it("accepts same-window and Tauri cross-webview signals and unsubscribes", async () => {
    const received: string[] = [];
    const stop = vi.fn();
    let tauriHandler:
      | ((event: { payload: { corpusId?: unknown } }) => void)
      | undefined;
    const listen = vi.fn(async (_name, handler) => {
      tauriHandler = handler;
      return stop;
    });
    const unsubscribe = subscribeTimeRevisionChanged(
      (corpusId) => received.push(corpusId),
      listen,
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    window.dispatchEvent(
      new CustomEvent(TIME_REVISION_CHANGED_EVENT, {
        detail: { corpusId: "corpus-a" },
      }),
    );
    tauriHandler?.({ payload: { corpusId: "corpus-b" } });
    // Malformed or empty payloads must never surface as a "changed" signal.
    tauriHandler?.({ payload: { corpusId: "" } });
    tauriHandler?.({ payload: {} });

    expect(received).toEqual(["corpus-a", "corpus-b"]);
    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
    window.dispatchEvent(
      new CustomEvent(TIME_REVISION_CHANGED_EVENT, {
        detail: { corpusId: "corpus-c" },
      }),
    );
    expect(received).toEqual(["corpus-a", "corpus-b"]);
  });

  it("broadcasts the corpus id to both same-window listeners and the Tauri bus", async () => {
    const custom = vi.fn();
    const emit = vi.fn(async () => undefined);
    window.addEventListener(TIME_REVISION_CHANGED_EVENT, custom);
    await broadcastTimeRevisionChanged("corpus-x", emit);
    window.removeEventListener(TIME_REVISION_CHANGED_EVENT, custom);

    expect(custom).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(TIME_REVISION_CHANGED_EVENT, {
      corpusId: "corpus-x",
    });
  });

  it("never throws when there is no Tauri event bus (browser preview, tests)", async () => {
    const custom = vi.fn();
    window.addEventListener(TIME_REVISION_CHANGED_EVENT, custom);
    await expect(
      broadcastTimeRevisionChanged("corpus-y", () => {
        throw new Error("no Tauri bus here");
      }),
    ).resolves.toBeUndefined();
    window.removeEventListener(TIME_REVISION_CHANGED_EVENT, custom);
    // The same-window signal must still land even if the cross-webview leg fails.
    expect(custom).toHaveBeenCalledOnce();
  });
});
