import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const ARTIFACT_KINDS = ["log", "email", "attachment", "file_server_ref"] as const;
const PRIVACY_CLASSES = ["owner_only", "share_safe"] as const;
const MAX_UPLOAD_BYTES = 1_000_000;
const MAX_ERROR_LENGTH = 240;

interface ArtifactView {
  id: string;
  kind: string;
  filename: string | null;
  contentHash: string | null;
  verificationStatus: string | null;
  privacyClass: string;
  uploaderId: string;
}

interface SnapshotView {
  id: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  evidence: { evidenceId: string; ordinal: number }[];
  visibility: string;
  createdAt: string;
  createdBy: string;
}

interface BoardFinding {
  id: string;
  bucket: "known" | "unknown" | "agreed" | "disputed" | "newly_concluded";
  statement: string;
  evidenceRefs: string[];
  contributionRefs: string[];
  agreement: string;
  confidence: string;
  basis?: string;
}

const BUCKETS: BoardFinding["bucket"][] = [
  "known",
  "unknown",
  "agreed",
  "disputed",
  "newly_concluded",
];

const BUCKET_DETAILS: Record<
  BoardFinding["bucket"],
  { title: string; description: string; empty: string }
> = {
  known: {
    title: "Known",
    description: "Directly supported by verified evidence or a supported hypothesis.",
    empty: "Nothing recorded yet.",
  },
  unknown: {
    title: "Unknown",
    description: "Unverified evidence and hypotheses still awaiting support.",
    empty:
      "No open unknowns recorded. Only recorded unknowns appear here; an empty list is not proof there are none.",
  },
  agreed: {
    title: "Agreed",
    description: "Independent hypotheses cite the same evidence. Agreement is not correctness.",
    empty: "Nothing recorded yet.",
  },
  disputed: {
    title: "Disputed",
    description: "Contradicted hypotheses that need human adjudication.",
    empty: "No disputes recorded.",
  },
  newly_concluded: {
    title: "Newly concluded",
    description: "Human-accepted decisions from this case's experiment reviews.",
    empty: "No accepted decision recorded yet.",
  },
};

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "not available";
}

function errorText(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (typeof body === "object" && body !== null && "error" in body) {
        const error = (body as { error?: unknown }).error;
        if (typeof error === "string") return boundedError(error, fallback);
      }
      return fallback;
    })
    .catch(() => fallback);
}

function boundedError(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : trimmed;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Selected file could not be read."));
        return;
      }
      const separator = reader.result.indexOf(",");
      resolve(separator === -1 ? reader.result : reader.result.slice(separator + 1));
    };
    reader.onerror = () => reject(new Error("Selected file could not be read."));
    reader.readAsDataURL(file);
  });
}

export function CaseBoardPanel(props: {
  caseId: string;
  canWrite: boolean;
  canLead: boolean;
  readOnly: boolean;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotView[]>([]);
  const [board, setBoard] = useState<{ snapshotId: string | null; findings: BoardFinding[]; notice: string } | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (snapshotId?: string | null) => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const suffix = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : "";
      const [evidenceResponse, snapshotsResponse, boardResponse] = await Promise.all([
        fetch(`/api/cases/${props.caseId}/evidence`),
        fetch(`/api/cases/${props.caseId}/snapshots`),
        fetch(`/api/cases/${props.caseId}/board${suffix}`),
      ]);
      if (!evidenceResponse.ok) throw new Error(await errorText(evidenceResponse, "Evidence could not be loaded."));
      if (!snapshotsResponse.ok) throw new Error(await errorText(snapshotsResponse, "Snapshots could not be loaded."));
      if (!boardResponse.ok) throw new Error(await errorText(boardResponse, "Case board could not be loaded."));
      if (!isCurrent()) return;
      const evidenceBody = (await evidenceResponse.json()) as { artifacts?: ArtifactView[] };
      const snapshotsBody = (await snapshotsResponse.json()) as { snapshots?: SnapshotView[] };
      const boardBody = (await boardResponse.json()) as { snapshotId: string | null; findings: BoardFinding[]; notice: string };
      setArtifacts(evidenceBody.artifacts ?? []);
      setSnapshots(snapshotsBody.snapshots ?? []);
      setBoard(boardBody);
      setSelectedSnapshotId(boardBody.snapshotId);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "Case memory could not be loaded.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [props.caseId]);

  useEffect(() => {
    setSelectedEvidence([]);
    void load(null);
  }, [load]);

  async function freezeSnapshot() {
    setError(null);
    const response = await fetch(`/api/cases/${props.caseId}/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidenceIds: selectedEvidence }),
    });
    if (!response.ok) {
      setError(await errorText(response, "Snapshot could not be frozen."));
      return;
    }
    const snapshot = (await response.json()) as SnapshotView;
    setSelectedEvidence([]);
    await load(snapshot.id);
    window.dispatchEvent(
      new CustomEvent("contextdesk:snapshot-frozen", {
        detail: { caseId: props.caseId, snapshotId: snapshot.id },
      }),
    );
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.readOnly || !props.canWrite || uploading) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const fileControl = form.elements.namedItem("file");
    const selectedFile = fileControl instanceof HTMLInputElement ? fileControl.files?.[0] : undefined;
    if (!selectedFile) {
      setError("Choose an evidence file to upload.");
      return;
    }
    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      setError("Selected file is too large. Files must be 1 MB or smaller.");
      return;
    }
    const summary = String(data.get("summary") ?? "").trim();
    if (!summary) {
      setError("Add a short evidence summary.");
      return;
    }

    const freezeAfterUpload = props.canLead && data.get("freezeAfterUpload") === "on";

    setError(null);
    setUploading(true);
    try {
      const contentBase64 = await readFileAsBase64(selectedFile);
      const response = await fetch(`/api/cases/${props.caseId}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: selectedFile.name,
          mediaType: selectedFile.type || "application/octet-stream",
          contentBase64,
          kind: String(data.get("kind") ?? "log"),
          summary,
          privacyClass: String(data.get("privacyClass") ?? "owner_only"),
        }),
      });
      if (!response.ok) {
        setError(await errorText(response, "Evidence could not be uploaded."));
        return;
      }
      form.reset();
      if (freezeAfterUpload) {
        const uploaded = (await response.json().catch(() => null)) as
          | { artifact?: { id?: string } }
          | null;
        const artifactId = uploaded?.artifact?.id;
        if (!artifactId) {
          setError("Upload succeeded but the snapshot was not frozen: the new evidence id was unavailable. Freeze it from the evidence board.");
          await load(null);
          return;
        }
        const evidenceIds = [...new Set([...selectedEvidence, artifactId])];
        const snapshotResponse = await fetch(`/api/cases/${props.caseId}/snapshots`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ evidenceIds }),
        });
        if (!snapshotResponse.ok) {
          setError(await errorText(snapshotResponse, "Upload succeeded but the snapshot could not be frozen."));
          await load(null);
          return;
        }
        const snapshot = (await snapshotResponse.json()) as SnapshotView;
        setSelectedEvidence([]);
        await load(snapshot.id);
        window.dispatchEvent(
          new CustomEvent("contextdesk:snapshot-frozen", {
            detail: { caseId: props.caseId, snapshotId: snapshot.id },
          }),
        );
        return;
      }
      await load(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? boundedError(cause.message, "Evidence could not be uploaded.")
          : "Evidence could not be uploaded.",
      );
    } finally {
      setUploading(false);
    }
  }

  const byBucket = (bucket: BoardFinding["bucket"]) =>
    (board?.findings ?? []).filter((finding) => finding.bucket === bucket);

  return (
    <section className="case-memory" aria-labelledby="case-memory-heading">
      <div className="case-memory__header">
        <div>
          <p className="case-memory__eyebrow">War-room memory</p>
          <h3 id="case-memory-heading">Evidence and snapshots</h3>
          <p className="case-memory__copy">Freeze exactly what a later triage is allowed to see. New evidence creates a new lineage point.</p>
        </div>
        <span className="case-memory__badge">{artifacts.length} evidence · {snapshots.length} snapshots</span>
      </div>
      {error ? <p className="case-memory__error" role="alert">{error}</p> : null}
      {loading ? <p className="case-memory__empty">Loading case memory…</p> : null}
      {!loading ? (
        <>
          <div className="case-memory__grid">
            <section className="case-memory__card" aria-labelledby="case-evidence-heading">
              <h4 id="case-evidence-heading">Evidence board</h4>
              {artifacts.length === 0 ? <p className="case-memory__empty">No evidence has been registered yet.</p> : null}
              <ul className="case-memory__list">
                {artifacts.map((artifact) => (
                  <li key={artifact.id} className="case-memory__item">
                    {!props.readOnly && props.canLead ? (
                      <input
                        type="checkbox"
                        aria-label={`Include ${artifact.filename ?? artifact.kind} in snapshot`}
                        checked={selectedEvidence.includes(artifact.id)}
                        onChange={(event) =>
                          setSelectedEvidence((current) =>
                            event.target.checked
                              ? [...current, artifact.id]
                              : current.filter((id) => id !== artifact.id),
                          )
                        }
                      />
                    ) : null}
                    <div>
                      <strong>{artifact.filename ?? artifact.kind}</strong>
                      <span className="case-memory__meta">
                        {artifact.kind} · {artifact.verificationStatus ?? "verification unknown"} · {artifact.uploaderId}
                      </span>
                      <span className="case-memory__meta">hash {shortHash(artifact.contentHash)} · {artifact.privacyClass}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {!props.readOnly && props.canWrite ? (
                <form
                  className="case-memory__upload-form"
                  aria-labelledby="case-evidence-upload-heading"
                  onSubmit={(event) => void uploadEvidence(event)}
                >
                  <h5 id="case-evidence-upload-heading">Upload evidence</h5>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-file">
                    File
                    <input
                      className="login__input"
                      id="case-evidence-file"
                      name="file"
                      type="file"
                      required
                    />
                  </label>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-summary">
                    Summary
                    <textarea
                      className="login__input"
                      id="case-evidence-summary"
                      name="summary"
                      required
                      rows={3}
                    />
                  </label>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-kind">
                    Artifact kind
                    <select className="login__input" id="case-evidence-kind" name="kind" defaultValue="log">
                      {ARTIFACT_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-privacy">
                    Privacy class
                    <select
                      className="login__input"
                      id="case-evidence-privacy"
                      name="privacyClass"
                      defaultValue={PRIVACY_CLASSES[0]}
                    >
                      <option value="owner_only">owner_only</option>
                      <option value="share_safe">share_safe</option>
                    </select>
                  </label>
                  {props.canLead ? (
                    <label className="case-memory__upload-field case-memory__freeze-toggle">
                      <span>
                        <input name="freezeAfterUpload" type="checkbox" /> Freeze a snapshot with
                        this upload
                      </span>
                      <small>
                        One step: the sanitized file is uploaded and a snapshot is frozen with it
                        (plus any evidence already selected above). Upload sanitized content only;
                        the server's media and privacy policy still applies.
                      </small>
                    </label>
                  ) : null}
                  <button className="login__submit" type="submit" disabled={uploading}>
                    {uploading ? "Uploading…" : "Upload evidence"}
                  </button>
                </form>
              ) : null}
              {!props.readOnly && props.canLead ? (
                <button className="login__submit" type="button" onClick={() => void freezeSnapshot()}>
                  Freeze selected evidence ({selectedEvidence.length})
                </button>
              ) : null}
            </section>
            <section className="case-memory__card" aria-labelledby="case-snapshots-heading">
              <h4 id="case-snapshots-heading">Snapshot lineage</h4>
              {snapshots.length === 0 ? <p className="case-memory__empty">No snapshot frozen yet. The current board is provisional.</p> : null}
              <div className="case-memory__snapshots">
                {snapshots.map((snapshot, index) => (
                  <button
                    className={snapshot.id === selectedSnapshotId ? "case-memory__snapshot is-selected" : "case-memory__snapshot"}
                    type="button"
                    key={snapshot.id}
                    aria-current={snapshot.id === selectedSnapshotId ? "page" : undefined}
                    onClick={() => {
                      setSelectedSnapshotId(snapshot.id);
                      void load(snapshot.id);
                    }}
                  >
                    <strong>S{index}</strong>
                    <span>{snapshot.evidence.length} items · {snapshot.createdBy}</span>
                    <small>{shortHash(snapshot.fingerprint)}</small>
                  </button>
                ))}
              </div>
              <p className="case-memory__note">Runs bound to a snapshot never silently widen to newer evidence.</p>
            </section>
          </div>
          <section className="case-memory__card case-memory__board" aria-labelledby="case-board-heading">
            <div className="case-memory__board-header">
              <div>
                <h4 id="case-board-heading">What the case currently supports</h4>
                <p className="case-memory__note">Agreement is not proof of correctness. Gold remains a separate human benchmark.</p>
              </div>
              {board?.snapshotId ? <span className="case-memory__badge">bound to selected snapshot</span> : null}
            </div>
            <div className="case-memory__board-grid">
              {BUCKETS.map((bucket) => (
                <div key={bucket} className="case-memory__bucket">
                  <h5>{BUCKET_DETAILS[bucket].title}</h5>
                  <p className="case-memory__bucket-hint">{BUCKET_DETAILS[bucket].description}</p>
                  {byBucket(bucket).length === 0 ? (
                    <p className="case-memory__empty">{BUCKET_DETAILS[bucket].empty}</p>
                  ) : null}
                  {byBucket(bucket).map((finding) => (
                    <article key={finding.id} className="case-memory__finding">
                      {finding.basis === "accepted_decision" ? (
                        <span className="case-memory__finding-tag">Accepted decision</span>
                      ) : null}
                      <p>{finding.statement}</p>
                      <small>
                        agreement {finding.agreement} · confidence {finding.confidence} ·{" "}
                        {finding.evidenceRefs.length} evidence{" "}
                        {finding.evidenceRefs.length === 1 ? "ref" : "refs"}
                      </small>
                    </article>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
