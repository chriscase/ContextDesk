import { describe, expect, it, vi } from "vitest";
import {
  publishTurnActivityUpdate,
  subscribeTurnActivityUpdate,
} from "./turnActivityUpdateBridge";

describe("turn activity update bridge", () => {
  it("delivers the exact owning session and stops after unsubscribe", () => {
    const listener = vi.fn();
    const stop = subscribeTurnActivityUpdate(listener);
    publishTurnActivityUpdate({ sessionId: "session-a" });
    stop();
    publishTurnActivityUpdate({ sessionId: "session-b" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: "session-a" });
  });
});
