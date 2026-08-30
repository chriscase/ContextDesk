import { describe, expect, it } from "vitest";
import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  resetResource,
  succeedResourceLoad,
} from "./resource-state.js";

const network = { kind: "network" } as const;

describe("keyed resource state", () => {
  it("preserves a ready value while refreshing the same key", () => {
    const initial = beginResourceLoad(createResourceState<string, string>(), "case-a");
    const ready = succeedResourceLoad(initial, "case-a", "A");

    expect(beginResourceLoad(ready, "case-a")).toEqual({
      key: "case-a",
      state: { status: "loading", previous: "A" },
    });
  });

  it("never exposes case A as case B's previous value", () => {
    const loadingA = beginResourceLoad(createResourceState<string, string>(), "case-a");
    const readyA = succeedResourceLoad(loadingA, "case-a", "A");

    expect(beginResourceLoad(readyA, "case-b")).toEqual({
      key: "case-b",
      state: { status: "loading" },
    });
  });

  it("retains same-key previous data on failure and ignores stale completion", () => {
    const loadingA = beginResourceLoad(createResourceState<string, string>(), "case-a");
    const readyA = succeedResourceLoad(loadingA, "case-a", "A");
    const refreshingA = beginResourceLoad(readyA, "case-a");
    const failedA = failResourceLoad(refreshingA, "case-a", network);

    expect(failedA).toEqual({
      key: "case-a",
      state: { status: "failed", error: network, previous: "A" },
    });
    expect(succeedResourceLoad(failedA, "case-b", "B")).toBe(failedA);
    expect(failResourceLoad(failedA, "case-b", network)).toBe(failedA);
  });

  it.each([
    { kind: "not_found", status: 404 } as const,
    { kind: "auth_lost", status: 403 } as const,
  ])("evicts previously published bytes after terminal $kind failure", (error) => {
    const loading = beginResourceLoad(createResourceState<string, string>(), "case-a");
    const ready = succeedResourceLoad(loading, "case-a", "sensitive A");
    const refreshing = beginResourceLoad(ready, "case-a");

    expect(failResourceLoad(refreshing, "case-a", error)).toEqual({
      key: "case-a",
      state: { status: "failed", error },
    });
  });

  it("reset removes both the resource identity and its published value", () => {
    expect(resetResource<string, string>()).toEqual({
      key: null,
      state: { status: "idle" },
    });
  });
});
