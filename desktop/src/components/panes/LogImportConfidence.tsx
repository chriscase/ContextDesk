import { useEffect, useId, useRef, useState } from "react";
import type {
  LogImportConfidenceDto,
  LogSourceConfidenceDto,
  LogTimezoneApplyRequestDto,
  LogTimezoneClearRequestDto,
  LogTimezoneDeclarationDto,
  LogTimezonePreviewRequestDto,
  LogTimezoneResolutionPreviewDto,
  LogTimezoneScopeDto,
} from "../../lib/host";
import { LogTimezoneReviewDialog } from "./LogTimezoneReviewDialog";

type Props = {
  confidence: LogImportConfidenceDto;
  timezoneScope?: LogTimezoneScopeDto;
  timezoneDeclarations?: Record<string, LogTimezoneDeclarationDto | undefined>;
  timezoneSuggestions?: Record<string, string | undefined>;
  onPreviewTimezone?: (
    request: LogTimezonePreviewRequestDto,
  ) => Promise<LogTimezoneResolutionPreviewDto>;
  onApplyTimezone?: (request: LogTimezoneApplyRequestDto) => Promise<void>;
  onClearTimezone?: (request: LogTimezoneClearRequestDto) => Promise<void>;
};

function sourceTimeLabel(source: LogSourceConfidenceDto): string {
  const unresolvedReasons = source.unresolvedReasons ?? [];
  if (source.timeQuality === "wall") return "Exact wall clock";
  if (
    unresolvedReasons.includes("zone_abbreviation_not_resolved") &&
    unresolvedReasons.includes("no_timezone")
  ) {
    return "No timezone and zone abbreviation not resolved — order-only";
  }
  if (unresolvedReasons.includes("zone_abbreviation_not_resolved")) {
    return "Zone abbreviation not resolved — order-only";
  }
  if (source.timeQuality === "mixed") {
    return "Mixed — some records have no timezone";
  }
  return "No timezone — order-only";
}

function formatLabel(source: LogSourceConfidenceDto): string {
  if (source.outcome === "unknown") {
    return "No grammar matched — kept as raw lines";
  }
  if (source.outcome === "ambiguous") {
    return `Multiple grammars fit${
      source.runnerUpMargin == null ? "" : ` — margin ${source.runnerUpMargin}`
    }`;
  }
  const grammar =
    source.formatId == null
      ? "Grammar matched"
      : `${source.formatId}${
          source.formatVersion == null ? "" : ` v${source.formatVersion}`
        }`;
  return `${grammar}${
    source.runnerUpMargin == null ? "" : ` — margin ${source.runnerUpMargin}`
  }`;
}

function sourceNeedsReview(source: LogSourceConfidenceDto): boolean {
  return source.timeQuality !== "wall" || source.outcome !== "matched";
}

function declarationFor(
  declarations:
    | Record<string, LogTimezoneDeclarationDto | undefined>
    | undefined,
  source: string,
): LogTimezoneDeclarationDto | undefined {
  return declarations && Object.hasOwn(declarations, source)
    ? declarations[source]
    : undefined;
}

export function LogImportConfidence({
  confidence,
  timezoneScope,
  timezoneDeclarations,
  timezoneSuggestions,
  onPreviewTimezone,
  onApplyTimezone,
  onClearTimezone,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [timezoneSourceId, setTimezoneSourceId] = useState<string | null>(null);
  const timezoneTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewToggleRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const detailsId = useId();
  const titleId = useId();
  const reviewSources = confidence.sources.filter(
    (source) =>
      sourceNeedsReview(source) ||
      Boolean(declarationFor(timezoneDeclarations, source.source)),
  );
  const exactSources = confidence.counts.wall;
  const reviewCount = confidence.sources.filter(sourceNeedsReview).length;
  const disclosedSourceCount = reviewSources.length;
  const timeReviewCount = confidence.sources.filter(
    (source) => source.timeQuality !== "wall",
  ).length;
  const formatReviewCount = confidence.sources.filter(
    (source) => source.outcome !== "matched",
  ).length;
  const timezoneReviewAvailable = Boolean(
    timezoneScope && onPreviewTimezone && onApplyTimezone,
  );
  const timezoneSource =
    confidence.sources.find((source) => source.source === timezoneSourceId) ??
    null;

  useEffect(() => {
    if (timezoneSourceId && !timezoneSource) {
      setTimezoneSourceId(null);
      queueMicrotask(() => {
        (reviewToggleRef.current ?? sectionRef.current)?.focus();
      });
    }
  }, [timezoneSource, timezoneSourceId]);

  return (
    <section
      ref={sectionRef}
      className="log-import-confidence"
      aria-labelledby={titleId}
      data-testid="log-import-confidence"
      tabIndex={-1}
    >
      <span className="sr-only" role="status" aria-live="polite">
        Import confidence ready: {exactSources} exact wall-clock{" "}
        {exactSources === 1 ? "source" : "sources"}; {reviewCount}{" "}
        {reviewCount === 1 ? "source needs" : "sources need"} review.
      </span>
      <div className="log-import-confidence__summary">
        <div>
          <span className="eyebrow">Import confidence</span>
          <strong id={titleId}>Time and format review</strong>
          <span>
            {exactSources} exact wall-clock{" "}
            {exactSources === 1 ? "source" : "sources"}
            {reviewCount > 0
              ? ` · ${reviewCount} ${
                  reviewCount === 1 ? "source needs" : "sources need"
                } review`
              : " · all source formats matched"}
          </span>
        </div>
        {disclosedSourceCount > 0 ? (
          <button
            ref={reviewToggleRef}
            type="button"
            className="btn btn--ghost"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? "Hide source review"
              : `Review ${disclosedSourceCount} ${
                  disclosedSourceCount === 1 ? "source" : "sources"
                }`}
          </button>
        ) : null}
      </div>

      {timeReviewCount > 0 ? (
        <p className="log-import-confidence__explanation">
          These records remain searchable, but exact alignment and metric
          correlation stay unavailable until their local time is resolved.
          ContextDesk did not guess a timezone.
        </p>
      ) : formatReviewCount > 0 ? (
        <p className="log-import-confidence__explanation">
          Every source has an exact wall clock. Some record grammars need
          review; their lines were retained without inventing a format.
        </p>
      ) : (
        <p className="log-import-confidence__explanation">
          Every imported source has an exact wall clock and a matched grammar.
        </p>
      )}

      {expanded ? (
        <ul id={detailsId} className="log-import-confidence__sources">
          {reviewSources.map((source) => (
            <li key={source.source}>
              <div className="log-import-confidence__source-heading">
                <strong>{source.source}</strong>
                <span>
                  {source.lines.toLocaleString()}{" "}
                  {source.lines === 1 ? "record" : "records"}
                </span>
              </div>
              <span>{sourceTimeLabel(source)}</span>
              <span>{formatLabel(source)}</span>
              {source.producerHint ? (
                <span>
                  Family hint: {source.producerHint.replaceAll("-", " ")} (not
                  verified)
                </span>
              ) : null}
              {(source.timestampPrefixSamples?.length ?? 0) > 0 ? (
                <pre
                  tabIndex={0}
                  aria-label={`Timestamp examples for ${source.source}`}
                >
                  {source.timestampPrefixSamples?.join("\n")}
                </pre>
              ) : null}
              {timezoneReviewAvailable &&
              (source.timeQuality !== "wall" ||
                declarationFor(timezoneDeclarations, source.source)) ? (
                <div className="log-import-confidence__source-actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      timezoneTriggerRef.current = event.currentTarget;
                      setTimezoneSourceId(source.source);
                    }}
                  >
                    {declarationFor(timezoneDeclarations, source.source)
                      ? "Review timezone…"
                      : "Resolve time…"}
                  </button>
                  <span>
                    {declarationFor(timezoneDeclarations, source.source)
                      ? `${declarationFor(timezoneDeclarations, source.source)?.ianaZone} is active`
                      : "Defaults to order-only"}
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {timezoneSource &&
      timezoneScope &&
      onPreviewTimezone &&
      onApplyTimezone ? (
        <LogTimezoneReviewDialog
          scope={timezoneScope}
          source={timezoneSource}
          declaration={declarationFor(
            timezoneDeclarations,
            timezoneSource.source,
          )}
          suggestedZone={timezoneSuggestions?.[timezoneSource.source]}
          triggerRef={timezoneTriggerRef}
          fallbackFocusRef={reviewToggleRef}
          onPreview={onPreviewTimezone}
          onApply={onApplyTimezone}
          onClear={onClearTimezone}
          onDismiss={() => setTimezoneSourceId(null)}
        />
      ) : null}
    </section>
  );
}
