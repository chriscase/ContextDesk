/**
 * War Room log-time review.
 *
 * The plain-language surface for a job with no obvious wording: some log lines
 * carry a clock but no timezone, so the investigation genuinely does not know
 * when they happened. This panel says that plainly, shows the exact lines,
 * makes a person choose the zone, shows what that choice would do before it is
 * made, and afterwards says what the change did to work already produced.
 *
 * It never proposes a zone. There is no default, no "detected" value, and no
 * pre-selected option in the picker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";

const MAX_ERROR_LENGTH = 240;
const VISIBLE_SAMPLE_ROWS = 6;
const INITIAL_SOURCE_ROWS = 12;

interface Declaration {
  source: string;
  ianaTimezone: string;
  basis: "user_declared" | "configured_default";
  declaredAt: number;
  appliedRevision: number;
  declarationFingerprint: string;
  declaredBy: string;
}

interface SourceStatus {
  source: string;
  unresolvedLocalRecords: number;
  resolvedLocalRecords: number;
  explicitWallClockRecords: number;
  otherOrderOnlyRecords: number;
  declaration: Declaration | null;
}

interface CorpusState {
  caseId: string;
  corpusId: string | null;
  corpusRevision: number;
  builtAt: string | null;
  privacyClass: string;
  sources: SourceStatus[];
  reviewOutstanding: boolean;
  undoableRevision: number | null;
}

interface Sample {
  ordinal: number;
  outcome: "resolved" | "unresolved" | "existing_wall_clock";
  rawTimestamp: string | null;
  normalizedInstant: string | null;
  utcOffsetSeconds: number | null;
  unresolvedReason: string | null;
  excerpt: string;
}

interface Preview {
  corpusRevision: number;
  declarationFingerprint: string;
  source: string;
  ianaTimezone: string;
  affectedRecords: number;
  existingWallClockRecords: number;
  unchangedOrderOnlyRecords: number;
  firstResolvedInstant: string | null;
  lastResolvedInstant: string | null;
  dstGapCount: number;
  dstFoldCount: number;
  unsupportedTimestampCount: number;
  zoneAbbreviationMismatchCount: number;
  outOfRangeCount: number;
  samples: Sample[];
}

interface Dependent {
  kind: "snapshot" | "triage_run";
  id: string;
  disposition: "unaffected" | "revised" | "invalidated" | "unknown_basis";
  reason: string;
  observedRevision: number | null;
}

interface StateResponse {
  state: CorpusState;
  dependents: Dependent[];
}

/**
 * Zones offered in the picker. This is a starting list for a reviewer who
 * knows where the system ran, not a guess about where it ran — any IANA id can
 * be typed instead, and nothing is selected until a person selects it.
 */
const COMMON_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Plain-language wording for each reason a line stays order-only. */
const UNRESOLVED_WORDING: Record<string, string> = {
  nonexistent_dst_gap:
    "This local time never happened here — the clocks jumped forward past it.",
  ambiguous_dst_fold:
    "This local time happened twice here — the clocks went back, so it is genuinely ambiguous.",
  zone_abbreviation_mismatch:
    "The line names a different zone abbreviation than this timezone would use then.",
  unsupported_local_timestamp_shape:
    "The timestamp on this line is not complete enough to place on a calendar.",
  no_recognized_local_timestamp: "This line has no timestamp to place.",
  resolved_instant_out_of_range:
    "The resulting date falls outside the range this investigation stores.",
};

function boundedError(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  // The server intentionally collapses unclassified host failures to this
  // sentinel. It is safe, but it is not useful language for an operator.
  if (trimmed.toLocaleLowerCase() === "invalid") return fallback;
  return trimmed.length > MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : trimmed;
}

function errorText(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (typeof body === "object" && body !== null && "error" in body) {
        const error = (body as { error?: unknown }).error;
        if (typeof error === "string") return boundedError(error, fallback);
      }
      return fallback;
    })
    .catch(() => fallback);
}

function newIdempotencyKey(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `logtime-${random}`.slice(0, 120);
}

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "−" : "+";
  const total = Math.abs(seconds);
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

/** "12 lines" / "1 line" — used throughout so counts always read as English. */
function lines(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "line" : "lines"}`;
}

export function LogTimeReviewPanel(props: {
  caseId: string;
  canWrite: boolean;
  readOnly: boolean;
}) {
  const [state, setState] = useState<CorpusState | null>(null);
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState("");
  const [sourceLimit, setSourceLimit] = useState(INITIAL_SOURCE_ROWS);
  const [zone, setZone] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<
    "load" | "build" | "preview" | "apply" | "clear" | "undo" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A deployment with no configured host pipeline never registers these
  // routes. That is a deliberate absence, not a failure, so the panel
  // disappears rather than reporting an error for a feature nobody enabled.
  const [unavailable, setUnavailable] = useState(false);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setBusy("load");
    try {
      const response = await protectedApiFetch(
        `/api/cases/${props.caseId}/log-time`,
      );
      if (response.status === 404) {
        if (requestVersion.current === version) setUnavailable(true);
        return;
      }
      if (!response.ok) {
        setError(await errorText(response, "Time review could not be loaded."));
        return;
      }
      const body = (await response.json()) as StateResponse;
      if (requestVersion.current !== version) return;
      setUnavailable(false);
      setState(body.state);
      setDependents(body.dependents ?? []);
    } catch {
      setError("Time review could not be loaded.");
    } finally {
      setBusy(null);
    }
  }, [props.caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const outstanding = useMemo(
    () => (state?.sources ?? []).filter((s) => s.unresolvedLocalRecords > 0),
    [state],
  );
  const filteredSources = useMemo(() => {
    const needle = sourceFilter.trim().toLocaleLowerCase();
    if (!needle) return state?.sources ?? [];
    return (state?.sources ?? []).filter((source) =>
      [source.source, source.declaration?.ianaTimezone]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [sourceFilter, state]);
  const renderedSources = filteredSources.slice(0, sourceLimit);
  const hiddenSourceCount = Math.max(0, filteredSources.length - renderedSources.length);

  /** Any durable change invalidates the preview a reviewer was looking at. */
  function resetAfterChange(message: string) {
    setPreview(null);
    setNotice(message);
    void load();
  }

  async function post(
    path: string,
    body: unknown,
    phase: "build" | "preview" | "apply" | "clear" | "undo",
    fallback: string,
  ): Promise<unknown | null> {
    if (props.readOnly || !props.canWrite || busy) return null;
    setError(null);
    setNotice(null);
    setBusy(phase);
    try {
      // Build takes no body. Declaring a JSON content-type without one makes
      // Fastify reject the request before it reaches the route.
      const response = await protectedApiFetch(
        `/api/cases/${props.caseId}/log-time/${path}`,
        body === undefined
          ? { method: "POST" }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      if (!response.ok) {
        setError(await errorText(response, fallback));
        // A conflict means someone else moved the corpus. Re-read so the
        // reviewer is deciding against what is actually there now.
        if (response.status === 409) void load();
        return null;
      }
      return await response.json();
    } catch {
      setError(fallback);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runBuild() {
    const result = await post(
      "build",
      undefined,
      "build",
      "The log corpus could not be built.",
    );
    if (result) resetAfterChange("Log corpus built from this case's files.");
  }

  async function runPreview(source: string) {
    if (!state?.corpusId || !zone.trim()) return;
    const result = (await post(
      "preview",
      {
        schemaId: "cd-collab.log_time_preview_request.v1",
        source,
        ianaTimezone: zone.trim(),
        expectedRevision: state.corpusRevision,
      },
      "preview",
      "That timezone could not be previewed.",
    )) as Preview | null;
    if (result) setPreview(result);
  }

  async function runApply() {
    // A declaration that resolves no timestamps cannot publish an event-time
    // revision. Keep the honest preview visible, but do not offer a request
    // which the host must reject as an empty revision.
    if (!preview || preview.affectedRecords === 0) return;
    const result = await post(
      "apply",
      {
        schemaId: "cd-collab.log_time_apply_request.v1",
        source: preview.source,
        ianaTimezone: preview.ianaTimezone,
        expectedRevision: preview.corpusRevision,
        declarationFingerprint: preview.declarationFingerprint,
        idempotencyKey: newIdempotencyKey(),
      },
      "apply",
      "That timezone could not be applied.",
    );
    if (result) {
      resetAfterChange(
        `${preview.ianaTimezone} applied to ${preview.source}. ${lines(preview.affectedRecords)} now have an exact time.`,
      );
    }
  }

  async function runClear(source: string) {
    if (!state) return;
    const result = await post(
      "clear",
      {
        schemaId: "cd-collab.log_time_clear_request.v1",
        source,
        expectedRevision: state.corpusRevision,
        idempotencyKey: newIdempotencyKey(),
      },
      "clear",
      "That declaration could not be cleared.",
    );
    if (result) {
      resetAfterChange(
        `Declaration removed from ${source}. Those lines are back to file order only.`,
      );
    }
  }

  async function runUndo() {
    if (!state) return;
    const result = await post(
      "undo",
      {
        schemaId: "cd-collab.log_time_undo_request.v1",
        expectedRevision: state.corpusRevision,
        idempotencyKey: newIdempotencyKey(),
      },
      "undo",
      "The last time change could not be undone.",
    );
    if (result) resetAfterChange("Last time change undone.");
  }

  const heading = (
    <header className="log-time__head">
      <h4 id="log-time-heading">When did these log lines happen?</h4>
      {state?.corpusId ? (
        <span className="log-time__badge">
          revision {state.corpusRevision}
          {state.builtAt ? ` · built ${state.builtAt.slice(0, 10)}` : ""}
        </span>
      ) : null}
    </header>
  );

  if (unavailable) return null;

  if (!state) {
    return (
      <section className="log-time" id="log-time" aria-labelledby="log-time-heading">
        {heading}
        <p className="log-time__copy">
          {busy === "load" ? "Loading time review…" : (error ?? "Time review unavailable.")}
        </p>
      </section>
    );
  }

  if (!state.corpusId) {
    return (
      <section className="log-time" id="log-time" aria-labelledby="log-time-heading">
        {heading}
        <p className="log-time__copy">
          Once you have added log files to this investigation, build a log corpus
          to read them in order and check whether their timestamps carry a
          timezone.
        </p>
        {error ? (
          <p className="log-time__error" role="alert">
            {error}
          </p>
        ) : null}
        {props.canWrite && !props.readOnly ? (
          <button type="button" onClick={() => void runBuild()} disabled={busy !== null}>
            {busy === "build" ? "Building…" : "Build the log corpus"}
          </button>
        ) : (
          <p className="log-time__copy">
            A contributor can build the log corpus for this investigation.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="log-time" id="log-time" aria-labelledby="log-time-heading">
      {heading}

      {outstanding.length > 0 ? (
        <p className="log-time__copy log-time__copy--warn" role="status">
          {outstanding.length === 1
            ? "One log file records a clock time but not which timezone it was in."
            : `${outstanding.length} log files record a clock time but not which timezone they were in.`}{" "}
          Until someone says which zone each was written in, those lines stay in
          file order and carry no exact time. ContextDesk will not guess.
        </p>
      ) : (
        <p className="log-time__copy" role="status">
          Every log file in this investigation either states its timezone or has
          had one declared. Nothing is waiting on a decision.
        </p>
      )}

      {notice ? (
        <p className="log-time__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="log-time__error" role="alert">
          {error}
        </p>
      ) : null}

      {state.sources.length > 0 ? (
        <div className="log-time__tools">
          <label htmlFor="log-time-source-filter">
            Find a log file
            <input
              id="log-time-source-filter"
              type="search"
              value={sourceFilter}
              placeholder="Filename or timezone"
              onChange={(event) => {
                setSourceFilter(event.target.value);
                setSourceLimit(INITIAL_SOURCE_ROWS);
              }}
            />
          </label>
          <p aria-live="polite">
            {filteredSources.length.toLocaleString()} of {state.sources.length.toLocaleString()} files match
          </p>
        </div>
      ) : null}

      <ul className="log-time__sources">
        {renderedSources.map((source) => {
          const isSelected = selectedSource === source.source;
          const showPreview = preview && preview.source === source.source;
          return (
            <li
              key={source.source}
              className="log-time__source"
              data-route-item={source.source}
              data-unresolved={source.unresolvedLocalRecords > 0 ? "true" : "false"}
            >
              <div className="log-time__source-head">
                <span className="log-time__source-name">{source.source}</span>
                {source.declaration ? (
                  <span className="log-time__chip log-time__chip--declared">
                    {source.declaration.ianaTimezone}
                  </span>
                ) : source.unresolvedLocalRecords > 0 ? (
                  <span className="log-time__chip log-time__chip--waiting">
                    timezone not stated
                  </span>
                ) : null}
              </div>

              <p className="log-time__counts">
                {source.resolvedLocalRecords > 0
                  ? `${lines(source.resolvedLocalRecords)} placed at an exact time`
                  : null}
                {source.resolvedLocalRecords > 0 && source.unresolvedLocalRecords > 0
                  ? " · "
                  : null}
                {source.unresolvedLocalRecords > 0
                  ? `${lines(source.unresolvedLocalRecords)} still in file order only`
                  : null}
                {source.explicitWallClockRecords > 0
                  ? ` · ${lines(source.explicitWallClockRecords)} already state their own timezone`
                  : null}
              </p>

              {source.declaration ? (
                <details className="log-time__provenance">
                  <summary>How this timezone was decided</summary>
                  <dl>
                    <dt>Timezone</dt>
                    <dd>{source.declaration.ianaTimezone}</dd>
                    <dt>Decided by</dt>
                    <dd>{source.declaration.declaredBy}</dd>
                    <dt>Basis</dt>
                    <dd>
                      {source.declaration.basis === "user_declared"
                        ? "A person chose this zone here."
                        : "A saved default was applied when this file was imported, not chosen in the moment."}
                    </dd>
                    <dt>Applied at revision</dt>
                    <dd>{source.declaration.appliedRevision}</dd>
                    <dt>Preview fingerprint</dt>
                    <dd>
                      <code>{source.declaration.declarationFingerprint.slice(0, 16)}…</code>
                    </dd>
                  </dl>
                </details>
              ) : null}

              {props.canWrite && !props.readOnly ? (
                <div className="log-time__actions">
                  {source.declaration ? (
                    <button
                      type="button"
                      onClick={() => void runClear(source.source)}
                      disabled={busy !== null}
                    >
                      {busy === "clear" ? "Removing…" : "Remove this timezone"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSource(isSelected ? null : source.source);
                        setPreview(null);
                      }}
                      disabled={busy !== null}
                      aria-expanded={isSelected}
                    >
                      {isSelected ? "Cancel" : "Declare a timezone"}
                    </button>
                  )}
                </div>
              ) : null}

              {isSelected && !source.declaration ? (
                <div className="log-time__declare">
                  <label htmlFor={`log-time-zone-${source.source}`}>
                    Which timezone was this file written in?
                  </label>
                  <input
                    id={`log-time-zone-${source.source}`}
                    list="log-time-zone-options"
                    value={zone}
                    placeholder="Start typing, e.g. America/Chicago"
                    onChange={(event) => {
                      setZone(event.target.value);
                      setPreview(null);
                    }}
                  />
                  <datalist id="log-time-zone-options">
                    {COMMON_ZONES.map((option) => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
                  <p className="log-time__hint">
                    Pick the zone the machine that wrote this file was set to. If
                    you are not sure, leave it — file order is still usable
                    evidence, and a wrong zone is worse than none.
                  </p>
                  <button
                    type="button"
                    onClick={() => void runPreview(source.source)}
                    disabled={busy !== null || !zone.trim()}
                  >
                    {busy === "preview" ? "Checking…" : "Show me what this would do"}
                  </button>
                </div>
              ) : null}

              {showPreview && preview ? (
                <PreviewCard
                  preview={preview}
                  busy={busy}
                  canApply={props.canWrite && !props.readOnly}
                  onApply={() => void runApply()}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      {hiddenSourceCount > 0 ? (
        <div className="log-time__more">
          <p>
            Showing {renderedSources.length.toLocaleString()} of {filteredSources.length.toLocaleString()} matching files.
          </p>
          <button
            type="button"
            onClick={() => setSourceLimit((current) => current + INITIAL_SOURCE_ROWS)}
          >
            Show {Math.min(INITIAL_SOURCE_ROWS, hiddenSourceCount).toLocaleString()} more
          </button>
        </div>
      ) : null}

      {state.undoableRevision !== null && props.canWrite && !props.readOnly ? (
        <div className="log-time__undo">
          <button type="button" onClick={() => void runUndo()} disabled={busy !== null}>
            {busy === "undo" ? "Undoing…" : "Undo the last time change"}
          </button>
          <span className="log-time__hint">
            This puts the reading back the way it was at revision{" "}
            {state.undoableRevision}. Nothing is deleted — the step back is
            recorded as its own revision.
          </span>
        </div>
      ) : null}

      <DependentImpact dependents={dependents} />
    </section>
  );
}

/**
 * What a declaration would do, shown before it is made: the counts, the DST
 * problems it would hit, and the actual lines with raw and normalized
 * timestamps side by side.
 */
function PreviewCard(props: {
  preview: Preview;
  busy: string | null;
  canApply: boolean;
  onApply: () => void;
}) {
  const { preview } = props;
  const problems =
    preview.dstGapCount +
    preview.dstFoldCount +
    preview.zoneAbbreviationMismatchCount +
    preview.unsupportedTimestampCount +
    preview.outOfRangeCount;
  const visible = preview.samples.slice(0, VISIBLE_SAMPLE_ROWS);
  const hidden = preview.samples.slice(VISIBLE_SAMPLE_ROWS);

  return (
    <div className="log-time__preview" role="group" aria-label="Preview of this timezone">
      <h5>If you apply {preview.ianaTimezone}</h5>
      <p className="log-time__copy">
        {lines(preview.affectedRecords)} would get an exact time
        {preview.firstResolvedInstant && preview.lastResolvedInstant
          ? `, spanning ${preview.firstResolvedInstant} to ${preview.lastResolvedInstant} UTC`
          : ""}
        .{" "}
        {preview.unchangedOrderOnlyRecords > 0
          ? `${lines(preview.unchangedOrderOnlyRecords)} have no timestamp to place and stay in file order.`
          : ""}
        {preview.existingWallClockRecords > 0
          ? ` ${lines(preview.existingWallClockRecords)} already state their own timezone and are left alone.`
          : ""}
      </p>

      {problems > 0 ? (
        <ul className="log-time__problems">
          {preview.dstGapCount > 0 ? (
            <li>
              <strong>{lines(preview.dstGapCount)}</strong> fall in the hour this
              zone skips when clocks go forward. That local time never existed,
              so those lines keep file order instead.
            </li>
          ) : null}
          {preview.dstFoldCount > 0 ? (
            <li>
              <strong>{lines(preview.dstFoldCount)}</strong> fall in the hour this
              zone repeats when clocks go back. There are two possible instants
              and no way to tell which, so those lines keep file order.
            </li>
          ) : null}
          {preview.zoneAbbreviationMismatchCount > 0 ? (
            <li>
              <strong>{lines(preview.zoneAbbreviationMismatchCount)}</strong> name
              a zone abbreviation that contradicts {preview.ianaTimezone}. That
              usually means this is the wrong zone for this file.
            </li>
          ) : null}
          {preview.unsupportedTimestampCount > 0 ? (
            <li>
              <strong>{lines(preview.unsupportedTimestampCount)}</strong> have a
              timestamp too incomplete to place on a calendar.
            </li>
          ) : null}
          {preview.outOfRangeCount > 0 ? (
            <li>
              <strong>{lines(preview.outOfRangeCount)}</strong> would land outside
              the date range this investigation stores.
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="log-time__copy">
          No daylight-saving gaps or folds in this file under this zone.
        </p>
      )}

      <details className="log-time__samples" open>
        <summary>See these lines with both timestamps</summary>
        <SampleTable samples={visible} />
        {hidden.length > 0 ? (
          <details>
            <summary>Show {hidden.length} more sampled lines</summary>
            <SampleTable samples={hidden} />
          </details>
        ) : null}
        <p className="log-time__hint">
          Showing the first {preview.samples.length} lines of this file, not all
          of them.
        </p>
      </details>

      {props.canApply ? (
        preview.affectedRecords > 0 ? (
          <button type="button" onClick={props.onApply} disabled={props.busy !== null}>
            {props.busy === "apply"
              ? "Applying…"
              : `Apply ${preview.ianaTimezone} to this file`}
          </button>
        ) : (
          <p className="log-time__copy" role="note">
            Nothing can be given an exact time with this choice, so there is no
            time change to apply. Keep these lines in file order or preview a
            different timezone.
          </p>
        )
      ) : null}
    </div>
  );
}

/** Raw text, the instant it becomes, and the line it came from, side by side. */
function SampleTable(props: { samples: Sample[] }) {
  return (
    <div className="log-time__table-scroll">
      <table className="log-time__table">
        <thead>
          <tr>
            <th scope="col">In the file</th>
            <th scope="col">Becomes</th>
            <th scope="col">Log line</th>
          </tr>
        </thead>
        <tbody>
          {props.samples.map((sample) => (
            <tr
              key={sample.ordinal}
              data-outcome={sample.outcome}
              className={
                sample.outcome === "unresolved" ? "log-time__row--unresolved" : undefined
              }
            >
              <td>
                <code>{sample.rawTimestamp ?? "no timestamp"}</code>
              </td>
              <td>
                {sample.normalizedInstant ? (
                  <>
                    <code>{sample.normalizedInstant}</code>
                    {sample.utcOffsetSeconds !== null ? (
                      <span className="log-time__offset">
                        {" "}
                        ({formatOffset(sample.utcOffsetSeconds)})
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="log-time__unresolved">
                    stays in file order —{" "}
                    {UNRESOLVED_WORDING[sample.unresolvedReason ?? ""] ??
                      "this line cannot be placed."}
                  </span>
                )}
              </td>
              <td className="log-time__excerpt">{sample.excerpt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the time changes did to snapshots and runs already produced. */
function DependentImpact(props: { dependents: Dependent[] }) {
  const notable = props.dependents.filter((d) => d.disposition !== "unaffected");
  if (notable.length === 0) return null;

  return (
    <details className="log-time__dependents" open>
      <summary>
        What changing the time did to work already done ({notable.length})
      </summary>
      <ul>
        {notable.map((dependent) => (
          <li key={`${dependent.kind}:${dependent.id}`} data-disposition={dependent.disposition}>
            <span className={`log-time__chip log-time__chip--${dependent.disposition}`}>
              {dependent.disposition === "revised"
                ? "reads differently now"
                : dependent.disposition === "invalidated"
                  ? "no longer current"
                  : "time basis unknown"}
            </span>{" "}
            <span className="log-time__dependent-id">
              {dependent.kind === "snapshot" ? "Evidence set" : "Run"} {dependent.id}
            </span>
            <p className="log-time__copy">{dependent.reason}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
