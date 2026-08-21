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
});
