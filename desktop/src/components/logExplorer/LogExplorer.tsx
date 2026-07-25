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
  agentTurn,
  hostGetLogCorpus,
  hostListChatSessionsForCorpus,
  hostLoadChatSession,
  hostLogAddBookmark,
  hostLogDeleteBookmark,
  hostLogFacets,
  hostLogListBookmarks,
  hostLogQueryEvents,
  hostLogSearchEvents,
  hostSaveChatSession,
  hostSetActiveLogCorpus,
  type EventQueryDto,
  type ExplorerEventDto,
  type LogBookmarkDto,
  type LogCorpusSummaryDto,
  type LogFacetsDto,
  type SessionMetaDto,
  type TimeQuality,
} from "../../lib/host";
import {
  applyEventsToMessage,
  newSession,
  nowIso,
  sessionFromDto,
  sessionToDto,
} from "../../lib/session";
import {
  applyLogNav,
  extractLogNavFromText,
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
import { VirtualizedEventList } from "./VirtualizedEventList";
import "../../styles/components/log-explorer.css";

type Props = {
  corpusId: string;
};

type ChatMsg = { id: string; role: "user" | "assistant"; content: string };

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
  /** Per-lane composite cursors for multi-lane page-to-end (#505). */
  const [laneCursors, setLaneCursors] = useState<
    Record<string, { afterSeq: number | null; afterTs: number | null }>
  >({});
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
  const [chats, setChats] = useState<SessionMetaDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [navChips, setNavChips] = useState<LogNavAction[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
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
      setBreakpoint(classifyBreakpoint(w));
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
      const linked = await hostListChatSessionsForCorpus(corpusId);
      setChats(linked ?? []);
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
        setLaneEvents({ "lane-0": page.events });
        setLaneCursors({
          "lane-0": {
            afterSeq: page.nextCursor,
            afterTs: page.nextTs ?? null,
          },
        });
        setStatus(
          `${page.totalMatched} matched · showing ${page.events.length}`,
        );
      } else {
        const byLane: Record<string, ExplorerEventDto[]> = {};
        const cursors: Record<
          string,
          { afterSeq: number | null; afterTs: number | null }
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
            cursors[lane.id] = { afterSeq: null, afterTs: null };
            states[lane.id] = { status: "error", quality: null };
            continue;
          }
          const { page } = result.value;
          byLane[lane.id] = page.events;
          cursors[lane.id] = {
            afterSeq: page.nextCursor,
            afterTs: page.nextTs ?? null,
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

  const runSearch = async () => {
    const requestId = ++eventsRequestRef.current;
    setBusy(true);
    setError(null);
    setLaneTimeStates({
      "lane-0": { status: "unloaded", quality: null },
    });
    setTimeQuality("order_only");
    setGaps([]);
    try {
      const hits = await hostLogSearchEvents(corpusId, {
        query: searchDraft || filters.keyword || undefined,
        semantic: semanticAvailable,
        k: 100,
        filter: filtersToQuery(filters, { keyword: null }),
      });
      if (requestId !== eventsRequestRef.current) return;
      const evs = hits.map((h) => h.event);
      const state: LaneTimeState =
        evs.length > 0
          ? {
              status: "loaded",
              quality: leastReliableTimeQuality(
                evs.map((event) => event.timeQuality),
              ),
            }
          : { status: "empty", quality: null };
      const states = { "lane-0": state };
      setLaneEvents({ "lane-0": evs });
      setLaneTimeStates(states);
      setTimeQuality(aggregateLaneTimeQuality(["lane-0"], states));
      setTotalMatched(evs.length);
      setHighlight(new Set(evs.map((e) => e.seq)));
      setStatus(
        semanticAvailable
          ? `Search: ${evs.length} event hits (template-first semantic + keyword)`
          : `Search: ${evs.length} event hits (keyword-only; local re-analysis is not complete)`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setError(String(e));
    } finally {
      if (requestId === eventsRequestRef.current) setBusy(false);
    }
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

  const applyNav = (action: LogNavAction) => {
    const result = applyLogNav(filters, action, corpusId);
    if (!result.corpusMatch) {
      setStatus("log_nav corpus mismatch — ignored");
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

  const openChat = async (id: string) => {
    setActiveChatId(id);
    try {
      const full = await hostLoadChatSession(id);
      if (full) {
        const s = sessionFromDto(full);
        setChatMessages(
          s.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        );
      }
    } catch (e) {
      setError(String(e));
    }
  };

  /** Create linked chat and return its id (avoids stale React state in sendChat). */
  const createLinkedChat = async (): Promise<string | null> => {
    setError(null);
    try {
      const s = newSession(`Logs · ${summary?.name ?? corpusId.slice(0, 8)}`);
      s.linkedCorpusId = corpusId;
      const saved = await hostSaveChatSession(sessionToDto(s));
      if (saved) {
        const linked = await hostListChatSessionsForCorpus(corpusId);
        setChats(linked ?? []);
        await openChat(saved.id);
        setStatus(`Linked chat created: ${saved.title}`);
        return saved.id;
      }
    } catch (e) {
      setError(String(e));
    }
    return null;
  };

  const sendChat = async () => {
    const text = chatDraft.trim();
    if (!text || chatBusy) return;
    let sessionId = activeChatId;
    if (!sessionId) {
      sessionId = await createLinkedChat();
      if (!sessionId) return;
    }
    setChatBusy(true);
    setError(null);
    setChatDraft("");
    const userMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setChatMessages((m) => [...m, userMsg]);
    let assistantText = "";
    const assistantId = crypto.randomUUID();
    setChatMessages((m) => [
      ...m,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    try {
      const events = await agentTurn(
        sessionId!,
        text,
        false,
        null,
        null,
        (ev) => {
          if (ev.kind === "text_delta") {
            assistantText += String(ev.payload?.text ?? "");
            setChatMessages((msgs) =>
              msgs.map((x) =>
                x.id === assistantId ? { ...x, content: assistantText } : x,
              ),
            );
          }
        },
        null,
        {
          corpus_id: corpusId,
          brief: viewBrief,
        },
      );
      const full = await hostLoadChatSession(sessionId!);
      if (!full) {
        throw new Error("Linked chat could not be reloaded after the turn");
      }
      const session = sessionFromDto(full);
      const folded = applyEventsToMessage(
        { id: assistantId, role: "assistant", content: "" },
        events,
      ).msg;
      const assistant = {
        ...folded,
        content: folded.content || assistantText,
      };
      const updated = {
        ...session,
        messages: [...session.messages, userMsg, assistant],
        lastReadMessageId: assistantId,
        updatedAt: nowIso(),
      };
      const saved = await hostSaveChatSession(sessionToDto(updated));
      if (!saved) {
        throw new Error("Linked chat turn was not persisted");
      }
      const persisted = sessionFromDto(saved);
      setChatMessages(
        persisted.messages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      );

      // Extract log_nav from the final persisted assistant text.
      const found = extractLogNavFromText(assistant.content);
      if (found.length) setNavChips((prev) => [...prev, ...found]);
      const linked = await hostListChatSessionsForCorpus(corpusId);
      setChats(linked ?? []);
      setStatus("Linked chat response saved");
    } catch (e) {
      setError(String(e));
      setChatMessages((msgs) =>
        msgs.map((x) =>
          x.id === assistantId
            ? { ...x, content: x.content || `(error: ${String(e)})` }
            : x,
        ),
      );
    } finally {
      setChatBusy(false);
    }
  };

  const loadMoreLane = async (laneId: string) => {
    const cur = laneCursors[laneId];
    if (cur?.afterSeq == null) return;
    const lane = lanes.find((l) => l.id === laneId);
    const requestId = eventsRequestRef.current;
    setBusy(true);
    try {
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(filters, {
          sources:
            lane && lane.sources.length > 0
              ? lane.sources
              : filters.sources.length > 0
                ? filters.sources
                : undefined,
          afterSeq: cur.afterSeq,
          afterTs: cur.afterTs,
          sortByTime: true,
          limit: 100,
        }),
      );
      if (requestId !== eventsRequestRef.current) return;
      setLaneEvents((prev) => ({
        ...prev,
        [laneId]: [...(prev[laneId] ?? []), ...page.events],
      }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: page.nextCursor,
          afterTs: page.nextTs ?? null,
        },
      }));
      if (laneId === "lane-0") {
        setNextCursor(page.nextCursor);
      }
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
        `Lane ${laneId}: loaded +${page.events.length} (cursor ${page.nextCursor ?? "end"})`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setError(String(e));
    } finally {
      if (requestId === eventsRequestRef.current) setBusy(false);
    }
  };

  const loadMore = async () => {
    if (laneCount <= 1) {
      await loadMoreLane("lane-0");
      return;
    }
    // Multi-lane: advance every lane that still has a cursor.
    for (const lane of lanes.slice(0, laneCount)) {
      if (laneCursors[lane.id]?.afterSeq != null) {
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
  const bodyStyle =
    breakpoint === "narrow"
      ? undefined
      : ({
          gridTemplateColumns: `${filterW}px 6px 1fr 6px ${chatW}px`,
        } as React.CSSProperties);

  return (
    <div
      ref={rootRef}
      className={["log-explorer", bpClass, densityClass]
        .filter(Boolean)
        .join(" ")}
      data-testid="log-explorer"
      data-breakpoint={breakpoint}
      data-density={density}
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
          {[1, 2, 3, 4].map((n) => (
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
        className="log-explorer__body"
        style={bodyStyle}
        data-testid="log-explorer-body"
      >
        <aside
          className="log-explorer__filters"
          data-testid="log-explorer-filters"
        >
          <div className="log-explorer__section-title">Search</div>
          <input
            className="log-explorer__search"
            placeholder={
              semanticAvailable
                ? "Keyword / semantic…"
                : "Keyword search (semantic unavailable)…"
            }
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setFilters((f) => ({ ...f, keyword: searchDraft || null }));
                void runSearch();
              }
            }}
            aria-label="Search logs"
          />
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() => void runSearch()}
          >
            Search
          </button>
          <p className="log-explorer__chat-preview" role="note">
            {semanticAvailable
              ? "Semantic template search available"
              : "Keyword-only corpus · re-analyze locally from Logs to enable semantic search"}
          </p>

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
                    onClick={() => {
                      setHighlight(
                        new Set(
                          Array.from(
                            { length: b.seqTo - b.seqFrom + 1 },
                            (_, i) => b.seqFrom + i,
                          ),
                        ),
                      );
                      setStatus(`Jumped bookmark ${b.label}`);
                    }}
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
            {navChips.map((chip, i) => (
              <button
                key={i}
                type="button"
                className="log-explorer__nav-chip"
                onClick={() => applyNav(chip)}
                title="Apply agent navigation (opt-in)"
              >
                {chip.label || "log_nav"}
              </button>
            ))}
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
                    <span className="log-explorer__chat-preview">
                      {(laneEvents[lane.id] ?? []).length} rows
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
                    scrollToSeq={laneScrollSeq[lane.id] ?? null}
                    onRowClick={onRowClick}
                  />
                  {laneCursors[lane.id]?.afterSeq != null ? (
                    <button
                      type="button"
                      className="log-explorer__btn"
                      data-testid={`load-more-${lane.id}`}
                      data-lane-load-more={lane.id}
                      disabled={busy}
                      onClick={() => void loadMoreLane(lane.id)}
                    >
                      Load more ({lane.label})
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
          {detail && (
            <div
              className="log-explorer__detail"
              data-testid="log-explorer-detail"
            >
              <div>
                <strong>seq {detail.seq}</strong> · {detail.source} ·{" "}
                <span className={levelClass(detail.level)}>{detail.level}</span>
              </div>
              <div className="log-explorer__ts">
                {formatEventTime(detail.ts, detail.timeQuality)} ·{" "}
                {timeQualityLabel(detail.timeQuality)}
              </div>
              <pre style={{ whiteSpace: "pre-wrap", margin: "0.4rem 0 0" }}>
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

        <aside className="log-explorer__chat" data-testid="log-explorer-chat">
          <div className="log-explorer__section-title">Chats for corpus</div>
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="new-linked-chat"
            onClick={() => void createLinkedChat()}
          >
            New linked chat
          </button>
          <div className="log-explorer__chat-list">
            {chats.length === 0 ? (
              <div className="log-explorer__chat-preview">
                No linked chats yet. Any chat may set linkedCorpusId.
              </div>
            ) : (
              chats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`log-explorer__chat-item ${
                    activeChatId === c.id
                      ? "log-explorer__chat-item--active"
                      : ""
                  }`}
                  onClick={() => void openChat(c.id)}
                >
                  <div>{c.title}</div>
                  <div className="log-explorer__chat-preview">{c.preview}</div>
                </button>
              ))
            )}
          </div>

          <div className="log-explorer__section-title">Thread</div>
          <div
            className="log-explorer__chat-thread"
            data-testid="log-explorer-chat-thread"
          >
            {chatMessages.length === 0 ? (
              <div className="log-explorer__chat-preview">
                Open or create a linked chat, then ask about this corpus. Agent
                receives viewport context + log tools.
              </div>
            ) : (
              chatMessages.map((m) => (
                <div
                  key={m.id}
                  className={`log-explorer__chat-bubble log-explorer__chat-bubble--${m.role}`}
                >
                  <div className="log-explorer__chat-role">{m.role}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              ))
            )}
          </div>
          <div
            className="log-explorer__chat-composer"
            data-testid="log-explorer-chat-composer"
          >
            <textarea
              className="log-explorer__search"
              rows={3}
              placeholder="Ask about these logs…"
              value={chatDraft}
              disabled={chatBusy}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void sendChat();
                }
              }}
              aria-label="Chat message"
            />
            <button
              type="button"
              className="log-explorer__btn log-explorer__btn--active"
              data-testid="send-linked-chat"
              disabled={chatBusy || !chatDraft.trim()}
              onClick={() => void sendChat()}
            >
              {chatBusy ? "Thinking…" : "Send"}
            </button>
          </div>

          <div className="log-explorer__section-title">Agent nav links</div>
          <div className="log-explorer__chat-preview">
            log_nav chips from the agent — apply is opt-in.
          </div>
          <textarea
            className="log-explorer__search"
            rows={2}
            placeholder='{"type":"log_nav","corpusId":"…","sources":["api.log"],"label":"…"}'
            onBlur={(e) => {
              const found = extractLogNavFromText(e.target.value);
              if (found.length) setNavChips((prev) => [...prev, ...found]);
            }}
            aria-label="Paste log_nav JSON"
          />
          <div className="log-explorer__section-title">
            View context → agent
          </div>
          <pre
            className="log-explorer__chat-preview"
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="log-explorer-view-context"
          >
            {viewBrief}
          </pre>
        </aside>
      </div>

      <div className="log-explorer__status" role="status">
        {error ? `Error: ${error}` : status}
        {busy ? " · busy" : ""}
      </div>
    </div>
  );
}
