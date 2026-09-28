import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { parseExportEnvelope, parseExportInventory, type ExportEnvelopeV1, type ExportInventoryItemV1 } from "@cd-collab/contracts/export";
import { protectedApiFetch } from "./protected-api.js";

type InventoryItem = ExportInventoryItemV1;

interface ScanFinding {
  rule: string;
  path: string;
  excerpt: string;
}

type ExportKind = "brief" | "package";
type InventoryStatus = "loading" | "ready" | "error" | "unavailable";
type PortableStatus = "loading" | "ready" | "unavailable";

interface PortableCapabilities {
  exportAvailable: boolean;
  dryRunPreflightAvailable: boolean;
  maximumArchiveBytes: number;
  apply: {
    available: boolean;
    requiresExactReconstruction?: boolean;
    typedConfirmation?: string;
    coordination?: "single_instance" | "postgres_transactional";
    confirmationRestartDurable?: boolean;
  };
}

interface PortableActor {
  sourceActorId: string;
}

interface PortableSelection {
  archive: unknown;
  actorIds: string[];
}

interface PortableIdentityResolution {
  sourceActorId: string;
  action: string;
  destinationActorId: string | null;
}

interface PortableApplyResult {
  status: "applied" | "idempotent_replay";
  investigationId: string;
  deepLink: string;
}

interface PortablePreflightResult {
  report: {
    counts: { create: number; update: number; conflict: number; blocked: number };
    collisionPolicy: string;
    warnings: unknown[];
    referentialIntegrityFailures: unknown[];
    idRemap: unknown[];
    identityResolutions?: PortableIdentityResolution[];
    reconstructionStatus: string;
    exactReconstruction: boolean;
    transportHash?: string;
    destinationCatalogDigest?: string;
    semanticFingerprint?: string;
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
  apply: {
    available: boolean;
    requiresExactReconstruction: boolean;
    typedConfirmation: string;
    confirmationToken: string | null;
    expiresAt: string | null;
    reason: string | null;
    coordination: "single_instance" | "postgres_transactional";
    confirmationRestartDurable: boolean;
  };
}

function safeFinding(finding: ScanFinding): ScanFinding | null {
  if (!["credential", "internal_hostname", "raw_private_evidence"].includes(finding.rule)) return null;
  const path = finding.path.length <= 120 && /^\$(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d{1,5}\])+$/.test(finding.path)
    ? finding.path : "[redacted path]";
  return { rule: finding.rule, path, excerpt: "[redacted]" };
}

const NETWORK_ERROR_MESSAGE =
  "The export response was interrupted, so no checked file is ready. The server may have processed the request; retry only if you need a new export.";
const INVALID_EXPORT_MESSAGE =
  "The server returned an invalid export result. Nothing is available to download; retry the export or contact an administrator.";
const OBJECT_URL_TTL_MS = 5_000;

interface ObjectUrlLease { url: string; timer: number | null }

function revokeDownloads(leases: Set<ObjectUrlLease>): void {
  for (const lease of leases) {
    if (lease.timer !== null) window.clearTimeout(lease.timer);
    URL.revokeObjectURL(lease.url);
  }
  leases.clear();
}

function startDownload(blob: Blob, filename: string, leases: Set<ObjectUrlLease>): void {
  const url = URL.createObjectURL(blob);
  const lease: ObjectUrlLease = { url, timer: null };
  leases.add(lease);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    lease.timer = window.setTimeout(() => {
      if (leases.delete(lease)) URL.revokeObjectURL(url);
    }, OBJECT_URL_TTL_MS);
  } catch (error) {
    if (leases.delete(lease)) URL.revokeObjectURL(url);
    throw error;
  } finally {
    anchor?.remove();
  }
}

function safeFilenamePart(value: string): string {
  return value.slice(0, 80).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "investigation";
}

function envelopeCaseId(envelope: ExportEnvelopeV1): string {
  return envelope.kind === "brief"
    ? (envelope.payload as Extract<ExportEnvelopeV1["payload"], { header: unknown }>).header.caseId
    : (envelope.payload as Extract<ExportEnvelopeV1["payload"], { caseId: unknown }>).caseId;
}

function envelopeSnapshotIdentity(envelope: ExportEnvelopeV1): string | null {
  return envelope.kind === "package" ? (envelope.payload as Extract<ExportEnvelopeV1["payload"], { snapshotIdentity: unknown }>).snapshotIdentity : null;
}

function parseDeliveryEnvelope(value: unknown, kind: ExportKind, privacy: "owner_only" | "share_safe", caseId: string): ExportEnvelopeV1 {
  const envelope = parseExportEnvelope(value);
  if (envelope.kind !== kind || envelope.privacyClass !== privacy || envelopeCaseId(envelope) !== caseId) {
    throw new Error("export request identity mismatch");
  }
  return envelope;
}

function exportFailure(status: number, body: unknown): string {
  const code = asRecord(body)?.error;
  if (status === 401 || status === 403) return "Your current account is not authorized to export this investigation.";
  if (status === 404) return "This investigation is no longer available for export.";
  if (status === 422 && code === "privacy_scan_failed") return "Privacy scan blocked this export (privacy_scan_failed). Review the findings and selection.";
  return "The export could not be prepared. Review the selection and try again.";
}

const PORTABLE_NETWORK_ERROR =
  "The archive request did not complete. Nothing was downloaded or changed; check your connection and try again.";

const PORTABLE_APPLY_NETWORK_ERROR =
  "The restore response was interrupted, so the outcome is not confirmed. Run the dry-run check again; an already committed restore returns an actor-scoped replay instead of creating another investigation.";

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

function applyErrorMessage(status: number, code: string | null): string {
  if (status === 401 || status === 403) {
    return "Your current account is not authorized to restore this archive.";
  }
  if (code === "stale_destination_catalog") {
    return "The destination catalog changed after the dry-run check. Run the check again.";
  }
  if (code === "exact_reconstruction_required") {
    return "This archive is not an exact reconstruction and cannot be restored.";
  }
  if (
    code === "identity_map_mismatch" ||
    code === "actor_mismatch" ||
    code === "confirmation_invalid"
  ) {
    return "This restore confirmation is no longer valid. Run the dry-run check again.";
  }
  if (code === "apply_refused") {
    return "The restore was not committed. Staged evidence and metadata were rolled back.";
  }
  if (code === "apply_outcome_unknown") {
    return PORTABLE_APPLY_NETWORK_ERROR;
  }
  return "This archive could not be restored. The server did not confirm a committed restore; run the dry-run check again before retrying.";
}

function readableAction(value: string): string {
  if (value === "preserve_historical_external") return "Keep as historical attribution";
  if (value === "map_existing") return "Map to an existing destination person";
  return value.replaceAll("_", " ");
}

function readablePrivacy(value: string): string {
  return value.replaceAll("_", " ");
}

export function ExportPanel(props: {
  caseId: string; canWrite: boolean; canLead: boolean;
  identityKey?: string; authorityKey?: string;
  canRead?: boolean; canExport?: boolean; canReadPrivate?: boolean;
}) {
  const canRead = props.canRead ?? (props.canWrite || props.canLead);
  const canExport = props.canExport ?? (props.canWrite || props.canLead);
  const canReadPrivate = props.canReadPrivate ?? (props.canWrite || props.canLead);
  const scopeKey = JSON.stringify([props.caseId, props.identityKey, props.authorityKey,
    canRead, canExport, canReadPrivate, props.canLead]);
  // Each scope visit has a distinct identity, including A → B → A in one mount.
  // A callback retained from the first A must never become current again.
  const scopeVisit = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const activeScope = useRef<typeof scopeVisit | null>(null);
  const preparedRef = useRef<ExportEnvelopeV1 | null>(null);
  const isCurrentScope = () => activeScope.current === scopeVisit;
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus>("loading");
  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [variant, setVariant] = useState<"owner_only" | "share_safe">(canReadPrivate ? "owner_only" : "share_safe");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scaffold, setScaffold] = useState("");
  const [exportResult, setExportResult] = useState<ExportEnvelopeV1 | null>(null);
  const [findings, setFindings] = useState<ScanFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [exportScopeKey, setExportScopeKey] = useState(scopeKey);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [portableStatus, setPortableStatus] = useState<PortableStatus>("loading");
  const [portableCapabilities, setPortableCapabilities] = useState<PortableCapabilities | null>(
    null,
  );
  const [portableSelection, setPortableSelection] = useState<PortableSelection | null>(null);
  const [portablePending, setPortablePending] = useState<
    "download" | "preflight" | "apply" | null
  >(null);
  const [portableMessage, setPortableMessage] = useState<string | null>(null);
  const [portableError, setPortableError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PortablePreflightResult | null>(null);
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [applyResult, setApplyResult] = useState<PortableApplyResult | null>(null);
  const inFlight = useRef(false);
  const exportGeneration = useRef(0);
  // Object URLs still waiting to be revoked. Unmounting revokes them at once
  // rather than leaving them addressable for the rest of the session.
  const objectUrls = useRef(new Set<ObjectUrlLease>());
  const exportObjectUrls = useRef(new Set<ObjectUrlLease>());
  useLayoutEffect(() => {
    activeScope.current = scopeVisit;
    inFlight.current = false;
    setExportScopeKey(scopeKey);
    preparedRef.current = null;
    setExportResult(null);
    setVariant(canReadPrivate ? "owner_only" : "share_safe");
    setSelected({});
    setScaffold("");
    setItems([]);
    setInventoryStatus("loading");
    setFindings([]);
    setError(null);
    setPending(null);
    setDownloadNotice(null);
    setPortableSelection(null);
    setPreflight(null);
    setApplyResult(null);
    setTypedConfirmation("");
    setPortableMessage(null);
    setPortableError(null);
    setPortablePending(null);
    setPortableStatus(props.canLead ? "loading" : "unavailable");
    return () => {
      activeScope.current = null;
      preparedRef.current = null;
      exportGeneration.current += 1;
      revokeDownloads(exportObjectUrls.current);
      revokeDownloads(objectUrls.current);
    };
  }, [scopeVisit]);

  useEffect(() => {
    if (!canRead || !canExport) return;
    let stale = false;
    setInventoryStatus("loading");
    void protectedApiFetch(`/api/cases/${props.caseId}/export/inventory`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 404) return null;
          throw new Error("inventory failed");
        }
        return parseExportInventory(await res.json());
      })
      .then((inventory) => {
        if (stale || !isCurrentScope()) return;
        if (inventory === null) {
          setItems([]);
          setInventoryStatus("unavailable");
          return;
        }
        if (inventory.caseId !== props.caseId) throw new Error("wrong inventory case");
        setItems(inventory.items);
        setSelected((previous) => Object.fromEntries(
          inventory.items.filter((item) => !item.excludedByDefault && previous[`${item.kind}:${item.id}`])
            .map((item) => [`${item.kind}:${item.id}`, true]),
        ));
        setInventoryStatus("ready");
      })
      .catch(() => {
        if (stale || !isCurrentScope()) return;
        setInventoryStatus("error");
      });
    return () => { stale = true; };
  }, [scopeKey, inventoryAttempt]);

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
        if (stale || !isCurrentScope()) return;
        if (
          body.exportAvailable !== true ||
          body.dryRunPreflightAvailable !== true ||
          !Number.isSafeInteger(body.maximumArchiveBytes) ||
          body.maximumArchiveBytes <= 0 ||
          body.apply?.available !== true ||
          body.apply.requiresExactReconstruction !== true ||
          body.apply.typedConfirmation !== "RESTORE"
        ) {
          setPortableStatus("unavailable");
          return;
        }
        setPortableCapabilities(body);
        setPortableStatus("ready");
      })
      .catch(() => {
        if (!stale && isCurrentScope()) setPortableStatus("unavailable");
      });
    return () => {
      stale = true;
    };
  }, [scopeKey]);

  const allowed = canRead && canExport && (variant === "share_safe" || canReadPrivate);
  const selectableItems = items.filter((item) => !item.excludedByDefault);
  const excludedCount = items.length - selectableItems.length;
  const selectedCount = selectableItems.filter(
    (item) => selected[`${item.kind}:${item.id}`],
  ).length;
  const permissionNote = !allowed
    ? variant === "share_safe"
      ? "Export access is unavailable for this account."
      : "Owner-only exports require private-evidence access."
    : !canReadPrivate
      ? "Only share-safe export is available to this account."
      : null;
  const exportStateIsCurrent = exportScopeKey === scopeKey && allowed;
  const currentExportResult = exportStateIsCurrent &&
    (exportResult?.privacyClass !== "owner_only" || canReadPrivate) ? exportResult : null;
  const currentPending = exportStateIsCurrent ? pending : null;
  const currentError = exportStateIsCurrent ? error : null;
  const currentFindings = exportStateIsCurrent ? findings : [];
  if ((!canRead || !canExport) && !props.canLead) return null;

  function clearPrepared() {
    preparedRef.current = null;
    setExportResult(null);
    setDownloadNotice(null);
    revokeDownloads(exportObjectUrls.current);
  }

  async function postExport(kind: ExportKind, path: string, body: {
    variant: "owner_only" | "share_safe";
    selection?: { kind: "artifact" | "contribution"; id: string }[];
    promptScaffold?: string | null;
  }) {
    if (!isCurrentScope() || !allowed || inFlight.current) return;
    const requestGeneration = exportGeneration.current;
    const requestedCaseId = props.caseId;
    const requestedVariant = variant;
    inFlight.current = true;
    setExportScopeKey(scopeKey);
    setDownloadNotice(null);
    setPending(kind);
    clearPrepared();
    setError(null);
    setFindings([]);
    try {
      const res = await protectedApiFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        if (requestGeneration !== exportGeneration.current || !isCurrentScope()) return;
        setError(INVALID_EXPORT_MESSAGE);
        return;
      }
      if (requestGeneration !== exportGeneration.current || !isCurrentScope()) return;
      if (!res.ok) {
        const record = asRecord(json);
        setError(exportFailure(res.status, json));
        setFindings(
          Array.isArray(record?.findings)
            ? record.findings
                .map((value) => asRecord(value))
                .filter(
                  (value): value is Record<string, unknown> =>
                    value !== null &&
                    typeof value.rule === "string" &&
                    typeof value.path === "string" &&
                    typeof value.excerpt === "string",
                )
                .map((value) =>
                  safeFinding({
                    rule: value.rule as string,
                    path: value.path as string,
                    excerpt: value.excerpt as string,
                  }),
                )
                .filter((value): value is ScanFinding => value !== null)
                .slice(0, 12)
            : [],
        );
        return;
      }
      try {
        const envelope = parseDeliveryEnvelope(json, kind, requestedVariant, requestedCaseId);
        if (kind === "package") {
          const pkg = envelope.payload as Extract<ExportEnvelopeV1["payload"], { manifest: unknown }>;
          const requested = body.selection ?? [];
          const actual = pkg.manifest.items.map((item) => `${item.kind}:${item.id}`);
          const expected = requested.map((item) => `${item.kind}:${item.id}`);
          if (actual.length !== expected.length ||
              actual.some((key) => !expected.includes(key)) ||
              pkg.promptScaffold !== (body.promptScaffold ?? null)) {
            throw new Error("package selection differs from request");
          }
        }
        preparedRef.current = envelope;
        setExportResult(envelope);
      } catch {
        setError(INVALID_EXPORT_MESSAGE);
      }
    } catch {
      if (requestGeneration !== exportGeneration.current || !isCurrentScope()) return;
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      if (requestGeneration === exportGeneration.current && isCurrentScope()) {
        inFlight.current = false;
        setPending(null);
      }
    }
  }

  function downloadExport(format: "json" | "markdown") {
    if (!isCurrentScope() || !allowed || inFlight.current || !currentExportResult ||
        preparedRef.current !== currentExportResult) return;
    const safeId = safeFilenamePart(envelopeCaseId(currentExportResult));
    const stem = `contextdesk-${safeId}-${currentExportResult.kind}-${currentExportResult.privacyClass}`;
    const contents = format === "json"
      ? `${JSON.stringify(currentExportResult, null, 2)}\n`
      : currentExportResult.markdown;
    try {
      startDownload(new Blob([contents], {
        type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
      }), `${stem}.${format === "json" ? "json" : "md"}`, exportObjectUrls.current);
      setDownloadNotice(`${format === "json" ? "JSON" : "Markdown"} download started. Check your browser's downloads; saving the file is not confirmed here.`);
    } catch {
      setDownloadNotice("The browser could not start this download. The prepared result is still available; retry its download button.");
    }
  }

  async function exportBrief(event: FormEvent) {
    event.preventDefault();
    if (!isCurrentScope() || !allowed || inFlight.current) return;
    await postExport("brief", `/api/cases/${props.caseId}/export/brief`, { variant });
  }

  async function exportPackage(event: FormEvent) {
    event.preventDefault();
    if (!isCurrentScope() || !allowed || inventoryStatus !== "ready" || inFlight.current) return;
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
    if (!isCurrentScope() || !props.canLead || portableStatus !== "ready" || portablePending) return;
    setPortablePending("download");
    setPortableError(null);
    setPortableMessage(null);
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/portable-archive`);
      if (!isCurrentScope()) return;
      if (!response.ok) {
        setPortableError(portableErrorMessage(response.status));
        return;
      }
      const archive = await response.json();
      if (!isCurrentScope()) return;
      const contents = JSON.stringify(archive, null, 2);
      const safeId = safeFilenamePart(props.caseId);
      startDownload(
        new Blob([contents], { type: "application/json;charset=utf-8" }),
        `contextdesk-investigation-${safeId}.json`,
        objectUrls.current,
      );
      setPortableMessage(
        "Portable archive download started. Check your browser downloads and handle the file according to its privacy classification.",
      );
    } catch {
      if (isCurrentScope()) setPortableError(PORTABLE_NETWORK_ERROR);
    } finally {
      if (isCurrentScope()) setPortablePending(null);
    }
  }

  async function selectPortableArchive(event: ChangeEvent<HTMLInputElement>) {
    if (!isCurrentScope() || !props.canLead) return;
    setPortableSelection(null);
    setPreflight(null);
    setApplyResult(null);
    setTypedConfirmation("");
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
      if (!isCurrentScope()) return;
      const actors = portableActors(archive);
      if (!actors) {
        setPortableError("This file is not a valid portable investigation archive.");
        event.target.value = "";
        return;
      }
      setPortableSelection({ archive, actorIds: actors.map((actor) => actor.sourceActorId) });
      setPortableMessage(
        `Archive selected. ${actors.length} historical ${actors.length === 1 ? "person" : "people"} will remain attribution only.`,
      );
    } catch {
      if (!isCurrentScope()) return;
      setPortableError("This file is not a valid portable investigation archive.");
      event.target.value = "";
    }
  }

  async function runPortablePreflight() {
    if (!isCurrentScope() || !props.canLead || !portableSelection || portablePending) return;
    setPortablePending("preflight");
    setPortableError(null);
    setPortableMessage(null);
    setPreflight(null);
    setApplyResult(null);
    setTypedConfirmation("");
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
      if (!isCurrentScope()) return;
      if (!response.ok) {
        setPortableError(portableErrorMessage(response.status));
        return;
      }
      const result = (await response.json()) as PortablePreflightResult;
      if (!isCurrentScope()) return;
      setPreflight(result);
      setPortableMessage(
        "Dry-run check complete. No investigation, user, membership, role, or permission was created or changed.",
      );
    } catch {
      if (isCurrentScope()) setPortableError(PORTABLE_NETWORK_ERROR);
    } finally {
      if (isCurrentScope()) setPortablePending(null);
    }
  }

  async function applyPortableArchive() {
    if (
      !isCurrentScope() ||
      !props.canLead ||
      !portableSelection ||
      !preflight?.apply.confirmationToken ||
      !preflight.report.exactReconstruction ||
      typedConfirmation !== "RESTORE" ||
      portablePending
    ) {
      return;
    }
    setPortablePending("apply");
    setPortableError(null);
    setPortableMessage(null);
    setApplyResult(null);
    try {
      const response = await protectedApiFetch("/api/portable-investigations/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: "cd-collab.portable_investigation_apply_request.v1",
          confirmationToken: preflight.apply.confirmationToken,
          typedConfirmation: "RESTORE",
          collisionPolicy: "remap_deterministic",
          identityMap: portableSelection.actorIds.map((sourceActorId) => ({
            sourceActorId,
            action: "preserve_historical_external",
            destinationActorId: null,
          })),
          archive: portableSelection.archive,
        }),
      });
      const body = asRecord(await response.json());
      if (!isCurrentScope()) return;
      if (!response.ok) {
        const code = typeof body?.error === "string" ? body.error : null;
        setPortableError(applyErrorMessage(response.status, code));
        return;
      }
      if (
        !body ||
        (body.status !== "applied" && body.status !== "idempotent_replay") ||
        typeof body.investigationId !== "string" ||
        typeof body.deepLink !== "string" ||
        !body.deepLink.startsWith("/investigations/")
      ) {
        setPortableError(applyErrorMessage(response.status, "apply_refused"));
        return;
      }
      setApplyResult({
        status: body.status,
        investigationId: body.investigationId,
        deepLink: body.deepLink,
      });
      setPortableMessage(
        body.status === "idempotent_replay"
          ? "This archive was already restored. Nothing new was created."
          : "Restore complete. Historical people remain attribution only and received no destination access.",
      );
    } catch {
      if (isCurrentScope()) setPortableError(PORTABLE_APPLY_NETWORK_ERROR);
    } finally {
      if (isCurrentScope()) setPortablePending(null);
    }
  }

  return (
    <section className="export" aria-busy={currentPending !== null ? true : undefined}>
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
            onChange={(e) => {
              if (!isCurrentScope() || inFlight.current) return;
              clearPrepared();
              setVariant(e.target.value as "owner_only" | "share_safe");
            }}
          >
            <option value="owner_only" disabled={!canReadPrivate}>owner_only</option>
            <option value="share_safe">
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
          {inventoryStatus === "unavailable" ? (
            <p className="case-memory__note" role="status">Evidence inventory is unavailable for this account or investigation.</p>
          ) : null}
          {inventoryStatus === "error" ? (
            <>
              <p className="case-memory__error" role="alert">
                The evidence inventory could not be loaded. Check your connection, then retry.
              </p>
              <button
                className="case-memory__secondary-button"
                type="button"
                onClick={() => { if (isCurrentScope()) setInventoryAttempt((attempt) => attempt + 1); }}
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
          {inventoryStatus === "ready" ? items.map((item) => (
            <label key={`${item.kind}:${item.id}`} className="export__item">
              <input
                type="checkbox"
                disabled={item.excludedByDefault || pending !== null}
                checked={Boolean(selected[`${item.kind}:${item.id}`])}
                onChange={(e) => {
                  if (!isCurrentScope() || inFlight.current || item.excludedByDefault) return;
                  clearPrepared();
                  setSelected((cur) => ({ ...cur, [`${item.kind}:${item.id}`]: e.target.checked }));
                }}
              />
              <span>
                {item.kind} · {item.label} · {item.privacyClass}
                {item.excludedByDefault ? " (excluded by default)" : ""}
              </span>
            </label>
          )) : null}
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
            disabled={pending !== null}
            value={scaffold}
            onChange={(e) => {
              if (!isCurrentScope() || inFlight.current) return;
              clearPrepared();
              setScaffold(e.target.value);
            }}
            rows={2}
          />
        </label>
        <button
          className="login__submit"
          type="submit"
          disabled={!allowed || pending !== null || inventoryStatus !== "ready" || selectedCount === 0}
        >
          Export selected-evidence prompt package
        </button>
      </form>
      {currentPending ? (
        <p className="case-memory__note" role="status">
          {currentPending === "brief"
            ? "Exporting triage brief…"
            : "Exporting selected-evidence prompt package…"} Export buttons stay disabled until
          it finishes; your selection is preserved.
        </p>
      ) : null}
      {currentError ? (
        <p className="export__error" role="alert">
          {currentError}
        </p>
      ) : null}
      {currentFindings.length > 0 ? (
        <>
          <p className="case-memory__note">
            The privacy scan blocked a downloadable result. The server may have performed projection or audit work. Finding values are redacted.
          </p>
          <ul className="export__findings" aria-label="Privacy scan findings">
            {currentFindings.map((f, i) => (
              <li key={`${f.rule}-${i}`}>
                <span className="imported-run__text">
                  {f.rule} · {f.path} · {f.excerpt}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {currentExportResult ? (
        <section className="export__result" aria-labelledby="export-result-heading">
          <div className="export__result-heading">
            <div>
              <p className="export__eyebrow">Ready to hand off</p>
              <h4 id="export-result-heading">Export files</h4>
            </div>
            <span className="export__badge">
              {readablePrivacy(currentExportResult.privacyClass)}
            </span>
          </div>
          <p className="export__copy" role="status">
            {currentExportResult.kind === "brief"
              ? "Triage brief prepared."
              : "Selected-evidence prompt package prepared."} Download each checked file deliberately; preparation does not save a file.
          </p>
          <dl className="export__result-facts">
            <div><dt>Investigation</dt><dd><code>{envelopeCaseId(currentExportResult)}</code></dd></div>
            <div><dt>Generated</dt><dd>{currentExportResult.exportedAt}</dd></div>
            <div>
              <dt>Export type</dt>
              <dd>
                {currentExportResult.kind === "brief" ? "Triage brief" : "Prompt package"}
              </dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>{readablePrivacy(currentExportResult.privacyClass)}</dd>
            </div>
            {envelopeSnapshotIdentity(currentExportResult) ? (
              <div>
                <dt>Snapshot identity</dt>
                <dd>
                  <code className="imported-run__text">
                    {envelopeSnapshotIdentity(currentExportResult)}
                  </code>
                </dd>
              </div>
            ) : null}
          </dl>
          {currentExportResult.kind === "package" ? (
            <div className="export__selection" aria-label="Prepared package selection">
              <p className="export__copy">Selected manifest items and body inclusion:</p>
              <ul>
                {(currentExportResult.payload as Extract<ExportEnvelopeV1["payload"], { excerpts: unknown }>).excerpts.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <code>{item.kind}:{item.id}</code> · {readablePrivacy(item.privacyClass)} ·
                    {item.bodyIncluded ? " body included" : " body omitted"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {envelopeSnapshotIdentity(currentExportResult) ? (
            <p className="export__copy">
              The snapshot identity is the content hash of this package's manifest; identical
              inputs reproduce the same identity.
            </p>
          ) : null}
          <div className="export__result-actions" aria-label="Export file downloads">
            <button
              className="case-memory__secondary-button"
              type="button"
              onClick={() => downloadExport("json")}
            >
              Download JSON
            </button>
            <button
              className="case-memory__secondary-button"
              type="button"
              onClick={() => downloadExport("markdown")}
            >
              Download Markdown
            </button>
          </div>
          {downloadNotice ? <p role="status" className="export__copy">{downloadNotice}</p> : null}
          <pre
            className="export__markdown"
            tabIndex={0}
            role="region"
            aria-label="Exported markdown"
          >
            {currentExportResult.markdown}
          </pre>
        </section>
      ) : null}
      <section className="export__portable" aria-labelledby="portable-archive-heading">
        <div className="export__portable-heading">
          <div>
            <p className="export__eyebrow">Move or preserve an investigation</p>
            <h4 id="portable-archive-heading">Portable investigation archive</h4>
          </div>
          <span className="export__badge">Lead access</span>
        </div>
        <p className="export__copy">
          Download the supported portable record for safekeeping or transfer. Unlike the
          selected-evidence package above, this archive can include investigation fields and
          evidence that the dry-run checker knows how to reconstruct exactly.
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
                : "Download portable investigation archive"}
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
            A case lead or administrator must download or check portable investigation archives.
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
        {portableCapabilities?.apply.available ? (
          <p className="export__portable-policy">
            Restore coordination: {portableCapabilities.apply.coordination === "postgres_transactional"
              ? "transactional across PostgreSQL-backed server replicas"
              : "supported only by this single server instance"}. Confirmation survives a server
            restart: {portableCapabilities.apply.confirmationRestartDurable ? "yes" : "no"}.
          </p>
        ) : null}
        <p className="export__portable-warning">
          Restore requires an exact reconstruction of every field represented by this archive
          version, a case lead or administrator, and typing{" "}
          <strong>RESTORE</strong> after the dry-run check. Historical people stay attribution
          only. Archive signatures are recorded, not verified.
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
              <li>
                {preflight.report.exactReconstruction
                  ? "Every field represented by this archive version can be reconstructed and the archive can be restored after typed confirmation."
                  : "This archive is not an exact reconstruction. Metadata-only, blocked, omitted, private, or redacted required content cannot be restored."}
              </li>
            </ul>
            {(preflight.report.identityResolutions ?? []).length > 0 ? (
              <ul className="export__preflight-notes" aria-label="Identity mappings">
                {(preflight.report.identityResolutions ?? []).map((row) => (
                  <li key={row.sourceActorId}>{readableAction(row.action)}</li>
                ))}
              </ul>
            ) : null}
            <p className="export__copy">
              Collision policy: deterministic remaps.{" "}
              {preflight.report.counts.conflict} collision
              {preflight.report.counts.conflict === 1 ? "" : "s"} will receive new destination
              identifiers instead of overwriting existing records.
            </p>
            <details className="export__tech">
              <summary>Technical details</summary>
              <dl className="export__summary-grid">
                <div>
                  <dt>Transport hash</dt>
                  <dd>
                    <code className="imported-run__text">
                      {preflight.report.transportHash ?? "unavailable"}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Semantic fingerprint</dt>
                  <dd>
                    <code className="imported-run__text">
                      {preflight.report.semanticFingerprint ?? "unavailable"}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Destination catalog digest</dt>
                  <dd>
                    <code className="imported-run__text">
                      {preflight.report.destinationCatalogDigest ?? "unavailable"}
                    </code>
                  </dd>
                </div>
              </dl>
            </details>
            {preflight.report.exactReconstruction && preflight.apply.confirmationToken ? (
              <form
                className="export__confirm"
                aria-labelledby="portable-confirm-heading"
                onSubmit={(event) => {
                  event.preventDefault();
                  void applyPortableArchive();
                }}
              >
                <h6 id="portable-confirm-heading">Confirm exact restore</h6>
                <p>
                  Type <strong>RESTORE</strong> to reconstruct the supported investigation record.
                  Metadata and staged evidence commit together or roll back together. Historical
                  identities do not become members, roles, or capability holders.
                </p>
                <label className="export__typed">
                  Typed confirmation
                  <input
                    className="login__input"
                    value={typedConfirmation}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={portablePending !== null || applyResult !== null}
                    onChange={(event) => setTypedConfirmation(event.target.value)}
                  />
                </label>
                <button
                  className="login__submit"
                  type="submit"
                  disabled={
                    typedConfirmation !== "RESTORE" ||
                    portablePending !== null ||
                    applyResult !== null
                  }
                >
                  {portablePending === "apply" ? "Restoring investigation…" : "Restore investigation"}
                </button>
              </form>
            ) : (
              <p className="case-memory__note">
                Restore stays unavailable until the dry-run reports an exact reconstruction.
              </p>
            )}
          </section>
        ) : null}
        {portablePending === "apply" ? (
          <p className="case-memory__note" role="status">
            Restoring investigation… Metadata and staged evidence stay within one coordinated
            commit. If the response is interrupted, rerun the dry-run check to recover an
            actor-scoped replay safely.
          </p>
        ) : null}
        {applyResult ? (
          <p className="export__copy" role="status">
            <a className="export__success-link" href={applyResult.deepLink}>
              Open restored investigation
            </a>
          </p>
        ) : null}
      </section>
    </section>
  );
}
