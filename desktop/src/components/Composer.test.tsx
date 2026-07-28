import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer keyboard interactions", () => {
  it("sends once with Enter and keeps Shift+Enter as a newline", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText("Message ContextDesk…");

    fireEvent.change(input, { target: { value: "first line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "send this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("send this"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit while an input method is composing", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText("Message ContextDesk…");
    fireEvent.change(input, { target: { value: "編集中" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("restores the draft when the parent rejects the send", async () => {
    const onSubmit = vi.fn(async () => false);
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(
      "Message ContextDesk…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "keep my draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("keep my draft"));
  });
});
