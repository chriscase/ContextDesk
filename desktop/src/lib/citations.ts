/**
 * Citation scheme classification for turn-completion and click routing
 * (#701 / #698). Pure — no host I/O.
 *
 * Governed log identities use one canonical grammar shared with Rust
 * (`fixtures/citation-contracts/governed-log-citation-ids.v1.json`):
 * lowercase `log_event:<u64>` / `log_template:<u64>`, digits only, canonical
 * form, explicit overflow reject. IDs stay strings through routing; any path
 * that needs a JS number requires `Number.isSafeInteger`.
 */

import { parseHelpLocator } from "./help";

export type CompletedCitationRoute =
  | "help"
  | "log"
  | "file"
  | "deferred"
  | "invalid";

/** Kind of a governed log evidence identity (mirrors Rust). */
export type GovernedLogCitationKind = "event" | "template";

/**
 * Parsed governed log citation. `id` is always the canonical decimal string
 * of the u64 — never silently widened via `Number()`.
 */
export type GovernedLogCitationId = {
  kind: GovernedLogCitationKind;
  /** Canonical decimal digits of the u64 value. */
  id: string;
};

const LOG_EVENT_PREFIX = "log_event:";
const LOG_TEMPLATE_PREFIX = "log_template:";
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;

/** u64::MAX as a decimal string (for overflow comparison without BigInt paths). */
const U64_MAX_DIGITS = "18446744073709551615";

/**
 * Parse a decimal digit string as a canonical u64.
 * - digits only
 * - no leading zeros except the single digit `0`
 * - value ≤ u64::MAX (lexicographic length/digit compare)
 * Returns the canonical digit string, or null.
 */
function parseCanonicalU64Digits(digits: string): string | null {
  if (!digits) return null;
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length > 1 && digits.startsWith("0")) return null;
  // Overflow past u64::MAX without Number/BigInt coercion of the value itself.
  if (digits.length > U64_MAX_DIGITS.length) return null;
  if (
    digits.length === U64_MAX_DIGITS.length &&
    digits > U64_MAX_DIGITS
  ) {
    return null;
  }
  return digits;
}

/**
 * Parse a governed log citation identity (Rust-compatible grammar).
 * Trims outer whitespace only; scheme is case-sensitive lowercase.
 */
export function parseGovernedLogCitationId(
  raw: string,
): GovernedLogCitationId | null {
  const s = raw.trim();
  if (!s) return null;

  let kind: GovernedLogCitationKind;
  let rest: string;
  if (s.startsWith(LOG_EVENT_PREFIX)) {
    kind = "event";
    rest = s.slice(LOG_EVENT_PREFIX.length);
  } else if (s.startsWith(LOG_TEMPLATE_PREFIX)) {
    kind = "template";
    rest = s.slice(LOG_TEMPLATE_PREFIX.length);
  } else {
    return null;
  }

  const id = parseCanonicalU64Digits(rest);
  if (id == null) return null;
  return { kind, id };
}

/** True when `raw` is a fully valid governed log citation identity. */
export function isGovernedLogCitationId(sourceId: string): boolean {
  return parseGovernedLogCitationId(sourceId) != null;
}

/**
 * Format a governed identity from kind + canonical decimal id string.
 * Callers must pass a digit string already accepted by the parser.
 */
export function formatGovernedLogCitationId(
  kind: GovernedLogCitationKind,
  id: string,
): string {
  const prefix = kind === "event" ? LOG_EVENT_PREFIX : LOG_TEMPLATE_PREFIX;
  return `${prefix}${id}`;
}

/**
 * Convert a canonical u64 digit string to a JS number only when it is a
 * safe integer. Otherwise return null — never silent widening.
 *
 * `9007199254740993` must not become `9007199254740992`.
 */
export function governedIdToSafeInteger(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  if (id.length > 1 && id.startsWith("0")) return null;
  // Fast reject beyond safe-integer digit length / value without Number() widen.
  // Number.MAX_SAFE_INTEGER = 9007199254740991 (16 digits).
  const MAX_SAFE = "9007199254740991";
  if (id.length > MAX_SAFE.length) return null;
  if (id.length === MAX_SAFE.length && id > MAX_SAFE) return null;
  const n = Number(id);
  if (!Number.isSafeInteger(n)) return null;
  // Guard against any residual coercion mismatch (should be unreachable).
  if (String(n) !== id) return null;
  return n;
}

/**
 * Classify a citation id before any automatic I/O or Explorer reveal.
 * Governed/in-app identities must never be interpreted as workspace paths.
 *
 * Only the canonical `log_event:<u64>` / `log_template:<u64>` form routes as
 * `"log"`. Any other `log_event:` / `log_template:` prefix is `"invalid"`
 * (fail closed — never file I/O).
 */
export function classifyCompletedCitation(
  citationId: string,
): CompletedCitationRoute {
  const id = citationId.trim();
  if (!id || id.includes("\0")) return "invalid";
  if (parseHelpLocator(id)) return "help";
  if (parseGovernedLogCitationId(id)) return "log";

  if (
    id.startsWith("help://") ||
    id.startsWith(LOG_TEMPLATE_PREFIX) ||
    id.startsWith(LOG_EVENT_PREFIX)
  ) {
    return "invalid";
  }

  // These are handled only after an explicit citation click.
  if (/^https?:\/\//i.test(id) || /^memory:[a-z0-9._-]+$/i.test(id)) {
    return "deferred";
  }

  if (URI_SCHEME.test(id) && !WINDOWS_ABSOLUTE_PATH.test(id)) {
    return "invalid";
  }
  return "file";
}

/**
 * Parse a governed log_event identity into a sequence number when the id is a
 * JS safe integer. Returns null for non-governed forms or unsafe ranges
 * (callers must fail navigation visibly — do not Number()-coerce).
 */
export function parseLogEventSeq(sourceId: string): number | null {
  const parsed = parseGovernedLogCitationId(sourceId);
  if (!parsed || parsed.kind !== "event") return null;
  return governedIdToSafeInteger(parsed.id);
}

/**
 * Parse a governed log_template identity into a template id when the id is a
 * JS safe integer. Returns null for non-governed forms or unsafe ranges.
 */
export function parseLogTemplateId(sourceId: string): number | null {
  const parsed = parseGovernedLogCitationId(sourceId);
  if (!parsed || parsed.kind !== "template") return null;
  return governedIdToSafeInteger(parsed.id);
}

/**
 * Build a host exact-nav target from a governed citation id, or null when the
 * id is not a navigable governed form (callers fail visibly).
 */
export function governedCitationToNavTarget(
  sourceId: string,
): GovernedLogCitationId | null {
  return parseGovernedLogCitationId(sourceId);
}

/**
 * Open a persisted log citation against its host-authored corpus only (#698).
 * Never substitutes the chat's currently attached corpus when provenance is
 * missing or the original corpus is gone.
 *
 * When `openExplorerTarget` is provided, routes through the host exact-nav
 * command (validate corpus + target, one-shot deliver). Otherwise falls back
 * to open-only (legacy callers / tests).
 *
 * @returns `true` only when the host open path succeeded; callers must not
 * treat swallowed host errors as a successful open.
 */
export async function openPersistedLogCitation(
  sourceId: string,
  corpusId: string | undefined,
  showUnavailable: (sourceId: string, message: string) => void,
  openExplorer: (corpusId: string) => Promise<unknown>,
  openExplorerTarget?: (
    corpusId: string,
    target: GovernedLogCitationId,
  ) => Promise<unknown>,
): Promise<boolean> {
  if (!corpusId) {
    showUnavailable(
      sourceId,
      "This older log citation does not record its original corpus. ContextDesk will not substitute the chat’s current corpus.",
    );
    return false;
  }
  const target = parseGovernedLogCitationId(sourceId);
  if (!target) {
    showUnavailable(
      sourceId,
      "This log citation is not a canonical log_event:<id> or log_template:<id> identity and was not opened.",
    );
    return false;
  }
  try {
    if (openExplorerTarget) {
      await openExplorerTarget(corpusId, target);
    } else {
      await openExplorer(corpusId);
    }
    return true;
  } catch (error) {
    showUnavailable(
      sourceId,
      `The original log corpus for this citation is unavailable:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
