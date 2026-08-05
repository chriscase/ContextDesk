/**
 * Corpus-scoped import activity transport.
 *
 * A reviewed/quick import is initiated in the Logs pane, while its Activity
 * rail can live in another Tauri webview. Persist only the already-projected,
 * bounded metadata events — never the import path, source names, log text, or
 * the full host report — then signal same-window and cross-webview listeners.
 */
import {
  appendActivities,
  createActivityLog,
} from "./activityLog";
import {
  ACTIVITY_LANE_GROUP,
  ACTIVITY_ORIGINS,
  determinismForOrigin,
  type ActivityEventInput,
  type ActivityOrigin,
  type ActivityPhase,
  type ActivityStatus,
  type ImportRunInput,
} from "./types";

export const IMPORT_ACTIVITY_CHANGED_EVENT =
  "contextdesk:corpus-import-activity-changed";

const STORAGE_PREFIX = "contextdesk.importActivity.v1:";
const MAX_CORPUS_ID_LENGTH = 256;
const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 200;
const MAX_DETAIL_LENGTH = 2_000;
const MAX_EVENTS = 32;
const MAX_SEEN_EVENT_IDS = 128;
const MAX_EVENT_ID_LENGTH = 128;
// A generous bound, not a realistic count: the live cap
// (`IMPORT_ACTIVITY_EVENT_CAP` in importProgressActivity.ts) is 16, so a
// genuine value never exceeds a few dozen. This only rejects an implausible
// or corrupted/tampered value read back from storage or another webview.
const MAX_OMITTED_UPDATES = 1_000_000;
const SAFE_IMPORT_DETAIL_PART =
  /^(?:[\d,]+ (?:files?|events?|templates?|bytes read)|\d+%|prior displayed phase [\d,]+ ms)$/;

const NON_TERMINAL_PHASES: ReadonlySet<ActivityPhase> = new Set([
  "started",
  "progress",
]);
const TERMINAL_PHASE: ReadonlySet<ActivityPhase> = new Set(["completed"]);
const PENDING_ONLY: ReadonlySet<ActivityStatus> = new Set(["pending"]);

const EMBEDDING_HOOK = {
  trigger: "import → optional local embedding phase",
  dataScope: "learned templates of the selected import only",
} as const;

/**
 * Exact allowlisted (label -> origin, phases, statuses[, hook]) tuple for
 * every event `importProgressActivity.ts` can actually emit.
 *
 * This is the fix for two distinct forgeries the old label-only check let
 * through: (1) a payload could claim ANY origin for a label — e.g.
 * `label: "Corpus published"` with `origin: "deterministic_host"` and
 * `status: "failed"` — since only the label was ever checked; (2) an
 * `external_connector`-origin payload was accepted as long as it carried a
 * well-formed-looking `hook`, because the old hook-content check ran only
 * for `probabilistic_model`. Import never talks to an external connector —
 * every real emitter above is `deterministic_host` / `governed_write` /
 * `user_decision` / `probabilistic_model` (the local embedding step only) —
 * so `external_connector` is rejected outright, and every other origin must
 * match this table exactly, not merely "be a valid origin string".
 */
const IMPORT_LABEL_TUPLES: ReadonlyMap<
  string,
  {
    origin: Exclude<ActivityOrigin, "external_connector">;
    phases: ReadonlySet<ActivityPhase>;
    statuses: ReadonlySet<ActivityStatus>;
    hook?: { trigger: string; dataScope: string };
  }
> = new Map([
  [
    "Import started",
    { origin: "user_decision", phases: new Set<ActivityPhase>(["started"]), statuses: PENDING_ONLY },
  ],
  [
    "Archive discovery and source scan",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  // Legacy label kept so older in-memory attempts still validate.
  [
    "Discovering and reading sources",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Reading, parsing, normalizing, and indexing",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Parsing and framing records",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Candidate template classification",
    { origin: "repeatable_heuristic", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Safety redaction of secrets and credentials",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Normalization and indexing into the store",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Running optional local embedding",
    {
      origin: "probabilistic_model",
      phases: NON_TERMINAL_PHASES,
      statuses: PENDING_ONLY,
      hook: EMBEDDING_HOOK,
    },
  ],
  [
    "Safety limits and staged corpus validation",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Validating staged corpus",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Publishing corpus atomically",
    { origin: "governed_write", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Corpus published — Explorer can refresh",
    { origin: "governed_write", phases: TERMINAL_PHASE, statuses: new Set<ActivityStatus>(["ok"]) },
  ],
  [
    "Corpus published",
    { origin: "governed_write", phases: TERMINAL_PHASE, statuses: new Set<ActivityStatus>(["ok"]) },
  ],
  [
    "Import cancelled — nothing published",
    {
      origin: "deterministic_host",
      phases: TERMINAL_PHASE,
      statuses: new Set<ActivityStatus>(["cancelled"]),
    },
  ],
  [
    "Import failed — nothing published",
    {
      origin: "deterministic_host",
      phases: TERMINAL_PHASE,
      statuses: new Set<ActivityStatus>(["failed"]),
    },
  ],
  [
    "Reading selected source bytes",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Extracting archive contents",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Writing session context material",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
  [
    "Import processing",
    { origin: "deterministic_host", phases: NON_TERMINAL_PHASES, statuses: PENDING_ONLY },
  ],
]);

type BridgePayload = {
  corpusId?: unknown;
  eventId?: unknown;
  events?: unknown;
  omittedUpdates?: unknown;
};
type BridgeListen = (
  eventName: string,
  handler: (event: { payload: BridgePayload }) => void,
) => Promise<() => void>;
type BridgeEmit = (
  eventName: string,
  payload: {
    corpusId: string;
    eventId: string;
    events: ActivityEventInput[];
    omittedUpdates: number;
  },
) => Promise<void>;

const senderId = globalThis.crypto.randomUUID();
let nextEventSequence = 0;

function createEventId(): string {
  nextEventSequence += 1;
  return `${senderId}:${nextEventSequence}`;
}

function storageKey(corpusId: string): string {
  return `${STORAGE_PREFIX}${corpusId}`;
}

function validString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validCorpusId(value: unknown): value is string {
  return validString(value, MAX_CORPUS_ID_LENGTH);
}

/**
 * Fail closed on anything but a genuine non-negative integer count: a
 * tampered or out-of-bounds value from storage or another webview is
 * rejected wholesale (falls back to 0 at every call site below) rather than
 * clamped, so a forged large value cannot be laundered into a smaller-but
 * still attacker-chosen disclosure count.
 */
function validOmittedUpdates(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_OMITTED_UPDATES
  );
}

function normalizeEvent(
  raw: unknown,
  corpusId: string,
): ActivityEventInput | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    !validString(value.correlationId, MAX_ID_LENGTH) ||
    !value.correlationId.startsWith("import:") ||
    !validString(value.operationId, MAX_ID_LENGTH) ||
    !value.operationId.startsWith(`${value.correlationId}:`) ||
    !ACTIVITY_ORIGINS.includes(value.origin as ActivityOrigin) ||
    !["started", "progress", "completed"].includes(String(value.phase)) ||
    !["pending", "ok", "failed", "cancelled", "withheld"].includes(
      String(value.status),
    ) ||
    !validString(value.label, MAX_LABEL_LENGTH) ||
    (value.detail != null &&
      (typeof value.detail !== "string" ||
        value.detail.length > MAX_DETAIL_LENGTH))
  ) {
    return null;
  }
  const rawClock = value.clock as Record<string, unknown> | null;
  const clock = (() => {
    if (!rawClock) return null;
    if (
      rawClock.kind === "elapsed" &&
      typeof rawClock.elapsedMs === "number" &&
      Number.isFinite(rawClock.elapsedMs) &&
      rawClock.elapsedMs >= 0
    ) {
      return { kind: "elapsed" as const, elapsedMs: Math.floor(rawClock.elapsedMs) };
    }
    if (
      rawClock.kind === "sequence" &&
      typeof rawClock.seq === "number" &&
      Number.isSafeInteger(rawClock.seq) &&
      rawClock.seq >= 0
    ) {
      return { kind: "sequence" as const, seq: rawClock.seq };
    }
    return null;
  })();
  if (!clock) return null;

  const origin = value.origin as ActivityOrigin;
  const base = {
    correlationId: value.correlationId,
    operationId: value.operationId,
    origin,
    determinism: determinismForOrigin(origin),
    phase: value.phase as ActivityEventInput["phase"],
    status: value.status as ActivityEventInput["status"],
    clock,
    label: value.label,
    detail: typeof value.detail === "string" ? value.detail : undefined,
    scope: {
      kind: "log_corpus" as const,
      id: corpusId,
      label: `Log corpus ${corpusId}`,
    },
    privacy: "metadata" as const,
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
    corpusId,
  };

  if (origin === "probabilistic_model" || origin === "external_connector") {
    const hook = value.hook as Record<string, unknown> | null;
    if (
      !hook ||
      !validString(hook.trigger, MAX_LABEL_LENGTH) ||
      !validString(hook.dataScope, MAX_DETAIL_LENGTH)
    ) {
      return null;
    }
    return {
      ...base,
      origin,
      hook: { trigger: hook.trigger, dataScope: hook.dataScope },
    };
  }
  return {
    ...base,
    origin,
  } as ActivityEventInput;
}

function normalizeEvents(raw: unknown, corpusId: string): ActivityEventInput[] {
  if (!Array.isArray(raw) || raw.length > MAX_EVENTS) return [];
  const normalized: ActivityEventInput[] = [];
  for (const event of raw) {
    const next = safeProjectedEvent(event as ActivityEventInput, corpusId);
    if (!next) return [];
    normalized.push(next);
  }
  return normalized;
}

function safeImportDetail(detail: string | undefined): boolean {
  if (detail == null || detail === "No corpus was published.") return true;
  return detail.split(" · ").every((part) => SAFE_IMPORT_DETAIL_PART.test(part));
}

function safeProjectedEvent(
  event: ActivityEventInput,
  corpusId: string,
): ActivityEventInput | null {
  const normalized = normalizeEvent(event, corpusId);
  if (!normalized) return null;
  // Import never involves an external connector — reject outright, before
  // even consulting the label table, so a forged payload cannot rely on
  // some future table entry accidentally omitting this check.
  if (normalized.origin === "external_connector") return null;
  const tuple = IMPORT_LABEL_TUPLES.get(normalized.label);
  if (
    !tuple ||
    normalized.origin !== tuple.origin ||
    !tuple.phases.has(normalized.phase) ||
    !tuple.statuses.has(normalized.status) ||
    !safeImportDetail(normalized.detail)
  ) {
    return null;
  }
  if (normalized.origin === "probabilistic_model") {
    if (
      !tuple.hook ||
      normalized.hook.trigger !== tuple.hook.trigger ||
      normalized.hook.dataScope !== tuple.hook.dataScope
    ) {
      return null;
    }
  }
  return normalized;
}

function safeEventsForRun(
  run: ImportRunInput,
  sourceEvents: ActivityEventInput[],
): ActivityEventInput[] {
  const corpusId = run.report?.corpusId;
  if (!corpusId) return [];
  const correlationId = sourceEvents[0]?.correlationId;
  // A corpus-scoped trace is only durable when it contains a milestone bound
  // to the host-issued operation identity. A renderer-only request/result pair
  // cannot prove which process-progress invocation produced the corpus.
  if (
    !correlationId ||
    !sourceEvents.some(
      (event) =>
        event.correlationId === correlationId &&
        event.operationId.startsWith(`${correlationId}:host:`),
    )
  ) {
    return [];
  }
  const projected = sourceEvents.map((event) =>
    safeProjectedEvent(event, corpusId),
  );
  // Reject the whole causal chain if any caller bypassed the projector. A
  // partial Activity chain can make a successful import look misleadingly
  // incomplete, and storing arbitrary "metadata" text could retain a path.
  if (projected.some((event) => event == null)) return [];
  const bounded = appendActivities(
    createActivityLog(MAX_EVENTS),
    projected as ActivityEventInput[],
  );
  return bounded.entries.map(({ id: _id, ...event }) => event);
}

/** Read the last safely projected import activity for one corpus. */
export function loadCorpusImportActivity(corpusId: string): {
  events: ActivityEventInput[];
  omittedUpdates: number;
} {
  const empty = { events: [], omittedUpdates: 0 };
  if (typeof window === "undefined" || !validCorpusId(corpusId)) return empty;
  try {
    const raw = window.localStorage.getItem(storageKey(corpusId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      events?: unknown;
      omittedUpdates?: unknown;
    };
    if (parsed.version !== 1) return empty;
    const events = normalizeEvents(parsed.events, corpusId);
    // A tampered/out-of-bounds omittedUpdates never invalidates the
    // (separately validated) events themselves — it just fails closed to 0,
    // the truthful "nothing known to be omitted" default.
    const omittedUpdates = validOmittedUpdates(parsed.omittedUpdates)
      ? parsed.omittedUpdates
      : 0;
    return { events, omittedUpdates };
  } catch {
    return empty;
  }
}

/** Forget only the confirmed-discard corpus's renderer-side Activity cache. */
export function forgetCorpusImportActivity(corpusId: string): void {
  if (typeof window === "undefined" || !validCorpusId(corpusId)) return;
  try {
    window.localStorage.removeItem(storageKey(corpusId));
  } catch {
    // Corpus deletion remains authoritative even if web storage is blocked.
  }
}

/**
 * Persist and announce a published import. Failed/cancelled attempts have no
 * corpus scope, so they remain visible only in the initiating Logs pane.
 */
export async function publishImportRunActivity(
  run: ImportRunInput,
  sourceEvents: ActivityEventInput[],
  omittedUpdates = 0,
  injectedEmit?: BridgeEmit,
): Promise<void> {
  const corpusId = run.report?.corpusId;
  if (
    typeof window === "undefined" ||
    run.outcome !== "completed" ||
    !validCorpusId(corpusId)
  ) {
    return;
  }
  const events = safeEventsForRun(run, sourceEvents);
  if (events.length === 0) return;
  // This process is the trusted source of its own count, but still bound and
  // validate it before it is persisted/broadcast — the same discipline every
  // other outbound field here gets, and it keeps the value that reaches
  // storage always passing `validOmittedUpdates` on the way back in.
  const safeOmittedUpdates = validOmittedUpdates(omittedUpdates)
    ? omittedUpdates
    : 0;
  try {
    window.localStorage.setItem(
      storageKey(corpusId),
      JSON.stringify({ version: 1, events, omittedUpdates: safeOmittedUpdates }),
    );
  } catch {
    // A live Explorer still receives the safe event payload below.
  }

  const payload = {
    corpusId,
    eventId: createEventId(),
    events,
    omittedUpdates: safeOmittedUpdates,
  };
  window.dispatchEvent(
    new CustomEvent<BridgePayload>(IMPORT_ACTIVITY_CHANGED_EVENT, {
      detail: payload,
    }),
  );
  try {
    const send =
      injectedEmit ??
      ((await import("../engine/activityBridgeTransport"))
        .emitActivityBridgeEvent as BridgeEmit);
    await send(IMPORT_ACTIVITY_CHANGED_EVENT, payload);
  } catch {
    // Browser preview and tests have no Tauri event bus.
  }
}

/** Subscribe to published imports in this webview and other Tauri webviews. */
export function subscribeImportRunActivity(
  onChanged: (
    corpusId: string,
    events: ActivityEventInput[],
    omittedUpdates: number,
  ) => void,
  injectedListen?: BridgeListen,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  let disposed = false;
  let stopTauri: (() => void) | null = null;
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  const accept = (payload: BridgePayload | undefined) => {
    if (disposed || !validCorpusId(payload?.corpusId)) return;
    if (
      !validString(payload?.eventId, MAX_EVENT_ID_LENGTH) ||
      seenIds.has(payload.eventId)
    ) {
      return;
    }
    const events = normalizeEvents(payload.events, payload.corpusId);
    if (events.length === 0) return;
    // A cross-webview payload is exactly as untrusted as a localStorage
    // read — fail closed to 0 rather than propagate a tampered count.
    const omittedUpdates = validOmittedUpdates(payload.omittedUpdates)
      ? payload.omittedUpdates
      : 0;
    seenIds.add(payload.eventId);
    seenOrder.push(payload.eventId);
    if (seenOrder.length > MAX_SEEN_EVENT_IDS) {
      const expired = seenOrder.shift();
      if (expired) seenIds.delete(expired);
    }
    onChanged(payload.corpusId, events, omittedUpdates);
  };
  const onCustom = (event: Event) => {
    accept((event as CustomEvent<BridgePayload>).detail);
  };

  window.addEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, onCustom);
  void (async () => {
    const listen =
      injectedListen ??
      ((await import("../engine/activityBridgeTransport"))
        .listenActivityBridgeEvent as BridgeListen);
    const stop = await listen(IMPORT_ACTIVITY_CHANGED_EVENT, (event) =>
      accept(event.payload),
    );
    if (disposed) stop();
    else stopTauri = stop;
  })().catch(() => undefined);

  return () => {
    disposed = true;
    window.removeEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, onCustom);
    stopTauri?.();
  };
}
