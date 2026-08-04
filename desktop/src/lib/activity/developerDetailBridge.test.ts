import { describe, expect, it, vi } from "vitest";
import {
  publishDeveloperDetail,
  subscribeDeveloperDetail,
} from "./developerDetailBridge";
import type { DeveloperDetailEvent } from "./types";

const event: DeveloperDetailEvent = {
  seq: 7,
  elapsed_ms: 12,
  kind: "tool_call",
  label: "Selected tool: search_kb",
  round: 0,
  tool_name: "search_kb",
  offered_tools: [],
  request: [],
  status: "selected",
  sensitive: true,
};

describe("developer detail live bridge", () => {
  it("delivers the exact session/message envelope and stops after unsubscribe", () => {
    const listener = vi.fn();
    const stop = subscribeDeveloperDetail(listener);
    publishDeveloperDetail({ sessionId: "session-a", messageId: "message-a", event });
    stop();
    publishDeveloperDetail({ sessionId: "session-b", messageId: "message-a", event });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      sessionId: "session-a",
      messageId: "message-a",
      event,
    });
  });
});
