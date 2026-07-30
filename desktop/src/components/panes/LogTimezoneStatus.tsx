import { useEffect, useId, useRef, useState } from "react";
import type {
  LogSourceConfidenceDto,
  LogTimezoneApplyRequestDto,
  LogTimezoneClearRequestDto,
  LogTimezonePreviewRequestDto,
  LogTimezoneResolutionPreviewDto,
  LogTimezoneSourceStatusDto,
  LogTimezoneStateDto,
  TimeQuality,
} from "../../lib/host";
import { LogTimezoneReviewDialog } from "./LogTimezoneReviewDialog";

type Props = {
  state: LogTimezoneStateDto;
  onPreview: (
    request: LogTimezonePreviewRequestDto,
  ) => Promise<LogTimezoneResolutionPreviewDto>;
  onApply: (request: LogTimezoneApplyRequestDto) => Promise<void>;
  onClear: (request: LogTimezoneClearRequestDto) => Promise<void>;
};

function sourceQuality(source: LogTimezoneSourceStatusDto): TimeQuality {
  const wall =
    source.resolvedLocalRecords + source.explicitWallClockRecords > 0;
  const orderOnly =
    source.unresolvedLocalRecords + source.otherOrderOnlyRecords > 0;
  if (wall && orderOnly) return "mixed";
  if (wall) return "wall";
  return "order_only";
}

function confidenceSource(
  source: LogTimezoneSourceStatusDto,
): LogSourceConfidenceDto {
  return {
    source: source.source,
    lines:
      source.unresolvedLocalRecords +
      source.resolvedLocalRecords +
      source.explicitWallClockRecords +
      source.otherOrderOnlyRecords,
    outcome: "matched",
    timeQuality: sourceQuality(source),
    unresolvedReasons:
      source.unresolvedLocalRecords > 0 ? ["no_timezone"] : [],
  };
}

function recordLabel(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "record" : "records"}`;
}

function declarationFor(
  state: LogTimezoneStateDto,
  source: string,
) {
  return Object.hasOwn(state.declarations, source)
    ? state.declarations[source]
    : undefined;
}

export function LogTimezoneStatus({
  state,
  onPreview,
  onApply,
  onClear,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [reviewSourceId, setReviewSourceId] = useState<string | null>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewToggleRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const detailsId = useId();
  const titleId = useId();
  const reviewSources = state.sources.filter(
    (source) =>
      source.unresolvedLocalRecords > 0 ||
      Boolean(declarationFor(state, source.source)),
  );
  const unresolvedRecords = state.sources.reduce(
    (total, source) => total + source.unresolvedLocalRecords,
    0,
  );
  const resolvedRecords = state.sources.reduce(
    (total, source) => total + source.resolvedLocalRecords,
    0,
  );
  const reviewStatus =
    reviewSources.find((source) => source.source === reviewSourceId) ?? null;
  const reviewSource = reviewStatus ? confidenceSource(reviewStatus) : null;

  useEffect(() => {
    if (reviewSourceId && !reviewSource) {
      setReviewSourceId(null);
      queueMicrotask(() => {
        (reviewToggleRef.current ?? sectionRef.current)?.focus();
      });
    }
  }, [reviewSource, reviewSourceId]);

  if (reviewSources.length === 0) return null;

  return (
    <section
      ref={sectionRef}
      className="log-timezone-status"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="log-timezone-status"
    >
      <div className="log-timezone-status__summary">
        <div>
          <span className="eyebrow">Time interpretation</span>
          <strong id={titleId}>Source timezones</strong>
          <span>
            {recordLabel(resolvedRecords)} resolved by saved declarations
            {unresolvedRecords > 0
              ? ` · ${recordLabel(unresolvedRecords)} remain order-only`
              : " · no unresolved local timestamps"}
          </span>
        </div>
        <button
          ref={reviewToggleRef}
          type="button"
          className="btn btn--ghost"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? "Hide time sources"
            : `Review ${reviewSources.length} ${
                reviewSources.length === 1 ? "source" : "sources"
              }`}
        </button>
      </div>

      <p className="log-timezone-status__explanation">
        ContextDesk keeps local timestamps order-only until you explicitly
        declare an IANA timezone. Saved declarations are revision-bound,
        previewed before application, and reversible.
      </p>

      {expanded ? (
        <ul id={detailsId} className="log-timezone-status__sources">
          {reviewSources.map((source) => {
            const declaration = declarationFor(state, source.source);
            return (
              <li key={source.source}>
                <div className="log-timezone-status__source-heading">
                  <strong>{source.source}</strong>
                  <span>{recordLabel(confidenceSource(source).lines)}</span>
                </div>
                <span>
                  {source.explicitWallClockRecords.toLocaleString()} explicit ·{" "}
                  {source.resolvedLocalRecords.toLocaleString()} resolved ·{" "}
                  {source.unresolvedLocalRecords.toLocaleString()} unresolved
                </span>
                <div className="log-timezone-status__source-actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      reviewTriggerRef.current = event.currentTarget;
                      setReviewSourceId(source.source);
                    }}
                  >
                    {declaration ? "Review timezone…" : "Resolve time…"}
                  </button>
                  <span>
                    {declaration
                      ? `${declaration.ianaZone} is active`
                      : "No timezone guessed"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {reviewSource && reviewStatus ? (
        <LogTimezoneReviewDialog
          scope={{
            corpusId: state.corpusId,
            eventRevision: state.eventRevision,
          }}
          source={reviewSource}
          declaration={declarationFor(state, reviewSource.source)}
          triggerRef={reviewTriggerRef}
          fallbackFocusRef={reviewToggleRef}
          onPreview={onPreview}
          onApply={onApply}
          onClear={onClear}
          onDismiss={() => setReviewSourceId(null)}
        />
      ) : null}
    </section>
  );
}
