/** Shared chat/session types for the desktop shell (#146). */

import type { ChatMsg } from "../turn";
import type { MessageMetaDto } from "../host";

export type { ChatMsg as Msg };
export type { MessageMetaDto };

export type PaneId =
  | "chat"
  | "archive"
  | "memory"
  | "compose"
  | "source"
  | "todos"
  | "logs"
  | "harvest";

export type ChatSession = {
  id: string;
  title: string;
  messages: ChatMsg[];
  /** How many recent messages stay visible while auto-folded. */
  compactKeepLast: number;
  /**
   * When false (default), long threads auto-fold older turns in the UI.
   * Full `messages` are never deleted — fold is view-only.
   */
  showFullHistory: boolean;
  titleLocked: boolean;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Soft-deleted into trash. */
  trashed: boolean;
  trashedAt: string | null;
  pinned: boolean;
  /** Model for this chat; null uses app default. */
  chatModel: string | null;
  /** Provider profile when model is from a non-default source. */
  providerProfileId: string | null;
  /** Last message id scrolled into view / marked read. */
  lastReadMessageId: string | null;
  /** Pinned skill id for this chat (#343); null = none. */
  pinnedSkillId: string | null;
};

export type UiScale = "90" | "100" | "110";
