import {
  ADMIN_PEOPLE_CSRF_HEADER,
  ADMIN_PEOPLE_CSRF_HEADER_VALUE,
  USER_PROFILE_ERROR_SCHEMA_ID,
  USER_PROFILE_SCHEMA_ID,
  USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
} from "@cd-collab/contracts/admin";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfProfilePanel } from "./SelfProfilePanel.js";

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
    id: "local:viewer",
    username: "viewer",
    displayName: "Local Viewer",
    roleTitle: "Triage engineer",
    team: "Response",
    contactEmail: "viewer@example.test",
    contactOther: null,
    avatar: null,
    status: "active",
    provenance: "local",
    directorySubject: null,
    directorySyncStatus: "not_synced",
    directorySyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastSeenAt: "2026-01-03T00:00:00.000Z",
    customAttributes: [],
    revision: 1,
    ...overrides,
  };
}

function renderPanel(overrides?: {
  readOnly?: boolean;
  leaveRequest?: boolean;
  onLeaveConfirm?: ReturnType<typeof vi.fn>;
  onLeaveCancel?: ReturnType<typeof vi.fn>;
  onSaved?: ReturnType<typeof vi.fn>;
  onDirtyChange?: ReturnType<typeof vi.fn>;
}) {
  const onLeaveConfirm = overrides?.onLeaveConfirm ?? vi.fn();
  const onLeaveCancel = overrides?.onLeaveCancel ?? vi.fn();
  const onSaved = overrides?.onSaved ?? vi.fn();
  const onDirtyChange = overrides?.onDirtyChange ?? vi.fn();
  render(
    <SelfProfilePanel
      readOnly={overrides?.readOnly ?? false}
      leaveRequest={overrides?.leaveRequest ?? false}
      onLeaveConfirm={onLeaveConfirm}
      onLeaveCancel={onLeaveCancel}
      onSaved={onSaved}
      onDirtyChange={onDirtyChange}
    />,
  );
  return { onLeaveConfirm, onLeaveCancel, onSaved, onDirtyChange };
}

describe("SelfProfilePanel", () => {
  it("loads recognizable identity, provenance, sync, and revision without raw JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(profile())));
    renderPanel();
    expect(await screen.findByRole("heading", { name: "My profile" })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "My profile" }));
    });
    expect(screen.getByText("Local Viewer")).toBeTruthy();
    expect(screen.getByText("@viewer")).toBeTruthy();
    expect(screen.getByText("Triage engineer · Response")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getAllByText("Local account").length).toBeGreaterThan(0);
    expect(screen.getByText("Not synced from a directory")).toBeTruthy();
    expect(screen.getByText(/Used when saving so two overlapping edits/)).toBeTruthy();
    expect(screen.getByText(/never rewrites history/)).toBeTruthy();
    expect(screen.queryByText(USER_PROFILE_SCHEMA_ID)).toBeNull();
  });

  it("saves a local-editable field with CSRF, schema, and expectedRevision", async () => {
    const current = profile();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/profile/me" && (init?.method ?? "GET") === "GET") {
        return response(current);
      }
      if (url === "/api/profile/me" && init?.method === "PATCH") {
        const headers = init.headers as Record<string, string>;
        expect(headers[ADMIN_PEOPLE_CSRF_HEADER]).toBe(ADMIN_PEOPLE_CSRF_HEADER_VALUE);
        const body = JSON.parse(String(init.body)) as {
          schemaId: string;
          expectedRevision: number;
          contactOther: string;
        };
        expect(body.schemaId).toBe(USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID);
        expect(body.expectedRevision).toBe(1);
        expect(body.contactOther).toBe("Pager: viewer");
        return response(profile({ contactOther: "Pager: viewer", revision: 2 }));
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);
    const { onSaved } = renderPanel();
    const other = await screen.findByLabelText("Other contact");
    fireEvent.change(other, { target: { value: "Pager: viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Profile saved/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ contactOther: "Pager: viewer", revision: 2 }));
  });

  it("keeps LDAP directory fields read-only while local contact stays editable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          profile({
            id: "uid=dana,ou=people,dc=example,dc=test",
            username: "dana",
            displayName: "Dana Directory",
            team: "Directory Team",
            contactEmail: "dana@example.test",
            provenance: "ldap",
            directorySubject: "uid=dana,ou=people,dc=example,dc=test",
            directorySyncStatus: "synced",
            directorySyncedAt: "2026-01-04T00:00:00.000Z",
          }),
        ),
      ),
    );
    renderPanel();
    expect(await screen.findAllByText("Dana Directory")).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "Display name" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Team" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Work email" })).toBeNull();
    expect(screen.getAllByText("Directory-owned").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cannot change LDAP/).length).toBeGreaterThan(0);
    expect(screen.getByText("Linked to the LDAP directory (technical identifier hidden)")).toBeTruthy();
    expect(screen.queryByText(/uid=dana/)).toBeNull();
    expect(screen.getByLabelText("Other contact")).toBeTruthy();
    expect(screen.getByLabelText("Other contact")).not.toHaveProperty("readOnly", true);
  });

  it("validates an empty display name before sending a request", async () => {
    const fetch = vi.fn(async () => response(profile()));
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findAllByText("Enter a display name.")).length).toBeGreaterThan(0);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(
      fetch.mock.calls.some((call) => {
        const init = (call as unknown[])[1] as RequestInit | undefined;
        return init?.method === "PATCH";
      }),
    ).toBe(false);
  });

  it("discards a dirty draft on cancel and restores the saved values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(profile())));
    renderPanel();
    const other = await screen.findByLabelText("Other contact");
    fireEvent.change(other, { target: { value: "unsaved note" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Other contact") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/unsaved edits were discarded/)).toBeTruthy();
  });

  it("preserves the user draft after a stale revision and offers reload or review", async () => {
    let revision = 1;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/profile/me") return response({}, 404);
      if ((init?.method ?? "GET") === "GET") {
        return response(profile({
          contactOther: revision === 1 ? null : "Saved from another tab",
          revision,
        }));
      }
      return response({ schemaId: USER_PROFILE_ERROR_SCHEMA_ID, error: "stale_revision" }, 409);
    });
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    const other = await screen.findByLabelText("Other contact");
    fireEvent.change(other, { target: { value: "My draft note" } });
    revision = 2;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/changed since you started editing/)).toBeTruthy();
    expect((screen.getByLabelText("Other contact") as HTMLInputElement).value).toBe("My draft note");
    expect(screen.getByRole("button", { name: "Hide saved values" })).toBeTruthy();
    const table = screen.getByRole("table", { name: /Your edits compared/ });
    expect(within(table).getByText("My draft note")).toBeTruthy();
    expect(within(table).getByText("Saved from another tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved profile" }));
    await waitFor(() => {
      expect((screen.getByLabelText("Other contact") as HTMLInputElement).value).toBe("Saved from another tab");
    });
  });

  it("shows a recoverable unavailable state", async () => {
    const fetch = vi.fn(async () =>
      response({ schemaId: USER_PROFILE_ERROR_SCHEMA_ID, error: "unavailable" }, 503),
    );
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    expect(await screen.findByText(/temporarily unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("blocks save when the account is suspended", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(profile({ status: "suspended" }))));
    renderPanel();
    expect(await screen.findByText(/account is suspended/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  });

  it("does not offer save in a read-only snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(profile())));
    renderPanel({ readOnly: true });
    expect(await screen.findByText(/read-only snapshot/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  });

  it("restores focus to Stay on this page in the leave dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(profile())));
    const onLeaveCancel = vi.fn();
    renderPanel({ leaveRequest: true, onLeaveCancel });
    await screen.findByRole("heading", { name: "My profile" });
    const stay = await screen.findByRole("button", { name: "Stay on this page" });
    await waitFor(() => expect(document.activeElement).toBe(stay));
    fireEvent.click(stay);
    expect(onLeaveCancel).toHaveBeenCalled();
  });
});
