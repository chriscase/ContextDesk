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

const ROW_HEIGHT = 24;
const VIEWPORT_HEIGHT = 360;
const OVERSCAN = 6;
const MAX_PANES = 4;

interface InventoryItem {
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  displayLabel: string;
  digest: string;
  intakeBatchId: string | null;
  privacyClass: string;
  lineCount: number;
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
  relativePath: string;
  lineNumber: number;
  excerpt: string;
  adjacencyReason: string;
  uncertainty: string[];
  correlationKind: string;
  correlationId: string | null;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
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
  const [pageByPane, setPageByPane] = useState<Record<string, PageResult>>({});
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("Timeout window");
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const [chronology, setChronology] = useState<ChronologyEvent[] | null>(null);
  const [unknownBuckets, setUnknownBuckets] = useState<{ category: string; count: number; detail: string }[]>([]);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const liveRef = useRef<HTMLParagraphElement>(null);

  const selectedItems = useMemo(
    () => items.filter((item) => panes.includes(item.evidenceId)),
    [items, panes],
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    setError(null);
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
      };
      setItems(body.items ?? []);
      setRevision(body.normalizationRevision ?? null);
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
    return () => {
      window.removeEventListener("contextdesk:corpus-intake-committed", reload);
      window.removeEventListener("contextdesk:snapshot-frozen", reload);
    };
  }, [load, props.caseId]);

  const loadPane = useCallback(
    async (evidenceId: string, startLine = 1) => {
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

  useEffect(() => {
    const ids = panes.length > 0 ? panes : items.slice(0, 1).map((item) => item.evidenceId);
    for (const id of ids) void loadPane(id);
  }, [panes, items, loadPane]);

  function togglePane(evidenceId: string) {
    setPanes((current) => {
      if (current.includes(evidenceId)) return current.filter((id) => id !== evidenceId);
      if (current.length >= MAX_PANES) return current;
      return [...current, evidenceId];
    });
  }

  async function runSearch() {
    setError(null);
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query,
        mode,
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
        contextBefore: 1,
        contextAfter: 1,
        cursor: 0,
        limit: 50,
        expectedNormalizationRevision: revision,
      }),
    });
    if (!response.ok) {
      setError(await errorText(response, "Search could not run."));
      return;
    }
    const result = (await response.json()) as SearchResult;
    setSearch(result);
    setMatchIndex(0);
    setNotice(
      result.bounded
        ? `At least ${result.atLeast.toLocaleString()} matches; showing ${result.returned}.`
        : `${result.returned.toLocaleString()} matches.`,
    );
  }

  async function runChronology() {
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/workbench/chronology`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grouping: "file", evidenceIds: panes }),
    });
    if (!response.ok) {
      setError(await errorText(response, "The merged chronology could not be built."));
      return;
    }
    const body = (await response.json()) as {
      events?: ChronologyEvent[];
      unknownBuckets?: { category: string; count: number; detail: string }[];
    };
    setChronology(body.events ?? []);
    setUnknownBuckets(body.unknownBuckets ?? []);
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
        sort: "time_asc",
        grouping: "file",
        display: {
          syncScroll,
          wrap: false,
          lineNumbers: true,
          displayTimezone: "UTC",
        },
        contextBefore: 1,
        contextAfter: 1,
        idempotencyKey: `view-${viewName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-0001`,
      }),
    });
    if (!response.ok) {
      setError(await errorText(response, "The view could not be saved."));
      return;
    }
    setNotice("Saved view recorded for this investigation.");
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
    setQuery(view.query);
    setMode((view.mode as typeof mode) || "case_insensitive");
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
    if (event.key === "F3" || (event.key === "g" && event.metaKey)) {
      event.preventDefault();
      if (!search || search.matches.length === 0) return;
      setMatchIndex((index) =>
        event.shiftKey
          ? (index - 1 + search.matches.length) % search.matches.length
          : (index + 1) % search.matches.length,
      );
    }
  }

  function onScroll(event: { currentTarget: HTMLDivElement }) {
    const next = event.currentTarget.scrollTop;
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
        <p>Loading this investigation’s logs…</p>
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
        <p role="alert">{error}</p>
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
  const firstPaneRows = selectedItems[0]
    ? (pageByPane[selectedItems[0].evidenceId]?.rows ?? [])
    : [];
  const paneWindow = virtualizedWindow({
    totalRows: firstPaneRows.length,
    scrollTop,
    rowHeight: ROW_HEIGHT,
    viewportHeight: VIEWPORT_HEIGHT,
    overscan: OVERSCAN,
  });

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
        {items.map((item) => (
          <label key={item.evidenceId} className="log-workbench__file">
            <input
              type="checkbox"
              checked={panes.includes(item.evidenceId)}
              onChange={() => togglePane(item.evidenceId)}
              aria-label={`Show ${item.displayLabel} in a pane`}
            />
            <span>{item.displayLabel}</span>
            <span className="log-workbench__muted">{item.relativePath}</span>
            <TechnicalIdentifiers
              record={item.displayLabel}
              items={[
                { label: "Evidence id", value: item.evidenceId },
                { label: "Digest", value: item.digest },
                { label: "Intake batch", value: item.intakeBatchId },
              ]}
            />
          </label>
        ))}
      </div>

      <div className="log-workbench__search">
        <label>
          <span>Find</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Find in logs"
          />
        </label>
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
          <input value={include} onChange={(event) => setInclude(event.target.value)} />
        </label>
        <label>
          <span>Exclude</span>
          <input value={exclude} onChange={(event) => setExclude(event.target.value)} />
        </label>
        <label>
          <span>Severity</span>
          <input value={severity} onChange={(event) => setSeverity(event.target.value)} />
        </label>
        <label>
          <span>From (UTC)</span>
          <input value={timeFrom} onChange={(event) => setTimeFrom(event.target.value)} />
        </label>
        <label>
          <span>To (UTC)</span>
          <input value={timeTo} onChange={(event) => setTimeTo(event.target.value)} />
        </label>
        <button type="button" onClick={() => void runSearch()}>
          Search
        </button>
        <button
          type="button"
          onClick={() =>
            search && search.matches.length > 0
              ? setMatchIndex((index) => (index + search.matches.length - 1) % search.matches.length)
              : undefined
          }
        >
          Previous match
        </button>
        <button
          type="button"
          onClick={() =>
            search && search.matches.length > 0
              ? setMatchIndex((index) => (index + 1) % search.matches.length)
              : undefined
          }
        >
          Next match
        </button>
      </div>
      {search?.timeFilterUnknownReason ? (
        <p className="log-workbench__notice">{search.timeFilterUnknownReason}</p>
      ) : null}
      {search ? (
        <div>
          <p>
            {search.bounded
              ? `At least ${search.atLeast.toLocaleString()} matches.`
              : `${search.returned.toLocaleString()} matches.`}
            {activeMatch ? ` Showing match ${matchIndex + 1}.` : ""}
          </p>
          {search.matches.length > 0 ? (
            <ol className="log-workbench__hits" aria-label="Search matches">
              {search.matches.map((row, index) => (
                <li key={`${row.evidenceId}:${row.lineNumber}:${index}`}>
                  <button
                    type="button"
                    aria-current={index === matchIndex ? "true" : undefined}
                    onClick={() => setMatchIndex(index)}
                  >
                    {row.relativePath}:{row.lineNumber}
                  </button>
                  <span className="log-workbench__text">{row.text}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
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
        <button type="button" onClick={() => void runChronology()}>
          Show merged chronology
        </button>
      </div>

      {chronology ? (
        <section aria-label="Merged chronology">
          <h5>Merged chronology</h5>
          {unknownBuckets.length > 0 ? (
            <details>
              <summary>
                {unknownBuckets.reduce((sum, bucket) => sum + bucket.count, 0)} technical unknowns
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
                <div>{event.excerpt}</div>
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
            {bookmarks.map((bookmark) => (
              <li key={bookmark.id}>
                {bookmark.note || `Line ${bookmark.locator.lineNumber}`}
                {bookmark.status !== "resolved" ? (
                  <span role="status"> {bookmark.staleReason}</span>
                ) : null}
              </li>
            ))}
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
