/**
 * Log workbench — investigation-owned log exploration on Analyze.
 *
 * Evidence listed here is this investigation's intake, not the global Sources
 * catalog. Technical ids stay behind a disclosure. Rendering is a bounded
 * window over paged rows; imported text is always a text node.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TechnicalIdentifiers } from "./technical-identity.js";
import { protectedApiFetch } from "./protected-api.js";

function virtualizedWindow(input: {
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
/**
 * Files the chooser keeps in the DOM for one page of the list.
 *
 * An investigation that imported three hundred files must not put three
 * hundred checkboxes on the page: the list is paged, and the page is the hard
 * bound. Every file stays reachable — the filter narrows the whole inventory,
 * not the page, and the pager walks the rest.
 */
const FILE_PAGE = 25;
/**
 * Files a responder can take in at a glance before scanning beats reading.
 *
 * Below this the chooser stays a plain list with nothing to learn: no filter,
 * no pager, no bulk action. The three-file investigation should not pay for
 * the three-hundred-file one.
 */
const FILE_FILTER_THRESHOLD = 6;

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
  cancelled?: boolean;
  corpusTruncated?: boolean;
  timeFilterUnknownReason: string | null;
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

/**
 * Does this file match what the reader typed into the chooser filter?
 *
 * Deliberately narrow: the only text considered is the human name and the path
 * the file arrived under. Evidence ids, digests, and intake batch ids are how
 * ContextDesk addresses a record, not how a responder recognises one, and a
 * filter that matched them would put those strings on screen the moment
 * someone pasted one in. Every token must appear, so "worker batch" narrows
 * rather than widens.
 */
export function fileMatchesFilter(
  item: { displayLabel: string; relativePath: string },
  filter: string,
): boolean {
  const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = `${item.relativePath} ${item.displayLabel}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * What the chooser is actually showing, in one sentence a responder can trust.
 *
 * A count that omits the part it left out reads as a complete one, so a paged
 * list says which slice is on screen, a filtered list says how much of the
 * inventory it hid, and a full pane set says why the next file will not open.
 */
export function chooserStatus(input: {
  total: number;
  matching: number;
  filtered: boolean;
  /** 1-based inclusive range of the matching list currently rendered. */
  from: number;
  to: number;
  /** Open files listed outside that range so they can still be closed. */
  pinned: number;
  selected: number;
  maxPanes: number;
}): string {
  const files = (count: number) =>
    `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;
  const shown = Math.max(0, input.to - input.from + 1);
  const parts: string[] = [];
  if (input.filtered && input.matching === 0) {
    parts.push(`No file matches this filter. This investigation has ${files(input.total)}.`);
  } else if (input.filtered) {
    parts.push(
      `${input.matching.toLocaleString()} of ${files(input.total)} ${
        input.matching === 1 ? "matches" : "match"
      } this filter.`,
    );
    if (shown < input.matching) parts.push(`Showing ${input.from}–${input.to}.`);
  } else if (shown < input.total) {
    parts.push(`Showing ${input.from}–${input.to} of ${files(input.total)}.`);
  } else {
    parts.push(`${files(input.total)}.`);
  }
  if (input.pinned > 0) {
    parts.push(
      input.pinned === 1
        ? "1 open file is listed too, so you can close it."
        : `${input.pinned} open files are listed too, so you can close them.`,
    );
  }
  if (input.selected === 0) {
    parts.push("No file is open yet.");
  } else if (input.selected >= input.maxPanes) {
    parts.push(
      `${input.selected} of ${input.maxPanes} panes in use — the maximum. Clear one to open another.`,
    );
  } else {
    parts.push(`${input.selected} of ${input.maxPanes} panes in use.`);
  }
  return parts.join(" ");
}

/**
 * One sentence a responder can act on. A partial answer never reads as a
 * complete one: a stopped scan, a cancelled scan, and a corpus that was too
 * large to read to the end each say so in plain words.
 */
function searchSummary(result: SearchResult, corpusTruncated: boolean): string {
  const shown = `Showing ${result.returned.toLocaleString()}`;
  if (result.cancelled) {
    return `${shown} of at least ${result.atLeast.toLocaleString()} matches. The search stopped early, so later matches were not counted.`;
  }
  if (result.corpusTruncated || corpusTruncated) {
    return `${shown} matches so far. This investigation has more log lines than one search can read, so matches past the read limit were not counted.`;
  }
  if (result.bounded) {
    return `${shown} of at least ${result.atLeast.toLocaleString()} matches. Load more to keep going.`;
  }
  return `${result.returned.toLocaleString()} match${result.returned === 1 ? "" : "es"}. That is every match in the read lines.`;
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
  const [fileFilter, setFileFilter] = useState("");
  const [filePage, setFilePage] = useState(0);
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
  const liveRef = useRef<HTMLParagraphElement>(null);
  /** Panes already read once, so a selection change does not re-page them. */
  const loadedPanes = useRef<Set<string>>(new Set());

  const selectedItems = useMemo(
    () => items.filter((item) => panes.includes(item.evidenceId)),
    [items, panes],
  );

  /**
   * The chooser stays usable at three files and at three hundred.
   *
   * `matchingFiles` is the whole inventory narrowed by what the reader typed;
   * `renderedFiles` is one page of that, plus any open file the page or the
   * filter would otherwise hide. Pinning open files is what makes the bound
   * safe: a pane can always be closed from the row that opened it, so paging
   * never strands a selection the reader can no longer reach.
   */
  const filterActive = fileFilter.trim().length > 0;
  const matchingFiles = useMemo(
    () => items.filter((item) => fileMatchesFilter(item, fileFilter)),
    [items, fileFilter],
  );
  const filePageCount = Math.max(1, Math.ceil(matchingFiles.length / FILE_PAGE));
  const filePageIndex = Math.min(Math.max(0, filePage), filePageCount - 1);
  const fileWindow = useMemo(() => {
    const start = filePageIndex * FILE_PAGE;
    return matchingFiles.slice(start, start + FILE_PAGE);
  }, [matchingFiles, filePageIndex]);
  const renderedFiles = useMemo(() => {
    const onPage = new Set(fileWindow.map((item) => item.evidenceId));
    return items.filter(
      (item) => onPage.has(item.evidenceId) || panes.includes(item.evidenceId),
    );
  }, [items, fileWindow, panes]);
  const pinnedFileCount = renderedFiles.length - fileWindow.length;
  const showFileTools = items.length > FILE_FILTER_THRESHOLD;
  const atPaneLimit = panes.length >= MAX_PANES;
  const fileRangeStart = fileWindow.length === 0 ? 0 : filePageIndex * FILE_PAGE + 1;
  const fileRangeEnd = filePageIndex * FILE_PAGE + fileWindow.length;

  const load = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    loadedPanes.current.clear();
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench`);
      if (response.status === 401 || response.status === 403) {
        setLoadState("unauthorized");
        return;
      }
      if (!response.ok) {
        setError(await errorText(response, "The log workbench could not be loaded."));
        setLoadState("error");
        return;
      }
      const body = (await response.json()) as {
        items?: InventoryItem[];
        normalizationRevision?: number | null;
        corpusTruncated?: boolean;
        unreadFiles?: string[];
      };
      setItems(body.items ?? []);
      setRevision(body.normalizationRevision ?? null);
      setCorpusTruncated(body.corpusTruncated === true);
      setUnreadFiles(body.unreadFiles ?? []);
      setLoadState("ready");
      try {
        const viewsRes = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/views`);
        if (viewsRes.ok) {
          const parsed = (await viewsRes.json()) as { views?: SavedView[] };
          setViews(parsed.views ?? []);
        }
      } catch {
        setViews([]);
      }
      try {
        const bookmarksRes = await protectedApiFetch(
          `/api/cases/${props.caseId}/workbench/bookmarks`,
        );
        if (bookmarksRes.ok) {
          const parsed = (await bookmarksRes.json()) as { bookmarks?: BookmarkRow[] };
          setBookmarks(parsed.bookmarks ?? []);
        }
      } catch {
        setBookmarks([]);
      }
      try {
        const queueRes = await protectedApiFetch(
          `/api/cases/${props.caseId}/workbench/review-queue`,
        );
        if (queueRes.ok) {
          const parsed = (await queueRes.json()) as { candidateCount?: number };
          setReviewCount(parsed.candidateCount ?? 0);
        }
      } catch {
        setReviewCount(null);
      }
    } catch {
      setError("The log workbench could not be loaded.");
      setLoadState("error");
    }
  }, [props.caseId]);

  useEffect(() => {
    if (props.active === false) return;
    void load();
  }, [load, props.active]);

  useEffect(() => {
    const reload = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: string }>).detail;
      if (detail?.caseId && detail.caseId !== props.caseId) return;
      void load();
    };
    window.addEventListener("contextdesk:corpus-intake-committed", reload);
    window.addEventListener("contextdesk:snapshot-frozen", reload);
    // Evidence can also arrive through the board beside this panel on Analyze.
    window.addEventListener("contextdesk:evidence-changed", reload);
    return () => {
      window.removeEventListener("contextdesk:corpus-intake-committed", reload);
      window.removeEventListener("contextdesk:snapshot-frozen", reload);
      window.removeEventListener("contextdesk:evidence-changed", reload);
    };
  }, [load, props.caseId]);

  const loadPane = useCallback(
    async (evidenceId: string, startLine = 1) => {
      loadedPanes.current.add(evidenceId);
      try {
        const response = await protectedApiFetch(
          `/api/cases/${props.caseId}/workbench/page?evidenceId=${encodeURIComponent(evidenceId)}&startLine=${startLine}&limit=80`,
        );
        if (!response.ok) return;
        const page = (await response.json()) as PageResult;
        setPageByPane((current) => ({ ...current, [evidenceId]: page }));
      } catch {
        /* unmount or test teardown */
      }
    },
    [props.caseId],
  );

  // Only panes that have never been read are opened at line 1. Re-reading them
  // whenever the selection changes would throw away where the reader had paged
  // to — including the window a revealed search match just loaded.
  useEffect(() => {
    const ids = panes.length > 0 ? panes : items.slice(0, 1).map((item) => item.evidenceId);
    for (const id of ids) {
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
      if (!panes.includes(row.evidenceId) && panes.length < MAX_PANES) {
        setPanes((current) =>
          current.includes(row.evidenceId) ? current : [...current, row.evidenceId],
        );
      }
      const page = pageByPane[row.evidenceId];
      const inWindow =
        page && page.rows.some((candidate) => candidate.lineNumber === row.lineNumber);
      if (!inWindow) {
        await loadPane(row.evidenceId, Math.max(1, row.lineNumber - PAGE_LEAD_LINES));
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
    [loadPane, pageByPane, panes, syncScroll],
  );

  function selectMatch(index: number) {
    setMatchIndex(index);
    const row = search?.matches[index];
    if (row) void revealMatch(row);
  }

  /**
   * Opening a fifth file is refused out loud, never by eviction.
   *
   * Silently dropping the oldest pane would take away a file the reader chose
   * on purpose and give no reason for it, so the selection is left exactly as
   * it was and the limit is stated instead.
   */
  function togglePane(evidenceId: string) {
    if (panes.includes(evidenceId)) {
      setPanes((current) => current.filter((id) => id !== evidenceId));
      return;
    }
    if (panes.length >= MAX_PANES) {
      const label =
        items.find((item) => item.evidenceId === evidenceId)?.displayLabel ?? "That file";
      setNotice(
        `“${label}” did not open: ${MAX_PANES} panes are already open, which is the maximum. Clear a file first — nothing already open was closed.`,
      );
      return;
    }
    setPanes((current) =>
      current.includes(evidenceId) ? current : [...current, evidenceId],
    );
  }

  function clearFileSelection() {
    if (panes.length === 0) return;
    setPanes([]);
    setNotice("Cleared the file selection.");
  }

  /** Open as many listed files as there is room for, closing nothing. */
  function selectVisibleFiles() {
    const candidates = renderedFiles.filter((item) => !panes.includes(item.evidenceId));
    if (candidates.length === 0) {
      setNotice("Every file listed here is already open.");
      return;
    }
    const room = MAX_PANES - panes.length;
    if (room <= 0) {
      setNotice(
        `Nothing was opened: ${MAX_PANES} panes are already open, which is the maximum. Clear a file first.`,
      );
      return;
    }
    const added = candidates.slice(0, room);
    setPanes((current) => [...current, ...added.map((item) => item.evidenceId)]);
    const remaining = candidates.length - added.length;
    const opened = `Opened ${added.length} more ${added.length === 1 ? "file" : "files"}.`;
    setNotice(
      remaining === 0
        ? opened
        : `${opened} ${remaining} listed ${remaining === 1 ? "file" : "files"} did not fit — ${MAX_PANES} panes is the maximum, and nothing already open was closed.`,
    );
  }

  function setFileFilterText(next: string) {
    setFileFilter(next);
    // A narrowed list starts at its first page; keeping page 7 would show an
    // empty list and read as "no matches".
    setFilePage(0);
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
   * `cursor` continues the previous page rather than starting over, so a
   * bounded result is reachable instead of being a dead end.
   */
  async function runSearch(cursor = 0) {
    setError(null);
    setSearching(true);
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: "cd-collab.log_workbench_search_request.v1",
          query,
          mode,
          filters: searchFilters(),
          contextBefore: 1,
          contextAfter: 1,
          cursor,
          limit: 50,
          expectedNormalizationRevision: revision,
        }),
      });
      if (!response.ok) {
        setError(await errorText(response, "Search could not run."));
        return;
      }
      const result = (await response.json()) as SearchResult;
      setSearch((current) =>
        cursor > 0 && current
          ? { ...result, matches: [...current.matches, ...result.matches] }
          : result,
      );
      if (cursor === 0) setMatchIndex(0);
      setNotice(searchSummary(result, corpusTruncated));
    } finally {
      setSearching(false);
    }
  }

  async function runChronology() {
    setChronologyBusy(true);
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/chronology`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grouping, evidenceIds: panes }),
      });
      if (!response.ok) {
        setError(await errorText(response, "The merged chronology could not be built."));
        return;
      }
      const body = (await response.json()) as {
        events?: ChronologyEvent[];
        unknownBuckets?: { category: string; count: number; detail: string }[];
        bounded?: boolean;
        atLeast?: number;
      };
      setChronology(body.events ?? []);
      setUnknownBuckets(body.unknownBuckets ?? []);
      setNotice(
        body.bounded
          ? `Showing the first ${(body.events ?? []).length.toLocaleString()} of ${(body.atLeast ?? 0).toLocaleString()} lines in this chronology.`
          : `Merged chronology built from ${(body.events ?? []).length.toLocaleString()} lines.`,
      );
    } finally {
      setChronologyBusy(false);
    }
  }

  async function pinEvent(event: ChronologyEvent, status: "pinned" | "human_ground_truth") {
    if (props.readOnly || !props.canWrite || !event.evidenceId) return;
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/anchors`, {
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
    if (!response.ok) {
      setError(await errorText(response, "The chronology pin could not be saved."));
      return;
    }
    setNotice(status === "human_ground_truth" ? "Ground truth recorded." : "Benchmark pin recorded.");
    await runChronology();
  }

  async function saveView() {
    if (props.readOnly || !props.canWrite) return;
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/views`, {
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
        selectedPanes: panes.length > 0 ? panes : items.slice(0, 2).map((item) => item.evidenceId),
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
    if (!response.ok) {
      setError(await errorText(response, "The view could not be saved."));
      return;
    }
    setNotice(`Saved view “${viewName.trim() || "Saved view"}” recorded for this investigation.`);
    await load();
  }

  async function saveBookmark(row: MatchRow) {
    if (props.readOnly || !props.canWrite) return;
    const item = items.find((entry) => entry.evidenceId === row.evidenceId);
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/bookmarks`, {
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
    if (!response.ok) {
      setError(await errorText(response, "The bookmark could not be saved."));
      return;
    }
    setNotice("Bookmark recorded.");
    await load();
  }

  function applyView(view: SavedView) {
    setPanes(view.selectedPanes.slice(0, MAX_PANES));
    // The view names its own files; a leftover filter would hide the rest of
    // the inventory behind a word the reader typed for a different question.
    setFileFilter("");
    setFilePage(0);
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
      setQuery("");
      setSearch(null);
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
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <h4 id="log-workbench-heading">Log workbench</h4>
        <p role="status">Loading this investigation’s logs…</p>
      </section>
    );
  }
  if (loadState === "unauthorized") {
    return (
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <h4 id="log-workbench-heading">Log workbench</h4>
        <p role="alert">You do not have access to this investigation’s logs.</p>
      </section>
    );
  }
  if (loadState === "error") {
    return (
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <h4 id="log-workbench-heading">Log workbench</h4>
        <p role="alert">{error ?? "The log workbench could not be loaded."}</p>
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section className="log-workbench" id="log-workbench" aria-labelledby="log-workbench-heading">
        <h4 id="log-workbench-heading">Log workbench</h4>
        <p>
          This investigation has no imported logs yet. Add files, a ZIP, or a directory on
          Capture — those files stay with this investigation, not in the shared Sources
          catalog.
        </p>
      </section>
    );
  }

  const activeMatch = search?.matches[matchIndex] ?? null;

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
          This investigation holds more log lines than one read can cover, so the
          workbench stopped part-way through
          {unreadFiles.length > 0 ? ` (${unreadFiles.slice(0, 3).join(", ")}${unreadFiles.length > 3 ? ", and others" : ""})` : ""}
          . Counts and searches below cover only the lines that were read — select
          fewer files, or narrow the corpus on Capture, to see the rest.
        </p>
      ) : null}
      {reviewCount && reviewCount > 0 ? (
        <p className="log-workbench__notice">
          {reviewCount.toLocaleString()} lines still have a clock but no timezone. Open
          Timezone review below to declare a zone — nothing here will guess one.
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
            <span>Select one or more to open them side by side.</span>
          </div>
        </div>
        {/* The filter and the bulk action arrive only once the list stops
            being glanceable. Clearing a selection is useful at any size, so it
            appears as soon as there is one to clear. */}
        {showFileTools || panes.length > 0 ? (
          <div className="log-workbench__file-tools">
            {showFileTools ? (
              <>
                <label className="log-workbench__file-filter">
                  <span>Filter by name or folder</span>
                  <input
                    type="search"
                    value={fileFilter}
                    onChange={(event) => setFileFilterText(event.target.value)}
                    placeholder="worker/, edge.log…"
                  />
                </label>
                <button
                  type="button"
                  className="log-workbench__file-action"
                  onClick={selectVisibleFiles}
                >
                  Select visible
                </button>
              </>
            ) : null}
            {panes.length > 0 ? (
              <button
                type="button"
                className="log-workbench__file-action"
                onClick={clearFileSelection}
              >
                Clear selection
              </button>
            ) : null}
          </div>
        ) : null}
        <p
          className="log-workbench__files-status"
          data-workbench-file-status
          role="status"
          aria-live="polite"
        >
          {chooserStatus({
            total: items.length,
            matching: matchingFiles.length,
            filtered: filterActive,
            from: fileRangeStart,
            to: fileRangeEnd,
            pinned: pinnedFileCount,
            selected: panes.length,
            maxPanes: MAX_PANES,
          })}
        </p>
        {atPaneLimit ? (
          <p className="log-workbench__file-limit" id="log-workbench-pane-limit">
            {MAX_PANES} panes is the maximum this workbench opens at once. Clear a file
            before opening another — choosing one here will not close one you already
            opened.
          </p>
        ) : null}
        {renderedFiles.length === 0 ? (
          <div className="log-workbench__file-empty">
            <p>
              No file in this investigation matches “{fileFilter.trim()}”. The filter
              reads file names and the folders they arrived in, nothing else.
            </p>
            <button
              type="button"
              className="log-workbench__file-action"
              onClick={() => setFileFilterText("")}
            >
              Clear filter
            </button>
          </div>
        ) : (
          renderedFiles.map((item) => {
            const selected = panes.includes(item.evidenceId);
            const blocked = !selected && atPaneLimit;
            return (
              <label
                key={item.evidenceId}
                className={
                  blocked
                    ? "log-workbench__file log-workbench__file--blocked"
                    : "log-workbench__file"
                }
                data-workbench-file={item.evidenceId}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => togglePane(item.evidenceId)}
                  aria-label={`Show ${item.displayLabel} in a pane`}
                  // Left focusable on purpose: a control a keyboard reader
                  // cannot reach cannot tell them why it will not act.
                  aria-disabled={blocked ? true : undefined}
                  aria-describedby={blocked ? "log-workbench-pane-limit" : undefined}
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
              </label>
            );
          })
        )}
        {filePageCount > 1 ? (
          <div className="log-workbench__file-pager" role="group" aria-label="File list pages">
            <button
              type="button"
              className="log-workbench__file-action"
              onClick={() => setFilePage(Math.max(0, filePageIndex - 1))}
              disabled={filePageIndex === 0}
            >
              Previous files
            </button>
            <span>
              Page {filePageIndex + 1} of {filePageCount}
            </span>
            <button
              type="button"
              className="log-workbench__file-action"
              onClick={() => setFilePage(Math.min(filePageCount - 1, filePageIndex + 1))}
              disabled={filePageIndex >= filePageCount - 1}
            >
              More files
            </button>
          </div>
        ) : null}
      </div>

      <div className="log-workbench__search">
        <div className="log-workbench__search-head">
          <div>
            <strong>Search these logs</strong>
            <span>Start with a word or phrase. Open advanced filters only when you need them.</span>
          </div>
        </div>
        <div className="log-workbench__search-primary">
          <label>
            <span>Find</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              aria-label="Find in logs"
              placeholder="Message, error, identifier…"
            />
          </label>
          <button type="button" onClick={() => void runSearch()} disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        <details className="log-workbench__search-advanced">
          <summary>Advanced filters</summary>
          <div className="log-workbench__search-filters">
            <label>
              <span>Match</span>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
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
                onChange={(event) => setInclude(event.target.value)}
                aria-label="Include terms"
              />
            </label>
            <label>
              <span>Exclude</span>
              <input
                value={exclude}
                onChange={(event) => setExclude(event.target.value)}
                aria-label="Exclude terms"
              />
            </label>
            <label>
              <span>Severity</span>
              <input
                value={severity}
                onChange={(event) => setSeverity(event.target.value)}
                aria-label="Severity"
              />
            </label>
            <label>
              <span>From (UTC)</span>
              <input
                value={timeFrom}
                onChange={(event) => setTimeFrom(event.target.value)}
                aria-label="From (UTC)"
              />
            </label>
            <label>
              <span>To (UTC)</span>
              <input
                value={timeTo}
                onChange={(event) => setTimeTo(event.target.value)}
                aria-label="To (UTC)"
              />
            </label>
          </div>
          <p className="log-workbench__hint">
            UTC ranges require a full instant such as <code>2024-03-10T08:00:00Z</code>.
            Local times without a zone are refused rather than guessed.
          </p>
        </details>

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
      <p className="log-workbench__hint">
        Press F3 (or Ctrl/Cmd+G) in Find to move through matches.
      </p>
      {search?.timeFilterUnknownReason ? (
        <p className="log-workbench__notice">{search.timeFilterUnknownReason}</p>
      ) : null}
      {search ? (
        <section className="log-workbench__search-results" aria-label="Search results">
          <p className="log-workbench__search-summary" role="status" aria-live="polite">
            {searchSummary(search, corpusTruncated)}
            {activeMatch ? ` Showing match ${matchIndex + 1} of ${search.matches.length}.` : ""}
          </p>
          {search.matches.length > 0 ? (
            <ol className="log-workbench__hits" aria-label="Search matches">
              {search.matches.map((row, index) => (
                <li key={`${row.evidenceId}:${row.lineNumber}:${index}`}>
                  <button
                    type="button"
                    aria-current={index === matchIndex ? "true" : undefined}
                    onClick={() => selectMatch(index)}
                  >
                    {row.relativePath}:{row.lineNumber}
                  </button>
                  <span className="log-workbench__text">{row.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No line in the read log lines matches this search.</p>
          )}
          {search.nextCursor !== null ? (
            <button
              type="button"
              disabled={searching}
              onClick={() => void runSearch(search.nextCursor ?? 0)}
            >
              {searching ? "Loading…" : "Load more matches"}
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
        {(selectedItems.length > 0 ? selectedItems : items.slice(0, 1)).map((item) => {
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

      <div className="log-workbench__tools">
        {props.canWrite && !props.readOnly ? (
          <div>
            <label>
              <span>Save this view as</span>
              <input value={viewName} onChange={(event) => setViewName(event.target.value)} />
            </label>
            <button type="button" onClick={() => void saveView()}>
              Save view
            </button>
          </div>
        ) : null}
        {views.length > 0 ? (
          <ul aria-label="Saved views">
            {views.map((view) => (
              <li key={view.id}>
                <button type="button" onClick={() => applyView(view)}>
                  {view.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label>
          <span>Chronology grouping</span>
          <select
            value={grouping}
            onChange={(event) => setGrouping(event.target.value)}
            aria-label="Chronology grouping"
          >
            <option value="none">None</option>
            <option value="file">File</option>
            <option value="component">Component</option>
            <option value="batch">Batch</option>
            <option value="rotation_family">Rotation family</option>
            <option value="entity">Observed identifier</option>
            <option value="severity">Severity</option>
          </select>
        </label>
        <button type="button" onClick={() => void runChronology()} disabled={chronologyBusy}>
          {chronologyBusy ? "Building chronology…" : "Show merged chronology"}
        </button>
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
            {chronology.map((event, index) => (
              <li key={`${event.relativePath}:${event.lineNumber}:${index}`}>
                <span>{event.normalizedUtc ?? event.originalTimestamp ?? "order only"}</span>
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
            ))}
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
};
