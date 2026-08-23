import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__CONTEXTDESK_STATIC_READ_ONLY__;
  delete document.documentElement.dataset.theme;
  delete (import.meta.env as Record<string, unknown>).VITE_CONTEXTDESK_SYNTHETIC_DEMO;
  if (typeof window.localStorage?.removeItem === "function") {
    window.localStorage.removeItem("cd-theme");
  }
  window.history.replaceState(null, "", window.location.pathname);
});

type FetchStub = ReturnType<typeof vi.fn>;

function stubSignedOutFetch(): FetchStub {
  const stub = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
  vi.stubGlobal("fetch", stub);
  return stub;
}

function stubSignedInFetch(
  identity: { username: string; roles: string[] },
  extra?: (url: string, init?: RequestInit) => Promise<Response> | null,
): FetchStub {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url === "/api/auth/me") {
      return {
        ok: true,
        json: async () => ({ identity: { username: identity.username }, roles: identity.roles }),
      };
    }
    if (url === "/api/auth/logout") {
      return { ok: true, json: async () => ({}) };
    }
    if (url === "/api/cases") {
      return { ok: true, json: async () => ({ cases: [] }) };
    }
    if (url === "/api/catalog/sources") {
      return { ok: true, json: async () => ({ sources: [] }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("auth boundary", () => {
  it("shows a restrained loading shell while the session is unresolved", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => undefined)),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: "ContextDesk War Room" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Checking your session");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("renders only the sign-in screen when signed out — no workflow, cases, or sources", async () => {
    const stub = stubSignedOutFetch();
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "ContextDesk War Room" }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText(/shared command center/)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start investigation" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(/Source & provenance library/)).toBeNull();
    const requested = stub.mock.calls.map((call) => String(call[0]));
    expect(requested).not.toContain("/api/cases");
    expect(requested).not.toContain("/api/catalog/sources");
  });

  it("offers honest sample credentials on the sign-in screen in synthetic demo mode", async () => {
    (import.meta.env as Record<string, unknown>).VITE_CONTEXTDESK_SYNTHETIC_DEMO = "1";
    stubSignedOutFetch();
    render(<App />);
    expect(await screen.findByText(/Sample data mode/)).toBeTruthy();
    expect(screen.getByText(/may reset when its service stops/)).toBeTruthy();
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("demo");
    expect(screen.queryByText(/No provider calls/)).toBeNull();
  });
});

describe("authenticated application shell", () => {
  it("shows the War Room title, primary navigation, and start action", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "ContextDesk War Room" }),
    ).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const label of ["Overview", "Investigations", "Sources", "How it works"]) {
      expect(within_nav(nav, label)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Start investigation" })).toBeTruthy();
    expect(
      screen
        .getByRole("navigation", { name: "Primary" })
        .querySelector('[aria-current="page"]')?.textContent,
    ).toBe("Overview");
    expect(screen.getByRole("heading", { name: "Operating picture" })).toBeTruthy();
  });

  it("keeps identity, roles, theme, and sign-out in the account menu", async () => {
    const stub = stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Signed in as dave" });
    fireEvent.click(trigger);
    expect(screen.getByText("Roles: case-lead")).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "Interface theme" });
    fireEvent.change(selector, { target: { value: "forest" } });
    expect(document.documentElement.dataset.theme).toBe("forest");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(stub.mock.calls.map((call) => String(call[0]))).toContain("/api/auth/logout");
    });
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("routes Sources and How it works to real destinations and back", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sources" }));
    expect(
      screen.getByRole("heading", { name: "Source & provenance library" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Operating picture" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.getByRole("tablist", { name: "Workflow stages" })).toBeTruthy();
    expect(screen.getByText(/not a progress tracker/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("heading", { name: "Operating picture" })).toBeTruthy();
  });

  it("shows the honest sample-data notice in synthetic demo mode", async () => {
    (import.meta.env as Record<string, unknown>).VITE_CONTEXTDESK_SYNTHETIC_DEMO = "1";
    stubSignedInFetch({ username: "demo", roles: ["case-lead"] });
    render(<App />);
    const notice = await screen.findByText(/Sample investigation data is loaded/);
    expect(notice.textContent).toMatch(/synthetic, live gateway, or imported/);
    expect(notice.textContent).toMatch(/may reset when its service stops/);
    expect(screen.queryByText(/No provider calls/)).toBeNull();
  });

  it("keeps the static read-only truth explicit and removes mutation entry points", async () => {
    window.__CONTEXTDESK_STATIC_READ_ONLY__ = true;
    stubSignedInFetch({ username: "demo", roles: ["case-lead"] });
    render(<App />);
    expect(await screen.findByText(/Static read-only snapshot/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start investigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Signed in as demo" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByText(/Static read-only session/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Interface theme" })).toBeTruthy();
  });

  it("maps legacy triage anchors onto the focused stage navigation", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            cases: [{ id: "c1", title: "Checkout timeouts", status: "open", severity: "high" }],
          }),
        } as Response);
      }
      if (url.endsWith("/timeline") || url.endsWith("/imports")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ events: [], runs: [] }),
        } as Response);
      }
      if (url.endsWith("/contributions") || url.endsWith("/experiments")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ contributions: [], experiments: [] }),
        } as Response);
      }
      return null;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Checkout timeouts" }));
    expect(await screen.findByRole("heading", { name: "Situation" })).toBeTruthy();
    window.location.hash = "#triage-analyze";
    // Browsers fire popstate (with a null state) before hashchange on a
    // fragment navigation; the shell must not treat that as Back-to-start.
    fireEvent(window, new PopStateEvent("popstate", { state: null }));
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Situation" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Operating picture" })).toBeNull();
  });
});

// This jsdom profile ships a localStorage whose methods are not callable (the
// app guards for exactly that); tests that need a saved value stub a real one.
function stubSavedTheme(value: string) {
  const store = new Map<string, string>([["cd-theme", value]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, next: string) => void store.set(key, next),
    removeItem: (key: string) => void store.delete(key),
  });
}

describe("theme default and naming", () => {
  it("defaults to the Command skin when no theme has been saved", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Signed in as dave" }));
    const selector = screen.getByRole("combobox", { name: "Interface theme" });
    expect((selector as HTMLSelectElement).value).toBe("grokptah");
    expect(document.documentElement.dataset.theme).toBe("grokptah");
    const selected = screen.getByRole("option", { name: "Command" }) as HTMLOptionElement;
    expect(selected.selected).toBe(true);
    expect(screen.queryByRole("option", { name: "GrokPtah" })).toBeNull();
  });

  it("falls back to the Command skin for an invalid saved value", async () => {
    stubSavedTheme("neon-glow");
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    await screen.findByRole("button", { name: "Signed in as dave" });
    expect(document.documentElement.dataset.theme).toBe("grokptah");
  });

  it("preserves an existing valid saved theme choice", async () => {
    stubSavedTheme("light");
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Signed in as dave" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    const selector = screen.getByRole("combobox", { name: "Interface theme" });
    expect((selector as HTMLSelectElement).value).toBe("light");
  });
});

describe("workflow guide help surface", () => {
  it("moves between stages with the keyboard", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "How it works" }));

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
  });

  it("explains each stage in the panel when selected", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "How it works" }));

    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toMatch(/provenance/);
    fireEvent.click(screen.getByRole("tab", { name: "Decide" }));
    expect(panel.textContent).toMatch(/share-safe export/);
  });
});

function within_nav(nav: HTMLElement, label: string): HTMLElement | null {
  return (
    Array.from(nav.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    ) ?? null
  );
}
