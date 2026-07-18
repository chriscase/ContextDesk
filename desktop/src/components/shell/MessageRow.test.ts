import { describe, expect, it } from "vitest";
import { messageRowPropsEqual, type MessageRowProps } from "./MessageRow";
import type { Msg } from "../../lib/session";

function base(over: Partial<Msg> = {}): MessageRowProps {
  const msg: Msg = {
    id: "m1",
    role: "assistant",
    content: "hello",
    streaming: false,
    ...over,
  };
  return {
    msg,
    turnStartedAt: null,
    effectiveChatModel: "gpt",
    setSourcePath: () => {},
    setSourceContent: () => {},
    setPane: () => {},
  };
}

describe("messageRowPropsEqual (#148)", () => {
  it("treats identical settled rows as equal", () => {
    const a = base();
    const b = base();
    expect(messageRowPropsEqual(a, b)).toBe(true);
  });

  it("detects content change (neighbor stream must not re-render settled)", () => {
    const a = base({ content: "a" });
    const b = base({ content: "ab" });
    expect(messageRowPropsEqual(a, b)).toBe(false);
  });

  it("detects streaming flag and tool count", () => {
    expect(
      messageRowPropsEqual(base({ streaming: false }), base({ streaming: true })),
    ).toBe(false);
    expect(
      messageRowPropsEqual(
        base({ tools: [{ id: "1", name: "t", summary: "x" }] }),
        base({ tools: [] }),
      ),
    ).toBe(false);
  });

  it("ignores setSourcePath identity churn for settled rows", () => {
    const a = base();
    const b = { ...base(), setSourcePath: () => {} };
    expect(messageRowPropsEqual(a, b)).toBe(true);
  });
});
