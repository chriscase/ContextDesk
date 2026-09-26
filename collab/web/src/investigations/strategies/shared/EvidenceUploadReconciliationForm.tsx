import { useState, type FormEvent } from "react";
import { selectResourceView, useInvestigationRuntime, type ArtifactKind, type PrivacyClass } from "../../runtime/public.js";
import { StrategyStateNotice } from "./index.js";
import { useEvidenceUploadReconciliation, type FrozenUploadIntent } from "./evidence-upload-reconciliation.js";

const KINDS = ["attachment", "log", "email"] as const;

export function EvidenceUploadReconciliationForm(props: { readonly variant: "investigation-first" | "beacon" }) {
  const runtime = useInvestigationRuntime();
  const view = selectResourceView(runtime.resources.evidence);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("attachment");
  const [summary, setSummary] = useState("");
  const [privacyClass, setPrivacyClass] = useState<PrivacyClass>(runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe");
  const evidenceSignature = view.availability === "available"
    ? `available|${view.refresh}|${view.value.length}`
    : view.availability === "unavailable"
      ? "unavailable|failed"
      : view.availability;
  const investigationId = runtime.resources.investigation.status === "ready"
    ? runtime.resources.investigation.value.id
    : "";
  const scopeKey = [
    runtime.presentationScopeKey,
    investigationId,
    runtime.capabilities.canUpload ? "upload" : "no-upload",
    runtime.capabilities.canReadPrivate ? "private" : "public",
  ].join("\0");
  const command = runtime.commands.uploadEvidence;
  const reconciliation = useEvidenceUploadReconciliation({
    scopeKey,
    canReadPrivate: runtime.capabilities.canReadPrivate,
    evidenceSignature,
    refreshEvidence: () => runtime.refresh.evidence(),
    upload: async (intent) => {
      if (command === null) return { status: "ignored" };
      return command({
        file: intent.file,
        summary: intent.summary,
        kind: intent.kind as ArtifactKind,
        privacyClass: intent.privacyClass,
      });
    },
  });
  const locked = reconciliation.intent !== null && reconciliation.phase !== "editing" && reconciliation.phase !== "ordinary_failure";
  const className = props.variant === "beacon" ? "beacon__upload" : "investigation-first__upload";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) {
      const frozen = reconciliation.intent;
      if (frozen) await reconciliation.submit(frozen, "retry");
      return;
    }
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0] ?? null;
    if (!file || !command) return;
    const requestedKind = (form.elements.namedItem("kind") as HTMLSelectElement | null)?.value ?? kind;
    const nextKind = requestedKind === "log" || requestedKind === "email" || requestedKind === "attachment" ? requestedKind : "attachment";
    const requestedPrivacy = (form.elements.namedItem("privacyClass") as HTMLSelectElement | null)?.value ?? privacyClass;
    const nextPrivacy: PrivacyClass = runtime.capabilities.canReadPrivate && requestedPrivacy === "owner_only"
      ? "owner_only"
      : "share_safe";
    const nextSummary = (form.elements.namedItem("summary") as HTMLInputElement | null)?.value ?? summary;
    const intent: FrozenUploadIntent = { file, summary: nextSummary, kind: nextKind, privacyClass: nextPrivacy };
    const before = reconciliation.phase;
    await reconciliation.submit(intent, "form");
    if (before === "editing") {
      form.reset();
    }
  }

  if (!runtime.capabilities.canUpload) {
    return <StrategyStateNotice title="Evidence upload is read-only">You can review supporting material, but your current access cannot attach a file.</StrategyStateNotice>;
  }

  return (
    <form className={className} onSubmit={(event) => void onSubmit(event)} aria-busy={reconciliation.submitting}>
      <h4>{props.variant === "beacon" ? "Attach evidence" : "Add evidence"}</h4>
      {reconciliation.phase === "unconfirmed" || reconciliation.phase === "refreshing" ? (
        <p role="status">The upload result is unconfirmed. The original file and privacy choice stay locked while the inventory refreshes.</p>
      ) : null}
      {reconciliation.phase === "refresh_failed" ? (
        <p role="alert">The inventory refresh failed. Previously loaded evidence remains visible. Retry stays unavailable until a successful refresh.</p>
      ) : null}
      {reconciliation.phase === "review" && reconciliation.intent ? (
        <p role="status">Review the refreshed inventory for {reconciliation.intent.file.name} ({reconciliation.intent.privacyClass === "owner_only" ? "owner only" : "share safe"}). Then retry that original upload or finish without another write.</p>
      ) : null}
      {reconciliation.ordinaryMessage ? <p role="alert">{reconciliation.ordinaryMessage}</p> : null}
      <label>File<input name="file" type="file" disabled={locked || reconciliation.submitting} /></label>
      <label>Kind
        <select name="kind" value={locked && reconciliation.intent ? reconciliation.intent.kind : kind} disabled={locked || reconciliation.submitting} onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}>
          {KINDS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label>Privacy
        <select name="privacyClass" value={locked && reconciliation.intent ? reconciliation.intent.privacyClass : privacyClass} disabled={locked || reconciliation.submitting} onChange={(event) => setPrivacyClass(event.target.value === "owner_only" && runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe")}>
          <option value="share_safe">Share safe</option>
          {runtime.capabilities.canReadPrivate ? <option value="owner_only">Owner only</option> : null}
        </select>
      </label>
      <label>Summary<input name="summary" value={locked && reconciliation.intent ? reconciliation.intent.summary : summary} disabled={locked || reconciliation.submitting} onChange={(event) => setSummary(event.target.value)} /></label>
      {reconciliation.phase === "review" ? (
        <div>
          <button type="button" disabled={!reconciliation.readyToRetry} onClick={() => { if (reconciliation.intent) void reconciliation.submit(reconciliation.intent, "retry"); }}>Retry original upload</button>
          <button type="button" onClick={reconciliation.finish}>Finish without another write</button>
        </div>
      ) : (
        <button type="submit" disabled={reconciliation.submitting || command === null || locked}>{reconciliation.submitting ? "Uploading…" : "Add to evidence inventory"}</button>
      )}
      {reconciliation.phase === "refresh_failed" ? <button type="button" onClick={reconciliation.refreshAgain}>Refresh inventory</button> : null}
    </form>
  );
}
