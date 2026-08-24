import {
  ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
  ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_RESULTS,
  type AppRole,
} from "@cd-collab/contracts/admin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Administration } from "./Administration.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
