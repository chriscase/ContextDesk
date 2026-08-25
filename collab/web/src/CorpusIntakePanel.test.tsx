import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorpusIntakePanel } from "./CorpusIntakePanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CorpusIntakePanel", () => {
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
    expect(screen.getByText(/unsupported_media/)).toBeTruthy();
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
});
