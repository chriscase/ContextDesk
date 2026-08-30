import { describe, expect, it } from "vitest";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
} from "./scoped-mutation-state.js";

describe("scoped mutation state", () => {
  it("hides a completed result synchronously when authority changes", () => {
    const first = mutationScopeKey(["alice", "authority-v1", "case-a"]);
    const second = mutationScopeKey(["alice", "authority-v2", "case-a"]);
    const stored = scopedMutationState(first, { status: "succeeded", value: "private-a" });

    expect(visibleMutationState(stored, first)).toEqual({
      status: "succeeded",
      value: "private-a",
    });
    expect(visibleMutationState(stored, second)).toEqual({ status: "idle" });
    expect(visibleMutationState(stored, null)).toEqual({ status: "idle" });
  });

  it("starts without a publishable scope", () => {
    expect(visibleMutationState(emptyScopedMutationState<string>(), "case-a"))
      .toEqual({ status: "idle" });
  });
});
