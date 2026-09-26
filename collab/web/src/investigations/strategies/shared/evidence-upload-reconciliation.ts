import { useEffect, useReducer, useRef } from "react";
type ArtifactKind = "attachment" | "log" | "email";
type PrivacyClass = "owner_only" | "share_safe";

export interface FrozenUploadIntent {
  readonly file: File;
  readonly summary: string;
  readonly kind: ArtifactKind;
  readonly privacyClass: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
}
export type ReconciliationPhase = "editing" | "submitting" | "refreshing" | "refresh_failed" | "review" | "ordinary_failure";
export interface ReconciliationUploadResult {
  readonly status: "succeeded" | "failed" | "ignored";
  readonly error?: { readonly kind?: string; readonly reason?: string };
  readonly evidenceReadGeneration?: number;
}
interface Epoch {
  readonly scopeKey: string;
  live: boolean;
  intent: FrozenUploadIntent | null;
  phase: ReconciliationPhase;
  message: string | null;
  barrier: number | null;
  busy: boolean;
}
function epoch(scopeKey: string): Epoch {
  return { scopeKey, live: true, intent: null, phase: "editing", message: null, barrier: null, busy: false };
}
/** Runtime generations prove read chronology; presentation epochs fence every captured action. */
export function useEvidenceUploadReconciliation(options: {
  readonly scopeKey: string;
  readonly canReadPrivate: boolean;
  readonly canSubmit?: boolean;
  readonly readCompletion: { readonly requested: number; readonly succeeded: number; readonly failed: number };
  readonly upload: (intent: FrozenUploadIntent) => Promise<ReconciliationUploadResult>;
  readonly refreshEvidence: () => number | void;
}) {
  const [, paint] = useReducer((value: number) => value + 1, 0);
  const current = useRef<Epoch>(epoch(options.scopeKey));
  const latest = useRef(options);
  latest.current = options;
  const concealed = current.current.scopeKey !== options.scopeKey;
  if (concealed) {
    current.current.live = false;
    current.current.intent = null;
    current.current = epoch(options.scopeKey);
  }
  const active = current.current;
  const isCurrent = () => active.live && current.current === active;
  useEffect(() => {
    current.current.live = true;
    return () => { current.current.live = false; current.current.intent = null; };
  }, []);
  const allowed = () => isCurrent() && latest.current.canSubmit !== false
    && !(active.intent?.privacyClass === "owner_only" && !latest.current.canReadPrivate);
  const reviewed = () => active.barrier !== null
    && latest.current.readCompletion.succeeded >= active.barrier;
  const phase = active.phase === "refreshing" || active.phase === "refresh_failed"
    ? reviewed() ? "review" : active.barrier !== null && options.readCompletion.failed >= active.barrier ? "refresh_failed" : "refreshing"
    : active.phase;
  async function submit(next: FrozenUploadIntent, source: "form" | "retry"): Promise<ReconciliationUploadResult | undefined> {
    if (!allowed() || active.busy) return;
    if (source === "retry" && (!active.intent || !reviewed())) return;
    // A direct form invocation cannot start a new intent while recovery is unresolved.
    if (source === "form" && active.intent !== null && active.phase !== "ordinary_failure") return;
    const frozen = source === "retry" ? active.intent! : Object.freeze({ ...next });
    if (frozen.privacyClass === "owner_only" && !latest.current.canReadPrivate) return;
    active.intent = frozen;
    active.busy = true;
    active.phase = "submitting";
    active.message = null;
    paint();
    let result: ReconciliationUploadResult;
    try { result = await latest.current.upload(frozen); }
    catch { result = { status: "failed", error: { kind: "unexpected" } }; }
    if (!isCurrent()) return result;
    active.busy = false;
    if (result.status === "succeeded") {
      active.intent = null;
      active.barrier = null;
      active.phase = "editing";
    } else if (result.status === "failed" && result.error?.kind === "unavailable" && result.error.reason === "commit_outcome_unknown") {
      // The Runtime triggered this generation synchronously on the exact marker.
      // A legacy injected Runtime without provenance fails closed until explicit refresh.
      active.barrier = result.evidenceReadGeneration ?? latest.current.readCompletion.requested + 1;
      active.phase = "refreshing";
    } else if (result.status === "ignored") {
      active.intent = null;
      active.barrier = null;
      active.phase = "editing";
    } else {
      active.phase = source === "retry" ? "review" : "ordinary_failure";
      active.message = "The upload did not finish. No success has been confirmed.";
      if (source === "form") active.intent = null;
    }
    paint();
    return result;
  }
  return {
    concealed,
    intent: active.intent,
    phase,
    ordinaryMessage: active.message,
    submitting: active.busy,
    readyToRetry: allowed() && !active.busy && phase === "review" && reviewed(),
    submit,
    finish() {
      if (!isCurrent() || active.busy || !reviewed()) return;
      active.intent = null; active.barrier = null; active.phase = "editing"; active.message = null; paint();
    },
    refreshAgain() {
      if (!allowed() || active.busy || !active.intent || active.barrier === null) return;
      active.barrier = latest.current.readCompletion.requested + 1;
      const requested = latest.current.refreshEvidence();
      if (!isCurrent()) return;
      if (typeof requested === "number") active.barrier = requested;
      active.phase = "refreshing";
      paint();
    },
  };
}
