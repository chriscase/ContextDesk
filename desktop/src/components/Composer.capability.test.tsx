/**
 * Capability truth in the main composer (#650).
 *
 * The core keys learned native-tool rejection by provider *and* model, and the
 * linked rail already reports it — but the main-window picker showed nothing,
 * so a user in an ordinary chat could select a model that silently cannot call
 * tools, with no way to re-test it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelOptionDto } from "../lib/host";
import { Composer } from "./Composer";

function model(
  id: string,
  overrides: Partial<ModelOptionDto> = {},
): ModelOptionDto {
  return {
    id,
    label: id,
    selection_key: `ollama::${id}`,
    provider_id: "ollama",
    provider_label: "Ollama",
    group: "Ollama",
    is_default: false,
    tools_enabled: true,
    tools_disabled_reason: null,
    ...overrides,
  };
}

/** One proven model and one that rejected tools — the #650 scenario. */
const MIXED: ModelOptionDto[] = [
  model("mistral:latest"),
  model("dolphin-llama3:8b", {
    tools_enabled: false,
    tools_disabled_reason: "model",
  }),
];

function renderComposer(
  models: ModelOptionDto[],
  selectedModelKey: string,
  extra: Partial<React.ComponentProps<typeof Composer>> = {},
) {
  return render(
    <Composer
      onSubmit={vi.fn()}
      models={models}
      selectedModelKey={selectedModelKey}
      onModelChange={vi.fn()}
      {...extra}
    />,
  );
}

describe("per-model tool capability", () => {
  it("marks only the rejected model, never its proven sibling", () => {
    renderComposer(MIXED, "ollama::mistral:latest");

    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    const proven = options.find((o) => o.value === "ollama::mistral:latest")!;
    const rejected = options.find(
      (o) => o.value === "ollama::dolphin-llama3:8b",
    )!;

    expect(proven.textContent).not.toContain("tools unavailable");
    expect(rejected.textContent).toContain("tools unavailable");
  });

  it("says nothing about capability while a tools-capable model is selected", () => {
    renderComposer(MIXED, "ollama::mistral:latest");

    expect(screen.queryByText(/rejected native tools/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry tools/i })).toBeNull();
  });

  it("explains a learned rejection and offers a retry for that pair only", async () => {
    const onRetryModelTools = vi.fn(async (_model: ModelOptionDto) => undefined);
    renderComposer(MIXED, "ollama::dolphin-llama3:8b", { onRetryModelTools });

    expect(screen.getByText(/rejected native tools/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Retry tools/i }));
    await waitFor(() => expect(onRetryModelTools).toHaveBeenCalledTimes(1));
    expect(onRetryModelTools.mock.calls[0]![0]).toMatchObject({
      provider_id: "ollama",
      id: "dolphin-llama3:8b",
    });
  });

  it("treats a profile-level decision as the user's, not a retryable rejection", () => {
    const profileDisabled = [
      model("grok-1", {
        tools_enabled: false,
        tools_disabled_reason: "profile",
      }),
    ];
    renderComposer(profileDisabled, "ollama::grok-1", {
      onRetryModelTools: vi.fn(),
    });

    expect(screen.getByText(/Tools are off for this provider/i)).toBeTruthy();
    // Retry would silently contradict an explicit configuration choice.
    expect(screen.queryByRole("button", { name: /Retry tools/i })).toBeNull();

    const option = screen.getAllByRole("option")[0] as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("keeps a learned-disabled model selectable so it can be retried", () => {
    renderComposer(MIXED, "ollama::mistral:latest");

    const rejected = (screen.getAllByRole("option") as HTMLOptionElement[]).find(
      (o) => o.value === "ollama::dolphin-llama3:8b",
    )!;
    expect(rejected.disabled).toBe(false);
  });

  it("shows the retry as in flight and restores it when the host answers", async () => {
    let release!: () => void;
    const onRetryModelTools = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    renderComposer(MIXED, "ollama::dolphin-llama3:8b", { onRetryModelTools });

    fireEvent.click(screen.getByRole("button", { name: /Retry tools/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Retrying…/ })).toBeTruthy(),
    );

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Retry tools/i })).toBeTruthy(),
    );
  });
});
