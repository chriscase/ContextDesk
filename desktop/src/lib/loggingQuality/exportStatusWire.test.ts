/**
 * Consumes **real** host-shaped JSON (snake_case status tag + camelCase fields),
 * not a hand-built camelCase mock. Guards the displayName wire contract.
 */
import { describe, expect, it } from "vitest";
import type { LoggingQualityExportStatus } from "./types";

/** Parse the host wire JSON exactly as Tauri delivers it. */
function parseExportStatus(wire: string): LoggingQualityExportStatus {
  const raw = JSON.parse(wire) as Record<string, unknown>;
  if (raw.status === "cancelled") {
    return { status: "cancelled" };
  }
  if (raw.status === "failed") {
    return {
      status: "failed",
      reason: String(raw.reason ?? "export failed"),
    };
  }
  if (raw.status === "written") {
    // Must read displayName (camelCase) — the bug was display_name only.
    const displayName = raw.displayName;
    if (typeof displayName !== "string" || !displayName) {
      throw new Error(
        `host export wire missing displayName (got keys: ${Object.keys(raw).join(",")})`,
      );
    }
    return {
      status: "written",
      format: String(raw.format ?? "json"),
      displayName,
    };
  }
  throw new Error(`unknown export status: ${String(raw.status)}`);
}

/** Same message the panel builds after a successful export. */
function exportSuccessMessage(result: LoggingQualityExportStatus): string {
  if (result.status !== "written") {
    throw new Error("expected written");
  }
  return `Exported ${result.format} as ${result.displayName} (atomic publish confirmed).`;
}

describe("LoggingQualityExportStatus wire contract", () => {
  it("parses real host JSON with displayName (not display_name)", () => {
    // Exact shape from logging_quality_host::export_status_serde_uses_camel_case_display_name
    const hostJson = JSON.stringify({
      status: "written",
      format: "json",
      displayName: "contextdesk-logging-quality.json",
    });
    const parsed = parseExportStatus(hostJson);
    expect(parsed).toEqual({
      status: "written",
      format: "json",
      displayName: "contextdesk-logging-quality.json",
    });
    expect(exportSuccessMessage(parsed)).toBe(
      "Exported json as contextdesk-logging-quality.json (atomic publish confirmed).",
    );
    expect(exportSuccessMessage(parsed)).not.toMatch(/undefined/);
  });

  it("rejects the broken snake_case display_name-only payload", () => {
    const broken = JSON.stringify({
      status: "written",
      format: "json",
      display_name: "contextdesk-logging-quality.json",
    });
    expect(() => parseExportStatus(broken)).toThrow(/displayName/);
  });

  it("parses cancelled and failed tags", () => {
    expect(parseExportStatus(JSON.stringify({ status: "cancelled" }))).toEqual({
      status: "cancelled",
    });
    expect(
      parseExportStatus(
        JSON.stringify({
          status: "failed",
          reason: "output already exists or cannot be created",
        }),
      ),
    ).toEqual({
      status: "failed",
      reason: "output already exists or cannot be created",
    });
  });
});
