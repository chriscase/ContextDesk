/** Pure turn-event fold used by the chat UI (extracted for unit tests). */

import type { PermissionPrompt } from "../components/PermissionModal";
import type { ToolCallView } from "../components/ToolCallList";
import type { EventDto, MessageMetaDto } from "./host";

/** In-UI chat message shape (subset persisted to sessions). */
export type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolCallView[];
  /** id = url/path, label = short source, title = article/page title */
  citations?: { id: string; label: string; title?: string }[];
  trail?: string[];
  streaming?: boolean;
  meta?: MessageMetaDto;
};

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Short publisher / host for chips (never the full Google News URL). */
export function shortSourceLabel(label: string, id: string): string {
  const raw = (label || id || "source").trim();
  if (!isHttpUrl(raw) && raw.length <= 48 && !raw.includes("://")) {
    // "Headline - Al Jazeera"
    const dash = raw.lastIndexOf(" - ");
    if (dash > 8 && raw.length - dash - 3 <= 40) {
      return raw.slice(dash + 3).trim();
    }
    return raw;
  }
  const url = isHttpUrl(raw) ? raw : id;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("news.google.")) return "Google News";
    if (host.includes("duckduckgo.com")) return "DuckDuckGo";
    if (host.endsWith("wikipedia.org")) return "Wikipedia";
    return host;
  } catch {
    return raw.length > 40 ? `${raw.slice(0, 36)}…` : raw || "source";
  }
}

/**
 * Fold a batch of stream events into a message + optional permission prompt.
 * Pure: no host I/O.
 */
export function applyEventsToMessage(
  base: ChatMsg,
  events: EventDto[],
): { msg: ChatMsg; permission: PermissionPrompt | null } {
  let content = base.content;
  const tools: ToolCallView[] = [...(base.tools ?? [])];
  const citations: { id: string; label: string; title?: string }[] = [
    ...(base.citations ?? []),
  ];
  const trail: string[] = [...(base.trail ?? [])];
  let permission: PermissionPrompt | null = null;
  let meta: MessageMetaDto | undefined = base.meta
    ? { ...base.meta }
    : undefined;

  for (const ev of events) {
    const p = ev.payload;
    switch (ev.kind) {
      case "turn_started": {
        // Host-fact model from StreamEvent::TurnStarted (#155 / #90).
        const hostModel = p.model != null ? String(p.model).trim() : "";
        if (hostModel) {
          meta = {
            ...(meta ?? {}),
            model: hostModel,
            host_confirmed: true,
          };
        }
        break;
      }
      case "text_delta":
        content += String(p.text ?? "");
        break;
      case "tool": {
        const id = String(p.id ?? crypto.randomUUID());
        const existing = tools.find((t) => t.id === id);
        if (existing) {
          existing.summary = String(p.summary ?? existing.summary);
          if (p.detail) existing.detail = String(p.detail);
          if (p.ok !== undefined && p.ok !== null) existing.ok = Boolean(p.ok);
        } else {
          tools.push({
            id,
            name: String(p.name ?? "tool"),
            summary: String(p.summary ?? ""),
            detail: p.detail ? String(p.detail) : undefined,
            ok: p.ok === undefined || p.ok === null ? undefined : Boolean(p.ok),
          });
        }
        break;
      }
      case "citation": {
        const id = String(p.source_id ?? p.label ?? "");
        let label = String(p.label ?? p.source_id ?? "source");
        // Never show raw mega-URLs as the chip name.
        if (/^https?:\/\//i.test(label) || label.length > 48) {
          label = shortSourceLabel(label, id);
        }
        const titleRaw = p.locator != null ? String(p.locator) : "";
        const title =
          titleRaw && titleRaw !== id && titleRaw !== label
            ? titleRaw
            : undefined;
        if (id && !citations.some((c) => c.id === id)) {
          citations.push({ id, label, title });
        }
        break;
      }
      case "search_trail": {
        const steps = p.steps;
        if (Array.isArray(steps)) {
          for (const s of steps) {
            const step = String(s);
            if (step && !trail.includes(step)) trail.push(step);
          }
        }
        break;
      }
      case "permission_required":
        permission = {
          requestId: String(p.request_id ?? ""),
          toolName: String(p.tool_name ?? ""),
          target: String(p.target ?? ""),
          reason: String(p.reason ?? ""),
          preview: String(p.preview ?? ""),
          risk: String(p.risk ?? "local"),
          typeConfirmPhrase:
            p.risk === "remote" || p.risk === "destructive" ? "WRITE" : null,
        };
        break;
      case "error":
        content += `\n\n**Error:** ${String(p.message ?? "unknown")}\n`;
        break;
      default:
        break;
    }
  }

  return {
    msg: {
      ...base,
      content,
      tools: tools.length ? tools : undefined,
      citations: citations.length ? citations : undefined,
      trail: trail.length ? trail : undefined,
      streaming: false,
      meta,
    },
    permission,
  };
}

/**
 * After Stop, still process finalizing events so the bubble is not left
 * `streaming: true` forever (#249 / original #105 AC#3).
 * Host cancel ownership: #90 / #109; this only gates UI event drop.
 */
export function shouldProcessEventWhileStopped(
  stopped: boolean,
  kind: string,
): boolean {
  if (!stopped) return true;
  return kind === "turn_completed" || kind === "error";
}

/**
 * Finalize in-flight assistant bubbles after Stop: clear streaming, keep
 * partial text, drop empty assistant shells.
 */
export function finalizeMessagesAfterStop<
  T extends {
    role: string;
    content?: string;
    streaming?: boolean;
    tools?: unknown[];
    citations?: unknown[];
  },
>(messages: T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.streaming) {
      out.push(m);
      continue;
    }
    const text = (m.content ?? "").trim();
    const hasTools = Boolean(m.tools && m.tools.length > 0);
    const hasCite = Boolean(m.citations && m.citations.length > 0);
    if (!text && !hasTools && !hasCite) {
      // Empty cancelled shell — remove rather than leave a blank bubble.
      continue;
    }
    out.push({ ...m, streaming: false });
  }
  return out;
}

/** True if any message is still mid-stream (adversarial post-Stop check). */
export function anyMessageStreaming(
  messages: { streaming?: boolean }[],
): boolean {
  return messages.some((m) => m.streaming === true);
}
