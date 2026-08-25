import {
  ADMIN_DIRECTORY_MAPPING_PREVIEW_RESPONSE_SCHEMA_ID,
  ADMIN_PEOPLE_CSRF_HEADER,
  ADMIN_PEOPLE_CSRF_HEADER_VALUE,
  ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_SCHEMA_ID,
  USER_PROFILE_SCHEMA_ID,
} from "@cd-collab/contracts/admin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPeoplePanel } from "./AdminPeoplePanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: USER_PROFILE_SCHEMA_ID,
    id: "local:alice",
    username: "alice",
    displayName: "Alice Analyst",
    roleTitle: null,
    team: null,
    contactEmail: null,
    contactOther: null,
    avatar: null,
    status: "active",
    provenance: "local",
    directorySubject: null,
    directorySyncStatus: "not_synced",
    directorySyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    customAttributes: [],
    revision: 1,
    ...overrides,
  };
}

describe("AdminPeoplePanel", () => {
  it("lists people and shows effective capabilities with source when a row is managed", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/people/search") {
        return response({ schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID, people: [profile()], nextCursor: null });
      }
      if (url === "/api/admin/people/local%3Aalice/effective") {
        return response({
          schemaId: ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID,
          userId: "local:alice",
          roles: ["case-lead"],
          capabilities: [
            { capability: "decision:accept", viaRoles: ["case-lead"], viaLocalGrant: false, grantedBy: null, grantedAt: null },
            { capability: "admin:users", viaRoles: [], viaLocalGrant: true, grantedBy: "local:root", grantedAt: "2026-01-01T00:00:00.000Z" },
          ],
        });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminPeoplePanel />);
    expect(await screen.findByText("alice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("decision:accept")).toBeTruthy();
    expect(screen.getByText("case-lead")).toBeTruthy();
    expect(screen.getByText("Yes (local:root)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
  });

  it("suspends a person with the CSRF header and an idempotency key, then reflects the new status", async () => {
    let currentStatus = "active";
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/people/search") {
        return response({ schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID, people: [profile({ status: currentStatus })], nextCursor: null });
      }
      if (url === "/api/admin/people/local%3Aalice/effective") {
        return response({ schemaId: ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID, userId: "local:alice", roles: [], capabilities: [] });
      }
      if (url === "/api/admin/people/local%3Aalice/status" && init?.method === "POST") {
        const headers = init.headers as Record<string, string>;
        expect(headers[ADMIN_PEOPLE_CSRF_HEADER]).toBe(ADMIN_PEOPLE_CSRF_HEADER_VALUE);
        const body = JSON.parse(String(init.body)) as { status: string; idempotencyKey: string };
        expect(body.idempotencyKey.length).toBeGreaterThan(0);
        currentStatus = body.status;
        return response({ schemaId: USER_PROFILE_SCHEMA_ID, profile: profile({ status: currentStatus, revision: 2 }) });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminPeoplePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    await screen.findByRole("button", { name: "Suspend" });
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/is now suspended/)).toBeTruthy();
  });

  it("never offers a suspend action or a grant/revoke action for an imported_historical profile", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/people/search") {
        return response({
          schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID,
          people: [profile({
            id: "imported:north:actor-1",
            username: "north-actor-1",
            provenance: "imported_historical",
            status: "disabled",
            directorySubject: "imported:north:actor-1",
          })],
          nextCursor: null,
        });
      }
      if (url === "/api/admin/people/imported%3Anorth%3Aactor-1/effective") {
        return response({
          schemaId: ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID,
          userId: "imported:north:actor-1",
          roles: [],
          capabilities: [{ capability: "investigation:read", viaRoles: [], viaLocalGrant: false, grantedBy: null, grantedAt: null }],
        });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminPeoplePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(await screen.findByText(/Historical import - attribution only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  });

  it("previews a directory mapping from synthetic sample claims without touching a directory", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/people/search") {
        return response({ schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID, people: [], nextCursor: null });
      }
      if (url === "/api/admin/directory/mapping/preview") {
        return response({
          schemaId: ADMIN_DIRECTORY_MAPPING_PREVIEW_RESPONSE_SCHEMA_ID,
          fields: { displayName: "Synthetic Analyst" },
          skipped: ["roleTitle", "team", "contactEmail"],
        });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminPeoplePanel />);
    await waitFor(() => expect(screen.getByText("No people match this search.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Preview mapping" }));
    expect(await screen.findByText("Synthetic Analyst")).toBeTruthy();
    const directoryCalls = fetch.mock.calls.filter(([input]) => String(input).includes("directory"));
    expect(directoryCalls).toHaveLength(1);
  });
});
