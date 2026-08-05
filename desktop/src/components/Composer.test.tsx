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

  it("sends explicit one-turn context only when the user selected it", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    const selected = screen.getByLabelText(
      "Selected context for the next message",
    ) as HTMLTextAreaElement;
    fireEvent.change(selected, {
      target: { value: "GUI_SELECTION_TOKEN_7QK9" },
    });
    fireEvent.change(screen.getByPlaceholderText("Message ContextDesk…"), {
      target: { value: "use my selected text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "use my selected text",
        "GUI_SELECTION_TOKEN_7QK9",
      ),
    );
    expect(selected.value).toBe("");
  });

  it("does not invent selected context for an ordinary send", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText("Message ContextDesk…"), {
      target: { value: "ordinary message" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("ordinary message"),
    );
  });

  it("does not offer free-form selection for host-resolved linked-log turns", () => {
    render(<Composer onSubmit={vi.fn()} allowUserSelection={false} />);
    expect(screen.queryByRole("button", { name: "Context" })).toBeNull();
    expect(
      screen.queryByLabelText("Selected context for the next message"),
    ).toBeNull();
  });
});
