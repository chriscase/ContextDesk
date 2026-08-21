import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__CONTEXTDESK_STATIC_READ_ONLY__;
  delete document.documentElement.dataset.theme;
});

describe("UI shell", () => {
  it("renders the rename-friendly working name and login form when signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: "ContextDesk Experiment Lab" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("identifies the static fallback and removes shell mutation controls", async () => {
    window.__CONTEXTDESK_STATIC_READ_ONLY__ = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return {
            ok: true,
            json: async () => ({ identity: { username: "demo" }, roles: ["case-lead"] }),
          };
        }
        if (url === "/api/cases") {
          return { ok: true, json: async () => ({ cases: [] }) };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<App />);
    expect(await screen.findByText(/Static read-only fallback/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create case" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add source" })).toBeNull();
  });

  it("renders the signed-in participant and server-provided roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return {
            ok: true,
            json: async () => ({ identity: { username: "dave" }, roles: ["case-lead"] }),
          };
        }
        if (url === "/api/cases") {
          return { ok: true, json: async () => ({ cases: [] }) };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    render(<App />);

    expect(await screen.findByText("dave")).toBeTruthy();
    expect(screen.getByText(/Roles: case-lead/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("supports the shared ContextDesk presentation skins", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return {
            ok: true,
            json: async () => ({ identity: { username: "demo" }, roles: [] }),
          };
        }
        if (url === "/api/cases") {
          return { ok: true, json: async () => ({ cases: [] }) };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    render(<App />);

    const selector = await screen.findByRole("combobox", { name: "Interface theme" });
    fireEvent.change(selector, { target: { value: "grokptah" } });
    expect((selector as HTMLSelectElement).value).toBe("grokptah");
    expect(document.documentElement.dataset.theme).toBe("grokptah");
  });
});
