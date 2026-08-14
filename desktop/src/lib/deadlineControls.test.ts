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

/** Accept matrix mirrored from cd_core::deadline_controls adversarial tests. */
const ACCEPT: Array<[string, number]> = [
  ["500ms", 500],
  ["600000ms", 600_000],
  ["1s", 1_000],
  ["90s", 90_000],
  ["3m", 180_000],
  ["10m", 600_000],
  ["  2M  ", 120_000],
  ["10S", 10_000],
  ["\t90s\n", 90_000],
  ["500MS", 500],
  ["  10m  ", 600_000],
];

const REJECT: string[] = [
  "",
  "   ",
  "\t\n",
  "-3m",
  "+3m",
  "1.5m",
  "1,5m",
  "0s",
  "0ms",
  "0m",
  "3",
  "3min",
  "1m30s",
  "90 s",
  "90  s",
  "90s30ms",
  "ms",
  "s",
  "m",
  "abc",
  "90sec",
  "90seconds",
  "٩٠s",
  "90ｓ",
  "90s!",
  "😊3m",
  "3m😊",
  "1e3s",
  "0x10s",
  "499ms",
  "11m",
  "100ms",
  "15m",
  "601s",
  // Unsafe / oversized magnitudes (TS Number path)
  "9007199254740992ms", // Number.MAX_SAFE_INTEGER + 1
  "99999999999999999999ms",
];

describe("deadlineControls adversarial parse parity", () => {
  it("accepts each unit, outer whitespace, case, and bounds", () => {
    for (const [input, want] of ACCEPT) {
      const got = parseDeadlineDuration(input);
      expect(got, `accept ${JSON.stringify(input)}`).toEqual({
        ok: true,
        ms: want,
      });
    }
  });

  it("rejects signs, decimals, zero, junk, mixed units, overflow, and range", () => {
    for (const input of REJECT) {
      const got = parseDeadlineDuration(input);
      expect(got.ok, `reject ${JSON.stringify(input)}`).toBe(false);
    }
  });

  it("never silently clamps out-of-range custom input", () => {
    const low = parseDeadlineDuration("100ms");
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error).toMatch(/500ms|10m/);
    const high = parseDeadlineDuration("15m");
    expect(high.ok).toBe(false);
    expect(parseDeadlineDuration("499ms").ok).toBe(false);
    expect(parseDeadlineDuration("600001ms").ok).toBe(false);
    expect(parseDeadlineDuration("500ms")).toEqual({
      ok: true,
      ms: MIN_DEADLINE_MS,
    });
    expect(parseDeadlineDuration("600000ms")).toEqual({
      ok: true,
      ms: MAX_DEADLINE_MS,
    });
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

  it("invalid custom draft does not change last valid via applyPreset without customMs", () => {
    const last = { deadline_ms: 180_000, deadline_is_explicit: true };
    // When customMs is omitted or invalid-range, applyPreset keeps last value.
    const kept = applyPreset(last, "custom");
    expect(kept.deadline_ms).toBe(180_000);
    expect(kept.deadline_is_explicit).toBe(true);
    const invalidParsed = parseDeadlineDuration("11m");
    expect(invalidParsed.ok).toBe(false);
    // Product path only calls applyPreset with customMs when parse succeeds.
    const still = applyPreset(last, "custom", undefined);
    expect(still.deadline_ms).toBe(180_000);
  });

  it("applyPreset with out-of-range customMs keeps last valid and never invents a clamped value", () => {
    const last = { deadline_ms: 180_000, deadline_is_explicit: true };
    // GUI only passes customMs after parse succeeds; if a caller passes OOR,
    // we must not silently clamp to 500ms (that would look like a successful save).
    const low = applyPreset(last, "custom", 100);
    expect(low.deadline_ms).toBe(180_000);
    const high = applyPreset(last, "custom", 900_000);
    expect(high.deadline_ms).toBe(180_000);
  });

  it("desktop/CLI numeric parity for the shared accept matrix", () => {
    for (const [sample, want] of ACCEPT) {
      const gui = parseDeadlineDuration(sample);
      expect(gui.ok).toBe(true);
      if (gui.ok) expect(gui.ms).toBe(want);
    }
  });

  it("saved-policy style precedence helpers: override clone does not mutate base", () => {
    const saved = { deadline_ms: 90_000, deadline_is_explicit: true };
    const turn = applyPreset(saved, "custom", 600_000);
    expect(turn.deadline_ms).toBe(600_000);
    expect(saved.deadline_ms).toBe(90_000);
    const auto = applyPreset(saved, "auto");
    expect(auto.deadline_is_explicit).toBe(false);
    expect(auto.deadline_ms).toBe(90_000);
  });
});
