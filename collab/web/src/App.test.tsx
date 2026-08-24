import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { parsePathname, pathFor } from "./app-location.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__CONTEXTDESK_STATIC_READ_ONLY__;
  delete document.documentElement.dataset.theme;
  delete (import.meta.env as Record<string, unknown>).VITE_CONTEXTDESK_SYNTHETIC_DEMO;
  if (typeof window.localStorage?.removeItem === "function") {
    window.localStorage.removeItem("cd-theme");
  }
  window.history.replaceState(null, "", "/");
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
    for (const label of ["Overview", "Investigations", "Sources", "Help"]) {
      expect(within_nav(nav, label)).toBeTruthy();
    }
    expect(within_nav(nav, "How it works")).toBeNull();
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

  it("routes Sources and Help to real destinations and back", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sources" }));
    expect(
      screen.getByRole("heading", { name: "Source & provenance library" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Operating picture" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("heading", { name: "Help Center" })).toBeTruthy();
    expect(screen.getByLabelText("Search help")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Source & provenance library" })).toBeNull();
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

describe("help center in the shell", () => {
  it("keeps help search and topic state while visiting another area", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Help" }));
    const search = screen.getByLabelText("Search help") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "snapshot" } });
    expect(screen.getByRole("status").textContent).toMatch(/result/);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.queryByRole("heading", { name: "Help Center" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect((screen.getByLabelText("Search help") as HTMLInputElement).value).toBe("snapshot");
    expect(screen.getByRole("status").textContent).toMatch(/result/);
  });

  it("offers no investigation-stage shortcuts when no investigation is in focus", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Help" }));
    expect(screen.getByRole("heading", { name: "Help Center" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Return to your investigation" })).toBeNull();
  });

  it("returns to the focused investigation's stage through a real help shortcut", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    const shortcuts = screen.getByRole("group", { name: "Return to your investigation" });
    expect(shortcuts).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByRole("heading", { name: "Analyze" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Help Center" })).toBeNull();
  });
});

function within_nav(nav: HTMLElement, label: string): HTMLElement | null {
  return (
    Array.from(nav.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    ) ?? null
  );
}


describe("pathname parsing", () => {
  it("maps canonical area and investigation paths and rejects open redirects", () => {
    expect(parsePathname("/")).toEqual({
      area: "overview",
      caseId: null,
      stage: "situation",
    });
    expect(parsePathname("/sources")).toEqual({
      area: "sources",
      caseId: null,
      stage: "situation",
    });
    expect(parsePathname("/signin")).toEqual({ kind: "sign-in" });
    expect(parsePathname("/sign-in")).toEqual({ kind: "sign-in" });
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(parsePathname(`/investigations/${uuid}/analyze`)).toEqual({
      area: "investigations",
      caseId: uuid,
      stage: "analyze",
    });
    const focused = parsePathname(
      `/investigations/${uuid}/compare`,
      "?section=cross-exam-heading&item=ev-synthetic-7&lane=lane-a&experiment=exp-a",
      "#cross-exam-heading",
    );
    expect(focused).toMatchObject({
      area: "investigations",
      caseId: uuid,
      stage: "compare",
      focus: {
        section: "cross-exam-heading",
        item: "ev-synthetic-7",
        lane: "lane-a",
        experiment: "exp-a",
      },
    });
    expect(pathFor(focused)).toBe(
      `/investigations/${uuid}/compare?section=cross-exam-heading&item=ev-synthetic-7&lane=lane-a&experiment=exp-a#cross-exam-heading`,
    );
    expect(parsePathname("//evil.example/phish")).toMatchObject({ kind: "unknown" });
    expect(parsePathname("/investigations/../sources")).toMatchObject({ kind: "unknown" });
    expect(parsePathname("https://evil.example")).toMatchObject({ kind: "unknown" });
    expect(pathFor({ kind: "sign-in" })).toBe("/signin");
    expect(pathFor({ kind: "unknown", attempted: "/nope" })).toBe("/not-found");
  });
});

describe("pathname shell routing", () => {
  it("restores a direct area pathname after a signed-in load", async () => {
    window.history.replaceState(null, "", "/sources");
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Source & provenance library" })).toBeTruthy();
    expect(window.location.pathname).toBe("/sources");
    expect(
      screen.getByRole("navigation", { name: "Primary" }).querySelector('[aria-current="page"]')
        ?.textContent,
    ).toBe("Sources");
  });

  it("keeps browser Back and Forward in sync with area pathnames", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sources" }));
    expect(window.location.pathname).toBe("/sources");
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(window.location.pathname).toBe("/help");
    expect(screen.getByRole("heading", { name: "Help Center" })).toBeTruthy();
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/sources"));
    expect(screen.getByRole("heading", { name: "Source & provenance library" })).toBeTruthy();
    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe("/help"));
    expect(screen.getByRole("heading", { name: "Help Center" })).toBeTruthy();
  });

  it("shows a bounded not-found page for unknown pathnames", async () => {
    window.history.replaceState(null, "", "/definitely-not-a-route");
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "This page is not in the War Room" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("/definitely-not-a-route");
    expect(screen.queryByRole("heading", { name: "Operating picture" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to overview" }));
    expect(await screen.findByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("opens the shell after a successful sign-in and does not keep the form visible", async () => {
    let signedIn = false;
    const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/me") {
        if (!signedIn) return { ok: false, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({ identity: { username: "dave" }, roles: ["case-lead"] }),
        };
      }
      if (url === "/api/auth/login") {
        expect(init?.method).toBe("POST");
        signedIn = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [] }) };
      if (url === "/api/catalog/sources") return { ok: true, json: async () => ({ sources: [] }) };
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "dave" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("returns to the dedicated sign-in route immediately on sign-out, without a stale shell flash", async () => {
    let release: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {};
    const gate = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      release = resolve;
    });
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/auth/logout") return gate as Promise<Response>;
      return null;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Signed in as dave" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Operating picture" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(window.location.pathname).toBe("/signin");
    release({ ok: true, json: async () => ({}) });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("does not paint the shell for a deep link until the session is known", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input) === "/api/auth/me") {
          await gate;
          return {
            ok: true,
            json: async () => ({ identity: { username: "dave" }, roles: ["case-lead"] }),
          };
        }
        if (String(input) === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        if (String(input) === "/api/cases") {
          return { ok: true, json: async () => ({ cases: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.history.replaceState(null, "", "/sources");
    render(<App />);
    expect(screen.getByText(/Checking your session/)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Source & provenance library" })).toBeNull();
    release(undefined);
    expect(await screen.findByRole("heading", { name: "Source & provenance library" })).toBeTruthy();
    expect(window.location.pathname).toBe("/sources");
  });

  it("restores a UUID investigation pathname on load", async () => {
    const uuid = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/investigations/${uuid}/analyze`);
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            cases: [{ id: uuid, title: "Checkout timeouts", status: "open", severity: "high" }],
          }),
        } as Response);
      }
      if (url.endsWith("/timeline") || url.endsWith("/imports")) {
        return Promise.resolve({ ok: true, json: async () => ({ events: [], runs: [] }) } as Response);
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
    expect(await screen.findByRole("heading", { name: "Checkout timeouts" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Analyze" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/investigations/${uuid}/analyze`);
  });

  it("restores exact deep focus and keeps Back navigation on the same investigation", async () => {
    const uuid = "44444444-4444-4444-8444-444444444444";
    const compareUrl = `/investigations/${uuid}/compare?section=cross-exam-heading&item=ev-synthetic-9&lane=lane-blue&experiment=exp-blue#cross-exam-heading`;
    window.history.replaceState(null, "", compareUrl);
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            cases: [{ id: uuid, title: "Synthetic queue delay", status: "open", severity: "high" }],
          }),
        } as Response);
      }
      if (url.endsWith("/timeline") || url.endsWith("/imports")) {
        return Promise.resolve({ ok: true, json: async () => ({ events: [], runs: [] }) } as Response);
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
    expect(await screen.findByRole("heading", { name: "Compare" })).toBeTruthy();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(compareUrl);

    const decideUrl = `/investigations/${uuid}/decide?section=decision-heading&experiment=exp-blue#decision-heading`;
    window.history.pushState(null, "", decideUrl);
    fireEvent(window, new PopStateEvent("popstate", { state: null }));
    expect(await screen.findByRole("heading", { name: "Decide" })).toBeTruthy();
    window.history.back();
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(compareUrl));
    expect(await screen.findByRole("heading", { name: "Compare" })).toBeTruthy();
    expect(window.location.pathname).not.toBe("/investigations");
  });

  it("keeps in-app case focus in a canonical pathname so reload does not fall back to the list", async () => {
    const uuid = "33333333-3333-4333-8333-333333333333";
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            cases: [{ id: uuid, title: "Synthetic timeout", status: "open", severity: "high" }],
          }),
        } as Response);
      }
      if (url.endsWith("/timeline") || url.endsWith("/imports")) {
        return Promise.resolve({ ok: true, json: async () => ({ events: [], runs: [] }) } as Response);
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
    fireEvent.click(await screen.findByRole("button", { name: "Synthetic timeout" }));
    expect(await screen.findByRole("heading", { name: "Situation" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/investigations/${uuid}/situation`);
    expect(window.location.pathname).not.toBe("/investigations");
  });

  it("renders without crashing under StrictMode", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  });
});
