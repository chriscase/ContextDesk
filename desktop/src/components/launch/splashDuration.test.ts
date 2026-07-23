import { describe, expect, it } from "vitest";
import {
  markSplashCompleted,
  resolveSplashDuration,
  shouldSkipSplash,
  SPLASH_FIRST_MS,
  SPLASH_RETURN_MS,
  SPLASH_STORAGE_KEY,
} from "./splashDuration";

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe("splashDuration", () => {
  it("uses longer duration on first visit", () => {
    const s = memStore();
    expect(resolveSplashDuration(SPLASH_STORAGE_KEY, s)).toBe(SPLASH_FIRST_MS);
  });

  it("uses shorter duration after complete", () => {
    const s = memStore();
    markSplashCompleted(SPLASH_STORAGE_KEY, s);
    expect(resolveSplashDuration(SPLASH_STORAGE_KEY, s)).toBe(SPLASH_RETURN_MS);
  });

  it("honors explicit override", () => {
    expect(resolveSplashDuration(SPLASH_STORAGE_KEY, memStore(), 100)).toBe(100);
  });

  it("detects skip flags", () => {
    expect(shouldSkipSplash("?skipSplash=1")).toBe(true);
    expect(shouldSkipSplash("")).toBe(false);
  });
});
