/** Opt-in log_nav parse + apply (mirrors cd-core view_context). */

import type { ExplorerFilters, LogNavAction, LogNavApplyResult } from "./types";

export type { LogNavAction, LogNavApplyResult };

export function parseLogNav(raw: unknown): LogNavAction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type ?? o.kind;
  if (type !== "log_nav") return null;
  const corpusId = String(o.corpusId ?? o.corpus_id ?? "");
  if (!corpusId) return null;
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

/** Extract log_nav JSON objects from assistant text (fenced or inline). */
export function extractLogNavFromText(text: string): LogNavAction[] {
  const out: LogNavAction[] = [];
  const re = /\{[^{}]*"type"\s*:\s*"log_nav"[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = parseLogNav(JSON.parse(m[0]));
      if (parsed) out.push(parsed);
    } catch {
      /* ignore */
    }
  }
  return out;
}
