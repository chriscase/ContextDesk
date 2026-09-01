import {
  EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
} from "@cd-collab/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminEvidenceStoragePanel } from "./AdminEvidenceStoragePanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("AdminEvidenceStoragePanel", () => {
  it("shows a secret-free S3 readiness report and refreshes safely", async () => {
    const fetch = vi.fn(async () => response({
      schemaId: EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
      provider: "s3",
      database: "postgres",
      state: "ready",
      checkedAt: "2026-09-01T12:00:00.000Z",
      endpoint: "https://garage.example.test:3900",
      region: "garage",
      bucket: "contextdesk-evidence",
      prefix: "cases/",
      maxUploadBytes: 30_000_000,
      requestTimeoutMs: 30_000,
      credentialsMode: "default_chain",
    }));
    vi.stubGlobal("fetch", fetch);

    render(<AdminEvidenceStoragePanel />);
    expect(await screen.findByText("S3-compatible object storage")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("contextdesk-evidence")).toBeTruthy();
    expect(screen.getByText("Server credential chain")).toBeTruthy();
    expect(screen.getByText(/browser talks only to the ContextDesk server/i)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/evidence-storage",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("does not display configuration when the status response cannot be validated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ secret: "never-display" }, 500)));
    render(<AdminEvidenceStoragePanel />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be validated/i);
    expect(screen.queryByText("never-display")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });
});
