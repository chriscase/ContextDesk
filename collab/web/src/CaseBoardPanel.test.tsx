import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseBoardPanel } from "./CaseBoardPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CaseBoardPanel", () => {
  it("renders evidence, immutable snapshot lineage, and separate agreement buckets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) {
          return {
            ok: true,
            json: async () => ({
              artifacts: [
                {
                  id: "artifact-1",
                  kind: "log",
                  filename: "checkout.log",
                  contentHash: "a".repeat(64),
                  verificationStatus: "verified",
                  privacyClass: "owner_only",
                  uploaderId: "alice",
                },
              ],
            }),
          };
        }
        if (url.endsWith("/snapshots")) {
          return {
            ok: true,
            json: async () => ({
              snapshots: [
                {
                  id: "snapshot-1",
                  fingerprint: "b".repeat(64),
                  parentSnapshotId: null,
                  evidence: [{ evidenceId: "artifact-1", ordinal: 0 }],
                  visibility: "owner_only",
                  createdAt: "2026-08-20T00:00:00.000Z",
                  createdBy: "alice",
                },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            snapshotId: "snapshot-1",
            notice: "Agreement is not proof of correctness.",
            findings: [
              {
                id: "known-1",
                bucket: "known",
                statement: "Verified evidence available: checkout.log.",
                evidenceRefs: ["artifact-1"],
                contributionRefs: [],
                agreement: "unknown",
                confidence: "high",
              },
              {
                id: "agreed-1",
                bucket: "agreed",
                statement: "Multiple supported hypotheses reference the same evidence.",
                evidenceRefs: ["artifact-1"],
                contributionRefs: ["h1", "h2"],
                agreement: "shared",
                confidence: "medium",
              },
              {
                id: "concluded-1",
                bucket: "newly_concluded",
                statement: "Treat inventory timeout as the benchmark investigation path.",
                evidenceRefs: ["artifact-1"],
                contributionRefs: [],
                agreement: "unknown",
                confidence: "unknown",
                basis: "accepted_decision",
              },
            ],
          }),
        };
      }),
    );

    render(<CaseBoardPanel caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
    expect(screen.getByText("checkout.log")).toBeTruthy();
    expect(screen.getByText("Snapshot lineage")).toBeTruthy();
    expect(screen.getByText("Multiple supported hypotheses reference the same evidence.")).toBeTruthy();
    expect(screen.getByText(/Agreement is not proof of correctness/)).toBeTruthy();
    expect(screen.getByText("Treat inventory timeout as the benchmark investigation path.")).toBeTruthy();
    expect(screen.getByText("Accepted decision")).toBeTruthy();
    expect(screen.getByText(/No open unknowns recorded/)).toBeTruthy();
    expect(screen.getByText(/agreement shared · confidence medium · 1 evidence ref/)).toBeTruthy();
    expect(screen.queryByText(/schemaId/)).toBeNull();
  });

  it("keeps the empty state useful and read-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return { ok: true, json: async () => ({ artifacts: [] }) };
        if (url.endsWith("/snapshots")) return { ok: true, json: async () => ({ snapshots: [] }) };
        return {
          ok: true,
          json: async () => ({
            snapshotId: null,
            notice: "Agreement is not proof of correctness.",
            findings: [],
          }),
        };
      }),
    );
    render(<CaseBoardPanel caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("No evidence has been registered yet.")).toBeTruthy();
    expect(screen.getByText(/No snapshot frozen yet/)).toBeTruthy();
    expect(screen.queryByText(/Freeze selected evidence/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Upload evidence" })).toBeNull();
    expect(screen.queryByLabelText("File")).toBeNull();
  });

  it("submits the upload contract and refreshes the evidence board", async () => {
    let evidenceLoads = 0;
    let uploadBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/evidence") && init?.method === "POST") {
          uploadBody = JSON.parse(String(init.body));
          return { ok: true, json: async () => ({}) };
        }
        if (url.endsWith("/evidence")) {
          evidenceLoads += 1;
          return {
            ok: true,
            json: async () => ({
              artifacts:
                evidenceLoads > 1
                  ? [
                      {
                        id: "artifact-2",
                        kind: "log",
                        filename: "checkout.log",
                        contentHash: "c".repeat(64),
                        verificationStatus: "verified",
                        privacyClass: "owner_only",
                        uploaderId: "alice",
                      },
                    ]
                  : [],
            }),
          };
        }
        if (url.endsWith("/snapshots")) {
          return { ok: true, json: async () => ({ snapshots: [] }) };
        }
        return {
          ok: true,
          json: async () => ({ snapshotId: null, notice: "", findings: [] }),
        };
      }),
    );

    render(<CaseBoardPanel caseId="case-1" canWrite canLead={false} readOnly={false} />);
    expect(await screen.findByRole("heading", { name: "Upload evidence" })).toBeTruthy();
    expect(screen.queryByText(/Freeze selected evidence/)).toBeNull();

    const fileInput = screen.getByLabelText("File");
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Checkout request log" },
    });
    fireEvent.submit(screen.getByRole("heading", { name: "Upload evidence" }).closest("form")!);

    await waitFor(() => {
      expect(uploadBody).toEqual({
        filename: "checkout.log",
        mediaType: "text/plain",
        contentBase64: "aGVsbG8=",
        kind: "log",
        summary: "Checkout request log",
        privacyClass: "owner_only",
      });
    });
    expect(await screen.findByText("checkout.log")).toBeTruthy();
    expect(evidenceLoads).toBe(2);
  });

  it("uploads a sanitized log and freezes a snapshot in one step", async () => {
    let snapshotBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/evidence") && init?.method === "POST") {
        return { ok: true, json: async () => ({ artifact: { id: "artifact-9" } }) };
      }
      if (url.endsWith("/snapshots") && init?.method === "POST") {
        snapshotBody = JSON.parse(String(init.body));
        return {
          ok: true,
          json: async () => ({
            id: "snapshot-9",
            fingerprint: "d".repeat(64),
            parentSnapshotId: null,
            evidence: [{ evidenceId: "artifact-9", ordinal: 0 }],
            visibility: "share_safe",
            createdAt: "2026-08-20T00:00:00.000Z",
            createdBy: "lead",
          }),
        };
      }
      if (url.endsWith("/evidence")) return { ok: true, json: async () => ({ artifacts: [] }) };
      if (url.endsWith("/snapshots")) return { ok: true, json: async () => ({ snapshots: [] }) };
      return { ok: true, json: async () => ({ snapshotId: null, notice: "", findings: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const frozen = vi.fn();
    window.addEventListener("contextdesk:snapshot-frozen", frozen);
    try {
      render(<CaseBoardPanel caseId="case-1" canWrite canLead readOnly={false} />);
      const uploadHeading = await screen.findByRole("heading", { name: "Upload evidence" });
      const fileInput = screen.getByLabelText("File");
      const file = new File(["sanitized"], "sanitized.log", { type: "text/plain" });
      Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
      fireEvent.change(fileInput);
      fireEvent.change(screen.getByLabelText("Summary"), {
        target: { value: "Sanitized checkout log" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: /Freeze a snapshot with this upload/ }));
      fireEvent.submit(uploadHeading.closest("form")!);

      await waitFor(() => expect(snapshotBody).toEqual({ evidenceIds: ["artifact-9"] }));
      expect(frozen).toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      window.removeEventListener("contextdesk:snapshot-frozen", frozen);
    }
  });

  it("rejects oversized files before reading or posting them", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/evidence")) return { ok: true, json: async () => ({ artifacts: [] }) };
      if (url.endsWith("/snapshots")) return { ok: true, json: async () => ({ snapshots: [] }) };
      return { ok: true, json: async () => ({ snapshotId: null, notice: "", findings: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CaseBoardPanel caseId="case-1" canWrite canLead={false} readOnly={false} />);
    const uploadHeading = await screen.findByRole("heading", { name: "Upload evidence" });
    const fileInput = screen.getByLabelText("File");
    const file = new File([new Uint8Array(1_000_001)], "large.log", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Large file" } });
    fireEvent.submit(uploadHeading.closest("form")!);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Selected file is too large. Files must be 1 MB or smaller.",
    );
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });
});
