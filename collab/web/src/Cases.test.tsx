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

  it("reloads imported runs after a delayed import POST", async () => {
    const events = [
      {
        seq: 1,
        kind: "case_created",
        actorUsername: "alice",
        serverTime: "2026-08-15T00:00:00.000Z",
        payload: "{}",
      },
    ];
    let runs: Array<Record<string, unknown>> = [];
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
    expect(await screen.findByText(/#1 case_created/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    expect(await screen.findByText(/#2 contribution_created/)).toBeTruthy();
  });
});
