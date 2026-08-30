import { describe, expect, it } from "vitest";
import { RequestSlot } from "./request-slot.js";

describe("RequestSlot", () => {
  it("aborts the prior generation and only accepts the current token", () => {
    const slot = new RequestSlot<string>();
    const caseA = slot.begin("case-a");
    const caseB = slot.begin("case-b");

    expect(caseA.scope).toBe("case-a");
    expect(caseA.signal.aborted).toBe(true);
    expect(slot.isCurrent(caseA)).toBe(false);
    expect(caseB.scope).toBe("case-b");
    expect(caseB.signal.aborted).toBe(false);
    expect(slot.isCurrent(caseB)).toBe(true);
  });

  it("invalidates completion even if an abort-insensitive request resolves", () => {
    const slot = new RequestSlot<number>();
    const token = slot.begin(1);
    slot.invalidate();

    expect(token.signal.aborted).toBe(true);
    expect(slot.isCurrent(token)).toBe(false);
  });

  it("disposes the active token and permits no stale token to recover", () => {
    const slot = new RequestSlot<string>();
    const first = slot.begin("case-a");
    slot.dispose();
    const second = slot.begin("case-a");

    expect(first.signal.aborted).toBe(true);
    expect(slot.isCurrent(first)).toBe(false);
    expect(slot.isCurrent(second)).toBe(true);
  });
});
