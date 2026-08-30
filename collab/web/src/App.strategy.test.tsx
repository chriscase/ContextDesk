import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CASE_LIST_SCHEMA_ID,
  CASE_SCHEMA_ID,
  CONTRIBUTION_LIST_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  parseCase,
  type CaseV1,
} from "@cd-collab/contracts";
import { App } from "./App.js";

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
  it("keeps Overview canonical while applying the selected strategy only to Investigations", async () => {
    if (typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem("cd-ui-strategy:alice");
    }
    const fetchStub = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["contributor"], capabilities: ["investigation:read", "investigation:write"] }) };
      const runtime = runtimeReadResponse(url, []);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    expect(await screen.findByText("War Room")).toBeTruthy();
    await waitFor(() => {
      expect(fetchStub.mock.calls.filter(([input]) => String(input) === "/api/cases")).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Investigation First/ }));
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("War Room");
    expect(screen.getByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Create an investigation" })).toBeNull();
    expect(document.title).toBe("ContextDesk War Room");
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Investigations" }));
    expect(document.querySelector(".topbar__title-app")?.textContent).toBe("Investigation First");
    expect(screen.getByRole("heading", { name: "Create an investigation" })).toBeTruthy();
    expect(document.title).toBe("Investigations · ContextDesk Investigation First");
    expect(window.location.pathname).toBe("/investigations");
    expect(fetchStub.mock.calls.filter(([input]) => String(input) === "/api/cases")).toHaveLength(2);
    expect(fetchStub.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["case-lead"], capabilities: ["investigation:read", "investigation:write", "run:strategies"] }) };
      const runtime = runtimeReadResponse(url, [focusedInvestigation]);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    }));

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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return { ok: false, status: 404, json: async () => ({}) };
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ identity: { username: "alice", displayName: "Alice" }, roles: ["case-lead"], capabilities: ["investigation:read", "run:strategies"] }) };
      const runtime = runtimeReadResponse(url, [focusedInvestigation]);
      if (runtime) return runtime;
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(<App />);
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
