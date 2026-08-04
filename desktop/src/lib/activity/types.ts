/**
 * Activity Inspector — the ONE renderer-side activity model.
 *
 * This module replaces two earlier, incompatible drafts: a log/import-lane
 * `ActivityEvent` (classification + wall-clock `atMs`) and a main-chat-lane
 * `ActivityTurn` (context/budget/rounds with a `source: "live" | "fixture"`
 * field on every value). Both are folded into the shape below, which mirrors
 * `crates/cd-core/src/activity.rs` — the source-agnostic contract the host
 * actually emits — so the UI and the backend cannot drift apart.
 *
 * Three properties this file exists to enforce:
 *
 * 1. **App activity is not customer evidence.** Every event carries
 *    `laneGroup: "contextdesk"`, and there is no constructor that produces
 *    anything else. Customer log events are `ExplorerEventDto`s in an
 *    entirely separate family, reached through corpus/source/filter state.
 *    Nothing here can enter the corpus, the source facets, search or filter
 *    results, the suppression policy, or grounded citations, because none of
 *    those read this type. See `laneGroup` below.
 * 2. **Time is never invented.** An event's position is an
 *    [`ActivityClock`], a union whose variants are honest about what is
 *    known: real calendar time, elapsed-since-start, or bare ordering. A
 *    sequence-only event has no `atMs` field to render as a date, so the
 *    dual-lane view cannot fabricate one by accident.
 * 3. **A heuristic cannot claim to be deterministic.** `determinism` is
 *    derived from `origin` by [`determinismForOrigin`], a total function
 *    mirroring the Rust one — not a field a caller fills in.
 *
 * There is deliberately no `source: "fixture"` field. Fixtures are for tests
 * and stories only (`fixtures.ts`); production renders live facts or renders
 * nothing. A missing fact is `null`/absent and is displayed as unknown.
 */

// ---------------------------------------------------------------------------
// Origin and determinism — mirrors cd-core `ActivityOrigin` / `Determinism`.
// Wire values are the snake_case serde representation, so a record read from
// `get_turn_activity` needs no key translation.
// ---------------------------------------------------------------------------

/** Where a step's authority comes from. */
export const ACTIVITY_ORIGINS = [
  /** Supplied by the client or observed in the user's own input. */
  "client_evidence",
  /** Trusted host work with a defined result. */
  "deterministic_host",
  /** A repeatable rule (ranking, scoring, selection) — not a proof. */
  "repeatable_heuristic",
  /** A request to a language model. */
  "probabilistic_model",
  /** A system outside this application. */
  "external_connector",
  /** A human answered a question. */
  "user_decision",
  /** A durable mutation that required, and had, an explicit grant. */
  "governed_write",
] as const;
export type ActivityOrigin = (typeof ACTIVITY_ORIGINS)[number];

/** How much a reader may rely on a step reproducing. */
export type Determinism =
  | "deterministic"
  | "repeatable"
  | "probabilistic"
  | "human";

/**
 * The determinism class an origin implies.
 *
 * A total function on `origin`, exactly as in `cd-core`, so "deterministic"
 * cannot be claimed for a heuristic by filling in a struct carelessly. The
 * `repeatable_heuristic` case is the whole point: a ranking rule gives the
 * same answer twice, which is NOT the same claim as "this is a proof."
 */
export function determinismForOrigin(origin: ActivityOrigin): Determinism {
  switch (origin) {
    case "client_evidence":
    case "deterministic_host":
      return "deterministic";
    case "repeatable_heuristic":
      return "repeatable";
    case "probabilistic_model":
    case "external_connector":
      return "probabilistic";
    case "user_decision":
      return "human";
    case "governed_write":
      // The write is defined; the decision to allow it was human, and that
      // decision is its own `user_decision` event.
      return "deterministic";
  }
}

/**
 * Origins whose work the host cannot promise to reproduce — a model ran, or
 * something outside this process answered. Requirement 4's "nondeterministic
 * / external" half; everything else is the deterministic half.
 */
export function isNondeterministicOrigin(origin: ActivityOrigin): boolean {
  const d = determinismForOrigin(origin);
  return d === "probabilistic";
}

/** Lifecycle position of one operation. */
export type ActivityPhase = "started" | "progress" | "completed";

/** Terminal (or current) result of an operation. */
export type ActivityStatus =
  | "pending"
  | "ok"
  | "failed"
  | "cancelled"
  | "withheld";

/** What kind of material an event's captured text is. */
export type PrivacyClass =
  | "metadata"
  | "redacted_content"
  | "user_visible_content";

/** The kind of material a step was working over. */
export type DataScopeKind =
  | "conversation"
  | "log_corpus"
  | "workspace"
  | "memory"
  | "connector";

export type DataScope = {
  kind: DataScopeKind;
  /** Stable id within that kind, when one exists. Never user content. */
  id?: string | null;
  label: string;
};

/** A pointer to something a step read or produced. Identifiers only. */
export type EvidenceRef = {
  kind: string;
  id: string;
  locator?: string | null;
};

// ---------------------------------------------------------------------------
// Lane isolation (requirement 2).
// ---------------------------------------------------------------------------

/**
 * Every activity event belongs to ContextDesk's own lane group and nothing
 * else. This is a constant, not a parameter: there is no code path that
 * produces an activity event in the customer group, because the customer
 * group is not made of activity events at all — it is `ExplorerEventDto`s
 * governed by corpus / source / filter / suppression state.
 *
 * The two groups synchronize independently:
 *  - customer lanes ← corpus, source facets, filters, suppression policy
 *  - ContextDesk lanes ← operation / import / chat-turn / model-round / tool
 *    / correlation identity (see `correlationId` below)
 */
export const ACTIVITY_LANE_GROUP = "contextdesk" as const;
export type ActivityLaneGroup = typeof ACTIVITY_LANE_GROUP;

// ---------------------------------------------------------------------------
// The honest clock (requirement 3).
// ---------------------------------------------------------------------------

/**
 * Where an event sits in time, and how much that placement can be trusted.
 *
 * A discriminated union rather than a nullable timestamp, so a renderer
 * physically cannot read `atMs` off an event that never had one. The dual-
 * lane Explorer view shares one axis with the customer lanes only when BOTH
 * sides are `wall`; otherwise the ContextDesk lane is drawn on its own
 * approximate/causal track and labelled as such.
 */
export type ActivityClock =
  /** Real calendar time on this machine, from the host runtime clock. */
  | { kind: "wall"; atMs: number }
  /** Monotonic milliseconds since the owning operation started. */
  | { kind: "elapsed"; elapsedMs: number }
  /** Order only. No duration, no date — this event is merely Nth. */
  | { kind: "sequence"; seq: number };

/** True only for a clock that carries genuine calendar time. */
export function isWallClock(clock: ActivityClock): clock is {
  kind: "wall";
  atMs: number;
} {
  return clock.kind === "wall";
}

/**
 * Short, honest label for a clock — used wherever a time is displayed so a
 * reader is never shown a bare number whose meaning is ambiguous.
 */
export function clockQualityLabel(clock: ActivityClock): string {
  switch (clock.kind) {
    case "wall":
      return "wall clock";
    case "elapsed":
      return "elapsed since start";
    case "sequence":
      return "order only (no clock time)";
  }
}

/**
 * Trigger + data-scope disclosure. Required on every automatic
 * nondeterministic or external event: what fired the hook, and what data it
 * could see. The discriminated union on `ActivityEvent` makes the compiler,
 * not reviewer vigilance, enforce it.
 */
export type ActivityHookDisclosure = {
  /** What caused this to run (e.g. "import → optional embedding phase"). */
  trigger: string;
  /** What data the hook could read (e.g. "learned templates of this corpus"). */
  dataScope: string;
};

/** Per-role tallies for one provider round. */
export type RoleTally = {
  role: string;
  messages: number;
  chars: number;
};

/** Bounded, redacted metadata about one provider round's context. */
export type ContextMetadata = {
  round: number;
  messageCount: number;
  contextUsedChars: number;
  /** True when more messages were sent than the trace retains. */
  messagesCapped: boolean;
  toolNames: string[];
  roles: RoleTally[];
  /** Duration of the provider call itself, not turn-relative placement. */
  providerLatencyMs: number | null;
};

type ActivityEventBase = {
  /** Stable per-store id. */
  id: string;
  /**
   * What this event belongs to, for the ContextDesk group's own
   * synchronization: an import run, a chat turn, a model round, a tool call.
   * Selecting one correlation highlights its whole causal chain across
   * ContextDesk lanes — and never touches the customer lanes.
   */
  correlationId: string;
  /** Folds `started`/`progress`/`completed` rows into one logical row. */
  operationId: string;
  phase: ActivityPhase;
  status: ActivityStatus;
  /** Honest time placement — see `ActivityClock`. */
  clock: ActivityClock;
  /** One concise line. */
  label: string;
  /** Optional longer explanation, bounded before it gets here. */
  detail?: string;
  scope: DataScope;
  evidence?: EvidenceRef[];
  privacy: PrivacyClass;
  /** Present on provider-round events only. */
  context?: ContextMetadata;
  /** Always the ContextDesk group. Never the customer corpus. */
  laneGroup: ActivityLaneGroup;
  /** Corpus this activity concerned, when corpus-scoped. */
  corpusId?: string;
};

/**
 * One auditable step.
 *
 * Split into two arms so a `probabilistic_model` or `external_connector`
 * event does not typecheck without its `hook` disclosure — the reader of a
 * nondeterministic step is always told what triggered it and what it could
 * see.
 */
export type ActivityEvent =
  | (ActivityEventBase & {
      origin: Exclude<
        ActivityOrigin,
        "probabilistic_model" | "external_connector"
      >;
      determinism: Determinism;
      hook?: ActivityHookDisclosure;
    })
  | (ActivityEventBase & {
      origin: "probabilistic_model" | "external_connector";
      determinism: Determinism;
      hook: ActivityHookDisclosure;
    });

/** Caller-side shape: everything but the store-assigned id. */
export type ActivityEventInput = ActivityEvent extends infer E
  ? E extends { id: string }
    ? Omit<E, "id">
    : never
  : never;

// ---------------------------------------------------------------------------
// Presentation preference (requirement 1) — ONE shared vocabulary.
// ---------------------------------------------------------------------------

/**
 * The four display modes, shared by ordinary chat and the Log Explorer.
 *
 * `off` hides the entire ContextDesk activity group. It is a display
 * preference only: host-side capture is governed by `AppConfig.activity` and
 * is deliberately a different switch, so hiding the panel never changes what
 * a turn actually does.
 */
export const ACTIVITY_MODES = ["off", "compact", "drawer", "docked"] as const;
export type ActivityMode = (typeof ACTIVITY_MODES)[number];

// ---------------------------------------------------------------------------
// Live turn facets — populated from the host's TurnActivityRecord.
// Every field is `null` when the backend does not report it. There is no
// fixture fallback in this file or any production module.
// ---------------------------------------------------------------------------

export type ActivityBudget = {
  usedChars: number | null;
  /** Null unless the host reported a real ceiling — never assumed. */
  totalChars: number | null;
  /** What got cut and why; null when nothing was truncated. */
  truncationNote: string | null;
};

export type ActivityRequestRound = {
  id: string;
  /** 1-based for display; the wire contract is 0-based. */
  index: number;
  model?: string;
  toolsOffered: string[];
  toolsRun: string[];
  elapsedMs: number | null;
  status: ActivityStatus;
  contextUsedChars: number | null;
  messagesCapped: boolean;
};

export type ActivityCitation = {
  id: string;
  label: string;
  title?: string;
};

export type ActivityPermissionRecord = {
  id: string;
  toolName: string;
  target: string;
  decision: string | null;
};

export type ActivityTurnSummary = {
  modelRounds: number | null;
  toolCalls: number | null;
  contextUsedChars: number | null;
  /** True when the answer cited at least one resolvable source. */
  grounded: boolean | null;
  status: ActivityStatus | null;
};

/**
 * One turn's activity, in the shape every Activity Inspector surface reads.
 *
 * `liveRecord` is true when a host `TurnActivityRecord` backed this turn. A
 * turn with `liveRecord: false` still renders whatever the renderer itself
 * observed (tool calls, citations, search trail) and shows every host-only
 * field as unknown — it never fills them in.
 */
export type ActivityTurn = {
  turnId: string;
  label: string;
  summary: ActivityTurnSummary;
  budget: ActivityBudget;
  requestRounds: ActivityRequestRound[];
  events: ActivityEvent[];
  citations: ActivityCitation[];
  permissions: ActivityPermissionRecord[];
  elapsedMs: number | null;
  /** True when the host contract supplied this turn's record. */
  liveRecord: boolean;
  /** Non-zero when the host's per-turn bound dropped steps. */
  droppedEvents: number;
  /** Contract version the record was written with, when live. */
  contractVersion: number | null;
  /** Explicitly opted-in, process-local sensitive developer payloads. */
  developerDetail?: DeveloperDetailEvent[];
};

export type DeveloperPayload = {
  content: string;
  original_bytes: number;
  retained_bytes: number;
  truncated: boolean;
};

export type DeveloperDetailEvent = {
  seq: number;
  elapsed_ms?: number | null;
  kind:
    | "provider_exchange"
    | "tool_call"
    | "tool_result"
    | "permission"
    | "deterministic_stage"
    | "cancellation";
  label: string;
  provider?: string | null;
  model?: string | null;
  round?: number | null;
  tool_name?: string | null;
  offered_tools: string[];
  request: DeveloperPayload[];
  response?: DeveloperPayload | null;
  status: string;
  sensitive: true;
};

// ---------------------------------------------------------------------------
// Host wire shapes — the serde representation of cd-core's contract.
// Structural mirrors, so `get_turn_activity` needs no key translation.
// ---------------------------------------------------------------------------

export type HostActivityTrigger =
  | { trigger: "user_message" }
  | { trigger: "host_policy" }
  | { trigger: "model_request"; round: number }
  | { trigger: "user_decision" }
  | { trigger: "retry"; of_operation_id: string };

export type HostContextMetadata = {
  round: number;
  message_count: number;
  context_used_chars: number;
  messages_capped: boolean;
  tool_names: string[];
  roles: { role: string; messages: number; chars: number }[];
  provider_latency_ms?: number | null;
};

export type HostActivityEvent = {
  turn_id: string;
  operation_id: string;
  seq: number;
  elapsed_ms?: number | null;
  phase: ActivityPhase;
  status: ActivityStatus;
  origin: ActivityOrigin;
  determinism: Determinism;
  label: string;
  detail?: string | null;
  trigger: HostActivityTrigger;
  scope: { kind: DataScopeKind; id?: string | null; label: string };
  evidence?: EvidenceRef[];
  privacy: PrivacyClass;
  context?: HostContextMetadata | null;
};

export type HostTurnActivityRecord = {
  version: number;
  turn_id: string;
  session_id: string;
  message_id?: string | null;
  scope: { kind: DataScopeKind; id?: string | null; label: string };
  status: ActivityStatus;
  total_elapsed_ms: number;
  detail_level: "summary" | "full";
  events: HostActivityEvent[];
  dropped_events: number;
};

// ---------------------------------------------------------------------------
// Import-run adapter inputs — structural subsets of existing renderer DTOs
// (LogIngestReportDto / FailedLogIngestDiagnosticDto / LogImportConfidenceDto
// in src/lib/host.ts). Field names match the wire exactly so a baselined
// caller can pass its DTO straight in; no host import happens here.
// ---------------------------------------------------------------------------

export type ImportEmbeddingInput = {
  state: "keyword_only" | "deferred" | "partial" | "complete";
  modelId: string | null;
};

export type TimeQuality = "wall" | "mixed" | "order_only";

export type ImportSourceConfidenceInput = {
  source: string;
  lines: number;
  formatId?: string | null;
  outcome: "matched" | "ambiguous" | "unknown";
  timeQuality: TimeQuality;
  unresolvedReasons?: string[];
};

export type ImportConfidenceInput = {
  corpusTimeQuality: TimeQuality;
  counts: {
    wall: number;
    orderOnly: number;
    mixed: number;
    matched: number;
    ambiguous: number;
    unknown: number;
    unresolved: number;
  };
  sources: ImportSourceConfidenceInput[];
};

export type ImportReportInput = {
  corpusId: string;
  lines: number;
  templates: number;
  reductionRatio: number;
  embedded: number;
  files: number;
  discoveredFiles: number;
  excludedFiles: number;
  failedFiles: number;
  ignoredFiles: number;
  exclusionCounts: Record<string, number>;
  exclusionExamples: string[];
  partial: boolean;
  sourceBytes: number;
  corpusBytes: number;
  tsMin: number | null;
  tsMax: number | null;
  formatCounts: Record<string, number>;
  embedding?: ImportEmbeddingInput | null;
  confidence?: ImportConfidenceInput | null;
};

export type ImportDiagnosticInput = {
  reasonCode: string;
  summary: string;
  cancelled: boolean;
  evidence: {
    scanCounts: {
      binary: number;
      empty: number;
      hidden: number;
      oversized: number;
      readFailed: number;
      parseFailed: number;
    };
    omittedEntries: number;
  };
};

/** One completed/failed/cancelled import attempt, as the ledger sees it. */
export type ImportRunInput = {
  startedAtMs: number;
  endedAtMs: number;
  outcome: "completed" | "failed" | "cancelled";
  sourceKind: "directory" | "file" | "zip" | "package" | "demo" | "unknown";
  report?: ImportReportInput | null;
  diagnostic?: ImportDiagnosticInput | null;
};

// ---------------------------------------------------------------------------
// Dual clocks — the two timelines the Explorer dock must keep apart.
// ---------------------------------------------------------------------------

/**
 * The customer's incident clock: real event time from the evidence, carried
 * with its honesty level. An `order_only` corpus has NO calendar time, and
 * the dock must say so rather than render a fabricated date.
 */
export type ClientIncidentClock = {
  tsMinMs: number | null;
  tsMaxMs: number | null;
  timeQuality: TimeQuality;
  /** Currently selected event's time, when one is selected. */
  selectedTsMs?: number | null;
};

/**
 * ContextDesk's own clock: host runtime on this machine, right now. Never
 * aligned to the client incident clock unless both carry wall time — see
 * `dualLaneAxis.ts`.
 */
export type InvestigationElapsedClock = {
  openedAtMs: number;
  nowMs: number;
};
