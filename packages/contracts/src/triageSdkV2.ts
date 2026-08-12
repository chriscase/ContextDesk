/** Strict mirror of Rust-owned ContextDesk triage SDK v2 golden contracts. */
import { ContractViolation, checkObject, f } from "./parse";

export const TRIAGE_REQUEST_SCHEMA_V2 = "contextdesk.triage.request.v2" as const;
export const TRIAGE_RUN_EVENT_SCHEMA_V2 =
  "contextdesk.triage.run_event.v2" as const;
export const TRIAGE_RESULT_SCHEMA_V2 = "contextdesk.triage.result.v2" as const;
export const TRIAGE_REPLAY_SCHEMA_V1 = "contextdesk.triage.replay.v1" as const;
export const TRIAGE_CANCELLATION_SCHEMA_V1 =
  "contextdesk.triage.cancellation.v1" as const;
export const COMPILED_TRIAGE_POLICY_SCHEMA_V2 =
  "contextdesk.triage_policy.compiled.v2" as const;

export type TriageRequestV2 = Record<string, unknown> & {
  schema_id: typeof TRIAGE_REQUEST_SCHEMA_V2;
  run_id: string;
  privacy: "owner_only";
  task: string;
  cancellation_id: string;
};

export type TriageRunEventV2 = Record<string, unknown> & {
  schema_id: typeof TRIAGE_RUN_EVENT_SCHEMA_V2;
  run_id: string;
  sequence: number;
  event: Record<string, unknown> & { kind: string };
};

export type TriageReplayV1 = Record<string, unknown> & {
  schema_id: typeof TRIAGE_REPLAY_SCHEMA_V1;
  run_id: string;
  request_fingerprint: string;
  events: TriageRunEventV2[];
};

export type TriageCancellationV1 = {
  schema_id: typeof TRIAGE_CANCELLATION_SCHEMA_V1;
  run_id: string;
  cancellation_id: string;
};

export type CompiledTriagePolicyV2 = Record<string, unknown> & {
  schema_id: typeof COMPILED_TRIAGE_POLICY_SCHEMA_V2;
  mode: "standard" | "enhanced" | "advanced";
  slots: Record<string, unknown>[];
};

const modelRef = f.obj({
  profile_id: f.req(f.str),
  model_id: f.req(f.str),
});

const reconciliation = f.obj({
  state: f.req(f.str),
  configured_role_slots: f.req(f.u64),
  completed_role_slots: f.req(f.u64),
  distinct_models: f.req(f.u64),
  distinct_gateways: f.req(f.u64),
  supported_claim_ids: f.opt(f.arr(f.str)),
  conflict_ids: f.opt(f.arr(f.str)),
  gap_ids: f.opt(f.arr(f.str)),
  root_cause_established: f.req(f.bool),
});

const triageSlotKind = f.pred("typed triage slot kind", (value) => {
  if (value === "finalizer" || value === "reviewer") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "contributor") return false;
  return [
    "observation_extractor",
    "timeline_analyst",
    "causal_proposer",
    "contradiction_checker",
    "evidence_gap_finder",
  ].includes((value as Record<string, unknown>).contributor as string);
});

const rejectionCategory = f.en(
  "schema_mismatch",
  "invalid_slot_id",
  "duplicate_slot_id",
  "invalid_model_ref",
  "standard_mode_expanded",
  "standard_finalizer_required",
  "empty_policy",
  "invalid_budget",
  "role_unavailable",
  "qualification_unavailable",
  "egress_denied",
  "unknown_preflight_slot",
  "duplicate_preflight_slot",
  "preflight_binding_mismatch",
  "provider_call_budget_insufficient",
);

const contributorBudget = f.obj({
  max_provider_calls: f.req(f.u64),
  operation_timeout_ms: f.req(f.u64),
  max_context_chars: f.req(f.u64),
});

const correctionBudget = f.obj({
  max_per_stage: f.req(f.u64),
  max_provider_calls: f.req(f.u64),
  operation_timeout_ms: f.req(f.u64),
  max_context_chars: f.req(f.u64),
});

const terminalBudget = f.obj({
  max_provider_calls: f.req(f.u64),
  reserve_ms: f.req(f.u64),
  operation_timeout_ms: f.req(f.u64),
  max_context_chars: f.req(f.u64),
});

const triageBudget = f.obj({
  whole_turn_deadline_ms: f.nul(f.u64),
  max_provider_calls: f.req(f.u64),
  max_context_chars: f.req(f.u64),
  contributors: f.req(contributorBudget),
  corrections: f.req(correctionBudget),
  finalizer: f.req(terminalBudget),
  reviewer: f.req(terminalBudget),
});

function objectValue(path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ContractViolation(path, "expected object");
  return value as Record<string, unknown>;
}

function checkPolicy(path: string, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ContractViolation(path, "expected policy object");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "standard") {
    checkObject(path, { kind: f.req(f.en("standard")), model: f.req(modelRef) }, value);
  } else if (kind === "saved") {
    checkObject(
      path,
      {
        kind: f.req(f.en("saved")),
        policy_id: f.req(f.str),
        policy_revision: f.req(f.u64),
      },
      value,
    );
  } else if (kind === "inline") {
    checkObject(
      path,
      {
        kind: f.req(f.en("inline")),
        schema_id: f.req(f.str),
        document: f.req(f.json),
      },
      value,
    );
  } else {
    throw new ContractViolation(`${path}.kind`, "unknown policy kind");
  }
}

export function parseTriageRequestV2(value: unknown): TriageRequestV2 {
  checkObject(
    "request",
    {
      schema_id: f.req(f.en(TRIAGE_REQUEST_SCHEMA_V2)),
      run_id: f.req(f.str),
      privacy: f.req(f.en("owner_only")),
      task: f.req(f.str),
      scope: f.req(
        f.obj({
          corpus_id: f.req(f.str),
          corpus_revision: f.opt(f.u64),
          source_ids: f.opt(f.arr(f.str)),
        }),
      ),
      policy: f.req(f.pred("triage policy", (candidate) => {
        try {
          checkPolicy("request.policy", candidate);
          return true;
        } catch {
          return false;
        }
      })),
      overrides: f.req(
        f.obj({
          deadline_ms: f.opt(f.u64),
          max_provider_calls: f.opt(f.u64),
        }),
      ),
      cancellation_id: f.req(f.str),
    },
    value,
  );
  return value as TriageRequestV2;
}

export function parseTriageCancellationV1(value: unknown): TriageCancellationV1 {
  checkObject(
    "cancellation",
    {
      schema_id: f.req(f.en(TRIAGE_CANCELLATION_SCHEMA_V1)),
      run_id: f.req(f.str),
      cancellation_id: f.req(f.str),
    },
    value,
  );
  return value as TriageCancellationV1;
}

export function parseCompiledTriagePolicyV2(
  value: unknown,
): CompiledTriagePolicyV2 {
  const slot = f.obj({
    slot_id: f.req(f.str),
    kind: f.req(triageSlotKind),
    model: f.req(modelRef),
    requirement: f.req(f.en("required", "optional")),
    disposition: f.req(
      f.en("admitted", "optional_degraded", "required_rejected"),
    ),
    rejections: f.req(f.arr(rejectionCategory)),
  });
  checkObject(
    "compiled_policy",
    {
      schema_id: f.req(f.en(COMPILED_TRIAGE_POLICY_SCHEMA_V2)),
      mode: f.req(f.en("standard", "enhanced", "advanced")),
      slots: f.req(f.arr(slot)),
      independence_groups: f.req(
        f.arr(
          f.obj({
            model: f.req(modelRef),
            slot_ids: f.req(f.arr(f.str)),
          }),
        ),
      ),
      independence_counts: f.req(
        f.obj({
          role_slots: f.req(f.u64),
          distinct_model_refs: f.req(f.u64),
          distinct_model_ids: f.req(f.u64),
          distinct_gateways: f.req(f.u64),
        }),
      ),
      budget: f.req(triageBudget),
      execution: f.req(f.en("sequential")),
    },
    value,
  );
  return value as CompiledTriagePolicyV2;
}

function checkAttempt(path: string, value: unknown): void {
  checkObject(
    path,
    {
      attempt_id: f.req(f.str),
      role_slot_id: f.req(f.str),
      role: f.req(triageSlotKind),
      model: f.opt(modelRef),
      status: f.req(
        f.en(
          "completed",
          "abstained",
          "invalid",
          "unavailable",
          "timed_out",
          "cancelled",
          "failed",
          "not_admitted",
        ),
      ),
      reason_codes: f.opt(f.arr(f.str)),
      elapsed_ms: f.req(f.u64),
      input_chars: f.req(f.u64),
      output_chars: f.req(f.u64),
    },
    value,
  );
}

function checkResult(path: string, value: unknown): void {
  checkObject(
    path,
    {
      schema_id: f.req(f.en(TRIAGE_RESULT_SCHEMA_V2)),
      run_id: f.req(f.str),
      kind: f.req(f.en("grounded_final", "honest_partial")),
      validation_state: f.req(f.en("passed", "partial", "failed")),
      packet_id: f.req(f.str),
      reconciliation: f.req(reconciliation),
      answer: f.opt(f.json),
      accepted_evidence_ids: f.opt(f.arr(f.str)),
      reason_codes: f.opt(f.arr(f.str)),
    },
    value,
  );
}

export function parseTriageRunEventV2(value: unknown): TriageRunEventV2 {
  checkObject(
    "event",
    {
      schema_id: f.req(f.en(TRIAGE_RUN_EVENT_SCHEMA_V2)),
      run_id: f.req(f.str),
      sequence: f.req(f.u64),
      privacy: f.req(f.en("share_safe", "owner_only")),
      event: f.req(f.json),
    },
    value,
  );
  const outer = value as TriageRunEventV2;
  const payload = objectValue("event.event", outer.event);
  switch (payload.kind) {
    case "run_started":
      checkObject("event.event", {
        kind: f.req(f.en("run_started")),
        request_fingerprint: f.req(f.str),
        policy_fingerprint: f.req(f.str),
      }, payload);
      break;
    case "packet_ready":
      checkObject("event.event", {
        kind: f.req(f.en("packet_ready")),
        packet_id: f.req(f.str),
        packet_digest: f.req(f.str),
        evidence_count: f.req(f.u64),
      }, payload);
      break;
    case "role_attempt":
      checkObject("event.event", {
        kind: f.req(f.en("role_attempt")),
        attempt: f.req(f.pred("role attempt", (candidate) => {
          try { checkAttempt("event.event.attempt", candidate); return true; } catch { return false; }
        })),
      }, payload);
      break;
    case "reconciliation":
      checkObject("event.event", {
        kind: f.req(f.en("reconciliation")),
        summary: f.req(reconciliation),
      }, payload);
      break;
    case "validation":
      checkObject("event.event", {
        kind: f.req(f.en("validation")),
        passed: f.req(f.bool),
        reason_codes: f.opt(f.arr(f.str)),
      }, payload);
      break;
    case "completed":
      checkObject("event.event", {
        kind: f.req(f.en("completed")),
        result: f.req(f.pred("triage result", (candidate) => {
          try { checkResult("event.event.result", candidate); return true; } catch { return false; }
        })),
      }, payload);
      break;
    case "failed":
      checkObject("event.event", {
        kind: f.req(f.en("failed")),
        category: f.req(f.str),
        partial_result: f.opt(f.pred("triage result", (candidate) => {
          try { checkResult("event.event.partial_result", candidate); return true; } catch { return false; }
        })),
      }, payload);
      break;
    case "timed_out":
      checkObject("event.event", {
        kind: f.req(f.en("timed_out")),
        category: f.req(f.str),
        partial_result: f.opt(f.pred("triage result", (candidate) => {
          try { checkResult("event.event.partial_result", candidate); return true; } catch { return false; }
        })),
      }, payload);
      break;
    case "cancelled":
      checkObject("event.event", {
        kind: f.req(f.en("cancelled")),
        cancellation_id: f.req(f.str),
        partial_result: f.opt(f.pred("triage result", (candidate) => {
          try { checkResult("event.event.partial_result", candidate); return true; } catch { return false; }
        })),
      }, payload);
      break;
    default:
      throw new ContractViolation("event.event.kind", "unknown event kind");
  }
  if (payload.kind === "completed") {
    const result = payload.result as Record<string, unknown>;
    if (result.run_id !== outer.run_id)
      throw new ContractViolation("event.event.result.run_id", "run identity mismatch");
  }
  if (["failed", "timed_out", "cancelled"].includes(payload.kind as string)) {
    const partial = payload.partial_result as Record<string, unknown> | undefined;
    if (partial !== undefined) {
      if (partial.run_id !== outer.run_id)
        throw new ContractViolation(
          "event.event.partial_result.run_id",
          "run identity mismatch",
        );
      if (partial.kind !== "honest_partial")
        throw new ContractViolation(
          "event.event.partial_result.kind",
          "terminal fallback must be honest_partial",
        );
    }
  }
  if (outer.privacy === "share_safe") {
    if (payload.kind === "completed" || payload.partial_result !== undefined)
      throw new ContractViolation(
        "event.privacy",
        "owner-only terminal content declared share_safe",
      );
    if (
      payload.kind === "role_attempt" &&
      (payload.attempt as Record<string, unknown>).model !== undefined
    )
      throw new ContractViolation(
        "event.privacy",
        "exact model identity declared share_safe",
      );
  }
  return outer;
}

export function parseTriageReplayV1(value: unknown): TriageReplayV1 {
  checkObject(
    "replay",
    {
      schema_id: f.req(f.en(TRIAGE_REPLAY_SCHEMA_V1)),
      run_id: f.req(f.str),
      request_fingerprint: f.req(f.str),
      events: f.req(f.arr(f.json)),
    },
    value,
  );
  const replay = value as TriageReplayV1;
  const events = replay.events.map(parseTriageRunEventV2);
  const first = events[0];
  if (
    first?.event.kind !== "run_started" ||
    first.event.request_fingerprint !== replay.request_fingerprint
  )
    throw new ContractViolation(
      "replay.request_fingerprint",
      "first run_started fingerprint mismatch",
    );
  let terminals = 0;
  events.forEach((event, index) => {
    if (event.run_id !== replay.run_id)
      throw new ContractViolation(`replay.events[${index}].run_id`, "run identity mismatch");
    if (event.sequence !== index)
      throw new ContractViolation(`replay.events[${index}].sequence`, "non-contiguous sequence");
    const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(
      event.event.kind,
    );
    if (terminal) {
      terminals += 1;
      if (index + 1 !== events.length)
        throw new ContractViolation(`replay.events[${index}]`, "event after terminal");
    }
  });
  if (terminals !== 1)
    throw new ContractViolation("replay.events", "expected exactly one terminal event");
  return { ...replay, events };
}
