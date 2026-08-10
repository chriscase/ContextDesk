import { describe, expect, it } from "vitest";
import {
  applyPreset,
  classifyPreset,
  formatDeadlineMs,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  parseDeadlineDuration,
  PATIENT_DEADLINE_MS,
  STANDARD_DEADLINE_MS,
} from "./deadlineControls";

describe("deadlineControls", () => {
  it("accepts each unit and boundaries", () => {
    expect(parseDeadlineDuration("500ms")).toEqual({ ok: true, ms: 500 });
    expect(parseDeadlineDuration("600000ms")).toEqual({
      ok: true,
      ms: 600_000,
    });
    expect(parseDeadlineDuration("90s")).toEqual({ ok: true, ms: 90_000 });
    expect(parseDeadlineDuration("3m")).toEqual({ ok: true, ms: 180_000 });
    expect(parseDeadlineDuration("10m")).toEqual({ ok: true, ms: 600_000 });
    expect(parseDeadlineDuration(" 2M ")).toEqual({ ok: true, ms: 120_000 });
  });

  it("rejects malformed, negative, decimal, and out-of-range", () => {
    expect(parseDeadlineDuration("").ok).toBe(false);
    expect(parseDeadlineDuration("-3m").ok).toBe(false);
    expect(parseDeadlineDuration("1.5m").ok).toBe(false);
    expect(parseDeadlineDuration("3").ok).toBe(false);
    expect(parseDeadlineDuration("1m30s").ok).toBe(false);
    expect(parseDeadlineDuration("499ms").ok).toBe(false);
    expect(parseDeadlineDuration("11m").ok).toBe(false);
    const low = parseDeadlineDuration("100ms");
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error).toMatch(/500ms|10m/);
  });

  it("formats human durations without inventing fractions", () => {
    expect(formatDeadlineMs(180_000)).toBe("3m");
    expect(formatDeadlineMs(90_000)).toBe("90s");
    expect(formatDeadlineMs(500)).toBe("500ms");
  });

  it("classifies Auto/Standard/Patient/Custom", () => {
    expect(
      classifyPreset({ deadline_ms: 180_000, deadline_is_explicit: false }),
    ).toBe("auto");
    expect(
      classifyPreset({
        deadline_ms: STANDARD_DEADLINE_MS,
        deadline_is_explicit: true,
      }),
    ).toBe("standard");
    expect(
      classifyPreset({
        deadline_ms: PATIENT_DEADLINE_MS,
        deadline_is_explicit: true,
      }),
    ).toBe("patient");
    expect(
      classifyPreset({ deadline_ms: 90_000, deadline_is_explicit: true }),
    ).toBe("custom");
  });

  it("Auto preserves stored numeric value", () => {
    const next = applyPreset(
      { deadline_ms: 90_000, deadline_is_explicit: true },
      "auto",
    );
    expect(next.deadline_is_explicit).toBe(false);
    expect(next.deadline_ms).toBe(90_000);
  });

  it("Standard and Patient set fixed presets within the max", () => {
    expect(STANDARD_DEADLINE_MS).toBeLessThanOrEqual(MAX_DEADLINE_MS);
    expect(PATIENT_DEADLINE_MS).toBeLessThanOrEqual(MAX_DEADLINE_MS);
    expect(STANDARD_DEADLINE_MS).toBeGreaterThanOrEqual(MIN_DEADLINE_MS);
    const s = applyPreset(
      { deadline_ms: 90_000, deadline_is_explicit: false },
      "standard",
    );
    expect(s).toEqual({
      deadline_ms: STANDARD_DEADLINE_MS,
      deadline_is_explicit: true,
    });
    const p = applyPreset(s, "patient");
    expect(p.deadline_ms).toBe(PATIENT_DEADLINE_MS);
  });

  it("desktop/CLI parity for the same duration strings", () => {
    for (const sample of ["500ms", "90s", "3m", "10m"] as const) {
      const gui = parseDeadlineDuration(sample);
      expect(gui.ok).toBe(true);
      if (gui.ok) {
        // Same formulas as cd_core::deadline_controls
        if (sample.endsWith("ms")) {
          expect(gui.ms).toBe(Number(sample.replace("ms", "")));
        } else if (sample.endsWith("s") && !sample.endsWith("ms")) {
          expect(gui.ms).toBe(Number(sample.replace("s", "")) * 1_000);
        } else {
          expect(gui.ms).toBe(Number(sample.replace("m", "")) * 60_000);
        }
      }
    }
  });
});
