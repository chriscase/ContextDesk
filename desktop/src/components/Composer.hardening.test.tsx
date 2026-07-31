/**
 * Composer hardening: draft ownership, focus return, double-send, and the
 * reason a blocked composer gives for being blocked.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const PLACEHOLDER = "Message ContextDesk…";

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

describe("draft ownership", () => {
  /** Stands in for App: drafts live above the component, keyed by chat. */
  function DraftHost({ onSubmit }: { onSubmit: () => boolean }) {
    const [sessionId, setSessionId] = useState("chat-a");
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [mounted, setMounted] = useState(true);
    return (
      <div>
        <button type="button" onClick={() => setSessionId("chat-b")}>
          go to chat B
        </button>
        <button type="button" onClick={() => setSessionId("chat-a")}>
          go to chat A
        </button>
        <button type="button" onClick={() => setMounted((m) => !m)}>
          toggle pane
        </button>
        {mounted ? (
          <Composer
            onSubmit={onSubmit}
            draft={drafts[sessionId] ?? ""}
            onDraftChange={(text) =>
              setDrafts((all) => ({ ...all, [sessionId]: text }))
            }
          />
        ) : null}
      </div>
    );
  }

  it("keeps a draft with its own conversation instead of following the user", async () => {
    render(<DraftHost onSubmit={() => true} />);

    fireEvent.change(input(), { target: { value: "notes for chat A" } });
    expect(input().value).toBe("notes for chat A");

    fireEvent.click(screen.getByText("go to chat B"));
    // The other conversation must start clean — this is what used to let a
    // draft written for A be sent into B.
    await waitFor(() => expect(input().value).toBe(""));

    fireEvent.click(screen.getByText("go to chat A"));
    await waitFor(() => expect(input().value).toBe("notes for chat A"));
  });

  it("survives leaving and returning to the chat pane", async () => {
    render(<DraftHost onSubmit={() => true} />);

    fireEvent.change(input(), { target: { value: "half-written question" } });
    fireEvent.click(screen.getByText("toggle pane"));
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();

    fireEvent.click(screen.getByText("toggle pane"));
    await waitFor(() =>
      expect(input().value).toBe("half-written question"),
    );
  });

  it("clears the draft once the send is accepted", async () => {
    render(<DraftHost onSubmit={() => true} />);

    fireEvent.change(input(), { target: { value: "ship it" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(input().value).toBe(""));
    fireEvent.click(screen.getByText("go to chat B"));
    fireEvent.click(screen.getByText("go to chat A"));
    await waitFor(() => expect(input().value).toBe(""));
  });
});

describe("double send", () => {
  it("submits once when two Enters land in the same frame", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer onSubmit={onSubmit} />);

    fireEvent.change(input(), { target: { value: "only once" } });

    // `fireEvent` wraps each call in act() and flushes React in between, which
    // would hide the race. Dispatching both native events in one task is what
    // a fast double-Enter actually does: two handlers run against the same
    // pre-clear render.
    const el = input();
    const press = () =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    await act(async () => {
      press();
      press();
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith("only once");
  });
});

describe("focus return", () => {
  it("returns the caret to the composer after sending with the Send button", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer onSubmit={onSubmit} />);

    fireEvent.change(input(), { target: { value: "sent by mouse" } });
    const send = screen.getByRole("button", { name: "Send" });
    send.focus();
    fireEvent.click(send);

    // The Send button disables itself once the draft clears, so without an
    // explicit restore focus would fall through to <body>.
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it("does not steal focus the user moved outside the composer", async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <div>
        <Composer onSubmit={onSubmit} />
        <button type="button">elsewhere</button>
      </div>,
    );

    fireEvent.change(input(), { target: { value: "send then leave" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    const outside = screen.getByText("elsewhere");
    outside.focus();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(outside);
  });
});

describe("blocked composer explains itself", () => {
  it("names the reason in the hint the input is described by", () => {
    render(
      <Composer
        onSubmit={vi.fn()}
        disabled
        disabledReason="Updating this chat's context — sending resumes when it finishes"
      />,
    );

    const hint = document.getElementById(
      input().getAttribute("aria-describedby")!,
    );
    expect(hint?.textContent).toContain("Updating this chat's context");
    expect(hint?.getAttribute("role")).toBe("status");
  });

  it("explains a busy turn rather than showing only keyboard hints", () => {
    render(<Composer onSubmit={vi.fn()} busy onStop={vi.fn()} />);

    const hint = document.getElementById(
      input().getAttribute("aria-describedby")!,
    );
    expect(hint?.textContent).toMatch(/Waiting for the response/i);
    // Stop stays reachable and named while the reason is showing.
    expect(
      screen.getByRole("button", { name: /Stop/ }),
    ).toBeTruthy();
  });

  it("shows keyboard hints again once input is available", () => {
    render(<Composer onSubmit={vi.fn()} />);

    const hint = document.getElementById(
      input().getAttribute("aria-describedby")!,
    );
    expect(hint?.textContent).toContain("Shift+Enter");
    expect(hint?.getAttribute("role")).toBeNull();
  });

  it("points the Send button at the same explanation", () => {
    render(
      <Composer onSubmit={vi.fn()} disabled disabledReason="Paused for setup" />,
    );

    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("aria-describedby")).toBe(
      input().getAttribute("aria-describedby"),
    );
  });
});
