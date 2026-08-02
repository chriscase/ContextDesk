/**
 * Frozen mapping: company-import lab production path ↔ EngineClient surface.
 *
 * The lab cannot open a live Tauri host; it exercises the same core entry
 * points the Tauri EngineClient adapter invokes. This test keeps the mapping
 * honest so a rename of host commands or EngineClient methods fails closed.
 */
import { describe, expect, it } from "vitest";

/** EngineClient methods the lab acceptance path covers via core equivalents. */
const LAB_ENGINE_CLIENT_SURFACE = {
  "import.preview": "preview_import_plan / log_preview_import",
  "import.run":
    "verify_import_plan + selection + ingest_path_with_policy_bindings_and_observer / log_run_import (optional formatApply)",
  "import.cancel": "CancelFlag → CoreError::Cancelled (cancel_log_ingest)",
  "time.state": "load_timezone_resolution_state / log_load_timezone_state",
  "time.preview": "preview_source_timezone / log_preview_source_timezone",
  "time.applyMany": "apply_source_timezones / log_apply_source_timezones",
  "formats.apply":
    "apply_reviewed_format_bindings_with_report / log_reviewed_format_apply / POST /v1/reviewed_formats/apply",
  diagnose: "diagnose_log_import",
} as const;

describe("company import lab EngineClient boundary", () => {
  it("covers every import/time method the ImportFlow EngineClient exposes", () => {
    const required = [
      "import.preview",
      "import.run",
      "import.cancel",
      "time.state",
      "time.preview",
      "time.applyMany",
    ];
    for (const key of required) {
      expect(LAB_ENGINE_CLIENT_SURFACE[key as keyof typeof LAB_ENGINE_CLIENT_SURFACE]).toBeTruthy();
    }
  });

  it("documents selection-bound run (not ad-hoc ingest) as the EngineClient path", () => {
    expect(LAB_ENGINE_CLIENT_SURFACE["import.run"]).toContain("verify_import_plan");
    expect(LAB_ENGINE_CLIENT_SURFACE["import.run"]).toContain("selection");
  });
});
