import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "./ExportPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface MockResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

function jsonResponse(ok: boolean, body: unknown): MockResponse {
  return { ok, json: async () => body };
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
      (screen.getByRole("button", { name: "Export prompt package" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    inventory.resolve(jsonResponse(true, { items: [] }));
    expect(await screen.findByText(/no exportable evidence yet/)).toBeTruthy();
    expect(screen.queryByText("Loading evidence inventory…")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Export prompt package" }) as HTMLButtonElement)
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
    expect(
      screen.getByText(/a package with no selected evidence cannot be exported/),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 item is excluded by default and never included in packages/),
    ).toBeTruthy();
    expect(screen.getByText(/agent_transcript · owner_only \(excluded by default\)/)).toBeTruthy();
    const packageButton = screen.getByRole("button", {
      name: "Export prompt package",
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
    expect(await screen.findByText(/Prompt package exported\./)).toBeTruthy();
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
      (screen.getByRole("button", { name: "Export prompt package" }) as HTMLButtonElement)
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
    expect(screen.getByRole("form", { name: "Export prompt package" })).toBeTruthy();
    expect(screen.getByLabelText(/Variant/).tagName).toBe("SELECT");
    expect(screen.getByLabelText(/Optional prompt scaffold/).tagName).toBe("TEXTAREA");
    expect(screen.getByRole("checkbox", { name: /artifact · app\.log · owner_only/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export triage brief" }));
    const region = await screen.findByRole("region", { name: "Exported markdown" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});
