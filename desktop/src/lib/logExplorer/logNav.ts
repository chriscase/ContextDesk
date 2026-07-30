/** Opt-in log_nav parse + apply (mirrors cd-core view_context). */

import type { ExplorerFilters, LogNavAction, LogNavApplyResult } from "./types";

export type { LogNavAction, LogNavApplyResult };

/** Max UTF-8 byte length of a single candidate JSON object. */
export const LOG_NAV_MAX_PAYLOAD_BYTES = 4096;
/** Max validated actions accepted from one assistant message. */
export const LOG_NAV_MAX_ACTIONS = 8;

export type LogNavExtraction = {
  /** Validated flat log_nav actions (≤ LOG_NAV_MAX_ACTIONS). */
  actions: LogNavAction[];
  /** Assistant prose with machine JSON payloads removed. */
  displayText: string;
  /**
   * True when the text contained navigation-like JSON that could not be
   * validated (malformed, truncated, over-limit, or schema-invalid).
   */
  unreadableProposal: boolean;
};

const NAV_TYPE_HINT = /"type"\s*:\s*"log_nav"|"kind"\s*:\s*"log_nav"/;

export function parseLogNav(raw: unknown): LogNavAction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type ?? o.kind;
  if (type !== "log_nav") return null;
  const corpusId = String(o.corpusId ?? o.corpus_id ?? "");
  if (!corpusId) return null;
  // Strict flat schema: reject nested objects in known array fields.
  if (hasNestedObject(o.sources) || hasNestedObject(o.levels)) return null;
  if (hasNestedObject(o.highlightSeq ?? o.highlight_seq)) return null;
  return {
    type: "log_nav",
    corpusId,
    sources: arrStr(o.sources),
    levels: arrStr(o.levels),
    tsFrom: numOrNull(o.tsFrom ?? o.ts_from),
    tsTo: numOrNull(o.tsTo ?? o.ts_to),
    highlightSeq: arrNum(o.highlightSeq ?? o.highlight_seq),
    focusLane: strOrNull(o.focusLane ?? o.focus_lane),
    label: strOrNull(o.label),
  };
}

function hasNestedObject(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.some((item) => item !== null && typeof item === "object");
}

function arrStr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).filter(Boolean);
}

function arrNum(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s || null;
}

/** Pure merge — UI applies only when user clicks the chip. */
export function applyLogNav(
  current: ExplorerFilters,
  action: LogNavAction,
  expectedCorpusId: string,
): LogNavApplyResult {
  const corpusMatch = action.corpusId === expectedCorpusId;
  const filters: ExplorerFilters = { ...current };
  if (corpusMatch) {
    if (action.sources && action.sources.length > 0) {
      filters.sources = [...action.sources];
    }
    if (action.levels && action.levels.length > 0) {
      filters.levels = [...action.levels];
    }
    if (action.tsFrom != null) filters.timeFrom = action.tsFrom;
    if (action.tsTo != null) filters.timeTo = action.tsTo;
  }
  return {
    filters,
    highlightSeq: action.highlightSeq ?? [],
    focusLane: action.focusLane ?? null,
    label: action.label ?? null,
    corpusMatch,
  };
}

/**
 * Scan `text` for balanced `{…}` regions (string-aware, escape-aware).
 * Yields [start, endExclusive) spans of candidate JSON objects.
 */
function findBalancedObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let j = i;
    for (; j < text.length; j += 1) {
      const ch = text[j]!;
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          spans.push([start, j]);
          break;
        }
      }
    }
    if (depth !== 0) {
      // Truncated object starting at `start` — record as open-ended for unreadable detection.
      spans.push([start, text.length]);
      break;
    }
    i = j;
  }
  return spans;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function looksLikeLogNavJson(candidate: string): boolean {
  return NAV_TYPE_HINT.test(candidate);
}

/**
 * Extract + clean log_nav payloads from assistant text.
 *
 * - Bounded brace-aware scan (not non-nested regex).
 * - Strict flat schema via `parseLogNav`.
 * - Byte + action caps.
 * - Removes accepted machine payloads (and unreadable nav-like blobs) from display text.
 */
export function extractAndCleanLogNav(text: string): LogNavExtraction {
  const spans = findBalancedObjectSpans(text);
  const actions: LogNavAction[] = [];
  const remove: Array<[number, number]> = [];
  let unreadableProposal = false;
  let actionsCapped = false;

  for (const [start, end] of spans) {
    const candidate = text.slice(start, end);
    if (!looksLikeLogNavJson(candidate)) continue;

    const incomplete = !candidate.endsWith("}");
    const oversize = utf8Bytes(candidate) > LOG_NAV_MAX_PAYLOAD_BYTES;
    if (incomplete || oversize) {
      unreadableProposal = true;
      remove.push([start, end]);
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(candidate);
    } catch {
      unreadableProposal = true;
      remove.push([start, end]);
      continue;
    }

    const action = parseLogNav(parsedJson);
    if (!action) {
      unreadableProposal = true;
      remove.push([start, end]);
      continue;
    }

    if (actions.length >= LOG_NAV_MAX_ACTIONS) {
      actionsCapped = true;
      unreadableProposal = true;
      remove.push([start, end]);
      continue;
    }

    actions.push(action);
    remove.push([start, end]);
  }

  // Also catch truncated nav-like fragments that never opened a balanced object
  // fully (e.g. `{"type":"log_nav","corpusId":` at end of stream).
  if (!unreadableProposal && /"type"\s*:\s*"log_nav"/.test(text)) {
    const residual = stripRanges(text, remove);
    if (/"type"\s*:\s*"log_nav"/.test(residual)) {
      unreadableProposal = true;
    }
  }

  if (actionsCapped) {
    unreadableProposal = true;
  }

  const displayText = tidyProse(stripRanges(text, remove));
  return { actions, displayText, unreadableProposal };
}

/** Back-compat: validated actions only. */
export function extractLogNavFromText(text: string): LogNavAction[] {
  return extractAndCleanLogNav(text).actions;
}

/** Quiet copy when navigation-like output cannot be read. */
export const LOG_NAV_UNREADABLE_MESSAGE =
  "Navigation proposal could not be read.";

function stripRanges(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue;
    out += text.slice(cursor, start);
    // If removing an inline object would join two existing separator spaces,
    // consume only the second one. Do not normalize unrelated Markdown.
    cursor = out.endsWith(" ") && text[end] === " " ? end + 1 : end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Remove wrappers left behind by a fenced machine payload while preserving
 * ordinary Markdown whitespace, indentation, tables, and hard line breaks.
 */
function tidyProse(text: string): string {
  return text
    .replace(/```(?:json)?[ \t]*\n(?:[ \t]*\n)*[ \t]*```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
