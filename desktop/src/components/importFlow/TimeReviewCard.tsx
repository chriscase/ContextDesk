/**
 * Corpus-wide timezone review card (#813), shown on the import summary.
 *
 * The common path is one decision: a shared zone across every unresolved
 * source, applied atomically. Deterministic exception groups sit behind a
 * disclosure; each can be included or left order-only. Previews run
 * automatically for the current zone and selection — there is no manual
 * Preview prerequisite and Apply is never mutely disabled: whenever it
 * cannot proceed, the reason renders beside it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { EngineClient, TimezonePreview } from "@contextdesk/client";
import { EngineError } from "@contextdesk/client";
import type { ImportRunReport } from "@contextdesk/client";
import { isValidIanaZone, timezoneGroups, type TimezoneGroup } from "./importFlowState";

const AUTO_PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_CONCURRENCY = 8;

type Props = {
  engine: EngineClient;
  report: ImportRunReport;
  /** Refresh host-backed corpus summaries after apply or undo. */
  onChanged?: (corpusId: string) => void;
};

type AppliedScope = {
  zone: string;
  sourceCount: number;
  revision: number;
};

type PreparedPreviews = {
  eventRevision: number;
  zone: string;
  sourceKey: string;
  bySource: Map<string, TimezonePreview>;
};

type PreviewProgress = {
  completed: number;
  total: number;
};

async function previewWithBoundedConcurrency(
  sources: string[],
  preview: (source: string) => Promise<TimezonePreview>,
  isCurrent: () => boolean,
  onProgress: (completed: number) => void,
): Promise<Map<string, TimezonePreview>> {
  const results = new Map<string, TimezonePreview>();
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (isCurrent()) {
      const index = nextIndex++;
      if (index >= sources.length) return;
      const source = sources[index];
      const result = await preview(source);
      if (!isCurrent()) return;
      results.set(source, result);
      completed += 1;
      onProgress(completed);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PREVIEW_CONCURRENCY, sources.length) }, () => worker()),
  );
  return results;
}

function machineZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

function zoneCatalog(): string[] {
  try {
    const values = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf?.("timeZone");
    return values ?? [];
  } catch {
    return [];
  }
}

export function TimeReviewCard({ engine, report, onChanged }: Props) {
  const headingId = useId();
  const listId = useId();
  const groups = useMemo(() => timezoneGroups(report), [report]);
  const allSources = useMemo(() => groups.flatMap((group) => group.sources), [groups]);
  const [dismissed, setDismissed] = useState(false);
  const [zone, setZone] = useState("");
  const [includedGroups, setIncludedGroups] = useState<ReadonlySet<string>>(
    () => new Set(groups.map((group) => group.key)),
  );
  const [prepared, setPrepared] = useState<PreparedPreviews | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyQueued, setApplyQueued] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedScope | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const debounceRef = useRef<number | null>(null);
  const requestSeq = useRef(0);
  const applyIntentRef = useRef(false);
  const applyRunningRef = useRef(false);

  const includedSources = useMemo(
    () =>
      groups
        .filter((group) => includedGroups.has(group.key))
        .flatMap((group) => group.sources),
    [groups, includedGroups],
  );

  const zoneValid = isValidIanaZone(zone);
  const suggestion = machineZone();
  const normalizedZone = zone.trim();
  const sourceKey = JSON.stringify(includedSources);

  // A queued click belongs only to the exact zone and source scope visible
  // when it was made. Editing either cancels that intent.
  useEffect(() => {
    applyIntentRef.current = false;
    setApplyQueued(false);
  }, [normalizedZone, sourceKey]);

  // Auto-preview: debounced, token-bound, read-only. Every zone or scope
  // change invalidates in-flight results by sequence number.
  useEffect(() => {
    const sequence = ++requestSeq.current;
    if (applied || dismissed) return;
    setPrepared(null);
    setPreviewError(null);
    if (!zoneValid || includedSources.length === 0) {
      setPreviewPending(false);
      setPreviewProgress(null);
      return;
    }
    setPreviewPending(true);
    setPreviewProgress({ completed: 0, total: includedSources.length });
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const state = await engine.time.state(report.corpusId);
          if (requestSeq.current !== sequence) return;
          const results = await previewWithBoundedConcurrency(
            includedSources,
            (source) =>
              engine.time.preview(
                report.corpusId,
                state.eventRevision,
                source,
                normalizedZone,
              ),
            () => requestSeq.current === sequence,
            (completed) => {
              if (requestSeq.current === sequence) {
                setPreviewProgress({ completed, total: includedSources.length });
              }
            },
          );
          if (requestSeq.current === sequence) {
            setPrepared({
              eventRevision: state.eventRevision,
              zone: normalizedZone,
              sourceKey,
              bySource: results,
            });
            setPreviewPending(false);
          }
        } catch (error) {
          if (requestSeq.current === sequence) {
            requestSeq.current += 1;
            applyIntentRef.current = false;
            setApplyQueued(false);
            setPreviewPending(false);
            setPreviewError(error instanceof Error ? error.message : String(error));
          }
        }
      })();
    }, AUTO_PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
      if (requestSeq.current === sequence) requestSeq.current += 1;
    };
  }, [
    engine,
    report.corpusId,
    normalizedZone,
    zoneValid,
    includedSources,
    sourceKey,
    applied,
    dismissed,
    previewNonce,
  ]);

  const previewTotals = prepared
    ? [...prepared.bySource.values()].reduce(
        (totals, preview) => ({
          affected: totals.affected + preview.affectedRecords,
          remaining:
            totals.remaining +
            preview.unchangedOrderOnlyRecords +
            preview.unsupportedTimestampRecords +
            preview.zoneAbbreviationMismatchRecords +
            preview.dstGapRecords +
            preview.dstFoldAmbiguities +
            preview.outOfRangeRecords,
        }),
        { affected: 0, remaining: 0 },
      )
    : null;

  const applyDisabledReason = applying
    ? "Applying…"
    : !zoneValid
      ? "Choose an IANA timezone first — for example America/Chicago."
      : includedSources.length === 0
        ? "Every group is set to stay order-only. Include at least one group."
        : applyQueued
          ? "Preparing the verified change. Apply will start automatically."
          : prepared && previewTotals && previewTotals.affected === 0
            ? "Nothing to apply — this zone resolves no records."
            : null;

  const applyPrepared = useCallback(async (batch: PreparedPreviews) => {
    if (applyRunningRef.current) return;
    if (batch.zone !== normalizedZone || batch.sourceKey !== sourceKey) return;
    applyRunningRef.current = true;
    applyIntentRef.current = false;
    setApplyQueued(false);
    setApplying(true);
    setApplyError(null);
    try {
      const requests = includedSources.map((source) => {
        const preview = batch.bySource.get(source);
        if (!preview) throw new EngineError("conflict", "preview is incomplete; retrying");
        return {
          source,
          ianaTimezone: normalizedZone,
          previewToken: preview.previewToken,
        };
      });
      const revision = await engine.time.applyMany(
        report.corpusId,
        batch.eventRevision,
        requests,
      );
      setApplied({
        zone: normalizedZone,
        sourceCount: requests.length,
        revision: revision.revision,
      });
      onChanged?.(report.corpusId);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
      // A conflict means the corpus moved. Refresh the verified preview, but
      // require another explicit click before changing the corpus.
      setPrepared(null);
      setPreviewNonce((nonce) => nonce + 1);
    } finally {
      applyRunningRef.current = false;
      setApplying(false);
    }
  }, [engine, includedSources, normalizedZone, onChanged, report.corpusId, sourceKey]);

  useEffect(() => {
    if (!applyQueued || !prepared || previewPending || previewError) return;
    void applyPrepared(prepared);
  }, [applyPrepared, applyQueued, prepared, previewError, previewPending]);

  const onApply = () => {
    if (!zoneValid || includedSources.length === 0 || applying || applyIntentRef.current) return;
    if (prepared && previewTotals && previewTotals.affected === 0) return;

    if (prepared) {
      void applyPrepared(prepared);
      return;
    }

    // Accept the click even while the automatic safety preview is running.
    // This avoids an inert-looking primary action on large corpora.
    applyIntentRef.current = true;
    setApplyQueued(true);
    setApplyError(null);
    if (previewError) {
      setPreviewError(null);
      setPreviewNonce((nonce) => nonce + 1);
    }
  };

  const onUndo = async () => {
    if (!applied) return;
    setUndoing(true);
    setApplyError(null);
    try {
      await engine.time.undo(report.corpusId, applied.revision);
      setApplied(null);
      setZone("");
      onChanged?.(report.corpusId);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setUndoing(false);
    }
  };

  if (groups.length === 0 || dismissed) return null;

  if (applied) {
    return (
      <section className="import-time" aria-labelledby={headingId}>
        <header className="import-time__head">
          <h3 id={headingId}>Source time</h3>
        </header>
        <div className="import-time__applied" role="status">
          <span className="import-time__scope-chip">
            {applied.zone} · {applied.sourceCount} source{applied.sourceCount === 1 ? "" : "s"}
          </span>
          <button type="button" className="import-time__ghost" onClick={() => setApplied(null)}>
            Change
          </button>
          <button
            type="button"
            className="import-time__ghost"
            disabled={undoing}
            onClick={() => void onUndo()}
          >
            {undoing ? "Undoing…" : "Undo / return to order-only"}
          </button>
        </div>
        {applyError ? (
          <p className="import-time__error" role="alert">
            {applyError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="import-time" aria-labelledby={headingId}>
      <header className="import-time__head">
        <h3 id={headingId}>Place local timestamps</h3>
        <span className="import-time__count">
          {allSources.length} source{allSources.length === 1 ? "" : "s"} unresolved
        </span>
      </header>
      <p className="import-time__lead">
        These sources use local timestamps without a resolvable timezone. ContextDesk did not
        guess a timezone.
      </p>
      <div className="import-time__zone-row">
        <input
          className="import-time__zone"
          list={listId}
          value={zone}
          placeholder="For example, America/Chicago"
          aria-label="IANA timezone"
          onChange={(event) => setZone(event.target.value)}
        />
        <datalist id={listId}>
          {zoneCatalog().map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <button
          type="button"
          className="import-time__apply"
          disabled={applyDisabledReason !== null}
          aria-describedby={applyDisabledReason && !applying ? `${headingId}-reason` : undefined}
          onClick={onApply}
        >
          {applying
            ? "Applying…"
            : applyQueued
              ? `Preparing ${previewProgress?.completed ?? 0}/${includedSources.length}…`
              : previewError
                ? `Retry and apply to ${includedSources.length} source${includedSources.length === 1 ? "" : "s"}`
                : `Apply to ${includedSources.length} source${includedSources.length === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          className="import-time__ghost"
          onClick={() => setDismissed(true)}
        >
          Decide later — keep order-only
        </button>
      </div>
      {applyDisabledReason && !applying ? (
        <p className="import-time__reason" id={`${headingId}-reason`}>
          {applyDisabledReason}
        </p>
      ) : null}
      {previewPending && previewProgress ? (
        <div className="import-time__progress" role="status" aria-live="polite">
          <progress
            aria-label="Preparing timezone change"
            value={previewProgress.completed}
            max={previewProgress.total}
          />
          <span>
            Checking {previewProgress.completed.toLocaleString()} of{" "}
            {previewProgress.total.toLocaleString()} sources
            {applyQueued ? " · apply will start automatically" : ""}
          </span>
        </div>
      ) : null}
      {applying ? (
        <p className="import-time__progress-text" role="status" aria-live="polite">
          Applying {normalizedZone} atomically to {includedSources.length.toLocaleString()} sources…
        </p>
      ) : null}
      {previewError ? (
        <p className="import-time__error" role="alert">
          Could not prepare the timezone change: {previewError}. Choose Retry to try again.
        </p>
      ) : null}
      {suggestion && !zone ? (
        <p className="import-time__suggestion">
          Suggested: {suggestion} — this computer&rsquo;s timezone. Not applied.
        </p>
      ) : null}
      {prepared && previewTotals && !previewPending ? (
        <p className="import-time__preview" role="status">
          Preview — not applied · {previewTotals.affected.toLocaleString()} records resolve ·{" "}
          {previewTotals.remaining.toLocaleString()} remain order-only
        </p>
      ) : null}
      {applyError ? (
        <p className="import-time__error" role="alert">
          {applyError}
        </p>
      ) : null}
      {groups.length > 1 ? (
        <details className="import-time__groups">
          <summary>Exceptions — {groups.length} groups</summary>
          <ul>
            {groups.map((group: TimezoneGroup) => (
              <li key={group.key} className="import-time__group">
                <label>
                  <input
                    type="checkbox"
                    checked={includedGroups.has(group.key)}
                    onChange={() =>
                      setIncludedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  />
                  <span className="import-time__group-label">
                    {group.label} · {group.sources.length} source
                    {group.sources.length === 1 ? "" : "s"} ·{" "}
                    {group.records.toLocaleString()} records
                  </span>
                  <span className="import-time__group-mode">
                    {includedGroups.has(group.key) ? "uses shared zone" : "stays order-only"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
