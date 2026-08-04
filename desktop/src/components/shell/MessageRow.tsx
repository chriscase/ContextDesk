/**
 * Memoized transcript row (#148). Settled rows skip re-render when a neighbor streams.
 */
import {
  memo,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { MarkdownBody } from "../MarkdownBody";
import { ThinkingIndicator } from "../ThinkingIndicator";
import { StreamLiveRegion } from "../StreamLiveRegion";
import { ToolCallList } from "../ToolCallList";
import { SourceCitations } from "../SourceCitations";
import { EvidenceSetPanel } from "../EvidenceSetPanel";
import {
  formatMsgMetaFooter,
  shortSourceLabel,
  type Msg,
} from "../../lib/session";
import {
  hostOpenExternalUrl,
  hostOpenLogExplorer,
  hostOpenLogExplorerTarget,
  hostReadFile,
  hostLogCancelInvestigationEvidencePrepare,
  hostLogCommitInvestigationEvidence,
  hostLogPrepareInvestigationEvidence,
  hostLogQueryEventNeighborhood,
} from "../../lib/host";
import { classifyCompletedCitation } from "../../lib/citations";
import { ActivityCompactLine } from "../activity/ActivityCompactLine";
import type { ActivityMode, ActivityTurn } from "../../lib/activity/types";
import type {
  HostEvidenceCitation,
  InvestigationAddState,
} from "../../lib/evidenceLaneBridge";

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function openExternalUrl(url: string) {
  void hostOpenExternalUrl(url).catch((err) => {
    console.error("open external url failed", err);
  });
}

export type MessageRowProps = {
  msg: Msg;
  turnStartedAt: number | null;
  effectiveChatModel: string | null | undefined;
  setSourcePath: (p: string | null) => void;
  setSourceContent: (c: string) => void;
  setPane: (
    p: "archive" | "source" | "chat" | "memory" | "compose" | "help",
  ) => void;
  /** Open a durable memory citation in the Memory pane. */
  setMemoryPath?: (p: string | null) => void;
  /** Open composition for a memory citation (#293). */
  openCompositionFromMemoryId?: (sourceId: string) => void;
  /** Open a canonical bundled Help citation without treating it as a file. */
  onOpenHelpCitation?: (locator: string) => void;
  /** Open the host-authored original corpus for governed log evidence. */
  onOpenLogCitation?: (sourceId: string, corpusId?: string) => void;
  /** Optional measure hook for virtualization. */
  onHeightChange?: (id: string, height: number) => void;
  /**
   * Activity Inspector (read-only observability — never changes chat
   * behaviour). `activityTurn` is null unless the shared preference is
   * Compact or above; the compact line reuses this row's footer conventions.
   */
  activityMode?: ActivityMode;
  activityTurn?: ActivityTurn | null;
  onOpenActivityDetails?: (turnId: string) => void;
};

function toolsSignature(tools: Msg["tools"]): string {
  if (!tools?.length) return "0";
  return `${tools.length}:${tools.map((t) => `${t.id}:${t.summary}:${t.ok}`).join("|")}`;
}

function citationsSignature(citations: Msg["citations"]): string {
  if (!citations?.length) return "0";
  return citations
    .map(
      (citation) =>
        `${citation.id}:${citation.label}:${citation.title ?? ""}:${
          citation.corpusId ?? ""
        }`,
    )
    .join("|");
}

/** Equality for React.memo — settled rows equal when id/content/stream/tools stable. */
export function messageRowPropsEqual(
  prev: MessageRowProps,
  next: MessageRowProps,
): boolean {
  if (prev.msg.id !== next.msg.id) return false;
  if (prev.msg.role !== next.msg.role) return false;
  if (prev.msg.content !== next.msg.content) return false;
  if (Boolean(prev.msg.streaming) !== Boolean(next.msg.streaming)) return false;
  if (toolsSignature(prev.msg.tools) !== toolsSignature(next.msg.tools)) {
    return false;
  }
  if ((prev.msg.trail?.length ?? 0) !== (next.msg.trail?.length ?? 0)) {
    return false;
  }
  if (
    citationsSignature(prev.msg.citations) !==
    citationsSignature(next.msg.citations)
  ) {
    return false;
  }
  // Meta footer only on settled assistant rows
  if (prev.msg.meta !== next.msg.meta) {
    const a = prev.msg.meta ? formatMsgMetaFooter(prev.msg.meta) : "";
    const b = next.msg.meta ? formatMsgMetaFooter(next.msg.meta) : "";
    if (a !== b) return false;
  }
  if (prev.turnStartedAt !== next.turnStartedAt) return false;
  if (prev.effectiveChatModel !== next.effectiveChatModel) return false;
  if (prev.activityMode !== next.activityMode) return false;
  // Compare the facts the compact line actually renders, not object identity:
  // the adapter rebuilds the turn each render, so identity always differs.
  const activitySig = (t?: ActivityTurn | null) =>
    t
      ? `${t.turnId}:${t.liveRecord}:${t.summary.modelRounds}:${t.summary.toolCalls}:${t.summary.grounded}:${t.summary.status}:${t.citations.length}`
      : "";
  if (activitySig(prev.activityTurn) !== activitySig(next.activityTurn)) {
    return false;
  }
  // setSource* / setPane are stable enough from shell; ignore identity churn
  return true;
}

function MessageRowImpl({
  msg: m,
  turnStartedAt,
  effectiveChatModel,
  setSourcePath,
  setSourceContent,
  setPane,
  setMemoryPath,
  openCompositionFromMemoryId,
  onOpenHelpCitation,
  onOpenLogCitation,
  onHeightChange,
  activityMode = "off",
  activityTurn = null,
  onOpenActivityDetails,
}: MessageRowProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!onHeightChange) return;
    const el = rootRef.current;
    if (!el) return;
    const report = () =>
      onHeightChange(m.id, el.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => report());
    ro.observe(el);
    return () => ro.disconnect();
  }, [m.id, m.content, m.streaming, m.tools, onHeightChange]);

  return (
    <article
      ref={rootRef}
      className="msg"
      data-role={m.role}
      data-msg-id={m.id}
      data-streaming={m.streaming ? "true" : "false"}
    >
      <div className="msg__role">
        {m.role === "user"
          ? "You"
          : m.role === "assistant"
            ? "Assistant"
            : m.role === "system"
              ? "System"
              : m.role}
      </div>
      {m.tools ? <ToolCallList tools={m.tools} /> : null}
      {m.trail?.length ? (
        <details className="message-activity">
          <summary>
            Activity · {m.trail.length} step{m.trail.length === 1 ? "" : "s"}
          </summary>
          <div className="search-trail" aria-label="Search trail">
            {m.trail.map((s) => (
              <span key={s} className="search-trail__step">
                {s}
              </span>
            ))}
          </div>
        </details>
      ) : null}
      {m.citations?.length ? (
        <SourceCitations
          citations={m.citations.map((c) => ({
            id: c.id,
            label: shortSourceLabel(c.label, c.id),
            title: c.title,
            corpusId: c.corpusId,
          }))}
          onOpenFile={(citation) => {
            const path = citation.id;
            const route = classifyCompletedCitation(path);
            if (route === "help") {
              onOpenHelpCitation?.(path);
              return;
            }
            if (route === "log") {
              onOpenLogCitation?.(path, citation.corpusId);
              return;
            }
            // Durable memory citations: `memory:{uuid}` → Compose (ADR 0007)
            if (path.startsWith("memory:")) {
              if (openCompositionFromMemoryId) {
                openCompositionFromMemoryId(path);
              } else {
                setPane("memory");
                setMemoryPath?.(path);
              }
              return;
            }
            if (route === "invalid" || route === "deferred") {
              // Never broaden access for unknown schemes; HTTP is handled above
              // via SourceCitations when external. Deferred non-file chips stay
              // click-only without automatic file I/O.
              if (isHttpUrl(path)) {
                openExternalUrl(path);
                return;
              }
              setSourcePath(path);
              setPane("source");
              setSourceContent(
                "This citation is unsupported or malformed and was not opened.",
              );
              return;
            }
            setSourcePath(path);
            setPane("source");
            setSourceContent("Loading…");
            void hostReadFile(path)
              .then((body) => setSourceContent(body))
              .catch((err) =>
                setSourceContent(
                  `Could not read ${path}:\n${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              );
          }}
        />
      ) : null}
      {m.role === "assistant" && m.citations?.length ? (
        <EvidenceSetPanel
          citations={m.citations.map(
            (c): HostEvidenceCitation => ({
              id: c.id,
              label: shortSourceLabel(c.label, c.id),
              title: c.title,
              corpusId: c.corpusId,
            }),
          )}
          onOpenCitation={(sourceId, corpusId) => {
            const route = classifyCompletedCitation(sourceId);
            if (route === "help") {
              onOpenHelpCitation?.(sourceId);
              return;
            }
            if (route === "log") {
              onOpenLogCitation?.(sourceId, corpusId);
              return;
            }
            if (sourceId.startsWith("memory:")) {
              if (openCompositionFromMemoryId) {
                openCompositionFromMemoryId(sourceId);
              } else {
                setPane("memory");
                setMemoryPath?.(sourceId);
              }
              return;
            }
            if (isHttpUrl(sourceId)) {
              openExternalUrl(sourceId);
              return;
            }
            if (route === "invalid" || route === "deferred") {
              setSourcePath(sourceId);
              setPane("source");
              setSourceContent(
                "This citation is unsupported or malformed and was not opened.",
              );
              return;
            }
            setSourcePath(sourceId);
            setPane("source");
            setSourceContent("Loading…");
            void hostReadFile(sourceId)
              .then((body) => setSourceContent(body))
              .catch((err) =>
                setSourceContent(
                  `Could not read ${sourceId}:\n${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              );
          }}
          onOpenWorkspace={(path) => {
            setSourcePath(path);
            setPane("source");
            setSourceContent("Loading…");
            void hostReadFile(path)
              .then((body) => setSourceContent(body))
              .catch((err) =>
                setSourceContent(
                  `Could not read ${path}:\n${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              );
          }}
          resolveHostEvents={async (need) => {
            const out: {
              corpusId: string;
              seq: number;
              source: string;
              ts: number;
              timeQuality: "wall" | "mixed" | "order_only";
              service?: string | null;
            }[] = [];
            for (const item of need) {
              if (!item.corpusId || item.seq == null) continue;
              const hood = await hostLogQueryEventNeighborhood(item.corpusId, {
                targetSeq: item.seq,
                before: 0,
                after: 0,
              });
              if (hood.status === "missing" || !hood.target) {
                throw new Error(
                  `Event ${item.id} missing or stale in corpus ${item.corpusId}.`,
                );
              }
              const t = hood.target;
              out.push({
                corpusId: item.corpusId,
                seq: t.seq,
                source: t.source,
                ts: t.ts,
                timeQuality: t.timeQuality,
                service: t.service,
              });
            }
            return out;
          }}
          onShowInExplorer={async (plan) => {
            // Open/focus existing corpus only — never reimport or duplicate.
            if (plan.navTarget) {
              await hostOpenLogExplorerTarget(plan.corpusId, plan.navTarget);
            } else {
              await hostOpenLogExplorer(plan.corpusId);
            }
          }}
          onPrepareInvestigation={async (state: InvestigationAddState) => {
            if (
              state.status !== "preview" ||
              !state.corpusId ||
              state.eventRefs.length === 0
            ) {
              throw new Error("Investigation preparation requires a valid preview.");
            }
            const eventRefs = state.eventRefs.map((r) => ({
              corpusId: r.corpusId,
              seq: r.seq,
              source: r.source,
              timestampHint: r.timestampHint,
              timeQualityHint: r.timeQualityHint,
            }));
            return hostLogPrepareInvestigationEvidence(state.corpusId, {
              title: state.title,
              eventRefs,
            });
          }}
          onCommitInvestigation={(token) =>
            hostLogCommitInvestigationEvidence(token).then(() => undefined)
          }
          onCancelPreparedInvestigation={(token) =>
            hostLogCancelInvestigationEvidencePrepare(token).then(() => undefined)
          }
        />
      ) : null}
      <div className="msg__bubble">
        {m.role === "assistant" ? (
          <>
            {m.streaming && !m.content.trim() && turnStartedAt ? (
              <ThinkingIndicator
                startedAt={turnStartedAt}
                model={effectiveChatModel}
                hasTokens={false}
              />
            ) : null}
            {m.content ? (
              <div
                className="msg__content"
                data-streaming={m.streaming ? "true" : "false"}
                onClick={(e: ReactMouseEvent) => {
                  const t = e.target as HTMLElement;
                  const a = t.closest(
                    "a.md-ext-link, a[href^='http']",
                  ) as HTMLAnchorElement | null;
                  if (a?.href && isHttpUrl(a.href)) {
                    e.preventDefault();
                    openExternalUrl(a.href);
                    return;
                  }
                  const citeEl = t.closest("[data-cite]") as HTMLElement | null;
                  const cite = citeEl?.getAttribute("data-cite");
                  if (!cite) return;
                  const route = classifyCompletedCitation(cite);
                  if (route === "help") {
                    onOpenHelpCitation?.(cite);
                    return;
                  }
                  if (route === "log") {
                    const matching =
                      m.citations?.filter(
                        (citation) => citation.id === cite,
                      ) ?? [];
                    onOpenLogCitation?.(
                      cite,
                      matching.length === 1 ? matching[0]?.corpusId : undefined,
                    );
                    return;
                  }
                  if (isHttpUrl(cite)) {
                    openExternalUrl(cite);
                    return;
                  }
                  if (route === "invalid" || route === "deferred") {
                    setSourcePath(cite);
                    setPane("source");
                    setSourceContent(
                      "This citation is unsupported or malformed and was not opened.",
                    );
                    return;
                  }
                  setSourcePath(cite);
                  setPane("source");
                  setSourceContent("Loading…");
                  void hostReadFile(cite)
                    .then((body) => setSourceContent(body))
                    .catch((err) =>
                      setSourceContent(
                        `Could not read ${cite}:\n${
                          err instanceof Error ? err.message : String(err)
                        }`,
                      ),
                    );
                }}
              >
                <MarkdownBody text={m.content} streaming={m.streaming} />
                {(m.streaming || m.content) && (
                  <StreamLiveRegion
                    text={m.content}
                    streaming={Boolean(m.streaming)}
                  />
                )}
              </div>
            ) : null}
            {m.streaming && m.content.trim() && turnStartedAt ? (
              <div className="thinking-ind-wrap">
                <ThinkingIndicator
                  startedAt={turnStartedAt}
                  model={effectiveChatModel}
                  hasTokens
                />
              </div>
            ) : null}
          </>
        ) : (
          <div
            className="msg__content msg__content--user"
            data-streaming={m.streaming ? "true" : "false"}
          >
            {m.content}
          </div>
        )}
      </div>
      {m.role === "assistant" &&
      m.meta &&
      !m.streaming &&
      formatMsgMetaFooter(m.meta) ? (
        <details className="msg__meta-details">
          <summary>Response details</summary>
          <footer className="msg__meta">{formatMsgMetaFooter(m.meta)}</footer>
        </details>
      ) : null}
      {m.role === "assistant" &&
      activityMode !== "off" &&
      activityTurn &&
      (!m.streaming || (activityTurn.developerDetail?.length ?? 0) > 0) ? (
        <ActivityCompactLine
          turn={activityTurn}
          onOpenDetails={() => onOpenActivityDetails?.(m.id)}
        />
      ) : null}
    </article>
  );
}

export const MessageRow = memo(MessageRowImpl, messageRowPropsEqual);
