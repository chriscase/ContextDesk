/** localStorage helpers for per-session todos (#157). Pure + testable. */

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
};

export function loadTodos(storageKey: string): TodoItem[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is TodoItem =>
        Boolean(x) &&
        typeof x === "object" &&
        typeof (x as TodoItem).id === "string" &&
        typeof (x as TodoItem).text === "string",
    );
  } catch {
    return [];
  }
}

export function saveTodos(storageKey: string, items: TodoItem[]): void {
  localStorage.setItem(storageKey, JSON.stringify(items));
}
