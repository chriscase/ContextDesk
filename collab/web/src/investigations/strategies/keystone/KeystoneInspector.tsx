import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
} from "../../runtime/public.js";
import type { KeyboardEvent } from "react";
import {
  StrategyBadge,
  StrategyStateNotice,
} from "../shared/index.js";
import {
  byteLengthLabel,
  contributionsLinkedToEvidence,
  evidenceName,
  recordedText,
  type KeystoneEvidenceRow,
  type KeystoneInspectorTab,
} from "./model.js";

interface KeystoneInspectorProps {
  readonly investigation: CaseV1;
  readonly selectedEvidence: KeystoneEvidenceRow | null;
  readonly contributions: readonly ContributionV1[];
  readonly contributionsState: "available" | "loading" | "unavailable";
  readonly tab: KeystoneInspectorTab;
  readonly onTabChange: (tab: KeystoneInspectorTab) => void;
}

const TABS: readonly { id: KeystoneInspectorTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "reasoning", label: "Reasoning" },
  { id: "record", label: "Record" },
];

function MetadataList({ evidence }: { readonly evidence: ArtifactV1 }) {
  return (
    <dl className="keystone-strategy__metadata">
      <div><dt>Evidence ID</dt><dd>{recordedText(evidence.id)}</dd></div>
      <div><dt>Investigation ID</dt><dd>{recordedText(evidence.caseId)}</dd></div>
      <div><dt>Name</dt><dd>{evidenceName(evidence)}</dd></div>
      <div><dt>Kind</dt><dd>{evidence.kind}</dd></div>
      <div><dt>URI</dt><dd>{recordedText(evidence.uri)}</dd></div>
      <div><dt>Media type</dt><dd>{recordedText(evidence.mediaType)}</dd></div>
      <div><dt>Size</dt><dd>{byteLengthLabel(evidence.byteLength)}</dd></div>
      <div><dt>Verification</dt><dd>{recordedText(evidence.verificationStatus)}</dd></div>
      <div><dt>Privacy</dt><dd>{evidence.privacyClass}</dd></div>
      <div><dt>Source</dt><dd>{recordedText(evidence.sourceId)}</dd></div>
      <div><dt>Uploader</dt><dd>{recordedText(evidence.uploaderId)}</dd></div>
      <div><dt>Path</dt><dd>{recordedText(evidence.relativePath)}</dd></div>
      <div><dt>Intake batch</dt><dd>{recordedText(evidence.intakeBatchId)}</dd></div>
      <div><dt>Content hash</dt><dd>{recordedText(evidence.contentHash)}</dd></div>
      <div><dt>Expected hash</dt><dd>{recordedText(evidence.expectedHash)}</dd></div>
      <div><dt>Annotation contribution</dt><dd>{recordedText(evidence.summaryContributionId)}</dd></div>
    </dl>
  );
}

function ContributionLedger({
  rows,
  state,
}: {
  readonly rows: readonly ContributionV1[];
  readonly state: KeystoneInspectorProps["contributionsState"];
}) {
  if (state === "loading") {
    return <StrategyStateNotice busy>Loading recorded contributions…</StrategyStateNotice>;
  }
  if (state === "unavailable") {
    return (
      <StrategyStateNotice tone="danger" role="alert" title="Recorded contributions unavailable">
        Evidence remains available, but its contribution links could not be read.
      </StrategyStateNotice>
    );
  }
  if (rows.length === 0) {
    return (
      <StrategyStateNotice title="No linked contribution">
        No recorded contribution links the selected evidence in the available ledger.
      </StrategyStateNotice>
    );
  }
  return (
    <ol className="keystone-strategy__ledger">
      {rows.map((contribution) => (
        <li key={contribution.id}>
          <div className="keystone-strategy__ledger-heading">
            <StrategyBadge tone={contribution.hypothesisStatus ? "accent" : "neutral"}>
              {contribution.kind}
            </StrategyBadge>
            {contribution.hypothesisStatus
              ? <StrategyBadge>{contribution.hypothesisStatus}</StrategyBadge>
              : null}
          </div>
          <p>{recordedText(contribution.body)}</p>
          <dl className="keystone-strategy__inline-metadata">
            <div><dt>Author</dt><dd>{recordedText(contribution.authorUsername)}</dd></div>
            <div><dt>Recorded</dt><dd>{recordedText(contribution.createdAt)}</dd></div>
            <div><dt>Revision</dt><dd>{contribution.revision}</dd></div>
          </dl>
        </li>
      ))}
    </ol>
  );
}

function CanonicalRecord({ investigation }: { readonly investigation: CaseV1 }) {
  const context = investigation.investigationContext;
  return (
    <dl className="keystone-strategy__record">
      <div><dt>Problem statement</dt><dd>{recordedText(investigation.problemStatement)}</dd></div>
      <div><dt>Affected parties</dt><dd>{recordedText(investigation.affectedParties)}</dd></div>
      <div><dt>Impact</dt><dd>{recordedText(investigation.impact)}</dd></div>
      <div><dt>Scope</dt><dd>{recordedText(investigation.scope)}</dd></div>
      <div><dt>Occurred at</dt><dd>{recordedText(investigation.occurredAt)}</dd></div>
      <div><dt>Occurrence precision</dt><dd>{investigation.occurredAtPrecision}</dd></div>
      <div><dt>Occurrence time zone</dt><dd>{investigation.occurredAtZone}</dd></div>
      <div><dt>Product</dt><dd>{recordedText(context?.productName)}</dd></div>
      <div><dt>Version</dt><dd>{recordedText(context?.version)}</dd></div>
      <div><dt>Build</dt><dd>{recordedText(context?.build)}</dd></div>
      <div><dt>Component</dt><dd>{recordedText(context?.component)}</dd></div>
      <div><dt>Environment</dt><dd>{recordedText(context?.environment)}</dd></div>
      <div><dt>Organization</dt><dd>{recordedText(context?.organization)}</dd></div>
      <div><dt>Created at</dt><dd>{recordedText(investigation.createdAt)}</dd></div>
      <div><dt>Created by</dt><dd>{recordedText(investigation.createdBy)}</dd></div>
      <div><dt>Situation version</dt><dd>{investigation.situationVersion}</dd></div>
      <div><dt>Retention class</dt><dd>{recordedText(investigation.retentionClass)}</dd></div>
      <div><dt>Legal hold</dt><dd>{investigation.legalHold ? "Yes" : "No"}</dd></div>
      <div className="keystone-strategy__record-wide">
        <dt>Participants</dt>
        <dd>{investigation.participants.length > 0
          ? <ul>{investigation.participants.map((participant) => <li key={participant.identityId}>{recordedText(participant.username)}</li>)}</ul>
          : "Not recorded"}</dd>
      </div>
      <div className="keystone-strategy__record-wide">
        <dt>Open questions</dt>
        <dd>{investigation.openQuestions.length > 0
          ? <ul>{investigation.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
          : "Not recorded"}</dd>
      </div>
    </dl>
  );
}

export function KeystoneInspector({
  investigation,
  selectedEvidence,
  contributions,
  contributionsState,
  tab,
  onTabChange,
}: KeystoneInspectorProps) {
  const selected = selectedEvidence?.evidence ?? null;
  const linkedContributions = contributionsLinkedToEvidence(
    selected,
    selectedEvidence?.annotation ?? null,
    contributions,
  );
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: KeystoneInspectorTab) {
    const index = TABS.findIndex(({ id }) => id === current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    const next = TABS[nextIndex];
    if (!next) return;
    event.preventDefault();
    onTabChange(next.id);
    document.getElementById(`keystone-tab-${next.id}`)?.focus();
  }
  return (
    <div className="keystone-strategy__inspector">
      <div className="keystone-strategy__tabs" role="tablist" aria-label="Investigation inspector">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`keystone-tab-${item.id}`}
            aria-controls="keystone-inspector-panel"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => moveTab(event, item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id="keystone-inspector-panel"
        role="tabpanel"
        aria-labelledby={`keystone-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "details"
          ? selected
            ? <MetadataList evidence={selected} />
            : <StrategyStateNotice title="Choose evidence">Inspect an evidence row to see its recorded metadata.</StrategyStateNotice>
          : null}
        {tab === "reasoning"
          ? <ContributionLedger rows={linkedContributions} state={contributionsState} />
          : null}
        {tab === "record" ? <CanonicalRecord investigation={investigation} /> : null}
      </div>
    </div>
  );
}
