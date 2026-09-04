import type {
  InvestigationCoordinationAction,
  InvestigationCoordinationRefusal,
  InvestigationCoordinationV1,
  InvestigationLifecycleV1,
  LifecycleAction,
  LifecycleRefusal,
} from "@cd-collab/contracts/investigation-runtime";

export const RUNTIME_PROTOCOL_REASONS = [
  "content_type",
  "json",
  "contract",
  "identity",
] as const;

export type RuntimeProtocolReason = (typeof RUNTIME_PROTOCOL_REASONS)[number];

export type RuntimeInputField = "title" | "file" | "summary" | "idempotencyKey";
export type RuntimeInputReason =
  | "required"
  | "too_large"
  | "unreadable"
  | "intent_mismatch";

/**
 * A deliberately bounded failure vocabulary for presentation consumers.
 *
 * It contains no response, response body, URL, header, thrown error, stack,
 * or unbounded message string. Human-facing copy is selected locally from
 * these discriminants.
 */
export type RuntimeFailure =
  | { kind: "input"; field: RuntimeInputField; reason: RuntimeInputReason }
  | { kind: "auth_lost"; status: 401 | 403 }
  | { kind: "not_found"; status: 404 }
  | { kind: "validation"; status: 400 }
  | {
      kind: "coordination_refused";
      status: 409;
      investigationId: string;
      action: InvestigationCoordinationAction;
      targetIdentityId: string | null;
      reason: InvestigationCoordinationRefusal;
      detail: string;
      current: InvestigationCoordinationV1;
    }
  | {
      kind: "coordination_changed";
      status: 409;
      investigationId: string;
      action: InvestigationCoordinationAction;
      targetIdentityId: string | null;
      current: InvestigationCoordinationV1;
    }
  | {
      kind: "lifecycle_refused";
      status: 409;
      action: LifecycleAction;
      reason: LifecycleRefusal;
      detail: string;
    }
  | {
      kind: "lifecycle_changed";
      status: 409;
      investigationId: string;
      action: LifecycleAction;
      current: InvestigationLifecycleV1;
    }
  | { kind: "conflict"; status: 409 }
  | {
      kind: "unavailable";
      status: 503;
      reason?: "commit_outcome_unknown";
    }
  | { kind: "server_failure"; status: number }
  | { kind: "unexpected_response"; status: number }
  | { kind: "aborted" }
  | { kind: "network" }
  | { kind: "protocol"; reason: RuntimeProtocolReason }
  | { kind: "unexpected" };

/** Known, already-bounded fields parsed before HTTP failure classification. */
export interface KnownLifecycleRefusal {
  kind: "lifecycle_refused";
  action: LifecycleAction;
  reason: LifecycleRefusal;
  detail: string;
}

/** Bounded 503 claim: the mutation may already have committed. */
export interface KnownCommitOutcomeUnknown {
  kind: "commit_outcome_unknown";
}

export type KnownHttpFailure = KnownLifecycleRefusal | KnownCommitOutcomeUnknown;

/**
 * Classify by status before consulting parsed body fields. In particular,
 * authentication loss cannot be disguised by a body that resembles a more
 * local error.
 */
export function classifyHttpFailure(
  status: number,
  known?: KnownHttpFailure,
): RuntimeFailure {
  if (status === 401 || status === 403) {
    return { kind: "auth_lost", status };
  }
  if (status === 400) return { kind: "validation", status };
  if (status === 404) return { kind: "not_found", status };
  if (status === 409) {
    if (known?.kind === "lifecycle_refused") {
      return {
        kind: "lifecycle_refused",
        status,
        action: known.action,
        reason: known.reason,
        detail: known.detail,
      };
    }
    return { kind: "conflict", status };
  }
  if (status === 503) {
    if (known?.kind === "commit_outcome_unknown") {
      return { kind: "unavailable", status, reason: "commit_outcome_unknown" };
    }
    return { kind: "unavailable", status };
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { kind: "server_failure", status };
  }
  return { kind: "unexpected_response", status };
}

/** Create a protocol failure without retaining the rejected payload. */
export function protocolFailure(reason: RuntimeProtocolReason): RuntimeFailure {
  return { kind: "protocol", reason };
}

function exceptionName(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  try {
    if (!("name" in cause)) return undefined;
    return typeof cause.name === "string" ? cause.name : undefined;
  } catch {
    // A thrown value can be a hostile Proxy or expose a throwing getter. Its
    // properties are never trusted or allowed to escape the bounded failure.
    return undefined;
  }
}

function isTypeError(cause: unknown): boolean {
  try {
    return cause instanceof TypeError;
  } catch {
    return false;
  }
}

/**
 * Bound exceptions raised by the request mechanism. Callers pass the signal's
 * already-known aborted flag because not every platform throws DOMException.
 */
export function classifyRequestException(
  cause: unknown,
  aborted = false,
): RuntimeFailure {
  const name = exceptionName(cause);
  if (aborted || name === "AbortError") return { kind: "aborted" };
  if (isTypeError(cause) || name === "NetworkError") {
    return { kind: "network" };
  }
  return { kind: "unexpected" };
}
