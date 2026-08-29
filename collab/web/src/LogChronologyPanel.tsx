import { useCallback, useEffect, useRef, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";
import "./styles/log-chronology.css";

interface ChronologyRow {
  seq: number;
  source: string;
  rawTimestamp: string | null;
  normalizedInstant: string | null;
  timeState: "resolved" | "order_only";
  timestampProvenance: string;
  orderOnlyReason: string | null;
  level: string;
  message: string;
}

interface ChronologyPage {
  corpusRevision: number;
  rows: ChronologyRow[];
  nextCursor: string | null;
  totalMatched: number;
  orderOnlyCount: number;
  timeQuality: "wall" | "mixed" | "order_only";
}

const PAGE_SIZE = 50;
const MAX_ERROR_LENGTH = 240;
/** Pause after the last keystroke before a filter change reaches the corpus. */
const FILTER_SETTLE_MS = 250;

const REASON_COPY: Record<string, string> = {
  timezone_unresolved: "Timezone not declared",
  no_recognized_local_timestamp: "No recognized timestamp",
  unsupported_local_timestamp_shape: "Timestamp shape is incomplete",
  ambiguous_dst_fold: "Ambiguous DST fold — happened twice",
  nonexistent_dst_gap: "DST gap — local time never happened",
  zone_abbreviation_mismatch: "Zone abbreviation conflicts",
  resolved_instant_out_of_range: "Instant is outside the supported range",
};

function boundedError(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed || trimmed.toLocaleLowerCase() === "invalid") return fallback;
  return trimmed.length > MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : trimmed;
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? boundedError(body.error, fallback) : fallback;
  } catch {
    return fallback;
  }
}

function reasonCopy(reason: string | null): string {
  return reason ? (REASON_COPY[reason] ?? "Order-only: instant unresolved") : "";
}

const TIME_QUALITIES = ["wall", "mixed", "order_only"] as const;

/**
 * Accept a chronology page only when it carries the fields this panel reads.
 *
 * This panel renders inside the investigation workspace, and an unvalidated
 * body that is missing a field would throw during render and take the whole
 * stage down with it. A body this panel cannot read is reported as an error,
 * not rendered as a partial truth.
 */
function toChronologyPage(raw: unknown): ChronologyPage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.corpusRevision !== "number") return null;
  if (!TIME_QUALITIES.includes(body.timeQuality as ChronologyPage["timeQuality"])) return null;
  if (!Array.isArray(body.rows)) return null;
  if (typeof body.totalMatched !== "number" || typeof body.orderOnlyCount !== "number") {
    return null;
  }
  if (body.nextCursor !== null && typeof body.nextCursor !== "string") return null;
  return {
    corpusRevision: body.corpusRevision,
    rows: body.rows as ChronologyRow[],
    nextCursor: body.nextCursor as string | null,
    totalMatched: body.totalMatched,
    orderOnlyCount: body.orderOnlyCount,
    timeQuality: body.timeQuality as ChronologyPage["timeQuality"],
  };
}

function queryPath(
  caseId: string,
  search: string,
  source: string,
  cursor: string | null,
): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (search.length > 0) params.set("search", search);
  if (source.length > 0) params.set("sources", source);
  if (cursor) params.set("cursor", cursor);
  return `/api/cases/${encodeURIComponent(caseId)}/log-time/chronology?${params.toString()}`;
}

/**
 * Compact Analyze-side chronology surface. It is intentionally standalone so
 * the timezone-wiring branch can choose its insertion point without this slice
 * changing that branch's workspace composition.
 */
export function LogChronologyPanel(props: {
  caseId: string;
  /** When false, the stage is mounted but hidden — do not read the corpus. */
  active?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState<ChronologyPage | null>(null);
  const [rows, setRows] = useState<ChronologyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const requestVersion = useRef(0);
  const currentCaseIdRef = useRef(props.caseId);
  currentCaseIdRef.current = props.caseId;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersion.current += 1;
    };
  }, []);

  const isCurrentCase = useCallback(
    (caseId: string) => mountedRef.current && currentCaseIdRef.current === caseId,
    [],
  );

  useEffect(() => {
    requestVersion.current += 1;
    setSearch("");
    setSource("");
    setPage(null);
    setRows([]);
    setBusy(false);
    setError(null);
    setUnavailable(false);
  }, [props.caseId]);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const requestCaseId = props.caseId;
      if (!isCurrentCase(requestCaseId)) return;
      const version = ++requestVersion.current;
      if (!append) {
        // A replacement query or timezone refresh invalidates the currently
        // rendered projection immediately. Never present an old revision as
        // current while its replacement is pending or after it fails.
        setPage(null);
        setRows([]);
      }
      setBusy(true);
      setError(null);
      try {
        const response = await protectedApiFetch(
          queryPath(requestCaseId, search, source.trim(), cursor),
        );
        if (!isCurrentCase(requestCaseId) || requestVersion.current !== version) return;
        if (response.status === 404) {
          setUnavailable(true);
          return;
        }
        if (!response.ok) {
          if (response.status === 409 && append) {
            setPage(null);
            setRows([]);
            setError("The corpus changed; chronology was refreshed.");
            void load(null, false);
            return;
          }
          const message = await errorText(response, "Chronology could not be loaded.");
          if (!isCurrentCase(requestCaseId) || requestVersion.current !== version) return;
          setError(message);
          return;
        }
        const next = toChronologyPage(await response.json());
        if (!isCurrentCase(requestCaseId) || requestVersion.current !== version) return;
        if (!next) {
          setError("Chronology could not be read from this server's reply.");
          return;
        }
        setUnavailable(false);
        setPage(next);
        setRows((current) => (append ? [...current, ...next.rows] : next.rows));
      } catch {
        if (isCurrentCase(requestCaseId) && requestVersion.current === version) {
          setError("Chronology could not be loaded.");
        }
      } finally {
        if (isCurrentCase(requestCaseId) && requestVersion.current === version) {
          setBusy(false);
        }
      }
    },
    [isCurrentCase, props.caseId, search, source],
  );

  // The filters are typed, not submitted. Firing a corpus query on every
  // keystroke turns a long word into a burst of full-corpus reads; one settled
  // pause is enough for a filter this cheap to change.
  useEffect(() => {
    if (props.active === false) return;
    const timer = setTimeout(() => void load(null, false), FILTER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [load, props.active]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: string }>).detail;
      if (detail?.caseId && detail.caseId !== props.caseId) return;
      setPage(null);
      setRows([]);
      if (props.active === false) return;
      void load(null, false);
    };
    window.addEventListener("contextdesk:log-time-changed", refresh);
    return () => window.removeEventListener("contextdesk:log-time-changed", refresh);
  }, [load, props.caseId, props.active]);

  if (unavailable) return null;

  return (
    <section
      className="log-chronology"
      data-testid="log-chronology"
      aria-labelledby="log-chronology-heading"
    >
      <header className="log-chronology__head">
        <div>
          <h4 id="log-chronology-heading">Normalized log chronology</h4>
          <p className="log-chronology__copy">
            Proven instants are ordered across sources. Lines without a proven instant stay
            order-only; no timezone, DST fold, or DST gap is guessed.
          </p>
        </div>
        {page ? (
          <span className="log-chronology__badge">
            revision {page.corpusRevision} · {page.timeQuality.replace("_", " ")}
          </span>
        ) : null}
      </header>

      <div className="log-chronology__filters">
        <label>
          Search log messages
          <input
            aria-label="Search log messages"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Literal text"
            maxLength={256}
          />
        </label>
        <label>
          Filter by source
          <input
            aria-label="Filter by source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Exact source identity"
            maxLength={4096}
          />
        </label>
      </div>

      {error ? <p className="log-chronology__error" role="alert">{error}</p> : null}
      {page ? (
        <p className="log-chronology__summary" role="status">
          {page.totalMatched.toLocaleString()} matching lines · {page.orderOnlyCount.toLocaleString()} order-only
        </p>
      ) : busy ? (
        <p className="log-chronology__summary" role="status">Loading chronology…</p>
      ) : null}

      {rows.length > 0 ? (
        <div className="log-chronology__table-wrap">
          <table className="log-chronology__table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">State</th>
                <th scope="col">Source</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.source}:${row.seq}`} className={row.timeState === "order_only" ? "log-chronology__row--order-only" : undefined}>
                  <td className="log-chronology__time">
                    {row.normalizedInstant ? (
                      <time dateTime={row.normalizedInstant}>{row.normalizedInstant}</time>
                    ) : (
                      <span className="log-chronology__order-label">Order only</span>
                    )}
                    {row.rawTimestamp ? <code>{row.rawTimestamp}</code> : null}
                  </td>
                  <td>
                    {row.timeState === "resolved" ? (
                      <span className="log-chronology__state log-chronology__state--resolved">
                        Resolved
                      </span>
                    ) : (
                      <span className="log-chronology__state log-chronology__state--order-only">
                        {reasonCopy(row.orderOnlyReason)}
                      </span>
                    )}
                  </td>
                  <td><code>{row.source}</code></td>
                  <td className="log-chronology__message">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : page && !busy ? (
        <p className="log-chronology__empty">No chronology lines match these filters.</p>
      ) : null}

      {page?.nextCursor ? (
        <button
          type="button"
          className="log-chronology__more"
          onClick={() => void load(page.nextCursor, true)}
          disabled={busy}
        >
          {busy ? "Loading…" : "Load more chronology"}
        </button>
      ) : null}
    </section>
  );
}
