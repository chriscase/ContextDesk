import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "./ExportPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 422): MockResponse {
  return { ok, status, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const APP_LOG_ITEM = {
  kind: "artifact",
  id: "a1",
  label: "app.log",
  privacyClass: "owner_only",
  contentHash: "h",
  excludedByDefault: false,
};

const EXCLUDED_ITEM = {
  kind: "contribution",
  id: "c1",
  label: "agent_transcript",
  privacyClass: "owner_only",
  contentHash: null,
  excludedByDefault: true,
};

const PORTABLE_CAPABILITIES = {
  schemaId: "cd-collab.portable_investigation_capabilities.v1",
  exportAvailable: true,
  dryRunPreflightAvailable: true,
  maximumArchiveBytes: 1024 * 1024,
  apply: {
    available: true,
    requiresExactReconstruction: true,
    typedConfirmation: "RESTORE",
    coordination: "single_instance",
    confirmationRestartDurable: true,
  },
};

const SYNTHETIC_ARCHIVE = {
  schemaId: "cd-collab.investigation_portable_archive.v1",
  investigation: {
    actors: [
      { sourceActorId: "historical-reviewer" },
      { sourceActorId: "historical-operator" },
    ],
  },
};

function jsonFile(value: unknown, name = "investigation.json"): File {
  const contents = JSON.stringify(value);
  const file = new File([contents], name, { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => contents });
  return file;
}

describe("export panel", () => {
  it("exports a brief and shows a privacy-scan report with redacted findings", async () => {
    const briefBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [APP_LOG_ITEM] });
      }
      if (url === "/api/cases/c1/export/brief") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { variant?: string };
        briefBodies.push(body);
        if (body.variant === "share_safe") {
          return jsonResponse(false, {
            error: "privacy_scan_failed",
            findings: [
              { rule: "credential", path: "$.actions[0].body", excerpt: "aws_access_key: AKIA" },
            ],
          });
        }
        return jsonResponse(true, { markdown: "# Triage brief\n", payload: {} });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    expect(await screen.findByText(/app.log/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    expect(await screen.findByText(/# Triage brief/)).toBeTruthy();
    expect(screen.getByText(/Triage brief exported\./)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("owner_only"), { target: { value: "share_safe" } });
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    expect(await screen.findByText(/privacy_scan_failed/)).toBeTruthy();
    expect(screen.getByText(/credential · \$\.actions\[0\]\.body · \[redacted\]/)).toBeTruthy();
    expect(screen.queryByText(/aws_access_key: AKIA/)).toBeNull();
    expect(screen.getByText(/privacy scan blocked this export/)).toBeTruthy();
    expect(screen.queryByText(/# Triage brief/)).toBeNull();
    expect(screen.queryByText(/Triage brief exported\./)).toBeNull();
    expect(briefBodies).toEqual([{ variant: "owner_only" }, { variant: "share_safe" }]);
  });

  it("shows an explicit inventory loading state and an explicit empty state", async () => {
    const inventory = deferred<MockResponse>();
    const fetchMock = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") return inventory.promise;
      return Promise.resolve(jsonResponse(false, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    expect(screen.getByText("Loading evidence inventory…")).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Export selected-evidence prompt package",
      }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    inventory.resolve(jsonResponse(true, { items: [] }));
    expect(await screen.findByText(/no exportable evidence yet/)).toBeTruthy();
    expect(screen.queryByText("Loading evidence inventory…")).toBeNull();
    expect(
      (screen.getByRole("button", {
        name: "Export selected-evidence prompt package",
      }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("surfaces inventory failure as an alert and recovers via retry", async () => {
    let inventoryCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        inventoryCalls += 1;
        if (inventoryCalls === 1) throw new TypeError("network down");
        return jsonResponse(true, { items: [APP_LOG_ITEM] });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("evidence inventory could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading inventory" }));
    expect(await screen.findByText(/app.log/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(inventoryCalls).toBe(2);
  });

  it("treats a non-ok inventory response as a retryable failure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") return jsonResponse(false, {});
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading inventory" })).toBeTruthy();
  });

  it("explains selection state, keeps excluded-by-default items out, and exports a package", async () => {
    const packageBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [APP_LOG_ITEM, EXCLUDED_ITEM] });
      }
      if (url === "/api/cases/c1/export/package") {
        packageBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return jsonResponse(true, {
          markdown: "# Prompt package\n",
          payload: { snapshotIdentity: "f".repeat(64) },
        });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    expect(await screen.findByText(/0 of 1 selectable item selected\./)).toBeTruthy();
    expect(screen.getByText(/not a full investigation backup/)).toBeTruthy();
    expect(
      screen.getByText(/a package with no selected evidence cannot be exported/),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 item is excluded by default and never included in packages/),
    ).toBeTruthy();
    expect(screen.getByText(/agent_transcript · owner_only \(excluded by default\)/)).toBeTruthy();
    const packageButton = screen.getByRole("button", {
      name: "Export selected-evidence prompt package",
    }) as HTMLButtonElement;
    expect(packageButton.disabled).toBe(true);
    const excludedBox = screen.getByRole("checkbox", {
      name: /agent_transcript/,
    }) as HTMLInputElement;
    expect(excludedBox.disabled).toBe(true);
    expect(excludedBox.checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /app\.log/ }));
    expect(await screen.findByText(/1 of 1 selectable item selected\./)).toBeTruthy();
    expect(packageButton.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Optional prompt scaffold/), {
      target: { value: "Summarize the incident" },
    });
    fireEvent.click(packageButton);
    expect(await screen.findByText(/Selected-evidence prompt package exported\./)).toBeTruthy();
    expect(packageBodies).toEqual([
      {
        variant: "owner_only",
        selection: [{ kind: "artifact", id: "a1" }],
        promptScaffold: "Summarize the incident",
      },
    ]);
    expect(screen.getByText("f".repeat(64))).toBeTruthy();
    expect(screen.getByText(/content hash of this export's manifest/)).toBeTruthy();
    const region = screen.getByRole("region", { name: "Exported markdown" });
    expect(region.textContent).toContain("# Prompt package");
  });

  it("disables both submits and shows progress while an export is in flight", async () => {
    const briefGate = deferred<MockResponse>();
    let briefCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return Promise.resolve(jsonResponse(true, { items: [APP_LOG_ITEM] }));
      }
      if (url === "/api/cases/c1/export/brief") {
        briefCalls += 1;
        return briefGate.promise;
      }
      return Promise.resolve(jsonResponse(false, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    await screen.findByText(/app.log/);
    const briefButton = screen.getByRole("button", {
      name: "Export triage brief",
    }) as HTMLButtonElement;
    fireEvent.click(briefButton);
    expect(await screen.findByText(/Exporting triage brief…/)).toBeTruthy();
    expect(briefButton.disabled).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Export selected-evidence prompt package",
      }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByDisplayValue("owner_only") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Export triage brief" }));
    briefGate.resolve(jsonResponse(true, { markdown: "# Triage brief\n", payload: {} }));
    expect(await screen.findByText(/Triage brief exported\./)).toBeTruthy();
    expect(briefCalls).toBe(1);
    expect(briefButton.disabled).toBe(false);
    expect((screen.getByDisplayValue("owner_only") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(/Exporting triage brief…/)).toBeNull();
  });

  it("reports a recoverable network failure and preserves the selection for retry", async () => {
    let briefCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [APP_LOG_ITEM] });
      }
      if (url === "/api/cases/c1/export/brief") {
        briefCalls += 1;
        if (briefCalls === 1) throw new TypeError("network down");
        return jsonResponse(true, { markdown: "# Triage brief\n", payload: {} });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    await screen.findByText(/app.log/);
    fireEvent.click(screen.getByRole("checkbox", { name: /app\.log/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("did not complete");
    expect(alert.textContent).toContain("selection are unchanged");
    expect((screen.getByRole("checkbox", { name: /app\.log/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Export triage brief" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    expect(await screen.findByText(/Triage brief exported\./)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(briefCalls).toBe(2);
  });

  it("keeps default-deny permissions: hidden without access, share_safe locked to leads", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, { items: [APP_LOG_ITEM] }));
    vi.stubGlobal("fetch", fetchMock);
    const denied = render(<ExportPanel caseId="c1" canWrite={false} canLead={false} />);
    expect(denied.container.textContent).toBe("");
    denied.unmount();
    render(<ExportPanel caseId="c1" canWrite canLead={false} />);
    expect(await screen.findByText(/app.log/)).toBeTruthy();
    const option = screen.getByRole("option", { name: "share_safe" }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(screen.getByText("share_safe is available to case leads only.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Export triage brief" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("exposes keyboard-friendly names and a focusable markdown region", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [APP_LOG_ITEM] });
      }
      if (url === "/api/cases/c1/export/brief") {
        return jsonResponse(true, { markdown: "# Triage brief\n", payload: {} });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    await screen.findByText(/app.log/);
    expect(screen.getByRole("form", { name: "Export triage brief" })).toBeTruthy();
    expect(
      screen.getByRole("form", { name: "Export selected-evidence prompt package" }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/Variant/).tagName).toBe("SELECT");
    expect(screen.getByLabelText(/Optional prompt scaffold/).tagName).toBe("TEXTAREA");
    expect(screen.getByRole("checkbox", { name: /artifact · app\.log · owner_only/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    const region = await screen.findByRole("region", { name: "Exported markdown" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("downloads a clearly named complete archive only for a lead", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/case-safe/export/inventory") {
        return jsonResponse(true, { items: [] });
      }
      if (url === "/api/portable-investigations/capabilities") {
        return jsonResponse(true, PORTABLE_CAPABILITIES);
      }
      if (url === "/api/cases/case-safe/portable-archive") {
        return jsonResponse(true, SYNTHETIC_ARCHIVE);
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:portable-archive");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    render(<ExportPanel caseId="case-safe" canWrite canLead />);
    const button = await screen.findByRole("button", {
      name: "Download portable investigation archive",
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    expect(await screen.findByText(/Portable investigation archive downloaded/)).toBeTruthy();
    expect(downloadName).toBe("contextdesk-investigation-case-safe.json");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:portable-archive");
    expect(screen.getByText(/Unlike the selected-evidence package above/)).toBeTruthy();
    expect(screen.getByText(/supported only by this single server instance/)).toBeTruthy();
    expect(screen.getByText(/Restore requires an exact reconstruction/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
  });

  it("preflights an archive with attribution-only identities and deterministic remaps", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [] });
      }
      if (url === "/api/portable-investigations/capabilities") {
        return jsonResponse(true, PORTABLE_CAPABILITIES);
      }
      if (url === "/api/portable-investigations/preflight") {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(true, {
          report: {
            counts: { create: 17, update: 0, conflict: 2, blocked: 1 },
            collisionPolicy: "remap_deterministic",
            warnings: [{ code: "synthetic_warning" }],
            referentialIntegrityFailures: [],
            idRemap: [{ namespace: "investigation" }, { namespace: "evidence" }],
            reconstructionStatus: "metadata_only",
            exactReconstruction: false,
            identityResolutions: [
              {
                sourceActorId: "historical-operator",
                action: "preserve_historical_external",
                destinationActorId: null,
              },
            ],
            transportHash: "aa".repeat(32),
            semanticFingerprint: "bb".repeat(32),
            destinationCatalogDigest: "cc".repeat(32),
          },
          privacy: {
            classification: "contains_owner_only",
            ownerOnlyEvidence: 2,
            shareSafeEvidence: 4,
            inlineBlobCount: 5,
            omittedBlobCount: 1,
            privateBlobCount: 2,
            redactedBlobCount: 1,
          },
          omitted: [{ code: "content_omitted" }],
          unsupported: ["synthetic_state_one", "synthetic_state_two"],
          authorization: {
            sourceRolesTrusted: false,
            destinationMembershipGranted: false,
            destinationRoleGranted: false,
            destinationCapabilityGranted: false,
          },
          apply: {
            available: true,
            requiresExactReconstruction: true,
            typedConfirmation: "RESTORE",
            confirmationToken: null,
            expiresAt: null,
            reason: "exact_reconstruction_required",
          },
        });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    const input = await screen.findByLabelText("Portable investigation JSON");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { files: [jsonFile(SYNTHETIC_ARCHIVE)] } });
    expect(await screen.findByText(/2 historical people will remain attribution only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run dry-run check" }));

    expect(await screen.findByRole("region", { name: "Archive readiness summary" })).toBeTruthy();
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.getByText("contains owner only")).toBeTruthy();
    expect(screen.getByText("Deterministic ID remaps").parentElement?.textContent).toContain("2");
    expect(screen.getByText(/2 states are not represented/)).toBeTruthy();
    expect(screen.getByText(/No investigation, user, membership, role, or permission was created/)).toBeTruthy();
    expect(screen.getByText(/not an exact reconstruction/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
    expect(bodies).toEqual([
      {
        archive: SYNTHETIC_ARCHIVE,
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap: [
          {
            sourceActorId: "historical-operator",
            action: "preserve_historical_external",
            destinationActorId: null,
          },
          {
            sourceActorId: "historical-reviewer",
            action: "preserve_historical_external",
            destinationActorId: null,
          },
        ],
      },
    ]);
  });

  it("rejects malformed and oversized files without reflecting their contents", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [] });
      }
      if (url === "/api/portable-investigations/capabilities") {
        return jsonResponse(true, { ...PORTABLE_CAPABILITIES, maximumArchiveBytes: 24 });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    const input = await screen.findByLabelText("Portable investigation JSON");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    const sensitiveText = "not-json-sensitive-value".repeat(4);
    const malformed = new File([sensitiveText], "bad.json", { type: "application/json" });
    Object.defineProperty(malformed, "text", { value: async () => sensitiveText });
    fireEvent.change(input, { target: { files: [malformed] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /larger than this War Room accepts/,
    );
    expect(screen.queryByText(sensitiveText)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Run dry-run check" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("reports malformed archive and portable network failures without payload details", async () => {
    let preflightCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [] });
      }
      if (url === "/api/portable-investigations/capabilities") {
        return jsonResponse(true, PORTABLE_CAPABILITIES);
      }
      if (url === "/api/portable-investigations/preflight") {
        preflightCalls += 1;
        throw new TypeError("synthetic network failure");
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    const input = await screen.findByLabelText("Portable investigation JSON");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));

    const sensitiveText = "private-value-that-must-not-render";
    const malformed = new File([sensitiveText], "malformed.json", {
      type: "application/json",
    });
    Object.defineProperty(malformed, "text", { value: async () => sensitiveText });
    fireEvent.change(input, { target: { files: [malformed] } });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not a valid portable investigation archive",
    );
    expect(screen.queryByText(sensitiveText)).toBeNull();

    fireEvent.change(input, { target: { files: [jsonFile(SYNTHETIC_ARCHIVE)] } });
    await screen.findByText(/2 historical people/);
    fireEvent.click(screen.getByRole("button", { name: "Run dry-run check" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "archive request did not complete",
    );
    expect(preflightCalls).toBe(1);
    expect(screen.queryByRole("region", { name: "Archive readiness summary" })).toBeNull();
  });

  it("confirms an exact reconstruction with typed RESTORE and opens the restored investigation", async () => {
    const applyBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/export/inventory") {
        return jsonResponse(true, { items: [] });
      }
      if (url === "/api/portable-investigations/capabilities") {
        return jsonResponse(true, PORTABLE_CAPABILITIES);
      }
      if (url === "/api/portable-investigations/preflight") {
        return jsonResponse(true, {
          report: {
            counts: { create: 4, update: 0, conflict: 0, blocked: 0 },
            collisionPolicy: "remap_deterministic",
            warnings: [],
            referentialIntegrityFailures: [],
            idRemap: [{ namespace: "investigation" }],
            identityResolutions: [
              {
                sourceActorId: "historical-operator",
                action: "preserve_historical_external",
                destinationActorId: null,
              },
            ],
            reconstructionStatus: "exact",
            exactReconstruction: true,
            transportHash: "aa".repeat(32),
            semanticFingerprint: "bb".repeat(32),
            destinationCatalogDigest: "cc".repeat(32),
          },
          privacy: {
            classification: "share_safe_only",
            ownerOnlyEvidence: 0,
            shareSafeEvidence: 1,
            inlineBlobCount: 1,
            omittedBlobCount: 0,
            privateBlobCount: 0,
            redactedBlobCount: 0,
          },
          omitted: [],
          unsupported: ["synthetic_state_one"],
          authorization: {
            sourceRolesTrusted: false,
            destinationMembershipGranted: false,
            destinationRoleGranted: false,
            destinationCapabilityGranted: false,
          },
          apply: {
            available: true,
            requiresExactReconstruction: true,
            typedConfirmation: "RESTORE",
            confirmationToken: "pit1.synthetic-token",
            expiresAt: "2042-03-04T12:10:00.000Z",
            reason: null,
          },
        });
      }
      if (url === "/api/portable-investigations/apply") {
        applyBodies.push(JSON.parse(String(init?.body)));
        if (applyBodies.length === 1) throw new TypeError("synthetic interrupted restore response");
        return jsonResponse(true, {
          schemaId: "cd-collab.portable_investigation_apply_response.v1",
          status: "applied",
          investigationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          deepLink: "/investigations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/situation",
          authenticityClaim: "none",
          destinationMembershipGranted: false,
          destinationRoleGranted: false,
          destinationCapabilityGranted: false,
        });
      }
      return jsonResponse(false, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportPanel caseId="c1" canWrite canLead />);
    const input = await screen.findByLabelText("Portable investigation JSON");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { files: [jsonFile(SYNTHETIC_ARCHIVE)] } });
    fireEvent.click(await screen.findByRole("button", { name: "Run dry-run check" }));
    expect(await screen.findByText(/can be reconstructed and the archive can be restored/)).toBeTruthy();
    expect(screen.getByText("Keep as historical attribution")).toBeTruthy();
    const restore = screen.getByRole("button", { name: "Restore investigation" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "RESTORE" } });
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "outcome is not confirmed",
    );
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    const link = await screen.findByRole("link", { name: "Open restored investigation" });
    expect(link.getAttribute("href")).toBe(
      "/investigations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/situation",
    );
    expect(applyBodies).toHaveLength(2);
    expect((applyBodies[0] as { typedConfirmation: string }).typedConfirmation).toBe("RESTORE");
    expect((applyBodies[0] as { confirmationToken: string }).confirmationToken).toBe(
      "pit1.synthetic-token",
    );
  });

  it("keeps archive controls lead-only without hiding the explanation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(true, { items: [] })));
    render(<ExportPanel caseId="c1" canWrite canLead={false} />);
    expect(await screen.findByText(/case lead or administrator must download or check/)).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Download portable investigation archive",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText("Portable investigation JSON") as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});
