/**
 * The shared curated-selection contract (#678).
 *
 * Every picker consumes `curateModels`, so these are the rules that decide
 * what a user is offered — including the ones that keep the app honest when
 * curation and reality disagree.
 */

import { describe, expect, it } from "vitest";
import type { ModelOptionDto } from "@contextdesk/contracts";
import {
  DEFAULT_PICKER_LIMIT,
  curateModels,
  curationSummary,
} from "./modelCuration";

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

const keysOf = (list: ModelOptionDto[]) => list.map((m) => m.selection_key);

describe("what an ordinary picker offers", () => {
  const inventory = [
    model("ollama", "mistral"),
    model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
    model("gw", "gpt-4o"),
  ];

  it("omits curated-away choices by default", () => {
    const view = curateModels(inventory);
    expect(keysOf(view.available)).toEqual(["ollama::mistral", "gw::gpt-4o"]);
    expect(view.hidden).toHaveLength(0);
    expect(view.hiddenCount).toBe(1);
  });

  it("lists them for a management surface that asks", () => {
    const view = curateModels(inventory, { includeHidden: true });
    expect(keysOf(view.hidden)).toEqual(["ollama::llama3"]);
  });

  it("puts pinned choices first, in the user's explicit order", () => {
    const view = curateModels([
      model("gw", "gpt-4o"),
      model("ollama", "mistral", { pinned_rank: 1 }),
      model("ollama", "phi", { pinned_rank: 0 }),
    ]);
    expect(keysOf(view.pinned)).toEqual(["ollama::phi", "ollama::mistral"]);
    expect(view.groups[0]!.label).toBe("Pinned");
    expect(keysOf(view.available)).toEqual(["gw::gpt-4o"]);
  });

  it("reports an empty inventory rather than pretending", () => {
    const view = curateModels([]);
    expect(view.empty).toBe(true);
    expect(view.groups).toHaveLength(0);
  });
});

describe("a conversation never loses its own selection", () => {
  it("still renders a selected model that has been hidden", () => {
    const view = curateModels(
      [
        model("ollama", "mistral"),
        model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
      ],
      { selectedKey: "ollama::llama3" },
    );

    expect(view.selectedHidden?.selection_key).toBe("ollama::llama3");
    expect(keysOf(view.hidden)).toContain("ollama::llama3");
  });

  it("keeps the selection visible even when a search excludes it", () => {
    const view = curateModels(
      [model("ollama", "mistral"), model("gw", "gpt-4o")],
      { selectedKey: "gw::gpt-4o", query: "mistral" },
    );

    expect(keysOf(view.available)).toContain("gw::gpt-4o");
    expect(view.filtered).toBe(true);
  });

  it("does not mark a visible selection as hidden", () => {
    const view = curateModels([model("ollama", "mistral")], {
      selectedKey: "ollama::mistral",
    });
    expect(view.selectedHidden).toBeNull();
  });
});

describe("provider and model hiding compose", () => {
  it("distinguishes why a choice is hidden", () => {
    const view = curateModels(
      [
        model("gw", "a", { hidden: true, hidden_by: "provider" }),
        model("ollama", "b", { hidden: true, hidden_by: "model" }),
      ],
      { includeHidden: true },
    );

    const byKey = new Map(view.hidden.map((m) => [m.selection_key, m]));
    expect(byKey.get("gw::a")?.hidden_by).toBe("provider");
    expect(byKey.get("ollama::b")?.hidden_by).toBe("model");
  });

  it("leaves a sibling provider's identically named model alone", () => {
    // Two gateways can both expose `llama3`; curation is per scope.
    const view = curateModels([
      model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
      model("gw", "llama3"),
    ]);
    expect(keysOf(view.available)).toEqual(["gw::llama3"]);
  });
});

describe("curation never launders provider health", () => {
  it("keeps tool-capability truth on a hidden choice", () => {
    const view = curateModels(
      [
        model("ollama", "dolphin", {
          hidden: true,
          hidden_by: "model",
          tools_enabled: false,
          tools_disabled_reason: "model",
        }),
      ],
      { includeHidden: true },
    );

    const dolphin = view.hidden[0]!;
    expect(dolphin.tools_enabled).toBe(false);
    expect(dolphin.tools_disabled_reason).toBe("model");
  });

  it("does not treat an unavailable model as hidden, or the reverse", () => {
    const view = curateModels([
      model("ollama", "broken", {
        tools_enabled: false,
        tools_disabled_reason: "profile",
      }),
    ]);
    // A failing model is still offered — hiding it is the user's choice, and
    // hiding must never be how a failure gets swept out of sight.
    expect(keysOf(view.available)).toEqual(["ollama::broken"]);
    expect(view.hiddenCount).toBe(0);
  });
});

describe("large inventories stay bounded", () => {
  const many = Array.from({ length: 1000 }, (_, i) =>
    model("gw", `model-${String(i).padStart(4, "0")}`),
  );

  it("caps what a picker renders and says how much it dropped", () => {
    const view = curateModels(many);
    expect(view.available).toHaveLength(DEFAULT_PICKER_LIMIT);
    expect(view.truncated).toBe(1000 - DEFAULT_PICKER_LIMIT);
  });

  it("prioritizes pinned choices within the cap", () => {
    const withPin = [
      ...many,
      model("gw", "favourite", { pinned_rank: 0 }),
    ];
    const view = curateModels(withPin, { limit: 10 });
    expect(keysOf(view.pinned)).toEqual(["gw::favourite"]);
    expect(view.available.length).toBeLessThanOrEqual(9);
  });

  it("keeps the total bounded when pinned and hidden bands exceed the cap", () => {
    const inventory = [
      ...Array.from({ length: 15 }, (_, i) =>
        model("gw", `pinned-${i}`, { pinned_rank: i }),
      ),
      ...Array.from({ length: 15 }, (_, i) => model("gw", `available-${i}`)),
      ...Array.from({ length: 15 }, (_, i) =>
        model("gw", `hidden-${i}`, {
          hidden: true,
          hidden_by: "model",
        }),
      ),
    ];
    const view = curateModels(inventory, { includeHidden: true, limit: 10 });

    expect(
      view.pinned.length + view.available.length + view.hidden.length,
    ).toBe(10);
    expect(view.pinned).toHaveLength(10);
    expect(view.truncated).toBe(inventory.length - 10);
  });

  it("preserves a selected hidden choice without exceeding the total cap", () => {
    const inventory = [
      ...Array.from({ length: 10 }, (_, i) =>
        model("gw", `pinned-${i}`, { pinned_rank: i }),
      ),
      model("gw", "selected-hidden", {
        hidden: true,
        hidden_by: "model",
      }),
    ];
    const view = curateModels(inventory, {
      includeHidden: true,
      selectedKey: "gw::selected-hidden",
      limit: 10,
    });

    expect(keysOf(view.hidden)).toEqual(["gw::selected-hidden"]);
    expect(view.pinned).toHaveLength(9);
    expect(
      view.pinned.length + view.available.length + view.hidden.length,
    ).toBe(10);
    expect(view.truncated).toBe(1);
  });

  it("never drops the current selection to satisfy the cap", () => {
    const view = curateModels(many, {
      limit: 5,
      selectedKey: "gw::model-0999",
    });
    expect(keysOf(view.available)).toContain("gw::model-0999");
  });

  it("keeps the limit an actual bound when the selection is outside it", () => {
    const view = curateModels(many, {
      limit: 5,
      selectedKey: "gw::model-0999",
    });
    // Making room for the selection must displace a row, not add one — a caller
    // sizing a list on `limit` would otherwise render one row too many.
    expect(view.available).toHaveLength(5);
    expect(
      keysOf(view.available).filter((k) => k === "gw::model-0999"),
    ).toHaveLength(1);
    expect(view.truncated).toBe(many.length - 5);
  });

  it("caps the hidden band, so Show hidden cannot dump the inventory", () => {
    const manyHidden = Array.from({ length: 400 }, (_, i) =>
      model("gw", `h-${i}`, { hidden: true, hidden_by: "model" }),
    );
    const view = curateModels(manyHidden, { includeHidden: true, limit: 10 });
    expect(view.hidden).toHaveLength(10);
    expect(view.truncated).toBe(390);
    expect(view.hiddenCount).toBe(400);
  });

  it("search narrows a large inventory to a usable list", () => {
    const view = curateModels(many, { query: "model-0042" });
    expect(keysOf(view.available)).toEqual(["gw::model-0042"]);
    expect(view.truncated).toBe(0);
  });

  it("matches on provider label as well as model id", () => {
    const view = curateModels(
      [model("ollama", "mistral"), model("gw", "gpt-4o")],
      { query: "ollama" },
    );
    expect(keysOf(view.available)).toEqual(["ollama::mistral"]);
  });
});

describe("discovery refresh races", () => {
  it("collapses a duplicated list rather than showing a model twice", () => {
    const once = [model("ollama", "mistral"), model("gw", "gpt-4o")];
    const view = curateModels([...once, ...once]);
    expect(keysOf(view.available)).toEqual(["ollama::mistral", "gw::gpt-4o"]);
  });

  it("ignores malformed entries instead of rendering blanks", () => {
    const view = curateModels([
      model("ollama", "mistral"),
      { ...model("gw", "x"), selection_key: "" },
      null as unknown as ModelOptionDto,
    ]);
    expect(keysOf(view.available)).toEqual(["ollama::mistral"]);
  });

  it("orders stably across repeated calls on the same input", () => {
    const inventory = [
      model("gw", "b"),
      model("ollama", "a", { pinned_rank: 0 }),
      model("gw", "c"),
    ];
    const first = curateModels(inventory);
    const second = curateModels(inventory);
    expect(keysOf(second.available)).toEqual(keysOf(first.available));
    expect(keysOf(second.pinned)).toEqual(keysOf(first.pinned));
  });
});

describe("the Settings summary is a count, not an inventory", () => {
  it("summarises without listing anything", () => {
    const summary = curationSummary([
      model("ollama", "a"),
      model("ollama", "b", { hidden: true, hidden_by: "model" }),
      model("gw", "c", { pinned_rank: 0 }),
    ]);
    expect(summary).toBe("2 shown · 1 hidden · 1 pinned");
  });

  it("stays quiet when nothing is curated", () => {
    expect(curationSummary([model("ollama", "a")])).toBe("1 shown");
  });
});
