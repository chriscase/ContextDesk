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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { EngineClient, TimezonePreview } from "@contextdesk/client";
import { EngineError } from "@contextdesk/client";
import type { ImportRunReport } from "@contextdesk/client";
import { isValidIanaZone, timezoneGroups, type TimezoneGroup } from "./importFlowState";

const AUTO_PREVIEW_DEBOUNCE_MS = 300;

type Props = {
  engine: EngineClient;
  report: ImportRunReport;
};

type AppliedScope = {
  zone: string;
  sourceCount: number;
  revision: number;
};

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

export function TimeReviewCard({ engine, report }: Props) {
  const headingId = useId();
  const listId = useId();
  const groups = useMemo(() => timezoneGroups(report), [report]);
  const allSources = useMemo(() => groups.flatMap((group) => group.sources), [groups]);
  const [dismissed, setDismissed] = useState(false);
  const [zone, setZone] = useState("");
  const [includedGroups, setIncludedGroups] = useState<ReadonlySet<string>>(
    () => new Set(groups.map((group) => group.key)),
  );
  const [previews, setPreviews] = useState<Map<string, TimezonePreview> | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedScope | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const requestSeq = useRef(0);

  const includedSources = useMemo(
    () =>
      groups
        .filter((group) => includedGroups.has(group.key))
        .flatMap((group) => group.sources),
    [groups, includedGroups],
  );

  const zoneValid = isValidIanaZone(zone);
  const suggestion = machineZone();

  // Auto-preview: debounced, token-bound, read-only. Every zone or scope
  // change invalidates in-flight results by sequence number.
  useEffect(() => {
    if (applied || dismissed) return;
    setPreviews(null);
    setPreviewError(null);
    if (!zoneValid || includedSources.length === 0) {
      setPreviewPending(false);
      return;
    }
    setPreviewPending(true);
    const sequence = ++requestSeq.current;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const state = await engine.time.state(report.corpusId);
          const results = new Map<string, TimezonePreview>();
          for (const source of includedSources) {
            const preview = await engine.time.preview(
              report.corpusId,
              state.eventRevision,
              source,
              zone.trim(),
            );
            results.set(source, preview);
          }
          if (requestSeq.current === sequence) {
            setPreviews(results);
            setPreviewPending(false);
          }
        } catch (error) {
          if (requestSeq.current === sequence) {
            setPreviewPending(false);
            setPreviewError(error instanceof Error ? error.message : String(error));
          }
        }
      })();
    }, AUTO_PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [engine, report.corpusId, zone, zoneValid, includedSources, applied, dismissed]);

  if (groups.length === 0 || dismissed) return null;

  const previewTotals = previews
    ? [...previews.values()].reduce(
        (totals, preview) => ({
          affected: totals.affected + preview.affectedRecords,
          remaining:
            totals.remaining +
            preview.unchangedOrderOnlyRecords +
            preview.unsupportedTimestampRecords +
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
        : previewPending
          ? "Waiting for the automatic preview…"
          : previewError
            ? `Preview failed: ${previewError}`
            : previews && previewTotals && previewTotals.affected === 0
              ? "Nothing to apply — this zone resolves no records."
              : null;

  const onApply = async () => {
    if (applyDisabledReason || !previews) return;
    setApplying(true);
    setApplyError(null);
    try {
      const state = await engine.time.state(report.corpusId);
      const requests = includedSources.map((source) => {
        const preview = previews.get(source);
        if (!preview) throw new EngineError("conflict", "preview is incomplete; retrying");
        return {
          source,
          ianaTimezone: zone.trim(),
          previewToken: preview.previewToken,
        };
      });
      const revision = await engine.time.applyMany(
        report.corpusId,
        state.eventRevision,
        requests,
      );
      setApplied({ zone: zone.trim(), sourceCount: requests.length, revision: revision.revision });
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
      // A conflict means the corpus moved; the next auto-preview recomputes.
      setPreviews(null);
      requestSeq.current += 1;
    } finally {
      setApplying(false);
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
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setUndoing(false);
    }
  };

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
          aria-describedby={applyDisabledReason ? `${headingId}-reason` : undefined}
          onClick={() => void onApply()}
        >
          {applying
            ? "Applying…"
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
      {suggestion && !zone ? (
        <p className="import-time__suggestion">
          Suggested: {suggestion} — this computer&rsquo;s timezone. Not applied.
        </p>
      ) : null}
      {previews && previewTotals && !previewPending ? (
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
