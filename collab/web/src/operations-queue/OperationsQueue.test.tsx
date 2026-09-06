import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPERATIONS_QUEUE_QUERY, type OperationsQueueLocationQuery } from "../app-location.js";
import { makeOperationsQueuePage } from "../investigations/runtime/testkit/index.js";
import type { OperationsQueuePresentation } from "./useOperationsQueue.js";

const hook = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("./useOperationsQueue.js", () => ({
  useOperationsQueue: hook.current,
}));

import { OperationsQueue } from "./OperationsQueue.js";

const TEST_SCOPE_TOKEN = Object.freeze({});
const savedViewStorage = new Map<string, string>();

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => savedViewStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void savedViewStorage.set(key, value),
    removeItem: (key: string) => void savedViewStorage.delete(key),
  });
});

afterEach(() => {
  cleanup();
  savedViewStorage.clear();
  hook.current.mockReset();
});

function settled(overrides: Partial<OperationsQueuePresentation> = {}): OperationsQueuePresentation {
  return {
    identity: { id: "alice", username: "alice", displayName: "Alice" },
    scopeToken: TEST_SCOPE_TOKEN,
    commandAvailability: "available",
    view: { availability: "available", value: makeOperationsQueuePage(), refresh: "settled" },
    continuationFailed: false,
    continuationInFlight: false,
    continuationOutcome: 0,
    requestGeneration: 1,
    refresh: vi.fn(),
    nextPage: vi.fn(),
    selfCoordination: {
      available: true,
      targetInvestigationId: null,
      action: null,
      state: { status: "idle" },
      apply: vi.fn(),
      retry: vi.fn(),
    },
    participantCoordination: {
      available: false,
      targetInvestigationId: null,
      action: null,
      targetIdentityId: null,
      concealedInvestigationIds: [],
      state: { status: "idle" },
      apply: vi.fn(),
      retry: vi.fn(),
    },
    ...overrides,
  };
}

function participantAvailable(
  overrides: Partial<OperationsQueuePresentation["participantCoordination"]> = {},
): OperationsQueuePresentation["participantCoordination"] {
  return {
    available: true,
    targetInvestigationId: null,
    action: null,
    targetIdentityId: null,
    concealedInvestigationIds: [],
    state: { status: "idle" },
    apply: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

function renderQueue(
  state: OperationsQueuePresentation,
  query: OperationsQueueLocationQuery = DEFAULT_OPERATIONS_QUEUE_QUERY,
) {
  hook.current.mockReturnValue(state);
  const onQueryChange = vi.fn();
  const onOpenInvestigation = vi.fn();
  const rendered = render(
    <OperationsQueue
      query={query}
      onQueryChange={onQueryChange}
      onOpenInvestigation={onOpenInvestigation}
    />,
  );
  return { ...rendered, onQueryChange, onOpenInvestigation };
}

function savedViewsStatus() {
  const section = screen.getByRole("heading", { name: "Saved views" }).closest("section");
  if (section === null) throw new Error("missing saved views section");
  return within(section).getByRole("status");
}

const UNSIGNED_IDENTITY = { id: "", username: "", displayName: "" };
const BOB_IDENTITY = { id: "bob", username: "bob", displayName: "Bob" };

describe("Operations Queue presentation", () => {
  it("renders server rows, counts, and recorded coordination facts without recounting", () => {
    const page = makeOperationsQueuePage({
      coordinationScopeCounts: { allVisible: 17, mine: 6, unassigned: 3 },
    });
    renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
    }));

    const rows = within(screen.getByRole("list", { name: "Operations queue investigations" }))
      .getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".operations-queue__row-title")?.textContent))
      .toEqual(page.items.map((row) => row.investigation.title));
    expect(screen.getByRole("link", { name: /Checkout latency/u }).getAttribute("href"))
      .toBe(`/investigations/${page.items[0]?.investigation.id}/situation`);
    expect(screen.getByText("Coordinator: alice")).toBeTruthy();
    expect(screen.getByText("Coordinator: Not recorded")).toBeTruthy();
    expect(screen.getByRole("link", { name: /All visible 17/u })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Mine 6/u })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Unassigned 3/u })).toBeTruthy();
  });

  it("offers self claim/release controls without nesting actions in row links", () => {
    const page = makeOperationsQueuePage();
    const apply = vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }));
    renderQueue(settled({
      identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
      view: { availability: "available", value: page, refresh: "settled" },
      selfCoordination: {
        available: true,
        targetInvestigationId: null,
        action: null,
        state: { status: "idle" },
        apply,
        retry: vi.fn(),
      },
    }));

    expect(screen.getByRole("button", { name: "Release me Checkout latency after 4.8.0 rollout" })).toBeTruthy();
    const claim = screen.getByRole("button", { name: "Claim for me Imported investigation" });
    expect(claim.closest("a")).toBeNull();
    fireEvent.click(claim);
    expect(apply).toHaveBeenCalledWith(page.items[1]!.investigation.id, "claim_self");
  });

  it("never offers mutation for another coordinator and preserves unknown-outcome retry", () => {
    const page = makeOperationsQueuePage();
    const retry = vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }));
    renderQueue(settled({
      identity: BOB_IDENTITY,
      view: { availability: "available", value: page, refresh: "settled" },
      selfCoordination: {
        available: true,
        targetInvestigationId: page.items[1]!.investigation.id,
        action: "claim_self",
        state: { status: "failed", error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" } },
        apply: vi.fn(),
        retry,
      },
    }));

    expect(screen.queryByRole("button", { name: /Release me Checkout latency/u })).toBeNull();
    expect(screen.getByText(/server may have recorded this action/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry claim for me" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("saves, applies, and removes a private normalized queue view", async () => {
    const query: OperationsQueueLocationQuery = {
      q: " checkout ",
      status: ["archived", "open"],
      includeArchived: true,
      coordinationScope: "mine",
    };
    const canonical = {
      q: "checkout",
      status: ["open", "archived"],
      includeArchived: true,
      coordinationScope: "mine",
    };
    const { onQueryChange } = renderQueue(settled(), query);
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "My handoffs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));

    expect(await screen.findByRole("button", { name: "Apply saved view My handoffs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove saved view My handoffs" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "My handoffs" })).toBeNull();
    expect((screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement).value)
      .toBe(" checkout ");
    const saved = JSON.parse(window.localStorage.getItem("cd-operations-views:alice") ?? "[]") as Array<{
      query: OperationsQueueLocationQuery;
    }>;
    expect(saved[0]?.query).toEqual(canonical);
    expect(saved[0]?.query).not.toHaveProperty("cursor");

    fireEvent.click(screen.getByRole("button", { name: "Apply saved view My handoffs" }));
    expect(onQueryChange).toHaveBeenCalledWith(canonical);
    fireEvent.click(screen.getByRole("button", { name: "Remove saved view My handoffs" }));
    expect(JSON.parse(window.localStorage.getItem("cd-operations-views:alice") ?? "[]")).toEqual([]);
  });

  it("keeps saved views isolated by identity and drops malformed entries", async () => {
    window.localStorage.setItem("cd-operations-views:bob", JSON.stringify([
      { id: "bad", name: "", query: {} },
      {
        id: "good",
        name: "Bob queue",
        query: { q: "checkout", status: ["open"], includeArchived: false, coordinationScope: "all_visible" },
      },
    ]));
    renderQueue(settled({ identity: BOB_IDENTITY }));
    expect(await screen.findByRole("button", { name: "Apply saved view Bob queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply saved view My handoffs" })).toBeNull();
  });

  it("refuses unsigned saved-view writes with an explicit sign-in notice", () => {
    const { onQueryChange } = renderQueue(settled({ identity: UNSIGNED_IDENTITY }));
    const notice = savedViewsStatus();
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.getAttribute("aria-atomic")).toBe("true");
    expect(notice.textContent).toBe("Saved views become available after you sign in.");
    expect((screen.getByRole("textbox", { name: "View name" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save current view" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("textbox", { name: "View name" }).closest("form")!);
    expect(window.localStorage.getItem("cd-operations-views:")).toBeNull();
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it("reloads the matching identity key after a mounted account switch", async () => {
    window.localStorage.setItem("cd-operations-views:alice", JSON.stringify([
      {
        id: "alice-view",
        name: "Alice queue",
        query: { q: "alice", status: ["open"], includeArchived: false, coordinationScope: "mine" },
      },
    ]));
    window.localStorage.setItem("cd-operations-views:bob", JSON.stringify([
      {
        id: "bob-view",
        name: "Bob queue",
        query: { q: "bob", status: ["monitoring"], includeArchived: false, coordinationScope: "unassigned" },
      },
    ]));
    const alice = settled();
    const { rerender, onQueryChange, onOpenInvestigation } = renderQueue(alice);
    expect(await screen.findByRole("button", { name: "Apply saved view Alice queue" })).toBeTruthy();

    hook.current.mockReturnValue(settled({ identity: BOB_IDENTITY }));
    rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={onQueryChange}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );
    expect(await screen.findByRole("button", { name: "Apply saved view Bob queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply saved view Alice queue" })).toBeNull();
    expect(savedViewsStatus().textContent).toBe("");

    hook.current.mockReturnValue(settled({ identity: UNSIGNED_IDENTITY }));
    rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={onQueryChange}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );
    expect(screen.queryByRole("button", { name: "Apply saved view Bob queue" })).toBeNull();
    expect(savedViewsStatus().textContent).toBe("Saved views become available after you sign in.");
    expect((screen.getByRole("button", { name: "Save current view" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("announces save, apply, remove, and storage failure through one polite live status", async () => {
    const state = settled();
    const { onQueryChange, onOpenInvestigation, rerender } = renderQueue(state);
    const live = savedViewsStatus();
    expect(live.className).toBe("sr-only");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(within(live.closest("section") as HTMLElement).getAllByRole("status")).toHaveLength(1);

    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "My handoffs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(savedViewsStatus().textContent).toBe("Saved “My handoffs” for this account on this browser.");
    expect(savedViewsStatus().className).toBe("operations-queue__saved-notice");

    fireEvent.click(screen.getByRole("button", { name: "Apply saved view My handoffs" }));
    expect(savedViewsStatus().textContent).toBe("Applied “My handoffs”.");
    const applied = onQueryChange.mock.calls[0]?.[0] as OperationsQueueLocationQuery;
    hook.current.mockReturnValue(state);
    rerender(
      <OperationsQueue
        query={applied}
        onQueryChange={onQueryChange}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );
    expect(savedViewsStatus().textContent).toBe("Applied “My handoffs”.");

    fireEvent.click(screen.getByRole("button", { name: "Remove saved view My handoffs" }));
    expect(savedViewsStatus().textContent).toBe("Removed “My handoffs”.");

    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Retry later" },
    });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => savedViewStorage.get(key) ?? null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: (key: string) => void savedViewStorage.delete(key),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(savedViewsStatus().textContent)
      .toBe("This browser could not save the view. Your current queue is unchanged.");
    expect(JSON.parse(window.localStorage.getItem("cd-operations-views:alice") ?? "[]")).toEqual([]);
    expect(onQueryChange).toHaveBeenCalledTimes(1);
  });

  it("keeps existing views and rows when remove or an oversized query cannot be persisted", async () => {
    const page = makeOperationsQueuePage();
    window.localStorage.setItem("cd-operations-views:alice", JSON.stringify([
      {
        id: "first",
        name: "First view",
        query: { q: "first", status: ["open"], includeArchived: false, coordinationScope: "all_visible" },
      },
      {
        id: "second",
        name: "Second view",
        query: { q: "second", status: ["monitoring"], includeArchived: false, coordinationScope: "mine" },
      },
    ]));
    const rendered = renderQueue(settled({ view: { availability: "available", value: page, refresh: "settled" } }));
    const queueRows = () => within(screen.getByRole("list", { name: "Operations queue investigations" })).getAllByRole("listitem");
    expect(queueRows()).toHaveLength(page.items.length);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => savedViewStorage.get(key) ?? null,
      setItem: () => { throw new Error("quota"); },
      removeItem: (key: string) => void savedViewStorage.delete(key),
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved view First view" }));
    expect(savedViewsStatus().textContent).toBe("This browser could not remove the saved view.");
    expect(screen.getByRole("button", { name: "Apply saved view First view" })).toBeTruthy();
    expect(queueRows()).toHaveLength(page.items.length);

    rendered.unmount();
    savedViewStorage.clear();
    const oversized: OperationsQueueLocationQuery = {
      q: "x".repeat(257),
      status: [],
      includeArchived: false,
      coordinationScope: "all_visible",
    };
    renderQueue(settled(), oversized);
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "Too long" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(savedViewsStatus().textContent)
      .toBe("This browser could not save the view. Your current queue is unchanged.");
    expect(window.localStorage.getItem("cd-operations-views:alice")).toBeNull();
  });

  it("restores save, apply, and remove focus only while the initiator still owns it", async () => {
    const query: OperationsQueueLocationQuery = {
      q: "checkout",
      status: ["open"],
      includeArchived: false,
      coordinationScope: "all_visible",
    };
    const state = settled();
    const { onQueryChange, onOpenInvestigation, rerender } = renderQueue(state, query);
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Keep mine" },
    });
    const save = screen.getByRole("button", { name: "Save current view" });
    save.focus();
    fireEvent.click(save);
    const apply = await screen.findByRole("button", { name: "Apply saved view Keep mine" });
    await waitFor(() => expect(document.activeElement).toBe(apply));

    apply.focus();
    fireEvent.click(apply);
    const applied = onQueryChange.mock.calls[0]?.[0] as OperationsQueueLocationQuery;
    hook.current.mockReturnValue(state);
    rerender(
      <OperationsQueue
        query={applied}
        onQueryChange={onQueryChange}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );
    await waitFor(() => expect(document.activeElement).toBe(apply));

    const remove = screen.getByRole("button", { name: "Remove saved view Keep mine" });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "View name" }),
    ));
  });

  it("does not steal saved-view focus after the operator moves or identity changes", async () => {
    window.localStorage.setItem("cd-operations-views:alice", JSON.stringify([
      {
        id: "alice-view",
        name: "Alice queue",
        query: { q: "checkout", status: ["open"], includeArchived: false, coordinationScope: "mine" },
      },
    ]));
    const state = settled();
    const { onQueryChange, onOpenInvestigation, rerender } = renderQueue(state);
    const apply = await screen.findByRole("button", { name: "Apply saved view Alice queue" });
    apply.focus();
    fireEvent.click(apply);
    const search = screen.getByRole("searchbox", { name: "Search" });
    search.focus();
    const applied = onQueryChange.mock.calls[0]?.[0] as OperationsQueueLocationQuery;
    hook.current.mockReturnValue(state);
    rerender(
      <OperationsQueue
        query={applied}
        onQueryChange={onQueryChange}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );
    await waitFor(() => expect(document.activeElement).toBe(search));

    apply.focus();
    fireEvent.click(apply);
    hook.current.mockReturnValue(settled({ identity: BOB_IDENTITY }));
    rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={onQueryChange}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );
    expect(screen.queryByRole("button", { name: "Apply saved view Alice queue" })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "View name" }));
    expect(savedViewsStatus().textContent).toBe("");
  });

  it("gives sparse imported rows a useful title", () => {
    const page = makeOperationsQueuePage();
    renderQueue(settled({
      view: {
        availability: "available",
        value: { ...page, items: page.items.map((row, index) => ({
          ...row,
          investigation: { ...row.investigation, title: index === 0 ? "" : "   " },
        })) },
        refresh: "settled",
      },
    }));

    expect(screen.getAllByRole("link", { name: /Untitled investigation/u })).toHaveLength(2);
  });

  it("keeps scope and row links native while intercepting only normal shell navigation", () => {
    const query: OperationsQueueLocationQuery = {
      q: "checkout",
      status: ["open"],
      includeArchived: true,
      coordinationScope: "all_visible",
    };
    const { onQueryChange, onOpenInvestigation } = renderQueue(settled(), query);
    const mine = screen.getByRole("link", { name: /Mine/u });
    mine.addEventListener("click", (event) => event.preventDefault());
    expect(mine.getAttribute("href")).toBe(
      "/operations?q=checkout&status=open&includeArchived=true&coordinationScope=mine",
    );
    fireEvent.click(mine, { ctrlKey: true });
    expect(onQueryChange).not.toHaveBeenCalled();
    fireEvent.click(mine);
    expect(onQueryChange).toHaveBeenCalledWith({ ...query, coordinationScope: "mine" });

    const row = screen.getByRole("link", { name: /Checkout latency/u });
    row.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(row, { metaKey: true });
    expect(onOpenInvestigation).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onOpenInvestigation).toHaveBeenCalledWith(makeOperationsQueuePage().items[0]?.investigation.id);
  });

  it("distinguishes an absent command, denied authority, idle, and first loading", () => {
    const absent = renderQueue(settled({
      commandAvailability: "absent",
      view: { availability: "idle" },
    }));
    expect(screen.getByText("Operations Queue is not available in this build")).toBeTruthy();
    absent.unmount();

    hook.current.mockReturnValue(settled({
      commandAvailability: "denied",
      view: { availability: "idle" },
    }));
    const denied = render(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    expect(screen.getByText(/no queue data was requested/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    denied.unmount();

    hook.current.mockReturnValue(settled({ view: { availability: "idle" } }));
    const idle = render(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    expect(screen.getByText("Queue request has not started.")).toBeTruthy();
    idle.unmount();

    hook.current.mockReturnValue(settled({ view: { availability: "loading" } }));
    render(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    expect(screen.getByText("Loading operations queue…")).toBeTruthy();
  });

  it("distinguishes gateway unavailability and auth loss without a legacy fallback", () => {
    const retry = vi.fn();
    const unavailable = renderQueue(settled({
      view: { availability: "unavailable", error: { kind: "unavailable", status: 503 } },
      refresh: retry,
    }));
    expect(screen.getByText("Operations Queue service is unavailable")).toBeTruthy();
    expect(screen.getByText(/No legacy investigation list was substituted/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    unavailable.unmount();

    hook.current.mockReturnValue(settled({
      view: { availability: "unavailable", error: { kind: "auth_lost", status: 401 } },
    }));
    render(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    expect(screen.getByText("Operations Queue access ended")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("keeps previous rows visible through refresh and continuation failures", async () => {
    const retry = vi.fn();
    const page = makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" });
    const refreshFailure = renderQueue(settled({
      view: {
        availability: "available",
        value: page,
        refresh: "failed",
        refreshError: { kind: "network" },
      },
      refresh: retry,
    }));
    expect(screen.getAllByRole("listitem")).toHaveLength(page.items.length);
    expect(screen.getByText(/latest refresh failed/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    refreshFailure.unmount();

    const nextPage = vi.fn();
    const continuation = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      nextPage,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load more operations" }));
    hook.current.mockReturnValue(settled({
      continuationInFlight: true,
      view: { availability: "available", value: page, refresh: "loading" },
      nextPage,
    }));
    continuation.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    hook.current.mockReturnValue(settled({
      continuationOutcome: 1,
      view: {
        availability: "available",
        value: page,
        refresh: "failed",
        refreshError: { kind: "network" },
      },
      continuationFailed: true,
      nextPage,
    }));
    continuation.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getAllByRole("listitem")).toHaveLength(page.items.length);
    expect(screen.getByText(/Previously loaded rows remain in server order/u)).toBeTruthy();
  });

  it("focuses truthful completion after continuation and reports hidden archives", async () => {
    const first = settled({
      view: {
        availability: "available",
        value: makeOperationsQueuePage({
          nextCursor: "eyJwYWdlIjoyfQ",
          hiddenArchivedCount: 4,
        }),
        refresh: "settled",
      },
    });
    const rendered = renderQueue(first);
    expect(screen.getByText("4 archived investigations are hidden. Include archived to show them.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more operations" }));

    hook.current.mockReturnValue(settled({
      continuationInFlight: true,
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ", hiddenArchivedCount: 4 }),
        refresh: "loading",
      },
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );

    hook.current.mockReturnValue(settled({
      continuationOutcome: 1,
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: null, hiddenArchivedCount: 4 }),
        refresh: "settled",
      },
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    const completion = screen.getByText("All operations are shown.");
    await waitFor(() => expect(document.activeElement).toBe(completion));

    const search = screen.getByRole("searchbox", { name: "Search" });
    search.focus();
    fireEvent.change(search, { target: { value: "checkout" } });
    expect(document.activeElement).toBe(search);

    hook.current.mockReturnValue(settled({
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: null, hiddenArchivedCount: 4 }),
        refresh: "loading",
      },
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeTruthy();
    expect(screen.queryByText("Loading more operations…")).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it("restores focus to Load more after a nonterminal continuation retry", async () => {
    const cursor = "eyJwYWdlIjoyfQ";
    const page = makeOperationsQueuePage({ nextCursor: cursor });
    const nextPage = vi.fn();
    const rendered = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      nextPage,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load more operations" }));

    hook.current.mockReturnValue(settled({
      continuationInFlight: true,
      view: { availability: "available", value: page, refresh: "loading" },
      nextPage,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );

    hook.current.mockReturnValue(settled({
      continuationFailed: true,
      continuationOutcome: 1,
      view: {
        availability: "available",
        value: page,
        refresh: "failed",
        refreshError: { kind: "network" },
      },
      nextPage,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
    fireEvent.click(screen.getByRole("button", { name: "Try loading more" }));

    hook.current.mockReturnValue(settled({
      continuationInFlight: true,
      view: { availability: "available", value: page, refresh: "loading" },
      nextPage,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    hook.current.mockReturnValue(settled({
      continuationOutcome: 2,
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjozfQ" }),
        refresh: "settled",
      },
      nextPage,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Load more operations" }),
    ));
    expect(screen.queryByText("All operations are shown.")).toBeNull();
  });

  it("focuses the single recovery surface when a continuation becomes unavailable", async () => {
    const page = makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" });
    const rendered = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load more operations" }));

    hook.current.mockReturnValue(settled({
      continuationOutcome: 1,
      view: { availability: "unavailable", error: { kind: "not_found", status: 404 } },
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );

    const alert = screen.getByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more operations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try loading more" })).toBeNull();
  });

  it("returns focus to queue context after an unavailable first-page retry succeeds", async () => {
    const refresh = vi.fn();
    const rendered = renderQueue(settled({
      view: { availability: "unavailable", error: { kind: "network" } },
      refresh,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);

    hook.current.mockReturnValue(settled({
      view: { availability: "loading" },
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: makeOperationsQueuePage(), refresh: "settled" },
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );

    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Operations Queue" }),
    ));
  });

  it("returns focus to the updated alert after repeated first-page retry failure", async () => {
    const refresh = vi.fn();
    const repeatedError = Object.freeze({ kind: "unavailable" as const, status: 503 as const });
    const rendered = renderQueue(settled({
      view: { availability: "unavailable", error: repeatedError },
      refresh,
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      hook.current.mockReturnValue(settled({ view: { availability: "loading" }, refresh }));
      rendered.rerender(
        <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
      );
      hook.current.mockReturnValue(settled({
        view: { availability: "unavailable", error: repeatedError },
        refresh,
      }));
      rendered.rerender(
        <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
    }

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("returns focus after slow and fast retained-page refresh retries", async () => {
    const refresh = vi.fn();
    const page = makeOperationsQueuePage();
    const failedView = Object.freeze({
      availability: "available" as const,
      value: page,
      refresh: "failed" as const,
      refreshError: Object.freeze({ kind: "network" as const }),
    });
    const rendered = renderQueue(settled({
      view: failedView,
      requestGeneration: 3,
      refresh,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "loading" },
      requestGeneration: 4,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 4,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Operations Queue" }),
    ));

    hook.current.mockReturnValue(settled({
      view: failedView,
      requestGeneration: 5,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 6,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Operations Queue" }),
    ));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the remounted alert after repeated retained-page retry failure", async () => {
    const refresh = vi.fn();
    const page = makeOperationsQueuePage();
    const repeatedView = Object.freeze({
      availability: "available" as const,
      value: page,
      refresh: "failed" as const,
      refreshError: Object.freeze({ kind: "network" as const }),
    });
    const rendered = renderQueue(settled({
      view: repeatedView,
      requestGeneration: 8,
      refresh,
    }));

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      hook.current.mockReturnValue(settled({
        view: { availability: "available", value: page, refresh: "loading" },
        requestGeneration: 8 + attempt,
        refresh,
      }));
      rendered.rerender(
        <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
      );
      hook.current.mockReturnValue(settled({
        view: repeatedView,
        requestGeneration: 8 + attempt,
        refresh,
      }));
      rendered.rerender(
        <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
    }
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not steal retained-refresh focus after user or authority-scope movement", async () => {
    const refresh = vi.fn();
    const page = makeOperationsQueuePage();
    const failedView = {
      availability: "available" as const,
      value: page,
      refresh: "failed" as const,
      refreshError: { kind: "network" as const },
    };
    const rendered = renderQueue(settled({ view: failedView, requestGeneration: 2, refresh }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "loading" },
      requestGeneration: 3,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    const search = screen.getByRole("searchbox", { name: "Search" });
    search.focus();
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 3,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(search));

    hook.current.mockReturnValue(settled({ view: failedView, requestGeneration: 4, refresh }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    const authorityRetry = screen.getByRole("button", { name: "Try again" });
    authorityRetry.focus();
    fireEvent.click(authorityRetry);
    const nextAuthorityScope = Object.freeze({});
    hook.current.mockReturnValue(settled({
      scopeToken: nextAuthorityScope,
      view: { availability: "available", value: page, refresh: "loading" },
      requestGeneration: 1,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    hook.current.mockReturnValue(settled({
      scopeToken: nextAuthorityScope,
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 1,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it("does not apply retained-refresh retry focus to a different location query", async () => {
    const refresh = vi.fn();
    const page = makeOperationsQueuePage();
    const rendered = renderQueue(settled({
      view: {
        availability: "available",
        value: page,
        refresh: "failed",
        refreshError: { kind: "network" },
      },
      requestGeneration: 11,
      refresh,
    }));
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);

    const nextQuery = { ...DEFAULT_OPERATIONS_QUEUE_QUERY, q: "different" };
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "loading" },
      requestGeneration: 1,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={nextQuery} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 1,
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={nextQuery} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Operations Queue" })).toBeTruthy());
    expect(document.activeElement).toBe(document.body);
  });

  it("clears pagination intent when the Runtime authority scope changes", async () => {
    const page = makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" });
    const rendered = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load more operations" }));
    const search = screen.getByRole("searchbox", { name: "Search" });
    search.focus();

    hook.current.mockReturnValue(settled({
      scopeToken: Object.freeze({}),
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: null }),
        refresh: "settled",
      },
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );

    await waitFor(() => expect(screen.queryByText("All operations are shown.")).toBeNull());
    expect(document.activeElement).toBe(search);
  });

  it("does not apply unavailable retry focus to a different location query", async () => {
    const refresh = vi.fn();
    const rendered = renderQueue(settled({
      view: { availability: "unavailable", error: { kind: "network" } },
      refresh,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const nextQuery = { ...DEFAULT_OPERATIONS_QUEUE_QUERY, q: "different" };
    hook.current.mockReturnValue(settled({ view: { availability: "loading" }, refresh }));
    rendered.rerender(
      <OperationsQueue query={nextQuery} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: makeOperationsQueuePage(), refresh: "settled" },
      refresh,
    }));
    rendered.rerender(
      <OperationsQueue query={nextQuery} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Operations Queue" })).toBeTruthy());
    expect(document.activeElement).toBe(document.body);
  });

  it("does not steal focus when the user moves away during continuation", async () => {
    const page = makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" });
    const rendered = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load more operations" }));
    hook.current.mockReturnValue(settled({
      continuationInFlight: true,
      view: { availability: "available", value: page, refresh: "loading" },
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    const search = screen.getByRole("searchbox", { name: "Search" });
    search.focus();
    hook.current.mockReturnValue(settled({
      continuationOutcome: 1,
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: null }),
        refresh: "settled",
      },
    }));
    rendered.rerender(
      <OperationsQueue query={DEFAULT_OPERATIONS_QUEUE_QUERY} onQueryChange={vi.fn()} onOpenInvestigation={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("All operations are shown.")).toBeTruthy());
    expect(document.activeElement).toBe(search);
  });

  it("marks pagination unavailable during a header refresh", () => {
    const rendered = renderQueue(settled({
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" }),
        refresh: "loading",
      },
    }));
    expect(screen.getByRole("button", { name: "Load more operations" }).getAttribute("aria-disabled"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeTruthy();

    hook.current.mockReturnValue(settled({
      continuationInFlight: true,
      view: {
        availability: "available",
        value: makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" }),
        refresh: "loading",
      },
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Refresh after load" }).getAttribute("aria-disabled"))
      .toBe("true");
  });

  it("uses distinct true-empty, filtered-empty, and scope-empty copy", () => {
    const emptyPage = makeOperationsQueuePage({
      items: [],
      coordinationScopeCounts: { allVisible: 0, mine: 0, unassigned: 0 },
    });
    const state = settled({ view: { availability: "available", value: emptyPage, refresh: "settled" } });
    const rendered = renderQueue(state);
    expect(screen.getByText("No investigations are visible in Operations.")).toBeTruthy();

    rendered.rerender(
      <OperationsQueue
        query={{ ...DEFAULT_OPERATIONS_QUEUE_QUERY, q: "checkout" }}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(screen.getByText("No operations match the current search or status filter.")).toBeTruthy();

    rendered.rerender(
      <OperationsQueue
        query={{ ...DEFAULT_OPERATIONS_QUEUE_QUERY, coordinationScope: "unassigned" }}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(screen.getByText("No visible investigations are unassigned.")).toBeTruthy();

    rendered.rerender(
      <OperationsQueue
        query={{ ...DEFAULT_OPERATIONS_QUEUE_QUERY, coordinationScope: "mine" }}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(screen.getByText("No visible investigations are coordinated by you.")).toBeTruthy();

    hook.current.mockReturnValue(settled({
      view: {
        availability: "available",
        value: makeOperationsQueuePage({
          items: [],
          hiddenArchivedCount: 2,
          coordinationScopeCounts: { allVisible: 0, mine: 0, unassigned: 0 },
        }),
        refresh: "settled",
      },
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(screen.getByText("No non-archived investigations are visible in Operations.")).toBeTruthy();
  });

  it("does not offer participant assignment when the command is unavailable to a viewer", () => {
    const page = makeOperationsQueuePage();
    renderQueue(settled({
      identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({ available: false }),
    }));

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Assign participant/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Release coordinator/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Release me Checkout latency after 4.8.0 rollout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim for me Imported investigation" })).toBeTruthy();
  });

  it("renders labeled participant select and actions from the visible row only", () => {
    const page = makeOperationsQueuePage();
    const apply = vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }));
    const { onOpenInvestigation, onQueryChange } = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({ apply }),
    }));
    const title = page.items[0]!.investigation.title;

    const select = screen.getByRole("combobox", { name: `Recorded participants for ${title}` });
    expect(select.closest("a")).toBeNull();
    expect(within(select).getByRole("option", { name: "alice (identity-alice)" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "ravi (identity-ravi)" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "identity-ravi" } });

    const assign = screen.getByRole("button", {
      name: `Assign participant ravi (identity-ravi) to ${title}`,
    });
    expect(assign.closest("a")).toBeNull();
    expect(assign.className).toContain("operations-queue__coordination-action");
    fireEvent.click(assign);
    expect(apply).toHaveBeenCalledWith(page.items[0]!.investigation.id, "assign_participant", "identity-ravi");
    expect(onOpenInvestigation).not.toHaveBeenCalled();
    expect(onQueryChange).not.toHaveBeenCalled();

    const release = screen.getByRole("button", {
      name: `Release coordinator alice (identity-alice) from ${title}`,
    });
    fireEvent.click(release);
    expect(apply).toHaveBeenCalledWith(page.items[0]!.investigation.id, "release_participant", "identity-alice");

    const imported = page.items[1]!.investigation.title;
    expect(screen.getByRole("combobox", { name: `Recorded participants for ${imported}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Assign participant to ${imported}` })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /Release coordinator .*Imported investigation/u })).toBeNull();
    expect(screen.getByRole("group", { name: `Participant coordination for ${title}` }).className)
      .toContain("operations-queue__participant-control");
    expect(screen.getByRole("button", { name: "Claim for me Imported investigation" })).toBeTruthy();
  });

  it("keeps self claim/release independently busy from participant actions", () => {
    const page = makeOperationsQueuePage();
    const selfApply = vi.fn();
    const participantApply = vi.fn();
    renderQueue(settled({
      identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
      view: { availability: "available", value: page, refresh: "settled" },
      selfCoordination: {
        available: true,
        targetInvestigationId: page.items[1]!.investigation.id,
        action: "claim_self",
        state: { status: "running" },
        apply: selfApply,
        retry: vi.fn(),
      },
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: { status: "idle" },
        apply: participantApply,
      }),
    }));

    expect(screen.getByRole("button", { name: "Claim for me Imported investigation" }))
      .toHaveProperty("disabled", true);
    expect(screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${page.items[0]!.investigation.title}`,
    })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Release me Checkout latency after 4.8.0 rollout" }))
      .toHaveProperty("disabled", false);

    cleanup();
    renderQueue(settled({
      identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
      view: { availability: "available", value: page, refresh: "settled" },
      selfCoordination: {
        available: true,
        targetInvestigationId: null,
        action: null,
        state: { status: "idle" },
        apply: selfApply,
        retry: vi.fn(),
      },
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: { status: "running" },
        apply: participantApply,
      }),
    }));
    expect(screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${page.items[0]!.investigation.title}`,
    })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Release me Checkout latency after 4.8.0 rollout" }))
      .toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Claim for me Imported investigation" }))
      .toHaveProperty("disabled", false);
  });

  it("disables participant controls across rows while any participant mutation is running", () => {
    const page = makeOperationsQueuePage();
    const twoRows = {
      ...page,
      items: [
        page.items[0]!,
        {
          ...page.items[1]!,
          investigation: {
            ...page.items[1]!.investigation,
            participants: page.items[0]!.investigation.participants,
          },
        },
      ],
    };
    const participantApply = vi.fn();
    renderQueue(settled({
      identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
      view: { availability: "available", value: twoRows, refresh: "settled" },
      participantCoordination: participantAvailable({
        targetInvestigationId: twoRows.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: { status: "running" },
        apply: participantApply,
      }),
    }));
    const rowATitle = twoRows.items[0]!.investigation.title;
    const rowBTitle = twoRows.items[1]!.investigation.title;
    const rowAAssign = screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${rowATitle}`,
    });
    const rowBAssign = screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${rowBTitle}`,
    });
    expect(rowAAssign).toHaveProperty("disabled", true);
    expect(rowAAssign.getAttribute("aria-busy")).toBe("true");
    expect(rowBAssign).toHaveProperty("disabled", true);
    expect(rowBAssign.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("combobox", { name: `Recorded participants for ${rowBTitle}` }))
      .toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: `Claim for me ${rowBTitle}` }))
      .toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: `Release me ${rowATitle}` }))
      .toHaveProperty("disabled", false);
    fireEvent.click(rowBAssign);
    expect(participantApply).not.toHaveBeenCalled();
  });

  it("shows truthful auth-loss copy without claiming success and conceals a 404 row action", () => {
    const page = makeOperationsQueuePage();
    const title = page.items[0]!.investigation.title;
    for (const status of [401, 403] as const) {
      const authLoss = renderQueue(settled({
        view: { availability: "available", value: page, refresh: "settled" },
        participantCoordination: participantAvailable({
          targetInvestigationId: page.items[0]!.investigation.id,
          action: "assign_participant",
          targetIdentityId: "identity-ravi",
          state: { status: "failed", error: { kind: "auth_lost", status } },
        }),
      }));
      expect(screen.getByText("Your investigation access changed. No ownership change was assumed.")).toBeTruthy();
      expect(screen.queryByText(/Coordination updated/u)).toBeNull();
      expect(screen.getByRole("button", { name: `Assign participant alice (identity-alice) to ${title}` })).toBeTruthy();
      expect(screen.getByRole("list", { name: "Operations queue investigations" })).toBeTruthy();
      authLoss.unmount();
    }

    renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: { status: "failed", error: { kind: "not_found", status: 404 } },
      }),
    }));
    expect(screen.queryByRole("combobox", { name: `Recorded participants for ${title}` })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assign participant .*Checkout latency/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Release coordinator .*Checkout latency/u })).toBeNull();
    const recovery = screen.getByText(/no longer available for this coordination action/u);
    expect(recovery.getAttribute("tabindex")).toBe("-1");
    expect(screen.queryByText(/Coordination updated/u)).toBeNull();
    expect(screen.getByRole("list", { name: "Operations queue investigations" })).toBeTruthy();
    expect(screen.getByRole("combobox", {
      name: `Recorded participants for ${page.items[1]!.investigation.title}`,
    })).toBeTruthy();
  });

  it("keeps a 404-concealed row hidden after another row is targeted", () => {
    const page = makeOperationsQueuePage();
    const rowA = page.items[0]!;
    const rowB = page.items[1]!;
    const rendered = renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({
        targetInvestigationId: rowA.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: { status: "failed", error: { kind: "not_found", status: 404 } },
      }),
    }));
    expect(screen.queryByRole("combobox", {
      name: `Recorded participants for ${rowA.investigation.title}`,
    })).toBeNull();

    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({
        targetInvestigationId: rowB.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        concealedInvestigationIds: [rowA.investigation.id],
        state: { status: "idle" },
      }),
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={rendered.onQueryChange}
        onOpenInvestigation={rendered.onOpenInvestigation}
      />,
    );
    expect(screen.queryByRole("combobox", {
      name: `Recorded participants for ${rowA.investigation.title}`,
    })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assign participant .*Checkout latency/u })).toBeNull();
    expect(screen.getByText(/no longer available for this coordination action/u)).toBeTruthy();
    expect(screen.queryByText(/Coordination updated/u)).toBeNull();
    expect(screen.getByRole("combobox", {
      name: `Recorded participants for ${rowB.investigation.title}`,
    })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: `Assign participant to ${rowB.investigation.title}`,
    })).toBeTruthy();
  });

  it("returns focus to the 404 recovery status after concealing the row action", async () => {
    const page = makeOperationsQueuePage();
    const apply = vi.fn(async () => ({
      status: "failed" as const,
      error: { kind: "not_found" as const, status: 404 as const },
    }));
    const state = settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({ apply }),
    });
    const rendered = renderQueue(state);
    const assign = screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${page.items[0]!.investigation.title}`,
    });
    assign.focus();
    fireEvent.click(assign);

    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 2,
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-alice",
        concealedInvestigationIds: [page.items[0]!.investigation.id],
        state: { status: "failed", error: { kind: "not_found", status: 404 } },
        apply,
      }),
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={rendered.onQueryChange}
        onOpenInvestigation={rendered.onOpenInvestigation}
      />,
    );
    const recovery = screen.getByText(/no longer available for this coordination action/u);
    await waitFor(() => expect(document.activeElement).toBe(recovery));
    expect(screen.queryByText(/Coordination updated/u)).toBeNull();
    expect(rendered.onOpenInvestigation).not.toHaveBeenCalled();
    expect(rendered.onQueryChange).not.toHaveBeenCalled();
  });

  it("asks for a queue refresh after a recorded coordination change or refusal", () => {
    const page = makeOperationsQueuePage();
    renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: {
          status: "failed",
          error: {
            kind: "coordination_changed",
            status: 409,
            investigationId: page.items[0]!.investigation.id,
            action: "assign_participant",
            targetIdentityId: "identity-ravi",
            current: page.items[0]!.coordination,
          },
        },
      }),
    }));
    expect(screen.getByText("The server recorded a coordination change. Refresh the queue before trying again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry assign participant/u })).toBeNull();
  });

  it("offers retry of the exact same participant action after an unknown outcome", () => {
    const page = makeOperationsQueuePage();
    const retry = vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }));
    renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        state: { status: "failed", error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" } },
        retry,
      }),
    }));
    expect(screen.getByText(/server may have recorded this action/u)).toBeTruthy();
    const retryButton = screen.getByRole("button", {
      name: `Retry assign participant identity-ravi for ${page.items[0]!.investigation.title}`,
    });
    expect(screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${page.items[0]!.investigation.title}`,
    })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", {
      name: `Release coordinator alice (identity-alice) from ${page.items[0]!.investigation.title}`,
    })).toHaveProperty("disabled", true);
    fireEvent.click(retryButton);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("announces success without navigating and restores focus to the initiator", async () => {
    const page = makeOperationsQueuePage();
    const apply = vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }));
    const state = settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable({ apply }),
    });
    const rendered = renderQueue(state);
    const assign = screen.getByRole("button", {
      name: `Assign participant alice (identity-alice) to ${page.items[0]!.investigation.title}`,
    });
    assign.focus();
    fireEvent.click(assign);

    hook.current.mockReturnValue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      requestGeneration: 2,
      participantCoordination: participantAvailable({
        targetInvestigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-alice",
        state: { status: "succeeded", value: {} as never },
        apply,
      }),
    }));
    rendered.rerender(
      <OperationsQueue
        query={DEFAULT_OPERATIONS_QUEUE_QUERY}
        onQueryChange={rendered.onQueryChange}
        onOpenInvestigation={rendered.onOpenInvestigation}
      />,
    );
    expect(screen.getByText("Coordination updated; refreshing recorded queue data.")).toBeTruthy();
    expect(screen.getByText("Coordination updated; refreshing recorded queue data.").getAttribute("role"))
      .toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(assign));
    expect(rendered.onOpenInvestigation).not.toHaveBeenCalled();
    expect(rendered.onQueryChange).not.toHaveBeenCalled();
  });

  it("offers release of a recorded coordinator who is absent from participants", () => {
    const page = makeOperationsQueuePage();
    const populated = page.items[0]!;
    const apply = vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }));
    renderQueue(settled({
      view: {
        availability: "available",
        value: {
          ...page,
          items: [
            {
              ...populated,
              investigation: {
                ...populated.investigation,
                participants: populated.investigation.participants.filter(
                  (participant) => participant.identityId !== "identity-alice",
                ),
              },
            },
            page.items[1]!,
          ],
        },
        refresh: "settled",
      },
      participantCoordination: participantAvailable({ apply }),
    }));
    const title = populated.investigation.title;
    expect(within(screen.getByRole("combobox", { name: `Recorded participants for ${title}` }))
      .queryByRole("option", { name: /identity-alice/u })).toBeNull();
    const release = screen.getByRole("button", {
      name: `Release coordinator alice (identity-alice) from ${title}`,
    });
    fireEvent.click(release);
    expect(apply).toHaveBeenCalledWith(populated.investigation.id, "release_participant", "identity-alice");
  });

  it("wraps participant controls with responsive classes instead of clipping", () => {
    const page = makeOperationsQueuePage();
    renderQueue(settled({
      view: { availability: "available", value: page, refresh: "settled" },
      participantCoordination: participantAvailable(),
    }));
    const group = screen.getByRole("group", {
      name: `Participant coordination for ${page.items[0]!.investigation.title}`,
    });
    expect(group.className).toContain("operations-queue__participant-control");
    expect(group.querySelector(".operations-queue__participant-actions")).toBeTruthy();
    expect(group.querySelector(".operations-queue__participant-select")).toBeTruthy();
    expect(group.closest(".operations-queue__row-actions")).toBeTruthy();
    expect(group.closest(".operations-queue__row-link")).toBeNull();
  });
});
