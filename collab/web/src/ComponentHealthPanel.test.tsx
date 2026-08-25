import { COMPONENT_HEALTH_NOTICES, COMPONENT_HEALTH_SCHEMA_ID } from "@cd-collab/contracts/admin";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentHealthPanel } from "./ComponentHealthPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function fixture() {
  return {
    schemaId: COMPONENT_HEALTH_SCHEMA_ID,
    generatedAt: "2026-08-24T12:00:00.000Z",
    dataMode: "synthetic_fixture" as const,
    components: [
      {
        id: "war_room_service" as const,
        label: "War Room service",
        source: "synthetic_fixture" as const,
        reportStatus: "reported" as const,
        version: "0.0.1-fixture",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        protocol: { name: "cd", version: "v1" },
        storageMigration: { state: "current" as const, current: "016_contribution_write_intents", target: "016_contribution_write_intents" },
        compatibility: { status: "compatible" as const, scope: "component_health_contract" as const, detail: "Fixture contract check." },
        update: { state: "available" as const, targetVersion: "0.0.2-fixture" },
      },
      {
        id: "desktop" as const,
        label: "Desktop",
        source: "not_reported" as const,
        reportStatus: "not_reported" as const,
        version: null,
        commit: null,
        protocol: null,
        storageMigration: { state: "not_applicable" as const, current: null, target: null },
        compatibility: { status: "not_evaluated" as const, scope: "not_evaluated" as const, detail: "No report." },
        update: { state: "unknown" as const, targetVersion: null },
      },
      {
        id: "cli" as const,
        label: "CLI",
        source: "not_reported" as const,
        reportStatus: "not_reported" as const,
        version: null,
        commit: null,
        protocol: null,
        storageMigration: { state: "not_applicable" as const, current: null, target: null },
        compatibility: { status: "not_evaluated" as const, scope: "not_evaluated" as const, detail: "No report." },
        update: { state: "unknown" as const, targetVersion: null },
      },
      {
        id: "host_bridge" as const,
        label: "Host bridge",
        source: "not_reported" as const,
        reportStatus: "not_reported" as const,
        version: null,
        commit: null,
        protocol: null,
        storageMigration: { state: "not_applicable" as const, current: null, target: null },
        compatibility: { status: "not_evaluated" as const, scope: "not_evaluated" as const, detail: "No report." },
        update: { state: "unknown" as const, targetVersion: null },
      },
    ],
    notices: [...COMPONENT_HEALTH_NOTICES],
  };
}

describe("ComponentHealthPanel", () => {
  it("shows bounded identity, migration, compatibility, and update state without actions", async () => {
    const fetch = vi.fn(async () => response(fixture()));
    vi.stubGlobal("fetch", fetch);
    render(<ComponentHealthPanel />);

    expect(await screen.findByText("Synthetic fixture data — this is not live desktop, CLI, or host telemetry.")).toBeTruthy();
    expect(screen.getByText("0.0.1-fixture")).toBeTruthy();
    expect(screen.getByText("016_contribution_write_intents → 016_contribution_write_intents")).toBeTruthy();
    expect(screen.getByText("available")).toBeTruthy();
    expect(screen.getAllByText("not_evaluated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/admin/component-health", { cache: "no-store" });
  });

  it("fails closed when the endpoint returns malformed data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ schemaId: COMPONENT_HEALTH_SCHEMA_ID })));
    render(<ComponentHealthPanel />);
    expect(await screen.findByText("Component health could not be validated. No component identity is shown.")).toBeTruthy();
    expect(screen.queryByText("0.0.1-fixture")).toBeNull();
  });
});
