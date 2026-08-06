/**
 * Structural wiring: Log Explorer must expose the Assess entry and host
 * commands must be registered by name in the Tauri host source.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../../..");

describe("Logging quality desktop wiring", () => {
  it("LogExplorer imports the panel and toolbar button", () => {
    const src = readFileSync(join(here, "LogExplorer.tsx"), "utf8");
    expect(src).toMatch(/LoggingQualityPanel/);
    expect(src).toMatch(/LoggingQualityToolbarButton/);
    expect(src).toMatch(/loggingQualityOpen/);
    const panel = readFileSync(join(here, "LoggingQualityPanel.tsx"), "utf8");
    expect(panel).toMatch(/data-testid="lqa-open"/);
    expect(panel).toMatch(/Assess quality/);
  });

  it("registers thin host commands without frontend scoring", () => {
    const lib = readFileSync(
      join(desktopRoot, "src-tauri/src/lib.rs"),
      "utf8",
    );
    expect(lib).toMatch(/log_assess_logging_quality/);
    expect(lib).toMatch(/log_export_logging_quality_assessment/);
    expect(lib).toMatch(/logging_quality_host/);
    // Must not re-implement scoring in the Tauri command body.
    const assessCmd = lib.slice(
      lib.indexOf("async fn log_assess_logging_quality"),
      lib.indexOf("async fn log_export_logging_quality_assessment"),
    );
    expect(assessCmd).toMatch(/logging_quality_host::assess_at_cache/);
    expect(assessCmd).not.toMatch(/overall_score\s*=/);
  });

  it("main styles load logging-quality.css", () => {
    const main = readFileSync(join(desktopRoot, "src/main.tsx"), "utf8");
    expect(main).toMatch(/logging-quality\.css/);
  });
});
