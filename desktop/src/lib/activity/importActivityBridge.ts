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
const SAFE_IMPORT_LABELS = new Set([
  "Import started",
  "Discovering and reading sources",
  "Reading, parsing, normalizing, and indexing",
  "Running optional local embedding",
  "Validating staged corpus",
  "Publishing corpus atomically",
  "Corpus published",
  "Import cancelled — nothing published",
  "Import failed — nothing published",
  "Import processing",
]);
const SAFE_IMPORT_DETAIL_PART =
  /^(?:[\d,]+ (?:files?|events?|templates?|bytes read)|\d+%|prior displayed phase [\d,]+ ms)$/;

type BridgePayload = {
  corpusId?: unknown;
  eventId?: unknown;
  events?: unknown;
};
type BridgeListen = (
  eventName: string,
  handler: (event: { payload: BridgePayload }) => void,
) => Promise<() => void>;
type BridgeEmit = (
  eventName: string,
  payload: { corpusId: string; eventId: string; events: ActivityEventInput[] },
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
    const next = normalizeEvent(event, corpusId);
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
  if (
    !normalized ||
    !SAFE_IMPORT_LABELS.has(normalized.label) ||
    !safeImportDetail(normalized.detail)
  ) {
    return null;
  }
  if (normalized.origin === "probabilistic_model") {
    if (
      normalized.hook.trigger !==
        "import → optional local embedding phase" ||
      normalized.hook.dataScope !==
        "learned templates of the selected import only"
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
export function loadCorpusImportActivity(corpusId: string): ActivityEventInput[] {
  if (typeof window === "undefined" || !validCorpusId(corpusId)) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(corpusId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; events?: unknown };
    if (parsed.version !== 1) return [];
    return normalizeEvents(parsed.events, corpusId);
  } catch {
    return [];
  }
}

/**
 * Persist and announce a published import. Failed/cancelled attempts have no
 * corpus scope, so they remain visible only in the initiating Logs pane.
 */
export async function publishImportRunActivity(
  run: ImportRunInput,
  sourceEvents: ActivityEventInput[],
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
  try {
    window.localStorage.setItem(
      storageKey(corpusId),
      JSON.stringify({ version: 1, events }),
    );
  } catch {
    // A live Explorer still receives the safe event payload below.
  }

  const payload = { corpusId, eventId: createEventId(), events };
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
  onChanged: (corpusId: string, events: ActivityEventInput[]) => void,
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
    seenIds.add(payload.eventId);
    seenOrder.push(payload.eventId);
    if (seenOrder.length > MAX_SEEN_EVENT_IDS) {
      const expired = seenOrder.shift();
      if (expired) seenIds.delete(expired);
    }
    onChanged(payload.corpusId, events);
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
