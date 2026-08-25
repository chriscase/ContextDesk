/**
 * The Entities area. Every fixture is synthetic.
 *
 * Beyond the mechanics, two things are asserted deliberately: that the area
 * states the boundary between a reusable label and investigation content, and
 * that it does not privilege `customer` over the other five kinds.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTITY_KINDS, Entities, type EntityRow } from "./Entities.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fixtures: EntityRow[] = [
  {
    id: "e1",
    kind: "organization",
    label: "Fable Harbor",
    profile: { summary: "Synthetic counterparty in the fixture corpus.", reference: "SYN-1" },
    privacyClass: "owner_only",
    lifecycle: "active",
  },
  {
    id: "e2",
    kind: "service",
    label: "Synthetic checkout",
    profile: null,
    privacyClass: "share_safe",
    lifecycle: "active",
  },
  {
    id: "e3",
    kind: "system",
    label: "Synthetic legacy scheduler",
    profile: null,
    privacyClass: "owner_only",
    lifecycle: "retired",
  },
];

function stubFetch(options?: {
  entities?: EntityRow[];
  onWrite?: (url: string, init?: RequestInit) => { ok: boolean; body?: unknown } | null;
}) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const handled = options?.onWrite?.(url, init);
      return handled
        ? { ok: handled.ok, json: async () => handled.body ?? {} }
        : { ok: true, json: async () => ({}) };
    }
    if (url === "/api/entities") {
      return { ok: true, json: async () => ({ entities: options?.entities ?? fixtures }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("the Entities area", () => {
  it("states the boundary against investigation content and against Attribution", async () => {
    stubFetch();
    render(<Entities canWrite canLead />);
    expect(await screen.findByText(/This area holds labels only/)).toBeTruthy();
    expect(
      screen.getByText(/stay inside the investigation where they were captured/),
    ).toBeTruthy();
    expect(
      screen.getByText(/where a piece of information came from, not who the work is about/),
    ).toBeTruthy();
  });

  it("offers six neutral kinds and privileges none of them", async () => {
    stubFetch();
    render(<Entities canWrite canLead />);
    const filter = await screen.findByLabelText("Filter entities by kind");
    const options = [...filter.querySelectorAll("option")].map((node) => node.value);
    expect(options).toEqual(["all", ...ENTITY_KINDS]);
    // customer is one of six, listed with the rest and not first.
    expect(options.indexOf("customer")).toBeGreaterThan(options.indexOf("organization"));
  });

  it("separates available labels from retired ones", async () => {
    stubFetch();
    render(<Entities canWrite canLead />);
    expect(await screen.findByText("Available (2)")).toBeTruthy();
    expect(screen.getByText("Retired (1)")).toBeTruthy();
    expect(
      screen.getByText(/Investigations that already name it keep reading exactly as they were written/),
    ).toBeTruthy();
  });

  it("filters by kind and by search", async () => {
    stubFetch();
    render(<Entities canWrite canLead />);
    await screen.findByText("Fable Harbor");
    fireEvent.change(screen.getByLabelText("Filter entities by kind"), {
      target: { value: "service" },
    });
    await waitFor(() => expect(screen.queryByText("Fable Harbor")).toBeNull());
    expect(screen.getByText("Synthetic checkout")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter entities by kind"), {
      target: { value: "all" },
    });
    fireEvent.change(
      screen.getByLabelText("Search entities by label, description, or reference"),
      { target: { value: "harbor" } },
    );
    await waitFor(() => expect(screen.queryByText("Synthetic checkout")).toBeNull());
    expect(screen.getByText("Fable Harbor")).toBeTruthy();
  });

  it("says which labels may leave the tool", async () => {
    stubFetch();
    render(<Entities canWrite canLead />);
    expect(await screen.findByText("May leave the tool")).toBeTruthy();
    expect(screen.getByText("Stays internal")).toBeTruthy();
  });

  it("creates a label with the share-safe decision made explicitly", async () => {
    const posts: unknown[] = [];
    stubFetch({
      onWrite: (_url, init) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: true, body: {} };
      },
    });
    render(<Entities canWrite canLead />);
    fireEvent.change(await screen.findByLabelText("Entity kind"), {
      target: { value: "customer" },
    });
    fireEvent.change(screen.getByLabelText("Entity name"), {
      target: { value: "Synthetic customer" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Add an entity" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      kind: "customer",
      label: "Synthetic customer",
      // Default-deny: a name stays inside unless someone said otherwise.
      privacyClass: "owner_only",
    });
  });

  it("points at the existing label instead of forking it", async () => {
    stubFetch({
      onWrite: () => ({ ok: false, body: { error: "entity_exists", existingId: "e1" } }),
    });
    render(<Entities canWrite canLead />);
    fireEvent.change(await screen.findByLabelText("Entity name"), {
      target: { value: "Fable Harbor" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Add an entity" }));
    expect(
      await screen.findByText(/Use the existing one so the record stays reusable/),
    ).toBeTruthy();
  });

  it("hides writing and retiring from someone without the standing", async () => {
    stubFetch();
    render(<Entities canWrite={false} canLead={false} />);
    await screen.findByText("Fable Harbor");
    expect(screen.queryByRole("form", { name: "Add an entity" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retire/ })).toBeNull();
  });

  it("reports a failed load instead of showing an empty registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    render(<Entities canWrite canLead />);
    expect(await screen.findByText("Entities could not be loaded. Try again.")).toBeTruthy();
  });
});
