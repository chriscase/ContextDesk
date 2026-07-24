/**
 * Structural smoke for progress phase display helpers (#445).
 */

import { describe, expect, it } from "vitest";
import {
  LOG_INGEST_PIPELINE,
  SESSION_IMPORT_PIPELINE,
  phaseLabel,
  type ProcessProgressDto,
} from "./types";

function activePipelineIndex(
  progress: ProcessProgressDto | null,
  pipeline: readonly string[],
): number {
  if (!progress) return -1;
  return pipeline.indexOf(progress.phase);
}

describe("ProcessProgressPanel sequencing helpers", () => {
  it("maps log ingest phases in pipeline order", () => {
    const updates: ProcessProgressDto[] = LOG_INGEST_PIPELINE.map((phase, i) => ({
      kind: "log_ingest",
      phase,
      message: phaseLabel(phase),
      fraction: (i + 1) / LOG_INGEST_PIPELINE.length,
      lines_processed: 10 * (i + 1),
      files_processed: 1,
      bytes_processed: null,
      templates: i >= 2 ? 3 : null,
      cancellable: i < 4,
    }));
    let last = -1;
    for (const u of updates) {
      const idx = activePipelineIndex(u, LOG_INGEST_PIPELINE);
      expect(idx).toBeGreaterThan(last);
      last = idx;
      expect(u.message).not.toMatch(/\/Users\//);
    }
  });

  it("includes session import extract phase", () => {
    expect(SESSION_IMPORT_PIPELINE).toContain("extract");
    expect(phaseLabel("extract")).toBe("Extract");
  });
});
