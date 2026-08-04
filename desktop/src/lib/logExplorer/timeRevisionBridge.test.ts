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
      | ((event: {
          payload: { corpusId?: unknown; eventId?: unknown };
        }) => void)
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
    tauriHandler?.({
      payload: { corpusId: "ignored", eventId: "x".repeat(129) },
    });

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
    const customPayload = (custom.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(customPayload).toEqual({
      corpusId: "corpus-x",
      eventId: expect.any(String),
    });
    expect(emit).toHaveBeenCalledWith(
      TIME_REVISION_CHANGED_EVENT,
      customPayload,
    );
  });

  it("delivers one logical same-window plus Tauri broadcast only once", async () => {
    const received = vi.fn();
    let tauriHandler:
      | ((event: {
          payload: { corpusId?: unknown; eventId?: unknown };
        }) => void)
      | undefined;
    const listen = vi.fn(async (_name, handler) => {
      tauriHandler = handler;
      return vi.fn();
    });
    const unsubscribe = subscribeTimeRevisionChanged(received, listen);
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    await broadcastTimeRevisionChanged("corpus-dedup", async (_name, payload) => {
      tauriHandler?.({ payload });
    });

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith("corpus-dedup");
    unsubscribe();
  });

  it("bounds remembered event ids with deterministic FIFO eviction", async () => {
    const received = vi.fn();
    const unsubscribe = subscribeTimeRevisionChanged(
      received,
      async () => () => undefined,
    );
    const dispatch = (eventId: string) =>
      window.dispatchEvent(
        new CustomEvent(TIME_REVISION_CHANGED_EVENT, {
          detail: { corpusId: "corpus-bounded", eventId },
        }),
      );

    for (let index = 0; index < 129; index += 1) {
      dispatch(`event-${index}`);
    }
    dispatch("event-128"); // newest remains remembered
    dispatch("event-0"); // oldest was evicted after the 129th unique id

    expect(received).toHaveBeenCalledTimes(130);
    unsubscribe();
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
