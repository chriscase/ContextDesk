import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CASE_LIST_SCHEMA_ID,
  CASE_SCHEMA_ID,
  CONTRIBUTION_LIST_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  INVESTIGATION_COORDINATION_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  parseCase,
  type CaseV1,
} from "@cd-collab/contracts";
import { App } from "./App.js";
import {
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
} from "@cd-collab/contracts/investigation-activity";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function investigation(
  id: string,
  title: string,
  status: CaseV1["status"] = "open",
  severity: CaseV1["severity"] = "medium",
): CaseV1 {
  return parseCase({
    schemaId: CASE_SCHEMA_ID,
    id,
    title,
    severity,
    status,
    legalHold: false,
    retentionClass: "standard",
    participants: [],
    createdAt: "2026-08-29T12:00:00.000Z",
    createdBy: "alice",
  });
}

function runtimeReadResponse(url: string, cases: readonly CaseV1[]): Response | null {
  if (url === "/api/investigation-activity?limit=30") {
    return jsonResponse({
      schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
      items: [],
      nextCursor: null,
      notices: [...INVESTIGATION_ACTIVITY_NOTICES],
    });
  }
  if (url === "/api/cases") {
    return jsonResponse({ schemaId: CASE_LIST_SCHEMA_ID, cases });
  }
  const active = cases.find((candidate) => url === `/api/cases/${candidate.id}`);
  if (active) return jsonResponse(active);
  const nested = cases.find((candidate) => url.startsWith(`/api/cases/${candidate.id}/`));
  if (!nested) return null;
  if (url.endsWith("/evidence")) {
    return jsonResponse({
      schemaId: EVIDENCE_LIST_SCHEMA_ID,
      caseId: nested.id,
      artifacts: [],
    });
  }
  if (url.endsWith("/contributions")) {
    return jsonResponse({
      schemaId: CONTRIBUTION_LIST_SCHEMA_ID,
      caseId: nested.id,
      contributions: [],
    });
  }
  if (url.endsWith("/coordination")) {
    return jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_SCHEMA_ID,
      investigationId: nested.id,
      coordinator: null,
      revision: 0,
      updatedAt: null,
      updatedBy: null,
      archived: nested.status === "archived",
    });
  }
  if (url.endsWith("/lifecycle")) {
    return jsonResponse({
      schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
      investigationId: nested.id,
      status: nested.status,
      legalHold: nested.legalHold,
      archive: nested.status === "archived"
        ? {
            allowed: false,
            action: "archive",
            reason: "already_archived",
            detail: "This investigation is already archived.",
          }
        : { allowed: true, action: "archive", targetStatus: "archived" },
      restore: nested.status === "archived"
        ? { allowed: true, action: "restore", targetStatus: "open" }
        : {
            allowed: false,
            action: "restore",
            reason: "not_archived",
            detail: "This investigation is not archived.",
          },
      restoreTarget: "open",
      deletion: {
        supported: false,
        detail: "Investigations are archived, never permanently deleted.",
        alternatives: ["archive"],
      },
    });
  }
  return null;
}

function strategyEffective(
  preferredId: "war-room" | "investigation-first" = "war-room",
  preferenceRevision = preferredId === "war-room" ? 0 : 1,
): Response {
  return jsonResponse({
    schemaId: "cd-collab.ui_strategy_effective.v1",
    policyRevision: 1,
    preferenceRevision,
    preferredId: preferenceRevision === 0 ? null : preferredId,
    effectiveId: preferredId,
    defaultId: "war-room",
    enabledIds: ["war-room", "investigation-first", "keystone"],
    selectableIds: ["war-room", "investigation-first", "keystone"],
    canSelect: true,
    source: preferenceRevision === 0 ? "instance_default" : "user",
  });
}

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
  it("reconciles an open selector draft when a policy refresh removes that choice", async () => {
    let restricted = false;
    const fetchStub = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["contributor"], capabilities: ["investigation:read"] }) };
      if (url === "/api/ui-strategies/effective") {
        return restricted ? jsonResponse({
          schemaId: "cd-collab.ui_strategy_effective.v1",
          policyRevision: 2,
          preferenceRevision: 0,
          preferredId: null,
          effectiveId: "war-room",
          defaultId: "war-room",
          enabledIds: ["war-room"],
          selectableIds: ["war-room"],
          canSelect: true,
          source: "instance_default",
        }) : strategyEffective();
      }
      return runtimeReadResponse(url, []) ?? { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Signed in as Alice" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Investigation First/u }));
    restricted = true;
    act(() => window.dispatchEvent(new Event("contextdesk:ui-strategy-policy-changed")));

    await waitFor(() => expect(screen.queryByRole("radio", { name: /Investigation First/u })).toBeNull());
    expect((screen.getByRole("radio", { name: /War Room/u }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("button", { name: "Use selected experience" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps Overview canonical while applying the selected strategy only to Investigations", async () => {
    if (typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem("cd-ui-strategy:alice");
    }
    let preferred: "war-room" | "investigation-first" = "war-room";
    const fetchStub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["contributor"], capabilities: ["investigation:read", "investigation:write"] }) };
      if (url === "/api/ui-strategies/effective") return strategyEffective(preferred, preferred === "war-room" ? 0 : 1);
      if (url === "/api/ui-strategies/preference" && init?.method === "PUT") {
        preferred = JSON.parse(String(init.body)).strategyId as typeof preferred;
        return strategyEffective(preferred, 1);
      }
      const runtime = runtimeReadResponse(url, []);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    expect(await screen.findByText("War Room")).toBeTruthy();
    await waitFor(() => {
      expect(fetchStub.mock.calls.filter(([input]) => String(input) === "/api/cases")).toHaveLength(1);
    });
    const account = screen.getByRole("button", { name: /Alice/ });
    fireEvent.click(account);
    fireEvent.click(screen.getByRole("radio", { name: /Investigation First/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use selected experience" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(account);
      expect(account.getAttribute("aria-expanded")).toBe("true");
    });
    expect(await screen.findByText(/is now your saved investigation experience/u)).toBeTruthy();
    expect(screen.getByText(/This choice applies inside Investigations; Overview remains the War Room activity dashboard\./u)).toBeTruthy();
    fireEvent.keyDown(account, { key: "Escape" });
    expect(account.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room");
    expect(screen.getByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Create an investigation" })).toBeNull();
    expect(document.title).toBe("Overview · ContextDesk War Room");
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Investigations" }));
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("Investigation First");
    expect(screen.getByRole("heading", { name: "Create an investigation" })).toBeTruthy();
    expect(document.title).toBe("Investigations · ContextDesk Investigation First");
    expect(window.location.pathname).toBe("/investigations");
    expect(fetchStub.mock.calls.filter(([input]) => String(input) === "/api/cases")).toHaveLength(2);
    expect(fetchStub.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not steal focus when the chooser is dismissed while a preference save is pending", async () => {
    let finishSave: ((response: Response) => void) | null = null;
    const fetchStub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["contributor"], capabilities: ["investigation:read", "investigation:write"] }) };
      if (url === "/api/ui-strategies/effective") return strategyEffective();
      if (url === "/api/ui-strategies/preference" && init?.method === "PUT") {
        return await new Promise<Response>((resolve) => { finishSave = resolve; });
      }
      return runtimeReadResponse(url, []) ?? { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    const account = await screen.findByRole("button", { name: "Signed in as Alice" });
    fireEvent.click(account);
    fireEvent.click(await screen.findByRole("radio", { name: /Investigation First/u }));
    fireEvent.click(screen.getByRole("button", { name: "Use selected experience" }));
    await waitFor(() => expect(finishSave).not.toBeNull());

    const outside = screen.getByRole("button", { name: "Help" });
    fireEvent.mouseDown(outside);
    outside.focus();
    expect(account.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(outside);

    await act(async () => finishSave?.(strategyEffective("investigation-first", 1)));
    await waitFor(() => expect(document.activeElement).toBe(outside));
    expect(account.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a failed preference visible and restores focus while the chooser still owns the interaction", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["contributor"], capabilities: ["investigation:read", "investigation:write"] }) };
      if (url === "/api/ui-strategies/effective") return strategyEffective();
      if (url === "/api/ui-strategies/preference" && init?.method === "PUT") {
        return jsonResponse({ error: "unavailable" }, 503);
      }
      return runtimeReadResponse(url, []) ?? { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    const account = await screen.findByRole("button", { name: "Signed in as Alice" });
    fireEvent.click(account);
    fireEvent.click(await screen.findByRole("radio", { name: /Investigation First/u }));
    fireEvent.click(screen.getByRole("button", { name: "Use selected experience" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/preference was not confirmed/u);
    expect(account.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(account);
  });

  it("keeps a shared browser's server preferences isolated by immutable authenticated identity", async () => {
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
      if (url === "/api/ui-strategies/effective") {
        return strategyEffective(username === "alice" ? "investigation-first" : "war-room", 1);
      }
      const runtime = runtimeReadResponse(url, []);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    });

    window.history.replaceState(null, "", "/investigations");
    vi.stubGlobal("fetch", signedInFetch("alice"));
    const alice = render(<App />);
    expect(await screen.findByRole("heading", { name: "Create an investigation" })).toBeTruthy();
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("Investigation First");
    alice.unmount();
    window.history.replaceState(null, "", "/investigations");

    vi.stubGlobal("fetch", signedInFetch("bob"));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room"));
    expect(screen.queryByRole("heading", { name: "Create an investigation" })).toBeNull();
    expect(window.localStorage.getItem("cd-ui-strategy:alice")).toBe("investigation-first");
    expect(window.localStorage.getItem("cd-ui-strategy:bob")).toBe("war-room");
  });

  it("opens War Room technical tools without replacing the saved personal strategy", async () => {
    const caseId = "00000000-0000-4000-8000-000000000001";
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
    window.history.replaceState(null, "", `/investigations/${caseId}`);
    const focusedInvestigation = investigation(caseId, "Checkout pauses", "open", "high");
    const fetchStub = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["case-lead"], capabilities: ["investigation:read", "investigation:write", "run:strategies"] }) };
      if (url === "/api/ui-strategies/effective") return strategyEffective("investigation-first", 1);
      const runtime = runtimeReadResponse(url, [focusedInvestigation]);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Checkout pauses" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open War Room technical tools" }));
    await waitFor(() => expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room"));
    expect(window.localStorage.getItem("cd-ui-strategy:alice")).toBe("investigation-first");
    expect(window.location.pathname).toBe(`/investigations/${caseId}/analyze`);
    fireEvent.click(screen.getByRole("button", { name: "Signed in as Alice" }));
    expect(screen.getByText(/Temporarily using War Room for this history entry/u)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Investigation First/u }) as HTMLInputElement).checked)
      .toBe(true);
    expect((screen.getByRole("radio", { name: /War Room/u }) as HTMLInputElement).checked)
      .toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Signed in as Alice" }));
    window.history.back();
    await waitFor(() => expect(document.querySelector(".topbar__title-app")?.textContent).toBe("Investigation First"));
    expect(window.location.pathname).toBe(`/investigations/${caseId}/situation`);
    expect(window.localStorage.getItem("cd-ui-strategy:alice")).toBe("investigation-first");
    window.history.forward();
    await waitFor(() => expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room"));
    expect(window.location.pathname).toBe(`/investigations/${caseId}/analyze`);
    expect(window.localStorage.getItem("cd-ui-strategy:alice")).toBe("investigation-first");
  });

  it("restores a technical-tools history override after reload without replacing the saved strategy", async () => {
    const caseId = "00000000-0000-4000-8000-000000000003";
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
    window.history.replaceState(
      { uiStrategyId: "war-room" },
      "",
      `/investigations/${caseId}/analyze`,
    );
    const focusedInvestigation = investigation(caseId, "Reloaded technical review");
    const fetchStub = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["case-lead"], capabilities: ["investigation:read", "run:strategies"] }) };
      if (url === "/api/ui-strategies/effective") return strategyEffective("investigation-first", 1);
      const runtime = runtimeReadResponse(url, [focusedInvestigation]);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    await waitFor(() => expect(fetchStub.mock.calls.some(([input]) => String(input) === "/api/ui-strategies/effective")).toBe(true));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await waitFor(() => expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room"));
    expect(window.location.pathname).toBe(`/investigations/${caseId}/analyze`);
    expect(window.localStorage.getItem("cd-ui-strategy:alice")).toBe("investigation-first");
  });

  it("does not turn a decision-only grant into lifecycle authority", async () => {
    const caseId = "00000000-0000-4000-8000-000000000002";
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
    window.history.replaceState(null, "", `/investigations/${caseId}`);
    const focusedInvestigation = investigation(caseId, "Decision review");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["case-lead"], capabilities: ["investigation:read", "decision:accept"] }) };
      if (url === "/api/ui-strategies/effective") return strategyEffective("investigation-first", 1);
      const runtime = runtimeReadResponse(url, [focusedInvestigation]);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Decision review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    expect(document.querySelector(".lifecycle-panel")).toBeNull();
  });
});
