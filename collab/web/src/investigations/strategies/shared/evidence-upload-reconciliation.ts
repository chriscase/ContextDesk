import { useEffect, useRef, useState } from "react";

export interface FrozenUploadIntent {
  readonly file: File;
  readonly summary: string;
  readonly kind: string;
  readonly privacyClass: "owner_only" | "share_safe";
}

export type ReconciliationPhase =
  | "editing"
  | "submitting"
  | "unconfirmed"
  | "refreshing"
  | "refresh_failed"
  | "review"
  | "ordinary_failure";

export interface ReconciliationUploadResult {
  readonly status: "succeeded" | "failed" | "ignored";
  readonly error?: { readonly kind?: string; readonly reason?: string };
}

/**
 * Freeze the first validated upload and unlock retry only after an evidence
 * read that starts after that unknown result. Scope changes drop the intent
 * on the render that receives the new scope.
 */
export function useEvidenceUploadReconciliation(options: {
  readonly scopeKey: string;
  readonly canReadPrivate: boolean;
  readonly evidenceSignature: string;
  readonly upload: (intent: FrozenUploadIntent) => Promise<ReconciliationUploadResult>;
  readonly refreshEvidence: () => void;
}) {
  const [appliedScope, setAppliedScope] = useState(options.scopeKey);
  const [intent, setIntent] = useState<FrozenUploadIntent | null>(null);
  const [phase, setPhase] = useState<ReconciliationPhase>("editing");
  const [ordinaryMessage, setOrdinaryMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const barrier = useRef<number | null>(null);
  const completions = useRef(0);
  const previousSignature = useRef(options.evidenceSignature);
  const uploadRef = useRef(options.upload);
  const refreshRef = useRef(options.refreshEvidence);
  uploadRef.current = options.upload;
  refreshRef.current = options.refreshEvidence;

  if (previousSignature.current !== options.evidenceSignature) {
    previousSignature.current = options.evidenceSignature;
    completions.current += 1;
  }
  const concealed = appliedScope !== options.scopeKey;
  const publishedIntent = concealed ? null : intent;
  const publishedPhase: ReconciliationPhase = concealed ? "editing" : phase;
  const readyToRetry = !concealed
    && phase === "review"
    && intent !== null
    && barrier.current !== null
    && completions.current > barrier.current
    && !(intent.privacyClass === "owner_only" && !options.canReadPrivate);

  useEffect(() => {
    setAppliedScope(options.scopeKey);
    setIntent(null);
    setPhase("editing");
    setOrdinaryMessage(null);
    setSubmitting(false);
    barrier.current = null;
  }, [options.scopeKey]);

  async function submit(next: FrozenUploadIntent, source: "form" | "retry"): Promise<void> {
    if (inFlight.current || submitting) return;
    if (source === "retry") {
      if (!readyToRetry || intent === null) return;
      if (intent.privacyClass === "owner_only" && !options.canReadPrivate) return;
    }
    inFlight.current = true;
    const frozen = source === "retry" && intent !== null ? intent : next;
    if (source === "form") setIntent(frozen);
    setSubmitting(true);
    setPhase("submitting");
    let result: ReconciliationUploadResult;
    try {
      result = await uploadRef.current(frozen);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
    if (result.status === "succeeded") {
      setIntent(null);
      setPhase("editing");
      setOrdinaryMessage(null);
      barrier.current = null;
      return;
    }
    if (result.status === "failed" && result.error?.reason === "commit_outcome_unknown") {
      barrier.current = completions.current;
      setIntent(frozen);
      setPhase("refreshing");
      setOrdinaryMessage(null);
      refreshRef.current();
      return;
    }
    if (result.status === "ignored") {
      setPhase(intent === null ? "editing" : phase);
      return;
    }
    setPhase("ordinary_failure");
    setOrdinaryMessage("The upload did not finish. You can correct the form and try again.");
    if (source === "form") setIntent(null);
  }

  const unlocked = !concealed
    && publishedIntent !== null
    && barrier.current !== null
    && completions.current > barrier.current
    && !(publishedIntent.privacyClass === "owner_only" && !options.canReadPrivate);
  const refreshFailed = unlocked && options.evidenceSignature.endsWith("|failed");
  const visiblePhase: ReconciliationPhase = concealed
    ? "editing"
    : refreshFailed
      ? "refresh_failed"
      : unlocked && publishedPhase === "refreshing"
        ? "review"
        : publishedPhase;

  return {
    concealed,
    intent: publishedIntent,
    phase: visiblePhase,
    ordinaryMessage: concealed ? null : ordinaryMessage,
    submitting,
    readyToRetry: visiblePhase === "review" && unlocked,
    submit,
    finish() {
      setIntent(null);
      setPhase("editing");
      setOrdinaryMessage(null);
      barrier.current = null;
    },
    refreshAgain() {
      if (concealed || publishedIntent === null) return;
      barrier.current = completions.current;
      setPhase("refreshing");
      refreshRef.current();
    },
  };
}
