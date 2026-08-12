/**
 * Product vocabulary for reasoning effort (CLI/GUI parity).
 * Affects cost/latency; not a readiness badge. Default is omit.
 */

export type ReasoningEffortLevel =
  | "omit"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const REASONING_EFFORT_OPTIONS: {
  value: ReasoningEffortLevel;
  label: string;
}[] = [
  { value: "omit", label: "Provider default (recommended)" },
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export function effortPolicyHint(level: ReasoningEffortLevel): string {
  if (level === "omit") {
    return "No effort field on the wire (provider default). Not a readiness badge.";
  }
  return `Requests the exact “${level}” token using the selected transport. Exact model and gateway support must be verified; refusals are surfaced and never silently downgraded. Affects cost and latency, not readiness.`;
}

/** Map host DTO → select value. */
export function levelFromDto(policy: string, level?: string | null): ReasoningEffortLevel {
  if (policy === "omit" && !level) return "omit";
  if (policy !== "explicit" || !level) {
    throw new Error("Malformed reasoning-effort policy from host");
  }
  const known = REASONING_EFFORT_OPTIONS.find((o) => o.value === level);
  if (!known || level === "omit") {
    throw new Error(`Unsupported reasoning-effort level from host: ${level}`);
  }
  return level as ReasoningEffortLevel;
}

/** Select value → host set payload (`null` means omit). */
export function levelToSavePayload(level: ReasoningEffortLevel): string | null {
  return level === "omit" ? null : level;
}
