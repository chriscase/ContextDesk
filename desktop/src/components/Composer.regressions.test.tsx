/**
 * Regressions found by adversarially reviewing the hardening batch itself.
 *
 * Each case here failed against the first version of that batch; they exist so
 * the same mistakes cannot return under a later refactor.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const PLACEHOLDER = "Message ContextDesk…";
const input = () =>
  screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;

describe("the send latch is not held for the whole turn", () => {
  it("accepts a second send once the first turn is cancelled", async () => {
    // A long-running turn that never resolves — exactly what Stop leaves
    // behind. Holding the latch until the turn settled made every later send
    // a silent no-op.
    const onSubmit = vi.fn(() => new Promise<boolean>(() => {}));
    const { rerender } = render(<Composer onSubmit={onSubmit} busy={false} />);

    fireEvent.change(input(), { target: { value: "first" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // Stop: the turn is still unresolved, but the composer is usable again.
    rerender(<Composer onSubmit={onSubmit} busy={false} />);
    fireEvent.change(input(), { target: { value: "second" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith("second");
  });
});

describe("a spent seed is not replayed", () => {
  function SeedHost() {
    const [mounted, setMounted] = useState(true);
    const [seed, setSeed] = useState<{ id: number; text: string } | null>({
      id: 1,
      text: "seeded by a wizard",
    });
    const [draft, setDraft] = useState("");
    return (
      <div>
        <button type="button" onClick={() => setMounted((m) => !m)}>
          toggle pane
        </button>
        <span data-testid="draft">{draft}</span>
        {mounted ? (
          <Composer
            onSubmit={vi.fn()}
            seedRequest={seed}
            onSeedConsumed={(id) =>
              setSeed((cur) => (cur?.id === id ? null : cur))
            }
            draft={draft}
            onDraftChange={setDraft}
          />
        ) : null}
      </div>
    );
  }

  it("does not overwrite the user's draft when the pane is revisited", async () => {
    render(<SeedHost />);
    await waitFor(() => expect(input().value).toBe("seeded by a wizard"));

    // User replaces the seeded text with their own.
    fireEvent.change(input(), { target: { value: "my own question" } });
    await waitFor(() => expect(input().value).toBe("my own question"));

    // Leave and come back — Composer remounts with a fresh effect.
    fireEvent.click(screen.getByText("toggle pane"));
    fireEvent.click(screen.getByText("toggle pane"));

    await waitFor(() => expect(input().value).toBe("my own question"));
  });
});

describe("the composer is never inert", () => {
  it("accepts typing before a conversation id exists", async () => {
    // App passes draft/onDraftChange only once a session id exists; a
    // controlled empty string with a no-op writer swallowed every keystroke.
    render(<Composer onSubmit={vi.fn()} draft={undefined} />);

    fireEvent.change(input(), { target: { value: "typed before hydration" } });
    await waitFor(() =>
      expect(input().value).toBe("typed before hydration"),
    );
  });
});

describe("a streaming turn keeps its own wording", () => {
  it("does not let another reason replace the Stop explanation", () => {
    render(
      <Composer
        onSubmit={vi.fn()}
        busy
        onStop={vi.fn()}
        disabledReason="Updating this chat's context"
      />,
    );

    const hint = document.getElementById(
      input().getAttribute("aria-describedby")!,
    );
    expect(hint?.textContent).toMatch(/Stop to cancel/);
    expect(hint?.textContent).toMatch(/Updating this chat's context/);
  });

  it("explains an unresolved setup even though sending is still allowed", () => {
    // preflightBlocking does not disable the composer — sending opens Settings
    // — so the reason has to show while the composer is enabled.
    render(
      <Composer
        onSubmit={vi.fn()}
        disabledReason="Setup checks are unresolved — sending opens Settings instead"
      />,
    );

    const hint = document.getElementById(
      input().getAttribute("aria-describedby")!,
    );
    expect(hint?.textContent).toMatch(/Setup checks are unresolved/);
    expect(hint?.getAttribute("role")).toBe("status");
    expect(input().disabled).toBe(false);
  });
});

describe("a failed capability retry is surfaced", () => {
  it("restores the button and does not leak an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => {
      rejections.push(e.reason);
      e.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);

    const onRetryModelTools = vi.fn(async () => {
      throw new Error("host refused");
    });
    render(
      <Composer
        onSubmit={vi.fn()}
        models={[
          {
            id: "dolphin",
            label: "dolphin",
            selection_key: "ollama::dolphin",
            provider_id: "ollama",
            provider_label: "Ollama",
            group: "Ollama",
            is_default: false,
            tools_enabled: false,
            tools_disabled_reason: "model",
            availability: "discovered",
            availability_detail: null,
            hidden: false,
            hidden_by: null,
            pinned_rank: null,
          },
        ]}
        selectedModelKey="ollama::dolphin"
        onModelChange={vi.fn()}
        onRetryModelTools={onRetryModelTools}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Retry tools/i }));
    await waitFor(() => expect(onRetryModelTools).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // The control must not be left stuck on "Retrying…".
    expect(screen.getByRole("button", { name: /Retry tools/i })).toBeTruthy();
    expect(rejections).toHaveLength(0);
    window.removeEventListener("unhandledrejection", onUnhandled);
  });
});
