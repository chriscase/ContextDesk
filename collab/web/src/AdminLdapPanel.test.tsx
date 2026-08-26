import {
  DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  LDAP_PROBE_REPORT_SCHEMA_ID,
  LDAP_PROBE_REQUEST_SCHEMA_ID,
  LDAP_PUBLIC_CONFIG_SCHEMA_ID,
} from "@cd-collab/contracts/admin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminLdapPanel } from "./AdminLdapPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const publicConfig = {
  schemaId: LDAP_PUBLIC_CONFIG_SCHEMA_ID,
  authMode: "ldap" as const,
  url: "ldaps://directory.example.test:636",
  starttls: false,
  verifyTls: true,
  caConfigured: false,
  userResolutionModes: ["service_bind_search", "upn", "domain_backslash"],
  userDnTemplate: null,
  userSearchBase: "ou=people,dc=example,dc=test",
  userSearchFilter: "(uid={username})",
  groupSearchBase: "ou=groups,dc=example,dc=test",
  groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
  memberAttribute: "memberOf",
  bindDn: "cn=svc,ou=services,dc=example,dc=test",
  bindPasswordConfigured: true,
  upnSuffix: "example.test",
  netbiosDomain: "EXAMPLE",
  attributeMap: DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  timeoutMs: 8000,
};

const readyReport = {
  schemaId: LDAP_PROBE_REPORT_SCHEMA_ID,
  ready: true,
  stages: [
    { id: "transport", status: "passed", detail: "Encrypted directory transport is available." },
    { id: "service_bind", status: "passed", detail: "Service bind succeeded." },
    { id: "user_search", status: "passed", detail: "Probe user resolved and authenticated." },
    { id: "group_lookup", status: "passed", detail: "Found 1 group reference(s)." },
    { id: "role_map", status: "passed", detail: "At least one probe group maps to a workspace role." },
  ],
  bindPasswordConfigured: true,
  groupsFound: 1,
  mappedRoles: true,
};

describe("AdminLdapPanel", () => {
  it("loads share-safe configuration and runs a staged test without keeping the probe password", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/ldap/config") {
        return { ok: true, status: 200, json: async () => publicConfig } as Response;
      }
      if (url === "/api/admin/ldap/test") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as {
          schemaId: string;
          probeUsername: string;
          probePassword: string;
        };
        expect(body.schemaId).toBe(LDAP_PROBE_REQUEST_SCHEMA_ID);
        expect(body.probeUsername).toBe("alice");
        expect(body.probePassword).toBe("fixture-alice-secret");
        return { ok: true, status: 200, json: async () => readyReport } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminLdapPanel />);
    expect(await screen.findByText("configured (not displayed)")).toBeTruthy();
    expect(screen.queryByText("fixture-service-secret")).toBeNull();
    expect(screen.getByText(/service_bind_search, upn, domain_backslash/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Probe username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Probe password (optional, never stored)"), {
      target: { value: "fixture-alice-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test directory" }));

    expect(await screen.findByText("Every required stage passed or was skipped.")).toBeTruthy();
    expect(screen.getByText("Encrypted transport")).toBeTruthy();
    expect(screen.getByText("Role-map readiness")).toBeTruthy();
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Probe password (optional, never stored)") as HTMLInputElement).value,
      ).toBe("");
    });
    expect(JSON.stringify(readyReport)).not.toContain("fixture-alice-secret");
  });

  it("names the group-refresh mode and CA trust the running configuration implies", async () => {
    const withServiceBind = vi.fn(async () =>
      new Response(JSON.stringify(publicConfig), { status: 200 }),
    );
    vi.stubGlobal("fetch", withServiceBind);
    render(<AdminLdapPanel />);
    expect(
      await screen.findByText(/live — the service bind re-reads membership on each request/),
    ).toBeTruthy();
    expect(screen.getByText("system trust store")).toBeTruthy();
    cleanup();

    // No service bind: membership is whatever the user bind exposed at login,
    // and the panel must say so rather than leave it to be inferred.
    const snapshot = {
      ...publicConfig,
      bindDn: null,
      bindPasswordConfigured: false,
      caConfigured: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 })),
    );
    render(<AdminLdapPanel />);
    expect(
      await screen.findByText(
        /login-time snapshot — membership changes apply at next sign-in/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("operator-supplied CA (replaces the system trust store)"),
    ).toBeTruthy();
  });

  it("states a bounded error when directory configuration is forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response),
    );
    render(<AdminLdapPanel />);
    expect(
      await screen.findByText("Directory configuration requires the admin:system_config capability."),
    ).toBeTruthy();
  });
});

describe("AdminLdapPanel reload and failed-probe behaviour", () => {
  it("re-reads the configuration on demand and drops the report it no longer describes", async () => {
    let configReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/ldap/config") {
        configReads += 1;
        // Second read reflects an operator changing the running configuration.
        return {
          ok: true,
          status: 200,
          json: async () =>
            configReads === 1
              ? publicConfig
              : { ...publicConfig, starttls: true, url: "ldap://directory.example.test:389" },
        } as Response;
      }
      if (url === "/api/admin/ldap/test") {
        return { ok: true, status: 200, json: async () => readyReport } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminLdapPanel />);
    expect(await screen.findByText("ldaps://directory.example.test:636")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test directory" }));
    expect(await screen.findByText("Every required stage passed or was skipped.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));

    // New values are shown, and the earlier "ready" verdict is gone: it
    // described the configuration read before this one.
    expect(await screen.findByText("ldap://directory.example.test:389")).toBeTruthy();
    expect(screen.getByText(/StartTLS/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Every required stage passed or was skipped.")).toBeNull();
    });
    expect(screen.queryByRole("heading", { name: "Last test report" })).toBeNull();
    expect(configReads).toBe(2);
  });

  it("keeps the panel usable and returns no secret when a probe fails", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/ldap/config") {
        return { ok: true, status: 200, json: async () => publicConfig } as Response;
      }
      if (url === "/api/admin/ldap/test") {
        return {
          ok: false,
          status: 500,
          json: async () => ({ schemaId: "cd-collab.ldap_admin_error.v1", error: "unavailable" }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminLdapPanel />);
    fireEvent.change(await screen.findByLabelText("Probe username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("Probe password (optional, never stored)"), {
      target: { value: "fixture-alice-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test directory" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The directory test could not run. No stored secret was returned.",
    );
    expect(screen.queryByRole("heading", { name: "Last test report" })).toBeNull();
    // The probe password is cleared even on failure, and the panel stays usable.
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Probe password (optional, never stored)") as HTMLInputElement).value,
      ).toBe("");
    });
    expect(document.body.textContent).not.toContain("fixture-alice-secret");
    expect(screen.getByRole("button", { name: "Reload configuration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test directory" })).toBeTruthy();
  });
});
