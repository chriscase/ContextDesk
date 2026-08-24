import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";

interface InventoryItem {
  kind: "artifact" | "contribution";
  id: string;
  label: string;
  privacyClass: string;
  contentHash: string | null;
  excludedByDefault: boolean;
}

interface ScanFinding {
  rule: string;
  path: string;
  excerpt: string;
}

type ExportKind = "brief" | "package";
type InventoryStatus = "loading" | "ready" | "error";
type PortableStatus = "loading" | "ready" | "unavailable";

interface PortableCapabilities {
  exportAvailable: boolean;
  dryRunPreflightAvailable: boolean;
  maximumArchiveBytes: number;
  apply: { available: false; reason: string };
}

interface PortableActor {
  sourceActorId: string;
}

interface PortableSelection {
  archive: unknown;
  actorIds: string[];
}

interface PortablePreflightResult {
  report: {
    counts: { create: number; update: number; conflict: number; blocked: number };
    collisionPolicy: string;
    warnings: unknown[];
    referentialIntegrityFailures: unknown[];
    idRemap: unknown[];
    reconstructionStatus: string;
    exactReconstruction: boolean;
  };
  privacy: {
    classification: string;
    ownerOnlyEvidence: number;
    shareSafeEvidence: number;
    inlineBlobCount: number;
    omittedBlobCount: number;
    privateBlobCount: number;
    redactedBlobCount: number;
  };
  omitted: unknown[];
  unsupported: string[];
  authorization: {
    sourceRolesTrusted: false;
    destinationMembershipGranted: false;
    destinationRoleGranted: false;
    destinationCapabilityGranted: false;
  };
  apply: { available: false; reason: string };
}

function safeFinding(finding: ScanFinding): ScanFinding {
  if (/(credential|secret|token|authorization|request[_-]?id|endpoint|url)/i.test(finding.rule)) {
    return { ...finding, excerpt: "[redacted]" };
  }
  return {
    ...finding,
    excerpt: finding.excerpt.length > 160 ? `${finding.excerpt.slice(0, 157)}…` : finding.excerpt,
  };
}

const NETWORK_ERROR_MESSAGE =
  "The export request did not complete — the server returned no result. Nothing was exported and " +
  "your variant and evidence selection are unchanged; retry with the same export button.";

const PORTABLE_NETWORK_ERROR =
  "The archive request did not complete. Nothing was downloaded or changed; check your connection and try again.";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function portableActors(value: unknown): PortableActor[] | null {
  const archive = asRecord(value);
  const investigation = asRecord(archive?.investigation);
  if (!investigation || !Array.isArray(investigation.actors)) return null;
  const actors: PortableActor[] = [];
  const seen = new Set<string>();
  for (const value of investigation.actors) {
    const actor = asRecord(value);
    if (!actor || typeof actor.sourceActorId !== "string" || !actor.sourceActorId.trim()) {
      return null;
    }
    if (seen.has(actor.sourceActorId)) return null;
    seen.add(actor.sourceActorId);
    actors.push({ sourceActorId: actor.sourceActorId });
  }
  return actors.sort((left, right) =>
    left.sourceActorId < right.sourceActorId
      ? -1
      : left.sourceActorId > right.sourceActorId
        ? 1
        : 0,
  );
}

function portableErrorMessage(status: number): string {
  if (status === 413) return "This archive is larger than this War Room accepts.";
  if (status === 401 || status === 403) {
    return "Your current account is not authorized to check portable investigation archives.";
  }
  return "This archive could not be checked. It may be malformed, incomplete, or incompatible.";
}

function readablePrivacy(value: string): string {
  return value.replaceAll("_", " ");
}

export function ExportPanel(props: { caseId: string; canWrite: boolean; canLead: boolean }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus>("loading");
  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [variant, setVariant] = useState<"owner_only" | "share_safe">("owner_only");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scaffold, setScaffold] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [findings, setFindings] = useState<ScanFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [completed, setCompleted] = useState<ExportKind | null>(null);
  const [portableStatus, setPortableStatus] = useState<PortableStatus>("loading");
  const [portableCapabilities, setPortableCapabilities] = useState<PortableCapabilities | null>(
    null,
  );
  const [portableSelection, setPortableSelection] = useState<PortableSelection | null>(null);
  const [portablePending, setPortablePending] = useState<"download" | "preflight" | null>(null);
  const [portableMessage, setPortableMessage] = useState<string | null>(null);
  const [portableError, setPortableError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PortablePreflightResult | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let stale = false;
    setInventoryStatus("loading");
    void protectedApiFetch(`/api/cases/${props.caseId}/export/inventory`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`inventory request failed (${res.status})`);
        return (await res.json()) as { items?: InventoryItem[] };
      })
      .then((body) => {
        if (stale) return;
        setItems(body.items ?? []);
        setInventoryStatus("ready");
      })
      .catch(() => {
        if (stale) return;
        setInventoryStatus("error");
      });
    return () => {
      stale = true;
    };
  }, [props.caseId, inventoryAttempt]);

  useEffect(() => {
    if (!props.canLead) {
      setPortableStatus("unavailable");
      return;
    }
    let stale = false;
    setPortableStatus("loading");
    void protectedApiFetch("/api/portable-investigations/capabilities")
      .then(async (res) => {
        if (!res.ok) throw new Error("capabilities unavailable");
        return (await res.json()) as PortableCapabilities;
      })
      .then((body) => {
        if (stale) return;
        if (
          body.exportAvailable !== true ||
          body.dryRunPreflightAvailable !== true ||
          !Number.isSafeInteger(body.maximumArchiveBytes) ||
          body.maximumArchiveBytes <= 0 ||
          body.apply?.available !== false
        ) {
          setPortableStatus("unavailable");
          return;
        }
        setPortableCapabilities(body);
        setPortableStatus("ready");
      })
      .catch(() => {
        if (!stale) setPortableStatus("unavailable");
      });
    return () => {
      stale = true;
    };
  }, [props.canLead]);

  const allowed = variant === "share_safe" ? props.canLead : props.canWrite;
  const selectableItems = items.filter((item) => !item.excludedByDefault);
  const excludedCount = items.length - selectableItems.length;
  const selectedCount = selectableItems.filter(
    (item) => selected[`${item.kind}:${item.id}`],
  ).length;
  const permissionNote = !allowed
    ? variant === "share_safe"
      ? "share_safe exports require the case lead role."
      : "owner_only exports require write access to this case."
    : !props.canLead
      ? "share_safe is available to case leads only."
      : null;
  if (!props.canWrite && !props.canLead) return null;

  async function postExport(kind: ExportKind, path: string, body: unknown) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(kind);
    setCompleted(null);
    setError(null);
    setFindings([]);
    try {
      const res = await protectedApiFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        error?: string;
        findings?: ScanFinding[];
        markdown?: string;
        payload?: { snapshotIdentity?: string };
      };
      if (!res.ok) {
        setError(json.error ?? "export failed");
        setFindings((json.findings ?? []).map(safeFinding));
        setMarkdown("");
        setSnapshot(null);
        return;
      }
      setMarkdown(json.markdown ?? "");
      setSnapshot(json.payload?.snapshotIdentity ?? null);
      setCompleted(kind);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      setMarkdown("");
      setSnapshot(null);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function exportBrief(event: FormEvent) {
    event.preventDefault();
    await postExport("brief", `/api/cases/${props.caseId}/export/brief`, { variant });
  }

  async function exportPackage(event: FormEvent) {
    event.preventDefault();
    const selection = items
      .filter((item) => selected[`${item.kind}:${item.id}`] && !item.excludedByDefault)
      .map((item) => ({ kind: item.kind, id: item.id }));
    if (selection.length === 0) return;
    await postExport("package", `/api/cases/${props.caseId}/export/package`, {
      variant,
      selection,
      promptScaffold: scaffold || null,
    });
  }

  async function downloadPortableArchive() {
    if (!props.canLead || portableStatus !== "ready" || portablePending) return;
    setPortablePending("download");
    setPortableError(null);
    setPortableMessage(null);
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/portable-archive`);
      if (!response.ok) {
        setPortableError(portableErrorMessage(response.status));
        return;
      }
      const archive = await response.json();
      const contents = JSON.stringify(archive, null, 2);
      const url = URL.createObjectURL(
        new Blob([contents], { type: "application/json;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      const safeId = props.caseId.replace(/[^a-zA-Z0-9_-]/g, "-");
      anchor.href = url;
      anchor.download = `contextdesk-investigation-${safeId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setPortableMessage(
        "Complete investigation archive downloaded. Store it according to its privacy classification.",
      );
    } catch {
      setPortableError(PORTABLE_NETWORK_ERROR);
    } finally {
      setPortablePending(null);
    }
  }

  async function selectPortableArchive(event: ChangeEvent<HTMLInputElement>) {
    setPortableSelection(null);
    setPreflight(null);
    setPortableMessage(null);
    setPortableError(null);
    const file = event.target.files?.[0];
    if (!file) return;
    if (!portableCapabilities || file.size > portableCapabilities.maximumArchiveBytes) {
      setPortableError("This archive is larger than this War Room accepts.");
      event.target.value = "";
      return;
    }
    try {
      const archive = JSON.parse(await file.text()) as unknown;
      const actors = portableActors(archive);
      if (!actors) {
        setPortableError("This file is not a valid portable investigation archive.");
        event.target.value = "";
        return;
      }
      setPortableSelection({ archive, actorIds: actors.map((actor) => actor.sourceActorId) });
      setPortableMessage(
        `Archive selected. ${actors.length} historical participant${actors.length === 1 ? "" : "s"} will remain attribution only.`,
      );
    } catch {
      setPortableError("This file is not a valid portable investigation archive.");
      event.target.value = "";
    }
  }

  async function runPortablePreflight() {
    if (!props.canLead || !portableSelection || portablePending) return;
    setPortablePending("preflight");
    setPortableError(null);
    setPortableMessage(null);
    setPreflight(null);
    try {
      const response = await protectedApiFetch("/api/portable-investigations/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          archive: portableSelection.archive,
          mode: "dry_run",
          collisionPolicy: "remap_deterministic",
          identityMap: portableSelection.actorIds.map((sourceActorId) => ({
            sourceActorId,
            action: "preserve_historical_external",
            destinationActorId: null,
          })),
        }),
      });
      if (!response.ok) {
        setPortableError(portableErrorMessage(response.status));
        return;
      }
      const result = (await response.json()) as PortablePreflightResult;
      setPreflight(result);
      setPortableMessage(
        "Dry-run check complete. No investigation, user, membership, role, or permission was created or changed.",
      );
    } catch {
      setPortableError(PORTABLE_NETWORK_ERROR);
    } finally {
      setPortablePending(null);
    }
  }

  return (
    <section className="export" aria-busy={pending !== null ? true : undefined}>
      <h3 className="export__title">Export</h3>
      <p className="export__copy">
        Projection only — export never edits the case. <code>share_safe</code> is
        default-deny for raw owner-only artifacts and must pass a privacy scan.
      </p>
      <form
        className="composer"
        aria-label="Export triage brief"
        onSubmit={(e) => void exportBrief(e)}
      >
        <label className="export__label">
          Variant
          <select
            className="login__input"
            value={variant}
            disabled={pending !== null}
            onChange={(e) => setVariant(e.target.value as "owner_only" | "share_safe")}
          >
            <option value="owner_only">owner_only</option>
            <option value="share_safe" disabled={!props.canLead}>
              share_safe
            </option>
          </select>
        </label>
        {permissionNote ? <p className="case-memory__note">{permissionNote}</p> : null}
        <button className="login__submit" type="submit" disabled={!allowed || pending !== null}>
          Export triage brief
        </button>
      </form>
      <form
        className="composer"
        aria-label="Export selected-evidence prompt package"
        onSubmit={(e) => void exportPackage(e)}
      >
        <fieldset
          className="export__select"
          aria-busy={inventoryStatus === "loading" ? true : undefined}
        >
          <legend>Selected evidence</legend>
          {inventoryStatus === "loading" ? (
            <p className="case-memory__note" role="status">
              Loading evidence inventory…
            </p>
          ) : null}
          {inventoryStatus === "error" ? (
            <>
              <p className="case-memory__error" role="alert">
                The evidence inventory could not be loaded. Check your connection, then retry.
              </p>
              <button
                className="case-memory__secondary-button"
                type="button"
                onClick={() => setInventoryAttempt((attempt) => attempt + 1)}
              >
                Retry loading inventory
              </button>
            </>
          ) : null}
          {inventoryStatus === "ready" && items.length === 0 ? (
            <p className="case-memory__empty">
              This case has no exportable evidence yet, so a selected-evidence prompt package
              cannot be exported.
            </p>
          ) : null}
          {items.map((item) => (
            <label key={`${item.kind}:${item.id}`} className="export__item">
              <input
                type="checkbox"
                disabled={item.excludedByDefault}
                checked={Boolean(selected[`${item.kind}:${item.id}`])}
                onChange={(e) =>
                  setSelected((cur) => ({
                    ...cur,
                    [`${item.kind}:${item.id}`]: e.target.checked,
                  }))
                }
              />
              <span>
                {item.kind} · {item.label} · {item.privacyClass}
                {item.excludedByDefault ? " (excluded by default)" : ""}
              </span>
            </label>
          ))}
          <p className="case-memory__note">
            This package contains only the evidence you select for another analysis tool. It is
            not a full investigation backup and cannot restore this case on another War Room.
          </p>
          {inventoryStatus === "ready" && items.length > 0 ? (
            <p className="case-memory__note" aria-live="polite">
              {selectedCount} of {selectableItems.length} selectable item
              {selectableItems.length === 1 ? "" : "s"} selected.
              {selectedCount === 0
                ? " Select at least one item — a package with no selected evidence cannot be exported."
                : ""}
              {excludedCount > 0
                ? ` ${excludedCount} item${excludedCount === 1 ? " is" : "s are"} excluded by default and never included in packages.`
                : ""}
            </p>
          ) : null}
        </fieldset>
        <label className="export__label">
          Optional prompt scaffold
          <textarea
            className="login__input"
            value={scaffold}
            onChange={(e) => setScaffold(e.target.value)}
            rows={2}
          />
        </label>
        <button
          className="login__submit"
          type="submit"
          disabled={!allowed || pending !== null || selectedCount === 0}
        >
          Export selected-evidence prompt package
        </button>
      </form>
      {pending ? (
        <p className="case-memory__note" role="status">
          {pending === "brief"
            ? "Exporting triage brief…"
            : "Exporting selected-evidence prompt package…"} Export buttons stay disabled until
          it finishes; your selection is preserved.
        </p>
      ) : null}
      {error ? (
        <p className="export__error" role="alert">
          {error}
        </p>
      ) : null}
      {findings.length > 0 ? (
        <>
          <p className="case-memory__note">
            The privacy scan blocked this export; nothing left the case. Excerpts below are
            redacted where they may contain sensitive values.
          </p>
          <ul className="export__findings" aria-label="Privacy scan findings">
            {findings.map((f, i) => (
              <li key={`${f.rule}-${i}`}>
                <span className="imported-run__text">
                  {f.rule} · {f.path} · {f.excerpt}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {completed ? (
        <p className="export__copy" role="status">
          {completed === "brief"
            ? "Triage brief exported."
            : "Selected-evidence prompt package exported."} The result below is a read-only
          projection of the case.
        </p>
      ) : null}
      {snapshot ? (
        <p className="export__copy">
          Snapshot identity: <code className="imported-run__text">{snapshot}</code> — the content
          hash of this export's manifest; identical inputs reproduce the same identity.
        </p>
      ) : null}
      {markdown ? (
        <pre
          className="export__markdown"
          tabIndex={0}
          role="region"
          aria-label="Exported markdown"
        >
          {markdown}
        </pre>
      ) : null}
      <section className="export__portable" aria-labelledby="portable-archive-heading">
        <div className="export__portable-heading">
          <div>
            <p className="export__eyebrow">Move or preserve an investigation</p>
            <h4 id="portable-archive-heading">Complete investigation archive</h4>
          </div>
          <span className="export__badge">Lead access</span>
        </div>
        <p className="export__copy">
          Download the complete portable record for safekeeping or transfer. Unlike the
          selected-evidence package above, this archive represents the investigation record and
          its included evidence.
        </p>
        <div className="export__portable-grid">
          <article className="export__portable-card">
            <h5>1. Download this investigation</h5>
            <p>
              Creates one clearly named JSON file. The export is read-only and does not change the
              investigation.
            </p>
            <button
              className="login__submit"
              type="button"
              disabled={!props.canLead || portableStatus !== "ready" || portablePending !== null}
              onClick={() => void downloadPortableArchive()}
            >
              {portablePending === "download"
                ? "Preparing archive…"
                : "Download complete investigation archive"}
            </button>
          </article>
          <article className="export__portable-card">
            <h5>2. Check an archive before moving it</h5>
            <p>
              Select an archive and run a dry-run check. Historical people remain attribution
              only; this never grants destination access or permissions.
            </p>
            <label className="export__file-label" htmlFor="portable-archive-file">
              Portable investigation JSON
            </label>
            <input
              id="portable-archive-file"
              className="export__file"
              type="file"
              accept="application/json,.json"
              disabled={!props.canLead || portableStatus !== "ready" || portablePending !== null}
              onChange={(event) => void selectPortableArchive(event)}
            />
            <button
              className="case-memory__secondary-button"
              type="button"
              disabled={!portableSelection || portablePending !== null}
              onClick={() => void runPortablePreflight()}
            >
              {portablePending === "preflight" ? "Checking archive…" : "Run dry-run check"}
            </button>
          </article>
        </div>
        {!props.canLead ? (
          <p className="case-memory__note">
            A case lead or administrator must download or check complete investigation archives.
          </p>
        ) : portableStatus === "loading" ? (
          <p className="case-memory__note" role="status">
            Checking portable archive availability…
          </p>
        ) : portableStatus === "unavailable" ? (
          <p className="case-memory__note">
            Portable archive tools are unavailable on this War Room right now.
          </p>
        ) : null}
        <p className="export__portable-policy">
          ID collisions are remapped deterministically, so the same archive and destination state
          produce the same plan. Source roles are never trusted. Historical identities do not
          become destination users, members, leads, administrators, or capability holders.
        </p>
        <p className="export__portable-warning">
          Restore/apply is unavailable. This War Room can export and safely inspect an archive, but
          it cannot yet reconstruct that archive on another installation with proven atomic
          rollback. No apply control is provided.
        </p>
        <div className="export__portable-status" aria-live="polite" aria-atomic="true">
          {portableMessage ? <p>{portableMessage}</p> : null}
          {portableError ? (
            <p className="export__error" role="alert">
              {portableError}
            </p>
          ) : null}
        </div>
        {preflight ? (
          <section
            className="export__preflight"
            aria-labelledby="portable-preflight-heading"
            tabIndex={0}
          >
            <div className="export__portable-heading">
              <div>
                <p className="export__eyebrow">Dry-run result</p>
                <h5 id="portable-preflight-heading">Archive readiness summary</h5>
              </div>
              <span className="export__badge">
                {readablePrivacy(preflight.report.reconstructionStatus)}
              </span>
            </div>
            <dl className="export__summary-grid">
              <div>
                <dt>Objects to create</dt>
                <dd>{preflight.report.counts.create}</dd>
              </div>
              <div>
                <dt>Existing objects updated</dt>
                <dd>{preflight.report.counts.update}</dd>
              </div>
              <div>
                <dt>Collisions</dt>
                <dd>{preflight.report.counts.conflict}</dd>
              </div>
              <div>
                <dt>Blocked objects</dt>
                <dd>{preflight.report.counts.blocked}</dd>
              </div>
              <div>
                <dt>Deterministic ID remaps</dt>
                <dd>{preflight.report.idRemap.length}</dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>{readablePrivacy(preflight.privacy.classification)}</dd>
              </div>
            </dl>
            <ul className="export__preflight-notes">
              <li>
                Included evidence: {preflight.privacy.shareSafeEvidence} share-safe and{" "}
                {preflight.privacy.ownerOnlyEvidence} owner-only.
              </li>
              <li>
                Content state: {preflight.privacy.inlineBlobCount} included, {preflight.privacy.omittedBlobCount} omitted, {preflight.privacy.privateBlobCount} private, and{" "}
                {preflight.privacy.redactedBlobCount} redacted.
              </li>
              <li>
                {preflight.omitted.length} reconstruction limitation
                {preflight.omitted.length === 1 ? "" : "s"}; {preflight.unsupported.length} state
                {preflight.unsupported.length === 1 ? " is" : "s are"} not represented by this
                archive version.
              </li>
              <li>
                {preflight.report.warnings.length} warning
                {preflight.report.warnings.length === 1 ? "" : "s"};{" "}
                {preflight.report.referentialIntegrityFailures.length} broken reference
                {preflight.report.referentialIntegrityFailures.length === 1 ? "" : "s"}.
              </li>
              <li>Restore/apply remains unavailable after this check.</li>
            </ul>
          </section>
        ) : null}
      </section>
    </section>
  );
}
