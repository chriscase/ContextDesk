import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "./ExportPanel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("export panel", () => {
  it("exports a brief and shows a privacy-scan report", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                kind: "artifact",
                id: "a1",
                label: "app.log",
                privacyClass: "owner_only",
                contentHash: "h",
                excludedByDefault: false,
              },
            ],
          }),
        };
      }
      if (url === "/api/cases/c1/export/brief") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { variant?: string };
        if (body.variant === "share_safe") {
          return {
            ok: false,
            json: async () => ({
              error: "privacy_scan_failed",
              findings: [{ rule: "credential", path: "$.actions[0].body", excerpt: "aws_access_key: AKIA" }],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            markdown: "# Triage brief\n",
            payload: {},
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    expect(await screen.findByText(/app.log/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    expect(await screen.findByText(/# Triage brief/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("owner_only"), { target: { value: "share_safe" } });
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    expect(await screen.findByText(/privacy_scan_failed/)).toBeTruthy();
    expect(screen.getByText(/credential · \$\.actions\[0\]\.body · \[redacted\]/)).toBeTruthy();
    expect(screen.queryByText(/aws_access_key: AKIA/)).toBeNull();
  });
});
