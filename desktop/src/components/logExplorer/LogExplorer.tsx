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
  hostLogQueryEvents,
  hostLogSearchEvents,
  hostSetActiveLogCorpus,
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
import { HelpTip } from "../HelpTip";
import { LinkedChatRail } from "./LinkedChatRail";
import {
  VirtualizedEventList,
  type LineMode,
} from "./VirtualizedEventList";
import "../../styles/components/log-explorer.css";

type Props = {
  corpusId: string;
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
  /** Per-lane scroll anchor adjust (rows prepended) for stable visual position. */
  const [laneScrollAdjust, setLaneScrollAdjust] = useState<
    Record<string, number>
  >({});
  const pagingInflight = useRef<Record<string, "older" | "newer" | null>>({});
  const [focusLaneId, setFocusLaneId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<ExplorerEventDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("comfortable");
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("normal");
  const [linkMode, setLinkMode] = useState(false);
  const [laneCount, setLaneCount] = useState(1);
  const [lanes, setLanes] = useState<LaneConfig[]>([
    { id: "lane-0", label: "All sources", sources: [] },
  ]);
  const [laneEvents, setLaneEvents] = useState<
    Record<string, ExplorerEventDto[]>
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
  const [filterDraft, setFilterDraft] = useState("");
  /** Find matches (ordered seqs) — does not reduce the table (#523). */
  const [findMatches, setFindMatches] = useState<number[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  /** Prior filters/view saved while a bookmark temporary reveal is active (#531). */
  const [revealRestore, setRevealRestore] = useState<ExplorerFilters | null>(
    null,
  );
  const [bookmarkRevealState, setBookmarkRevealState] = useState<
    "idle" | "visible" | "revealed" | "missing"
  >("idle");
  const [lineMode, setLineMode] = useState<LineMode>("compact");
  const [expandedSeqs, setExpandedSeqs] = useState<Set<number>>(new Set());
  const [narrowFiltersOpen, setNarrowFiltersOpen] = useState(false);
  const [narrowChatOpen, setNarrowChatOpen] = useState(false);
  const [detailH, setDetailH] = useState(180);
  const [status, setStatus] = useState("Ready");
  // Resizable columns (px)
  const [filterW, setFilterW] = useState(220);
  const [chatW, setChatW] = useState(300);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"filters" | "chat" | null>(null);
  const facetRequestRef = useRef(0);
  const eventsRequestRef = useRef(0);
  const semanticAvailable =
    (summary?.embedding?.embeddedTemplates ?? summary?.stats?.embedded ?? 0) >
    0;

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
        setLinkMode(false);
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
    setLaneTimeStates(unloaded);
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
        setLaneScrollAdjust({ "lane-0": 0 });
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
        let total = 0;
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
          total = Math.max(total, page.totalMatched);
          shown += page.events.length;
          states[lane.id] =
            page.events.length > 0
              ? { status: "loaded", quality: page.timeQuality }
              : { status: "empty", quality: null };
        }
        setLaneEvents(byLane);
        setLaneCursors(cursors);
        setLaneTimeStates(states);
        setTotalMatched(total);
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
          `${laneCount} lanes · ${shown} loaded (page) · up to ${total} matched per lane`,
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
    if (!linkMode || laneCount < 2) {
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
    if (timeQuality === "order_only" && linkMode) {
      setLinkMode(false);
      setGaps([]);
      setStatus(
        "Linked scroll disabled: at least one visible lane has order-only or unavailable time",
      );
    }
  }, [linkMode, timeQuality]);

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

  /**
   * Find: highlight matches in full investigation context (#523).
   * Does NOT replace the resident table with only hits.
   */
  const runFind = async () => {
    const q = findDraft.trim();
    if (!q) {
      setFindMatches([]);
      setFindIndex(0);
      setFindTotal(0);
      setHighlight(new Set());
      setStatus("Find cleared");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hits = await hostLogSearchEvents(corpusId, {
        query: q,
        // Find is keyword/locator only — do not claim semantic when unavailable.
        semantic: false,
        k: 500,
        // Compose with active filter facets but not a second keyword reduce.
        filter: filtersToQuery(filters, { keyword: null }),
      });
      const seqs = hits.map((h) => h.event.seq);
      setFindMatches(seqs);
      setFindTotal(seqs.length);
      setFindIndex(seqs.length > 0 ? 0 : 0);
      setHighlight(new Set(seqs));
      if (seqs.length > 0) {
        const first = seqs[0]!;
        setLaneScrollSeq((m) => ({ ...m, "lane-0": first }));
        // If not resident, request a window around the first match via before/after seed.
        const resident = laneEvents["lane-0"] ?? [];
        if (!resident.some((e) => e.seq === first)) {
          const page = await hostLogQueryEvents(
            corpusId,
            filtersToQuery(filters, {
              keyword: filters.keyword,
              // Jump by loading around match via after of prev if available is hard;
              // load first page with keyword null then user can page — better: seek by seq via before next.
              limit: 100,
              sortByTime: true,
            }),
          );
          // Prefer a page that includes the match by reverse+forward is complex;
          // seed and scroll when match is in page; else keep highlight + status.
          if (page.events.some((e) => e.seq === first)) {
            const seeded = seedFromPage(page);
            setLaneEvents((prev) => ({ ...prev, "lane-0": seeded.events }));
          }
        }
      }
      setStatus(
        seqs.length
          ? `Find: match 1 of ${seqs.length} for “${q}” (context preserved)`
          : `Find: no matches for “${q}”`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const findStep = (dir: 1 | -1) => {
    if (findMatches.length === 0) return;
    const next =
      (findIndex + dir + findMatches.length) % findMatches.length;
    setFindIndex(next);
    const seq = findMatches[next]!;
    setLaneScrollSeq((m) => ({ ...m, "lane-0": seq }));
    setStatus(`Find: match ${next + 1} of ${findMatches.length}`);
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
    if (linkMode && laneCount > 1) {
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

  /** #531: activate bookmark — reveal target even when filters hide it. */
  const activateBookmark = async (b: LogBookmarkDto) => {
    const seq = b.seqFrom;
    const resident = Object.values(laneEvents)
      .flat()
      .some((e) => e.seq >= b.seqFrom && e.seq <= b.seqTo);
    setHighlight(
      new Set(
        Array.from(
          { length: Math.max(1, b.seqTo - b.seqFrom + 1) },
          (_, i) => b.seqFrom + i,
        ),
      ),
    );
    setLaneScrollSeq((m) => ({ ...m, "lane-0": seq }));

    if (resident) {
      setBookmarkRevealState("visible");
      setStatus(`Bookmark visible: ${b.label}`);
      return;
    }

    // Temporarily clear source/level/keyword so the target can load.
    if (!revealRestore) {
      setRevealRestore({ ...filters });
    }
    const openFilters: ExplorerFilters = {
      ...filters,
      levels: [],
      sources: [],
      keyword: null,
    };
    setFilters(openFilters);
    setFilterDraft("");
    setBusy(true);
    try {
      // Seek a page that ends at/after the bookmark via before_cursor on seq+1
      // or load around by sequential pages — use direct after from 0 with limit
      // and keyword null, then check presence; if missing, try reverse from end.
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(openFilters, {
          limit: 100,
          sortByTime: true,
        }),
      );
      // Walk forward until we pass the bookmark or exhaust.
      let window = seedFromPage(page);
      let guard = 0;
      while (
        !window.events.some((e) => e.seq === seq) &&
        window.afterSeq != null &&
        window.afterTs != null &&
        guard < 40
      ) {
        guard += 1;
        const next = await hostLogQueryEvents(
          corpusId,
          filtersToQuery(openFilters, {
            afterSeq: window.afterSeq,
            afterTs: window.afterTs,
            limit: 100,
            sortByTime: true,
          }),
        );
        if (next.events.length === 0) break;
        window = appendNewer(window, next, DEFAULT_MAX_RESIDENT).window;
        if (next.nextCursor == null) break;
      }
      const found = window.events.find((e) => e.seq === seq);
      setLaneEvents((prev) => ({ ...prev, "lane-0": window.events }));
      setLaneCursors((prev) => ({
        ...prev,
        "lane-0": {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: window.beforeSeq != null,
          hasNewer: window.afterSeq != null,
        },
      }));
      if (found) {
        setDetail(found);
        setSelected(new Set([seq]));
        setBookmarkRevealState("revealed");
        setStatus(
          `Bookmark temporarily revealed: ${b.label} — restore prior view when done`,
        );
      } else {
        setBookmarkRevealState("missing");
        setStatus(
          `Bookmark target seq ${seq} not found in corpus (source may have changed)`,
        );
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
      setFilters(revealRestore);
      setFilterDraft(revealRestore.keyword ?? "");
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
      linkMode,
      lanes: lanes
        .slice(0, laneCount)
        .map((l) => `${l.label || l.id}:[${l.sources.join(",") || "*"}]`),
      levels: filters.levels,
      sources: filters.sources,
      keyword: filters.keyword,
      selectedCount: selected.size,
      bookmarkCount: bookmarks.length,
      brief: viewBrief,
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
    setBusy(true);
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
      const { window } = appendNewer(resident, page, DEFAULT_MAX_RESIDENT);
      setLaneEvents((prev) => ({ ...prev, [laneId]: window.events }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: window.beforeSeq != null,
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
      setStatus(
        `Lane ${laneId}: +${page.events.length} newer · ${window.events.length} resident`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setError(String(e));
    } finally {
      pagingInflight.current[laneId] = null;
      if (requestId === eventsRequestRef.current) setBusy(false);
    }
  };

  const loadOlderLane = async (laneId: string) => {
    const cur = laneCursors[laneId];
    if (!cur?.hasOlder || cur.beforeSeq == null || cur.beforeTs == null) return;
    if (pagingInflight.current[laneId]) return;
    pagingInflight.current[laneId] = "older";
    const requestId = eventsRequestRef.current;
    setBusy(true);
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
      const { window, prepended } = prependOlder(
        resident,
        page,
        DEFAULT_MAX_RESIDENT,
      );
      setLaneEvents((prev) => ({ ...prev, [laneId]: window.events }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: page.prevCursor != null,
          hasNewer: cur.hasNewer || page.events.length > 0,
        },
      }));
      if (prepended > 0) {
        setLaneScrollAdjust((prev) => ({
          ...prev,
          [laneId]: (prev[laneId] ?? 0) + prepended,
        }));
      }
      setStatus(
        `Lane ${laneId}: +${page.events.length} older · ${window.events.length} resident`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setError(String(e));
    } finally {
      pagingInflight.current[laneId] = null;
      if (requestId === eventsRequestRef.current) setBusy(false);
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

  const configureLanes = (n: number) => {
    const count = clampLaneCount(n);
    setLaneCount(count);
    const sources = Object.keys(facets?.sources ?? {});
    if (count === 1) {
      setLanes([{ id: "lane-0", label: "All sources", sources: [] }]);
      setLaneScrollSeq({});
      return;
    }
    const next: LaneConfig[] = [];
    for (let i = 0; i < count; i++) {
      const src = sources[i];
      next.push({
        id: `lane-${i}`,
        label: src ? src : `Lane ${i + 1}`,
        sources: src ? [src] : [],
      });
    }
    setLanes(next);
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
    const more =
      cur?.hasNewer || cur?.hasOlder ? "+" : "";
    return `${n}${more} resident`;
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
      data-link-mode={linkMode ? "on" : "off"}
      data-time-quality={timeQuality}
      data-resizable="true"
      onKeyDown={onKeyDown}
    >
      <header className="log-explorer__titlebar">
        <div className="log-explorer__title">
          Log Explorer · {summary?.name ?? corpusId.slice(0, 8)}
        </div>
        <div className="log-explorer__meta">
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
          <span className="log-explorer__badge">{totalMatched} events</span>
          <span className="log-explorer__badge">{breakpoint}</span>
        </div>
        <div className="log-explorer__toolbar">
          <button
            type="button"
            className={`log-explorer__btn ${linkMode ? "log-explorer__btn--active" : ""}`}
            onClick={() => {
              if (!linkMode && timeQuality === "order_only") {
                setStatus(
                  "Linked scroll unavailable: at least one visible lane has order-only or unavailable time",
                );
                return;
              }
              if (!linkMode && timeQuality === "mixed") {
                setStatus(
                  "Linked scroll uses mixed time quality; inspect each lane badge before interpreting gaps",
                );
              }
              setLinkMode((v) => !v);
            }}
            title="Timestamp-linked scroll across lanes"
          >
            Link {linkMode ? "ON" : "OFF"}
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
            onClick={() => void bookmarkSelection()}
          >
            Bookmark (B)
          </button>
        </div>
      </header>

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
            <HelpTip label="Find vs Filter" title="Find vs Filter">
              <p>
                <strong>Find</strong> highlights matches and steps next/prev
                while keeping surrounding investigation context.
              </p>
              <p>
                <strong>Filter</strong> reduces the table to matching rows and
                intersects levels, sources, and time. Use both together: filter
                to ERROR, then find a ticket id.
              </p>
            </HelpTip>
          </div>
          <input
            className="log-explorer__search"
            placeholder="Find in corpus (keeps surrounding rows)…"
            value={findDraft}
            onChange={(e) => setFindDraft(e.target.value)}
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
              disabled={findMatches.length === 0}
              onClick={() => findStep(-1)}
            >
              Prev
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              data-testid="log-explorer-find-next"
              disabled={findMatches.length === 0}
              onClick={() => findStep(1)}
            >
              Next
            </button>
          </div>
          {findTotal > 0 ? (
            <div
              className="log-explorer__chat-preview"
              data-testid="log-explorer-find-count"
            >
              Match {findIndex + 1} of {findTotal}
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
            Matched {totalMatched.toLocaleString()} · resident{" "}
            {Object.values(laneEvents).reduce((n, e) => n + e.length, 0)}
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
            {linkMode && gaps.length > 0 && (
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
                      {totalMatched > 0 && laneCount === 1
                        ? ` · ${totalMatched} matched`
                        : ""}
                      {focusLaneId === lane.id ? " · focused" : ""}
                    </span>
                  </div>
                  {linkMode &&
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
                    expandedSeqs={expandedSeqs}
                    onToggleExpand={toggleExpand}
                    scrollToSeq={laneScrollSeq[lane.id] ?? null}
                    scrollAnchorAdjust={laneScrollAdjust[lane.id] ?? 0}
                    onRowClick={onRowClick}
                    onNearTop={() => void loadOlderLane(lane.id)}
                    onNearBottom={() => void loadMoreLane(lane.id)}
                  />
                  <div className="log-explorer__lane-paging">
                    {laneCursors[lane.id]?.hasOlder ? (
                      <button
                        type="button"
                        className="log-explorer__btn"
                        data-testid={`load-older-${lane.id}`}
                        disabled={busy}
                        onClick={() => void loadOlderLane(lane.id)}
                      >
                        Load older
                      </button>
                    ) : null}
                    {laneCursors[lane.id]?.hasNewer ? (
                      <button
                        type="button"
                        className="log-explorer__btn"
                        data-testid={`load-more-${lane.id}`}
                        data-lane-load-more={lane.id}
                        disabled={busy}
                        onClick={() => void loadMoreLane(lane.id)}
                      >
                        Load newer
                      </button>
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
              style={{ maxHeight: detailH }}
            >
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
                  data-testid="detail-taller"
                  onClick={() => setDetailH((h) => Math.min(480, h + 60))}
                >
                  Taller
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
