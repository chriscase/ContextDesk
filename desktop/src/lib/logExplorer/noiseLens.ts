/**
 * Explorer noise-lens disclosure and suspend state (#817).
 *
 * Durable #671 rules are never deleted or disabled by Suspend. Suspend only
 * overrides the Explorer query lens. Persistence uses localStorage keyed by
 * corpus id so close/reopen and app restart restore the suspend flag without
 * mutating the suppression sidecar revision or rule states.
 */

export const NOISE_LENS_SUSPEND_STORAGE_PREFIX =
  "contextdesk.noiseLensSuspended.v1.";

export function noiseLensSuspendStorageKey(corpusId: string): string {
  return `${NOISE_LENS_SUSPEND_STORAGE_PREFIX}${corpusId}`;
}

/** Read durable-per-corpus suspend flag (false if unavailable). */
export function readNoiseLensSuspended(corpusId: string): boolean {
  if (!corpusId) return false;
  try {
    return globalThis.localStorage?.getItem(noiseLensSuspendStorageKey(corpusId)) === "1";
  } catch {
    return false;
  }
}

/** Persist suspend flag for one corpus. Does not touch #671 policy. */
export function writeNoiseLensSuspended(
  corpusId: string,
  suspended: boolean,
): void {
  if (!corpusId) return;
  try {
    const key = noiseLensSuspendStorageKey(corpusId);
    if (suspended) {
      globalThis.localStorage?.setItem(key, "1");
    } else {
      globalThis.localStorage?.removeItem(key);
    }
  } catch {
    // Private mode / quota: session state still works via React.
  }
}

export type NoiseLensDisclosureInput = {
  /** Count of enabled exact-template rules in the durable policy. */
  enabledRuleCount: number;
  /**
   * Events matching enabled rules in the raw corpus (policy would hide).
   * Null while loading/unavailable.
   */
  policyHiddenCount: number | null;
  /** True when queries currently exclude those templates. */
  lensApplying: boolean;
  /** True when the engineer suspended the lens without disabling rules. */
  lensSuspended: boolean;
  /** Temporary evidence reveal (bookmarks) without policy mutation. */
  temporaryReveal: boolean;
  /** Suppression document revision, if known. */
  policyRevision: number | null;
};

/** Format a compact count for UI. */
export function formatNoiseCount(value: number | null | undefined): string {
  if (value == null) return "…";
  return value.toLocaleString();
}

/**
 * Human-readable disclosure for any surface that may show a reduced number.
 * Always names rule count and excluded-event count; never claims confirmed noise.
 */
export function formatNoiseLensDisclosure(input: NoiseLensDisclosureInput): string {
  const rules = input.enabledRuleCount;
  const ruleWord = rules === 1 ? "rule" : "rules";
  const hidden = formatNoiseCount(input.policyHiddenCount);
  const rev =
    input.policyRevision != null ? ` · policy r${input.policyRevision}` : "";

  if (rules === 0) {
    return `Noise inactive · 0 rules · 0 excluded${rev}`;
  }
  if (input.lensSuspended) {
    return `Noise lens suspended · ${rules} ${ruleWord} still enabled · 0 excluded now · policy would hide ${hidden}${rev}`;
  }
  if (input.temporaryReveal) {
    return `Noise temporarily revealing suppressed evidence · ${rules} ${ruleWord} · policy hides ${hidden} · not analyzed when lens is active${rev}`;
  }
  if (input.lensApplying) {
    return `Noise active · ${rules} ${ruleWord} · ${hidden} excluded · excluded events not analyzed${rev}`;
  }
  return `Noise policy loaded · ${rules} ${ruleWord} · ${hidden} would be excluded${rev}`;
}

/**
 * Template ids that should be applied as `excludedTemplateIds` for the current
 * Explorer query lens.
 */
export function activeNoiseExclusionTemplateIds(input: {
  enabledTemplateIds: number[];
  lensSuspended: boolean;
  temporaryReveal: boolean;
}): number[] {
  if (input.lensSuspended || input.temporaryReveal) return [];
  return input.enabledTemplateIds;
}
