/**
 * Friendly whole-turn deadline helpers for Settings.
 *
 * Mirrors `cd_core::deadline_controls` grammar so GUI and CLI accept the same
 * strings. The Rust host remains authoritative when saving (sanitized bounds).
 *
 * Precedence (effective ceiling):
 *   per-turn CLI override > saved explicit policy > adaptive policy
 *
 * Adaptive latency *learning* is future work — these controls only set policy.
 */

export const MIN_DEADLINE_MS = 500;
export const MAX_DEADLINE_MS = 600_000;
/** Fixed Standard preset: 3 minutes (managed adaptive default). */
export const STANDARD_DEADLINE_MS = 180_000;
/** Fixed Patient preset: 5 minutes (local/private adaptive default). */
export const PATIENT_DEADLINE_MS = 300_000;

export type DeadlinePreset = "auto" | "standard" | "patient" | "custom";

export type DeadlineParseResult =
  | { ok: true; ms: number }
  | { ok: false; error: string };

/**
 * Parse `90s` / `3m` / `500ms` (case-insensitive unit). No silent clamp.
 */
export function parseDeadlineDuration(input: string): DeadlineParseResult {
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Enter a duration such as 90s, 3m, or 10m." };
  }
  if (raw.startsWith("+") || raw.startsWith("-")) {
    return {
      ok: false,
      error:
        "Use a positive whole number with unit ms, s, or m (for example 90s or 3m).",
    };
  }
  const match = /^(\d+)(ms|s|m)$/i.exec(raw);
  if (!match) {
    if (/^\d+[.,]\d+/.test(raw)) {
      return {
        ok: false,
        error: "Decimals are not accepted; use a whole number (for example 90s).",
      };
    }
    if (/^\d+$/.test(raw)) {
      return {
        ok: false,
        error: "Add a unit: ms, s, or m (for example 90s, 3m, or 10m).",
      };
    }
    return {
      ok: false,
      error:
        "Use one whole number and one unit (ms, s, or m). Examples: 90s, 3m, 10m.",
    };
  }
  const magnitude = Number(match[1]);
  if (!Number.isSafeInteger(magnitude) || magnitude <= 0) {
    return {
      ok: false,
      error: "Duration is too large or zero; use a positive whole number.",
    };
  }
  const unit = match[2].toLowerCase();
  let ms: number;
  if (unit === "ms") {
    ms = magnitude;
  } else if (unit === "s") {
    ms = magnitude * 1_000;
  } else {
    ms = magnitude * 60_000;
  }
  if (!Number.isSafeInteger(ms) || ms > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: "Duration is too large to represent." };
  }
  if (ms < MIN_DEADLINE_MS || ms > MAX_DEADLINE_MS) {
    return {
      ok: false,
      error: `Must be between 500ms and 10m (got ${formatDeadlineMs(ms)}).`,
    };
  }
  return { ok: true, ms };
}

/** Compact human form: prefer whole minutes, then seconds, else ms. */
export function formatDeadlineMs(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

export function classifyPreset(args: {
  deadline_ms: number;
  deadline_is_explicit: boolean;
}): DeadlinePreset {
  if (!args.deadline_is_explicit) return "auto";
  if (args.deadline_ms === STANDARD_DEADLINE_MS) return "standard";
  if (args.deadline_ms === PATIENT_DEADLINE_MS) return "patient";
  return "custom";
}

export type RouterDeadlineFields = {
  deadline_ms: number;
  deadline_is_explicit: boolean;
};

/** Apply a preset; Auto preserves the stored numeric value. */
export function applyPreset(
  current: RouterDeadlineFields,
  preset: DeadlinePreset,
  customMs?: number,
): RouterDeadlineFields {
  switch (preset) {
    case "auto":
      return { ...current, deadline_is_explicit: false };
    case "standard":
      return {
        deadline_ms: STANDARD_DEADLINE_MS,
        deadline_is_explicit: true,
      };
    case "patient":
      return {
        deadline_ms: PATIENT_DEADLINE_MS,
        deadline_is_explicit: true,
      };
    case "custom": {
      const ms =
        customMs !== undefined &&
        customMs >= MIN_DEADLINE_MS &&
        customMs <= MAX_DEADLINE_MS
          ? customMs
          : current.deadline_ms;
      const clamped =
        ms < MIN_DEADLINE_MS
          ? MIN_DEADLINE_MS
          : ms > MAX_DEADLINE_MS
            ? MAX_DEADLINE_MS
            : ms;
      return { deadline_ms: clamped, deadline_is_explicit: true };
    }
  }
}

/** Hint text for the whole-turn control (shared wording). */
export function deadlinePolicyHint(preset: DeadlinePreset): string {
  switch (preset) {
    case "auto":
      return "Recommended. Uses 3 minutes for managed providers and 5 minutes for local or private-network providers. This is a maximum; ContextDesk may finish sooner.";
    case "standard":
      return "Fixed 3-minute whole-turn maximum (within the 10-minute limit). ContextDesk may finish sooner.";
    case "patient":
      return "Fixed 5-minute whole-turn maximum for slower local or private providers (within the 10-minute limit). ContextDesk may finish sooner.";
    case "custom":
      return "Your custom whole-turn maximum (500ms–10m). Enter 90s, 3m, or 10m. ContextDesk may finish sooner.";
  }
}
