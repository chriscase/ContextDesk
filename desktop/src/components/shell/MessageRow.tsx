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
import {
  formatMsgMetaFooter,
  shortSourceLabel,
  type Msg,
} from "../../lib/session";
import { hostOpenExternalUrl, hostReadFile } from "../../lib/host";

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
  setPane: (p: "archive" | "source" | "chat") => void;
  /** Optional measure hook for virtualization. */
  onHeightChange?: (id: string, height: number) => void;
};

function toolsSignature(tools: Msg["tools"]): string {
  if (!tools?.length) return "0";
  return `${tools.length}:${tools.map((t) => `${t.id}:${t.summary}:${t.ok}`).join("|")}`;
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
  if ((prev.msg.citations?.length ?? 0) !== (next.msg.citations?.length ?? 0)) {
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
  onHeightChange,
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
      <div className="msg__role">{m.role}</div>
      {m.tools ? <ToolCallList tools={m.tools} /> : null}
      {m.trail?.length ? (
        <div className="search-trail" aria-label="Search trail">
          {m.trail.map((s) => (
            <span key={s} className="search-trail__step">
              {s}
            </span>
          ))}
        </div>
      ) : null}
      {m.citations?.length ? (
        <SourceCitations
          citations={m.citations.map((c) => ({
            id: c.id,
            label: shortSourceLabel(c.label, c.id),
            title: c.title,
          }))}
          onOpenFile={(path) => {
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
                  if (isHttpUrl(cite)) {
                    openExternalUrl(cite);
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
        <footer
          className="msg__meta"
          title={[
            m.meta.model,
            m.meta.provider_label,
            m.meta.provider_id,
            m.meta.base_url,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          {formatMsgMetaFooter(m.meta)}
        </footer>
      ) : null}
    </article>
  );
}

export const MessageRow = memo(MessageRowImpl, messageRowPropsEqual);
