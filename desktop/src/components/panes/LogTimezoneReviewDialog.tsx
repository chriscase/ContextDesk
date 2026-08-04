import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  LogSourceConfidenceDto,
  LogTimezoneApplyRequestDto,
  LogTimezoneClearRequestDto,
  LogTimezoneDeclarationDto,
  LogTimezonePreviewRequestDto,
  LogTimezoneResolutionPreviewDto,
  LogTimezoneScopeDto,
} from "../../lib/host";

type ResolutionMode = "unresolved" | "iana";

export type LogTimezoneReviewDialogProps = {
  scope: LogTimezoneScopeDto;
  source: LogSourceConfidenceDto;
  declaration?: LogTimezoneDeclarationDto | null;
  suggestedZone?: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef: RefObject<HTMLButtonElement | null>;
  onPreview: (
    request: LogTimezonePreviewRequestDto,
  ) => Promise<LogTimezoneResolutionPreviewDto>;
  onApply: (request: LogTimezoneApplyRequestDto) => Promise<void>;
  onClear?: (request: LogTimezoneClearRequestDto) => Promise<void>;
  onDismiss: () => void;
};

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  );
}

function trapFocus(
  event: ReactKeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
) {
  if (event.key !== "Tab") return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function isValidIanaZone(value: string): boolean {
  const zone = value.trim();
  if (zone !== "UTC" && !zone.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function systemIanaZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidIanaZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

const FALLBACK_IANA_ZONES = [
  "UTC",
  "America/Anchorage",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Brisbane",
  "Australia/Melbourne",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Berlin",
  "Europe/Dublin",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Prague",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Zurich",
] as const;

function supportedIanaZones(preferred: Array<string | null>): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  const available = (() => {
    try {
      return supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  })();
  return Array.from(
    new Set([
      ...preferred.filter((value): value is string => Boolean(value)),
      "UTC",
      ...available,
      ...FALLBACK_IANA_ZONES,
    ]),
  ).filter(isValidIanaZone);
}

function currentUtcOffset(zone: string): string {
  try {
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    if (!offset) return "current offset unavailable";
    return offset.replace(/^GMT/, "UTC").replace("-", "−");
  } catch {
    return "current offset unavailable";
  }
}

function friendlyZoneLabel(zone: string): string {
  if (zone === "UTC") return "Coordinated Universal Time · UTC+00:00";
  const parts = zone.split("/");
  const city = (parts.at(-1) ?? zone).replaceAll("_", " ");
  const region = parts.slice(0, -1).join(" · ").replaceAll("_", " ");
  return `${city}${region ? ` · ${region}` : ""} · ${currentUtcOffset(zone)} now`;
}

function countLabel(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function formatWholeSecondUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", "Z");
}

function sourceReason(
  source: LogSourceConfidenceDto,
  declaration?: LogTimezoneDeclarationDto | null,
): string {
  if (declaration) {
    return `${declaration.ianaZone} is the active source timezone. You can preview a different IANA timezone or remove this declaration to return its resolved local records to order-only time.`;
  }
  const reasons = source.unresolvedReasons ?? [];
  if (reasons.includes("zone_abbreviation_not_resolved")) {
    return "This source includes a timezone abbreviation. Abbreviations such as CET can refer to different regional or historic rules, so ContextDesk left those records order-only.";
  }
  return "This source has local date and time values without a timezone. They cannot be placed on a shared wall clock until you declare the source’s IANA timezone.";
}

export function LogTimezoneReviewDialog({
  scope,
  source,
  declaration,
  suggestedZone,
  triggerRef,
  fallbackFocusRef,
  onPreview,
  onApply,
  onClear,
  onDismiss,
}: LogTimezoneReviewDialogProps) {
  const systemSuggestedZone =
    !declaration && !suggestedZone ? systemIanaZone() : null;
  const effectiveSuggestedZone = suggestedZone ?? systemSuggestedZone;
  const initialMode: ResolutionMode = declaration ? "iana" : "unresolved";
  const initialZone = declaration?.ianaZone ?? effectiveSuggestedZone ?? "";
  const declarationZone = declaration?.ianaZone ?? null;
  const declarationRevision = declaration?.appliedRevision ?? null;
  const [mode, setMode] = useState<ResolutionMode>(initialMode);
  const [zone, setZone] = useState(initialZone);
  const [preview, setPreview] =
    useState<LogTimezoneResolutionPreviewDto | null>(null);
  const [status, setStatus] = useState<
    "idle" | "previewing" | "applying" | "clearing"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const safeDefaultRef = useRef<HTMLInputElement>(null);
  const previewGenerationRef = useRef(0);
  const titleId = useId();
  const descriptionId = useId();
  const zoneHelpId = useId();
  const zoneListId = useId();
  const resultId = useId();
  const timezoneOptions = useMemo(
    () =>
      supportedIanaZones([declarationZone, effectiveSuggestedZone]).map(
        (ianaZone) => ({
          ianaZone,
          label: friendlyZoneLabel(ianaZone),
        }),
      ),
    [declarationZone, effectiveSuggestedZone],
  );
  const busy = status !== "idle";
  const mutationBusy = status === "applying" || status === "clearing";
  const trimmedZone = zone.trim();
  const validZone = mode === "iana" && isValidIanaZone(trimmedZone);
  const previewMatchesCurrent =
    preview?.corpusId === scope.corpusId &&
    preview.eventRevision === scope.eventRevision &&
    preview?.source === source.source &&
    preview.ianaZone === trimmedZone &&
    preview.previewToken.trim().length > 0;
  const previewCanApply =
    previewMatchesCurrent && (preview?.affectedRecords ?? 0) > 0;
  const residualOrderOnlyRecords = preview
    ? preview.unchangedOrderOnlyRecords +
      preview.dstGapRecords +
      preview.dstFoldAmbiguities +
      preview.unsupportedTimestampRecords +
      preview.zoneAbbreviationMismatchRecords +
      preview.outOfRangeRecords
    : 0;
  const resultingWallClockRecords = preview
    ? preview.affectedRecords + preview.existingWallClockRecords
    : 0;
  const resultingSourceQuality =
    resultingWallClockRecords > 0 && residualOrderOnlyRecords > 0
      ? "mixed"
      : resultingWallClockRecords > 0
        ? "exact wall clock"
        : "order-only";

  const restoreFocus = () => {
    queueMicrotask(() => {
      (triggerRef.current ?? fallbackFocusRef.current)?.focus();
    });
  };

  const dismiss = () => {
    if (mutationBusy) return;
    previewGenerationRef.current += 1;
    onDismiss();
    restoreFocus();
  };

  const invalidatePreview = () => {
    previewGenerationRef.current += 1;
    setPreview(null);
    setError(null);
    setConfirmClear(false);
  };

  useEffect(() => {
    previewGenerationRef.current += 1;
    setMode(declarationZone ? "iana" : "unresolved");
    setZone(declarationZone ?? effectiveSuggestedZone ?? "");
    setPreview(null);
    setError(null);
    setConfirmClear(false);
    setStatus("idle");
    queueMicrotask(() => safeDefaultRef.current?.focus());
  }, [
    source.source,
    declarationZone,
    declarationRevision,
    effectiveSuggestedZone,
    scope.corpusId,
    scope.eventRevision,
  ]);

  useEffect(() => {
    queueMicrotask(() => safeDefaultRef.current?.focus());
  }, []);

  const previewZone = async () => {
    if (!validZone || busy) return;
    const request: LogTimezonePreviewRequestDto = {
      corpusId: scope.corpusId,
      eventRevision: scope.eventRevision,
      source: source.source,
      ianaZone: trimmedZone,
    };
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    setPreview(null);
    setError(null);
    setStatus("previewing");
    try {
      const result = await onPreview(request);
      if (previewGenerationRef.current !== generation) return;
      if (
        result.corpusId !== request.corpusId ||
        result.eventRevision !== request.eventRevision ||
        result.source !== request.source ||
        result.ianaZone !== request.ianaZone ||
        !result.previewToken.trim()
      ) {
        throw new Error(
          "The preview no longer matches this source, timezone, or corpus revision. Preview again.",
        );
      }
      setPreview(result);
    } catch (previewError) {
      if (previewGenerationRef.current !== generation) return;
      setError(String(previewError));
    } finally {
      if (previewGenerationRef.current === generation) setStatus("idle");
    }
  };

  const applyPreview = async () => {
    if (!previewCanApply || !preview || busy) return;
    setError(null);
    setStatus("applying");
    try {
      await onApply({
        corpusId: scope.corpusId,
        expectedRevision: scope.eventRevision,
        source: source.source,
        ianaZone: trimmedZone,
        previewToken: preview.previewToken,
      });
      onDismiss();
      restoreFocus();
    } catch (applyError) {
      setError(String(applyError));
      setStatus("idle");
    }
  };

  const clearDeclaration = async () => {
    if (!declaration || !onClear || busy) return;
    setError(null);
    setStatus("clearing");
    try {
      await onClear({
        corpusId: scope.corpusId,
        expectedRevision: scope.eventRevision,
        source: source.source,
        appliedRevision: declaration.appliedRevision,
      });
      onDismiss();
      restoreFocus();
    } catch (clearError) {
      setError(String(clearError));
      setStatus("idle");
      setConfirmClear(false);
    }
  };

  const dialog = (
    <div
      className="log-timezone-review__backdrop"
      data-testid="timezone-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          return;
        }
        trapFocus(event, dialogRef.current);
      }}
    >
      <div
        ref={dialogRef}
        className="log-timezone-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="log-timezone-review__header">
          <div>
            <span className="eyebrow">Source time</span>
            <h2 id={titleId}>Review timezone</h2>
            <span className="log-timezone-review__source">{source.source}</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            aria-label="Close timezone review"
            disabled={mutationBusy}
            onClick={dismiss}
          >
            Close
          </button>
        </header>

        <div className="log-timezone-review__body">
          <p id={descriptionId} className="log-timezone-review__lead">
            {sourceReason(source, declaration)}
          </p>

          <fieldset className="log-timezone-review__choice">
            <legend>How should this source be placed in time?</legend>
            <label>
              <input
                ref={safeDefaultRef}
                type="radio"
                name="timezone-resolution-mode"
                value="unresolved"
                checked={mode === "unresolved"}
                disabled={busy}
                onChange={() => {
                  invalidatePreview();
                  setMode("unresolved");
                }}
              />
              <span>
                <strong>Leave unresolved — order-only</strong>
                <small>
                  Safest default. Records remain searchable without claiming
                  exact alignment.
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="timezone-resolution-mode"
                value="iana"
                checked={mode === "iana"}
                disabled={busy}
                onChange={() => {
                  invalidatePreview();
                  setMode("iana");
                }}
              />
              <span>
                <strong>Use an IANA timezone</strong>
                <small>
                  You choose the regional rules. ContextDesk never applies a
                  hint automatically.
                </small>
              </span>
            </label>
          </fieldset>

          <label className="log-timezone-review__zone-field">
            <span>IANA timezone</span>
            <input
              type="text"
              list={zoneListId}
              value={zone}
              placeholder="For example, America/Chicago"
              autoComplete="off"
              spellCheck={false}
              disabled={mode !== "iana" || busy}
              aria-describedby={zoneHelpId}
              aria-invalid={
                mode === "iana" && trimmedZone.length > 0 && !validZone
              }
              onChange={(event) => {
                invalidatePreview();
                setZone(event.target.value);
              }}
            />
            <datalist id={zoneListId}>
              {timezoneOptions.map((option) => (
                <option
                  key={option.ianaZone}
                  value={option.ianaZone}
                  label={option.label}
                />
              ))}
            </datalist>
            <small id={zoneHelpId}>
              Browse or type to filter by location. Options show the current UTC
              offset; preview applies the region’s historical daylight-saving
              rules to each log time. The precise regional identifier is saved,
              and abbreviations such as CET are not accepted.
              {effectiveSuggestedZone && !declaration ? (
                <>
                  {" "}
                  {suggestedZone
                    ? "A saved or bundle hint filled this field; it is not active."
                    : "This computer’s timezone filled this field as a convenience; it is not active."}
                </>
              ) : null}
            </small>
          </label>

          <details className="log-timezone-review__explanation">
            <summary>Why timezone review can leave records unresolved</summary>
            <dl>
              <div>
                <dt>No timezone</dt>
                <dd>
                  A local clock value has no unique place on a shared timeline.
                </dd>
              </div>
              <div>
                <dt>Abbreviation</dt>
                <dd>
                  Short names can map to several regions or historic offset
                  rules.
                </dd>
              </div>
              <div>
                <dt>DST gap</dt>
                <dd>
                  Some local times never occurred when clocks moved forward.
                </dd>
              </div>
              <div>
                <dt>DST fold</dt>
                <dd>
                  Some local times occurred twice when clocks moved backward.
                </dd>
              </div>
            </dl>
          </details>

          {previewMatchesCurrent && preview ? (
            <section
              id={resultId}
              className="log-timezone-review__preview"
              aria-label="Timezone preview"
            >
              <div className="log-timezone-review__preview-heading">
                <strong>Preview for {preview.ianaZone}</strong>
                <span>Not applied</span>
              </div>
              <p className="log-timezone-review__outcome">
                <strong>
                  {countLabel(preview.affectedRecords, "record")} resolved
                </strong>
                <span aria-hidden="true"> · </span>
                {countLabel(residualOrderOnlyRecords, "record")} remain
                order-only
                <span aria-hidden="true"> · </span>
                Resulting source quality: {resultingSourceQuality}
              </p>
              <dl>
                <div>
                  <dt>Affected</dt>
                  <dd>{countLabel(preview.affectedRecords, "record")}</dd>
                </div>
                <div>
                  <dt>Already exact</dt>
                  <dd>
                    {countLabel(preview.existingWallClockRecords, "record")}
                  </dd>
                </div>
                <div>
                  <dt>First resolved</dt>
                  <dd>
                    {preview.firstResolvedTs == null
                      ? "None"
                      : formatWholeSecondUtc(preview.firstResolvedTs)}
                  </dd>
                </div>
                <div>
                  <dt>Last resolved</dt>
                  <dd>
                    {preview.lastResolvedTs == null
                      ? "None"
                      : formatWholeSecondUtc(preview.lastResolvedTs)}
                  </dd>
                </div>
                <div>
                  <dt>DST gaps</dt>
                  <dd>{countLabel(preview.dstGapRecords, "record")}</dd>
                </div>
                <div>
                  <dt>DST fold ambiguity</dt>
                  <dd>{countLabel(preview.dstFoldAmbiguities, "record")}</dd>
                </div>
                <div>
                  <dt>Unchanged / order-only</dt>
                  <dd>
                    {countLabel(preview.unchangedOrderOnlyRecords, "record")}
                  </dd>
                </div>
                <div>
                  <dt>Unsupported shape</dt>
                  <dd>
                    {countLabel(preview.unsupportedTimestampRecords, "record")}
                  </dd>
                </div>
                <div>
                  <dt>Zone abbreviation conflict</dt>
                  <dd>
                    {countLabel(
                      preview.zoneAbbreviationMismatchRecords,
                      "record",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Outside supported range</dt>
                  <dd>{countLabel(preview.outOfRangeRecords, "record")}</dd>
                </div>
              </dl>
              <p>
                Alignment is currently stored at coarse whole-second precision.
                Fractional source digits are not claimed in this preview.
              </p>
              {preview.affectedRecords === 0 ? (
                <p role="note">
                  No records can be resolved by this declaration, so there is
                  nothing to apply. Leave the source order-only or choose a
                  different zone after confirming the source’s time rules.
                </p>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <div className="log-timezone-review__error" role="alert">
              {error}
            </div>
          ) : null}

          <span className="sr-only" role="status" aria-live="polite">
            {status === "previewing"
              ? "Previewing timezone"
              : status === "applying"
                ? "Applying timezone declaration"
                : status === "clearing"
                  ? "Removing timezone declaration"
                  : previewMatchesCurrent
                    ? "Timezone preview ready"
                    : ""}
          </span>

          {declaration && onClear ? (
            <section className="log-timezone-review__current">
              <div>
                <strong>Current declaration</strong>
                <span>
                  {declaration.ianaZone} · revision{" "}
                  {declaration.appliedRevision}
                </span>
              </div>
              {confirmClear ? (
                <div
                  className="log-timezone-review__clear-confirm"
                  role="group"
                  aria-label="Confirm timezone removal"
                >
                  <p>
                    Remove this declaration and return affected records to
                    order-only? Raw timestamp text stays unchanged, and you can
                    declare a zone again later.
                  </p>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy}
                    onClick={() => setConfirmClear(false)}
                  >
                    Keep declaration
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost log-timezone-review__danger"
                    disabled={busy}
                    onClick={() => void clearDeclaration()}
                  >
                    {status === "clearing"
                      ? "Removing…"
                      : "Remove and use order-only"}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => setConfirmClear(true)}
                >
                  Remove declaration…
                </button>
              )}
            </section>
          ) : null}
        </div>

        <footer className="log-timezone-review__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!validZone || busy}
            onClick={() => void previewZone()}
          >
            {status === "previewing" ? "Previewing…" : "Preview"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!previewCanApply || busy}
            aria-describedby={previewMatchesCurrent ? resultId : undefined}
            onClick={() => void applyPreview()}
          >
            {status === "applying" ? "Applying…" : "Apply declaration"}
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
