import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  hostLogProposeNoiseCandidates,
  type NoiseCandidateDto,
  type NoiseCandidateReasonCode,
  type NoiseCandidateReportDto,
} from "../../lib/host";
import { formatCanonicalUtc } from "../../lib/logExplorer/types";

const MAX_DISMISSALS_PER_CORPUS = 200;

type CandidateDismissal = {
  templateFingerprint: string;
  eventRevision: number;
  suppressionRevision: number;
  templateAnalysisRevision: number;
  reason: string;
  recordedAt: number;
};

const DISMISSAL_REASONS = [
  "Expected but still diagnostically useful",
  "Possible incident signal",
  "Insufficient evidence",
  "Other reviewed reason",
] as const;

const REASON_LABELS: Record<NoiseCandidateReasonCode, string> = {
  high_frequency: "High frequency",
  high_corpus_share: "Material corpus share",
  multi_source_repetition: "Repeated across sources",
  temporally_persistent: "Spans much of the time range",
  level_dominated_info: "Mostly informational",
  level_dominated_warn: "Mostly warnings",
  repetitive_error_risky: "Repetitive errors — risky to hide",
  steady_background: "Steady background",
  already_suppressed: "Already suppressed",
};

function dismissalKey(corpusId: string): string {
  return `contextdesk:noise-candidate-dismissals:${corpusId}`;
}

function loadDismissals(corpusId: string): CandidateDismissal[] {
  try {
    const raw = window.localStorage.getItem(dismissalKey(corpusId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is CandidateDismissal =>
          typeof entry === "object" &&
          entry != null &&
          typeof entry.templateFingerprint === "string" &&
          typeof entry.eventRevision === "number" &&
          typeof entry.suppressionRevision === "number" &&
          typeof entry.templateAnalysisRevision === "number" &&
          typeof entry.reason === "string" &&
          typeof entry.recordedAt === "number",
      )
      .slice(-MAX_DISMISSALS_PER_CORPUS);
  } catch {
    return [];
  }
}

function saveDismissal(
  corpusId: string,
  report: NoiseCandidateReportDto,
  candidate: NoiseCandidateDto,
  reason: string,
): boolean {
  const next = [
    ...loadDismissals(corpusId).filter(
      (entry) =>
        !(
          entry.templateFingerprint === candidate.templateFingerprint &&
          entry.eventRevision === report.eventRevision &&
          entry.suppressionRevision === report.suppressionRevision &&
          entry.templateAnalysisRevision === report.templateAnalysisRevision
        ),
    ),
    {
      templateFingerprint: candidate.templateFingerprint,
      eventRevision: report.eventRevision,
      suppressionRevision: report.suppressionRevision,
      templateAnalysisRevision: report.templateAnalysisRevision,
      reason,
      recordedAt: Math.floor(Date.now() / 1000),
    },
  ].slice(-MAX_DISMISSALS_PER_CORPUS);
  try {
    window.localStorage.setItem(dismissalKey(corpusId), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

function dismissalMatches(
  dismissal: CandidateDismissal,
  report: NoiseCandidateReportDto,
  candidate: NoiseCandidateDto,
): boolean {
  return (
    dismissal.templateFingerprint === candidate.templateFingerprint &&
    dismissal.eventRevision === report.eventRevision &&
    dismissal.suppressionRevision === report.suppressionRevision &&
    dismissal.templateAnalysisRevision === report.templateAnalysisRevision
  );
}

function candidateTimeCoverage(candidate: NoiseCandidateDto): string {
  if (candidate.timeQuality === "wall" && candidate.wallTimeSpan) {
    return `${formatCanonicalUtc(candidate.wallTimeSpan.from)} – ${formatCanonicalUtc(
      candidate.wallTimeSpan.to,
    )}`;
  }
  if (candidate.timeQuality === "order_only" && candidate.orderSpan) {
    return `Order ${candidate.orderSpan.from.toLocaleString()} – ${candidate.orderSpan.to.toLocaleString()}`;
  }
  if (candidate.timeQuality === "mixed") {
    return "Mixed clocks; no shared duration is claimed";
  }
  return "Time coverage unavailable";
}

function candidateShape(candidate: NoiseCandidateDto): string {
  if (candidate.shape === "steady") return "Steady background";
  if (candidate.shape === "bursty") return "Bursty or uneven";
  return "Insufficient reliable time";
}

export function NoiseCandidateReview({
  corpusId,
  currentSuppressionRevision,
  onBack,
  onSuppress,
}: {
  corpusId: string;
  currentSuppressionRevision: number;
  onBack: () => void;
  onSuppress: (
    candidate: NoiseCandidateDto,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  const [state, setState] = useState<
    "loading" | "ready" | "error" | "refreshing"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<NoiseCandidateReportDto | null>(null);
  const [dismissals, setDismissals] = useState<CandidateDismissal[]>(() =>
    loadDismissals(corpusId),
  );
  const [dismissTarget, setDismissTarget] =
    useState<NoiseCandidateDto | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const [dismissalError, setDismissalError] = useState<string | null>(null);
  const [externallyStale, setExternallyStale] = useState(false);
  const titleId = useId();

  const load = useCallback(
    async (refreshing = false) => {
      setState(refreshing ? "refreshing" : "loading");
      setError(null);
      try {
        const next = await hostLogProposeNoiseCandidates(corpusId, {
          maxCandidates: 16,
          maxRepresentatives: 3,
        });
        setReport(next);
        setDismissals(loadDismissals(corpusId));
        setExternallyStale(false);
        setDismissTarget(null);
        setDismissReason("");
        setDismissalError(null);
        setState("ready");
      } catch (loadError) {
        setError(String(loadError));
        setState("error");
      }
    },
    [corpusId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!report) return;
    const verifyFreshness = () => {
      void hostLogProposeNoiseCandidates(corpusId, {
        maxCandidates: 1,
        maxRepresentatives: 1,
      })
        .then((current) => {
          if (
            current.eventRevision !== report.eventRevision ||
            current.suppressionRevision !== report.suppressionRevision ||
            current.templateAnalysisRevision !== report.templateAnalysisRevision
          ) {
            setExternallyStale(true);
          }
        })
        .catch(() => {
          // The existing report remains readable; explicit Refresh exposes errors.
        });
    };
    window.addEventListener("focus", verifyFreshness);
    return () => window.removeEventListener("focus", verifyFreshness);
  }, [corpusId, report]);

  const stale =
    externallyStale ||
    (report != null &&
      report.suppressionRevision !== currentSuppressionRevision);

  const visibleCandidates = useMemo(() => {
    if (!report) return [];
    return report.candidates.filter(
      (candidate) =>
        !dismissals.some((dismissal) =>
          dismissalMatches(dismissal, report, candidate),
        ),
    );
  }, [dismissals, report]);

  const dismissCandidate = () => {
    if (!report || !dismissTarget || !dismissReason) return;
    if (!saveDismissal(corpusId, report, dismissTarget, dismissReason)) {
      setDismissalError(
        "Not noise was not recorded. Local storage is unavailable; try again or keep the suggestion visible.",
      );
      return;
    }
    setDismissalError(null);
    setDismissals(loadDismissals(corpusId));
    setDismissTarget(null);
    setDismissReason("");
  };

  return (
    <section
      className="log-explorer__noise-candidates"
      aria-labelledby={titleId}
      data-testid="noise-candidate-review"
    >
      <header className="log-explorer__noise-candidates-header">
        <div>
          <strong id={titleId}>Review suggestions</strong>
          <span>Ranked corpus facts, never automatic suppression</span>
        </div>
        <button type="button" className="log-explorer__btn" onClick={onBack}>
          Back to policy
        </button>
      </header>

      <p className="log-explorer__noise-candidates-disclaimer">
        Nothing is preselected or auto-suppressed. ERROR/WARN-heavy, bursty,
        rare, and novel evidence is deliberately down-ranked or omitted because
        it may be the incident signal.
      </p>
      {report?.disclaimer ? (
        <p className="log-explorer__noise-candidates-core-disclaimer">
          {report.disclaimer}
        </p>
      ) : null}

      {stale ? (
        <div className="log-explorer__noise-candidates-stale" role="alert">
          <strong>Suggestions are stale.</strong>
          <span>
            Corpus or noise-policy revisions changed. Refresh before dismissing
            or previewing a rule.
          </span>
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() => void load(true)}
          >
            Refresh suggestions
          </button>
        </div>
      ) : null}

      {state === "loading" ? (
        <div className="log-explorer__noise-candidates-state" role="status">
          Reviewing bounded template facts…
        </div>
      ) : state === "error" ? (
        <div className="log-explorer__noise-candidates-state" role="alert">
          <span>Suggestions unavailable: {error}</span>
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() => void load(true)}
          >
            Retry
          </button>
        </div>
      ) : report ? (
        <>
          <div className="log-explorer__noise-candidates-summary" role="status">
            <span>
              Showing {visibleCandidates.length.toLocaleString()} of{" "}
              {report.eligibleCandidateCount.toLocaleString()} eligible
              suggestions
            </span>
            <span>
              {report.unsuppressedEventCount.toLocaleString()} unsuppressed
              events · policy r{report.suppressionRevision}
            </span>
            <button
              type="button"
              className="log-explorer__btn"
              disabled={state === "refreshing"}
              onClick={() => void load(true)}
            >
              {state === "refreshing" ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {report.candidateCapTruncated || report.responseBytesTruncated ? (
            <p className="log-explorer__noise-candidates-limit">
              This is a bounded review. Additional eligible templates were not
              loaded in this pass.
            </p>
          ) : null}
          {report.templateScanTruncated ? (
            <p className="log-explorer__noise-candidates-limit">
              The template scan reached its safety bound; additional templates
              may exist beyond this review.
            </p>
          ) : null}
          {dismissalError ? (
            <div className="log-explorer__noise-policy-error" role="alert">
              {dismissalError}
            </div>
          ) : null}

          <div className="log-explorer__noise-candidate-list">
            {visibleCandidates.length === 0 ? (
              <div className="log-explorer__noise-candidates-state">
                No current suggestions remain for this corpus revision.
              </div>
            ) : (
              visibleCandidates.map((candidate) => (
                <article
                  key={candidate.templateFingerprint}
                  className="log-explorer__noise-candidate"
                >
                  <div className="log-explorer__noise-candidate-heading">
                    <div>
                      <strong>{candidate.pattern}</strong>
                      <span>
                        Template {candidate.templateId} · proposal score{" "}
                        {candidate.score}
                      </span>
                    </div>
                    <span className="log-explorer__noise-candidate-share">
                      {(candidate.corpusShareBps / 100).toFixed(2)}%
                    </span>
                  </div>

                  <dl className="log-explorer__noise-candidate-facts">
                    <div>
                      <dt>Events</dt>
                      <dd>{candidate.eventCount.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Sources</dt>
                      <dd>{candidate.sourceCount.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Shape</dt>
                      <dd>{candidateShape(candidate)}</dd>
                    </div>
                    <div>
                      <dt>Time coverage</dt>
                      <dd>{candidateTimeCoverage(candidate)}</dd>
                    </div>
                  </dl>

                  <div
                    className="log-explorer__noise-candidate-levels"
                    aria-label={`Level distribution for template ${candidate.templateId}`}
                  >
                    {candidate.levelCounts.map((level) => (
                      <span key={level.level}>
                        {level.level || "unset"}{" "}
                        {level.count.toLocaleString()}
                      </span>
                    ))}
                    {candidate.otherLevelCount > 0 ? (
                      <span>
                        Other {candidate.otherLevelCount.toLocaleString()}
                      </span>
                    ) : null}
                  </div>

                  <div className="log-explorer__noise-candidate-reasons">
                    {candidate.reasonCodes.map((reason) => (
                      <span
                        key={reason}
                        data-risk={reason === "repetitive_error_risky"}
                      >
                        {REASON_LABELS[reason]}
                      </span>
                    ))}
                  </div>

                  <p className="log-explorer__noise-candidate-explanation">
                    {candidate.explanation}
                  </p>

                  <div className="log-explorer__noise-candidate-representatives">
                    <strong>Redacted representatives</strong>
                    {candidate.representatives.map((representative) => (
                      <div key={`${representative.seq}:${representative.source}`}>
                        <span>
                          seq {representative.seq} · {representative.source} ·{" "}
                          {representative.level || "unset"}
                        </span>
                        <code>{representative.redactedExcerpt}</code>
                      </div>
                    ))}
                  </div>

                  {dismissTarget?.templateFingerprint ===
                  candidate.templateFingerprint ? (
                    <div className="log-explorer__noise-candidate-dismiss">
                      <label>
                        <span>Why dismiss this proposal?</span>
                        <select
                          value={dismissReason}
                          onChange={(event) =>
                            setDismissReason(event.target.value)
                          }
                        >
                          <option value="">Choose a reviewed reason…</option>
                          {DISMISSAL_REASONS.map((reason) => (
                            <option key={reason} value={reason}>
                              {reason}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div>
                        <button
                          type="button"
                          className="log-explorer__btn"
                          onClick={() => {
                            setDismissTarget(null);
                            setDismissReason("");
                            setDismissalError(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="log-explorer__btn"
                          disabled={!dismissReason || stale}
                          onClick={dismissCandidate}
                        >
                          Record Not noise
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="log-explorer__noise-candidate-actions">
                      <button
                        type="button"
                        className="log-explorer__btn"
                        disabled={stale}
                        onClick={() => {
                          setDismissTarget(candidate);
                          setDismissReason("");
                          setDismissalError(null);
                        }}
                      >
                        Not noise…
                      </button>
                      <button
                        type="button"
                        className="log-explorer__btn log-explorer__btn--active"
                        disabled={stale}
                        onClick={(
                          event: ReactMouseEvent<HTMLButtonElement>,
                        ) => onSuppress(candidate, event.currentTarget)}
                      >
                        Suppress…
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
