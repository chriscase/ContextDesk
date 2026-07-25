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
} from "react";
import {
  hostGetLogCorpus,
  hostListChatSessionsForCorpus,
  hostLogAddBookmark,
  hostLogDeleteBookmark,
  hostLogFacets,
  hostLogListBookmarks,
  hostLogQueryEvents,
  hostLogSearchEvents,
  hostSaveChatSession,
  hostSetActiveLogCorpus,
  hostSetChatLinkedCorpus,
  type EventQueryDto,
  type ExplorerEventDto,
  type LogBookmarkDto,
  type LogCorpusSummaryDto,
  type LogFacetsDto,
  type SessionMetaDto,
  type TimeQuality,
} from "../../lib/host";
import { newSession, sessionToDto } from "../../lib/session";
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
  classifyBreakpoint,
  emptyFilters,
  formatEventTime,
  timeQualityLabel,
  type Breakpoint,
  type Density,
  type ExplorerFilters,
  type LaneConfig,
} from "../../lib/logExplorer/types";
import "../../styles/components/log-explorer.css";

type Props = {
  corpusId: string;
};

function filtersToQuery(f: ExplorerFilters, extra?: Partial<EventQueryDto>): EventQueryDto {
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
  const [, setEvents] = useState<ExplorerEventDto[]>([]);
  const [totalMatched, setTotalMatched] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
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
  const [laneEvents, setLaneEvents] = useState<Record<string, ExplorerEventDto[]>>({});
  const [gaps, setGaps] = useState<GapRegion[]>([]);
  const [bookmarks, setBookmarks] = useState<LogBookmarkDto[]>([]);
  const [chats, setChats] = useState<SessionMetaDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [navChips, setNavChips] = useState<LogNavAction[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [status, setStatus] = useState("Ready");
  const rootRef = useRef<HTMLDivElement>(null);

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
    try {
      const f = await hostLogFacets(corpusId, filtersToQuery(filters, { keyword: null }));
      setFacets(f);
      setTimeQuality(f.timeQuality);
    } catch (e) {
      setError(String(e));
    }
  }, [corpusId, filters]);

  const loadEvents = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (laneCount <= 1) {
        const page = await hostLogQueryEvents(corpusId, filtersToQuery(filters));
        setEvents(page.events);
        setTotalMatched(page.totalMatched);
        setNextCursor(page.nextCursor);
        setTimeQuality(page.timeQuality);
        setLaneEvents({ "lane-0": page.events });
        setStatus(`${page.totalMatched} matched · showing ${page.events.length}`);
      } else {
        const byLane: Record<string, ExplorerEventDto[]> = {};
        let total = 0;
        let tq: TimeQuality = "order_only";
        for (const lane of lanes.slice(0, laneCount)) {
          const q = filtersToQuery(filters, {
            sources:
              lane.sources.length > 0
                ? lane.sources
                : filters.sources.length > 0
                  ? filters.sources
                  : undefined,
            limit: 200,
          });
          const page = await hostLogQueryEvents(corpusId, q);
          byLane[lane.id] = page.events;
          total = Math.max(total, page.totalMatched);
          tq = page.timeQuality;
        }
        setLaneEvents(byLane);
        setEvents(byLane[lanes[0]?.id ?? "lane-0"] ?? []);
        setTotalMatched(total);
        setTimeQuality(tq);
        setStatus(`${laneCount} lanes · ${total} matched (per-lane caps)`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [corpusId, filters, laneCount, lanes]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  // Link/gap when multi-lane + link on
  useEffect(() => {
    if (!linkMode || laneCount < 2) {
      setGaps([]);
      return;
    }
    const packed = lanes.slice(0, laneCount).map((l) => ({
      id: l.id,
      events: (laneEvents[l.id] ?? []).map(
        (e): LaneEventRef => ({ seq: e.seq, ts: e.ts }),
      ),
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

  const toggleLevel = (level: string) => {
    setFilters((f) => {
      const has = f.levels.includes(level);
      return {
        ...f,
        levels: has ? f.levels.filter((x) => x !== level) : [...f.levels, level],
      };
    });
  };

  const toggleSource = (source: string) => {
    setFilters((f) => {
      const has = f.sources.includes(source);
      return {
        ...f,
        sources: has ? f.sources.filter((x) => x !== source) : [...f.sources, source],
      };
    });
  };

  const runSearch = async () => {
    setBusy(true);
    try {
      const hits = await hostLogSearchEvents(corpusId, {
        query: searchDraft || filters.keyword || undefined,
        semantic: true,
        k: 100,
        filter: filtersToQuery(filters, { keyword: null }),
      });
      const evs = hits.map((h) => h.event);
      setEvents(evs);
      setLaneEvents({ "lane-0": evs });
      setTotalMatched(evs.length);
      setHighlight(new Set(evs.map((e) => e.seq)));
      setStatus(`Search: ${evs.length} event hits (template-first semantic + keyword)`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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
        events: (laneEvents[l.id] ?? []).map(
          (x): LaneEventRef => ({ seq: x.seq, ts: x.ts }),
        ),
      }));
      const scrub = scrubLinked(e.ts, packed, timeQuality);
      if (scrub.linked) {
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
    setStatus(result.label ? `Applied nav: ${result.label}` : "Applied log_nav filters");
  };

  const createLinkedChat = async () => {
    try {
      const s = newSession(`Logs · ${summary?.name ?? corpusId.slice(0, 8)}`);
      s.linkedCorpusId = corpusId;
      const saved = await hostSaveChatSession(sessionToDto(s));
      if (saved) {
        await hostSetChatLinkedCorpus(saved.id, corpusId);
        const linked = await hostListChatSessionsForCorpus(corpusId);
        setChats(linked ?? []);
        setActiveChatId(saved.id);
        setStatus(`Linked chat created: ${saved.title}`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const loadMore = async () => {
    if (nextCursor == null) return;
    setBusy(true);
    try {
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(filters, { afterSeq: nextCursor }),
      );
      setEvents((prev) => [...prev, ...page.events]);
      setNextCursor(page.nextCursor);
      setLaneEvents((prev) => ({
        ...prev,
        "lane-0": [...(prev["lane-0"] ?? []), ...page.events],
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const configureLanes = (n: number) => {
    const count = clampLaneCount(n);
    setLaneCount(count);
    const sources = Object.keys(facets?.sources ?? {});
    if (count === 1) {
      setLanes([{ id: "lane-0", label: "All sources", sources: [] }]);
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

  const viewContextJson = useMemo(
    () =>
      JSON.stringify(
        {
          corpusId,
          filters,
          lanes: lanes.slice(0, laneCount),
          linkMode,
          timeQuality,
          selectedSeqs: [...selected].slice(0, 64),
          bookmarks: bookmarks.slice(0, 24).map((b) => ({
            id: b.id,
            label: b.label,
            seqFrom: b.seqFrom,
            seqTo: b.seqTo,
          })),
          density,
        },
        null,
        2,
      ),
    [
      corpusId,
      filters,
      lanes,
      laneCount,
      linkMode,
      timeQuality,
      selected,
      bookmarks,
      density,
    ],
  );

  const densityClass = density === "compact" ? "log-explorer--compact" : "";
  const bpClass = `log-explorer--${breakpoint}`;

  const renderRows = (rows: ExplorerEventDto[]) => (
    <div className="log-explorer__rows" role="list" aria-label="Log events">
      {rows.length === 0 ? (
        <div className="log-explorer__empty">
          {busy ? "Loading…" : "No events match filters"}
        </div>
      ) : (
        rows.map((e) => {
          const tq = e.timeQuality ?? timeQuality;
          return (
            <div
              key={e.seq}
              role="listitem"
              tabIndex={0}
              className={[
                "log-explorer__row",
                selected.has(e.seq) ? "log-explorer__row--selected" : "",
                highlight.has(e.seq) ? "log-explorer__row--highlight" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={(ev) => onRowClick(e, ev.metaKey || ev.ctrlKey || ev.shiftKey)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onRowClick(e, ev.metaKey || ev.ctrlKey || ev.shiftKey);
                }
              }}
            >
              <span className="log-explorer__ts" title={timeQualityLabel(tq)}>
                {formatEventTime(e.ts, tq)}
              </span>
              <span className={levelClass(e.level)}>{e.level}</span>
              <span className="log-explorer__msg" title={e.message}>
                {e.message}
              </span>
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={["log-explorer", bpClass, densityClass].filter(Boolean).join(" ")}
      data-testid="log-explorer"
      data-breakpoint={breakpoint}
      data-density={density}
      data-lane-count={laneCount}
      data-link-mode={linkMode ? "on" : "off"}
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
                  "Link requires wall-clock time; corpus is order-only — enabling will badge/warn",
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
          <button type="button" className="log-explorer__btn" onClick={() => void bookmarkSelection()}>
            Bookmark (B)
          </button>
        </div>
      </header>

      <div className="log-explorer__body">
        <aside className="log-explorer__filters" data-testid="log-explorer-filters">
          <div className="log-explorer__section-title">Search</div>
          <input
            className="log-explorer__search"
            placeholder="Keyword / semantic…"
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
          <button type="button" className="log-explorer__btn" onClick={() => void runSearch()}>
            Search
          </button>

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
          <div className="log-explorer__bookmarks" data-testid="log-explorer-bookmarks">
            {bookmarks.length === 0 ? (
              <div className="log-explorer__chat-preview">None yet — select rows + B</div>
            ) : (
              bookmarks.map((b) => (
                <div key={b.id} className="log-explorer__bm-item">
                  <button
                    type="button"
                    className="log-explorer__btn"
                    onClick={() => {
                      setHighlight(new Set(
                        Array.from(
                          { length: b.seqTo - b.seqFrom + 1 },
                          (_, i) => b.seqFrom + i,
                        ),
                      ));
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

        <main className="log-explorer__lanes" data-testid="log-explorer-lanes">
          <div className="log-explorer__lane-strip">
            {linkMode && gaps.length > 0 && (
              <span className="log-explorer__badge log-explorer__badge--warn">
                {gaps.length} gap region{gaps.length === 1 ? "" : "s"}
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
            {lanes.slice(0, laneCount).map((lane) => (
              <section key={lane.id} className="log-explorer__lane" data-lane-id={lane.id}>
                <div className="log-explorer__lane-header">
                  <strong>{lane.label}</strong>
                  <span className="log-explorer__chat-preview">
                    {(laneEvents[lane.id] ?? []).length} rows
                  </span>
                </div>
                {linkMode && gaps.some((g) => g.emptyLaneIds.includes(lane.id)) && (
                  <div
                    className="log-explorer__gap-band"
                    title="Gap: this lane empty while peers have events"
                    data-testid="log-explorer-gap"
                  />
                )}
                {renderRows(laneEvents[lane.id] ?? [])}
              </section>
            ))}
          </div>
          {detail && (
            <div className="log-explorer__detail" data-testid="log-explorer-detail">
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
              {nextCursor != null && laneCount === 1 && (
                <button type="button" className="log-explorer__btn" onClick={() => void loadMore()}>
                  Load more
                </button>
              )}
            </div>
          )}
        </main>

        <aside className="log-explorer__chat" data-testid="log-explorer-chat">
          <div className="log-explorer__section-title">Chats for corpus</div>
          <button type="button" className="log-explorer__btn" onClick={() => void createLinkedChat()}>
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
                    activeChatId === c.id ? "log-explorer__chat-item--active" : ""
                  }`}
                  onClick={() => setActiveChatId(c.id)}
                >
                  <div>{c.title}</div>
                  <div className="log-explorer__chat-preview">{c.preview}</div>
                </button>
              ))
            )}
          </div>
          <div className="log-explorer__section-title">Agent nav links</div>
          <div className="log-explorer__chat-preview">
            Paste or receive <code>log_nav</code> chips — apply is opt-in.
          </div>
          <textarea
            className="log-explorer__search"
            rows={4}
            placeholder='{"type":"log_nav","corpusId":"…","sources":["api.log"],"label":"…"}'
            onBlur={(e) => {
              const found = extractLogNavFromText(e.target.value);
              if (found.length) setNavChips((prev) => [...prev, ...found]);
            }}
            aria-label="Paste log_nav JSON"
          />
          <div className="log-explorer__section-title">View context</div>
          <pre
            className="log-explorer__chat-preview"
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="log-explorer-view-context"
          >
            {viewContextJson}
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
