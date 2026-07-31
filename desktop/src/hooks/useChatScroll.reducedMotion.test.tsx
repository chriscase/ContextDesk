/**
 * Reduced motion for the scripted transcript scroll (#767).
 *
 * base.css neutralises CSS animations under `prefers-reduced-motion`, but it
 * cannot reach `scrollTo({ behavior: "smooth" })`. Jump-to-latest was therefore
 * the one place in the main window that still animated for users who asked it
 * not to.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession } from "../lib/session";
import { useChatScroll } from "./useChatScroll";

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

/** Mount the hook against a real scrollable element and capture scroll calls. */
function mount() {
  const session = newSession("Reduced motion");
  const scrollTo = vi.fn();
  const rendered = renderHook(() =>
    useChatScroll([], session.id, () => {}),
  );

  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: 2000, writable: false });
  Object.defineProperty(el, "clientHeight", { value: 400, writable: false });
  el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
  document.body.appendChild(el);
  (
    rendered.result.current.chatScrollRef as { current: HTMLDivElement | null }
  ).current = el;

  return { rendered, el, scrollTo };
}

/** Two nested rAFs is what pinScrollToEnd waits for before it touches the DOM. */
async function flushFrames() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("transcript scrolling respects reduced motion", () => {
  it("jumps instantly when the user has asked for reduced motion", async () => {
    setReducedMotion(true);
    const { rendered, el, scrollTo } = mount();

    await act(async () => {
      rendered.result.current.pinScrollToEnd("smooth");
    });
    await flushFrames();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(1600);
  });

  it("still animates when reduced motion is not requested", async () => {
    setReducedMotion(false);
    const { rendered, scrollTo } = mount();

    await act(async () => {
      rendered.result.current.pinScrollToEnd("smooth");
    });
    await flushFrames();

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
  });

  it("leaves an explicitly instant pin instant either way", async () => {
    setReducedMotion(false);
    const { rendered, el, scrollTo } = mount();

    await act(async () => {
      rendered.result.current.pinScrollToEnd("auto");
    });
    await flushFrames();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(1600);
  });
});
