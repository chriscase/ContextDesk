import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOperationsQueueSavedViews,
  operationsQueueSavedViewsKey,
  writeOperationsQueueSavedViews,
} from "./saved-views.js";

const identity = { id: "alice", username: "alice", displayName: "Alice" };

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
    expect(operationsQueueSavedViewsKey(identity)).toBe("cd-operations-views:alice");
    expect(operationsQueueSavedViewsKey({ id: "", username: "bob", displayName: "Bob" }))
      .toBe("cd-operations-views:bob");
    expect(operationsQueueSavedViewsKey({ id: "", username: "", displayName: "" })).toBeNull();
    expect(writeOperationsQueueSavedViews({ id: "", username: "", displayName: "" }, [])).toBe(false);
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
    expect(new Set(views.map((view) => view.id)).size).toBe(8);
    expect(views[0]?.query).toEqual({
      q: "checkout",
      status: ["open"],
      includeArchived: false,
      coordinationScope: "all_visible",
    });
    expect(Object.isFrozen(views[0])).toBe(true);
    expect(Object.isFrozen(views[0]?.query)).toBe(true);
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
    expect(writeOperationsQueueSavedViews(identity, [])).toBe(false);
  });
});
