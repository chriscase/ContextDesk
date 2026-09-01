import {
  ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
  ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_RESULTS,
  DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  LDAP_PUBLIC_CONFIG_SCHEMA_ID,
  type AppRole,
} from "@cd-collab/contracts/admin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Administration } from "./Administration.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

function rolesAndPeopleFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/authz/group-role-map") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaId: ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
          mappings: [{ group: "local:admins", role: "admin" }],
          limit: ADMIN_ROLE_MAPPING_MAX_RESULTS,
          truncated: false,
        }),
      } as Response;
    }
    if (url === "/api/admin/people/search") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID, people: [], nextCursor: null }),
      } as Response;
    }
    if (url === "/api/admin/ldap/config") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaId: LDAP_PUBLIC_CONFIG_SCHEMA_ID,
          authMode: "local",
          url: null,
          starttls: false,
          verifyTls: true,
          caConfigured: false,
          userResolutionModes: [],
          userDnTemplate: null,
          userSearchBase: null,
          userSearchFilter: null,
          groupSearchBase: null,
          groupSearchFilter: null,
          memberAttribute: null,
          bindDn: null,
          bindPasswordConfigured: false,
          upnSuffix: null,
          netbiosDomain: null,
          attributeMap: DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
          timeoutMs: 8000,
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("Administration", () => {
  it("discovers references, grants a role, confirms admin updates, and confirms revoke", async () => {
    const mappings = new Map<string, AppRole>([["local:admins", "admin"]]);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/authz/group-role-map" && !init?.method) {
        return response({
          schemaId: ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
          mappings: [...mappings].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(
            ([group, role]) => ({ group, role }),
          ),
          limit: ADMIN_ROLE_MAPPING_MAX_RESULTS,
          truncated: false,
        });
      }
      if (url === "/api/admin/directory/groups/search") {
        return response({
          schemaId: ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
          results: [{ dn: "local:operators", name: "operators", source: "local" }],
        });
      }
      if (url === "/api/admin/directory/identities/search") {
        return response({
          schemaId: ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
          results: [{
            id: "local:operator-one",
            username: "operator-one",
            displayName: "Operator One",
            source: "local",
          }],
        });
      }
      if (url === "/api/authz/group-role-map" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { group: string; role: AppRole };
        mappings.set(body.group, body.role);
        return response({ ok: true, audit: "recorded" });
      }
      if (url === "/api/authz/group-role-map" && init?.method === "DELETE") {
        const body = JSON.parse(String(init.body)) as { group: string };
        mappings.delete(body.group);
        return response({ ok: true, audit: "recorded" });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    render(<Administration />);
    expect(await screen.findByText("local:admins")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Administration" }));

    fireEvent.change(screen.getByLabelText("Group name, username, or display name"), {
      target: { value: "operator" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search directory" }));
    expect(await screen.findByText("Operator One")).toBeTruthy();
    expect(screen.getByText(/Roles are granted to groups, never directly/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use directory group operators" }));
    expect((screen.getByLabelText("Directory group") as HTMLInputElement).value).toBe(
      "local:operators",
    );

    fireEvent.change(screen.getByLabelText("Workspace role"), {
      target: { value: "case-lead" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant role" }));
    expect(await screen.findByText(/local:operators now grants Case lead/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    const rowRole = screen.getByLabelText("Role for local:operators");
    fireEvent.change(rowRole, { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Update role for local:operators" }));
    expect(screen.getByRole("dialog", { name: "Grant administrator access?" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm administrator grant" }));
    expect(await screen.findByText(/local:operators now grants Administrator/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke mapping for local:operators" }));
    expect(screen.getByRole("dialog", { name: "Revoke this group mapping?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByText(/local:operators was revoked/)).toBeTruthy();
    expect(screen.queryByLabelText("Role for local:operators")).toBeNull();

    const requests = fetch.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: (init as RequestInit | undefined)?.method ?? "GET",
    }));
    expect(requests).toContainEqual({ url: "/api/authz/group-role-map", method: "PUT" });
    expect(requests).toContainEqual({ url: "/api/authz/group-role-map", method: "DELETE" });
  });

  it("fails closed on malformed mapping responses and bounds directory failures", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/authz/group-role-map") {
        return response({ mappings: [{ group: "private", role: "admin" }] });
      }
      return response({ internal: "directory bind detail" }, 503);
    });
    vi.stubGlobal("fetch", fetch);
    render(<Administration />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not be validated. No permission data is shown",
    );
    expect(screen.queryByText("private")).toBeNull();

    fireEvent.change(screen.getByLabelText("Group name, username, or display name"), {
      target: { value: "op" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search directory" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("No directory data is shown");
    });
    expect(screen.queryByText(/bind detail/)).toBeNull();
  });

  it("surfaces a persisted change whose audit write was not confirmed", async () => {
    let role: AppRole = "admin";
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        role = (JSON.parse(String(init.body)) as { role: AppRole }).role;
        return response({ ok: true, audit: "failed" });
      }
      return response({
        schemaId: ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
        mappings: [{ group: "local:admins", role }],
        limit: ADMIN_ROLE_MAPPING_MAX_RESULTS,
        truncated: false,
      });
    }));
    render(<Administration />);
    const selector = await screen.findByLabelText("Role for local:admins");
    fireEvent.change(selector, { target: { value: "case-lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Update role for local:admins" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "mapping changed, but its audit record was not confirmed",
    );
    expect((screen.getByLabelText("Role for local:admins") as HTMLSelectElement).value).toBe(
      "case-lead",
    );
  });
});

describe("Administration People tab", () => {
  it("switches to People on click, pushes /admin/people, and updates the document title", async () => {
    vi.stubGlobal("fetch", rolesAndPeopleFetch());
    render(<Administration />);
    await screen.findByText("local:admins");

    const rolesTab = screen.getByRole("tab", { name: "Group role mappings" });
    const peopleTab = screen.getByRole("tab", { name: "People" });
    expect(rolesTab.getAttribute("aria-selected")).toBe("true");
    expect(peopleTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(peopleTab);
    expect(await screen.findByText("No people match this search.")).toBeTruthy();
    // The roles panel is hidden (not unmounted, so its state survives a tab
    // switch) - assert that directly by id rather than fighting a plain
    // text query, which does not respect the hidden attribute at all.
    expect(document.getElementById("administration-roles-panel")?.hasAttribute("hidden")).toBe(true);
    expect(peopleTab.getAttribute("aria-selected")).toBe("true");
    expect(window.location.pathname).toBe("/admin/people");
    expect(document.title).toContain("People");

    fireEvent.click(rolesTab);
    expect(await screen.findByText("local:admins")).toBeTruthy();
    expect(window.location.pathname).toBe("/administration");
  });

  it("direct-loads and reloads on /admin/people with the People tab already selected", async () => {
    window.history.pushState({}, "", "/admin/people");
    vi.stubGlobal("fetch", rolesAndPeopleFetch());
    render(<Administration />);
    expect(await screen.findByText("No people match this search.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "People" }).getAttribute("aria-selected")).toBe("true");
    // The roles panel exists but is hidden, not unmounted with stale data lost.
    expect(document.getElementById("administration-roles-panel")?.hasAttribute("hidden")).toBe(true);
  });

  it("restores the People tab across simulated back/forward navigation", async () => {
    vi.stubGlobal("fetch", rolesAndPeopleFetch());
    render(<Administration />);
    await screen.findByText("local:admins");
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    await screen.findByText("No people match this search.");

    // Simulate the browser Back button: the URL changes without any click
    // in this component, so only a popstate listener can catch it.
    window.history.pushState({}, "", "/administration");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("local:admins")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Group role mappings" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Administration Directory tab", () => {
  it("switches to Directory on click, pushes /admin/ldap, and updates the document title", async () => {
    vi.stubGlobal("fetch", rolesAndPeopleFetch());
    render(<Administration />);
    await screen.findByText("local:admins");
    fireEvent.click(screen.getByRole("tab", { name: "Directory" }));
    expect(await screen.findByText("Current directory configuration")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Directory" }).getAttribute("aria-selected")).toBe("true");
    expect(window.location.pathname).toBe("/admin/ldap");
    expect(document.title).toContain("Directory");
    expect(document.getElementById("administration-roles-panel")?.hasAttribute("hidden")).toBe(true);
  });

  it("direct-loads and reloads on /admin/ldap with the Directory tab already selected", async () => {
    window.history.pushState({}, "", "/admin/ldap");
    vi.stubGlobal("fetch", rolesAndPeopleFetch());
    render(<Administration />);
    expect(await screen.findByText("Current directory configuration")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Directory" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("administration-roles-panel")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("Administration capability split", () => {
  it("shows only system policy tabs and requests no people or role data for a system-only admin", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/admin/ui-strategies");
      return response({
        schemaId: "cd-collab.ui_strategy_policy.v1",
        revision: 0,
        fingerprint: `sha256:${"0".repeat(64)}`,
        updatedAt: "1970-01-01T00:00:00.000Z",
        updatedBy: "system-default",
        instance: {
          enabledIds: ["war-room", "investigation-first", "keystone"],
          visibleIds: ["war-room", "investigation-first", "keystone"],
          defaultId: "war-room",
          selectionMode: "free",
          approvedIds: ["war-room", "investigation-first", "keystone"],
        },
        roleRules: [],
      });
    });
    vi.stubGlobal("fetch", fetchStub);
    render(<Administration tab="ui-strategies" canManageUsers={false} canManageSystem />);
    expect(await screen.findByRole("heading", { name: "Investigation experiences" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "People" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Group role mappings" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Model use" })).toBeTruthy();
    const requestedUrls = fetchStub.mock.calls.map((call) => String(call[0]));
    expect(requestedUrls).toContain("/api/admin/ui-strategies");
    expect(requestedUrls.some((url) => (
      url.includes("/api/authz/group-role-map") ||
      url.includes("/api/admin/directory/") ||
      url.includes("/api/admin/users")
    ))).toBe(false);
  });
});
