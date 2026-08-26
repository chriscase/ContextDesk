import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts/corpus-intake";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CorpusIntakePanel,
  corpusSelectionLimitError,
  summarizeCorpusRejections,
} from "./CorpusIntakePanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CorpusIntakePanel", () => {
  it("condenses rejection reasons into human-readable action groups", () => {
    expect(summarizeCorpusRejections([
      { reason: "binary_or_unknown" },
      { reason: "unsupported_media" },
      { reason: "binary_or_unknown" },
      { reason: "nested_archive" },
    ])).toEqual([
      {
        reason: "binary_or_unknown",
        count: 2,
        label: "Not safely readable as text",
        guidance: "Inspect these files outside the War Room before deciding whether they belong in the investigation.",
      },
      {
        reason: "nested_archive",
        count: 1,
        label: "Nested ZIP archive",
        guidance: "Open and review nested archives separately before adding their relevant files.",
      },
      {
        reason: "unsupported_media",
        count: 1,
        label: "Unrecognized file type",
        guidance: "Rename genuine text logs to a recognized log or text extension, then preview again.",
      },
    ]);
  });
  it("accepts exact browser capacity boundaries and rejects one unit over", () => {
    expect(corpusSelectionLimitError("zip", [{
      relativePath: "incident.zip",
      size: CORPUS_INTAKE_LIMITS.maxArchiveBytes,
    }])).toBeNull();
    expect(corpusSelectionLimitError("zip", [{
      relativePath: "incident.zip",
      size: CORPUS_INTAKE_LIMITS.maxArchiveBytes + 1,
    }])).toMatch(/64 MiB/);
    expect(corpusSelectionLimitError("files", [{
      relativePath: "incident.log",
      size: CORPUS_INTAKE_LIMITS.maxFileBytes,
    }])).toBeNull();
    expect(corpusSelectionLimitError("files", [{
      relativePath: "incident.log",
      size: CORPUS_INTAKE_LIMITS.maxFileBytes + 1,
    }])).toMatch(/64 MiB/);
    const exactCount = Array.from(
      { length: CORPUS_INTAKE_LIMITS.maxFileCount },
      (_, index) => ({ relativePath: `${index}.log`, size: 0 }),
    );
    expect(corpusSelectionLimitError("directory", exactCount)).toBeNull();
    expect(corpusSelectionLimitError("directory", [
      ...exactCount,
      { relativePath: "overflow.log", size: 0 },
    ])).toMatch(/4,096 files/);
    const fullCapacity = Array.from({ length: 8 }, (_, index) => ({
      relativePath: `capacity-${index}.log`,
      size: CORPUS_INTAKE_LIMITS.maxFileBytes,
    }));
    expect(corpusSelectionLimitError("files", fullCapacity)).toBeNull();
    expect(corpusSelectionLimitError("files", [
      ...fullCapacity,
      { relativePath: "one-byte-over.log", size: 1 },
    ])).toMatch(/512 MiB/);
  });

  it("previews then commits files without duplicating on retry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ url, body });
        if (url.endsWith("/corpus-intake/preview")) {
          return {
            ok: true,
            json: async () => ({
              previewToken: "a".repeat(64),
              accepted: [
                {
                  relativePath: "mailer/shared-timeout.log",
                  mediaType: "text/x-log",
                  byteLength: 44,
                  digest: "a".repeat(64),
                  duplicateDigest: false,
                  encodingStatus: "utf8",
                },
              ],
              rejected: [
                {
                  relativePath: "mailer/payload.bin",
                  reason: "unsupported_media",
                  detail: "extension is not in the intake allowlist",
                },
              ],
            }),
          };
        }
        if (url.endsWith("/corpus-intake")) {
          return {
            ok: true,
            json: async () => ({
              id: "batch-1",
              caseId: "11111111-1111-4111-8111-111111111111",
              origin: "files",
              replayed: calls.filter((row) => row.url.endsWith("/corpus-intake")).length > 1,
              items: [
                {
                  artifactId: "art-1",
                  relativePath: "mailer/shared-timeout.log",
                  digest: "a".repeat(64),
                  duplicateDigest: false,
                  encodingStatus: "utf8",
                },
              ],
              rejected: [],
            }),
          };
        }
        return { ok: false, json: async () => ({ error: "unexpected" }) };
      }),
    );

    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    const fileInput = screen.getByLabelText("Evidence files") as HTMLInputElement;
    const file = new File(["2026-08-15T00:00:00Z mailer timeout id=syn-1\n"], "shared-timeout.log", {
      type: "text/plain",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    expect(await screen.findByText("mailer/shared-timeout.log")).toBeTruthy();
    expect(screen.getByText("1 · Unrecognized file type")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Commit accepted files" }));
    expect(await screen.findByText("Committed batch")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Deep link to this batch" }).getAttribute("href")).toContain(
      "kind=intake-batch",
    );
    expect((screen.getByRole("button", { name: "Committed" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Commit accepted files" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit accepted files" }));
    await waitFor(() => {
      const commits = calls.filter((row) => row.url.endsWith("/corpus-intake"));
      expect(commits).toHaveLength(2);
      expect(commits[0]?.body.idempotencyKey).toBe(commits[1]?.body.idempotencyKey);
      expect(commits[0]?.body.previewToken).toBe("a".repeat(64));
    });
    expect(await screen.findByText("Replayed batch")).toBeTruthy();
  });

  it("uses browser relative paths for directory origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ accepted: [], rejected: [] }),
      })),
    );
    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Directory" }));
    const file = new File(["timeout\n"], "shared-timeout.log", { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", { value: "mailer/shared-timeout.log" });
    fireEvent.change(screen.getByLabelText("Log directory"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    await waitFor(() => {
      const mock = vi.mocked(fetch);
      expect(mock).toHaveBeenCalled();
      const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as {
        origin: string;
        files: Array<{ relativePath: string }>;
      };
      expect(body.origin).toBe("directory");
      expect(body.files[0]?.relativePath).toBe("mailer/shared-timeout.log");
    });
  });

  it("invalidates preview proof and idempotency when commit-relevant metadata changes", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return {
          ok: true,
          json: async () => ({
            previewToken: "b".repeat(64),
            accepted: [
              {
                relativePath: "synthetic.log",
                mediaType: "text/x-log",
                byteLength: 10,
                digest: "c".repeat(64),
                duplicateDigest: false,
                encodingStatus: "utf8",
              },
            ],
            rejected: [],
          }),
        };
      }),
    );
    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    const file = new File(["synthetic\n"], "synthetic.log", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Evidence files"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    expect(await screen.findByText("synthetic.log")).toBeTruthy();
    const firstKey = bodies[0]?.idempotencyKey;

    fireEvent.change(screen.getByLabelText("Corpus intake source label"), {
      target: { value: "changed synthetic source" },
    });
    expect(screen.queryByText("synthetic.log")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Commit accepted files" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.sourceLabel).toBe("changed synthetic source");
    expect(bodies[1]?.idempotencyKey).not.toBe(firstKey);
  });
  it("states the preflight facts and the unknowns before an upload starts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "ZIP archive" }));
    const archive = new File([new Uint8Array(2 * 1024 * 1024)], "diagnostics.zip", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("ZIP file to upload"), { target: { files: [archive] } });

    expect(screen.getByText("Before this upload starts")).toBeTruthy();
    expect(screen.getByText("Archives selected")).toBeTruthy();
    expect(screen.getByText("2 MiB")).toBeTruthy();
    expect(screen.getByText("64 MiB")).toBeTruthy();
    expect(screen.getByText("What will be checked (8 stages)")).toBeTruthy();
    expect(screen.getByText("Read the archive index")).toBeTruthy();
    // An archive's expanded size is not knowable from a file picker, and the
    // preflight says so rather than implying a total it does not have.
    expect(
      screen.getByText(/how large the archive is once expanded/),
    ).toBeTruthy();
  });

  it("blocks a selection the configured limits already refuse", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    const oversized = new File(["x"], "huge.log", { type: "text/plain" });
    Object.defineProperty(oversized, "size", {
      value: CORPUS_INTAKE_LIMITS.maxFileBytes + 1,
    });
    fireEvent.change(screen.getByLabelText("Evidence files"), { target: { files: [oversized] } });
    expect(screen.getByRole("alert").textContent).toMatch(/larger than 64 MiB/);
    expect(
      (screen.getByRole("button", { name: "Preview intake" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("streams a large selection as binary parts and shows determinate progress", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const selected = Array.from({ length: 40 }, (_, index) =>
      new File([`line ${index}\n`], `part-${index}.log`, { type: "text/plain" }));
    const declared = selected.reduce((total, file) => total + file.size, 0);
    const session = (receivedParts: number) => ({
      schemaId: "cd-collab.corpus_intake_session.v1",
      sessionId: "22222222-2222-4222-8222-222222222222",
      caseId: "11111111-1111-4111-8111-111111111111",
      origin: "files",
      sourceLabel: "investigation upload",
      privacyClass: "owner_only",
      idempotencyKey: "batch-web-000002",
      state: "awaiting_bytes",
      createdAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-08-25T06:00:00.000Z",
      limits: CORPUS_INTAKE_LIMITS,
      selection: {
        partCount: selected.length,
        declaredBytes: declared,
        compressedBytes: null,
        expandedBytes: declared,
      },
      stages: ["preflight", "upload", "classify", "privacy_scan", "stage_evidence", "commit"],
      unknowns: ["member_encodings", "duplicate_digests"],
      parts: selected.map((file, index) => ({
        index,
        relativePath: file.name,
        declaredBytes: file.size,
        declaredMediaType: "text/plain",
        receivedBytes: index < receivedParts ? file.size : 0,
        complete: index < receivedParts,
        digest: index < receivedParts ? "a".repeat(64) : null,
      })),
      progress: {
        stage: "upload",
        determinate: true,
        uploadedBytes: selected.slice(0, receivedParts).reduce((t, f) => t + f.size, 0),
        declaredBytes: declared,
        expandedBytes: 0,
        expectedExpandedBytes: null,
        filesSeen: 0,
        filesAccepted: 0,
        filesRejected: 0,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
      previewToken: null,
      batchId: null,
      failure: null,
    });
    let landed = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: String(init?.method ?? "GET"), body: init?.body });
      if (url.endsWith("/corpus-intake/sessions") && init?.method === "POST") {
        return { ok: true, status: 201, json: async () => session(0) };
      }
      if (url.includes("/parts/")) {
        landed += 1;
        return { ok: true, status: 200, json: async () => session(landed) };
      }
      if (url.endsWith("/preview")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            previewToken: "d".repeat(64),
            accepted: [{
              relativePath: "part-0.log",
              mediaType: "text/x-log",
              byteLength: 8,
              digest: "e".repeat(64),
              duplicateDigest: false,
              encodingStatus: "utf8",
            }],
            rejected: [],
          }),
        };
      }
      if (url.endsWith("/commit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "batch-streamed",
            caseId: "11111111-1111-4111-8111-111111111111",
            origin: "files",
            replayed: false,
            items: [{
              artifactId: "art-1",
              relativePath: "part-0.log",
              digest: "e".repeat(64),
              duplicateDigest: false,
            }],
            rejected: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => session(landed) };
    }));

    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Evidence files"), { target: { files: selected } });
    expect(screen.getByText("Resumable chunks of 8 MiB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    expect(await screen.findByText("part-0.log")).toBeTruthy();

    const parts = requests.filter((row) => row.url.includes("/parts/"));
    expect(parts).toHaveLength(selected.length);
    for (const part of parts) {
      expect(part.method).toBe("PUT");
      // Binary slices, not base64 the tab has to hold.
      expect(typeof part.body).not.toBe("string");
    }
    expect(requests.some((row) => row.url.endsWith("/corpus-intake/preview"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Commit accepted files" }));
    expect(await screen.findByText("Committed batch")).toBeTruthy();
    const commit = requests.find((row) => row.url.endsWith("/commit"));
    expect(JSON.parse(String(commit?.body)).previewToken).toBe("d".repeat(64));
  });

  it("shows the server's named refusal rather than a generic failure", async () => {
    const selected = Array.from({ length: 40 }, (_, index) =>
      new File([`line ${index}\n`], `part-${index}.log`, { type: "text/plain" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        schemaId: "cd-collab.corpus_intake_error.v1",
        error: "file_count_exceeded",
        code: "file_count_exceeded",
        message: "This selection holds more files than one intake accepts. Split it into smaller batches.",
        detail: "file count exceeds cap",
        limit: 4096,
        observed: null,
        path: null,
        retryable: false,
      }),
    })));
    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Evidence files"), { target: { files: selected } });
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "This selection holds more files than one intake accepts. Split it into smaller batches.",
    );
    expect(alert.textContent).not.toBe("invalid");
  });

  it("offers to continue an upload that a reload interrupted", async () => {
    globalThis.sessionStorage.setItem(
      "contextdesk:corpus-intake-session",
      JSON.stringify({
        caseId: "11111111-1111-4111-8111-111111111111",
        sessionId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: "33333333-3333-4333-8333-333333333333",
        state: "awaiting_bytes",
        selection: { partCount: 2, declaredBytes: 4 * 1024 * 1024, compressedBytes: null, expandedBytes: 4 * 1024 * 1024 },
        progress: { uploadedBytes: 1024 * 1024 },
        parts: [],
      }),
    })));
    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    const banner = await screen.findByText(/An upload to this investigation was interrupted/);
    expect(banner.textContent).toContain("1 MiB of 4 MiB is already here");
    expect(screen.getByRole("button", { name: "Discard the interrupted upload" })).toBeTruthy();
    globalThis.sessionStorage.clear();
  });
  it("keeps a dropped upload resumable instead of orphaning it", async () => {
    const selected = Array.from({ length: 40 }, (_, index) =>
      new File([`line ${index}\n`], `part-${index}.log`, { type: "text/plain" }));
    const declared = selected.reduce((total, file) => total + file.size, 0);
    const awaiting = {
      sessionId: "44444444-4444-4444-8444-444444444444",
      state: "awaiting_bytes",
      limits: CORPUS_INTAKE_LIMITS,
      selection: {
        partCount: selected.length,
        declaredBytes: declared,
        compressedBytes: null,
        expandedBytes: declared,
      },
      parts: selected.map((file, index) => ({
        index,
        relativePath: file.name,
        declaredBytes: file.size,
        declaredMediaType: "text/plain",
        receivedBytes: index === 0 ? file.size : 0,
        complete: index === 0,
        digest: index === 0 ? "a".repeat(64) : null,
      })),
      progress: { uploadedBytes: selected[0]!.size },
    };
    let parts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/corpus-intake/sessions") && init?.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ ...awaiting, parts: awaiting.parts.map((p) => ({ ...p, receivedBytes: 0, complete: false, digest: null })) }) };
      }
      if (url.includes("/parts/")) {
        parts += 1;
        // The connection drops partway through the selection.
        if (parts > 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              schemaId: "cd-collab.corpus_intake_error.v1",
              error: "storage_unavailable",
              code: "storage_unavailable",
              message: "The intake could not be completed.",
              detail: "upstream unavailable",
              limit: null,
              observed: null,
              path: null,
              retryable: true,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => awaiting };
      }
      return { ok: true, status: 200, json: async () => awaiting };
    }));

    render(
      <CorpusIntakePanel
        caseId="11111111-1111-4111-8111-111111111111"
        canWrite
        readOnly={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Evidence files"), { target: { files: selected } });
    fireEvent.click(screen.getByRole("button", { name: "Preview intake" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The intake could not be completed.");
    // The bytes the server already holds stay claimed, so the next attempt
    // continues rather than starting the whole upload again.
    const banner = await screen.findByText(/An upload to this investigation was interrupted/);
    expect(banner.textContent).toContain("is already here");
    expect(screen.getByRole("button", { name: "Discard the interrupted upload" })).toBeTruthy();
  });
});
