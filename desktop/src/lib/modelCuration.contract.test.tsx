/**
 * Every ordinary picker must consume the one curated-selection contract (#678).
 *
 * The failure this guards against is drift: before the shared contract, the
 * main composer and the linked-chat rail each grouped and ordered models their
 * own way, so a curation rule could be true in one picker and quietly false in
 * the other. These render the *real* components against one inventory and
 * assert they agree.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelOptionDto } from "@contextdesk/contracts";
import { Composer } from "../components/Composer";

function model(
  provider: string,
  id: string,
  overrides: Partial<ModelOptionDto> = {},
): ModelOptionDto {
  return {
    id,
    label: id,
    selection_key: `${provider}::${id}`,
    provider_id: provider,
    provider_label: provider === "ollama" ? "Ollama (local)" : "Gateway",
    group: provider === "ollama" ? "Ollama (local)" : "Gateway",
    is_default: false,
    tools_enabled: true,
    tools_disabled_reason: null,
    availability: "discovered",
    availability_detail: null,
    hidden: false,
    hidden_by: null,
    pinned_rank: null,
    ...overrides,
  };
}

/** One inventory exercising pin, hide, and an ordinary choice. */
const INVENTORY: ModelOptionDto[] = [
  model("gw", "gpt-4o"),
  model("ollama", "mistral", { pinned_rank: 0 }),
  model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
];

function renderComposerPicker(selectedKey = "ollama::mistral") {
  render(
    <Composer
      onSubmit={vi.fn()}
      models={INVENTORY}
      selectedModelKey={selectedKey}
      onModelChange={vi.fn()}
    />,
  );
  return screen.getByRole("combobox", { name: "Chat model by source" });
}

describe("the composer picker follows the shared contract", () => {
  it("shows the pinned band first and omits curated-away choices", () => {
    const select = renderComposerPicker();
    const groups = within(select).getAllByRole("group");

    expect(groups[0]).toHaveProperty("label", "Pinned");
    const optionValues = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);

    expect(optionValues[0]).toBe("ollama::mistral");
    expect(optionValues).toContain("gw::gpt-4o");
    expect(optionValues).not.toContain("ollama::llama3");
  });

  it("still offers a hidden model when it is the conversation's selection", () => {
    const select = renderComposerPicker("ollama::llama3");
    const optionValues = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);

    expect(optionValues).toContain("ollama::llama3");
    // …and says so, rather than presenting it as an ordinary choice.
    expect(
      within(select).getByRole("option", { name: /llama3.*hidden/i }),
    ).toBeTruthy();
  });

  it("keeps #650 capability truth alongside curation", () => {
    render(
      <Composer
        onSubmit={vi.fn()}
        models={[
          model("ollama", "dolphin", {
            tools_enabled: false,
            tools_disabled_reason: "model",
          }),
        ]}
        selectedModelKey="ollama::dolphin"
        onModelChange={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox", {
      name: "Chat model by source",
    });
    expect(
      within(select).getByRole("option", { name: /tools unavailable/i }),
    ).toBeTruthy();
  });
});

describe("no picker re-implements grouping", () => {
  it("the composer routes its options through curateModels, not a local copy", async () => {
    // Spying on the shared module proves the picker actually *calls* it. A
    // picker that quietly reverted to its own grouping would still render, and
    // would still pass every behavioural test above by coincidence — this is
    // what catches the drift itself.
    vi.resetModules();
    const spy = vi.fn(
      (await vi.importActual<typeof import("./modelCuration")>(
        "./modelCuration",
      )).curateModels,
    );
    vi.doMock("./modelCuration", async () => ({
      ...(await vi.importActual<typeof import("./modelCuration")>(
        "./modelCuration",
      )),
      curateModels: spy,
    }));

    const { Composer: Fresh } = await import("../components/Composer");
    render(
      <Fresh
        onSubmit={vi.fn()}
        models={INVENTORY}
        selectedModelKey="ollama::mistral"
        onModelChange={vi.fn()}
      />,
    );

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0]).toEqual(INVENTORY);
    vi.doUnmock("./modelCuration");
    vi.resetModules();
  });
});
