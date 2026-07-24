/** Session DTO mapping and pure session helpers (#146). */

import type { ChatSessionDto } from "../host";
import type { ToolCallView } from "../../components/ToolCallList";
import type { ChatMsg } from "../turn";
import type { ChatSession } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newSession(
  title = "Chat",
  chatModel: string | null = null,
): ChatSession {
  const t = nowIso();
  return {
    id: crypto.randomUUID(),
    title,
    messages: [],
    compactKeepLast: 6,
    showFullHistory: false,
    titleLocked: false,
    createdAt: t,
    updatedAt: t,
    archived: false,
    trashed: false,
    trashedAt: null,
    pinned: false,
    chatModel,
    providerProfileId: null,
    lastReadMessageId: null,
    pinnedSkillId: null,
  };
}

export function isPlaceholderTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (!t || t === "chat") return true;
  if (t.startsWith("chat ")) {
    return [...t.slice(5)].every((c) => c >= "0" && c <= "9");
  }
  return false;
}

/** Immediate short heuristic (never dump the full prompt into the tab). */
export function titleFromPrompt(prompt: string, max = 40): string {
  const line =
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const clause = collapsed.search(/[.?!;,](\s|$)/);
  const base =
    clause >= 12 && clause <= Math.max(max, 28)
      ? collapsed.slice(0, clause).replace(/[.?!;,]+$/, "").trim()
      : collapsed;
  if (base.length <= max) return base;
  const slice = base.slice(0, max);
  const sp = slice.lastIndexOf(" ");
  const cut = sp >= 8 ? slice.slice(0, sp) : slice;
  return `${cut.trimEnd()}…`;
}

export function msgFromStored(
  m: ChatSessionDto["messages"][number],
): ChatMsg | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    tools: Array.isArray(m.tools) ? (m.tools as ToolCallView[]) : undefined,
    citations: Array.isArray(m.citations)
      ? (m.citations as { id: string; label: string; title?: string }[])
      : undefined,
    trail: m.trail ?? undefined,
    meta: m.meta ?? undefined,
  };
}

export function sessionFromDto(dto: ChatSessionDto): ChatSession {
  return {
    id: dto.id,
    title: dto.title,
    messages: dto.messages
      .map(msgFromStored)
      .filter((m): m is ChatMsg => m !== null),
    compactKeepLast: dto.compact_keep_last || 6,
    showFullHistory: dto.show_full_history,
    titleLocked: dto.title_locked,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    archived: dto.archived,
    trashed: dto.trashed ?? false,
    trashedAt: dto.trashed_at ?? null,
    pinned: dto.pinned ?? false,
    chatModel: dto.chat_model ?? null,
    providerProfileId: dto.provider_profile_id ?? null,
    lastReadMessageId: dto.last_read_message_id ?? null,
    pinnedSkillId: dto.pinned_skill_id ?? null,
  };
}

export function sessionToDto(s: ChatSession): ChatSessionDto {
  return {
    id: s.id,
    title: s.title,
    messages: s.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tools: m.tools,
      citations: m.citations,
      trail: m.trail,
      meta: m.meta ?? null,
    })),
    compact_keep_last: s.compactKeepLast,
    show_full_history: s.showFullHistory,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    archived: s.archived,
    trashed: s.trashed,
    trashed_at: s.trashedAt,
    pinned: s.pinned,
    title_locked: s.titleLocked,
    chat_model: s.chatModel,
    provider_profile_id: s.providerProfileId,
    last_read_message_id: s.lastReadMessageId,
    pinned_skill_id: s.pinnedSkillId,
  };
}

export function foldPreview(msgs: ChatMsg[], keep: number): string {
  if (msgs.length <= keep) return "";
  return msgs
    .slice(0, -keep)
    .map((m) => {
      const snip = m.content.replace(/\s+/g, " ").trim().slice(0, 100);
      return `• ${m.role}: ${snip}${m.content.length > 100 ? "…" : ""}`;
    })
    .join("\n");
}
