import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LOST_EVENT } from "./protected-api.js";
import { CaseBoardPanel } from "./CaseBoardPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PANEL_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "CaseBoardPanel.tsx"),
  "utf8",
);

class UploadXHR {
  static pending: UploadXHR[] = [];
  status = 0;
  statusText = "";
  responseText = "";
  responseURL = "";
  withCredentials = false;
  method = "";
  url = "";
  body: unknown;
  aborted = false;
  sent = false;
  abortCalls = 0;
  requestHeaders: Record<string, string> = {};
  responseHeaders = "content-type: application/json";
  listeners = new Map<string, EventListener[]>();
  uploadListeners = new Map<string, EventListener[]>();
  upload = {
    addEventListener: (type: string, listener: EventListener) => {
      const list = this.uploadListeners.get(type) ?? [];
      list.push(listener);
      this.uploadListeners.set(type, list);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      const list = this.uploadListeners.get(type) ?? [];
      this.uploadListeners.set(type, list.filter((candidate) => candidate !== listener));
    },
  };

  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((candidate) => candidate !== listener));
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  abort(): void {
    this.abortCalls += 1;
    this.aborted = true;
    this.emit("abort");
  }

  send(body?: unknown): void {
    this.sent = true;
    this.body = body;
    UploadXHR.pending.push(this);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, new Event(type));
    }
  }

  emitProgress(loaded: number, total: number | null): void {
    const event = {
      loaded,
      total: total ?? 0,
      lengthComputable: total !== null,
    } as ProgressEvent;
    for (const listener of this.uploadListeners.get("progress") ?? []) {
      (listener as (event: ProgressEvent) => void).call(this.upload, event);
    }
  }

  complete(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.responseURL = this.url;
    this.emit("load");
  }

  failNetwork(): void {
    this.emit("error");
  }
}

function stubUploadXhr(): typeof UploadXHR {
  UploadXHR.pending = [];
  vi.stubGlobal("XMLHttpRequest", UploadXHR);
  return UploadXHR;
}

function formOrder(body: FormData): string[] {
  return [...body.keys()];
}

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function uploadArtifact(artifactId: string, caseId = "case-1", overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.artifact.v1",
    id: artifactId,
    caseId,
    kind: "log",
    filename: "checkout.log",
    uri: null,
    mediaType: "text/plain",
    byteLength: 5,
    contentHash: "sha256:observed",
    expectedHash: null,
    verificationStatus: "verified",
    privacyClass: "owner_only",
    summaryContributionId: `summary-${artifactId}`,
    uploaderId: "alice",
    sourceId: "source-1",
    ...overrides,
  };
}

function uploadSummaryRecord(artifactId: string, caseId = "case-1", overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.contribution.v1",
    id: `summary-${artifactId}`,
    caseId,
    kind: "upload",
    revision: 1,
    predecessorRevision: null,
    body: "Uploaded checkout.log",
    contentHash: "sha256:summary",
    privacyClass: "owner_only",
    tombstoned: false,
    authorId: "alice",
    authorUsername: "alice",
    createdAt: "2026-08-29T12:00:00.000Z",
    hypothesisStatus: null,
    hypothesisLinks: null,
    sourceId: "source-1",
    ...overrides,
  };
}

function uploadSuccessBody(artifactId: string, caseId = "case-1"): string {
  return JSON.stringify({
    schemaId: "cd-collab.evidence_upload_success.v1",
    caseId,
    artifact: uploadArtifact(artifactId, caseId),
    summary: uploadSummaryRecord(artifactId, caseId),
  });
}

function encodeBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function streamBody(
  bytes: Uint8Array,
  cancelled?: { value: boolean },
  leaveOpen = false,
  cancellationNeverSettles = false,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      if (!leaveOpen) controller.close();
    },
    cancel() {
      if (cancelled) cancelled.value = true;
      if (cancellationNeverSettles) return new Promise<void>(() => undefined);
    },
  });
}

function previewResponse(options: {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  cancelled?: { value: boolean };
  leaveOpen?: boolean;
  cancellationNeverSettles?: boolean;
}) {
  const bytes = typeof options.body === "string" || options.body === undefined
    ? encodeBytes(options.body ?? "")
    : options.body;
  return {
    ok: options.status >= 200 && options.status < 300,
    status: options.status,
    headers: new Headers(options.headers),
    body: streamBody(
      bytes,
      options.cancelled,
      options.leaveOpen,
      options.cancellationNeverSettles,
    ),
  };
}

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").toString().toUpperCase();
}

describe("CaseBoardPanel", () => {
  it("renders evidence, immutable snapshot lineage, and separate agreement buckets", async () => {
    const directoryIdentity = "uid=alice,ou=people,dc=example,dc=test";
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
                  uploaderId: directoryIdentity,
                  byteLength: 12,
                  mediaType: "text/plain",
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
                  createdBy: directoryIdentity,
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

    render(
      <CaseBoardPanel canReadPrivate
        caseId="case-1"
        canWrite={false}
        canLead={false}
        readOnly
        participants={[{ identityId: directoryIdentity, username: "alice" }]}
        routeFocus={{
          section: "triage-evidence-board",
          item: "artifact-1",
          itemKind: "evidence",
          lane: null,
          experiment: null,
        }}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
    expect(screen.getByText("checkout.log")).toBeTruthy();
    expect(screen.getByText("Kind: log")).toBeTruthy();
    expect(screen.getByText(/uploaded by alice/)).toBeTruthy();
    expect(screen.getByText(/frozen by alice/)).toBeTruthy();
    expect(screen.queryByText(/uid=alice/)).toBeNull();
    expect(screen.getByText("Snapshot lineage")).toBeTruthy();
    expect(screen.getByText("Multiple supported hypotheses reference the same evidence.")).toBeTruthy();
    expect(screen.getByText(/Agreement is not proof of correctness/)).toBeTruthy();
    expect(screen.getByText("Treat inventory timeout as the benchmark investigation path.")).toBeTruthy();
    expect(screen.getByText("Accepted decision")).toBeTruthy();
    expect(screen.getByText(/No open unknowns recorded/)).toBeTruthy();
    expect(screen.getByText(/agreement shared · confidence medium · 1 evidence ref/)).toBeTruthy();
    expect(screen.queryByText(/schemaId/)).toBeNull();
    const evidence = screen.getByText("checkout.log").closest("li") as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(evidence));
    expect(evidence.dataset.routeKind).toBe("evidence");
    expect(screen.getByRole("button", { name: "Download checkout.log" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect log" })).toBeTruthy();
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
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("No evidence has been registered yet.")).toBeTruthy();
    expect(screen.getByText(/No snapshot frozen yet/)).toBeTruthy();
    expect(screen.queryByText(/Freeze selected evidence/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Upload evidence" })).toBeNull();
    expect(screen.queryByLabelText("File")).toBeNull();
  });

  it("filters and bulk-selects a realistic evidence list for one snapshot", { timeout: 15_000 }, async () => {
    let snapshotBody: unknown;
    const artifacts = Array.from({ length: 80 }, (_, index) => ({
      id: `artifact-${index}`,
      kind: index < 5 ? "log" : "attachment",
      filename: index < 5 ? `service-${index}.log` : `note-${index}.txt`,
      relativePath: index < 5 ? `node-a/service-${index}.log` : `notes/note-${index}.txt`,
      contentHash: "a".repeat(64),
      verificationStatus: "verified",
      privacyClass: "owner_only",
      uploaderId: "lead",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return { ok: true, json: async () => ({ artifacts }) };
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          snapshotBody = JSON.parse(String(init.body));
          return {
            ok: true,
            json: async () => ({
              id: "snapshot-bulk",
              fingerprint: "b".repeat(64),
              parentSnapshotId: null,
              evidence: [],
              visibility: "owner_only",
              createdAt: "2026-08-20T00:00:00.000Z",
              createdBy: "lead",
            }),
          };
        }
        if (url.endsWith("/snapshots")) return { ok: true, json: async () => ({ snapshots: [] }) };
        return { ok: true, json: async () => ({ snapshotId: null, notice: "", findings: [] }) };
      }),
    );

    const { rerender } = render(
      <CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />,
    );
    expect(await screen.findByText("80 matching · showing 25 · 0 selected")).toBeTruthy();
    expect(screen.queryByText("note-49.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more matching" }));
    expect(screen.getByText("note-49.txt")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter evidence"), { target: { value: "node-a" } });
    expect(screen.getByText("5 matching · showing 5 · 0 selected")).toBeTruthy();
    expect(screen.queryByText("note-12.txt")).toBeNull();
    rerender(
      <CaseBoardPanel canReadPrivate
        caseId="case-1"
        canWrite
        canLead
        readOnly={false}
        routeFocus={{
          section: "triage-evidence-board",
          item: "artifact-79",
          itemKind: "evidence",
          lane: null,
          experiment: null,
        }}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Filter evidence") as HTMLInputElement).value).toBe(""),
    );
    const routedEvidence = screen.getByText("note-79.txt").closest("li") as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(routedEvidence));
    fireEvent.change(screen.getByLabelText("Filter evidence"), { target: { value: "node-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Select all matching" }));
    expect(screen.getByText("5 matching · showing 5 · 5 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Freeze selected evidence (5)" }));

    await waitFor(() =>
      expect(snapshotBody).toEqual({
        evidenceIds: ["artifact-0", "artifact-1", "artifact-2", "artifact-3", "artifact-4"],
      }),
    );
  });

  it("offers a direct handoff to timestamp review and keeps freeze inactive without a selection", async () => {
    const openCapture = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) {
          return {
            ok: true,
            json: async () => ({
              artifacts: [{
                id: "artifact-1",
                kind: "log",
                filename: "worker.log",
                contentHash: "a".repeat(64),
                verificationStatus: "verified",
                privacyClass: "owner_only",
                uploaderId: "lead",
              }],
            }),
          };
        }
        if (url.endsWith("/snapshots")) return { ok: true, json: async () => ({ snapshots: [] }) };
        return { ok: true, json: async () => ({ snapshotId: null, notice: "", findings: [] }) };
      }),
    );

    render(
      <CaseBoardPanel canReadPrivate
        caseId="case-1"
        canWrite
        canLead
        readOnly={false}
        onOpenCapture={openCapture}
      />,
    );

    expect(await screen.findByRole("button", { name: "Review timestamps in Capture" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review timestamps in Capture" }));
    expect(openCapture).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Freeze selected evidence (0)" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("collapses long finding buckets instead of flooding the case board", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return { ok: true, json: async () => ({ artifacts: [] }) };
        if (url.endsWith("/snapshots")) return { ok: true, json: async () => ({ snapshots: [] }) };
        return {
          ok: true,
          json: async () => ({
            snapshotId: "snapshot-large",
            notice: "",
            findings: Array.from({ length: 20 }, (_, index) => ({
              id: `finding-${index + 1}`,
              bucket: "known",
              statement: `Recorded evidence item ${index + 1}`,
              evidenceRefs: [`artifact-${index + 1}`],
              contributionRefs: [],
              agreement: "unknown",
              confidence: "high",
            })),
          }),
        };
      }),
    );

    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("Recorded evidence item 12")).toBeTruthy();
    const more = screen.getByText("Show 8 more known items").closest("details") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("Recorded evidence item 13");
    fireEvent.click(screen.getByText("Show 8 more known items"));
    expect(more.open).toBe(true);
    expect(screen.getByText("Recorded evidence item 20")).toBeTruthy();
  });

  it("posts ordered native FormData to the stream endpoint and refreshes the evidence board", async () => {
    stubUploadXhr();
    let evidenceLoads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
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
      if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
      if (init?.method === "POST") {
        throw new Error(`unexpected fetch POST ${url}`);
      }
      return jsonOk({ snapshotId: null, notice: "", findings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CaseBoardPanel
        caseId="case-1"
        canWrite
        canLead={false}
        canReadPrivate={false}
        readOnly={false}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Upload evidence" })).toBeTruthy();
    expect(screen.queryByText(/Freeze selected evidence/)).toBeNull();
    const privacySelect = screen.getByLabelText("Privacy class") as HTMLSelectElement;
    expect(privacySelect.value).toBe("share_safe");
    expect([...privacySelect.options].map((option) => option.value)).toEqual(["share_safe"]);
    expect(screen.getByText(/Share-safe is required/)).toBeTruthy();

    const fileInput = screen.getByLabelText("File");
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Checkout request log" },
    });
    fireEvent.submit(screen.getByRole("heading", { name: "Upload evidence" }).closest("form")!);

    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    const xhr = UploadXHR.pending[0]!;
    expect(xhr.url).toBe(new URL("/api/cases/case-1/evidence/stream", window.location.href).href);
    expect(xhr.method).toBe("POST");
    expect(xhr.body).toBeInstanceOf(FormData);
    const data = xhr.body as FormData;
    expect(formOrder(data)).toEqual(["kind", "summary", "privacyClass", "file"]);
    expect(data.get("kind")).toBe("log");
    expect(data.get("summary")).toBe("Checkout request log");
    expect(data.get("privacyClass")).toBe("share_safe");
    expect(data.get("filename")).toBeNull();
    expect(data.get("mediaType")).toBeNull();
    const uploaded = data.get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe("checkout.log");
    expect((uploaded as File).type).toBe("text/plain");
    xhr.complete(200, uploadSuccessBody("artifact-2"));

    expect(await screen.findByText("checkout.log")).toBeTruthy();
    expect(screen.getByText(/Private evidence bytes require additional permission/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download checkout.log" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inspect log" })).toBeNull();
    expect(evidenceLoads).toBe(2);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it("resets privacy choices and private-byte controls when capability changes", async () => {
    const artifact = {
      id: "private-artifact",
      kind: "log",
      filename: "private.log",
      contentHash: "a".repeat(64),
      verificationStatus: "verified",
      privacyClass: "owner_only",
      uploaderId: "alice",
      mediaType: "text/plain",
      byteLength: 12,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [artifact] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    const { rerender } = render(
      <CaseBoardPanel
        caseId="case-1"
        canWrite
        canLead={false}
        canReadPrivate={false}
        readOnly={false}
      />,
    );
    expect(await screen.findByText("private.log")).toBeTruthy();
    let privacySelect = screen.getByLabelText("Privacy class") as HTMLSelectElement;
    expect(privacySelect.value).toBe("share_safe");
    expect([...privacySelect.options].map((option) => option.value)).toEqual(["share_safe"]);
    expect(screen.queryByRole("button", { name: "Download private.log" })).toBeNull();

    rerender(
      <CaseBoardPanel
        caseId="case-1"
        canWrite
        canLead={false}
        canReadPrivate
        readOnly={false}
      />,
    );
    expect(await screen.findByRole("button", { name: "Download private.log" })).toBeTruthy();
    privacySelect = screen.getByLabelText("Privacy class") as HTMLSelectElement;
    expect(privacySelect.value).toBe("owner_only");
    expect([...privacySelect.options].map((option) => option.value)).toEqual([
      "owner_only",
      "share_safe",
    ]);

    rerender(
      <CaseBoardPanel
        caseId="case-1"
        canWrite
        canLead={false}
        canReadPrivate={false}
        readOnly={false}
      />,
    );
    await waitFor(() => {
      privacySelect = screen.getByLabelText("Privacy class") as HTMLSelectElement;
      expect(privacySelect.value).toBe("share_safe");
      expect([...privacySelect.options].map((option) => option.value)).toEqual(["share_safe"]);
    });
    expect(screen.queryByRole("button", { name: "Download private.log" })).toBeNull();
  });

  it("uploads a sanitized log and freezes a snapshot in one step", async () => {
    stubUploadXhr();
    let snapshotBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
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
      if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
      if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
      return jsonOk({ snapshotId: null, notice: "", findings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const frozen = vi.fn();
    window.addEventListener("contextdesk:snapshot-frozen", frozen);
    try {
      render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />);
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

      await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
      const xhr = UploadXHR.pending[0]!;
      expect(xhr.body).toBeInstanceOf(FormData);
      const data = xhr.body as FormData;
      expect(formOrder(data)).toEqual(["kind", "summary", "privacyClass", "file"]);
      expect(data.get("kind")).toBe("log");
      expect(data.get("summary")).toBe("Sanitized checkout log");
      expect(data.get("privacyClass")).toBe("owner_only");
      expect(data.get("filename")).toBeNull();
      expect(data.get("mediaType")).toBeNull();
      expect(data.get("freezeAfterUpload")).toBeNull();
      expect(xhr.requestHeaders["content-type"]).toBeUndefined();
      expect(xhr.requestHeaders["Content-Type"]).toBeUndefined();
      const files = data.getAll("file");
      expect(files).toHaveLength(1);
      expect(files[0]).toBeInstanceOf(File);
      expect((files[0] as File).constructor).toBe(File);
      expect((files[0] as File).name).toBe("sanitized.log");
      expect((files[0] as File).type).toBe("text/plain");
      xhr.complete(200, uploadSuccessBody("artifact-9"));
      await waitFor(() => expect(snapshotBody).toEqual({ evidenceIds: ["artifact-9"] }));
      expect(frozen).toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      window.removeEventListener("contextdesk:snapshot-frozen", frozen);
    }
  });

  it("maps a server 413 without a client 1 MB buffer and keeps the selected file", async () => {
    stubUploadXhr();
    const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
      if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
      return jsonOk({ snapshotId: null, notice: "", findings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />);
    const uploadHeading = await screen.findByRole("heading", { name: "Upload evidence" });
    const fileInput = screen.getByLabelText("File");
    const file = new File([new Uint8Array(1_000_001)], "large.log", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Large file" } });
    fireEvent.submit(uploadHeading.closest("form")!);

    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    expect((UploadXHR.pending[0]?.body as FormData).get("file")).toBeInstanceOf(File);
    UploadXHR.pending[0]?.complete(413, JSON.stringify({ error: "upload exceeds size cap" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This file is larger than the server allows.",
    );
    expect(screen.getByText("Selected: large.log")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeTruthy();
  });
});

describe("evidence card identifiers", () => {
  const HASH = "a".repeat(64);

  function stub() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) {
          return {
            ok: true,
            json: async () => ({
              artifacts: [{
                id: "artifact-1",
                kind: "log",
                filename: "checkout.log",
                contentHash: HASH,
                verificationStatus: "verified",
                privacyClass: "share_safe",
                uploaderId: "alice",
              }],
            }),
          };
        }
        if (url.endsWith("/snapshots")) {
          return {
            ok: true,
            json: async () => ({
              snapshots: [{
                id: "snapshot-1",
                fingerprint: "b".repeat(64),
                parentSnapshotId: null,
                evidence: [{ evidenceId: "artifact-1", ordinal: 0 }],
                visibility: "share_safe",
                createdAt: "2026-08-20T00:00:00.000Z",
                createdBy: "alice",
              }],
            }),
          };
        }
        return { ok: true, json: async () => ({ snapshotId: "snapshot-1", notice: "", findings: [] }) };
      }),
    );
  }

  it("does not lead the card with a truncated digest", async () => {
    stub();
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("checkout.log")).toBeTruthy();
    expect(screen.getByText("share_safe")).toBeTruthy();
    expect(screen.queryByText(/hash [0-9a-f]{12}…/)).toBeNull();
    expect(screen.queryByText(`${HASH.slice(0, 12)}…`)).toBeNull();
    expect(screen.queryByText(`${"b".repeat(12)}…`)).toBeNull();
  });

  it("keeps the exact digest available, in full, one disclosure away", async () => {
    stub();
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("checkout.log")).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy content hash for checkout.log" })).toBeTruthy();
  });
});

describe("streamed evidence workflow", () => {
  it("does not buffer uploads as base64 or own XMLHttpRequest", () => {
    expect(PANEL_SOURCE).not.toMatch(/\bFileReader\b/);
    expect(PANEL_SOURCE).not.toMatch(/readAsDataURL/);
    expect(PANEL_SOURCE).not.toMatch(/contentBase64/);
    expect(PANEL_SOURCE).not.toMatch(/\bXMLHttpRequest\b/);
    expect(PANEL_SOURCE).not.toMatch(/s3\.amazonaws|X-Amz-|presigned|createObjectURL|revokeObjectURL|new Blob\b/i);
    expect(PANEL_SOURCE).toMatch(/evidence\/stream/);
    expect(PANEL_SOURCE).toMatch(/Range: PREVIEW_RANGE/);
    expect(PANEL_SOURCE).toMatch(/bytes=0-\$\{PREVIEW_LIMIT_BYTES - 1\}/);
    expect(PANEL_SOURCE).toMatch(/PREVIEW_LIMIT_BYTES = 65_536/);
    expect(PANEL_SOURCE).toContain(
      'import { parseEvidenceUploadSuccess } from "@cd-collab/contracts/investigation-runtime";',
    );
    expect(PANEL_SOURCE).not.toMatch(
      /import\s*\{[^}]*\bparseEvidenceUploadSuccess\b[^}]*\}\s*from\s*"@cd-collab\/contracts"/,
    );
    expect(PANEL_SOURCE).not.toMatch(/from "@cd-collab\/contracts";/);
    expect(PANEL_SOURCE).not.toMatch(/arrayBuffer/);
    expect(PANEL_SOURCE).not.toMatch(/status === 503 && code === "commit_outcome_unknown"/);
  });

  it("shows determinate progress, cancel, retained retry state, and auth loss", async () => {
    stubUploadXhr();
    const seen: number[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ status: number }>).detail.status);
    };
    window.addEventListener(AUTH_LOST_EVENT, listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );

    try {
      render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />);
      const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
      const file = new File(["hello"], "checkout.log", { type: "text/plain" });
      const fileInput = screen.getByLabelText("File");
      Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
      fireEvent.change(fileInput);
      fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
      fireEvent.submit(form);

      await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull();
      UploadXHR.pending[0]?.emitProgress(2, 5);
      expect(await screen.findByText(/Uploading checkout\.log — 40%/)).toBeTruthy();
      expect(screen.getByRole("progressbar")).toHaveProperty("value", 2);
      UploadXHR.pending[0]?.emitProgress(4, null);
      await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
      expect(screen.getByText(/Uploading checkout\.log/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(await screen.findByText("Upload cancelled.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry upload" })).toBeTruthy();
      expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Checkout request log");
      expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry upload" })),
      );
      expect(screen.queryByRole("progressbar")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
      await waitFor(() => expect(UploadXHR.pending.length).toBe(2));
      expect(formOrder(UploadXHR.pending[1]!.body as FormData)).toEqual([
        "kind",
        "summary",
        "privacyClass",
        "file",
      ]);
      UploadXHR.pending[1]?.complete(403, JSON.stringify({ error: "forbidden" }));
      expect((await screen.findByRole("alert")).textContent).toBe("You are not allowed to upload evidence.");
      expect(seen).toEqual([403]);
      expect(UploadXHR.pending).toHaveLength(2);
    } finally {
      window.removeEventListener(AUTH_LOST_EVENT, listener);
    }
  });

  it("maps empty validation, privacy-safe 404, unknown commit, and network failure truthfully", async () => {
    stubUploadXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["x"], "notes.log", { type: "text/plain" });
    const fileInput = screen.getByLabelText("File");
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Notes" } });

    const outcomes = [
      { status: 400, body: { error: "kind and summary are required" }, message: /rejected this upload/ },
      { status: 404, body: { error: "not_found" }, message: "This investigation is not available." },
      {
        status: 503,
        body: { error: "commit_outcome_unknown" },
        message: /upload outcome is unknown/i,
      },
    ] as const;

    for (const outcome of outcomes) {
      fireEvent.submit(form);
      await waitFor(() => expect(UploadXHR.pending.length).toBeGreaterThan(0));
      const xhr = UploadXHR.pending.at(-1)!;
      xhr.complete(outcome.status, JSON.stringify(outcome.body));
      expect((await screen.findByRole("alert")).textContent).toMatch(outcome.message);
    }

    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.at(-1)?.sent).toBe(true));
    UploadXHR.pending.at(-1)?.failNetwork();
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not reach the server/i);
  });
});

describe("bounded evidence preview and download", () => {
  function boardWith(artifacts: unknown[], fetchImpl?: (url: string, init?: RequestInit) => unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const custom = fetchImpl?.(url, init);
        if (custom) return custom;
        if (url.endsWith("/evidence")) return jsonOk({ artifacts });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
  }

  it("previews text through a 64 KiB Range request and Inspect log alias", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("error boom\nstack\n");
    const contentInits: RequestInit[] = [];
    boardWith(
      [{
        id: "artifact-1",
        kind: "log",
        filename: "checkout.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 400_000,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        contentInits.push(init ?? {});
        return previewResponse({
          status: 206,
          headers: {
            "content-length": String(bytes.byteLength),
            "content-type": "text/plain",
            "content-range": `bytes 0-${bytes.byteLength - 1}/400000`,
            etag: '"etag-1"',
          },
          body: bytes,
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("checkout.log")).toBeTruthy();
    expect(screen.getByText("text/plain")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("error boom")).toBeTruthy();
    expect(screen.getByText("Showing the first 64 KiB of this file.")).toBeTruthy();
    expect(contentInits).toHaveLength(1);
    expect(contentInits[0]?.headers).toMatchObject({ Range: "bytes=0-65535" });
  });

  it("handles 200, 404, 416, and 503 preview outcomes", async () => {
    const encoder = new TextEncoder();
    const textBytes = encoder.encode("ok-body");
    const cancelled = {
      missing: { value: false },
      range: { value: false },
      unavailable: { value: false },
    };
    const artifacts = [
      {
        id: "ok",
        kind: "log",
        filename: "ok.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "share_safe",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 7,
      },
      {
        id: "missing",
        kind: "log",
        filename: "missing.log",
        contentHash: "b".repeat(64),
        verificationStatus: "verified",
        privacyClass: "share_safe",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 12,
      },
      {
        id: "range",
        kind: "log",
        filename: "range.log",
        contentHash: "c".repeat(64),
        verificationStatus: "verified",
        privacyClass: "share_safe",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 0,
      },
      {
        id: "down",
        kind: "log",
        filename: "down.log",
        contentHash: "d".repeat(64),
        verificationStatus: "verified",
        privacyClass: "share_safe",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 12,
      },
    ];
    boardWith(artifacts, (url, init) => {
      if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
      if (url.includes("/ok/")) {
        return previewResponse({
          status: 200,
          headers: { "content-length": "7", "content-type": "text/plain" },
          body: textBytes,
        });
      }
      if (url.includes("/missing/")) {
        return previewResponse({
          status: 404,
          body: "",
          cancelled: cancelled.missing,
          leaveOpen: true,
        });
      }
      if (url.includes("/range/")) {
        return previewResponse({
          status: 416,
          body: "",
          cancelled: cancelled.range,
          leaveOpen: true,
        });
      }
      return previewResponse({
        status: 503,
        body: JSON.stringify({ error: "storage_unavailable" }),
        cancelled: cancelled.unavailable,
        leaveOpen: true,
        cancellationNeverSettles: true,
      });
    });
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("ok.log")).toBeTruthy();
    fireEvent.click(within(screen.getByText("ok.log").closest("li")!).getByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("ok-body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide log" }));
    fireEvent.click(within(screen.getByText("missing.log").closest("li")!).getByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("This evidence is not available.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide log" }));
    fireEvent.click(within(screen.getByText("range.log").closest("li")!).getByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("A bounded preview is not available for this evidence.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide log" }));
    fireEvent.click(within(screen.getByText("down.log").closest("li")!).getByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText(/storage is temporarily unavailable/)).toBeTruthy();
    expect(cancelled.missing.value).toBe(true);
    expect(cancelled.range.value).toBe(true);
    expect(cancelled.unavailable.value).toBe(true);
  });

  it("rejects a 206 preview whose Content-Range does not start at zero", async () => {
    const cancelled = { value: false };
    boardWith(
      [{
        id: "shifted",
        kind: "log",
        filename: "shifted.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "share_safe",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 10,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({
          status: 206,
          headers: { "content-range": "bytes 1-4/10" },
          body: "EVIL",
          cancelled,
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("A bounded preview is not available for this evidence.")).toBeTruthy();
    expect(cancelled.value).toBe(true);
    expect(screen.queryByText("EVIL")).toBeNull();
  });

  it("does not read a body whose Content-Length exceeds 64 KiB", async () => {
    const cancelled = { value: false };
    let readerOpened = false;
    boardWith(
      [{
        id: "huge",
        kind: "log",
        filename: "huge.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 300_000,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "65537", "content-type": "text/plain" }),
          body: {
            getReader() {
              readerOpened = true;
              throw new Error("must not read an oversize preview body");
            },
            async cancel() {
              cancelled.value = true;
            },
          },
        };
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText(/more than the 64 KiB limit/)).toBeTruthy();
    expect(readerOpened).toBe(false);
    expect(cancelled.value).toBe(true);
  });

  it("truncates a Content-Length-free overflow stream at 64 KiB and cancels the reader", async () => {
    const cancelled = { value: false };
    let pulls = 0;
    const first = encodeBytes("A".repeat(32_768));
    const second = encodeBytes("B".repeat(40_960));
    boardWith(
      [{
        id: "overflow",
        kind: "log",
        filename: "overflow.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 73_728,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
          body: {
            getReader() {
              return {
                async read() {
                  pulls += 1;
                  if (pulls === 1) return { done: false, value: first };
                  if (pulls === 2) return { done: false, value: second };
                  throw new Error("must not read past the 64 KiB overflow cancel");
                },
                async cancel() {
                  cancelled.value = true;
                },
                releaseLock() {},
              };
            },
          },
        };
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("Showing the first 64 KiB of this file.")).toBeTruthy();
    expect(screen.getByText(new RegExp(`${(65_536).toLocaleString()} characters`))).toBeTruthy();
    expect(cancelled.value).toBe(true);
    expect(pulls).toBe(2);
    const retained = "A".repeat(32_768) + "B".repeat(32_768);
    expect(screen.getByLabelText("Log overflow.log").textContent).toContain(retained);
    expect(screen.getByLabelText("Log overflow.log").textContent).not.toContain("B".repeat(32_769));
  });

  it("retains at most 64 KiB from one giant first stream chunk", async () => {
    const cancelled = { value: false };
    const giant = new Uint8Array(2 * 1024 * 1024).fill(0x42);
    giant.fill(0x41, 0, 65_536);
    boardWith(
      [{
        id: "giant",
        kind: "log",
        filename: "giant.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "share_safe",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: giant.byteLength,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({ status: 200, body: giant, cancelled, leaveOpen: true });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("Showing the first 64 KiB of this file.")).toBeTruthy();
    const preview = screen.getByLabelText("Log giant.log");
    expect(preview.textContent).toContain("A".repeat(128));
    expect(preview.textContent).not.toContain("B".repeat(128));
    expect(cancelled.value).toBe(true);
    expect(PANEL_SOURCE).toContain("new Uint8Array(PREVIEW_LIMIT_BYTES)");
    expect(PANEL_SOURCE).not.toContain("chunks.push(value.subarray");
  });

  it("explains binary and metadata-only artifacts instead of decoding them", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/evidence")) {
        return jsonOk({
          artifacts: [
            {
              id: "bin",
              kind: "attachment",
              filename: "core.bin",
              contentHash: "a".repeat(64),
              verificationStatus: "verified",
              privacyClass: "owner_only",
              uploaderId: "alice",
              mediaType: "application/octet-stream",
              byteLength: 2048,
            },
            {
              id: "ref",
              kind: "file_server_ref",
              filename: "remote-core",
              contentHash: null,
              verificationStatus: null,
              privacyClass: "owner_only",
              uploaderId: "alice",
            },
          ],
        });
      }
      if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
      if (url.endsWith("/content")) throw new Error("preview must not fetch binary or metadata-only bytes");
      return jsonOk({ snapshotId: null, notice: "", findings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("core.bin")).toBeTruthy();
    fireEvent.click(within(screen.getByText("core.bin").closest("li")!).getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Preview is unavailable for this file type/)).toBeTruthy();
    fireEvent.click(within(screen.getByText("remote-core").closest("li")!).getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Bytes are not stored for this artifact/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download remote-core" })).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/content"))).toBe(false);
  });

  it("ignores a stale preview response after the selection changes", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const encoder = new TextEncoder();
    boardWith(
      [
        {
          id: "one",
          kind: "log",
          filename: "one.log",
          contentHash: "a".repeat(64),
          verificationStatus: "verified",
          privacyClass: "owner_only",
          uploaderId: "alice",
          mediaType: "text/plain",
          byteLength: 8,
        },
        {
          id: "two",
          kind: "log",
          filename: "two.log",
          contentHash: "b".repeat(64),
          verificationStatus: "verified",
          privacyClass: "owner_only",
          uploaderId: "alice",
          mediaType: "text/plain",
          byteLength: 8,
        },
      ],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        if (url.includes("/one/")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-length": "8", "content-type": "text/plain" }),
            body: new ReadableStream<Uint8Array>({
              async start(controller) {
                await firstGate;
                controller.enqueue(encoder.encode("STALEONE"));
                controller.close();
              },
            }),
          };
        }
        return previewResponse({
          status: 200,
          headers: { "content-length": "7", "content-type": "text/plain" },
          body: "CURRENT",
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("one.log")).toBeTruthy();
    fireEvent.click(within(screen.getByText("one.log").closest("li")!).getByRole("button", { name: "Inspect log" }));
    fireEvent.click(within(screen.getByText("two.log").closest("li")!).getByRole("button", { name: "Inspect log" }));
    releaseFirst?.();
    expect(await screen.findByText("CURRENT")).toBeTruthy();
    expect(screen.queryByText("STALEONE")).toBeNull();
  });

  it("renders sparse evidence without write controls", async () => {
    boardWith([{
      id: "sparse",
      kind: "attachment",
      filename: null,
      contentHash: null,
      verificationStatus: null,
      privacyClass: "owner_only",
      uploaderId: "alice",
    }]);
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    expect(await screen.findByText("attachment")).toBeTruthy();
    expect(screen.getByText("Kind: attachment")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Upload evidence" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download attachment" })).toBeTruthy();
  });

  it("reuses a 304 preview only when the same artifact cache is still valid", async () => {
    let gets = 0;
    const rangeInits: RequestInit[] = [];
    boardWith(
      [{
        id: "cached",
        kind: "log",
        filename: "cached.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 9,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        gets += 1;
        rangeInits.push(init ?? {});
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.["If-None-Match"] === '"etag-cache"') {
          return previewResponse({
            status: 304,
            headers: { etag: '"etag-cache"' },
            body: "",
          });
        }
        if (gets > 1) {
          return previewResponse({
            status: 200,
            headers: { "content-length": "9", "content-type": "text/plain", etag: '"other"' },
            body: "NOT-CACHE",
          });
        }
        return previewResponse({
          status: 200,
          headers: {
            "content-length": "9",
            "content-type": "text/plain",
            etag: '"etag-cache"',
          },
          body: "cached-ok",
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("cached-ok")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide log" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("cached-ok")).toBeTruthy();
    expect(screen.queryByText("NOT-CACHE")).toBeNull();
    expect(gets).toBe(2);
    expect(rangeInits[1]?.headers).toMatchObject({
      Range: "bytes=0-65535",
      "If-None-Match": '"etag-cache"',
    });
  });

  it("says 304 is unmodified when no cached preview exists", async () => {
    boardWith(
      [{
        id: "cold",
        kind: "log",
        filename: "cold.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 4,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({ status: 304, headers: { etag: '"missing"' }, body: "" });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("The preview was not modified, but no cached preview is available.")).toBeTruthy();
  });

  it("does not preview NUL-containing payloads", async () => {
    boardWith(
      [{
        id: "nul",
        kind: "log",
        filename: "nul.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 4,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({
          status: 200,
          headers: { "content-length": "4", "content-type": "text/plain" },
          body: new Uint8Array([65, 0, 66, 67]),
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText(/not valid text/)).toBeTruthy();
  });

  it("uses a native same-origin GET without forcing a filename onto error responses", async () => {
    const downloads: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      downloads.push([
        this.getAttribute("href"),
        this.getAttribute("download"),
        this.getAttribute("target"),
        this.getAttribute("rel"),
      ].join("|"));
    };
    let contentFetches = 0;
    boardWith(
      [{
        id: "dl",
        kind: "log",
        filename: "checkout.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 12,
      }],
      (url) => {
        if (!url.endsWith("/content")) return null;
        contentFetches += 1;
        throw new Error("native downloads must not preflight or buffer /content");
      },
    );
    try {
      render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
      fireEvent.click(await screen.findByRole("button", { name: "Download checkout.log" }));
      expect(downloads).toEqual([
        "/api/cases/case-1/evidence/dl/content||_blank|noopener",
      ]);
      expect(contentFetches).toBe(0);
      expect(PANEL_SOURCE).not.toContain('setAttribute("download"');
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it("does not treat a complete 12-byte 206 as truncated", async () => {
    const bytes = encodeBytes("hello world\n");
    boardWith(
      [{
        id: "tiny",
        kind: "log",
        filename: "tiny.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: bytes.byteLength,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({
          status: 206,
          headers: {
            "content-length": String(bytes.byteLength),
            "content-type": "text/plain",
            "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
          },
          body: bytes,
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("hello world")).toBeTruthy();
    expect(screen.queryByText("Showing the first 64 KiB of this file.")).toBeNull();
  });

  it("marks a 206 truncated only when Content-Range proves a partial object", async () => {
    boardWith(
      [{
        id: "part",
        kind: "log",
        filename: "part.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 1000,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({
          status: 206,
          headers: {
            "content-length": "11",
            "content-type": "text/plain",
            "content-range": "bytes 0-10/1000",
          },
          body: "partial-log",
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText("partial-log")).toBeTruthy();
    expect(screen.getByText("Showing the first 64 KiB of this file.")).toBeTruthy();
  });

  it("does not preview invalid UTF-8", async () => {
    boardWith(
      [{
        id: "bad",
        kind: "log",
        filename: "bad.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 3,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return previewResponse({
          status: 200,
          headers: { "content-length": "3", "content-type": "text/plain" },
          body: new Uint8Array([0xff, 0xfe, 0xfd]),
        });
      },
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    expect(await screen.findByText(/not valid text/)).toBeTruthy();
  });

  it("does not apply preview state after unmount", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Host(props: { open: boolean }) {
      return props.open
        ? <CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />
        : <p>unmounted</p>;
    }
    boardWith(
      [{
        id: "one",
        kind: "log",
        filename: "one.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        mediaType: "text/plain",
        byteLength: 7,
      }],
      (url, init) => {
        if (!url.endsWith("/content") || requestMethod(init) === "HEAD") return null;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "7", "content-type": "text/plain" }),
          body: new ReadableStream<Uint8Array>({
            async start(controller) {
              await gate;
              controller.enqueue(encodeBytes("STALE"));
              controller.close();
            },
          }),
        };
      },
    );
    const { rerender } = render(<Host open />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect log" }));
    rerender(<Host open={false} />);
    release?.();
    expect(screen.getByText("unmounted")).toBeTruthy();
    expect(screen.queryByText("STALE")).toBeNull();
  });

  it("does not retain download state after native navigation and unmount", async () => {
    const downloads: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      downloads.push("navigated");
    };
    function Host(props: { open: boolean }) {
      return props.open
        ? <CaseBoardPanel canReadPrivate caseId="case-1" canWrite={false} canLead={false} readOnly />
        : <p>unmounted</p>;
    }
    boardWith(
      [{
        id: "dl",
        kind: "log",
        filename: "checkout.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "alice",
        byteLength: 12,
      }],
      (url) => {
        if (!url.endsWith("/content")) return null;
        throw new Error("native download must not use protectedApiFetch");
      },
    );
    try {
      const { rerender } = render(<Host open />);
      fireEvent.click(await screen.findByRole("button", { name: "Download checkout.log" }));
      rerender(<Host open={false} />);
      await waitFor(() => expect(screen.getByText("unmounted")).toBeTruthy());
      expect(downloads).toEqual(["navigated"]);
      expect(screen.queryByText("Preparing download…")).toBeNull();
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});

describe("upload protocol and selection fencing", () => {
  it("treats a 2xx without the upload-success schema as a protocol error", async () => {
    stubUploadXhr();
    let evidenceLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) {
          evidenceLoads += 1;
          return jsonOk({ artifacts: [] });
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    UploadXHR.pending[0]?.complete(200, JSON.stringify({ artifact: { id: "artifact-2" } }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/unusable upload response/);
    expect(screen.queryByText("Evidence uploaded.")).toBeNull();
    expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeTruthy();
    await waitFor(() => expect(evidenceLoads).toBe(2));
  });

  it("rejects malformed 2xx envelopes without success, reset, or freeze", async () => {
    stubUploadXhr();
    let snapshotPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          snapshotPosts += 1;
          return jsonOk({ id: "snapshot-x" });
        }
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    const malformed = [
      JSON.stringify({
        schemaId: "cd-collab.evidence_list.v1",
        caseId: "case-1",
        artifact: uploadArtifact("artifact-2"),
        summary: uploadSummaryRecord("artifact-2"),
      }),
      JSON.stringify({
        schemaId: "cd-collab.evidence_upload_success.v1",
        caseId: "case-1",
        artifact: uploadArtifact("artifact-2"),
      }),
      JSON.stringify({
        schemaId: "cd-collab.evidence_upload_success.v1",
        caseId: "case-1",
        artifact: uploadArtifact("artifact-2"),
        summary: { ...uploadSummaryRecord("artifact-2"), id: undefined },
      }),
      JSON.stringify({
        schemaId: "cd-collab.evidence_upload_success.v1",
        caseId: "case-1",
        artifact: uploadArtifact("artifact-2", "case-9"),
        summary: uploadSummaryRecord("artifact-2"),
      }),
      JSON.stringify({
        schemaId: "cd-collab.evidence_upload_success.v1",
        caseId: "case-1",
        artifact: uploadArtifact("artifact-2", "case-1", { summaryContributionId: "other-summary" }),
        summary: uploadSummaryRecord("artifact-2"),
      }),
    ];
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Freeze a snapshot with this upload/ }));
    for (const body of malformed) {
      fireEvent.submit(form);
      await waitFor(() => expect(UploadXHR.pending.at(-1)?.sent).toBe(true));
      UploadXHR.pending.at(-1)?.complete(200, body);
      expect((await screen.findByRole("alert")).textContent).toMatch(/unusable upload response/);
      expect(screen.queryByText("Evidence uploaded.")).toBeNull();
      expect(screen.queryByText(/snapshot was frozen/)).toBeNull();
      expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
      expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Checkout request log");
    }
    expect(snapshotPosts).toBe(0);
  });

  it("rejects a well-formed upload envelope rooted on another case without success, reset, or freeze", async () => {
    stubUploadXhr();
    let snapshotPosts = 0;
    let evidenceLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          snapshotPosts += 1;
          return jsonOk({ id: "snapshot-x" });
        }
        if (url.endsWith("/evidence")) {
          evidenceLoads += 1;
          return jsonOk({ artifacts: [] });
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Freeze a snapshot with this upload/ }));
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    UploadXHR.pending[0]?.complete(200, uploadSuccessBody("artifact-2", "case-other"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/unusable upload response/);
    expect(screen.queryByText("Evidence uploaded.")).toBeNull();
    expect(screen.queryByText(/snapshot was frozen/)).toBeNull();
    expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
    expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Checkout request log");
    expect(snapshotPosts).toBe(0);
    await waitFor(() => expect(evidenceLoads).toBe(2));
  });

  it("rejects a well-formed upload envelope with a blank artifact id without success, reset, or freeze", async () => {
    stubUploadXhr();
    let snapshotPosts = 0;
    let evidenceLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          snapshotPosts += 1;
          return jsonOk({ id: "snapshot-x" });
        }
        if (url.endsWith("/evidence")) {
          evidenceLoads += 1;
          return jsonOk({ artifacts: [] });
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Freeze a snapshot with this upload/ }));
    for (const artifactId of ["", "   "]) {
      fireEvent.submit(form);
      await waitFor(() => expect(UploadXHR.pending.at(-1)?.sent).toBe(true));
      UploadXHR.pending.at(-1)?.complete(200, uploadSuccessBody(artifactId, "case-1"));
      expect((await screen.findByRole("alert")).textContent).toMatch(/unusable upload response/);
      expect(screen.queryByText("Evidence uploaded.")).toBeNull();
      expect(screen.queryByText(/snapshot was frozen/)).toBeNull();
      expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
      expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Checkout request log");
    }
    expect(snapshotPosts).toBe(0);
    await waitFor(() => expect(evidenceLoads).toBe(3));
  });

  it("says the board could not be refreshed when unknown-commit inventory reload fails", async () => {
    stubUploadXhr();
    let evidenceLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) {
          evidenceLoads += 1;
          if (evidenceLoads > 1) {
            return { ok: false, status: 500, json: async () => ({ error: "unavailable" }) };
          }
          return jsonOk({ artifacts: [] });
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    UploadXHR.pending[0]?.complete(503, JSON.stringify({ error: "commit_outcome_unknown" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The upload outcome is unknown, and the evidence board could not be refreshed. Reload and check the inventory before retrying. This is not confirmation that the file was stored or that it was rolled back.",
    );
    expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeTruthy();
    expect(UploadXHR.pending).toHaveLength(1);
  });

  it("does not freeze a snapshot when stream commit outcome is unknown", async () => {
    stubUploadXhr();
    let snapshotPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          snapshotPosts += 1;
          return jsonOk({ id: "snapshot-x" });
        }
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Freeze a snapshot with this upload/ }));
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    UploadXHR.pending[0]?.complete(503, JSON.stringify({ error: "commit_outcome_unknown" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/upload outcome is unknown/);
    expect(snapshotPosts).toBe(0);
    expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
  });

  it("does not mark upload cancelled after unmount", async () => {
    stubUploadXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    function Host(props: { open: boolean }) {
      return props.open
        ? <CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />
        : <p>unmounted</p>;
    }
    const { rerender } = render(<Host open />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    rerender(<Host open={false} />);
    expect(screen.getByText("unmounted")).toBeTruthy();
    expect(screen.queryByText("Upload cancelled.")).toBeNull();
    UploadXHR.pending[0]?.complete(200, uploadSuccessBody("artifact-2"));
    expect(screen.queryByText("Evidence uploaded.")).toBeNull();
  });

  it("refreshes on unknown commit outcome without claiming rollback or auto-retrying", async () => {
    stubUploadXhr();
    let evidenceLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) {
          evidenceLoads += 1;
          return jsonOk({ artifacts: [] });
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />);
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    UploadXHR.pending[0]?.complete(503, JSON.stringify({ error: "commit_outcome_unknown" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The upload outcome is unknown. The evidence board has been refreshed; check it before retrying. This is not confirmation that the file was stored or that it was rolled back.",
    );
    expect(screen.getByText("Selected: checkout.log")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeTruthy();
    await waitFor(() => expect(evidenceLoads).toBe(2));
    expect(UploadXHR.pending).toHaveLength(1);
  });

  it("ignores a stale upload after the investigation changes", async () => {
    stubUploadXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    const { rerender } = render(
      <CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead={false} readOnly={false} />,
    );
    const form = (await screen.findByRole("heading", { name: "Upload evidence" })).closest("form")!;
    const file = new File(["hello"], "checkout.log", { type: "text/plain" });
    Object.defineProperty(screen.getByLabelText("File"), "files", { configurable: true, value: [file] });
    fireEvent.change(screen.getByLabelText("File"));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Checkout request log" } });
    fireEvent.submit(form);
    await waitFor(() => expect(UploadXHR.pending.length).toBe(1));
    rerender(<CaseBoardPanel canReadPrivate caseId="case-2" canWrite canLead={false} readOnly={false} />);
    expect(await screen.findByRole("heading", { name: "Upload evidence" })).toBeTruthy();
    UploadXHR.pending[0]?.complete(200, uploadSuccessBody("artifact-stale", "case-1"));
    expect(screen.queryByText("Evidence uploaded.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborts and ignores late inventory JSON when switching investigations", async () => {
    let caseAEvidenceReads = 0;
    let releaseLateA!: (body: unknown) => void;
    let releaseCaseB!: (body: unknown) => void;
    const lateA = new Promise<unknown>((resolve) => {
      releaseLateA = resolve;
    });
    const caseB = new Promise<unknown>((resolve) => {
      releaseCaseB = resolve;
    });
    const signals: AbortSignal[] = [];
    const artifact = (id: string, filename: string) => ({
      id,
      kind: "log",
      filename,
      contentHash: "a".repeat(64),
      verificationStatus: "verified",
      privacyClass: "share_safe",
      uploaderId: "alice",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (init?.signal) signals.push(init.signal);
        if (url.endsWith("/evidence")) {
          if (url.includes("/case-1/")) {
            caseAEvidenceReads += 1;
            return {
              ok: true,
              status: 200,
              json: async () => caseAEvidenceReads === 1
                ? { artifacts: [artifact("artifact-a", "case-a.log")] }
                : lateA,
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => caseB,
          };
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    const { rerender } = render(
      <CaseBoardPanel canReadPrivate
        caseId="case-1"
        canWrite={false}
        canLead={false}
        readOnly
        routeFocus={{
          section: "triage-evidence-board",
          item: "artifact-a",
          itemKind: "evidence",
          lane: null,
          experiment: null,
        }}
      />,
    );
    const caseAItem = (await screen.findByText("case-a.log")).closest("li") as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(caseAItem));
    window.dispatchEvent(new CustomEvent("contextdesk:corpus-intake-committed", {
      detail: { caseId: "case-1" },
    }));
    await waitFor(() => expect(caseAEvidenceReads).toBe(2));
    const refreshSignal = [...new Set(signals)].at(-1);

    rerender(
      <CaseBoardPanel canReadPrivate caseId="case-2" canWrite={false} canLead={false} readOnly />,
    );
    expect(screen.queryByText("case-a.log")).toBeNull();
    expect(screen.getByText("Loading case memory…")).toBeTruthy();
    expect(refreshSignal?.aborted).toBe(true);

    releaseLateA({ artifacts: [artifact("artifact-late-a", "late-case-a.log")] });
    await Promise.resolve();
    expect(screen.queryByText("late-case-a.log")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    releaseCaseB({ artifacts: [artifact("artifact-b", "case-b.log")] });
    expect(await screen.findByText("case-b.log")).toBeTruthy();
    expect(screen.queryByText("case-a.log")).toBeNull();
    expect(screen.queryByText("late-case-a.log")).toBeNull();
  });

  it("does not freeze hidden selected evidence", async () => {
    let snapshotBody: unknown;
    const artifacts = [
      {
        id: "artifact-0",
        kind: "log",
        filename: "service-0.log",
        relativePath: "node-a/service-0.log",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "lead",
      },
      {
        id: "artifact-1",
        kind: "attachment",
        filename: "note-1.txt",
        relativePath: "notes/note-1.txt",
        contentHash: "a".repeat(64),
        verificationStatus: "verified",
        privacyClass: "owner_only",
        uploaderId: "lead",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonOk({ artifacts });
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          snapshotBody = JSON.parse(String(init.body));
          return jsonOk({
            id: "snapshot-hidden",
            fingerprint: "b".repeat(64),
            parentSnapshotId: null,
            evidence: [],
            visibility: "owner_only",
            createdAt: "2026-08-20T00:00:00.000Z",
            createdBy: "lead",
          });
        }
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    render(<CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />);
    expect(await screen.findByText("2 matching · showing 2 · 0 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all evidence" }));
    fireEvent.change(screen.getByLabelText("Filter evidence"), { target: { value: "note-1" } });
    expect(screen.getByText("1 matching · showing 1 · 1 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Freeze selected evidence (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Freeze selected evidence (1)" }));
    await waitFor(() => expect(snapshotBody).toEqual({ evidenceIds: ["artifact-1"] }));
  });

  it("prevents duplicate freeze and ignores a late completion after case switch", async () => {
    const artifact = {
      id: "artifact-freeze",
      kind: "log",
      filename: "freeze.log",
      contentHash: "a".repeat(64),
      verificationStatus: "verified",
      privacyClass: "share_safe",
      uploaderId: "lead",
    };
    let releaseFreeze!: (response: ReturnType<typeof jsonOk>) => void;
    const freezeResponse = new Promise<ReturnType<typeof jsonOk>>((resolve) => {
      releaseFreeze = resolve;
    });
    let freezePosts = 0;
    let freezeSignal: AbortSignal | null = null;
    let caseOneBoardLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/snapshots") && init?.method === "POST") {
          freezePosts += 1;
          freezeSignal = init.signal ?? null;
          return freezeResponse;
        }
        if (url.includes("/case-1/") && url.endsWith("/evidence")) {
          return jsonOk({ artifacts: [artifact] });
        }
        if (url.endsWith("/evidence")) return jsonOk({ artifacts: [] });
        if (url.endsWith("/snapshots")) return jsonOk({ snapshots: [] });
        if (url.includes("/case-1/") && url.endsWith("/board")) caseOneBoardLoads += 1;
        return jsonOk({ snapshotId: null, notice: "", findings: [] });
      }),
    );
    const frozen = vi.fn();
    window.addEventListener("contextdesk:snapshot-frozen", frozen);
    try {
      const { rerender } = render(
        <CaseBoardPanel canReadPrivate caseId="case-1" canWrite canLead readOnly={false} />,
      );
      await screen.findByText("freeze.log");
      fireEvent.click(screen.getByRole("button", { name: "Select all evidence" }));
      const freezeButton = screen.getByRole("button", { name: "Freeze selected evidence (1)" });
      fireEvent.click(freezeButton);
      fireEvent.click(freezeButton);
      expect(freezePosts).toBe(1);
      const pending = screen.getByRole("button", { name: "Freezing selected evidence…" });
      expect(pending).toHaveProperty("disabled", true);
      expect(pending.getAttribute("aria-busy")).toBe("true");

      rerender(
        <CaseBoardPanel canReadPrivate caseId="case-2" canWrite canLead readOnly={false} />,
      );
      expect(screen.queryByText("freeze.log")).toBeNull();
      expect((freezeSignal as AbortSignal | null)?.aborted).toBe(true);
      releaseFreeze(jsonOk({
        id: "stale-snapshot",
        fingerprint: "b".repeat(64),
        parentSnapshotId: null,
        evidence: [{ evidenceId: artifact.id, ordinal: 0 }],
        visibility: "share_safe",
        createdAt: "2026-08-20T00:00:00.000Z",
        createdBy: "lead",
      }));
      expect(await screen.findByText("No evidence has been registered yet.")).toBeTruthy();
      expect(frozen).not.toHaveBeenCalled();
      expect(caseOneBoardLoads).toBe(1);
    } finally {
      window.removeEventListener("contextdesk:snapshot-frozen", frozen);
    }
  });
});
