import type {
  InvestigationLifecycleV1,
  LifecycleAction,
  LifecycleRefusal,
} from "@cd-collab/contracts";

export const RUNTIME_PROTOCOL_REASONS = [
  "content_type",
  "json",
  "contract",
  "identity",
] as const;

export type RuntimeProtocolReason = (typeof RUNTIME_PROTOCOL_REASONS)[number];

export type RuntimeInputField = "title" | "file" | "summary";
export type RuntimeInputReason = "required" | "too_large" | "unreadable";

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
  | { kind: "unavailable"; status: 503 }
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

export type KnownHttpFailure = KnownLifecycleRefusal;

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
  if (status === 503) return { kind: "unavailable", status };
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
  if (typeof cause !== "object" || cause === null || !("name" in cause)) {
    return undefined;
  }
  return typeof cause.name === "string" ? cause.name : undefined;
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
  if (cause instanceof TypeError || name === "NetworkError") {
    return { kind: "network" };
  }
  return { kind: "unexpected" };
}
