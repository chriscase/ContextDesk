import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTodos, saveTodos, type TodoItem } from "./todoStorage";

/** Minimal in-memory localStorage for unit tests (happy-dom may lack clear). */
function installMemoryStorage() {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(k) {
      return map.has(k) ? map.get(k)! : null;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    removeItem(k) {
      map.delete(k);
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
  };
  vi.stubGlobal("localStorage", store);
}

describe("todoStorage (#157)", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("loads empty when key missing", () => {
    expect(loadTodos("cd-todos-a")).toEqual([]);
  });

  it("round-trips items for a key", () => {
    const items: TodoItem[] = [
      { id: "1", text: "alpha", done: false },
      { id: "2", text: "beta", done: true },
    ];
    saveTodos("cd-todos-a", items);
    expect(loadTodos("cd-todos-a")).toEqual(items);
  });

  it("does not cross-contaminate keys (session switch)", () => {
    saveTodos("cd-todos-a", [{ id: "1", text: "only-a", done: false }]);
    saveTodos("cd-todos-b", [{ id: "2", text: "only-b", done: false }]);
    expect(loadTodos("cd-todos-a").map((t) => t.text)).toEqual(["only-a"]);
    expect(loadTodos("cd-todos-b").map((t) => t.text)).toEqual(["only-b"]);
  });

  it("simulate key switch without writing old items to new key", () => {
    // Session A has todos
    const a: TodoItem[] = [{ id: "1", text: "a-item", done: false }];
    saveTodos("cd-todos-a", a);
    // Session B empty
    expect(loadTodos("cd-todos-b")).toEqual([]);
    // After key switch, UI must load B (empty) — not write A into B
    const loadedB = loadTodos("cd-todos-b");
    expect(loadedB).toEqual([]);
    // A intact
    expect(loadTodos("cd-todos-a")).toEqual(a);
  });
});
