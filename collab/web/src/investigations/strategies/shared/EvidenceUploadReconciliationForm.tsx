import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { StrategyStateNotice } from "./presentation.js";
import { useEvidenceUploadReconciliation, type FrozenUploadIntent, type ReconciliationUploadResult } from "./evidence-upload-reconciliation.js";

import "./evidence-upload-reconciliation.css";

const KINDS = ["attachment", "log", "email"] as const;

export interface EvidenceUploadReconciliationFormProps {
  readonly variant: "investigation-first" | "beacon";
  readonly scopeKey: string;
  readonly canRead: boolean;
  readonly canUpload: boolean;
  readonly canReadPrivate: boolean;
  readonly readCompletion: { readonly requested: number; readonly succeeded: number; readonly failed: number };
  readonly refreshEvidence: () => number | void;
  readonly upload: ((intent: FrozenUploadIntent) => Promise<ReconciliationUploadResult>) | null;
}
export function EvidenceUploadReconciliationForm(props: EvidenceUploadReconciliationFormProps) {
  const priorPrivate = useRef(props.canReadPrivate);
  const requirePrivacyChoice = useRef(false);
  if (priorPrivate.current && !props.canReadPrivate) requirePrivacyChoice.current = true;
  if (props.canReadPrivate) requirePrivacyChoice.current = false;
  const recheckPrivacy = requirePrivacyChoice.current;
  priorPrivate.current = props.canReadPrivate;
  return <ScopedEvidenceUploadForm key={props.scopeKey} {...props} recheckPrivacy={recheckPrivacy} />;
}
function ScopedEvidenceUploadForm(props: EvidenceUploadReconciliationFormProps & { readonly recheckPrivacy: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("attachment");
  const [summary, setSummary] = useState("");
  const [privacyClass, setPrivacyClass] = useState<FrozenUploadIntent["privacyClass"] | "">(props.recheckPrivacy && props.variant === "beacon" ? "" : props.canReadPrivate ? "owner_only" : "share_safe");
  const [privacyNotice, setPrivacyNotice] = useState(props.recheckPrivacy && props.variant === "beacon");
  const noticeId = useId();
  const command = props.upload;
  const reconciliation = useEvidenceUploadReconciliation({
    scopeKey: props.scopeKey,
    canSubmit: props.canRead && props.canUpload && command !== null,
    canReadPrivate: props.canReadPrivate,
    readCompletion: props.readCompletion,
    refreshEvidence: props.refreshEvidence,
    upload: async (intent) => command === null ? { status: "ignored" } : command(intent),
  });
  const locked = reconciliation.intent !== null && reconciliation.phase !== "editing" && reconciliation.phase !== "ordinary_failure";
  const className = props.variant === "beacon" ? "beacon__upload" : "investigation-first__upload";

  useLayoutEffect(() => {
    if (reconciliation.phase !== "editing" && reconciliation.phase !== "submitting") noticeRef.current?.focus();
  }, [reconciliation.phase, reconciliation.ordinaryMessage]);
  async function retry() {
    if (!reconciliation.intent) return;
    const result = await reconciliation.submit(reconciliation.intent, "retry");
    if (result?.status === "succeeded") { formRef.current?.reset(); setSummary(""); }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0] ?? null;
    if (!file || !command || !privacyClass) return;
    const requestedKind = (form.elements.namedItem("kind") as HTMLSelectElement | null)?.value ?? kind;
    const nextKind = requestedKind === "log" || requestedKind === "email" || requestedKind === "attachment" ? requestedKind : "attachment";
    const requestedPrivacy = (form.elements.namedItem("privacyClass") as HTMLSelectElement | null)?.value ?? privacyClass;
    if (requestedPrivacy === "owner_only" && !props.canReadPrivate) return;
    const nextPrivacy: FrozenUploadIntent["privacyClass"] = requestedPrivacy === "owner_only" ? "owner_only" : "share_safe";
    const nextSummary = (form.elements.namedItem("summary") as HTMLInputElement | null)?.value ?? summary;
    const intent: FrozenUploadIntent = { file, summary: nextSummary, kind: nextKind, privacyClass: nextPrivacy };
    const result = await reconciliation.submit(intent, "form");
    if (result?.status === "succeeded") {
      form.reset(); setSummary("");
    } else if (result?.status === "failed") {
      noticeRef.current?.focus();
    }
  }

  if (!props.canUpload) {
    return <StrategyStateNotice title="Evidence upload is read-only">You can review supporting material, but your current access cannot attach a file.</StrategyStateNotice>;
  }

  return (
    <form ref={formRef} className={`${className} evidence-reconciliation`} onSubmit={(event) => void onSubmit(event)} aria-busy={reconciliation.submitting}>
      <h4>{props.variant === "beacon" ? "Attach evidence" : "Add evidence"}</h4>
      {reconciliation.phase === "succeeded" ? <p id={noticeId} ref={noticeRef} tabIndex={-1} role="status">Evidence added to the inventory.</p> : null}
      {reconciliation.phase === "refreshing" ? (
        <p id={noticeId} ref={noticeRef} tabIndex={-1} role="status">The upload result is unconfirmed. The original file and privacy choice stay locked while the inventory refreshes.</p>
      ) : null}
      {reconciliation.phase === "refresh_failed" ? (
        <p id={noticeId} ref={noticeRef} tabIndex={-1} role="alert">The inventory refresh failed. Previously loaded evidence remains visible. Retry stays unavailable until a successful refresh.</p>
      ) : null}
      {reconciliation.phase === "review" && reconciliation.intent ? (
        <p id={noticeId} ref={noticeRef} tabIndex={-1} role="status">Review the refreshed inventory for {reconciliation.intent.file.name} ({reconciliation.intent.privacyClass === "owner_only" ? "owner only" : "share safe"}). Then retry that original upload or finish without another write.</p>
      ) : null}
      {reconciliation.ordinaryMessage ? <p id={noticeId} ref={noticeRef} tabIndex={-1} role="alert">{reconciliation.ordinaryMessage}</p> : null}
      {privacyNotice ? <p role="alert">Private evidence access changed. Choose a privacy level again and select a new file.</p> : null}
      <div className={props.variant === "beacon" ? "beacon__upload-grid" : "investigation-first__upload-grid"}>
      <label className={props.variant === "beacon" ? "beacon__field" : undefined}>{props.variant === "beacon" ? "File (server-configured limit)" : "File"}<input name="file" type="file" aria-describedby={locked ? noticeId : undefined} disabled={locked || reconciliation.submitting} /></label>
      <label className={props.variant === "beacon" ? "beacon__field" : undefined}>Kind
        <select name="kind" value={locked && reconciliation.intent ? reconciliation.intent.kind : kind} disabled={locked || reconciliation.submitting} onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}>
          {KINDS.map((option) => <option key={option} value={option}>{option === "attachment" ? "Attachment" : option === "log" ? "Log" : "Email"}</option>)}
        </select>
      </label>
      <label className={props.variant === "beacon" ? "beacon__field" : undefined}>Privacy
        <select name="privacyClass" value={locked && reconciliation.intent ? reconciliation.intent.privacyClass : privacyClass} disabled={locked || reconciliation.submitting} onChange={(event) => { setPrivacyClass(event.target.value === "owner_only" && props.canReadPrivate ? "owner_only" : "share_safe"); setPrivacyNotice(false); }}>
          {privacyNotice ? <option value="">Choose privacy</option> : null}
          {props.canReadPrivate ? <option value="owner_only">Owner only</option> : null}
          <option value="share_safe">Share safe</option>
        </select>
      </label>
      <label className={props.variant === "beacon" ? "beacon__field beacon__field--wide" : "investigation-first__field--wide"}>{props.variant === "beacon" ? "Why does this matter?" : "Annotation"}<input name="summary" placeholder="What is this file and why does it matter?" aria-describedby={locked ? noticeId : undefined} value={locked && reconciliation.intent ? reconciliation.intent.summary : summary} disabled={locked || reconciliation.submitting} onChange={(event) => setSummary(event.target.value)} /></label>
      </div>
      {reconciliation.phase === "review" ? (
        <div>
          <button type="button" disabled={!reconciliation.readyToRetry} onClick={() => void retry()}>Retry original upload</button>
          <button type="button" onClick={() => { reconciliation.finish(); formRef.current?.reset(); setSummary(""); }}>Finish without another write</button>
        </div>
      ) : (
        <button type="submit" disabled={reconciliation.submitting || command === null || locked || !privacyClass}>{reconciliation.submitting ? props.variant === "beacon" ? "Attaching…" : "Adding…" : props.variant === "beacon" ? "Attach evidence" : "Add to evidence inventory"}</button>
      )}
      {reconciliation.intent && !reconciliation.submitting ? <button type="button" onClick={reconciliation.refreshAgain}>Refresh inventory</button> : null}
    </form>
  );
}
