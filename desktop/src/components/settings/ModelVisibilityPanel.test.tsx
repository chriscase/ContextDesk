/**
 * Curated visibility management surface (#678).
 *
 * The behaviours that matter here are the ones that keep the feature honest:
 * nothing is deleted, the default can never become silently invalid, hiding
 * never launders provider health, and a large inventory stays operable by
 * keyboard.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CurationImpactDto,
  ModelOptionDto,
} from "@contextdesk/contracts";
import { ModelVisibilityPanel } from "./ModelVisibilityPanel";

const host = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  preview: vi.fn(),
  setModelHidden: vi.fn(),
  setProviderHidden: vi.fn(),
  setPinned: vi.fn(),
}));

vi.mock("../../lib/engine/modelCuration", () => {
  return {
    getCurationSummary: host.summary,
    listChatModels: host.list,
    previewCurationChange: host.preview,
    setModelHidden: host.setModelHidden,
    setProviderHidden: host.setProviderHidden,
    setModelPinned: host.setPinned,
  };
});

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

function impact(over: Partial<CurationImpactDto> = {}): CurationImpactDto {
  return {
    affects_default: false,
    replacement_key: null,
    replacement_label: null,
    remaining_visible: 3,
    state_token: "state-1",
    ...over,
  };
}

const INVENTORY = [
  model("ollama", "mistral", { is_default: true }),
  model("ollama", "llama3"),
  model("gw", "gpt-4o"),
];

async function openPanel(inventory: ModelOptionDto[] = INVENTORY) {
  host.list.mockResolvedValue(inventory);
  render(<ModelVisibilityPanel />);
  await waitFor(() => expect(host.summary).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
  await screen.findByRole("dialog", { name: "Model visibility" });
}

beforeEach(() => {
  vi.clearAllMocks();
  host.summary.mockResolvedValue({
    hidden_models: 0,
    hidden_providers: 0,
    pinned_models: 0,
  });
  host.preview.mockResolvedValue(impact());
  host.setModelHidden.mockResolvedValue(impact());
  host.setProviderHidden.mockResolvedValue(impact());
  host.setPinned.mockResolvedValue(true);
});

describe("progressive disclosure", () => {
  it("never lists or discovers models until the user asks to manage", async () => {
    host.list.mockResolvedValue(INVENTORY);
    render(<ModelVisibilityPanel />);

    await waitFor(() => expect(host.summary).toHaveBeenCalled());
    // Listing means provider discovery and would load the hidden inventory;
    // ordinary Settings must do neither.
    expect(host.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("gpt-4o")).toBeNull();
  });

  it("summarises curation from configuration alone", async () => {
    host.summary.mockResolvedValue({
      hidden_models: 1,
      hidden_providers: 2,
      pinned_models: 1,
    });
    render(<ModelVisibilityPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("curation-summary").textContent).toBe(
        "1 hidden · 2 providers hidden · 1 pinned",
      ),
    );
  });

  it("says so plainly when nothing is curated", async () => {
    render(<ModelVisibilityPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("curation-summary").textContent).toBe(
        "Nothing hidden",
      ),
    );
  });

  it("asks the host for everything only once opened", async () => {
    await openPanel();
    expect(host.list).toHaveBeenLastCalledWith({ includeHidden: true });
  });

  it("announces loading without claiming the inventory is empty", async () => {
    let resolveModels!: (models: ModelOptionDto[]) => void;
    host.list.mockReturnValue(
      new Promise<ModelOptionDto[]>((resolve) => {
        resolveModels = resolve;
      }),
    );
    render(<ModelVisibilityPanel />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    expect(await screen.findByText("Loading models…")).toBeTruthy();
    expect(screen.queryByText(/No models are listed/i)).toBeNull();

    await act(async () => resolveModels(INVENTORY));
    expect(await screen.findByText("gpt-4o")).toBeTruthy();
  });
});

describe("the panel never claims to be a privacy control", () => {
  it("says plainly that hiding deletes nothing and is not a security control", async () => {
    await openPanel();
    const dialog = screen.getByRole("dialog", { name: "Model visibility" });
    const blurb = within(dialog).getByText(/never deletes a provider/i);
    expect(blurb.textContent).toMatch(/not a privacy or security control/i);
  });

  it("names each model and provider in row action accessibility labels", async () => {
    await openPanel();
    const row = screen.getAllByRole("listitem")[0]!;

    expect(
      within(row).getByRole("button", {
        name: "Pin mistral from Ollama (local)",
      }),
    ).toBeTruthy();
    expect(
      within(row).getByRole("button", {
        name: "Hide mistral from Ollama (local)",
      }),
    ).toBeTruthy();
    expect(
      within(row).getByRole("button", {
        name: "Hide provider Ollama (local)",
      }),
    ).toBeTruthy();
  });
});

describe("the default can never become silently invalid", () => {
  it("names the exact replacement and waits for confirmation", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "gw::gpt-4o",
        replacement_label: "Gateway · gpt-4o",
        remaining_visible: 2,
      }),
    );

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toMatch(/changes the default for new chats/i);
    expect(warning.textContent).toContain("Gateway · gpt-4o");
    // Nothing is written while the user is still deciding.
    expect(host.setModelHidden).not.toHaveBeenCalled();
  });

  it("passes the previewed replacement back when the user confirms", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "gw::gpt-4o",
        replacement_label: "Gateway · gpt-4o",
        remaining_visible: 2,
      }),
    );

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Hide and use that default/i }),
    );

    await waitFor(() =>
      expect(host.setModelHidden).toHaveBeenCalledWith(
        expect.objectContaining({
          acceptReplacement: "gw::gpt-4o",
          expectedStateToken: "state-1",
        }),
      ),
    );
  });

  it("writes nothing when the user cancels", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "gw::gpt-4o",
        replacement_label: "Gateway · gpt-4o",
        remaining_visible: 2,
      }),
    );

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(host.setModelHidden).not.toHaveBeenCalled();
    await screen.findByText("No change was made.");
  });

  it("refuses to empty the picker", async () => {
    await openPanel();
    host.preview.mockResolvedValue(impact({ remaining_visible: 0 }));

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/at least one model must stay visible/i);
    expect(host.setModelHidden).not.toHaveBeenCalled();
  });

  it("refuses an unverified automatic default replacement", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: null,
        replacement_label: null,
        remaining_visible: 2,
      }),
    );

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Hide" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no discovered replacement default/i);
    expect(host.setModelHidden).not.toHaveBeenCalled();
  });
});

describe("hiding is reversible and non-destructive", () => {
  it("offers Restore for a hidden model and says nothing was deleted", async () => {
    await openPanel([
      model("ollama", "mistral", { is_default: true }),
      model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
    ]);
    fireEvent.click(screen.getByLabelText(/Show hidden/));

    const restore = await screen.findByRole("button", {
      name: "Restore llama3 from Ollama (local)",
    });
    fireEvent.click(restore);

    await waitFor(() =>
      expect(host.setModelHidden).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "llama3", hidden: false }),
      ),
    );
  });

  it("explains a model hidden by its provider instead of letting it be toggled", async () => {
    await openPanel([
      model("gw", "gpt-4o", { hidden: true, hidden_by: "provider" }),
      model("ollama", "mistral", { is_default: true }),
    ]);
    fireEvent.click(screen.getByLabelText(/Show hidden/));

    const row = (await screen.findAllByRole("listitem")).find((li) =>
      li.textContent?.includes("gpt-4o"),
    )!;
    expect(row.textContent).toMatch(/hidden with its provider/i);
    // No per-model toggle while the provider governs it: the model's own
    // setting is preserved underneath and reapplies on provider restore, so a
    // per-model button here would misdescribe both states.
    expect(
      within(row).queryByRole("button", { name: /^Hide .* from / }),
    ).toBeNull();
    expect(
      within(row).queryByRole("button", { name: /^Restore .* from / }),
    ).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Restore provider Gateway" }),
    ).toBeTruthy();
  });
});

describe("pinning", () => {
  it("pins and unpins an available model", async () => {
    await openPanel();
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Pin .* from / }),
    );

    await waitFor(() =>
      expect(host.setPinned).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "mistral", pinned: true }),
      ),
    );
  });

  it("will not pin a hidden model", async () => {
    await openPanel([
      model("ollama", "mistral", { is_default: true }),
      model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
    ]);
    fireEvent.click(screen.getByLabelText(/Show hidden/));

    const row = (await screen.findAllByRole("listitem")).find((li) =>
      li.textContent?.includes("llama3"),
    )!;
    expect(
      within(row).getByRole("button", {
        name: "Pin llama3 from Ollama (local)",
      }),
    ).toHaveProperty("disabled", true);
  });
});

describe("large inventories stay operable", () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    model("gw", `model-${String(i).padStart(3, "0")}`),
  );

  it("bounds the list and says what it dropped", async () => {
    await openPanel([...many, model("ollama", "mistral", { is_default: true })]);
    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(
      screen.getByText(/more match — narrow the search to reach them/i),
    ).toBeTruthy();
  });

  it("keeps one total bound across pinned and hidden rows", async () => {
    const pinned = Array.from({ length: 220 }, (_, i) =>
      model("gw", `pinned-${i}`, { pinned_rank: i }),
    );
    const hidden = Array.from({ length: 220 }, (_, i) =>
      model("gw", `hidden-${i}`, {
        hidden: true,
        hidden_by: "model",
      }),
    );
    await openPanel([...pinned, ...hidden]);
    fireEvent.click(screen.getByLabelText(/Show hidden/));

    expect(screen.getAllByRole("listitem")).toHaveLength(200);
    expect(screen.getByText(/240 more match/i)).toBeTruthy();
  });

  it("search narrows to an exact model", async () => {
    await openPanel([...many, model("ollama", "mistral", { is_default: true })]);
    fireEvent.change(screen.getByLabelText("Search models"), {
      target: { value: "model-042" },
    });

    await waitFor(() => {
      const rows = screen.getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("model-042");
    });
  });

  it("moves focus through rows with the arrow keys", async () => {
    await openPanel();
    const list = screen.getByRole("list", { name: "Discovered models" });
    const rowHandles = () =>
      list.querySelectorAll<HTMLElement>("[data-model-row]");

    // Roving tabindex: only the active row is reachable by Tab, so arrows are
    // the only way to the rest.
    expect(rowHandles()[0]!.tabIndex).toBe(0);
    expect(rowHandles()[1]!.tabIndex).toBe(-1);

    rowHandles()[0]!.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(rowHandles()[1]);

    fireEvent.keyDown(list, { key: "End" });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(
      rowHandles()[rowHandles().length - 1],
    );
  });
});

describe("stale discovery", () => {
  it("keeps the newest inventory when an older reload resolves last", async () => {
    let resolveFirst!: (v: ModelOptionDto[]) => void;
    const first = new Promise<ModelOptionDto[]>((r) => {
      resolveFirst = r;
    });
    host.list.mockReturnValueOnce(first).mockResolvedValue(INVENTORY);

    render(<ModelVisibilityPanel />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());

    // Open: load A starts and is left in flight.
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    await screen.findByRole("dialog", { name: "Model visibility" });

    // Close and reopen: load B supersedes A.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    });

    // The stale response lands last and must be discarded.
    await act(async () => {
      resolveFirst([model("stale", "should-not-appear")]);
      await first;
    });

    expect(host.list).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByText("should-not-appear")).toBeNull(),
    );
    expect(screen.getByText("gpt-4o")).toBeTruthy();
  });
});

describe("honest failures", () => {
  it("surfaces a listing failure instead of showing an empty inventory", async () => {
    host.list.mockRejectedValue(new Error("provider unreachable"));
    render(<ModelVisibilityPanel />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "provider unreachable",
    );
  });

  it("reports a rejected write rather than pretending it applied", async () => {
    await openPanel();
    host.setModelHidden.mockRejectedValue(new Error("config is read-only"));

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "config is read-only",
    );
  });

  it("keeps tool-capability truth visible on a curated row", async () => {
    await openPanel([
      model("ollama", "mistral", { is_default: true }),
      model("ollama", "dolphin", {
        tools_enabled: false,
        tools_disabled_reason: "model",
      }),
    ]);
    const row = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("dolphin"))!;
    expect(row.textContent).toMatch(/tools unavailable/i);
  });
});

describe("curation reaches the rest of the app", () => {
  it("tells the app to re-list its pickers after a hide", async () => {
    const onCurationChanged = vi.fn();
    host.list.mockResolvedValue(INVENTORY);
    render(<ModelVisibilityPanel onCurationChanged={onCurationChanged} />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    await screen.findByRole("dialog", { name: "Model visibility" });

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );

    // Without this the main composer keeps offering the hidden model until an
    // unrelated AI-setup save or an app restart — the feature would look broken.
    await waitFor(() => expect(onCurationChanged).toHaveBeenCalled());
  });

  it("tells the app after a pin too", async () => {
    const onCurationChanged = vi.fn();
    host.list.mockResolvedValue(INVENTORY);
    render(<ModelVisibilityPanel onCurationChanged={onCurationChanged} />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    await screen.findByRole("dialog", { name: "Model visibility" });

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Pin .* from / }),
    );

    await waitFor(() => expect(onCurationChanged).toHaveBeenCalled());
  });

  it("does not announce a change that failed", async () => {
    const onCurationChanged = vi.fn();
    host.list.mockResolvedValue(INVENTORY);
    host.setModelHidden.mockRejectedValue(new Error("config is read-only"));
    render(<ModelVisibilityPanel onCurationChanged={onCurationChanged} />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    await screen.findByRole("dialog", { name: "Model visibility" });

    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );

    await screen.findByRole("alert");
    expect(onCurationChanged).not.toHaveBeenCalled();
  });
});

describe("keyboard and focus", () => {
  it("moves focus into the panel on open and back to the trigger on close", async () => {
    await openPanel();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Search models")),
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Manage…" }),
      ),
    );
  });

  it("closes on Escape and returns focus", async () => {
    await openPanel();
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Model visibility" }),
      ).toBeNull(),
    );
  });

  it("Escape cancels a pending confirmation before it closes the panel", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "gw::gpt-4o",
        replacement_label: "Gateway · gpt-4o",
        remaining_visible: 2,
      }),
    );
    const rows = screen.getAllByRole("listitem");
    const hide = within(rows[0]!).getByRole("button", {
      name: "Hide mistral from Ollama (local)",
    });
    hide.focus();
    fireEvent.click(hide);
    await screen.findByRole("alert");

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" }),
      ),
    );

    fireEvent.keyDown(window, { key: "Escape" });

    // The decision is dismissed; the panel itself stays open.
    await screen.findByText("No change was made.");
    expect(
      screen.getByRole("dialog", { name: "Model visibility" }),
    ).toBeTruthy();
    expect(host.setModelHidden).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(hide));
  });

  it("Cancel returns focus to the exact action that opened confirmation", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "gw::gpt-4o",
        replacement_label: "Gateway · gpt-4o",
        remaining_visible: 2,
      }),
    );
    const hide = screen.getByRole("button", {
      name: "Hide llama3 from Ollama (local)",
    });
    hide.focus();
    fireEvent.click(hide);

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);

    await waitFor(() => expect(document.activeElement).toBe(hide));
  });

  it("moves focus to the replacement row after a successful hide removes one", async () => {
    host.list
      .mockResolvedValueOnce(INVENTORY)
      .mockResolvedValueOnce(INVENTORY.slice(1));
    render(<ModelVisibilityPanel />);
    await waitFor(() => expect(host.summary).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    await screen.findByText("gpt-4o");

    const hide = screen.getByRole("button", {
      name: "Hide mistral from Ollama (local)",
    });
    hide.focus();
    fireEvent.click(hide);

    await waitFor(() => {
      const focused = document.activeElement as HTMLElement;
      expect(focused.hasAttribute("data-model-row")).toBe(true);
      expect(focused.closest("li")?.textContent).toContain("llama3");
    });
  });

  it("keeps row actions out of the tab order for inactive rows", async () => {
    await openPanel();
    const rows = screen.getAllByRole("listitem");
    const firstPin = within(rows[0]!).getByRole("button", {
      name: /^Pin .* from /,
    });
    const secondPin = within(rows[1]!).getByRole("button", {
      name: /^Pin .* from /,
    });

    // Otherwise Tab walks three buttons per row through the whole inventory.
    expect(firstPin.tabIndex).toBe(0);
    expect(secondPin.tabIndex).toBe(-1);
  });

  it("locks the list while a replacement decision is pending", async () => {
    await openPanel();
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "gw::gpt-4o",
        replacement_label: "Gateway · gpt-4o",
        remaining_visible: 2,
      }),
    );
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /^Hide .* from / }),
    );
    await screen.findByRole("alert");

    // A second change now would confirm against a stale replacement.
    expect(
      within(screen.getAllByRole("listitem")[1]!).getByRole("button", {
        name: /^Hide .* from /,
      }),
    ).toHaveProperty("disabled", true);
  });
});

describe("confirmation copy matches the operation", () => {
  it("says Restoring, not Hiding, when restoring", async () => {
    await openPanel([
      model("ollama", "mistral", { is_default: true }),
      model("ollama", "llama3", { hidden: true, hidden_by: "model" }),
    ]);
    fireEvent.click(screen.getByLabelText(/Show hidden/));
    host.preview.mockResolvedValue(
      impact({
        affects_default: true,
        replacement_key: "ollama::llama3",
        replacement_label: "Ollama (local) · llama3",
        remaining_visible: 2,
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Restore llama3 from Ollama (local)",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Restoring/);
    expect(alert.textContent).not.toMatch(/Hiding/);
    expect(
      screen.getByRole("button", { name: /Restore and use that default/i }),
    ).toBeTruthy();
  });
});
