import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cases } from "./Cases.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("case list and view", () => {
  it("lists cases and opens a timeline view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/cases") {
          return {
            ok: true,
            json: async () => ({
              cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
            }),
          };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        if (url === "/api/cases/c1/imports") {
          return { ok: true, json: async () => ({ runs: [] }) };
        }
        if (url === "/api/cases/c1/experiments") {
          return { ok: true, json: async () => ({ experiments: [] }) };
        }
        if (url === "/api/cases/c1/export/inventory") {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        if (url === "/api/cases/c1/timeline") {
          return {
            ok: true,
            json: async () => ({
              events: [
                {
                  seq: 1,
                  kind: "case_created",
                  actorUsername: "alice",
                  serverTime: "2026-08-15T00:00:00.000Z",
                  payload: "{}",
                },
              ],
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<Cases />);
    const open = await screen.findByRole("button", { name: "Fixture incident" });
    fireEvent.click(open);
    expect(await screen.findByText(/#1 case_created/)).toBeTruthy();
    expect(screen.getByText(/open \/ high/)).toBeTruthy();
  });

  it("does not render case mutation controls in static read-only mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/cases") {
          return {
            ok: true,
            json: async () => ({
              cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
            }),
          };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        if (url === "/api/cases/c1/timeline") {
          return { ok: true, json: async () => ({ events: [] }) };
        }
        if (url === "/api/cases/c1/imports") {
          return {
            ok: true,
            json: async () => ({
              runs: [
                {
                  id: "run-1",
                  outputText: "Synthetic output",
                  corroborationState: "unverified",
                  evidenceVisibility: "unknown",
                  snapshotBinding: null,
                  importerUsername: "demo",
                  operatorUsername: "demo",
                  promptText: null,
                  promptCompleteness: "unknown",
                },
              ],
            }),
          };
        }
        if (url === "/api/cases/c1/experiments") {
          return { ok: true, json: async () => ({ experiments: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<Cases roles={["case-lead"]} readOnly />);
    expect(await screen.findByText("Unverified imported run")).toBeTruthy();
    for (const text of [
      "Create case",
      "Update status",
      "Record human judgment",
      "Import external run",
      "Add to timeline",
      "Case export tools",
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  it("does not offer case creation to a viewer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/cases") {
          return {
            ok: true,
            json: async () => ({
              cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
            }),
          };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        if (url.endsWith("/timeline") || url.endsWith("/imports")) {
          return { ok: true, json: async () => ({ events: [], runs: [] }) };
        }
        if (url.endsWith("/experiments") || url.endsWith("/export/inventory")) {
          return { ok: true, json: async () => ({ experiments: [], items: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    render(<Cases roles={["viewer"]} />);
    await screen.findByRole("button", { name: "Fixture incident" });
    expect(screen.queryByPlaceholderText("New case title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create case" })).toBeNull();
  });

  it("refreshes the import source list after a catalog change", async () => {
    let catalogRefreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/cases") {
          return {
            ok: true,
            json: async () => ({
              cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
            }),
          };
        }
        if (url === "/api/catalog/sources") {
          catalogRefreshes += 1;
          return {
            ok: true,
            json: async () => ({
              sources: catalogRefreshes > 1
                ? [{ id: "s1", name: "New source", kind: "external-tool" }]
                : [],
            }),
          };
        }
        if (url.endsWith("/timeline") || url.endsWith("/imports")) {
          return { ok: true, json: async () => ({ events: [], runs: [] }) };
        }
        if (url.endsWith("/experiments") || url.endsWith("/export/inventory")) {
          return { ok: true, json: async () => ({ experiments: [], items: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    render(<Cases roles={["contributor"]} />);
    await screen.findByRole("button", { name: "Fixture incident" });
    expect(screen.queryByRole("option", { name: /New source/ })).toBeNull();
    window.dispatchEvent(new Event("contextdesk:source-catalog-changed"));
    expect(await screen.findByRole("option", { name: "New source (external-tool)" })).toBeTruthy();
  });

  it("surfaces a bounded error when a case write is denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/cases" && (init?.method ?? "GET") === "POST") {
          return { ok: false, status: 403, json: async () => ({ error: "permission denied" }) };
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

    render(<Cases roles={["contributor"]} />);
    const title = await screen.findByPlaceholderText("New case title");
    fireEvent.change(title, { target: { value: "Denied case" } });
    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Case could not be created. You may not have permission to create cases.",
    );
    expect(screen.queryByText("permission denied")).toBeNull();
  });

  it("filters the loaded case list by title, problem, id, and creator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === "/api/cases") {
          return {
            ok: true,
            json: async () => ({
              cases: [
                {
                  id: "c-title",
                  title: "Payment outage",
                  summary: "Checkout requests are timing out",
                  status: "open",
                  severity: "high",
                  createdByUsername: "alice",
                },
                {
                  id: "c-problem",
                  title: "Search indexing",
                  reportedProblem: "New documents are missing from search",
                  status: "monitoring",
                  severity: "medium",
                  createdBy: "identity-bob",
                },
              ],
            }),
          };
        }
        if (url === "/api/catalog/sources") {
          return { ok: true, json: async () => ({ sources: [] }) };
        }
        if (url.endsWith("/timeline") || url.endsWith("/imports")) {
          return { ok: true, json: async () => ({ events: [], runs: [] }) };
        }
        if (url.endsWith("/experiments") || url.endsWith("/export/inventory")) {
          return { ok: true, json: async () => ({ experiments: [], items: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    render(<Cases />);
    const search = await screen.findByRole("searchbox", {
      name: "Search cases by title, problem, ID, or creator",
    });
    expect(screen.getByRole("button", { name: "Payment outage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search indexing" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "payment" } });
    expect(screen.getByRole("button", { name: "Payment outage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search indexing" })).toBeNull();

    fireEvent.change(search, { target: { value: "checkout requests" } });
    expect(screen.getByRole("button", { name: "Payment outage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search indexing" })).toBeNull();

    fireEvent.change(search, { target: { value: "C-PROBLEM" } });
    expect(screen.getByRole("button", { name: "Search indexing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Payment outage" })).toBeNull();

    fireEvent.change(search, { target: { value: "ALICE" } });
    expect(screen.getByRole("button", { name: "Payment outage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search indexing" })).toBeNull();
  });
  it("reloads imported runs after a delayed import POST", async () => {
    const events = [
      {
        seq: 1,
        kind: "case_created",
        actorUsername: "alice",
        targetId: "case-c1",
        serverTime: "2026-08-15T00:00:00.000Z",
        payload: "{}",
      },
    ];
    let runs: Array<Record<string, unknown>> = [];
    let postedPrivacy: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/cases") {
          return {
            ok: true,
            json: async () => ({
              cases: [{ id: "c1", title: "Fixture incident", status: "open", severity: "high" }],
            }),
          };
        }
        if (url === "/api/catalog/sources") {
          return {
            ok: true,
            json: async () => ({
              sources: [{ id: "s1", name: "Fixture chat assistant", kind: "external-tool" }],
            }),
          };
        }
        if (url === "/api/cases/c1/timeline") {
          return { ok: true, json: async () => ({ events: [...events] }) };
        }
        if (url === "/api/cases/c1/imports" && method === "GET") {
          return { ok: true, json: async () => ({ runs: [...runs] }) };
        }
        if (url === "/api/cases/c1/export/inventory") {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        if (url === "/api/cases/c1/imports" && method === "POST") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          runs = [
            {
              id: "r1",
              outputText: "queue depth is the root cause",
              corroborationState: "unverified",
              evidenceVisibility: "unknown",
              snapshotBinding: null,
              importerUsername: "alice",
              operatorUsername: "alice",
              promptText: null,
              promptCompleteness: "unknown",
            },
          ];
          return { ok: true, json: async () => ({ id: "r1" }) };
        }
        if (url === "/api/cases/c1/contributions" && method === "POST") {
          postedPrivacy = JSON.parse(String(init?.body ?? "{}")).privacyClass;
          await new Promise((resolve) => setTimeout(resolve, 30));
          events.push({
            seq: events.length + 1,
            kind: "contribution_created",
            actorUsername: "alice",
            serverTime: "2026-08-15T00:00:00.000Z",
            payload: '{"kind":"note"}',
          });
          return { ok: true, json: async () => ({ id: "n1" }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<Cases roles={["contributor"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    expect(await screen.findByText(/#1 case_created.*target case-c1/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Timeline entry kind" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Timeline entry body" })).toBeTruthy();
    expect(
      await screen.findByRole("option", { name: "Fixture chat assistant (external-tool)" }),
    ).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Output"), {
      target: { value: "queue depth is the root cause" },
    });
    fireEvent.change(screen.getByPlaceholderText("Operator username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText("Operator identity"), {
      target: { value: "uid=alice" },
    });
    fireEvent.change(document.querySelector('select[name="sourceId"]') as HTMLSelectElement, {
      target: { value: "s1" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I redacted secrets before save/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import external run" }));
    expect(await screen.findByText("Unverified imported run")).toBeTruthy();

    const noteBody = document.querySelector('textarea[name="body"]') as HTMLTextAreaElement;
    fireEvent.change(noteBody, { target: { value: "On-call observation" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline entry visibility" }), {
      target: { value: "share_safe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    expect(await screen.findByText(/#2 contribution_created/)).toBeTruthy();
    expect(postedPrivacy).toBe("share_safe");
  });

});
