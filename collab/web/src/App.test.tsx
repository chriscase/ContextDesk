import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { parsePathname, pathFor, sameLocation, type WorkLocation } from "./app-location.js";

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
  identity: { username: string; displayName?: string; roles: string[] },
  extra?: (url: string, init?: RequestInit) => Promise<Response> | null,
): FetchStub {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url === "/api/auth/me") {
      return {
        ok: true,
        json: async () => ({
          identity: {
            username: identity.username,
            displayName: identity.displayName ?? identity.username,
          },
          roles: identity.roles,
        }),
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

const routedLaneExperiment = {
  id: "exp-route-lane",
  packageId: "pkg-route-lane",
  taskFingerprint: "task-route-lane",
  snapshotFingerprint: "snapshot-route-lane",
  candidates: [
    {
      candidateId: "cand-qwen-3.6-27b",
      modelLabel: "qwen-3.6-27b",
      role: "single",
      runStatus: "completed",
      observedLatency: { status: "observed", milliseconds: 4120 },
      cost: { status: "unknown" },
      usage: { status: "unknown" },
      helpfulnessState: "unreviewed",
      goldState: "unknown",
    },
  ],
  agreement: {
    sharedAnchors: [],
    candidateSpecific: [],
    roleConflicts: [],
    notes: ["Agreement is not proof of correctness."],
  },
  observations: [],
  decisions: [],
  gold: null,
  alignments: [
    {
      candidateId: "cand-qwen-3.6-27b",
      status: "unknown",
      matchedAnchors: [],
      missingAnchors: [],
      extraAnchors: [],
      notes: [],
    },
  ],
  traces: [],
  comparison: {
    questionPaths: [],
    sharedEvidence: [],
    uniqueEvidence: [],
    divergence: [],
    convergence: [],
    efficiency: [],
    gold: { status: "absent", version: null, acceptedDecisionId: null },
    notes: [],
  },
};

function stubRoutedCompare(uuid: string): FetchStub {
  return stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
    if (url === "/api/cases") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          cases: [{ id: uuid, title: "Routed lane focus", status: "open", severity: "high" }],
        }),
      } as Response);
    }
    if (url === `/api/cases/${uuid}/experiments`) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ experiments: [routedLaneExperiment] }),
      } as Response);
    }
    if (url.endsWith("/timeline")) {
      return Promise.resolve({ ok: true, json: async () => ({ events: [] }) } as Response);
    }
    if (url.endsWith("/contributions")) {
      return Promise.resolve({ ok: true, json: async () => ({ contributions: [] }) } as Response);
    }
    if (url.endsWith("/imports")) {
      return Promise.resolve({ ok: true, json: async () => ({ runs: [] }) } as Response);
    }
    if (url.endsWith("/presence")) {
      return Promise.resolve({ ok: true, json: async () => ({ members: [] }) } as Response);
    }
    return null;
  });
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

  it("invalidates the whole protected shell when a background GET loses authorization", async () => {
    let denyActivity!: (value: Response) => void;
    const activity = new Promise<Response>((resolve) => { denyActivity = resolve; });
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            cases: [{
              id: "11111111-1111-4111-8111-111111111111",
              title: "Protected fixture investigation",
              status: "open",
              severity: "high",
            }],
          }),
        } as Response);
      }
      if (url === "/api/activity?limit=30") return activity;
      return null;
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Protected fixture investigation" })).toBeTruthy();

    denyActivity({ ok: false, status: 401, json: async () => ({}) } as Response);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Protected fixture investigation")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(window.location.pathname).toBe("/signin");
  });

  it("invalidates the whole protected shell when a mutation loses authorization", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url, init) => {
      if (url === "/api/cases" && (init?.method ?? "GET") === "POST") {
        return Promise.resolve({ ok: false, status: 403, json: async () => ({}) } as Response);
      }
      return null;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Investigations" }));
    fireEvent.change(screen.getByPlaceholderText("New investigation title"), {
      target: { value: "Never retain this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByDisplayValue("Never retain this draft")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.location.pathname).toBe("/signin");
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
    expect(within_nav(nav, "Administration")).toBeNull();
    expect(screen.getByRole("button", { name: "Start investigation" })).toBeTruthy();
    expect(
      screen
        .getByRole("navigation", { name: "Primary" })
        .querySelector('[aria-current="page"]')?.textContent,
    ).toBe("Overview");
    expect(screen.getByRole("heading", { name: "Operating picture" })).toBeTruthy();
  });

  it("shows Administration only to admins and does not fetch protected admin data for direct non-admin routes", async () => {
    window.history.replaceState(null, "", "/administration");
    const nonAdminFetch = stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Administration is unavailable" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Administration" })).toBeNull();
    expect(nonAdminFetch.mock.calls.map((call) => String(call[0]))).not.toContain(
      "/api/authz/group-role-map",
    );
    cleanup();

    window.history.replaceState(null, "", "/");
    stubSignedInFetch({ username: "owner", roles: ["admin"] }, (url) => {
      if (url === "/api/authz/group-role-map") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            schemaId: "cd-collab.admin_role_mapping_list.v1",
            mappings: [{ group: "local:admins", role: "admin" }],
            limit: 500,
            truncated: false,
          }),
        } as Response);
      }
      return null;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Administration" }));
    expect(await screen.findByRole("heading", { name: "Administration" })).toBeTruthy();
    expect(window.location.pathname).toBe("/administration");
    expect(document.title).toBe("Administration · ContextDesk War Room");
  });

  it("routes Start investigation to the inventory and focuses the title field", async () => {
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Start investigation" }));

    expect(screen.getByRole("heading", { name: "Investigations" })).toBeTruthy();
    const title = screen.getByPlaceholderText("New investigation title");
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it("keeps identity, roles, theme, and sign-out in the account menu", async () => {
    const stub = stubSignedInFetch({
      username: "dave",
      displayName: "Dave Rivera",
      roles: ["case-lead"],
    });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Signed in as Dave Rivera" });
    fireEvent.click(trigger);
    expect(screen.getAllByText("Dave Rivera")).toHaveLength(2);
    expect(screen.getByText("@dave")).toBeTruthy();
    expect(screen.getByText("Access: Case lead")).toBeTruthy();
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
    expect(parsePathname("/administration")).toEqual({
      area: "administration",
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
        itemKind: null,
        lane: "lane-a",
        experiment: "exp-a",
      },
    });
    expect(pathFor(focused)).toBe(
      `/investigations/${uuid}/compare?section=cross-exam-heading&item=ev-synthetic-7&lane=lane-a&experiment=exp-a#cross-exam-heading`,
    );
    const typedItem: WorkLocation = {
      area: "investigations",
      caseId: uuid,
      stage: "analyze",
      focus: {
        section: "triage-evidence-board",
        item: "evidence-7",
        itemKind: "evidence",
        lane: null,
        experiment: null,
      },
    };
    expect(pathFor(typedItem)).toBe(
      `/investigations/${uuid}/analyze?section=triage-evidence-board&item=evidence-7&kind=evidence#triage-evidence-board`,
    );
    expect(parsePathname(
      `/investigations/${uuid}/analyze`,
      "?section=triage-evidence-board&item=evidence-7&kind=evidence",
      "#triage-evidence-board",
    )).toEqual(typedItem);
    const focusedWork = focused as WorkLocation;
    const preservePosition: WorkLocation = {
      ...focusedWork,
      focus: { ...focusedWork.focus!, navigation: "preserve" },
    };
    expect(pathFor(preservePosition)).toBe(pathFor(focusedWork));
    expect(sameLocation(focusedWork, preservePosition)).toBe(false);
    const reparsedUrl = new URL(pathFor(preservePosition), "https://contextdesk.invalid");
    expect(parsePathname(reparsedUrl.pathname, reparsedUrl.search, reparsedUrl.hash)).not.toMatchObject(
      { focus: { navigation: "preserve" } },
    );
    expect(parsePathname("//evil.example/phish")).toMatchObject({ kind: "unknown" });
    expect(parsePathname("/investigations/../sources")).toMatchObject({ kind: "unknown" });
    expect(parsePathname("https://evil.example")).toMatchObject({ kind: "unknown" });
    expect(pathFor({ kind: "sign-in" })).toBe("/signin");
    expect(pathFor({ kind: "unknown", attempted: "/nope" })).toBe("/not-found");
  });
});

describe("pathname shell routing", () => {
  it("restores an exact captured item and names the investigation stage in the document title", async () => {
    const uuid = "77777777-7777-4777-8777-777777777777";
    window.history.replaceState(null, "",
      `/investigations/${uuid}/capture?section=triage-capture&item=note-7&kind=contribution#triage-capture`,
    );
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            cases: [{ id: uuid, title: "Synthetic queue timeout", status: "open", severity: "high" }],
          }),
        } as Response);
      }
      if (url === `/api/cases/${uuid}/timeline`) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            events: [{
              seq: 7,
              kind: "contribution_created",
              actorUsername: "dave",
              targetId: "note-7",
              serverTime: "2026-08-24T12:00:00.000Z",
              payload: "{}",
            }],
          }),
        } as Response);
      }
      if (url === `/api/cases/${uuid}/contributions`) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ contributions: [{
            id: "note-7",
            kind: "note",
            body: "Synthetic worker queue paused.",
            privacyClass: "owner_only",
            tombstoned: false,
          }] }),
        } as Response);
      }
      if (url === `/api/cases/${uuid}/imports`) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: [] }) } as Response);
      }
      return null;
    });
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<App />);
      const target = await screen.findByText("Synthetic worker queue paused.");
      const item = target.closest("[data-route-item]") as HTMLElement;
      await waitFor(() => expect(document.activeElement).toBe(item));
      expect(item.dataset.routeItem).toBe("note-7");
      expect(item.dataset.routeKind).toBe("contribution");
      await waitFor(() => {
        expect(document.title).toBe("Synthetic queue timeout · Capture · ContextDesk War Room");
      });
      expect(window.location.pathname).toBe(`/investigations/${uuid}/capture`);
      expect(window.location.search).toContain("kind=contribution");
      fireEvent.click(screen.getByRole("button", { name: "Sources" }));
      await waitFor(() => expect(document.title).toBe("Sources · ContextDesk War Room"));
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("restores a shared workstream address on load, then survives Back and Forward", async () => {
    const uuid = "22222222-2222-4222-8222-222222222222";
    const workstreamKey = "run-1:reviewer-lane";
    window.history.replaceState(
      null,
      "",
      `/investigations/${uuid}/analyze?section=workstreams&item=${encodeURIComponent(workstreamKey)}&kind=workstream&lane=${encodeURIComponent(workstreamKey)}#workstreams`,
    );
    stubSignedInFetch({ username: "dave", roles: ["case-lead"] }, (url) => {
      if (url === "/api/cases") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            cases: [
              { id: uuid, title: "Synthetic checkout timeouts", status: "open", severity: "high" },
            ],
          }),
        } as Response);
      }
      if (url === `/api/cases/${uuid}/workstreams`) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            schemaId: "cd-collab.workstream_list.v1",
            caseId: uuid,
            workstreams: [
              {
                key: workstreamKey,
                caseId: uuid,
                label: "Reviewer workstream — fixture-reviewer-a",
                purpose: "What caused the checkout timeout?",
                operatorKind: "ai_assisted",
                operatorLabel: "AI-assisted workstream — output is analysis, never a human finding",
                assignedTo: "dave",
                strategyLabel: "Standard synthetic strategy",
                role: "reviewer",
                inputs: {
                  question: "What caused the checkout timeout?",
                  snapshotLabel: "Frozen evidence set 1",
                  snapshotEvidenceCount: 1,
                  snapshotFrozenAt: "2026-08-24T06:13:00.000Z",
                  sameSnapshot: true,
                  snapshotProofLabel:
                    "Ran against the exact frozen evidence set, proven by the host.",
                },
                statusCode: "completed",
                lifecycle: "settled",
                statusLabel: "Completed",
                statusDetail: "Finished and recorded its findings.",
                startedAt: "2026-08-24T06:14:10.000Z",
                finishedAt: "2026-08-24T06:14:25.000Z",
                findings: "Checkout waited on the inventory call before failing.",
                outcome: "Recorded a written finding; it cited 0 evidence items.",
                evidenceCited: [],
                unknowns: [],
                activity: [
                  {
                    at: "2026-08-24T06:14:00.000Z",
                    label: "Run queued",
                    actor: "dave",
                    detail: null,
                  },
                ],
                rerun: { isRerun: false, parentKey: null, note: "Not a rerun." },
                agreementNotice: "Agreement is not proof of correctness.",
                technical: {
                  workstreamKey,
                  runId: "run-1",
                  candidateId: "reviewer-lane",
                  snapshotId: "snapshot-1",
                  snapshotFingerprint: "f".repeat(64),
                  requestFingerprint: "a".repeat(64),
                  taskFingerprint: "task-fingerprint",
                  strategyId: "contextdesk.standard.synthetic",
                  modelId: "fixture-reviewer-a",
                  modelVersion: null,
                  provider: "synthetic",
                  profileId: null,
                  outputHash: null,
                  benchmarkRunId: null,
                  parentRunId: null,
                  errorCode: null,
                  privacyClass: "share_safe",
                },
              },
            ],
          }),
        } as Response);
      }
      if (url.startsWith(`/api/cases/${uuid}/`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ events: [], contributions: [], runs: [], artifacts: [], snapshots: [] }),
        } as Response);
      }
      return null;
    });

    render(<App />);

    // The shared address opens that exact workstream, not the investigations list.
    expect(
      await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(`/investigations/${uuid}/analyze`);
    expect(window.location.search).toContain(`lane=${encodeURIComponent(workstreamKey)}`);

    // Returning to the list is a real navigation…
    fireEvent.click(screen.getByRole("link", { name: "All workstreams" }));
    await waitFor(() =>
      expect(window.location.search).not.toContain(`lane=${encodeURIComponent(workstreamKey)}`),
    );
    expect(screen.getByRole("heading", { name: "Workstreams" })).toBeTruthy();

    // …so Back restores the workstream and Forward returns to the list.
    window.history.back();
    await waitFor(() =>
      expect(window.location.search).toContain(`lane=${encodeURIComponent(workstreamKey)}`),
    );
    expect(
      await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    window.history.forward();
    await waitFor(() =>
      expect(window.location.search).not.toContain(`lane=${encodeURIComponent(workstreamKey)}`),
    );
    expect(screen.getByRole("heading", { name: "Workstreams" })).toBeTruthy();
  });

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

  it("shows first-run setup before sign-in when the host reports an unconfigured installation", async () => {
    const stub = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaId: "cd-collab.setup_status.v1",
            revision: 0,
            phase: "unclaimed",
            claimed: false,
            failureCode: null,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Prepare your War Room in about five minutes",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(stub.mock.calls.some(([input]) => String(input) === "/api/auth/me")).toBe(false);
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

  it("preserves position and focus when the bare routed Compare view selects a lane", async () => {
    const uuid = "55555555-5555-4555-8555-555555555555";
    window.history.replaceState(null, "", `/investigations/${uuid}/compare`);
    stubRoutedCompare(uuid);
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<App />);
      const summaryHeading = await screen.findByRole("heading", { name: "At a glance" });
      const laneButton = screen.getByRole("button", { name: "qwen-3.6-27b" });
      laneButton.focus();
      scrollIntoView.mockClear();

      fireEvent.click(laneButton);

      await waitFor(() => {
        expect(window.location.search).toContain("section=scan-heading");
        expect(window.location.search).toContain("lane=cand-qwen-3.6-27b");
        expect(window.location.search).toContain("experiment=exp-route-lane");
      });
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
      expect((window.history.state as WorkLocation).focus?.navigation).toBe("preserve");
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(laneButton);
      expect(document.activeElement).not.toBe(summaryHeading);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("focuses a direct section destination after reload drops transient lane intent", async () => {
    const uuid = "66666666-6666-4666-8666-666666666666";
    const url = `/investigations/${uuid}/compare?section=candidate-comparison-heading&lane=cand-qwen-3.6-27b&experiment=exp-route-lane#candidate-comparison-heading`;
    window.history.replaceState(
      {
        area: "investigations",
        caseId: uuid,
        stage: "compare",
        focus: {
          section: "candidate-comparison-heading",
          item: null,
          lane: "cand-qwen-3.6-27b",
          experiment: "exp-route-lane",
          navigation: "preserve",
        },
      } satisfies WorkLocation,
      "",
      url,
    );
    stubRoutedCompare(uuid);
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<App />);

      const destination = await screen.findByRole("heading", { name: "Candidate comparison" });
      await waitFor(() => expect(document.activeElement).toBe(destination));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
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
