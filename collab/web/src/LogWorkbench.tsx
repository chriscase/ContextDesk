/**
 * Log workbench — investigation-owned log exploration on Analyze.
 *
 * Evidence listed here is this investigation's intake, not the global Attribution
 * catalog. Technical ids stay behind a disclosure. Rendering is a bounded
 * window over paged rows; imported text is always a text node.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TechnicalIdentifiers } from "./technical-identity.js";
import { protectedApiFetch } from "./protected-api.js";
import { focusVisibleSectionTarget } from "./route-focus.js";

export function virtualizedWindow(input: {
  totalRows: number;
  scrollTop: number;
  rowHeight: number;
  viewportHeight: number;
  overscan: number;
}): { start: number; end: number; resident: number } {
  const rowHeight = Math.max(1, input.rowHeight);
  const overscan = Math.max(0, input.overscan);
  const start = Math.max(0, Math.floor(input.scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(input.viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(input.totalRows, start + visible);
  return { start, end, resident: Math.max(0, end - start) };
}

/**
 * Virtual rows must have a real, enforced height. Log text stays on one visual
 * line inside a horizontally scrollable pane, so spacer math and match reveal
 * offsets cannot drift when a long record is shown in a narrow pane.
 */
const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 360;
const OVERSCAN = 6;
const MAX_PANES = 4;
/** Lines of lead-in kept above a revealed match so it has visible context. */
const PAGE_LEAD_LINES = 10;
/** File-picker row height matches the checkbox row min-height in CSS. */
const FILE_ROW_HEIGHT = 40;
const FILE_VIEWPORT_HEIGHT = 320;
const FILE_OVERSCAN = 6;
/** Above this many matching files, only a window of rows stays in the DOM. */
const FILE_VIRTUALIZE_AFTER = 24;

interface InventoryItem {
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  displayLabel: string;
  digest: string;
  intakeBatchId: string | null;
  privacyClass: string;
  lineCount: number;
  fullyRead?: boolean;
}

interface MatchRow {
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  lineNumber: number;
  byteOffset: number;
  text: string;
  wrapped: boolean;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
  parseClass: string;
  contextBefore: string[];
  contextAfter: string[];
}

interface SearchResult {
  matches: MatchRow[];
  returned: number;
  bounded: boolean;
  atLeast: number;
  nextCursor: number | null;
  /** Position to resume at. Advancing it can never skip an unreached match. */
  nextPageCursor?: string | null;
  cancelled?: boolean;
  corpusTruncated?: boolean;
  /** True once every line in the selected files has been searched. */
  coverageComplete?: boolean;
  scannedLines?: number;
  scannedLinesTotal?: number;
  scopeFileCount?: number;
  timeFilterUnknownReason: string | null;
  timeAuthorityUnavailableReason?: string | null;
}

interface PageResult {
  evidenceId: string;
  relativePath: string;
  startLine: number;
  rows: MatchRow[];
  wrappedRowCount: number;
  nextStartLine: number | null;
  bounded: boolean;
}

interface SavedView {
  id: string;
  name: string;
  selectedPanes: string[];
  query: string;
  mode: string;
  filters?: {
    includeTerms?: string[];
    excludeTerms?: string[];
    severity?: string | null;
    timeFrom?: string | null;
    timeTo?: string | null;
  };
  timeFrom?: string | null;
  timeTo?: string | null;
  sort?: string;
  grouping?: string;
  display?: { syncScroll?: boolean; wrap?: boolean; displayTimezone?: string | null };
}

interface BookmarkRow {
  id: string;
  note: string;
  status: string;
  staleReason: string | null;
  locator: { evidenceId: string; lineNumber: number };
  shareSafeToken: string;
}

interface ChronologyEvent {
  evidenceId?: string;
  relativePath: string;
  lineNumber: number;
  excerpt: string;
  adjacencyReason: string;
  uncertainty: string[];
  correlationKind: string;
  correlationId: string | null;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
  groupKey?: string;
  anchorStatus?: string | null;
}

function chronologyTime(event: ChronologyEvent): { label: string; value: string | null } {
  if (event.normalizedUtc) return { label: "Normalized UTC", value: event.normalizedUtc };
  if (event.originalTimestamp) {
    return { label: "Unresolved local time", value: event.originalTimestamp };
  }
  return { label: "Order only", value: null };
}

/**
 * One sentence a responder can act on. A partial answer never reads as a
 * complete one: a stopped scan, a cancelled scan, and a corpus that was too
 * large to read to the end each say so in plain words.
 */
function searchSummary(
  result: SearchResult,
  total: number,
  corpusTruncated: boolean,
): string {
  const shown = `Showing ${total.toLocaleString()}`;
  const scanned = (result.scannedLinesTotal ?? result.scannedLines ?? 0).toLocaleString();
  if (result.cancelled) {
    return `${shown} of at least ${result.atLeast.toLocaleString()} matches. The search stopped early, so later matches were not counted.`;
  }
  if (result.corpusTruncated || corpusTruncated) {
    return `${shown} matches so far. Some of the selected files could not be read, so matches inside them were not counted.`;
  }
  // Coverage and match count are separate truths. A page can be full of
  // matches and still have lines left to read, and it can find nothing and
  // still have lines left to read — the reader needs to be told which.
  if (result.coverageComplete === false) {
    return result.returned === 0
      ? `No matches in the first ${scanned} lines searched. There are more selected lines to search — continue to cover the rest.`
      : `${shown} matches in the first ${scanned} lines searched. There are more selected lines to search — continue to cover the rest.`;
  }
  const covered = `Every selected line was searched (${scanned} lines).`;
  // "Load more" is offered exactly when there is a page to load. Tying it to
  // `bounded` promised more on the last page of a multi-page walk, where
  // `bounded` is still true only because the cumulative count exceeds what
  // this one page returned.
  if (result.nextPageCursor) {
    return `${shown} of ${result.atLeast.toLocaleString()} matches. ${covered} Load more to see the rest.`;
  }
  return `${total.toLocaleString()} match${total === 1 ? "" : "es"}. ${covered}`;
}

/**
 * Group keys are machine identities (an intake batch id, an observed request
 * id). The primary line stays readable; the raw value stays behind technical
 * details.
 */
function groupLabel(grouping: string, groupKey: string): string | null {
  if (grouping === "none" || !groupKey || groupKey === "ungrouped") return null;
  if (grouping === "batch") {
    return groupKey === "no-batch" ? "Not part of an intake batch" : "Same intake batch";
  }
  if (grouping === "entity") {
    return groupKey === "no-observed-id"
      ? "No observed identifier on this line"
      : `Observed id ${groupKey}`;
  }
  if (grouping === "severity") return `Severity ${groupKey}`;
  return groupKey;
}

/**
 * File picker filter for 3, 30, and 300 files: match the human label or the
 * relative path, never an evidence id.
 */
export function filterInvestigationLogs<T extends { displayLabel: string; relativePath: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter(
    (item) =>
      item.displayLabel.toLowerCase().includes(needle)
      || item.relativePath.toLowerCase().includes(needle),
  );
}

/** Search hits grouped by file so a 50-match page is scannable, not a flat dump. */
export function groupSearchMatches<T extends { relativePath: string }>(
  matches: readonly T[],
): { relativePath: string; displayLabel: string; entries: { row: T; index: number }[] }[] {
  const groups: {
    relativePath: string;
    displayLabel: string;
    entries: { row: T; index: number }[];
  }[] = [];
  const indexByPath = new Map<string, number>();
  matches.forEach((row, index) => {
    let groupIndex = indexByPath.get(row.relativePath);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      indexByPath.set(row.relativePath, groupIndex);
      const slash = row.relativePath.lastIndexOf("/");
      groups.push({
        relativePath: row.relativePath,
        displayLabel: slash >= 0 ? row.relativePath.slice(slash + 1) : row.relativePath,
        entries: [],
      });
    }
    groups[groupIndex]!.entries.push({ row, index });
  });
  return groups;
}

/** Count of advanced filters that differ from the novice defaults. */
export function countAdvancedFilters(input: {
  mode: string;
  include: string;
  exclude: string;
  severity: string;
  timeFrom: string;
  timeTo: string;
}): number {
  return [
    input.mode !== "case_insensitive",
    input.include.trim().length > 0,
    input.exclude.trim().length > 0,
    input.severity.trim().length > 0,
    input.timeFrom.trim().length > 0,
    input.timeTo.trim().length > 0,
  ].filter(Boolean).length;
}

/** Stable, bounded key: same name and same view content replay as one save. */
function viewIdempotencyKey(name: string, content: unknown): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "view";
  const serialized = JSON.stringify(content);
  let hash = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = (Math.imul(hash, 31) + serialized.charCodeAt(index)) | 0;
  }
  return `view-${slug}-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

function errorText(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: { error?: string }) =>
      typeof body.error === "string" && body.error.trim() ? body.error : fallback,
    )
    .catch(() => fallback);
}

export function LogWorkbench(props: {
  caseId: string;
  canWrite: boolean;
  readOnly: boolean;
  /** When false, Analyze is still in the DOM but hidden — wait to fetch. */
  active?: boolean;
}) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "unauthorized">("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"literal" | "case_insensitive" | "regex">("case_insensitive");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [severity, setSeverity] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [panes, setPanes] = useState<string[]>([]);
  const [syncScroll, setSyncScroll] = useState(true);
  const [grouping, setGrouping] = useState("file");
  const [sort, setSort] = useState("time_asc");
  const [pageByPane, setPageByPane] = useState<Record<string, PageResult>>({});
  const [scrollByPane, setScrollByPane] = useState<Record<string, number>>({});
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("Timeout window");
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const [chronology, setChronology] = useState<ChronologyEvent[] | null>(null);
  const [unknownBuckets, setUnknownBuckets] = useState<{ category: string; count: number; detail: string }[]>([]);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [corpusTruncated, setCorpusTruncated] = useState(false);
  const [unreadFiles, setUnreadFiles] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [chronologyBusy, setChronologyBusy] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [fileScrollTop, setFileScrollTop] = useState(0);
  const liveRef = useRef<HTMLParagraphElement>(null);
  /** Panes already read once, so a selection change does not re-page them. */
  const loadedPanes = useRef<Set<string>>(new Set());
  /** The first available file is selected once per investigation, never after an explicit clear. */
  const defaultPaneCase = useRef<string | null>(null);
  /** Latest pane selection for async inventory reconciliation. */
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  /** Async continuations must still belong to the mounted investigation. */
  const currentCaseIdRef = useRef(props.caseId);
  currentCaseIdRef.current = props.caseId;
  const mountedRef = useRef(true);
  const loadedCaseRef = useRef<string | null>(null);
  /** Ignore async results that were started against an obsolete file selection. */
  const searchRequestGeneration = useRef(0);
  const chronologyRequestGeneration = useRef(0);
  const loadRequestGeneration = useRef(0);
  const pageScopeGeneration = useRef(0);
  const pageRequestByEvidence = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrentCase = useCallback(
    (caseId: string) => mountedRef.current && currentCaseIdRef.current === caseId,
    [],
  );

  const invalidateSearchResults = useCallback(() => {
    searchRequestGeneration.current += 1;
    setSearch(null);
    setSearching(false);
    setError(null);
    setNotice(null);
  }, []);

  const invalidateChronologyResults = useCallback(() => {
    chronologyRequestGeneration.current += 1;
    setChronology(null);
    setUnknownBuckets([]);
    setChronologyBusy(false);
    setError(null);
    setNotice(null);
  }, []);

  const invalidateScopedResults = useCallback(() => {
    searchRequestGeneration.current += 1;
    chronologyRequestGeneration.current += 1;
    setSearch(null);
    setChronology(null);
    setUnknownBuckets([]);
    setSearching(false);
    setChronologyBusy(false);
    setError(null);
    setNotice(null);
  }, []);

  const invalidateEvidencePages = useCallback(() => {
    pageScopeGeneration.current += 1;
    pageRequestByEvidence.current.clear();
    loadedPanes.current.clear();
    setPageByPane({});
  }, []);

  const selectedItems = useMemo(
    () => items.filter((item) => panes.includes(item.evidenceId)),
    [items, panes],
  );
  const filteredItems = useMemo(
    () => filterInvestigationLogs(items, fileQuery),
    [items, fileQuery],
  );
  const virtualizeFiles = filteredItems.length > FILE_VIRTUALIZE_AFTER;
  const fileWindow = virtualizedWindow({
    totalRows: filteredItems.length,
    scrollTop: fileScrollTop,
    rowHeight: FILE_ROW_HEIGHT,
    viewportHeight: FILE_VIEWPORT_HEIGHT,
    overscan: FILE_OVERSCAN,
  });
  const visibleFiles = virtualizeFiles
    ? filteredItems.slice(fileWindow.start, fileWindow.end)
    : filteredItems;
  const advancedOn = countAdvancedFilters({
    mode,
    include,
    exclude,
    severity,
    timeFrom,
    timeTo,
  });

  useEffect(() => {
    setFileScrollTop(0);
  }, [fileQuery]);

  const load = useCallback(async (options?: { invalidateResults?: boolean }) => {
    const requestCaseId = props.caseId;
    if (!isCurrentCase(requestCaseId)) return;
    const requestGeneration = ++loadRequestGeneration.current;
    if (options?.invalidateResults) {
      invalidateScopedResults();
      invalidateEvidencePages();
    }
    if (loadedCaseRef.current !== requestCaseId) {
      loadedCaseRef.current = requestCaseId;
      setItems([]);
      setPanes([]);
      setPageByPane({});
      setScrollByPane({});
      setViews([]);
      setBookmarks([]);
      setReviewCount(null);
      setRevision(null);
      setCorpusTruncated(false);
      setUnreadFiles([]);
    }
    setLoadState("loading");
    setError(null);
    loadedPanes.current.clear();
    try {
      const response = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench`);
      if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
      if (response.status === 401 || response.status === 403) {
        setLoadState("unauthorized");
        return;
      }
      if (!response.ok) {
        const message = await errorText(response, "The log workbench could not be loaded.");
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        setError(message);
        setLoadState("error");
        return;
      }
      const body = (await response.json()) as {
        items?: InventoryItem[];
        normalizationRevision?: number | null;
        corpusTruncated?: boolean;
        unreadFiles?: string[];
      };
      if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
      const nextRevision = body.normalizationRevision ?? null;
      if (!options?.invalidateResults && revisionRef.current !== nextRevision) {
        invalidateScopedResults();
        invalidateEvidencePages();
      }
      const nextItems = body.items ?? [];
      const availableIds = new Set(nextItems.map((item) => item.evidenceId));
      if (panesRef.current.some((id) => !availableIds.has(id))) {
        invalidateScopedResults();
      }
      setItems(nextItems);
      setPanes((current) => {
        const valid = current.filter((id) => availableIds.has(id));
        if (defaultPaneCase.current !== props.caseId && nextItems.length > 0) {
          defaultPaneCase.current = props.caseId;
          return valid.length > 0 ? valid : [nextItems[0]!.evidenceId];
        }
        return valid;
      });
      setRevision(nextRevision);
      setCorpusTruncated(body.corpusTruncated === true);
      setUnreadFiles(body.unreadFiles ?? []);
      setLoadState("ready");
      try {
        const viewsRes = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench/views`);
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        if (viewsRes.ok) {
          const parsed = (await viewsRes.json()) as { views?: SavedView[] };
          if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
          setViews(parsed.views ?? []);
        } else setViews([]);
      } catch {
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        setViews([]);
      }
      try {
        const bookmarksRes = await protectedApiFetch(
          `/api/cases/${requestCaseId}/workbench/bookmarks`,
        );
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        if (bookmarksRes.ok) {
          const parsed = (await bookmarksRes.json()) as { bookmarks?: BookmarkRow[] };
          if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
          setBookmarks(parsed.bookmarks ?? []);
        } else setBookmarks([]);
      } catch {
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        setBookmarks([]);
      }
      try {
        const queueRes = await protectedApiFetch(
          `/api/cases/${requestCaseId}/workbench/review-queue`,
        );
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        if (queueRes.ok) {
          const parsed = (await queueRes.json()) as { candidateCount?: number };
          if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
          setReviewCount(parsed.candidateCount ?? 0);
        } else setReviewCount(null);
      } catch {
        if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
        setReviewCount(null);
      }
    } catch {
      if (!isCurrentCase(requestCaseId) || loadRequestGeneration.current !== requestGeneration) return;
      setError("The log workbench could not be loaded.");
      setLoadState("error");
    }
  }, [invalidateEvidencePages, invalidateScopedResults, isCurrentCase, props.caseId]);

  useEffect(() => {
    if (props.active === false) {
      // Analyze remains mounted while another investigation stage is visible.
      // Fence every continuation that began before the stage was hidden so a
      // delayed inventory, search, chronology, or pane reply cannot repopulate
      // state that will be exposed briefly on the next activation.
      loadRequestGeneration.current += 1;
      invalidateScopedResults();
      invalidateEvidencePages();
      return;
    }
    void load({ invalidateResults: true });
  }, [invalidateEvidencePages, invalidateScopedResults, load, props.active]);

  useEffect(() => {
    const reload = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: string }>).detail;
      if (detail?.caseId && detail.caseId !== props.caseId) return;
      if (props.active === false) return;
      void load({ invalidateResults: true });
    };
    window.addEventListener("contextdesk:corpus-intake-committed", reload);
    window.addEventListener("contextdesk:snapshot-frozen", reload);
    // Evidence can also arrive through the board beside this panel on Analyze.
    window.addEventListener("contextdesk:evidence-changed", reload);
    window.addEventListener("contextdesk:log-time-changed", reload);
    return () => {
      window.removeEventListener("contextdesk:corpus-intake-committed", reload);
      window.removeEventListener("contextdesk:snapshot-frozen", reload);
      window.removeEventListener("contextdesk:evidence-changed", reload);
      window.removeEventListener("contextdesk:log-time-changed", reload);
    };
  }, [load, props.active, props.caseId]);

  const loadPane = useCallback(
    async (evidenceId: string, startLine = 1) => {
      const requestCaseId = props.caseId;
      if (!isCurrentCase(requestCaseId)) return;
      const requestScopeGeneration = pageScopeGeneration.current;
      const requestSequence = (pageRequestByEvidence.current.get(evidenceId) ?? 0) + 1;
      pageRequestByEvidence.current.set(evidenceId, requestSequence);
      loadedPanes.current.add(evidenceId);
      try {
        const response = await protectedApiFetch(
          `/api/cases/${requestCaseId}/workbench/page?evidenceId=${encodeURIComponent(evidenceId)}&startLine=${startLine}&limit=80`,
        );
        if (
          !isCurrentCase(requestCaseId) ||
          pageScopeGeneration.current !== requestScopeGeneration ||
          pageRequestByEvidence.current.get(evidenceId) !== requestSequence
        ) return;
        if (!response.ok) return;
        const page = (await response.json()) as PageResult;
        if (
          !isCurrentCase(requestCaseId) ||
          pageScopeGeneration.current !== requestScopeGeneration ||
          pageRequestByEvidence.current.get(evidenceId) !== requestSequence
        ) return;
        setPageByPane((current) => ({ ...current, [evidenceId]: page }));
      } catch {
        /* unmount or test teardown */
      }
    },
    [isCurrentCase, props.caseId],
  );

  // Only panes that have never been read are opened at line 1. Re-reading them
  // whenever the selection changes would throw away where the reader had paged
  // to — including the window a revealed search match just loaded.
  useEffect(() => {
    for (const id of panes) {
      if (loadedPanes.current.has(id)) continue;
      void loadPane(id);
    }
  }, [panes, items, loadPane]);

  /**
   * Open the match. A hit list that only highlights rows already on screen is
   * not navigation: the responder clicks a line at 4,200 and nothing moves.
   * Selecting a match opens its file, pages to a window containing the line,
   * and scrolls that pane to it.
   */
  const revealMatch = useCallback(
    async (row: MatchRow) => {
      const requestCaseId = props.caseId;
      if (!isCurrentCase(requestCaseId)) return;
      if (!panes.includes(row.evidenceId)) {
        if (panes.length >= MAX_PANES) {
          // Bookmark navigation follows the same visible contract as the file
          // selector. Do not fetch and scroll a hidden fifth pane, and do not
          // invalidate results whose four-file scope has not changed.
          setNotice(
            `Only ${MAX_PANES} files can be open side by side. Clear one to open another.`,
          );
          return;
        }
        // A bookmark may point into a file outside the current pane scope.
        // Opening it expands both the search and chronology corpus, so results
        // that described the previous scope must disappear before the pane is
        // added just as they do for an explicit selector change.
        invalidateScopedResults();
        setPanes((current) =>
          current.includes(row.evidenceId) ? current : [...current, row.evidenceId],
        );
      }
      const page = pageByPane[row.evidenceId];
      const inWindow =
        page && page.rows.some((candidate) => candidate.lineNumber === row.lineNumber);
      if (!inWindow) {
        await loadPane(row.evidenceId, Math.max(1, row.lineNumber - PAGE_LEAD_LINES));
        if (!isCurrentCase(requestCaseId)) return;
      }
      const start = Math.max(1, row.lineNumber - PAGE_LEAD_LINES);
      const offset = Math.max(
        0,
        (row.lineNumber - start) * ROW_HEIGHT - VIEWPORT_HEIGHT / 3,
      );
      // Synchronized scrolling is the reader's choice, so revealing a match
      // moves the shared position rather than quietly switching it off.
      if (syncScroll) setScrollTop(offset);
      setScrollByPane((current) => ({ ...current, [row.evidenceId]: offset }));
    },
    [
      invalidateScopedResults,
      isCurrentCase,
      loadPane,
      pageByPane,
      panes,
      props.caseId,
      syncScroll,
    ],
  );

  function selectMatch(index: number) {
    setMatchIndex(index);
    const row = search?.matches[index];
    if (row) void revealMatch(row);
  }

  function togglePane(evidenceId: string) {
    if (panes.includes(evidenceId)) {
      invalidateScopedResults();
      setPanes((current) => current.filter((id) => id !== evidenceId));
      return;
    }
    if (panes.length >= MAX_PANES) {
      setNotice(
        `Only ${MAX_PANES} files can be open side by side. Clear one to open another.`,
      );
      return;
    }
    invalidateScopedResults();
    setPanes((current) =>
      current.includes(evidenceId) ? current : [...current, evidenceId],
    );
  }

  const searchFilters = useCallback(
    () => ({
      includeTerms: include.trim() ? [include.trim()] : [],
      excludeTerms: exclude.trim() ? [exclude.trim()] : [],
      severity: severity.trim() || null,
      component: null,
      file: null,
      rotationFamily: null,
      timeFrom: timeFrom.trim() || null,
      timeTo: timeTo.trim() || null,
      evidenceIds: panes,
    }),
    [include, exclude, severity, timeFrom, timeTo, panes],
  );

  /**
   * Continue where the last page stopped.
   *
   * `pageCursor` names a position in the corpus, so a page that searched
   * 50,000 lines without a match still leaves the next line reachable. The
   * older `cursor` is a match ordinal and cannot express that, so it is only
   * used to start over from the beginning.
   */
  async function runSearch(pageCursor: string | null = null) {
    const requestCaseId = props.caseId;
    if (!isCurrentCase(requestCaseId)) return;
    if (panes.length === 0) {
      setNotice("Select at least one log file before searching.");
      return;
    }
    const requestGeneration = ++searchRequestGeneration.current;
    setError(null);
    setSearching(true);
    try {
      const response = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: "cd-collab.log_workbench_search_request.v1",
          query,
          mode,
          filters: searchFilters(),
          contextBefore: 1,
          contextAfter: 1,
          cursor: 0,
          pageCursor,
          limit: 50,
          expectedNormalizationRevision: revision,
        }),
      });
      if (!isCurrentCase(requestCaseId)) return;
      if (!response.ok) {
        const message = await errorText(response, "Search could not run.");
        if (isCurrentCase(requestCaseId) && searchRequestGeneration.current === requestGeneration) setError(message);
        return;
      }
      const result = (await response.json()) as SearchResult;
      if (!isCurrentCase(requestCaseId) || searchRequestGeneration.current !== requestGeneration) return;
      const previous = pageCursor && search ? search.matches : [];
      const merged = { ...result, matches: [...previous, ...result.matches] };
      setSearch(merged);
      if (!pageCursor) setMatchIndex(0);
      setNotice(searchSummary(result, merged.matches.length, corpusTruncated));
    } finally {
      if (isCurrentCase(requestCaseId) && searchRequestGeneration.current === requestGeneration) setSearching(false);
    }
  }

  async function runChronology() {
    const requestCaseId = props.caseId;
    if (!isCurrentCase(requestCaseId)) return;
    if (panes.length === 0) {
      setNotice("Select at least one log file before building a chronology.");
      return;
    }
    const requestGeneration = ++chronologyRequestGeneration.current;
    setChronologyBusy(true);
    try {
      const response = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench/chronology`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grouping, evidenceIds: panes }),
      });
      if (!isCurrentCase(requestCaseId)) return;
      if (!response.ok) {
        const message = await errorText(response, "The merged chronology could not be built.");
        if (isCurrentCase(requestCaseId) && chronologyRequestGeneration.current === requestGeneration) setError(message);
        return;
      }
      const body = (await response.json()) as {
        events?: ChronologyEvent[];
        unknownBuckets?: { category: string; count: number; detail: string }[];
        bounded?: boolean;
        atLeast?: number;
      };
      if (!isCurrentCase(requestCaseId) || chronologyRequestGeneration.current !== requestGeneration) return;
      setChronology(body.events ?? []);
      setUnknownBuckets(body.unknownBuckets ?? []);
      setNotice(
        body.bounded
          ? `Showing the first ${(body.events ?? []).length.toLocaleString()} of ${(body.atLeast ?? 0).toLocaleString()} lines in this chronology.`
          : `Merged chronology built from ${(body.events ?? []).length.toLocaleString()} lines.`,
      );
    } finally {
      if (isCurrentCase(requestCaseId) && chronologyRequestGeneration.current === requestGeneration) setChronologyBusy(false);
    }
  }

  async function pinEvent(event: ChronologyEvent, status: "pinned" | "human_ground_truth") {
    if (props.readOnly || !props.canWrite || !event.evidenceId) return;
    const requestCaseId = props.caseId;
    if (!isCurrentCase(requestCaseId)) return;
    const response = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench/anchors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidenceId: event.evidenceId,
        lineNumber: event.lineNumber,
        status,
        note: status === "human_ground_truth" ? "Recorded as human ground truth." : "",
        idempotencyKey: `anchor-${event.evidenceId.slice(0, 8)}-${event.lineNumber}-${status}`,
      }),
    });
    if (!isCurrentCase(requestCaseId)) return;
    if (!response.ok) {
      const message = await errorText(response, "The chronology pin could not be saved.");
      if (isCurrentCase(requestCaseId)) setError(message);
      return;
    }
    setNotice(status === "human_ground_truth" ? "Ground truth recorded." : "Benchmark pin recorded.");
    await runChronology();
  }

  async function saveView() {
    if (props.readOnly || !props.canWrite) return;
    if (panes.length === 0) {
      setNotice("Select at least one log file before saving a view.");
      return;
    }
    const requestCaseId = props.caseId;
    if (!isCurrentCase(requestCaseId)) return;
    const response = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench/views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: viewName.trim() || "Saved view",
        filters: {
          includeTerms: include.trim() ? [include.trim()] : [],
          excludeTerms: exclude.trim() ? [exclude.trim()] : [],
          severity: severity.trim() || null,
          component: null,
          file: null,
          rotationFamily: null,
          timeFrom: timeFrom.trim() || null,
          timeTo: timeTo.trim() || null,
          evidenceIds: panes,
        },
        query,
        mode,
        selectedPanes: panes,
        timeFrom: timeFrom.trim() || null,
        timeTo: timeTo.trim() || null,
        sort,
        grouping,
        display: {
          syncScroll,
          wrap: false,
          lineNumbers: true,
          displayTimezone: "UTC",
        },
        contextBefore: 1,
        contextAfter: 1,
        // The key covers the name *and* what the view actually holds, so
        // re-saving the same view replays instead of erroring, while the same
        // name over changed filters records a new view rather than a conflict.
        idempotencyKey: viewIdempotencyKey(viewName, {
          query,
          mode,
          include,
          exclude,
          severity,
          timeFrom,
          timeTo,
          panes,
          sort,
          grouping,
          syncScroll,
        }),
      }),
    });
    if (!isCurrentCase(requestCaseId)) return;
    if (!response.ok) {
      const message = await errorText(response, "The view could not be saved.");
      if (isCurrentCase(requestCaseId)) setError(message);
      return;
    }
    setNotice(`Saved view “${viewName.trim() || "Saved view"}” recorded for this investigation.`);
    await load();
  }

  async function saveBookmark(row: MatchRow) {
    if (props.readOnly || !props.canWrite) return;
    const requestCaseId = props.caseId;
    if (!isCurrentCase(requestCaseId)) return;
    const item = items.find((entry) => entry.evidenceId === row.evidenceId);
    const response = await protectedApiFetch(`/api/cases/${requestCaseId}/workbench/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        locator: {
          evidenceId: row.evidenceId,
          digestAtBind: item?.digest,
          byteOffset: row.byteOffset,
          lineNumber: row.lineNumber,
          originalTimestamp: row.originalTimestamp,
          normalizedUtc: row.normalizedUtc,
          corpusRevision: revision,
        },
        note: `Line ${row.lineNumber} in ${row.relativePath}`,
        idempotencyKey: `bookmark-${row.evidenceId.slice(0, 8)}-${row.lineNumber}`,
      }),
    });
    if (!isCurrentCase(requestCaseId)) return;
    if (!response.ok) {
      const message = await errorText(response, "The bookmark could not be saved.");
      if (isCurrentCase(requestCaseId)) setError(message);
      return;
    }
    setNotice("Bookmark recorded.");
    await load();
  }

  function applyView(view: SavedView) {
    invalidateScopedResults();
    setPanes(view.selectedPanes.slice(0, MAX_PANES));
    setQuery(view.query);
    setMode((view.mode as typeof mode) || "case_insensitive");
    setInclude(view.filters?.includeTerms?.[0] ?? "");
    setExclude(view.filters?.excludeTerms?.[0] ?? "");
    setSeverity(view.filters?.severity ?? "");
    setTimeFrom(view.timeFrom ?? view.filters?.timeFrom ?? "");
    setTimeTo(view.timeTo ?? view.filters?.timeTo ?? "");
    setSort(view.sort || "time_asc");
    setGrouping(view.grouping || "file");
    setSyncScroll(view.display?.syncScroll ?? true);
    setNotice(`Applied saved view “${view.name}”.`);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void runSearch();
    }
    if (event.key === "Escape") {
      invalidateSearchResults();
      setQuery("");
    }
    if (event.key === "F3" || ((event.key === "g" || event.key === "G") && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      if (!search || search.matches.length === 0) return;
      const count = search.matches.length;
      selectMatch(
        event.shiftKey ? (matchIndex - 1 + count) % count : (matchIndex + 1) % count,
      );
    }
  }

  function onScroll(event: { currentTarget: HTMLDivElement }) {
    const paneId = event.currentTarget.getAttribute("data-workbench-pane");
    const next = event.currentTarget.scrollTop;
    if (paneId) {
      setScrollByPane((current) => ({ ...current, [paneId]: next }));
    }
    setScrollTop(next);
    if (syncScroll) {
      const panesEl = event.currentTarget.parentElement?.querySelectorAll("[data-workbench-pane]");
      panesEl?.forEach((node) => {
        if (node !== event.currentTarget) (node as HTMLDivElement).scrollTop = next;
      });
    }
  }

  if (loadState === "loading") {
    return (
      <section
        className="log-workbench"
        id="log-workbench"
        aria-labelledby="log-workbench-heading"
        aria-busy="true"
      >
        <header className="log-workbench__head">
          <h4 id="log-workbench-heading">Log workbench</h4>
          <p className="log-workbench__lede" role="status">
            Loading this investigation’s logs…
          </p>
        </header>
      </section>
    );
  }
  if (loadState === "unauthorized") {
    return (
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <header className="log-workbench__head">
          <h4 id="log-workbench-heading">Log workbench</h4>
          <p className="log-workbench__error" role="alert">
            You do not have access to this investigation’s logs.
          </p>
        </header>
      </section>
    );
  }
  if (loadState === "error") {
    return (
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <header className="log-workbench__head">
          <h4 id="log-workbench-heading">Log workbench</h4>
          <p className="log-workbench__error" role="alert">
            {error}
          </p>
        </header>
        <button type="button" onClick={() => void load({ invalidateResults: true })}>
          Try again
        </button>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <header className="log-workbench__head">
          <h4 id="log-workbench-heading">Log workbench</h4>
          <p className="log-workbench__lede">
            This investigation has no imported logs yet. Add files, a ZIP, or a directory on
            Capture — those files stay with this investigation, not in the shared Attribution
            catalog.
          </p>
        </header>
      </section>
    );
  }

  const activeMatch = search?.matches[matchIndex] ?? null;
  const matchGroups = search ? groupSearchMatches(search.matches) : [];

  return (
    <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
      <header className="log-workbench__head">
        <h4 id="log-workbench-heading">Log workbench</h4>
        <p className="log-workbench__lede">
          Read the logs that belong to this investigation, side by side. Capture is
          where files arrive; Analyze is where you search them; Compare and Decide
          freeze and record the call.
        </p>
      </header>
      {corpusTruncated ? (
        <p className="log-workbench__notice" role="status">
          Some of this investigation&rsquo;s files could not be read
          {unreadFiles.length > 0 ? ` (${unreadFiles.slice(0, 3).join(", ")}${unreadFiles.length > 3 ? ", and others" : ""})` : ""}
          . Counts and searches below leave those files out — re-commit them on
          Capture to include them.
        </p>
      ) : null}
      {reviewCount && reviewCount > 0 ? (
        <p className="log-workbench__notice">
          {reviewCount.toLocaleString()} lines still have a clock but no timezone.{" "}
          <a
            href="#triage-log-time"
            onClick={(event) => {
              if (
                event.button !== 0
                || event.metaKey
                || event.ctrlKey
                || event.shiftKey
                || event.altKey
              ) return;
              event.preventDefault();
              window.history.pushState(
                window.history.state,
                "",
                `${window.location.pathname}${window.location.search}#triage-log-time`,
              );
              focusVisibleSectionTarget("triage-log-time");
            }}
          >
            Open Timezone review
          </a>{" "}to declare a zone — nothing
          here will guess one.
        </p>
      ) : null}
      <p ref={liveRef} className="log-workbench__live" role="status" aria-live="polite">
        {notice}
      </p>
      {error ? (
        <p className="log-workbench__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="log-workbench__files" role="group" aria-label="Investigation logs">
        <div className="log-workbench__files-head">
          <div>
            <strong>Choose log files</strong>
            <span>
              Filter by name or path, then tick up to {MAX_PANES} files to open them side by
              side.
            </span>
          </div>
          <span className="log-workbench__muted">
            {fileQuery.trim()
              ? `${filteredItems.length.toLocaleString()} of ${items.length.toLocaleString()} files match`
              : `${items.length.toLocaleString()} ${items.length === 1 ? "file" : "files"}`}
            {" · "}
            {panes.length === 0
              ? `no panes open (up to ${MAX_PANES})`
              : `${panes.length} of ${MAX_PANES} panes open`}
          </span>
        </div>
        <div className="log-workbench__files-toolbar">
          <label htmlFor="log-workbench-file-filter">
            <span>Filter files</span>
            <input
              id="log-workbench-file-filter"
              type="search"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setFileQuery("");
                }
              }}
              aria-label="Filter log files"
              placeholder="Name or path…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {fileQuery.trim() ? (
            <button type="button" onClick={() => setFileQuery("")}>
              Clear file filter
            </button>
          ) : null}
          {panes.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                invalidateScopedResults();
                setPanes([]);
                setNotice("Open-file selection cleared. Select a file before searching.");
              }}
            >
              Clear open files
            </button>
          ) : null}
        </div>
        {filteredItems.length === 0 ? (
          <p className="log-workbench__notice" role="status">
            No files match “{fileQuery.trim()}”. Clear the filter to see all{" "}
            {items.length.toLocaleString()} files.
          </p>
        ) : (
          <div
            className={
              virtualizeFiles
                ? "log-workbench__file-list log-workbench__file-list--virtual"
                : "log-workbench__file-list"
            }
            aria-label="Matching log files"
            onScroll={(event) => setFileScrollTop(event.currentTarget.scrollTop)}
          >
            {virtualizeFiles ? (
              <div
                className="log-workbench__spacer"
                aria-hidden="true"
                style={{ height: `${fileWindow.start * FILE_ROW_HEIGHT}px` }}
              />
            ) : null}
            {visibleFiles.map((item) => {
              return (
                <label
                  key={item.evidenceId}
                  className={
                    virtualizeFiles
                      ? "log-workbench__file log-workbench__file--virtual"
                      : "log-workbench__file"
                  }
                >
                  <input
                    type="checkbox"
                    checked={panes.includes(item.evidenceId)}
                    onChange={() => togglePane(item.evidenceId)}
                    aria-label={`Show ${item.displayLabel} in a pane`}
                  />
                  <span className="log-workbench__file-copy">
                    <strong>{item.displayLabel}</strong>
                    {item.relativePath !== item.displayLabel || item.fullyRead === false ? (
                      <small>
                        {item.relativePath === item.displayLabel
                          ? ""
                          : item.relativePath.slice(
                              0,
                              item.relativePath.length - item.displayLabel.length,
                            )}
                        {item.fullyRead === false ? "not fully read" : ""}
                      </small>
                    ) : null}
                  </span>
                  {virtualizeFiles ? null : (
                    <TechnicalIdentifiers
                      record={item.displayLabel}
                      summary="Details"
                      className="log-workbench__file-details"
                      items={[
                        { label: "Evidence id", value: item.evidenceId },
                        { label: "Digest", value: item.digest },
                        { label: "Intake batch", value: item.intakeBatchId },
                      ]}
                    />
                  )}
                </label>
              );
            })}
            {virtualizeFiles ? (
              <div
                className="log-workbench__spacer"
                aria-hidden="true"
                style={{
                  height: `${Math.max(0, filteredItems.length - fileWindow.end) * FILE_ROW_HEIGHT}px`,
                }}
              />
            ) : null}
          </div>
        )}
        {virtualizeFiles ? (
          <p className="log-workbench__hint">
            Showing files {(fileWindow.start + 1).toLocaleString()}–
            {Math.max(fileWindow.start + 1, fileWindow.end).toLocaleString()} of{" "}
            {filteredItems.length.toLocaleString()}. Filter to jump to a file and inspect its details.
          </p>
        ) : null}
      </div>

      <div className="log-workbench__search">
        <div className="log-workbench__search-head">
          <div>
            <strong>Search these logs</strong>
            <span>Start with a word or phrase. Open advanced filters only when you need them.</span>
          </div>
        </div>
        <div className="log-workbench__search-row">
          <div className="log-workbench__search-primary">
            <label>
              <span>Find</span>
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  invalidateSearchResults();
                  setQuery(event.target.value);
                }}
                onKeyDown={onSearchKey}
                aria-label="Find in logs"
                placeholder="Message, error, identifier…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={searching || panes.length === 0}
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          <div
            className="log-workbench__match-nav"
            role="group"
            aria-label="Search match navigation"
          >
            <button
              type="button"
              aria-label="Previous match"
              disabled={!search || search.matches.length === 0}
              onClick={() =>
                search && search.matches.length > 0
                  ? selectMatch((matchIndex + search.matches.length - 1) % search.matches.length)
                  : undefined
              }
            >
              Previous
            </button>
            <span aria-live="polite" aria-atomic="true">
              {search && search.matches.length > 0
                ? `${matchIndex + 1} of ${search.matches.length}`
                : "No matches"}
            </span>
            <button
              type="button"
              aria-label="Next match"
              disabled={!search || search.matches.length === 0}
              onClick={() =>
                search && search.matches.length > 0
                  ? selectMatch((matchIndex + 1) % search.matches.length)
                  : undefined
              }
            >
              Next
            </button>
          </div>
        </div>

        <details className="log-workbench__search-advanced">
          <summary>
            {advancedOn > 0 ? `Advanced filters (${advancedOn} on)` : "Advanced filters"}
          </summary>
          <div className="log-workbench__search-filters">
            <label>
              <span>Match</span>
              <select
                value={mode}
                onChange={(event) => {
                  invalidateSearchResults();
                  setMode(event.target.value as typeof mode);
                }}
                aria-label="Match mode"
              >
                <option value="literal">Literal</option>
                <option value="case_insensitive">Ignore case</option>
                <option value="regex">Bounded regex</option>
              </select>
            </label>
            <label>
              <span>Include</span>
              <input
                value={include}
                onChange={(event) => {
                  invalidateSearchResults();
                  setInclude(event.target.value);
                }}
                aria-label="Include terms"
              />
            </label>
            <label>
              <span>Exclude</span>
              <input
                value={exclude}
                onChange={(event) => {
                  invalidateSearchResults();
                  setExclude(event.target.value);
                }}
                aria-label="Exclude terms"
              />
            </label>
            <label>
              <span>Severity</span>
              <input
                value={severity}
                onChange={(event) => {
                  invalidateSearchResults();
                  setSeverity(event.target.value);
                }}
                aria-label="Severity"
              />
            </label>
            <label>
              <span>From (UTC)</span>
              <input
                value={timeFrom}
                onChange={(event) => {
                  invalidateSearchResults();
                  setTimeFrom(event.target.value);
                }}
                aria-label="From (UTC)"
              />
            </label>
            <label>
              <span>To (UTC)</span>
              <input
                value={timeTo}
                onChange={(event) => {
                  invalidateSearchResults();
                  setTimeTo(event.target.value);
                }}
                aria-label="To (UTC)"
              />
            </label>
          </div>
          <p className="log-workbench__hint">
            UTC ranges require a full instant such as <code>2024-03-10T08:00:00Z</code>.
            Local times without a zone are refused rather than guessed.
          </p>
        </details>
      </div>
      <p className="log-workbench__hint">
        Press F3 (or Ctrl/Cmd+G) in Find to move through matches.
      </p>
      {search?.timeFilterUnknownReason ? (
        <p className="log-workbench__notice">{search.timeFilterUnknownReason}</p>
      ) : null}
      {search ? (
        <section
          className="log-workbench__search-results"
          aria-label="Search results"
          aria-busy={searching}
        >
          <p className="log-workbench__search-summary" role="status" aria-live="polite">
            {searchSummary(search, search.matches.length, corpusTruncated)}
            {activeMatch ? ` Showing match ${matchIndex + 1} of ${search.matches.length}.` : ""}
          </p>
          {search.timeAuthorityUnavailableReason ? (
            <p className="log-workbench__notice">
              {search.timeAuthorityUnavailableReason}
            </p>
          ) : null}
          {search.matches.length > 0 ? (
            <ol className="log-workbench__hits" aria-label="Search matches">
              {matchGroups.map((group) => (
                <li key={group.relativePath} className="log-workbench__hit-group">
                  <div className="log-workbench__hit-group-head">
                    <strong>{group.displayLabel}</strong>
                    <span>
                      {group.entries.length.toLocaleString()}{" "}
                      {group.entries.length === 1 ? "match" : "matches"}
                      {group.relativePath !== group.displayLabel ? ` · ${group.relativePath}` : ""}
                    </span>
                  </div>
                  <ol>
                    {group.entries.map(({ row, index }) => (
                      <li
                        key={`${row.evidenceId}:${row.lineNumber}:${index}`}
                        className={
                          index === matchIndex
                            ? "log-workbench__hit-row log-workbench__hit-row--current"
                            : "log-workbench__hit-row"
                        }
                      >
                        <button
                          type="button"
                          aria-current={index === matchIndex ? "true" : undefined}
                          onClick={() => selectMatch(index)}
                        >
                          {row.relativePath}:{row.lineNumber}
                        </button>
                        <span className="log-workbench__text" title={row.text}>
                          {row.text}
                        </span>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          ) : (
            <p role="status">
              {search.coverageComplete === false
                ? "No match yet in the lines searched so far. There are more selected lines to search."
                : "No line in the selected files matches this search."}
            </p>
          )}
          {search.nextPageCursor ? (
            <button
              type="button"
              disabled={searching}
              onClick={() => void runSearch(search.nextPageCursor ?? null)}
            >
              {searching
                ? "Searching…"
                : search.coverageComplete === false
                  ? "Keep searching the rest of the selected lines"
                  : "Load more matches"}
            </button>
          ) : null}
        </section>
      ) : null}

      <label className="log-workbench__sync">
        <input
          type="checkbox"
          checked={syncScroll}
          onChange={(event) => setSyncScroll(event.target.checked)}
        />
        Synchronize pane scrolling
      </label>

      <div className="log-workbench__panes">
        {selectedItems.length === 0 && items.length > 0 ? (
          <p className="log-workbench__notice" role="status">
            Select a log file to open its lines.
          </p>
        ) : null}
        {selectedItems.map((item) => {
          const page = pageByPane[item.evidenceId];
          const rows = page?.rows ?? [];
          const paneScroll = syncScroll ? scrollTop : (scrollByPane[item.evidenceId] ?? 0);
          const paneWindow = virtualizedWindow({
            totalRows: rows.length,
            scrollTop: paneScroll,
            rowHeight: ROW_HEIGHT,
            viewportHeight: VIEWPORT_HEIGHT,
            overscan: OVERSCAN,
          });
          const slice = rows.slice(paneWindow.start, paneWindow.end);
          return (
            <div
              key={item.evidenceId}
              className="log-workbench__pane"
              data-workbench-pane={item.evidenceId}
              tabIndex={0}
              role="region"
              aria-label={`${item.displayLabel} lines`}
              onScroll={onScroll}
            >
              <header>
                <strong>{item.displayLabel}</strong>
                {page?.wrappedRowCount ? (
                  <span> {page.wrappedRowCount} wrapped long lines</span>
                ) : null}
              </header>
              <div
                className="log-workbench__spacer"
                aria-hidden="true"
                style={{ height: `${paneWindow.start * ROW_HEIGHT}px` }}
              />
              <ol
                className="log-workbench__lines"
                style={{ ["--row-height" as string]: `${ROW_HEIGHT}px` }}
                start={slice[0]?.lineNumber ?? 1}
              >
                {slice.map((row) => (
                  <li
                    key={`${row.evidenceId}:${row.lineNumber}`}
                    data-line={row.lineNumber}
                    className={
                      activeMatch
                      && activeMatch.evidenceId === row.evidenceId
                      && activeMatch.lineNumber === row.lineNumber
                        ? "log-workbench__hit"
                        : undefined
                    }
                  >
                    <span className="log-workbench__gutter">{row.lineNumber}</span>
                    <span className="log-workbench__text">{row.text}</span>
                    {row.wrapped ? <span className="log-workbench__wrap">wrapped</span> : null}
                    {props.canWrite && !props.readOnly ? (
                      <button type="button" onClick={() => void saveBookmark(row)}>
                        Bookmark
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
              <div
                className="log-workbench__spacer"
                aria-hidden="true"
                style={{
                  height: `${Math.max(0, rows.length - paneWindow.end) * ROW_HEIGHT}px`,
                }}
              />
              {page?.nextStartLine ? (
                <button type="button" onClick={() => void loadPane(item.evidenceId, page.nextStartLine ?? 1)}>
                  Load next lines
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="log-workbench__tools" role="group" aria-label="Workbench view controls">
        {props.canWrite && !props.readOnly ? (
          <section className="log-workbench__tool-section log-workbench__tool-section--save" aria-labelledby="log-workbench-save-title">
            <div className="log-workbench__tool-heading">
              <strong id="log-workbench-save-title">Save a view</strong>
              <span>Keep this search, file selection, and layout for later.</span>
            </div>
            <div className="log-workbench__tool-form">
              <label>
                <span>View name</span>
                <input
                  value={viewName}
                  onChange={(event) => setViewName(event.target.value)}
                  placeholder="e.g. Checkout timeout"
                />
              </label>
              <button type="button" onClick={() => void saveView()} disabled={panes.length === 0}>
                Save view
              </button>
            </div>
          </section>
        ) : null}
        {views.length > 0 ? (
          <section className="log-workbench__tool-section log-workbench__tool-section--saved" aria-labelledby="log-workbench-saved-title">
            <div className="log-workbench__tool-heading">
              <strong id="log-workbench-saved-title">Saved views</strong>
              <span>Restore a previous investigation layout.</span>
            </div>
            <ul aria-label="Saved views">
              {views.map((view) => (
                <li key={view.id}>
                  <button type="button" onClick={() => applyView(view)}>
                    {view.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="log-workbench__tool-section log-workbench__tool-section--chronology" aria-labelledby="log-workbench-group-title">
          <div className="log-workbench__tool-heading">
            <strong id="log-workbench-group-title">Review chronology</strong>
            <span>Choose how related lines should be grouped.</span>
          </div>
          <div className="log-workbench__tool-form">
            <label>
              <span>Group by</span>
              <select
                value={grouping}
                onChange={(event) => {
                  invalidateChronologyResults();
                  setGrouping(event.target.value);
                }}
                aria-label="Chronology grouping"
              >
                <option value="none">No grouping</option>
                <option value="file">File</option>
                <option value="component">Component</option>
                <option value="batch">Intake batch</option>
                <option value="rotation_family">Rotation family</option>
                <option value="entity">Observed identifier</option>
                <option value="severity">Severity</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void runChronology()}
              disabled={chronologyBusy || panes.length === 0}
            >
              {chronologyBusy ? "Building chronology…" : "Show merged chronology"}
            </button>
          </div>
        </section>
      </div>

      {chronology ? (
        <section aria-label="Merged chronology">
          <h5>Merged chronology</h5>
          {unknownBuckets.length > 0 ? (
            <details>
              <summary>
                What this chronology does not know ({unknownBuckets.length})
              </summary>
              <ul>
                {unknownBuckets.map((bucket) => (
                  <li key={bucket.category}>{bucket.detail}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <ol>
            {chronology.map((event, index) => {
              const time = chronologyTime(event);
              return (
              <li key={`${event.relativePath}:${event.lineNumber}:${index}`}>
                <span><strong>{time.label}</strong>{time.value ? `: ${time.value}` : ""}</span>
                {" · "}
                <span>{event.relativePath}</span>
                {groupLabel(grouping, event.groupKey ?? "") ? (
                  <small> {groupLabel(grouping, event.groupKey ?? "")}</small>
                ) : null}
                {event.anchorStatus ? <small> {event.anchorStatus.replace("_", " ")}</small> : null}
                <div>{event.excerpt}</div>
                {props.canWrite && !props.readOnly ? (
                  <div>
                    <button type="button" onClick={() => void pinEvent(event, "pinned")}>
                      Pin as benchmark
                    </button>
                    <button
                      type="button"
                      onClick={() => void pinEvent(event, "human_ground_truth")}
                    >
                      Record as ground truth
                    </button>
                  </div>
                ) : null}
                <small>{event.adjacencyReason}</small>
                {event.uncertainty.length > 0 ? (
                  <small> Uncertainty: {event.uncertainty.join("; ")}</small>
                ) : null}
                {event.correlationKind === "observed_identifier" && event.correlationId ? (
                  <small> Observed id {event.correlationId}</small>
                ) : null}
              </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {bookmarks.length > 0 ? (
        <section aria-label="Bookmarks">
          <h5>Bookmarks</h5>
          <ul>
            {bookmarks.map((bookmark) => {
              const owner = items.find(
                (item) => item.evidenceId === bookmark.locator.evidenceId,
              );
              return (
                <li key={bookmark.id}>
                  {bookmark.status === "resolved" && owner ? (
                    <button
                      type="button"
                      onClick={() =>
                        void revealMatch({
                          evidenceId: bookmark.locator.evidenceId,
                          relativePath: owner.relativePath,
                          rotationFamily: owner.rotationFamily,
                          lineNumber: bookmark.locator.lineNumber,
                          byteOffset: 0,
                          text: "",
                          wrapped: false,
                          originalTimestamp: null,
                          normalizedUtc: null,
                          parseClass: "missing",
                          contextBefore: [],
                          contextAfter: [],
                        })
                      }
                    >
                      {bookmark.note || `Line ${bookmark.locator.lineNumber}`}
                    </button>
                  ) : (
                    <span>{bookmark.note || `Line ${bookmark.locator.lineNumber}`}</span>
                  )}
                  {bookmark.status !== "resolved" ? (
                    <span role="status"> {bookmark.staleReason}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

export const WORKBENCH_VIRTUALIZATION = {
  ROW_HEIGHT,
  VIEWPORT_HEIGHT,
  OVERSCAN,
  FILE_ROW_HEIGHT,
  FILE_VIEWPORT_HEIGHT,
  FILE_OVERSCAN,
  FILE_VIRTUALIZE_AFTER,
  MAX_PANES,
};
