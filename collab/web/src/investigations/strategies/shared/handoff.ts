export interface HandoffCaseRecord {
  readonly id: string;
  readonly status: string;
  readonly legalHold: boolean;
}

export interface HandoffContributionRecord {
  readonly id: string;
  readonly caseId: string;
  readonly kind: string;
  readonly revision: number;
  readonly body: string | null;
  readonly tombstoned: boolean;
  readonly authorUsername: string;
  readonly createdAt: string;
}

export type HandoffResourceState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly previous?: T }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "failed"; readonly error: string; readonly previous?: T };

export type HandoffResourceView<T> =
  | { readonly availability: "idle" }
  | { readonly availability: "loading" }
  | {
      readonly availability: "available";
      readonly value: T;
      readonly refresh: "settled" | "loading";
    }
  | {
      readonly availability: "available";
      readonly value: T;
      readonly refresh: "failed";
      readonly refreshError: string;
    }
  | { readonly availability: "unavailable"; readonly error: string };

export interface HandoffCreateInput {
  readonly kind: "handoff";
  readonly body: string;
  readonly privacyClass?: "share_safe";
  readonly idempotencyKey: string;
}

export type HandoffCreateResult =
  | { readonly status: "succeeded"; readonly value?: unknown }
  | { readonly status: "failed"; readonly error?: { readonly kind: string } }
  | { readonly status: "ignored"; readonly reason: string };

export type HandoffCreateCommand = (
  input: HandoffCreateInput,
) => Promise<HandoffCreateResult>;

export type HandoffMutationState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "succeeded"; readonly value?: unknown }
  | { readonly status: "failed"; readonly error?: { readonly kind: string } };

export interface HandoffCurrentState {
  readonly status: string;
  readonly legalHold: boolean;
}

export interface HandoffFacts {
  readonly liveHandoffs: readonly HandoffContributionRecord[];
  readonly whatHappened: HandoffContributionRecord | null;
  readonly nextAction: HandoffContributionRecord | null;
  readonly currentState: HandoffCurrentState | null;
}

const WHAT_HAPPENED_KINDS = new Set(["note", "message", "handoff"]);
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;

let fallbackSerial = 0;

function compareNewest(
  left: HandoffContributionRecord,
  right: HandoffContributionRecord,
): number {
  const created = right.createdAt.localeCompare(left.createdAt);
  if (created !== 0) return created;
  if (right.revision !== left.revision) return right.revision - left.revision;
  return right.id.localeCompare(left.id);
}

function liveOf(
  contributions: readonly HandoffContributionRecord[],
  kind: (record: HandoffContributionRecord) => boolean,
): readonly HandoffContributionRecord[] {
  return contributions
    .filter((record) => !record.tombstoned && kind(record))
    .slice()
    .sort(compareNewest);
}

/** Preserve a previously published snapshot during refresh and refresh failure. */
export function selectHandoffResourceView<T>(
  state: HandoffResourceState<T>,
): HandoffResourceView<T> {
  switch (state.status) {
    case "idle":
      return { availability: "idle" };
    case "loading":
      return state.previous === undefined
        ? { availability: "loading" }
        : {
            availability: "available",
            value: state.previous,
            refresh: "loading",
          };
    case "ready":
      return {
        availability: "available",
        value: state.value,
        refresh: "settled",
      };
    case "failed":
      return state.previous === undefined
        ? { availability: "unavailable", error: state.error }
        : {
            availability: "available",
            value: state.previous,
            refresh: "failed",
            refreshError: state.error,
          };
  }
}

/**
 * Project recorded handoff facts without inferring priority, progress, SLA,
 * assignment, owner, or lifecycle.
 */
export function selectHandoffFacts(
  investigation: HandoffCaseRecord | null,
  contributions: readonly HandoffContributionRecord[],
): HandoffFacts {
  const liveHandoffs = liveOf(contributions, (record) => record.kind === "handoff");
  const whatHappened = liveOf(
    contributions,
    (record) => WHAT_HAPPENED_KINDS.has(record.kind),
  )[0] ?? null;
  const nextAction = liveOf(
    contributions,
    (record) => record.kind === "action",
  )[0] ?? null;

  return {
    liveHandoffs,
    whatHappened,
    nextAction,
    currentState: investigation === null
      ? null
      : {
          status: investigation.status,
          legalHold: investigation.legalHold,
        },
  };
}

/** Label opaque note and optional next-action text for a handoff body. */
export function composeHandoffBody(note: string, nextAction?: string): string {
  const noteText = note.trim();
  const actionText = nextAction?.trim() ?? "";
  if (actionText.length === 0) return `Note: ${noteText}`;
  return `Note: ${noteText}\n\nNext action: ${actionText}`;
}

export function recordedHandoffText(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : "Not recorded";
}

function hasRandomUuid(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function";
}

/** Stable caller-generated retry token. The server owns replay semantics. */
export function createHandoffIdempotencyKey(): string {
  fallbackSerial += 1;
  const unique = hasRandomUuid()
    ? crypto.randomUUID()
    : `fallback-${Date.now().toString(16)}-${fallbackSerial.toString(16).padStart(4, "0")}`;
  const key = `handoff-${unique}`.slice(0, 128);
  return IDEMPOTENCY_KEY.test(key) ? key : `handoff${unique.replace(/[^a-z0-9._:-]/gi, "").slice(0, 120)}`;
}
