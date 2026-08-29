import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (typeof window.localStorage?.removeItem === "function") {
    window.localStorage.removeItem("cd-ui-strategy:alice");
    window.localStorage.removeItem("cd-ui-strategy:bob");
  }
  window.history.replaceState(null, "", "/");
});

describe("strategy selection in the shell", () => {
  it("keeps War Room as the default and switches presentation without changing the route", async () => {
    if (typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem("cd-ui-strategy:alice");
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["contributor"], capabilities: ["investigation:read", "investigation:write"] }) };
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(<App />);
    expect(await screen.findByText("War Room")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Investigation First/ }));
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("Investigation First");
    expect(screen.getByRole("heading", { name: "Create an investigation" })).toBeTruthy();
    expect(document.title).toBe("ContextDesk Investigation First");
    expect(window.location.pathname).toBe("/");
  });

  it("keeps a shared browser's preferences isolated by authenticated username", async () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, value); },
    };
    vi.stubGlobal("localStorage", storage);
    window.localStorage.setItem("cd-ui-strategy:alice", "investigation-first");
    window.localStorage.setItem("cd-ui-strategy:bob", "war-room");

    const signedInFetch = (username: string) => vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username, displayName: username }, roles: ["contributor"], capabilities: ["investigation:read", "investigation:write"] }) };
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal("fetch", signedInFetch("alice"));
    const alice = render(<App />);
    expect(await screen.findByRole("heading", { name: "Create an investigation" })).toBeTruthy();
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("Investigation First");
    alice.unmount();
    window.history.replaceState(null, "", "/");

    vi.stubGlobal("fetch", signedInFetch("bob"));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room"));
    expect(screen.queryByRole("heading", { name: "Create an investigation" })).toBeNull();
    expect(window.localStorage.getItem("cd-ui-strategy:alice")).toBe("investigation-first");
    expect(window.localStorage.getItem("cd-ui-strategy:bob")).toBe("war-room");
  });
});
