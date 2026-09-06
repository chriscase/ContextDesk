import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsQueueLocationQuery } from "../app-location.js";
import {
  loadOperationsQueueSavedViews,
  operationsQueueSavedViewLimit,
  operationsQueueSavedViewQuery,
  operationsQueueSavedViewsKey,
  writeOperationsQueueSavedViews,
  type OperationsQueueSavedView,
} from "./saved-views.js";

const identity = { id: "alice", username: "alice", displayName: "Alice" };
const canonicalQuery: OperationsQueueLocationQuery = {
  q: "checkout",
  status: ["open"],
  includeArchived: false,
  coordinationScope: "all_visible",
};

function view(
  overrides: Partial<OperationsQueueSavedView> = {},
): OperationsQueueSavedView {
  return {
    id: "view-1",
    name: "Checkout",
    query: canonicalQuery,
    ...overrides,
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Operations Queue saved views", () => {
  it("uses a stable identity namespace and refuses anonymous persistence", () => {
    const unsigned = { id: "", username: "", displayName: "" };
    expect(operationsQueueSavedViewsKey(identity)).toBe("cd-operations-views:alice");
    expect(operationsQueueSavedViewsKey({ id: "", username: "bob", displayName: "Bob" }))
      .toBe("cd-operations-views:bob");
    expect(operationsQueueSavedViewsKey({ id: "user/name", username: "user", displayName: "User" }))
      .toBe("cd-operations-views:user%2Fname");
    expect(operationsQueueSavedViewsKey(unsigned)).toBeNull();
    expect(loadOperationsQueueSavedViews(unsigned)).toEqual([]);
    expect(writeOperationsQueueSavedViews(unsigned, [view()])).toBe(false);
    expect(window.localStorage.getItem("cd-operations-views:alice")).toBeNull();
  });

  it("persists only canonical trimmed query dimensions", () => {
    const stuffed = {
      id: "view-1",
      name: "Checkout",
      query: {
        q: "  checkout  ",
        status: ["archived", "open"],
        includeArchived: true,
        coordinationScope: "mine",
        cursor: "eyJwYWdlIjoyfQ",
        actor: "alice",
        ranking: 9,
        priority: "high",
        sla: "p1",
        due: "2026-09-06",
        lease: "held",
        presence: "online",
        items: [{ id: "row-1" }],
      },
    } as unknown as OperationsQueueSavedView;
    expect(operationsQueueSavedViewQuery(stuffed.query)).toEqual({
      q: "checkout",
      status: ["open", "archived"],
      includeArchived: true,
      coordinationScope: "mine",
    });
    expect(writeOperationsQueueSavedViews(identity, [stuffed])).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem("cd-operations-views:alice") ?? "[]") as unknown[];
    expect(stored).toEqual([
      {
        id: "view-1",
        name: "Checkout",
        query: {
          q: "checkout",
          status: ["open", "archived"],
          includeArchived: true,
          coordinationScope: "mine",
        },
      },
    ]);
    expect(loadOperationsQueueSavedViews(identity)[0]?.query).toEqual({
      q: "checkout",
      status: ["open", "archived"],
      includeArchived: true,
      coordinationScope: "mine",
    });
  });

  it("normalizes previously stored records without requiring a migration", () => {
    window.localStorage.setItem("cd-operations-views:alice", JSON.stringify([
      {
        id: "legacy",
        name: " Legacy handoffs ",
        extra: "ignore",
        query: {
          q: " checkout ",
          status: ["archived", "open"],
          includeArchived: false,
          coordinationScope: "all_visible",
          cursor: "stale",
        },
      },
    ]));
    const views = loadOperationsQueueSavedViews(identity);
    expect(views).toEqual([
      {
        id: "legacy",
        name: "Legacy handoffs",
        query: {
          q: "checkout",
          status: ["open", "archived"],
          includeArchived: false,
          coordinationScope: "all_visible",
        },
      },
    ]);
    expect(Object.isFrozen(views[0])).toBe(true);
    expect(Object.isFrozen(views[0]?.query)).toBe(true);
  });

  it("drops malformed and duplicate records while enforcing the bounded list", () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
      query: { q: "checkout", status: ["open"], includeArchived: false, coordinationScope: "all_visible" },
    }));
    records.push(records[0]!, { id: "bad", name: "", query: {} as unknown as typeof records[number]["query"] });
    window.localStorage.setItem("cd-operations-views:alice", JSON.stringify(records));

    const views = loadOperationsQueueSavedViews(identity);
    expect(views).toHaveLength(8);
    expect(operationsQueueSavedViewLimit()).toBe(8);
    expect(new Set(views.map((current) => current.id)).size).toBe(8);
    expect(views[0]?.query).toEqual({
      q: "checkout",
      status: ["open"],
      includeArchived: false,
      coordinationScope: "all_visible",
    });
    expect(Object.isFrozen(views[0])).toBe(true);
    expect(Object.isFrozen(views[0]?.query)).toBe(true);
  });

  it("refuses an all-malformed write without wiping stored views", () => {
    expect(writeOperationsQueueSavedViews(identity, [view()])).toBe(true);
    expect(writeOperationsQueueSavedViews(identity, [
      { id: "bad", name: "", query: canonicalQuery },
      {
        id: "also-bad",
        name: "Broken",
        query: { q: "x", status: ["open", "open"], includeArchived: false, coordinationScope: "all_visible" },
      },
    ])).toBe(false);
    expect(loadOperationsQueueSavedViews(identity)).toEqual([view()]);
  });

  it("caps writes at eight unique views and can clear the stored list", () => {
    const tooMany = Array.from({ length: 10 }, (_, index) => view({
      id: `view-${index}`,
      name: `View ${index}`,
    }));
    expect(writeOperationsQueueSavedViews(identity, tooMany)).toBe(true);
    expect(loadOperationsQueueSavedViews(identity).map((current) => current.id)).toEqual(
      tooMany.slice(0, 8).map((current) => current.id),
    );
    expect(writeOperationsQueueSavedViews(identity, [])).toBe(true);
    expect(loadOperationsQueueSavedViews(identity)).toEqual([]);
  });

  it("fails closed when browser storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadOperationsQueueSavedViews(identity)).toEqual([]);
    expect(writeOperationsQueueSavedViews(identity, [view()])).toBe(false);
  });
});
