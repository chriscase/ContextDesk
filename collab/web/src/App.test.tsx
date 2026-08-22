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
    expect(screen.getByRole("tablist", { name: "Workflow stages" })).toBeTruthy();
  });
});

describe("workflow stage navigator", () => {
  function stubSignedOutFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }),
    );
  }

  it("presents the four stages in order without disturbing the login form", async () => {
    stubSignedOutFetch();
    render(<App />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Capture",
      "Analyze",
      "Compare",
      "Decide",
    ]);
    expect(screen.getByText("Manual evidence intake")).toBeTruthy();
    expect(screen.getByText("AI-assisted normalization")).toBeTruthy();
    expect(screen.getByText("Models side by side")).toBeTruthy();
    expect(screen.getByText("Human call, safe export")).toBeTruthy();
    expect(screen.getByText(/not a progress tracker/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("explains each stage in the panel when selected", async () => {
    stubSignedOutFetch();
    render(<App />);

    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toMatch(/provenance/);

    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    expect(panel.textContent).toMatch(/normalizes raw captures/);
    expect(panel.textContent).toMatch(/human review/);

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(panel.textContent).toMatch(/human-accepted benchmark/);

    fireEvent.click(screen.getByRole("tab", { name: "Decide" }));
    expect(panel.textContent).toMatch(/share-safe export/);
    expect(screen.getByRole("tab", { name: "Decide" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: "Capture" }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("moves between stages with the keyboard", async () => {
    stubSignedOutFetch();
    render(<App />);

    const capture = screen.getByRole("tab", { name: "Capture" });
    expect(capture.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(capture, { key: "ArrowRight" });
    const analyze = screen.getByRole("tab", { name: "Analyze" });
    expect(analyze.getAttribute("aria-selected")).toBe("true");
    expect(analyze.getAttribute("tabindex")).toBe("0");
    expect(capture.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(analyze, { key: "End" });
    const decide = screen.getByRole("tab", { name: "Decide" });
    expect(decide.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(decide, { key: "ArrowRight" });
    expect(capture.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(capture, { key: "Home" });
    expect(capture.getAttribute("aria-selected")).toBe("true");
  });

  it("stays available in the static read-only fallback", async () => {
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
    expect(screen.getByRole("tablist", { name: "Workflow stages" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByText(/not a progress tracker/)).toBeTruthy();
  });
});
