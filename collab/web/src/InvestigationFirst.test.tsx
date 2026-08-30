import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationFirst } from "./InvestigationFirst.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseCase = {
  id: "case-1",
  title: "Checkout pauses",
  status: "open",
  severity: "high",
  problemStatement: "Requests pause while the worker restarts.",
  affectedParties: "Checkout operators",
  impact: "Manual replay is required.",
  scope: "One worker group",
  openQuestions: ["Did the queue stall first?"],
  investigationContext: { productName: "ContextDesk", build: "build-42" },
  occurredAt: null,
  occurredAtPrecision: "unknown",
  occurredAtZone: "unknown",
  participants: [],
  createdAt: "2026-08-29T12:00:00.000Z",
  createdBy: "alice",
};

function stubFetch(options?: { cases?: unknown[]; created?: unknown; artifacts?: unknown[] }) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push(init === undefined ? { url } : { url, init });
    if (url === "/api/cases" && (init?.method ?? "GET") === "POST") {
      return { ok: true, json: async () => options?.created ?? { ...baseCase, id: "case-new", title: "New investigation" } };
    }
    if (url === "/api/cases") return { ok: true, json: async () => ({ cases: options?.cases ?? [baseCase] }) };
    if (url.endsWith("/evidence")) return { ok: true, json: async () => ({ artifacts: options?.artifacts ?? [] }) };
    if (url.endsWith("/contributions")) return { ok: true, json: async () => ({ contributions: options?.artifacts ? [{ id: "summary-1", body: "Collected by the import" }] : [] }) };
    if (url === "/api/cases/sparse") return { ok: true, json: async () => ({ id: "sparse", title: "Imported record", status: "open", severity: "low" }) };
    if (url.startsWith("/api/cases/")) return { ok: true, json: async () => baseCase };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return { stub, requests };
}

const commonProps = {
  canWrite: true,
  canLead: true,
  readOnly: false,
  view: "investigations" as const,
  focusCaseId: null,
  stage: "situation" as const,
  onOpenCase: vi.fn(),
  onExitFocus: vi.fn(),
};

describe("Investigation First", () => {
  it("puts fast capture above the browse list and keeps technical fields progressive", async () => {
    stubFetch();
    render(<InvestigationFirst {...commonProps} />);
    expect(await screen.findByRole("heading", { name: "Create an investigation" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Short investigation title")).toBeTruthy();
    expect(screen.getByText("Advanced context")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Investigations" })).toBeTruthy();
    expect(document.querySelector('#investigation-first-productName-options option[value="ContextDesk"]')).toBeTruthy();
  });

  it("posts the shared case payload and opens the server-confirmed record", async () => {
    const { requests } = stubFetch();
    const onOpenCase = vi.fn();
    render(<InvestigationFirst {...commonProps} onOpenCase={onOpenCase} />);
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "New investigation" } });
    fireEvent.change(screen.getByPlaceholderText("Describe the problem without assuming its cause."), { target: { value: "A clear observation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith("case-new"));
    const createRequest = requests.find((request) => request.url === "/api/cases" && request.init?.method === "POST");
    expect(createRequest).toBeTruthy();
    expect(JSON.parse(String(createRequest?.init?.body))).toMatchObject({ title: "New investigation", problemStatement: "A clear observation", severity: "medium" });
  });

  it("renders sparse records honestly and inventories annotated evidence", async () => {
    stubFetch({
      cases: [{ id: "sparse", title: "Imported record", status: "open", severity: "low" }],
      artifacts: [{ id: "e1", kind: "log", filename: "worker.log", contentHash: "abc", verificationStatus: "unverified", privacyClass: "owner_only", byteLength: 12, summaryContributionId: "summary-1" }],
    });
    const onOpenAdvancedTools = vi.fn();
    const { rerender } = render(<InvestigationFirst {...commonProps} onOpenAdvancedTools={onOpenAdvancedTools} />);
    await screen.findByRole("button", { name: /Imported record/ });
    rerender(<InvestigationFirst {...commonProps} focusCaseId="sparse" onOpenAdvancedTools={onOpenAdvancedTools} />);
    expect(await screen.findByRole("heading", { name: "Imported record" })).toBeTruthy();
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(0);
    expect(screen.getByText("worker.log")).toBeTruthy();
    expect(screen.getByText("Collected by the import")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open War Room technical tools" }));
    expect(onOpenAdvancedTools).toHaveBeenCalledWith("sparse", "analyze");
  });

  it("keeps evidence selection safe and sends file annotations through the protected route", async () => {
    const { requests } = stubFetch({
      cases: [{ ...baseCase, id: "case-1" }],
      artifacts: [{ id: "e1", kind: "attachment", filename: "notes.txt", contentHash: null, verificationStatus: "unverified", privacyClass: "owner_only" }],
    });
    render(<InvestigationFirst {...commonProps} focusCaseId="case-1" />);
    expect(await screen.findByRole("heading", { name: "Checkout pauses" })).toBeTruthy();
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect((screen.getByRole("button", { name: "Move selected to trash" }) as HTMLButtonElement).disabled).toBe(true);
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), { target: { value: "Operator notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/evidence") && request.init?.method === "POST")).toBe(true));
    const uploadRequest = requests.find((request) => request.url.endsWith("/evidence") && request.init?.method === "POST");
    expect(JSON.parse(String(uploadRequest?.init?.body))).toMatchObject({ filename: "notes.txt", summary: "Operator notes", kind: "attachment" });
  });

  it("does not expose creation to a viewer", async () => {
    stubFetch({ cases: [] });
    render(<InvestigationFirst {...commonProps} canWrite={false} />);
    await screen.findByRole("heading", { name: "Investigations" });
    expect(screen.queryByRole("heading", { name: "Create an investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create investigation" })).toBeNull();
    expect(screen.getByText("No investigations match this view. Try a different search.")).toBeTruthy();
  });

  it("shows focused loading and unavailable states with a way back", async () => {
    let resolveCase: ((value: unknown) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [] }) };
      if (url === "/api/cases/missing") return new Promise((resolve) => { resolveCase = resolve; });
      if (url.endsWith("/evidence") || url.endsWith("/contributions")) return { ok: true, json: async () => ({ artifacts: [], contributions: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(<InvestigationFirst {...commonProps} focusCaseId="missing" />);
    expect(await screen.findByText("Opening investigation…")).toBeTruthy();
    resolveCase?.({ ok: false, status: 404, json: async () => ({}) });
    expect(await screen.findByText("This investigation could not be found.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to investigations" })).toBeTruthy();
  });

  it("keeps lifecycle mutations unavailable in static read-only mode", async () => {
    stubFetch();
    render(<InvestigationFirst {...commonProps} canLead readOnly focusCaseId="case-1" />);
    expect(await screen.findByRole("heading", { name: "Checkout pauses" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    expect(screen.getByText("Only a case lead can archive or restore this investigation.")).toBeTruthy();
  });

  it("does not describe a failed evidence read as an empty inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [baseCase] }) };
      if (url === "/api/cases/case-1") return { ok: true, json: async () => baseCase };
      if (url.endsWith("/evidence")) return { ok: false, status: 503, json: async () => ({}) };
      if (url.endsWith("/contributions")) return { ok: true, json: async () => ({ contributions: [] }) };
      if (url.endsWith("/lifecycle")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(<InvestigationFirst {...commonProps} focusCaseId="case-1" />);
    expect(await screen.findByRole("heading", { name: "Checkout pauses" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Evidence inventory could not be loaded.");
    expect(screen.queryByText("No evidence has been registered yet.")).toBeNull();
  });

  it("keeps a failed list load honest after detail success and supports retry", async () => {
    let listAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") {
        listAttempts += 1;
        return listAttempts === 1
          ? { ok: false, status: 503, json: async () => ({}) }
          : { ok: true, json: async () => ({ cases: [baseCase] }) };
      }
      if (url === "/api/cases/case-1") return { ok: true, json: async () => baseCase };
      if (url.endsWith("/evidence") || url.endsWith("/contributions")) {
        return { ok: true, json: async () => ({ artifacts: [], contributions: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    const { rerender } = render(<InvestigationFirst {...commonProps} focusCaseId="case-1" />);
    expect(await screen.findByRole("heading", { name: "Checkout pauses" })).toBeTruthy();
    rerender(<InvestigationFirst {...commonProps} focusCaseId={null} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Investigations could not be loaded.");
    expect(screen.queryByText(/No investigations match this view/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading investigations" }));
    expect(await screen.findByRole("button", { name: /Checkout pauses/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a detail response that belongs to an investigation no longer in the URL", async () => {
    let resolveA: ((value: unknown) => void) | undefined;
    let resolveB: ((value: unknown) => void) | undefined;
    const caseA = { ...baseCase, id: "a", title: "Investigation A" };
    const caseB = { ...baseCase, id: "b", title: "Investigation B" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [caseA, caseB] }) };
      if (url === "/api/cases/a") return { ok: true, json: () => new Promise((resolve) => { resolveA = resolve; }) };
      if (url === "/api/cases/b") return { ok: true, json: () => new Promise((resolve) => { resolveB = resolve; }) };
      if (url.endsWith("/evidence") || url.endsWith("/contributions")) return { ok: true, json: async () => ({ artifacts: [], contributions: [] }) };
      if (url.endsWith("/lifecycle")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    const { rerender } = render(<InvestigationFirst {...commonProps} focusCaseId="a" />);
    await waitFor(() => expect(resolveA).toBeTypeOf("function"));
    rerender(<InvestigationFirst {...commonProps} focusCaseId="b" />);
    await waitFor(() => expect(resolveB).toBeTypeOf("function"));
    resolveB?.(caseB);
    expect(await screen.findByRole("heading", { name: "Investigation B" })).toBeTruthy();
    resolveA?.(caseA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("heading", { name: "Investigation B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Investigation A" })).toBeNull();
  });

  it("does not reopen an old investigation when its evidence upload finishes late", async () => {
    let resolveUpload: ((value: unknown) => void) | undefined;
    const caseA = { ...baseCase, id: "a", title: "Investigation A" };
    const caseB = { ...baseCase, id: "b", title: "Investigation B" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases: [caseA, caseB] }) };
      if (url === "/api/cases/a/evidence" && init?.method === "POST") {
        return new Promise((resolve) => { resolveUpload = resolve; });
      }
      if (url === "/api/cases/a") return { ok: true, json: async () => caseA };
      if (url === "/api/cases/b") return { ok: true, json: async () => caseB };
      if (url.endsWith("/evidence") || url.endsWith("/contributions")) return { ok: true, json: async () => ({ artifacts: [], contributions: [] }) };
      if (url.endsWith("/lifecycle")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    const { rerender } = render(<InvestigationFirst {...commonProps} focusCaseId="a" />);
    expect(await screen.findByRole("heading", { name: "Investigation A" })).toBeTruthy();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), { target: { value: "Operator notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(resolveUpload).toBeTypeOf("function"));
    rerender(<InvestigationFirst {...commonProps} focusCaseId="b" />);
    expect(await screen.findByRole("heading", { name: "Investigation B" })).toBeTruthy();
    resolveUpload?.({ ok: true, json: async () => ({}) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("heading", { name: "Investigation B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Investigation A" })).toBeNull();
  });
});
