/**
 * Multi-window Log Investigation Workspace (#480–#487).
 * Filters | 1–4 evidence lanes | chat rail · bookmarks · log_nav chips.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  hostGetLogCorpus,
  hostLogAddBookmark,
  hostLogDeleteBookmark,
  hostLogFacets,
  hostLogListBookmarks,
  hostLogQueryEventNeighborhood,
  hostLogQueryEvents,
  hostLogSearchEventsAdvanced,
  hostSetActiveLogCorpus,
  type SearchMatchMode,
  type EventQueryDto,
  type ExplorerEventDto,
  type LogBookmarkDto,
  type LogCorpusSummaryDto,
  type LogFacetsDto,
  type TimeQuality,
} from "../../lib/host";
import {
  applyLogNav,
  type LogNavAction,
} from "../../lib/logExplorer/logNav";
import {
  clampLaneCount,
  computeGaps,
  scrubLinked,
  type GapRegion,
  type LaneEventRef,
} from "../../lib/logExplorer/lanes";
import {
  aggregateLaneTimeQuality,
  classifyBreakpoint,
  emptyFilters,
  formatEventTime,
  leastReliableTimeQuality,
  timeQualityLabel,
  type Breakpoint,
  type Density,
  type ExplorerFilters,
  type LaneConfig,
  type LaneTimeState,
} from "../../lib/logExplorer/types";
import {
  appendNewer,
  DEFAULT_MAX_RESIDENT,
  prependOlder,
  seedFromPage,
} from "../../lib/logExplorer/residentWindow";
import {
  autoFitColWidths,
  DEFAULT_COL_WIDTHS,
  loadColWidths,
  resizeCol,
  saveColWidths,
  type ColWidths,
} from "../../lib/logExplorer/columnWidths";
import {
  defaultLanes,
  loadLanes,
  loadLinkMode,
  resizeLaneList,
  saveLanes,
  saveLinkMode,
  toggleLaneSource,
  type TimeLinkMode,
} from "../../lib/logExplorer/laneCompose";
import { HelpTip } from "../HelpTip";
import { HELP_FIND_VS_FILTER } from "../../lib/helpContent";
import { LinkedChatRail } from "./LinkedChatRail";
import {
  VirtualizedEventList,
  type LineMode,
} from "./VirtualizedEventList";
import "../../styles/components/log-explorer.css";

type Props = {
  corpusId: string;
};

const FIND_PAGE_SIZE = 50;

type FindCursor = {
  seq: number;
  ts: number;
};

type FindPageHistory = {
  start: FindCursor | null;
  base: number;
};

function filtersToQuery(
  f: ExplorerFilters,
  extra?: Partial<EventQueryDto>,
): EventQueryDto {
  return {
    timeFrom: f.timeFrom,
    timeTo: f.timeTo,
    levels: f.levels,
    sources: f.sources,
    services: f.services,
    hosts: f.hosts,
    keyword: f.keyword,
    limit: 200,
    sortByTime: true,
    ...extra,
  };
}

function levelClass(level: string): string {
  const l = level.toLowerCase();
  return `log-explorer__level log-explorer__level--${l}`;
}

export function LogExplorer({ corpusId }: Props) {
  const [summary, setSummary] = useState<LogCorpusSummaryDto | null>(null);
  const [filters, setFilters] = useState<ExplorerFilters>(emptyFilters);
  const [facets, setFacets] = useState<LogFacetsDto | null>(null);
  const [timeQuality, setTimeQuality] = useState<TimeQuality>("order_only");
  const [totalMatched, setTotalMatched] = useState(0);
  /** Unfiltered corpus event total for truthful count labeling (#534). */
  const [corpusTotal, setCorpusTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  /** Per-lane composite cursors for bidirectional paging (#505/#538). */
  const [laneCursors, setLaneCursors] = useState<
    Record<
      string,
      {
        afterSeq: number | null;
        afterTs: number | null;
        beforeSeq: number | null;
        beforeTs: number | null;
        hasOlder: boolean;
        hasNewer: boolean;
      }
    >
  >({});
  const pagingInflight = useRef<Record<string, "older" | "newer" | null>>({});
  const [lanePaging, setLanePaging] = useState<
    Record<
      string,
      {
        loading: "older" | "newer" | null;
        error: string | null;
        failedDirection: "older" | "newer" | null;
      }
    >
  >({});
  const [focusLaneId, setFocusLaneId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<ExplorerEventDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("comfortable");
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("normal");
  const [linkMode, setLinkMode] = useState<TimeLinkMode>(() =>
    loadLinkMode(corpusId),
  );
  const [laneCount, setLaneCount] = useState(1);
  const [lanes, setLanes] = useState<LaneConfig[]>(() => {
    const saved = loadLanes(corpusId);
    return saved && saved.length > 0 ? saved : defaultLanes(1);
  });
  const [laneEditorOpen, setLaneEditorOpen] = useState(false);
  const [laneEvents, setLaneEvents] = useState<
    Record<string, ExplorerEventDto[]>
  >({});
  /** Exact matched count for each lane query; null means unavailable/failed. */
  const [laneMatched, setLaneMatched] = useState<
    Record<string, number | null>
  >({});
  const [laneTimeStates, setLaneTimeStates] = useState<
    Record<string, LaneTimeState>
  >({});
  /** Per-lane scroll target seq from linked scrub. */
  const [laneScrollSeq, setLaneScrollSeq] = useState<
    Record<string, number | null>
  >({});
  const [gaps, setGaps] = useState<GapRegion[]>([]);
  const [bookmarks, setBookmarks] = useState<LogBookmarkDto[]>([]);
  const [findDraft, setFindDraft] = useState("");
  const [findMatchMode, setFindMatchMode] = useState<SearchMatchMode>("literal");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findUseSemantic, setFindUseSemantic] = useState(false);
  const [findPartial, setFindPartial] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState("");
  /** Find matches (ordered seqs) — does not reduce the table (#523). */
  const [findMatches, setFindMatches] = useState<number[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  const [findTotalExact, setFindTotalExact] = useState(false);
  const [findBase, setFindBase] = useState(0);
  const [findNextCursor, setFindNextCursor] = useState<FindCursor | null>(
    null,
  );
  const [findPageStart, setFindPageStart] = useState<FindCursor | null>(null);
  const [findHistory, setFindHistory] = useState<FindPageHistory[]>([]);
  const [findActiveQuery, setFindActiveQuery] = useState<string | null>(null);
  /** Prior filters/lanes saved while a bookmark temporary reveal is active (#531). */
  const [revealRestore, setRevealRestore] = useState<{
    filters: ExplorerFilters;
    lanes: LaneConfig[];
    laneCount: number;
  } | null>(null);
  const [bookmarkRevealState, setBookmarkRevealState] = useState<
    "idle" | "visible" | "revealed" | "missing"
  >("idle");
  const [lineMode, setLineMode] = useState<LineMode>(() => {
    try {
      const v = localStorage.getItem("contextdesk.logExplorer.lineMode.v1");
      if (v === "compact" || v === "wrap" || v === "full") return v;
    } catch {
      /* ignore */
    }
    return "compact";
  });
  const [expandedSeqs, setExpandedSeqs] = useState<Set<number>>(new Set());
  const [colWidths, setColWidths] = useState<ColWidths>(() => loadColWidths());
  const [narrowFiltersOpen, setNarrowFiltersOpen] = useState(false);
  const [narrowChatOpen, setNarrowChatOpen] = useState(false);
  const [detailH, setDetailH] = useState(() => {
    try {
      const n = Number(localStorage.getItem("contextdesk.logExplorer.detailH.v1"));
      if (Number.isFinite(n) && n >= 120 && n <= 640) return n;
    } catch {
      /* ignore */
    }
    return 180;
  });
  const detailDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const colDragRef = useRef<{ index: 0 | 1 | 2; startX: number; startW: number } | null>(
    null,
  );
  const [status, setStatus] = useState("Ready");
  // Resizable columns (px)
  const [filterW, setFilterW] = useState(220);
  const [chatW, setChatW] = useState(300);
  const rootRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<"filters" | "chat" | null>(null);
  const facetRequestRef = useRef(0);
  const eventsRequestRef = useRef(0);
  const findRequestRef = useRef(0);
  const findActiveRef = useRef(false);
  const findRefreshRef = useRef<(nextFilters: ExplorerFilters) => void>(
    () => {},
  );
  const semanticAvailable =
    (summary?.embedding?.embeddedTemplates ?? summary?.stats?.embedded ?? 0) >
    0;

  useEffect(() => {
    saveColWidths(colWidths);
  }, [colWidths]);

  useEffect(
    () => () => {
      findRequestRef.current += 1;
      findActiveRef.current = false;
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem("contextdesk.logExplorer.lineMode.v1", lineMode);
    } catch {
      /* ignore */
    }
  }, [lineMode]);

  useEffect(() => {
    try {
      localStorage.setItem("contextdesk.logExplorer.detailH.v1", String(detailH));
    } catch {
      /* ignore */
    }
  }, [detailH]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (colDragRef.current) {
        const { index, startX, startW } = colDragRef.current;
        const deltaRem = (e.clientX - startX) / 16;
        setColWidths((w) => {
          const next = [...w] as ColWidths;
          next[index] = startW + deltaRem;
          return resizeCol(next, index, 0);
        });
      }
      if (detailDragRef.current) {
        const dy = detailDragRef.current.startY - e.clientY;
        setDetailH(
          Math.min(640, Math.max(120, detailDragRef.current.startH + dy)),
        );
      }
    };
    const onUp = () => {
      colDragRef.current = null;
      detailDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Breakpoint observer
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? window.innerWidth;
      const bp = classifyBreakpoint(w);
      setBreakpoint(bp);
      // #536: narrow is single-lane by contract.
      if (bp === "narrow") {
        setLaneCount(1);
        setTimeLinkMode("independent");
      }
    });
    ro.observe(el);
    setBreakpoint(classifyBreakpoint(el.clientWidth || window.innerWidth));
    return () => ro.disconnect();
  }, []);

  // Drag splitters
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !rootRef.current) return;
      const rect = rootRef.current.getBoundingClientRect();
      if (dragRef.current === "filters") {
        setFilterW(Math.min(420, Math.max(140, e.clientX - rect.left)));
      } else if (dragRef.current === "chat") {
        setChatW(Math.min(520, Math.max(200, rect.right - e.clientX)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = (which: "filters" | "chat") => (e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const refreshMeta = useCallback(async () => {
    try {
      const s = await hostGetLogCorpus(corpusId);
      setSummary(s);
      if (s) setCorpusTotal(s.eventCount ?? 0);
      await hostSetActiveLogCorpus(corpusId);
      const bms = await hostLogListBookmarks(corpusId);
      setBookmarks(bms ?? []);
    } catch (e) {
      setError(String(e));
    }
  }, [corpusId]);

  const loadFacets = useCallback(async () => {
    const requestId = ++facetRequestRef.current;
    try {
      const f = await hostLogFacets(
        corpusId,
        filtersToQuery(filters, { keyword: null }),
      );
      if (requestId !== facetRequestRef.current) return;
      setFacets(f);
    } catch (e) {
      if (requestId !== facetRequestRef.current) return;
      setError(String(e));
    }
  }, [corpusId, filters]);

  const loadEvents = useCallback(async () => {
    const requestId = ++eventsRequestRef.current;
    const visibleLanes = lanes.slice(0, laneCount);
    const unloaded = Object.fromEntries(
      visibleLanes.map((lane) => [
        lane.id,
        { status: "unloaded", quality: null } satisfies LaneTimeState,
      ]),
    );
    setBusy(true);
    setError(null);
    setLanePaging({});
    setLaneTimeStates(unloaded);
    setLaneMatched(
      Object.fromEntries(visibleLanes.map((lane) => [lane.id, null])),
    );
    setTimeQuality("order_only");
    setGaps([]);
    try {
      if (laneCount <= 1) {
        const page = await hostLogQueryEvents(
          corpusId,
          filtersToQuery(filters),
        );
        if (requestId !== eventsRequestRef.current) return;
        const laneState: LaneTimeState =
          page.events.length > 0
            ? { status: "loaded", quality: page.timeQuality }
            : { status: "empty", quality: null };
        const states = { "lane-0": laneState };
        setTotalMatched(page.totalMatched);
        setLaneMatched({ "lane-0": page.totalMatched });
        setNextCursor(page.nextCursor);
        setLaneTimeStates(states);
        setTimeQuality(aggregateLaneTimeQuality(["lane-0"], states));
        const seeded = seedFromPage(page);
        setLaneEvents({ "lane-0": seeded.events });
        setLaneCursors({
          "lane-0": {
            afterSeq: seeded.afterSeq,
            afterTs: seeded.afterTs,
            beforeSeq: seeded.beforeSeq,
            beforeTs: seeded.beforeTs,
            hasOlder: page.prevCursor != null,
            hasNewer: page.nextCursor != null,
          },
        });
        setStatus(
          `${page.totalMatched} matched · ${seeded.events.length} resident (bounded)`,
        );
      } else {
        const byLane: Record<string, ExplorerEventDto[]> = {};
        const cursors: Record<
          string,
          {
            afterSeq: number | null;
            afterTs: number | null;
            beforeSeq: number | null;
            beforeTs: number | null;
            hasOlder: boolean;
            hasNewer: boolean;
          }
        > = {};
        const states: Record<string, LaneTimeState> = {};
        const matchedByLane: Record<string, number | null> = {};
        let maxLaneMatched = 0;
        let shown = 0;
        const requests = visibleLanes.map(async (lane) => {
          const q = filtersToQuery(filters, {
            sources:
              lane.sources.length > 0
                ? lane.sources
                : filters.sources.length > 0
                  ? filters.sources
                  : undefined,
            limit: 100,
            sortByTime: true,
          });
          const page = await hostLogQueryEvents(corpusId, q);
          return { lane, page };
        });
        const results = await Promise.allSettled(requests);
        if (requestId !== eventsRequestRef.current) return;
        let failed = 0;
        for (const [index, result] of results.entries()) {
          const lane = visibleLanes[index]!;
          if (result.status === "rejected") {
            failed += 1;
            byLane[lane.id] = [];
            cursors[lane.id] = {
              afterSeq: null,
              afterTs: null,
              beforeSeq: null,
              beforeTs: null,
              hasOlder: false,
              hasNewer: false,
            };
            states[lane.id] = { status: "error", quality: null };
            matchedByLane[lane.id] = null;
            continue;
          }
          const { page } = result.value;
          const seeded = seedFromPage(page);
          byLane[lane.id] = seeded.events;
          cursors[lane.id] = {
            afterSeq: seeded.afterSeq,
            afterTs: seeded.afterTs,
            beforeSeq: seeded.beforeSeq,
            beforeTs: seeded.beforeTs,
            hasOlder: page.prevCursor != null,
            hasNewer: page.nextCursor != null,
          };
          matchedByLane[lane.id] = page.totalMatched;
          maxLaneMatched = Math.max(maxLaneMatched, page.totalMatched);
          shown += page.events.length;
          states[lane.id] =
            page.events.length > 0
              ? { status: "loaded", quality: page.timeQuality }
              : { status: "empty", quality: null };
        }
        setLaneEvents(byLane);
        setLaneMatched(matchedByLane);
        setLaneCursors(cursors);
        setLaneTimeStates(states);
        // No global unique matched total is derivable from overlapping lanes.
        setTotalMatched(0);
        setTimeQuality(
          aggregateLaneTimeQuality(
            visibleLanes.map((lane) => lane.id),
            states,
          ),
        );
        setNextCursor(null);
        if (failed > 0) {
          setError(
            `${failed} evidence lane${failed === 1 ? "" : "s"} failed to load; time linking remains off`,
          );
        }
        setStatus(
          `${laneCount} lanes · ${shown} resident rows · largest lane match ${maxLaneMatched}`,
        );
      }
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setError(String(e));
    } finally {
      if (requestId === eventsRequestRef.current) setBusy(false);
    }
  }, [corpusId, filters, laneCount, lanes]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  useEffect(() => {
    void loadFacets();
    return () => {
      facetRequestRef.current += 1;
    };
  }, [loadFacets]);

  useEffect(() => {
    void loadEvents();
    return () => {
      eventsRequestRef.current += 1;
    };
  }, [loadEvents]);

  // Push view context to host for agent turns (optimized, not dump paste)
  const viewBrief = useMemo(() => {
    const parts = [
      `corpusId=${corpusId}`,
      `timeQuality=${timeQuality}`,
      filters.timeFrom != null ? `timeFrom=${filters.timeFrom}` : null,
      filters.timeTo != null ? `timeTo=${filters.timeTo}` : null,
      filters.levels.length ? `levels=${filters.levels.join(",")}` : null,
      filters.sources.length ? `sources=${filters.sources.join(",")}` : null,
      filters.keyword ? `keyword=${filters.keyword}` : null,
      `linkMode=${linkMode}`,
      `lanes=${lanes
        .slice(0, laneCount)
        .map((l) => `${l.id}:[${l.sources.join(",")}]`)
        .join("|")}`,
      selected.size
        ? `selectedSeqs=[${[...selected].slice(0, 32).join(",")}]`
        : null,
      bookmarks.length
        ? `bookmarks=${bookmarks
            .slice(0, 12)
            .map((b) => b.label)
            .join(",")}`
        : null,
    ].filter(Boolean);
    return parts.join("; ");
  }, [
    corpusId,
    timeQuality,
    filters,
    linkMode,
    lanes,
    laneCount,
    selected,
    bookmarks,
  ]);

  // Link/gap when multi-lane + link on
  useEffect(() => {
    if (linkMode === "independent" || laneCount < 2) {
      setGaps([]);
      return;
    }
    const packed = lanes.slice(0, laneCount).map((l) => ({
      id: l.id,
      events: (laneEvents[l.id] ?? []).map((e): LaneEventRef => ({
        seq: e.seq,
        ts: e.ts,
      })),
    }));
    const allTs = packed.flatMap((l) => l.events.map((e) => e.ts));
    if (allTs.length === 0) {
      setGaps([]);
      return;
    }
    const from = Math.min(...allTs);
    const to = Math.max(...allTs) + 1;
    const width = Math.max(1, Math.floor((to - from) / 20));
    const g = computeGaps(packed, from, to, width, timeQuality);
    if (Array.isArray(g)) setGaps(g);
    else setGaps([]);
  }, [linkMode, laneCount, lanes, laneEvents, timeQuality]);

  useEffect(() => {
    if (timeQuality === "order_only" && linkMode !== "independent") {
      setLinkMode("independent");
      saveLinkMode(corpusId, "independent");
      setGaps([]);
      setStatus(
        "Time link disabled: order-only time cannot claim wall-clock alignment",
      );
    }
  }, [linkMode, timeQuality, corpusId]);

  const toggleLevel = (level: string) => {
    setFilters((f) => {
      const has = f.levels.includes(level);
      return {
        ...f,
        levels: has
          ? f.levels.filter((x) => x !== level)
          : [...f.levels, level],
      };
    });
  };

  const toggleSource = (source: string) => {
    setFilters((f) => {
      const has = f.sources.includes(source);
      return {
        ...f,
        sources: has
          ? f.sources.filter((x) => x !== source)
          : [...f.sources, source],
      };
    });
  };

  /** Apply a neighborhood page into one lane's residency + cursors. */
  const applyNeighborhoodToLane = (
    nb: Awaited<ReturnType<typeof hostLogQueryEventNeighborhood>>,
    laneId = "lane-0",
  ) => {
    if (nb.events.length === 0) return;
    const seeded = seedFromPage({
      events: nb.events,
      nextCursor: nb.nextCursor ?? null,
      nextTs: nb.nextTs ?? null,
      prevCursor: nb.prevCursor ?? null,
      prevTs: nb.prevTs ?? null,
      totalMatched: nb.totalMatched,
    });
    setLaneEvents((prev) => ({ ...prev, [laneId]: seeded.events }));
    setLaneCursors((prev) => ({
      ...prev,
      [laneId]: {
        afterSeq: seeded.afterSeq,
        afterTs: seeded.afterTs,
        beforeSeq: seeded.beforeSeq,
        beforeTs: seeded.beforeTs,
        hasOlder: nb.prevCursor != null,
        hasNewer: nb.nextCursor != null,
      },
    }));
    if (nb.corpusTotal > 0) setCorpusTotal(nb.corpusTotal);
    setLaneMatched((m) => ({ ...m, [laneId]: nb.totalMatched }));
    if (laneCount === 1) setTotalMatched(nb.totalMatched);
  };

  /** Seek a stable event into the resident window via neighborhood API. */
  const seekToSeq = async (
    seq: number,
    opts?: {
      clearFilters?: boolean;
      laneId?: string;
      sources?: string[];
    },
  ): Promise<"found" | "hidden_by_filter" | "missing"> => {
    const base = opts?.clearFilters ? emptyFilters() : filters;
    const filter = filtersToQuery(base, {
      keyword: base.keyword,
      sources: opts?.sources ?? base.sources,
    });
    const nb = await hostLogQueryEventNeighborhood(corpusId, {
      targetSeq: seq,
      before: 50,
      after: 50,
      filter,
      sortByTime: true,
    });
    if (nb.status === "found") {
      const laneId = opts?.laneId ?? "lane-0";
      applyNeighborhoodToLane(nb, laneId);
      setFocusLaneId(laneId);
      setLaneScrollSeq((m) => ({ ...m, [laneId]: seq }));
      if (nb.target) {
        setDetail(nb.target);
        setSelected(new Set([seq]));
      }
    }
    return nb.status;
  };

  /**
   * Find: highlight matches in full investigation context (#523).
   * Does NOT replace the resident table with only hits.
   * Uses direct neighborhood seek for non-resident matches (no 40-page scan).
   */
  const clearFindResults = (message?: string) => {
    findRequestRef.current += 1;
    findActiveRef.current = false;
    setFindActiveQuery(null);
    setFindMatches([]);
    setFindIndex(0);
    setFindTotal(0);
    setFindTotalExact(false);
    setFindBase(0);
    setFindNextCursor(null);
    setFindPageStart(null);
    setFindHistory([]);
    setFindPartial(false);
    setHighlight(new Set());
    if (message) setStatus(message);
  };

  const requestFindPage = async (
    start: FindCursor | null,
    base: number,
    history: FindPageHistory[],
    target: "first" | "last",
    scopedFilters: ExplorerFilters,
  ) => {
    const q = findDraft.trim();
    if (!q) {
      clearFindResults("Find cleared");
      return;
    }
    const requestId = ++findRequestRef.current;
    findActiveRef.current = true;
    setFindActiveQuery(q);
    setBusy(true);
    setError(null);
    try {
      const result = await hostLogSearchEventsAdvanced(corpusId, {
        query: q,
        semantic: findUseSemantic && findMatchMode === "literal",
        matchMode: findMatchMode,
        caseSensitive: findCaseSensitive,
        // Only one bounded result page is retained in the webview.
        k: FIND_PAGE_SIZE,
        // Compose with active filter facets but not a second keyword reduce.
        filter: filtersToQuery(scopedFilters, {
          keyword: null,
          afterSeq: start?.seq ?? null,
          afterTs: start?.ts ?? null,
          beforeSeq: null,
          beforeTs: null,
        }),
      });
      if (requestId !== findRequestRef.current) return;
      const hits = result.hits;
      const seqs = hits.map((h) => h.event.seq);
      const index = target === "last" ? Math.max(0, seqs.length - 1) : 0;
      setFindMatches(seqs);
      setFindTotal(result.totalMatched ?? base + seqs.length);
      setFindTotalExact(result.totalMatched != null);
      setFindBase(base);
      setFindIndex(index);
      setFindPartial(result.partial);
      setFindPageStart(start);
      setFindHistory(history);
      setFindNextCursor(
        result.nextCursor != null && result.nextTs != null
          ? { seq: result.nextCursor, ts: result.nextTs }
          : null,
      );
      setHighlight(new Set(seqs));
      if (seqs.length > 0) {
        const first = seqs[index]!;
        const resident = laneEvents["lane-0"] ?? [];
        if (!resident.some((e) => e.seq === first)) {
          await seekToSeq(first);
        } else {
          setLaneScrollSeq((m) => ({ ...m, "lane-0": first }));
        }
      }
      const modeLabel = findMatchMode === "regex" ? "regex" : "literal";
      const extra = [
        result.partial && result.nextCursor == null ? "partial/capped" : null,
        result.diagnostic,
      ]
        .filter(Boolean)
        .join(" · ");
      const ordinal = base + index + 1;
      const totalLabel =
        result.totalMatched != null
          ? String(result.totalMatched)
          : result.nextCursor != null
            ? `${base + seqs.length}+`
            : String(base + seqs.length);
      setStatus(
        seqs.length
          ? `Find (${modeLabel}): match ${ordinal} of ${totalLabel} for “${q}”${
              extra ? ` (${extra})` : ""
            } (context preserved; ${seqs.length} result identities resident)`
          : `Find (${modeLabel}): no matches for “${q}”${
              result.diagnostic ? ` — ${result.diagnostic}` : ""
            }`,
      );
    } catch (e) {
      if (requestId !== findRequestRef.current) return;
      setError(String(e));
    } finally {
      if (requestId === findRequestRef.current) setBusy(false);
    }
  };

  const runFind = async () => {
    await requestFindPage(null, 0, [], "first", filters);
  };

  findRefreshRef.current = (nextFilters) => {
    if (!findActiveRef.current) return;
    void requestFindPage(null, 0, [], "first", nextFilters);
  };

  useEffect(() => {
    findRefreshRef.current(filters);
  }, [filters]);

  const findStep = async (dir: 1 | -1) => {
    if (findMatches.length === 0) {
      if (dir === 1 && findNextCursor) {
        await requestFindPage(
          findNextCursor,
          findBase,
          [...findHistory, { start: findPageStart, base: findBase }],
          "first",
          filters,
        );
      } else if (dir === -1) {
        const previous = findHistory.at(-1);
        if (previous) {
          await requestFindPage(
            previous.start,
            previous.base,
            findHistory.slice(0, -1),
            "last",
            filters,
          );
        }
      }
      return;
    }
    if (dir === 1 && findIndex === findMatches.length - 1) {
      if (!findNextCursor) {
        setStatus("Find: end of results");
        return;
      }
      await requestFindPage(
        findNextCursor,
        findBase + findMatches.length,
        [...findHistory, { start: findPageStart, base: findBase }],
        "first",
        filters,
      );
      return;
    }
    if (dir === -1 && findIndex === 0) {
      const previous = findHistory.at(-1);
      if (!previous) {
        setStatus("Find: beginning of results");
        return;
      }
      await requestFindPage(
        previous.start,
        previous.base,
        findHistory.slice(0, -1),
        "last",
        filters,
      );
      return;
    }
    const next = findIndex + dir;
    setFindIndex(next);
    const seq = findMatches[next]!;
    const resident = laneEvents["lane-0"] ?? [];
    if (!resident.some((e) => e.seq === seq)) {
      await seekToSeq(seq);
    } else {
      setLaneScrollSeq((m) => ({ ...m, "lane-0": seq }));
    }
    setStatus(
      `Find: match ${findBase + next + 1} of ${
        findTotalExact ? findTotal : `${Math.max(findTotal, findBase + findMatches.length)}+`
      }`,
    );
  };

  /** Filter: reduce visible events by keyword ∩ facets (#523). */
  const applyFilterKeyword = () => {
    const kw = filterDraft.trim() || null;
    setFilters((f) => ({ ...f, keyword: kw }));
    setStatus(
      kw
        ? `Filter: keyword “${kw}” (intersects levels/sources/time)`
        : "Filter: keyword cleared",
    );
  };

  const onRowClick = (e: ExplorerEventDto, multi: boolean) => {
    setDetail(e);
    setSelected((prev) => {
      const next = new Set(multi ? prev : []);
      if (next.has(e.seq)) next.delete(e.seq);
      else next.add(e.seq);
      return next;
    });
    if (linkMode !== "independent" && laneCount > 1) {
      const packed = lanes.slice(0, laneCount).map((l) => ({
        id: l.id,
        events: (laneEvents[l.id] ?? []).map((x): LaneEventRef => ({
          seq: x.seq,
          ts: x.ts,
        })),
      }));
      const scrub = scrubLinked(e.ts, packed, timeQuality);
      if (scrub.linked) {
        const scrollMap: Record<string, number | null> = {};
        const hl = new Set<number>();
        for (const p of scrub.peerPositions) {
          scrollMap[p.laneId] = p.seq;
          if (p.seq != null) hl.add(p.seq);
        }
        setLaneScrollSeq(scrollMap);
        setHighlight(hl);
        setStatus(
          `Linked cursor ts=${e.ts} · ${scrub.peerPositions
            .map((p) => `${p.laneId}→${p.seq ?? "—"}`)
            .join(" · ")}`,
        );
      } else if (scrub.refuseReason) {
        setStatus(scrub.refuseReason);
      }
    }
  };

  const bookmarkSelection = async () => {
    const seqs = [...selected].sort((a, b) => a - b);
    if (seqs.length === 0 && detail) seqs.push(detail.seq);
    if (seqs.length === 0) {
      setStatus("Select a row (or focus detail) then press B to bookmark");
      return;
    }
    const from = seqs[0]!;
    const to = seqs[seqs.length - 1]!;
    try {
      const bm = await hostLogAddBookmark(corpusId, {
        seqFrom: from,
        seqTo: to,
        label: from === to ? `seq ${from}` : `seq ${from}–${to}`,
        tsFrom: detail?.ts ?? null,
        tsTo: detail?.ts ?? null,
      });
      setBookmarks((b) => [...b, bm]);
      setStatus(`Bookmarked ${bm.label}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const onKeyDown = (ev: ReactKeyboardEvent) => {
    if (
      (ev.metaKey || ev.ctrlKey) &&
      ev.key.toLowerCase() === "f"
    ) {
      ev.preventDefault();
      setNarrowFiltersOpen(true);
      setNarrowChatOpen(false);
      findInputRef.current?.focus();
      return;
    }
    if (ev.key === "b" || ev.key === "B") {
      if (
        (ev.target as HTMLElement)?.tagName === "INPUT" ||
        (ev.target as HTMLElement)?.tagName === "TEXTAREA"
      ) {
        return;
      }
      ev.preventDefault();
      void bookmarkSelection();
    }
  };

  /** #533: drop selection/detail that is no longer in any resident lane. */
  useEffect(() => {
    const resident = new Set(
      Object.values(laneEvents)
        .flat()
        .map((e) => e.seq),
    );
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((s) => resident.has(s)));
      if (next.size === prev.size) return prev;
      if (next.size === 0) {
        setStatus(
          "Selection cleared — event no longer visible under filters/lanes",
        );
      }
      return next;
    });
    setDetail((d) => (d && !resident.has(d.seq) ? null : d));
  }, [laneEvents]);

  /** #531: activate bookmark — direct neighborhood seek (no multi-page scan). */
  const activateBookmark = async (b: LogBookmarkDto) => {
    const seq = b.seqFrom;
    setHighlight(
      new Set(
        Array.from(
          { length: Math.max(1, b.seqTo - b.seqFrom + 1) },
          (_, i) => b.seqFrom + i,
        ),
      ),
    );

    setBusy(true);
    setError(null);
    try {
      // Resolve the stable target under current global filters. Hidden results
      // still return the target identity so the correct source lane can be
      // selected or temporarily composed.
      const resolved = await hostLogQueryEventNeighborhood(corpusId, {
        targetSeq: seq,
        before: 0,
        after: 0,
        filter: filtersToQuery(filters),
        sortByTime: true,
      });
      if (resolved.status === "missing" || !resolved.target) {
        setBookmarkRevealState("missing");
        setStatus(
          `Bookmark target seq ${seq} not found in corpus (source may have changed)`,
        );
        return;
      }

      const visibleLanes = lanes.slice(0, laneCount);
      const matchingLane =
        visibleLanes.find(
          (lane) =>
            lane.sources.length > 0 &&
            lane.sources.includes(resolved.target!.source),
        ) ?? visibleLanes.find((lane) => lane.sources.length === 0);

      if (resolved.status === "found" && matchingLane) {
        const residentTarget = (laneEvents[matchingLane.id] ?? []).find(
          (event) => event.seq === seq,
        );
        if (residentTarget) {
          setFocusLaneId(matchingLane.id);
          setLaneScrollSeq((m) => ({ ...m, [matchingLane.id]: seq }));
          setDetail(residentTarget);
          setSelected(new Set([seq]));
          setBookmarkRevealState("visible");
          setStatus(`Bookmark visible: ${b.label}`);
          return;
        }
        const status = await seekToSeq(seq, {
          laneId: matchingLane.id,
          sources:
            matchingLane.sources.length > 0
              ? matchingLane.sources
              : filters.sources,
        });
        if (status !== "found") {
          throw new Error("Bookmark target changed while it was being revealed");
        }
        setBookmarkRevealState("visible");
        setStatus(`Bookmark visible under current filters: ${b.label}`);
        return;
      }

      // Hidden by filters or absent from current lane composition: preserve
      // the complete prior view and explicitly create a temporary reveal.
      if (!revealRestore) {
        setRevealRestore({
          filters: { ...filters },
          lanes: lanes.map((lane) => ({
            ...lane,
            sources: [...lane.sources],
          })),
          laneCount,
        });
      }
      const openFilters = emptyFilters();
      let revealLanes = lanes;
      let revealLane = matchingLane;
      if (!revealLane) {
        const first = lanes[0] ?? defaultLanes(1)[0]!;
        revealLane = {
          ...first,
          label: `Bookmark · ${resolved.target.source}`,
          sources: [resolved.target.source],
        };
        revealLanes = [revealLane, ...lanes.slice(1)];
        setLanes(revealLanes);
      }
      setFilters(openFilters);
      setFilterDraft("");
      const status = await seekToSeq(seq, {
        clearFilters: true,
        laneId: revealLane.id,
        sources: [resolved.target.source],
      });
      if (status === "found") {
        setBookmarkRevealState("revealed");
        setStatus(
          `Bookmark temporarily revealed: ${b.label} — filters cleared; restore prior view when done`,
        );
      } else if (status === "missing") {
        setBookmarkRevealState("missing");
        setStatus(
          `Bookmark target seq ${seq} not found in corpus (source may have changed)`,
        );
      } else {
        setBookmarkRevealState("missing");
        setStatus(`Bookmark target still not visible: ${b.label}`);
      }
    } catch (e) {
      setError(String(e));
      setBookmarkRevealState("missing");
    } finally {
      setBusy(false);
    }
  };

  const restorePriorView = () => {
    if (revealRestore) {
      setFilters(revealRestore.filters);
      setFilterDraft(revealRestore.filters.keyword ?? "");
      setLanes(revealRestore.lanes);
      setLaneCount(revealRestore.laneCount);
      setRevealRestore(null);
      setBookmarkRevealState("idle");
      setStatus("Restored prior Explorer view");
    }
  };

  const applyNav = (action: LogNavAction) => {
    const result = applyLogNav(filters, action, corpusId);
    if (!result.corpusMatch) {
      setStatus("log_nav corpus mismatch — ignored (fail closed)");
      return;
    }
    setFilters(result.filters);
    setHighlight(new Set(result.highlightSeq));
    if (result.focusLane) {
      setFocusLaneId(result.focusLane);
      // Ensure multi-lane view if agent targets a non-default lane.
      if (laneCount < 2 && result.focusLane !== "lane-0") {
        configureLanes(Math.min(4, Math.max(2, lanes.length || 2)));
      }
      setStatus(
        result.label
          ? `Applied nav: ${result.label} · focus ${result.focusLane}`
          : `Applied log_nav · focus ${result.focusLane}`,
      );
    } else {
      setStatus(
        result.label
          ? `Applied nav: ${result.label}`
          : "Applied log_nav filters",
      );
    }
  };

  const agentContext = useMemo(
    () => ({
      corpusId,
      timeQuality,
      // Agent snapshot keeps a boolean "linked" flag; mode name is in brief.
      linkMode: linkMode !== "independent",
      lanes: lanes
        .slice(0, laneCount)
        .map((l) => `${l.label || l.id}:[${l.sources.join(",") || "*"}]`),
      levels: filters.levels,
      sources: filters.sources,
      keyword: filters.keyword,
      selectedCount: selected.size,
      bookmarkCount: bookmarks.length,
      brief: `${viewBrief}; timeLink=${linkMode}`,
    }),
    [
      corpusId,
      timeQuality,
      linkMode,
      lanes,
      laneCount,
      filters.levels,
      filters.sources,
      filters.keyword,
      selected.size,
      bookmarks.length,
      viewBrief,
    ],
  );

  const laneSourceFilter = (laneId: string) => {
    const lane = lanes.find((l) => l.id === laneId);
    return lane && lane.sources.length > 0
      ? lane.sources
      : filters.sources.length > 0
        ? filters.sources
        : undefined;
  };

  const loadMoreLane = async (laneId: string) => {
    const cur = laneCursors[laneId];
    if (!cur?.hasNewer || cur.afterSeq == null || cur.afterTs == null) return;
    if (pagingInflight.current[laneId]) return;
    pagingInflight.current[laneId] = "newer";
    const requestId = eventsRequestRef.current;
    setLanePaging((previous) => ({
      ...previous,
      [laneId]: {
        loading: "newer",
        error: null,
        failedDirection: null,
      },
    }));
    try {
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(filters, {
          sources: laneSourceFilter(laneId),
          afterSeq: cur.afterSeq,
          afterTs: cur.afterTs,
          sortByTime: true,
          limit: 100,
        }),
      );
      if (requestId !== eventsRequestRef.current) return;
      const resident = {
        events: laneEvents[laneId] ?? [],
        afterSeq: cur.afterSeq,
        afterTs: cur.afterTs,
        beforeSeq: cur.beforeSeq,
        beforeTs: cur.beforeTs,
        totalMatched: totalMatched,
      };
      const { window, droppedFromHead } = appendNewer(
        resident,
        page,
        DEFAULT_MAX_RESIDENT,
      );
      setLaneEvents((prev) => ({ ...prev, [laneId]: window.events }));
      setLaneMatched((prev) => ({ ...prev, [laneId]: page.totalMatched }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: cur.hasOlder || droppedFromHead > 0,
          hasNewer: page.nextCursor != null,
        },
      }));
      if (laneId === "lane-0") setNextCursor(page.nextCursor);
      if (page.events.length > 0) {
        setLaneTimeStates((previous) => {
          const prior = previous[laneId];
          const quality =
            prior?.status === "loaded" && prior.quality != null
              ? leastReliableTimeQuality([prior.quality, page.timeQuality])
              : page.timeQuality;
          const next = {
            ...previous,
            [laneId]: {
              status: "loaded",
              quality,
            } satisfies LaneTimeState,
          };
          setTimeQuality(
            aggregateLaneTimeQuality(
              lanes.slice(0, laneCount).map((visible) => visible.id),
              next,
            ),
          );
          return next;
        });
      }
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: null,
          failedDirection: null,
        },
      }));
      setStatus(
        `Lane ${laneId}: +${page.events.length} newer · ${window.events.length} resident`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: String(e),
          failedDirection: "newer",
        },
      }));
    } finally {
      pagingInflight.current[laneId] = null;
    }
  };

  const loadOlderLane = async (laneId: string) => {
    const cur = laneCursors[laneId];
    if (!cur?.hasOlder || cur.beforeSeq == null || cur.beforeTs == null) return;
    if (pagingInflight.current[laneId]) return;
    pagingInflight.current[laneId] = "older";
    const requestId = eventsRequestRef.current;
    setLanePaging((previous) => ({
      ...previous,
      [laneId]: {
        loading: "older",
        error: null,
        failedDirection: null,
      },
    }));
    try {
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(filters, {
          sources: laneSourceFilter(laneId),
          beforeSeq: cur.beforeSeq,
          beforeTs: cur.beforeTs,
          sortByTime: true,
          limit: 100,
        }),
      );
      if (requestId !== eventsRequestRef.current) return;
      const resident = {
        events: laneEvents[laneId] ?? [],
        afterSeq: cur.afterSeq,
        afterTs: cur.afterTs,
        beforeSeq: cur.beforeSeq,
        beforeTs: cur.beforeTs,
        totalMatched: totalMatched,
      };
      const { window, droppedFromTail } = prependOlder(
        resident,
        page,
        DEFAULT_MAX_RESIDENT,
      );
      setLaneEvents((prev) => ({ ...prev, [laneId]: window.events }));
      setLaneMatched((prev) => ({ ...prev, [laneId]: page.totalMatched }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: page.prevCursor != null,
          hasNewer: cur.hasNewer || droppedFromTail > 0,
        },
      }));
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: null,
          failedDirection: null,
        },
      }));
      setStatus(
        `Lane ${laneId}: +${page.events.length} older · ${window.events.length} resident`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: String(e),
          failedDirection: "older",
        },
      }));
    } finally {
      pagingInflight.current[laneId] = null;
    }
  };

  const loadMore = async () => {
    if (laneCount <= 1) {
      await loadMoreLane("lane-0");
      return;
    }
    for (const lane of lanes.slice(0, laneCount)) {
      if (laneCursors[lane.id]?.hasNewer) {
        await loadMoreLane(lane.id);
      }
    }
  };

  /** User-composed lanes: change count without inventing first-N source assignment (#486). */
  const configureLanes = (n: number) => {
    const count = clampLaneCount(n);
    setLaneCount(count);
    setLanes((prev) => {
      const next = resizeLaneList(prev, count);
      saveLanes(corpusId, next);
      return next;
    });
    if (count === 1) setLaneScrollSeq({});
  };

  const updateLaneSources = (laneId: string, source: string) => {
    setLanes((prev) => {
      const next = prev.map((l) =>
        l.id === laneId ? toggleLaneSource(l, source) : l,
      );
      saveLanes(corpusId, next);
      return next;
    });
  };

  const setTimeLinkMode = (mode: TimeLinkMode) => {
    setLinkMode(mode);
    saveLinkMode(corpusId, mode);
  };

  const densityClass = density === "compact" ? "log-explorer--compact" : "";
  const bpClass = `log-explorer--${breakpoint}`;
  const narrowClass = [
    narrowFiltersOpen ? "log-explorer--filters-open" : "",
    narrowChatOpen ? "log-explorer--chat-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const bodyStyle =
    breakpoint === "narrow"
      ? undefined
      : ({
          gridTemplateColumns: `${filterW}px 6px 1fr 6px ${chatW}px`,
        } as React.CSSProperties);

  const toggleExpand = (seq: number) => {
    setExpandedSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  // Per-lane truthful counts (#534).
  const laneMatchedHint = (laneId: string) => {
    const n = (laneEvents[laneId] ?? []).length;
    const cur = laneCursors[laneId];
    const matched = laneMatched[laneId];
    const more =
      cur?.hasNewer || cur?.hasOlder ? "+" : "";
    return `${matched == null ? "matched unavailable" : `${matched} matched`} · ${n}${more} resident`;
  };

  return (
    <div
      ref={rootRef}
      className={["log-explorer", bpClass, densityClass, narrowClass]
        .filter(Boolean)
        .join(" ")}
      data-testid="log-explorer"
      data-breakpoint={breakpoint}
      data-density={density}
      data-line-mode={lineMode}
      data-lane-count={laneCount}
      data-link-mode={linkMode}
      data-time-quality={timeQuality}
      data-resizable="true"
      onKeyDown={onKeyDown}
    >
      <header className="log-explorer__titlebar">
        <div className="log-explorer__title">
          Log Explorer · {summary?.name ?? corpusId.slice(0, 8)}
        </div>
        <div
          className="log-explorer__meta"
          data-testid="log-explorer-global-counts"
        >
          <span
            className={
              timeQuality === "order_only"
                ? "log-explorer__badge log-explorer__badge--warn"
                : "log-explorer__badge"
            }
            title={timeQualityLabel(timeQuality)}
          >
            {timeQualityLabel(timeQuality)}
          </span>
          <span className="log-explorer__badge">
            {corpusTotal.toLocaleString()} corpus events
          </span>
          {laneCount === 1 && (
            <span className="log-explorer__badge">
              {totalMatched.toLocaleString()} matched
            </span>
          )}
          {laneCount > 1 && (
            <span className="log-explorer__badge">{laneCount} lane queries</span>
          )}
          <span className="log-explorer__badge">{breakpoint}</span>
        </div>
        <div className="log-explorer__toolbar">
          {(
            [
              ["independent", "Indep"],
              ["follow_cursor", "Follow"],
              ["align_time", "Align"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`log-explorer__btn ${linkMode === mode ? "log-explorer__btn--active" : ""}`}
              data-testid={`time-link-${mode}`}
              title={
                mode === "independent"
                  ? "Lanes page and scroll independently"
                  : mode === "follow_cursor"
                    ? "Selecting an event seeks peers to nearest time (not row alignment)"
                    : "Align lanes on a shared vertical time axis with explicit gap bands"
              }
              onClick={() => {
                if (mode !== "independent" && timeQuality === "order_only") {
                  setStatus(
                    "Time link unavailable: order-only time cannot claim wall-clock alignment",
                  );
                  return;
                }
                if (mode !== "independent" && timeQuality === "mixed") {
                  setStatus(
                    "Time link uses mixed time quality; inspect each lane badge before interpreting gaps",
                  );
                }
                setTimeLinkMode(mode);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`log-explorer__btn ${laneEditorOpen ? "log-explorer__btn--active" : ""}`}
            data-testid="lane-editor-toggle"
            onClick={() => setLaneEditorOpen((o) => !o)}
            title="Compose which sources belong to each lane"
          >
            Lanes…
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() =>
              setDensity((d) => (d === "compact" ? "comfortable" : "compact"))
            }
          >
            {density}
          </button>
          {breakpoint !== "narrow" &&
            [1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={`log-explorer__btn ${laneCount === n ? "log-explorer__btn--active" : ""}`}
                onClick={() => configureLanes(n)}
                title={`${n} evidence lane${n > 1 ? "s" : ""}`}
              >
                {n}L
              </button>
            ))}
          {(["compact", "wrap", "full"] as LineMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`log-explorer__btn ${lineMode === mode ? "log-explorer__btn--active" : ""}`}
              data-testid={`line-mode-${mode}`}
              onClick={() => setLineMode(mode)}
              title={`Message lines: ${mode}`}
            >
              {mode}
            </button>
          ))}
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="col-autofit"
            title="Auto-fit columns to source lengths"
            onClick={() => {
              const sources = Object.keys(facets?.sources ?? {});
              setColWidths(autoFitColWidths(sources));
              setStatus("Columns auto-fitted");
            }}
          >
            Auto-fit cols
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="col-reset"
            title="Reset column widths to defaults"
            onClick={() => {
              setColWidths([...DEFAULT_COL_WIDTHS]);
              setStatus("Column widths reset");
            }}
          >
            Reset cols
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() => void bookmarkSelection()}
          >
            Bookmark (B)
          </button>
        </div>
      </header>

      <div
        className="log-explorer__col-headers"
        data-testid="log-explorer-col-headers"
        role="row"
        style={{
          gridTemplateColumns: `${colWidths[0]}rem ${colWidths[1]}rem minmax(${colWidths[2]}rem, ${colWidths[2] + 2}rem) minmax(8rem, 1fr)`,
        }}
      >
        {(
          [
            { label: "Time", index: 0 as const },
            { label: "Lvl", index: 1 as const },
            { label: "Source", index: 2 as const },
          ] as const
        ).map((col) => (
          <div key={col.label} className="log-explorer__col-header" role="columnheader">
            <span>{col.label}</span>
            <button
              type="button"
              className="log-explorer__col-resizer"
              data-testid={`col-resize-${col.index}`}
              aria-label={`Resize ${col.label} column`}
              title="Drag or use ← → to resize"
              onMouseDown={(e) => {
                e.preventDefault();
                colDragRef.current = {
                  index: col.index,
                  startX: e.clientX,
                  startW: colWidths[col.index],
                };
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  setColWidths((w) => resizeCol(w, col.index, -0.5));
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  setColWidths((w) => resizeCol(w, col.index, 0.5));
                }
              }}
            />
          </div>
        ))}
        <div className="log-explorer__col-header" role="columnheader">
          Message
        </div>
      </div>

      {laneEditorOpen && (
        <div
          className="log-explorer__lane-editor"
          data-testid="lane-editor"
          role="region"
          aria-label="Lane source composition"
        >
          <div className="log-explorer__section-title">
            Compose lanes (empty membership = all sources)
          </div>
          {lanes.slice(0, laneCount).map((lane) => (
            <div key={lane.id} className="log-explorer__lane-editor-row">
              <strong>{lane.label}</strong>
              <div className="log-explorer__facet">
                {Object.keys(facets?.sources ?? {})
                  .sort()
                  .slice(0, 40)
                  .map((src) => (
                    <label key={src} className="log-explorer__facet-row">
                      <input
                        type="checkbox"
                        checked={lane.sources.includes(src)}
                        onChange={() => updateLaneSources(lane.id, src)}
                      />
                      <span title={src}>{src}</span>
                    </label>
                  ))}
              </div>
              <div className="log-explorer__chat-preview">
                {lane.sources.length === 0
                  ? "All sources"
                  : `${lane.sources.length} source(s)`}
                {" · "}same source may appear in multiple lanes
              </div>
            </div>
          ))}
        </div>
      )}

      {breakpoint === "narrow" && (
        <div
          className="log-explorer__narrow-tabs"
          data-testid="log-explorer-narrow-tabs"
        >
          <button
            type="button"
            className={`log-explorer__btn ${narrowFiltersOpen ? "log-explorer__btn--active" : ""}`}
            data-testid="narrow-filters-toggle"
            aria-expanded={narrowFiltersOpen}
            onClick={() => {
              setNarrowFiltersOpen((o) => !o);
              setNarrowChatOpen(false);
            }}
          >
            Filters
            {filters.levels.length + filters.sources.length > 0
              ? ` (${filters.levels.length + filters.sources.length})`
              : ""}
          </button>
          <button
            type="button"
            className={`log-explorer__btn ${narrowChatOpen ? "log-explorer__btn--active" : ""}`}
            data-testid="narrow-chat-toggle"
            aria-expanded={narrowChatOpen}
            onClick={() => {
              setNarrowChatOpen((o) => !o);
              setNarrowFiltersOpen(false);
            }}
          >
            Chat
          </button>
        </div>
      )}

      <div
        className="log-explorer__body"
        style={bodyStyle}
        data-testid="log-explorer-body"
      >
        <aside
          className="log-explorer__filters"
          data-testid="log-explorer-filters"
        >
          <div className="log-explorer__section-title">
            Find{" "}
            <HelpTip label="Find vs Filter" title="Find vs Filter" content={HELP_FIND_VS_FILTER} />
          </div>
          <input
            ref={findInputRef}
            className="log-explorer__search"
            placeholder={
              findMatchMode === "regex"
                ? "Regex (linear-time, bounded)…"
                : "Find in corpus (keeps surrounding rows)…"
            }
            value={findDraft}
            onChange={(e) => {
              const next = e.target.value;
              setFindDraft(next);
              if (
                findActiveQuery != null &&
                next.trim() !== findActiveQuery
              ) {
                clearFindResults("Find term changed — press Find to apply");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runFind();
            }}
            aria-label="Find in logs"
            data-testid="log-explorer-find"
          />
          <div className="log-explorer__find-actions">
            <button
              type="button"
              className="log-explorer__btn"
              data-testid="log-explorer-find-run"
              onClick={() => void runFind()}
            >
              Find
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              data-testid="log-explorer-find-prev"
              disabled={
                findHistory.length === 0 &&
                (findMatches.length === 0 || findIndex === 0)
              }
              onClick={() => void findStep(-1)}
            >
              Prev
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              data-testid="log-explorer-find-next"
              disabled={
                !findNextCursor &&
                (findMatches.length === 0 ||
                  findIndex === findMatches.length - 1)
              }
              onClick={() => void findStep(1)}
            >
              Next
            </button>
            <button
              type="button"
              className={`log-explorer__btn ${advancedOpen ? "log-explorer__btn--active" : ""}`}
              data-testid="log-explorer-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              Advanced
            </button>
          </div>
          {advancedOpen ? (
            <div
              className="log-explorer__advanced-search"
              data-testid="log-explorer-advanced-search"
              role="group"
              aria-label="Advanced search options"
            >
              <p className="log-explorer__chat-preview">
                Explicit controls — no hidden query grammar. Regex uses a
                linear-time engine with pattern-length, result, and scan caps.
              </p>
              <label className="log-explorer__facet-row">
                <input
                  type="radio"
                  name="find-mode"
                  checked={findMatchMode === "literal"}
                  onChange={() => {
                    setFindMatchMode("literal");
                    if (findActiveRef.current) {
                      clearFindResults(
                        "Find mode changed — press Find to apply",
                      );
                    }
                  }}
                  data-testid="find-mode-literal"
                />
                Literal text
              </label>
              <label className="log-explorer__facet-row">
                <input
                  type="radio"
                  name="find-mode"
                  checked={findMatchMode === "regex"}
                  onChange={() => {
                    setFindMatchMode("regex");
                    if (findActiveRef.current) {
                      clearFindResults(
                        "Find mode changed — press Find to apply",
                      );
                    }
                  }}
                  data-testid="find-mode-regex"
                />
                Regex (bounded)
              </label>
              <label className="log-explorer__facet-row">
                <input
                  type="checkbox"
                  checked={findCaseSensitive}
                  onChange={(e) => {
                    setFindCaseSensitive(e.target.checked);
                    if (findActiveRef.current) {
                      clearFindResults(
                        "Case option changed — press Find to apply",
                      );
                    }
                  }}
                  data-testid="find-case-sensitive"
                />
                Case sensitive
              </label>
              <label className="log-explorer__facet-row">
                <input
                  type="checkbox"
                  checked={findUseSemantic}
                  disabled={
                    !semanticAvailable || findMatchMode === "regex"
                  }
                  onChange={(e) => {
                    setFindUseSemantic(e.target.checked);
                    if (findActiveRef.current) {
                      clearFindResults(
                        "Semantic option changed — press Find to apply",
                      );
                    }
                  }}
                  data-testid="find-semantic"
                />
                Template semantic
                {!semanticAvailable ? " (unavailable)" : ""}
              </label>
              <p className="log-explorer__chat-preview">
                Filters (level / source / time) in this rail always intersect
                Find. Facet chips never discard the active predicate.
              </p>
            </div>
          ) : null}
          {findTotal > 0 ? (
            <div
              className="log-explorer__chat-preview"
              data-testid="log-explorer-find-count"
            >
              Match {findBase + findIndex + 1} of{" "}
              {findTotalExact ? findTotal : `${findTotal}+`}
              {findPartial && !findNextCursor ? " (partial)" : ""}
              {" · "}
              {findMatches.length} result identities resident
            </div>
          ) : null}

          <div className="log-explorer__section-title">Filter</div>
          <input
            className="log-explorer__search"
            placeholder="Filter keyword (reduces rows)…"
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilterKeyword();
            }}
            aria-label="Filter logs"
            data-testid="log-explorer-filter"
          />
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="log-explorer-filter-apply"
            onClick={() => applyFilterKeyword()}
          >
            Apply filter
          </button>
          {(filters.keyword ||
            filters.levels.length > 0 ||
            filters.sources.length > 0) && (
            <div
              className="log-explorer__active-facets"
              data-testid="log-explorer-active-facets"
            >
              {filters.keyword ? (
                <button
                  type="button"
                  className="log-explorer__nav-chip"
                  onClick={() => {
                    setFilterDraft("");
                    setFilters((f) => ({ ...f, keyword: null }));
                  }}
                >
                  keyword:{filters.keyword} ×
                </button>
              ) : null}
              {filters.levels.map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  className="log-explorer__nav-chip"
                  onClick={() => toggleLevel(lvl)}
                >
                  level:{lvl} ×
                </button>
              ))}
              {filters.sources.map((src) => (
                <button
                  key={src}
                  type="button"
                  className="log-explorer__nav-chip"
                  onClick={() => toggleSource(src)}
                >
                  source:{src} ×
                </button>
              ))}
            </div>
          )}
          <p className="log-explorer__chat-preview" role="note">
            Find highlights without removing rows. Filter reduces the table and
            intersects levels/sources/time.
            {semanticAvailable
              ? " Template-semantic ranking is available for advanced search."
              : " Keyword-only corpus · re-analyze for semantic."}
          </p>
          <div
            className="log-explorer__chat-preview"
            data-testid="log-explorer-count-truth"
          >
            {/* #534: label totals separately — never use max-per-lane as global. */}
            Corpus {(corpusTotal || summary?.eventCount || 0).toLocaleString()} ·{" "}
            {laneCount === 1
              ? `matched ${totalMatched.toLocaleString()} · `
              : "matched per lane below · "}
            resident rows{" "}
            {Object.values(laneEvents).reduce((n, e) => n + e.length, 0)}
            {laneCount > 1
              ? ` · ${laneCount} lanes (per-lane counts in headers)`
              : ""}
          </div>

          <div className="log-explorer__section-title">Levels</div>
          <div className="log-explorer__facet">
            {Object.entries(facets?.levels ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([lvl, count]) => (
                <label key={lvl} className="log-explorer__facet-row">
                  <input
                    type="checkbox"
                    checked={filters.levels.includes(lvl)}
                    onChange={() => toggleLevel(lvl)}
                  />
                  <span className={levelClass(lvl)}>{lvl}</span>
                  <span className="count">{count}</span>
                </label>
              ))}
          </div>

          <div className="log-explorer__section-title">Sources</div>
          <div className="log-explorer__facet">
            {Object.entries(facets?.sources ?? {})
              .sort((a, b) => b[1] - a[1])
              .slice(0, 40)
              .map(([src, count]) => (
                <label key={src} className="log-explorer__facet-row">
                  <input
                    type="checkbox"
                    checked={filters.sources.includes(src)}
                    onChange={() => toggleSource(src)}
                  />
                  <span title={src}>{src}</span>
                  <span className="count">{count}</span>
                </label>
              ))}
          </div>

          <div className="log-explorer__section-title">Bookmarks</div>
          <div
            className="log-explorer__bookmarks"
            data-testid="log-explorer-bookmarks"
          >
            {revealRestore ? (
              <button
                type="button"
                className="log-explorer__btn log-explorer__btn--active"
                data-testid="bookmark-restore-view"
                onClick={restorePriorView}
              >
                Restore prior view
                {bookmarkRevealState === "revealed" ? " (temp reveal)" : ""}
              </button>
            ) : null}
            {bookmarkRevealState === "missing" ? (
              <div
                className="log-explorer__chat-preview"
                data-testid="bookmark-missing"
              >
                Bookmark target missing or unavailable
              </div>
            ) : null}
            {bookmarks.length === 0 ? (
              <div className="log-explorer__chat-preview">
                None yet — select rows + B
              </div>
            ) : (
              bookmarks.map((b) => (
                <div key={b.id} className="log-explorer__bm-item">
                  <button
                    type="button"
                    className="log-explorer__btn"
                    data-testid={`bookmark-activate-${b.id}`}
                    onClick={() => void activateBookmark(b)}
                  >
                    {b.label}
                  </button>
                  <button
                    type="button"
                    className="log-explorer__btn"
                    aria-label={`Delete bookmark ${b.label}`}
                    onClick={() =>
                      void hostLogDeleteBookmark(corpusId, b.id).then(() =>
                        setBookmarks((all) => all.filter((x) => x.id !== b.id)),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {breakpoint !== "narrow" && (
          <div
            className="log-explorer__splitter"
            data-testid="splitter-filters"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize filters"
            onMouseDown={startDrag("filters")}
          />
        )}

        <main className="log-explorer__lanes" data-testid="log-explorer-lanes">
          <div className="log-explorer__lane-strip">
            {linkMode !== "independent" && gaps.length > 0 && (
              <span className="log-explorer__badge log-explorer__badge--warn">
                {gaps.length} {timeQuality === "mixed" ? "potential " : ""}gap
                region{gaps.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div
            className={`log-explorer__lane-grid log-explorer__lane-grid--${laneCount}`}
          >
            {lanes.slice(0, laneCount).map((lane) => {
              const laneTime = laneTimeStates[lane.id] ?? {
                status: "unloaded",
                quality: null,
              };
              const laneTimeLabel =
                laneTime.status === "loaded" && laneTime.quality != null
                  ? timeQualityLabel(laneTime.quality)
                  : laneTime.status === "empty"
                    ? "time unavailable · empty"
                    : laneTime.status === "error"
                      ? "time unavailable · load failed"
                      : "time unavailable · loading";
              return (
                <section
                  key={lane.id}
                  className={[
                    "log-explorer__lane",
                    focusLaneId === lane.id ? "log-explorer__lane--focus" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-lane-id={lane.id}
                  data-focused={focusLaneId === lane.id ? "true" : "false"}
                  data-time-status={laneTime.status}
                  data-time-quality={laneTime.quality ?? "unavailable"}
                >
                  <div className="log-explorer__lane-header">
                    <strong>{lane.label}</strong>
                    <span
                      className={`log-explorer__badge ${
                        laneTime.quality === "order_only" ||
                        laneTime.quality == null
                          ? "log-explorer__badge--warn"
                          : ""
                      }`}
                    >
                      {laneTimeLabel}
                    </span>
                    <span
                      className="log-explorer__chat-preview"
                      data-testid={`lane-count-${lane.id}`}
                    >
                      {laneMatchedHint(lane.id)}
                      {focusLaneId === lane.id ? " · focused" : ""}
                    </span>
                  </div>
                  {linkMode !== "independent" &&
                    gaps.some((g) => g.emptyLaneIds.includes(lane.id)) && (
                      <div
                        className="log-explorer__gap-band"
                        title="Gap: this lane empty while peers have events"
                        data-testid="log-explorer-gap"
                      />
                    )}
                  <VirtualizedEventList
                    events={laneEvents[lane.id] ?? []}
                    timeQuality={timeQuality}
                    selected={selected}
                    highlight={highlight}
                    density={density}
                    lineMode={lineMode}
                    colWidths={colWidths}
                    expandedSeqs={expandedSeqs}
                    onToggleExpand={toggleExpand}
                    scrollToSeq={laneScrollSeq[lane.id] ?? null}
                    onRowClick={onRowClick}
                    onNearTop={() => void loadOlderLane(lane.id)}
                    onNearBottom={() => void loadMoreLane(lane.id)}
                  />
                  {lanePaging[lane.id]?.error ? (
                    <div
                      className="log-explorer__lane-page-error"
                      role="alert"
                      data-testid={`lane-page-error-${lane.id}`}
                    >
                      <span>
                        Could not load{" "}
                        {lanePaging[lane.id]?.failedDirection ?? "adjacent"}{" "}
                        events: {lanePaging[lane.id]?.error}
                      </span>
                      <button
                        type="button"
                        className="log-explorer__btn"
                        onClick={() =>
                          lanePaging[lane.id]?.failedDirection === "older"
                            ? void loadOlderLane(lane.id)
                            : void loadMoreLane(lane.id)
                        }
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}
                  <div
                    className="log-explorer__lane-paging"
                    aria-live="polite"
                    aria-label={`${lane.label} paging status`}
                  >
                    {!laneCursors[lane.id]?.hasOlder ? (
                      <span className="log-explorer__paging-boundary">
                        Beginning
                      </span>
                    ) : null}
                    {laneCursors[lane.id]?.hasOlder ? (
                      <button
                        type="button"
                        className="log-explorer__btn"
                        data-testid={`load-older-${lane.id}`}
                        disabled={lanePaging[lane.id]?.loading != null}
                        onClick={() => void loadOlderLane(lane.id)}
                      >
                        Load older
                      </button>
                    ) : null}
                    {lanePaging[lane.id]?.loading ? (
                      <span className="log-explorer__paging-loading">
                        Loading {lanePaging[lane.id]?.loading}…
                      </span>
                    ) : null}
                    {laneCursors[lane.id]?.hasNewer ? (
                      <button
                        type="button"
                        className="log-explorer__btn"
                        data-testid={`load-more-${lane.id}`}
                        data-lane-load-more={lane.id}
                        disabled={lanePaging[lane.id]?.loading != null}
                        onClick={() => void loadMoreLane(lane.id)}
                      >
                        Load newer
                      </button>
                    ) : null}
                    {!laneCursors[lane.id]?.hasNewer ? (
                      <span className="log-explorer__paging-boundary">End</span>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
          {detail && (
            <div
              className="log-explorer__detail"
              data-testid="log-explorer-detail"
              style={{ height: detailH, maxHeight: detailH }}
            >
              <div
                className="log-explorer__detail-resize"
                data-testid="detail-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize event inspector"
                tabIndex={0}
                onMouseDown={(e) => {
                  e.preventDefault();
                  detailDragRef.current = {
                    startY: e.clientY,
                    startH: detailH,
                  };
                  document.body.style.cursor = "row-resize";
                  document.body.style.userSelect = "none";
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setDetailH((h) => Math.min(640, h + 20));
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setDetailH((h) => Math.max(120, h - 20));
                  }
                }}
              />
              <div className="log-explorer__detail-toolbar">
                <strong>Event inspector · seq {detail.seq}</strong>
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="detail-copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      `${detail.seq}\t${detail.ts}\t${detail.level}\t${detail.source}\t${detail.message}`,
                    );
                    setStatus("Copied event to clipboard");
                  }}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="detail-close"
                  onClick={() => setDetail(null)}
                >
                  Close
                </button>
              </div>
              <div>
                {detail.source} ·{" "}
                <span className={levelClass(detail.level)}>{detail.level}</span>
              </div>
              <div className="log-explorer__ts">
                {formatEventTime(detail.ts, detail.timeQuality)} ·{" "}
                {timeQualityLabel(detail.timeQuality)}
              </div>
              <pre
                style={{ whiteSpace: "pre-wrap", margin: "0.4rem 0 0" }}
                data-testid="detail-message"
              >
                {detail.message}
              </pre>
              {(nextCursor != null ||
                Object.values(laneCursors).some((c) => c.afterSeq != null)) && (
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="load-more-all-lanes"
                  onClick={() => void loadMore()}
                >
                  Load more{laneCount > 1 ? " (all lanes)" : ""}
                </button>
              )}
            </div>
          )}
        </main>

        {breakpoint !== "narrow" && (
          <div
            className="log-explorer__splitter"
            data-testid="splitter-chat"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat"
            onMouseDown={startDrag("chat")}
          />
        )}

        <LinkedChatRail
          corpusId={corpusId}
          corpusName={summary?.name ?? corpusId.slice(0, 8)}
          agentContext={agentContext}
          onApplyNav={applyNav}
          compactLayout={breakpoint === "narrow"}
          developerMode={import.meta.env.MODE === "development"}
        />
      </div>

      <div className="log-explorer__status" role="status">
        {error ? `Error: ${error}` : status}
        {busy ? " · busy" : ""}
      </div>
    </div>
  );
}
