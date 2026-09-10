import {
  EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
  type EvidenceStorageProviderIdentityBinding,
} from "@cd-collab/contracts/evidence-storage";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminEvidenceStoragePanel } from "./AdminEvidenceStoragePanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const PIN = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
const SECRET = "never-display-secret-access-key";

function statusBody(
  providerIdentityBinding: EvidenceStorageProviderIdentityBinding,
  extra: Record<string, unknown> = {},
) {
  return {
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
    providerIdentityBinding,
    ...extra,
  };
}

describe("AdminEvidenceStoragePanel", () => {
  it("shows a secret-free S3 readiness report and refreshes safely", async () => {
    const fetch = vi.fn(async () => response(statusBody("validated")));
    vi.stubGlobal("fetch", fetch);

    render(<AdminEvidenceStoragePanel />);
    expect(await screen.findByText("S3-compatible object storage")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("contextdesk-evidence")).toBeTruthy();
    expect(screen.getByText("Server credential chain")).toBeTruthy();
    expect(screen.getByText(/validated when this service started/i)).toBeTruthy();
    expect(screen.getByText(/browser talks only to the ContextDesk server/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(PIN);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/evidence-storage",
      expect.objectContaining({ cache: "no-store" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["legacy_unbound", /supported unpinned legacy mode/i],
    ["not_reported", /no startup provider-identity proof/i],
  ] as const)("shows the truthful %s provider identity state", async (binding, copy) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(statusBody(binding))));
    render(<AdminEvidenceStoragePanel />);
    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it("does not display configuration when the status response cannot be validated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ secret: "never-display" }, 500)));
    render(<AdminEvidenceStoragePanel />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be validated/i);
    expect(screen.queryByText("never-display")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });
});
