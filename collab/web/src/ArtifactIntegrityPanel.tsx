import { useId, useState, type ReactNode } from "react";

export interface IntegrityArtifactRecord {
  readonly id: string;
  readonly kind: string;
  readonly filename: string | null;
  readonly uri?: string | null;
  readonly mediaType?: string | null;
  readonly byteLength?: number | null;
  readonly contentHash: string | null;
  readonly expectedHash?: string | null;
  readonly verificationStatus: string | null;
  readonly privacyClass: string;
  readonly uploaderId: string;
  readonly sourceId?: string | null;
  readonly relativePath?: string | null;
  readonly intakeBatchId?: string | null;
  readonly summaryContributionId?: string | null;
}

export interface IntegritySnapshotRecord {
  readonly id: string;
  readonly fingerprint: string;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly ordinal: number;
  }[];
  readonly visibility: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ArtifactIntegrityPanelProps {
  readonly caseId: string;
  readonly artifact: IntegrityArtifactRecord;
  readonly snapshots: readonly IntegritySnapshotRecord[];
  readonly uploaderLabel: string;
  readonly snapshotCreatorLabel: (identityId: string) => string;
  readonly children?: ReactNode;
}

export type RecordedHashState = "unavailable" | "no_expected" | "match" | "mismatch";

export function recordedHashState(artifact: IntegrityArtifactRecord): RecordedHashState {
  if (!artifact.contentHash) return "unavailable";
  if (!artifact.expectedHash) return "no_expected";
  return artifact.contentHash === artifact.expectedHash ? "match" : "mismatch";
}

function recordedHashSummary(state: RecordedHashState): string {
  if (state === "match") return "The recorded content and expected hashes match.";
  if (state === "mismatch") return "The recorded content and expected hashes differ.";
  if (state === "no_expected") return "No expected comparison hash is recorded.";
  return "No stored content hash is recorded.";
}

function recorded(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  return typeof value === "number" ? value.toLocaleString() : value;
}

function statusLabel(value: string | null): string {
  return value ? value.replaceAll("_", " ") : "Not recorded";
}

function byteLengthLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? "Not recorded" : `${value.toLocaleString()} bytes`;
}

function artifactLabel(artifact: IntegrityArtifactRecord): string {
  return artifact.filename?.trim() || artifact.uri?.trim() || artifact.kind || "Unnamed evidence";
}

/**
 * Read-only composition of already-authorized artifact and snapshot facts.
 * It deliberately performs no requests and makes no human-review judgment.
 */
export function ArtifactIntegrityPanel({
  caseId,
  artifact,
  snapshots,
  uploaderLabel,
  snapshotCreatorLabel,
  children,
}: ArtifactIntegrityPanelProps) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const hashState = recordedHashState(artifact);
  const containingSnapshots = snapshots.flatMap((snapshot, index) => {
    const member = snapshot.evidence.find((item) => item.evidenceId === artifact.id);
    return member ? [{ snapshot, index, ordinal: member.ordinal }] : [];
  });
  const label = artifactLabel(artifact);

  return (
    <div className="artifact-integrity-shell">
      <details
        className="artifact-integrity"
        data-integrity-scope={`${caseId}\u0000${artifact.id}\u0000${artifact.contentHash ?? "no-content-hash"}`}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          Artifact identity &amp; integrity
          <span className="sr-only"> for {label}</span>
        </summary>
        {open ? <section className="artifact-integrity__body" aria-label={`${label} artifact identity and integrity`}>
        <div className="artifact-integrity__heading">
          <div>
            <p className="case-memory__eyebrow">Recorded evidence facts</p>
            <h5 id={headingId}>Recorded artifact</h5>
          </div>
          <span className={`artifact-integrity__hash-state artifact-integrity__hash-state--${hashState}`}>
            {hashState === "match" ? "Recorded hashes match" : hashState === "mismatch" ? "Recorded hashes differ" : "Hash comparison unavailable"}
          </span>
        </div>
        <p className="artifact-integrity__boundary">
          Technical integrity facts do not establish human judgment or investigative relevance.
        </p>

        <div className="artifact-integrity__columns">
          <section aria-labelledby={`${headingId}-identity`}>
            <h6 id={`${headingId}-identity`}>Identity and source</h6>
            <dl className="artifact-integrity__facts">
              <div><dt>Evidence ID</dt><dd>{recorded(artifact.id)}</dd></div>
              <div><dt>Kind</dt><dd>{recorded(artifact.kind)}</dd></div>
              <div><dt>Media type</dt><dd>{recorded(artifact.mediaType)}</dd></div>
              <div><dt>Size</dt><dd>{byteLengthLabel(artifact.byteLength)}</dd></div>
              <div><dt>Privacy</dt><dd>{recorded(artifact.privacyClass)}</dd></div>
              <div><dt>Uploader</dt><dd>{recorded(uploaderLabel)}</dd></div>
              <div><dt>Source record</dt><dd>{recorded(artifact.sourceId)}</dd></div>
              <div><dt>Recorded path</dt><dd>{recorded(artifact.relativePath)}</dd></div>
              <div><dt>Intake batch</dt><dd>{recorded(artifact.intakeBatchId)}</dd></div>
              <div><dt>Upload summary</dt><dd>{recorded(artifact.summaryContributionId)}</dd></div>
            </dl>
          </section>

          <section aria-labelledby={`${headingId}-integrity`}>
            <h6 id={`${headingId}-integrity`}>Technical integrity</h6>
            <dl className="artifact-integrity__facts">
              <div><dt>Recorded technical status</dt><dd>{statusLabel(artifact.verificationStatus)}</dd></div>
              <div className="artifact-integrity__fact--wide"><dt>Content hash</dt><dd><code>{recorded(artifact.contentHash)}</code></dd></div>
              <div className="artifact-integrity__fact--wide"><dt>Expected hash</dt><dd><code>{recorded(artifact.expectedHash)}</code></dd></div>
            </dl>
            <p className={`artifact-integrity__finding artifact-integrity__finding--${hashState}`}>
              {recordedHashSummary(hashState)}
            </p>
            {artifact.kind === "file_server_ref" ? (
              <p className="artifact-integrity__reference-note">
                This is the provider result recorded for the reference. This inspector does not perform a live recheck, and the referenced bytes are not stored here.
              </p>
            ) : null}
          </section>
        </div>

        <section className="artifact-integrity__snapshots" aria-labelledby={`${headingId}-snapshots`}>
          <h6 id={`${headingId}-snapshots`}>Frozen snapshot inclusion</h6>
          <p>
            Inclusion records which evidence identity a snapshot used. It does not establish the correctness of this evidence or of a later conclusion.
          </p>
          {containingSnapshots.length === 0 ? (
            <p className="case-memory__empty">No loaded frozen snapshot includes this artifact.</p>
          ) : (
            <ol>
              {containingSnapshots.map(({ snapshot, index, ordinal }) => (
                <li key={snapshot.id}>
                  <strong>Snapshot S{index}</strong>
                  <span>Position {(ordinal + 1).toLocaleString()} · {recorded(snapshot.visibility)} · frozen by {snapshotCreatorLabel(snapshot.createdBy)}</span>
                  <code>{recorded(snapshot.fingerprint)}</code>
                </li>
              ))}
            </ol>
          )}
        </section>

        </section> : null}
      </details>
      {children ? <div className="artifact-integrity__existing-tools">{children}</div> : null}
    </div>
  );
}
