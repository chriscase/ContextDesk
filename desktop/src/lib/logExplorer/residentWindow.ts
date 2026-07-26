/**
 * Bounded resident event window for bidirectional scroll paging (#538).
 * Pure helpers — no host I/O.
 */
import type { ExplorerEventDto } from "../host";

/** Max events kept in the browser for one lane (pages evict at the far end). */
export const DEFAULT_MAX_RESIDENT = 800;
/** Trigger load when within this many rows of an edge. */
export const EDGE_TRIGGER_ROWS = 24;

export type ResidentCursor = {
  afterSeq: number | null;
  afterTs: number | null;
  beforeSeq: number | null;
  beforeTs: number | null;
};

export type ResidentWindow = {
  events: ExplorerEventDto[];
  /** Newer-direction cursor (append). */
  afterSeq: number | null;
  afterTs: number | null;
  /** Older-direction cursor (prepend). */
  beforeSeq: number | null;
  beforeTs: number | null;
  totalMatched: number;
};

export function emptyResidentWindow(): ResidentWindow {
  return {
    events: [],
    afterSeq: null,
    afterTs: null,
    beforeSeq: null,
    beforeTs: null,
    totalMatched: 0,
  };
}

function eventKey(e: { seq: number; ts: number }): string {
  return `${e.ts}:${e.seq}`;
}

/** Merge pages without duplicates; keep ascending (ts, seq) order. */
export function mergeAscending(
  a: ExplorerEventDto[],
  b: ExplorerEventDto[],
): ExplorerEventDto[] {
  const map = new Map<string, ExplorerEventDto>();
  for (const e of a) map.set(eventKey(e), e);
  for (const e of b) map.set(eventKey(e), e);
  return [...map.values()].sort((x, y) =>
    x.ts !== y.ts ? x.ts - y.ts : x.seq - y.seq,
  );
}

/**
 * Append a newer page; drop oldest rows when over maxResident.
 * Returns the number of rows dropped from the head (for scroll compensation).
 */
export function appendNewer(
  win: ResidentWindow,
  page: {
    events: ExplorerEventDto[];
    nextCursor: number | null;
    nextTs?: number | null;
    prevCursor?: number | null;
    prevTs?: number | null;
    totalMatched: number;
  },
  maxResident = DEFAULT_MAX_RESIDENT,
): { window: ResidentWindow; droppedFromHead: number } {
  let events = mergeAscending(win.events, page.events);
  let droppedFromHead = 0;
  if (events.length > maxResident) {
    droppedFromHead = events.length - maxResident;
    events = events.slice(droppedFromHead);
  }
  const last = events[events.length - 1];
  const first = events[0];
  return {
    droppedFromHead,
    window: {
      events,
      afterSeq: page.nextCursor ?? (last ? last.seq : null),
      afterTs: page.nextTs ?? (last ? last.ts : null),
      // Keep ability to load older unless we never had a prev cursor and head is start.
      beforeSeq: first?.seq ?? win.beforeSeq,
      beforeTs: first?.ts ?? win.beforeTs,
      totalMatched: page.totalMatched || win.totalMatched,
    },
  };
}

/**
 * Prepend an older page; drop newest rows when over maxResident.
 * Returns prepended count for scroll anchor adjustment.
 */
export function prependOlder(
  win: ResidentWindow,
  page: {
    events: ExplorerEventDto[];
    nextCursor?: number | null;
    nextTs?: number | null;
    prevCursor?: number | null;
    prevTs?: number | null;
    totalMatched: number;
  },
  maxResident = DEFAULT_MAX_RESIDENT,
): { window: ResidentWindow; prepended: number } {
  const before = win.events.length;
  let events = mergeAscending(page.events, win.events);
  const prepended = Math.max(0, events.length - before);
  if (events.length > maxResident) {
    events = events.slice(0, maxResident);
  }
  const last = events[events.length - 1];
  const first = events[0];
  return {
    prepended,
    window: {
      events,
      afterSeq: last?.seq ?? win.afterSeq,
      afterTs: last?.ts ?? win.afterTs,
      beforeSeq:
        page.prevCursor !== undefined
          ? page.prevCursor
          : (first?.seq ?? null),
      beforeTs:
        page.prevTs !== undefined ? page.prevTs : (first?.ts ?? null),
      totalMatched: page.totalMatched || win.totalMatched,
    },
  };
}

/** Seed window from an initial/middle page. */
export function seedFromPage(
  page: {
    events: ExplorerEventDto[];
    nextCursor: number | null;
    nextTs?: number | null;
    prevCursor?: number | null;
    prevTs?: number | null;
    totalMatched: number;
  },
): ResidentWindow {
  const first = page.events[0];
  const last = page.events[page.events.length - 1];
  return {
    events: page.events,
    afterSeq: page.nextCursor ?? last?.seq ?? null,
    afterTs: page.nextTs ?? last?.ts ?? null,
    beforeSeq: page.prevCursor ?? first?.seq ?? null,
    beforeTs: page.prevTs ?? first?.ts ?? null,
    totalMatched: page.totalMatched,
  };
}

export function nearTop(scrollTop: number, rowH: number): boolean {
  return scrollTop <= EDGE_TRIGGER_ROWS * rowH;
}

export function nearBottom(
  scrollTop: number,
  clientH: number,
  scrollH: number,
  rowH: number,
): boolean {
  return scrollH - (scrollTop + clientH) <= EDGE_TRIGGER_ROWS * rowH;
}
