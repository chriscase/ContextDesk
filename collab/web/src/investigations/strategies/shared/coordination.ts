export type CoordinationAction =
  | "claim_self"
  | "release_self"
  | "assign_participant"
  | "release_participant";

export interface CoordinationIdentityRecord {
  readonly identityId: string;
  readonly username: string;
}

export interface CoordinationRecord {
  readonly investigationId: string;
  readonly coordinator: CoordinationIdentityRecord | null;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedBy: CoordinationIdentityRecord | null;
  readonly archived: boolean;
}

export interface CoordinationParticipantHint {
  readonly identityId: string;
  readonly username: string;
}

export type CoordinationReadError = "denied" | "not_found" | "unavailable";

export type CoordinationResourceState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly previous?: CoordinationRecord }
  | { readonly status: "ready"; readonly value: CoordinationRecord }
  | {
      readonly status: "failed";
      readonly error: CoordinationReadError;
      readonly previous?: CoordinationRecord;
    };

export type CoordinationResourceView =
  | { readonly availability: "idle" }
  | { readonly availability: "loading" }
  | {
      readonly availability: "available";
      readonly value: CoordinationRecord;
      readonly refresh: "settled" | "loading";
    }
  | {
      readonly availability: "available";
      readonly value: CoordinationRecord;
      readonly refresh: "failed";
      readonly refreshError: CoordinationReadError;
    }
  | { readonly availability: "unavailable"; readonly error: CoordinationReadError };

export type CoordinationFailureKind =
  | "outcome_unknown"
  | "changed"
  | "refused"
  | "validation"
  | "auth_lost"
  | "not_found"
  | "definitive";

export type CoordinationMutationState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: CoordinationFailureKind };

export type CoordinationActionInput =
  | {
      readonly action: "claim_self" | "release_self";
      readonly targetIdentityId?: never;
      readonly idempotencyKey: string;
    }
  | {
      readonly action: "assign_participant" | "release_participant";
      readonly targetIdentityId: string;
      readonly idempotencyKey: string;
    };

export type CoordinationActionResult =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: CoordinationFailureKind }
  | { readonly status: "ignored"; readonly reason: "busy" | "stale" | "not_ready" };

export type CoordinationActionCommand = (
  input: CoordinationActionInput,
) => Promise<CoordinationActionResult>;

/** Preserve the last confirmed projection while its refresh is unsettled. */
export function selectCoordinationResourceView(
  state: CoordinationResourceState,
): CoordinationResourceView {
  switch (state.status) {
    case "idle":
      return { availability: "idle" };
    case "loading":
      return state.previous === undefined
        ? { availability: "loading" }
        : { availability: "available", value: state.previous, refresh: "loading" };
    case "ready":
      return { availability: "available", value: state.value, refresh: "settled" };
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

const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
let fallbackSerial = 0;

/** Create a caller-owned retry key without attaching transport concerns. */
export function createCoordinationIdempotencyKey(): string {
  fallbackSerial += 1;
  const unique = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `fallback-${Date.now().toString(16)}-${fallbackSerial.toString(16).padStart(4, "0")}`;
  const key = `coordination-${unique}`.slice(0, 128);
  return IDEMPOTENCY_KEY.test(key)
    ? key
    : `coordination${unique.replace(/[^a-z0-9._:-]/gi, "").slice(0, 116)}`;
}
