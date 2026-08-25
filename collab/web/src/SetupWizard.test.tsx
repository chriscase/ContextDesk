import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const unclaimed = {
  schemaId: "cd-collab.setup_status.v1",
  revision: 0,
  phase: "awaiting_owner",
  claimed: false,
  failureCode: null,
};

const claimed = { ...unclaimed, revision: 1, phase: "claimed", claimed: true };

function fillClaim() {
  fireEvent.change(screen.getByLabelText("Your name or setup role"), {
    target: { value: "Synthetic owner" },
  });
  fireEvent.change(screen.getByLabelText("Owner token"), {
    target: { value: "A".repeat(43) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Claim installation" }));
}

function fillSingleNode() {
  fireEvent.change(screen.getByLabelText("Deployment label"), {
    target: { value: "Synthetic War Room" },
  });
  fireEvent.change(screen.getByLabelText("Data root"), {
    target: { value: "/var/lib/contextdesk-synthetic" },
  });
  fireEvent.change(screen.getByLabelText("Evidence root"), {
    target: { value: "/var/lib/contextdesk-synthetic/evidence" },
  });
  fireEvent.change(screen.getByLabelText("SQLite database path"), {
    target: { value: "/var/lib/contextdesk-synthetic/db/contextdesk.sqlite" },
  });
  fireEvent.change(screen.getByLabelText("Admin username"), {
    target: { value: "owner" },
  });
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Synthetic owner" },
  });
  fireEvent.change(screen.getByLabelText("Initial password"), {
    target: { value: "Synthetic password 123!" },
  });
}

describe("first-run setup wizard", () => {
  it("presents a guided checklist and keeps installation status honest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, unclaimed)));
    render(<SetupWizard />);

    expect(await screen.findByRole("heading", { name: "Prepare your War Room in about five minutes" })).toBeTruthy();
    expect(screen.getByText("Installation is not complete")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Setup checklist" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^install$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });

  it("claims, prepares, and verifies without sending raw secrets in the draft", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) return response(200, unclaimed);
      if (url.endsWith("/claim")) return response(200, claimed);
      if (url.endsWith("/secrets")) {
        return response(200, {
          purpose: "initial_admin_password",
          handle: `setup_secret:initial_admin_password:${"a".repeat(64)}`,
        });
      }
      if (url.endsWith("/draft")) {
        return response(200, {
          schemaId: "cd-collab.setup_public_draft.v1",
          deploymentLabel: "Synthetic War Room",
          status: { ...claimed, revision: 2, phase: "draft" },
          summary: { storage: "sqlite", authentication: "local", committed: false },
          configurationPrepared: true,
          installationComplete: false,
        });
      }
      if (url.endsWith("/verify")) {
        return response(200, {
          outcome: "bounded_checks_passed",
          installationComplete: false,
          commitAvailable: false,
        });
      }
      throw new Error(`unexpected ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupWizard />);
    await screen.findByLabelText("Owner token");
    fillClaim();
    await screen.findByLabelText("Deployment label");
    fillSingleNode();
    fireEvent.click(screen.getByRole("button", { name: "Prepare configuration" }));

    expect(await screen.findByText("Configuration prepared. Nothing has been installed or restarted.")).toBeTruthy();
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const secretCall = calls.find(([url]) => url.endsWith("/secrets"));
    const draftCall = calls.find(([url]) => url.endsWith("/draft"));
    expect(JSON.parse(String(secretCall?.[1].body))).toEqual({
      purpose: "initial_admin_password",
      value: "Synthetic password 123!",
    });
    const draftPayload = String(draftCall?.[1].body);
    expect(draftPayload).toContain("setup_secret:initial_admin_password:");
    expect(draftPayload).not.toContain("Synthetic password 123!");

    fireEvent.click(screen.getByRole("button", { name: "Run bounded checks" }));
    expect(
      await screen.findByText(
        "Bounded configuration checks passed. External services were not contacted, and installation is not complete.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Configuration checked")).toBeTruthy();
    expect(screen.getByText("Installation is not complete")).toBeTruthy();
  });

  it("preserves every entered field after a recoverable draft failure", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/status")) return response(200, claimed);
      if (url.endsWith("/secrets")) {
        return response(200, {
          purpose: "initial_admin_password",
          handle: `setup_secret:initial_admin_password:${"b".repeat(64)}`,
        });
      }
      if (url.endsWith("/draft")) {
        return response(409, { error: "stale_revision" });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupWizard />);
    await screen.findByLabelText("Deployment label");
    fireEvent.change(screen.getByLabelText("Owner token"), {
      target: { value: "A".repeat(43) },
    });
    fillSingleNode();
    fireEvent.click(screen.getByRole("button", { name: "Prepare configuration" }));

    expect(await screen.findByText(/Setup changed in another window/)).toBeTruthy();
    expect((screen.getByLabelText("Deployment label") as HTMLInputElement).value).toBe("Synthetic War Room");
    expect((screen.getByLabelText("Initial password") as HTMLInputElement).value).toBe("Synthetic password 123!");
    expect((screen.getByRole("button", { name: "Run bounded checks" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves the normal application in control when setup is unavailable", async () => {
    const onUnavailable = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => response(404, { error: "setup_unavailable" })));
    render(<SetupWizard onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
  });

  it("prepares a team LDAP draft with secret handles and never puts passwords in the draft", async () => {
    const bindSecret = "Synthetic LDAP bind value";
    const probeSecret = "fixture-alice-secret";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) return response(200, claimed);
      if (url.endsWith("/secrets")) {
        const body = JSON.parse(String(init?.body)) as { purpose: string };
        return response(200, {
          purpose: body.purpose,
          handle: `setup_secret:${body.purpose}:${"c".repeat(64)}`,
        });
      }
      if (url.endsWith("/draft")) {
        return response(200, {
          schemaId: "cd-collab.setup_public_draft.v1",
          deploymentLabel: "Synthetic team room",
          status: { ...claimed, revision: 2, phase: "draft" },
          summary: { storage: "postgres", authentication: "ldap", committed: false },
          configurationPrepared: true,
          installationComplete: false,
        });
      }
      if (url.endsWith("/ldap-probe")) {
        return response(200, {
          schemaId: "cd-collab.ldap_probe_report.v1",
          ready: true,
          stages: [
            { id: "transport", status: "passed", detail: "Encrypted directory transport is available." },
            { id: "service_bind", status: "passed", detail: "Service bind succeeded." },
            { id: "user_search", status: "skipped", detail: "No probe username was supplied." },
            { id: "group_lookup", status: "passed", detail: "Group search base is reachable." },
            { id: "role_map", status: "passed", detail: "A group-to-role map is present." },
          ],
          bindPasswordConfigured: true,
          groupsFound: 0,
          mappedRoles: true,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupWizard />);
    await screen.findByLabelText("Deployment label");
    fireEvent.change(screen.getByLabelText("Owner token"), { target: { value: "A".repeat(43) } });
    fireEvent.change(screen.getByLabelText("Deployment label"), { target: { value: "Synthetic team room" } });
    fireEvent.change(screen.getByLabelText("Deployment pattern"), {
      target: { value: "postgres_ldap" },
    });
    fireEvent.change(screen.getByLabelText("Data root"), {
      target: { value: "/srv/contextdesk-synthetic" },
    });
    fireEvent.change(screen.getByLabelText("Evidence root"), {
      target: { value: "/srv/contextdesk-synthetic/evidence" },
    });
    fireEvent.change(screen.getByLabelText("Application database URL"), {
      target: { value: "postgres://app:synthetic@db.example.test/contextdesk" },
    });
    fireEvent.change(screen.getByLabelText("LDAP URL"), {
      target: { value: "ldaps://directory.example.test:636" },
    });
    fireEvent.change(screen.getByLabelText("User search base"), {
      target: { value: "ou=people,dc=example,dc=test" },
    });
    fireEvent.change(screen.getByLabelText("Group search base"), {
      target: { value: "ou=groups,dc=example,dc=test" },
    });
    fireEvent.change(screen.getByLabelText("Bind DN"), {
      target: { value: "cn=svc,ou=services,dc=example,dc=test" },
    });
    fireEvent.change(screen.getByLabelText("Bind password"), { target: { value: bindSecret } });
    fireEvent.change(screen.getByLabelText("Administrator group"), {
      target: { value: "cn=contributors,ou=groups,dc=example,dc=test" },
    });
    fireEvent.change(screen.getByLabelText("UPN suffix (optional)"), { target: { value: "example.test" } });
    fireEvent.change(screen.getByLabelText("NetBIOS domain (optional)"), { target: { value: "EXAMPLE" } });
    fireEvent.change(screen.getByLabelText("Probe username (optional)"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Probe password (optional, never stored)"), {
      target: { value: probeSecret },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare configuration" }));
    expect(await screen.findByText("Configuration prepared. Nothing has been installed or restarted.")).toBeTruthy();

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const draftPayload = String(calls.find(([url]) => url.endsWith("/draft"))?.[1].body);
    expect(draftPayload).toContain("setup_secret:ldap_bind_password:");
    expect(draftPayload).toContain("service_bind_search");
    expect(draftPayload).toContain("upn");
    expect(draftPayload).toContain("domain_backslash");
    expect(draftPayload).not.toContain(bindSecret);
    expect(draftPayload).not.toContain(probeSecret);
    expect(draftPayload).not.toContain("postgres://app:synthetic");

    fireEvent.click(screen.getByRole("button", { name: "Test directory" }));
    expect(await screen.findByText(/Directory probe finished/)).toBeTruthy();
    const probePayload = String(calls.find(([url]) => url.endsWith("/ldap-probe"))?.[1].body);
    expect(probePayload).toContain(probeSecret);
    expect(JSON.stringify(calls.find(([url]) => url.endsWith("/ldap-probe"))?.[1])).not.toContain(bindSecret);
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Probe password (optional, never stored)") as HTMLInputElement).value,
      ).toBe("");
    });
  });
});
