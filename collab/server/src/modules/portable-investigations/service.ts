import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
  PORTABLE_APPLY_TYPED_CONFIRMATION,
  PORTABLE_HISTORY_CAVEAT,
  PORTABLE_OBJECT_KINDS,
  PORTABLE_PERMISSION_CAVEAT,
  PORTABLE_PROTOCOL_VERSION,
  PORTABLE_SCHEMA_ID,
  PORTABLE_TERMINAL_TRIAGE_STATUSES,
  attachPortableIntegrity,
  canonicalJson,
  destinationCatalogDigest,
  identityMapDigest,
  parsePortableArchive,
  parsePortableExperimentTraceTarget,
  parsePortableTriageAttemptTarget,
  portableApplyDeepLink,
  portableSnapshotFingerprint,
  preflightPortableArchive,
  sealPortableArchive,
  sha256Text,
  snapshotFairness,
  type ArchiveBlobInventoryEntryV1,
  type ArchivePreflightReportV1,
  type CollisionPolicy,
  type DestinationCatalogV1,
  type IdentityMapEntryV1,
  type PortableApplyResponseV1,
  type PortableArchiveV1,
  type PortableContentObjectV1,
  type PortableInvestigationUnsigned,
  type PortableObjectKind,
  type PortableTerminalTriageStatus,
  type PrivacyClass,
  type ProviderKind,
} from "@cd-collab/contracts";
import {
  persistPortableArchive,
  PortableCommitOutcomeUnknownError,
  type PortableApplyStateStore,
  type PortablePersistPorts,
  type StoredPortableApplyIntent,
} from "./persist.js";
import type { AuditStore } from "../audit/index.js";
import type { CatalogService } from "../catalog/index.js";
import type { Actor, CaseService, TimelineRow } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import type { ImportService } from "../import/index.js";
import type { TriageRunService } from "../triage-runs/index.js";

export const MAX_PORTABLE_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_PORTABLE_OBJECTS = 25_000;
export const PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE = PORTABLE_APPLY_TYPED_CONFIRMATION;
const APPLY_TOKEN_TTL_MS = 10 * 60 * 1000;

export const PORTABLE_CONTRACT_UNSUPPORTED = [
  "hypothesis_links",
  "file_reference_location_and_verification",
  "triage_worker_leases_and_cancellation_capabilities",
  "experiment_agreement_and_interaction_traces",
  "source_membership_and_source_identity_ownership",
  "imported_prompt_and_opaque_run_details",
  "imported_content_privacy_is_not_contract_bound",
  "discussion_containers_presence_and_live_chat_state",
  "derived_alignment_details_and_interaction_traces",
  "audit_references_origins_and_raw_payloads",
] as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

function isPortableTerminalTriageStatus(
  status: string,
): status is PortableTerminalTriageStatus {
  return (PORTABLE_TERMINAL_TRIAGE_STATUSES as readonly string[]).includes(status);
}

export type PortableServerErrorCode =
  | "not_found"
  | "archive_size_limit"
  | "unsupported_state"
  | "integrity_failure"
  | "archive_invalid"
  | "apply_refused"
  | "confirmation_invalid"
  | "exact_reconstruction_required"
  | "stale_destination_catalog"
  | "identity_map_mismatch"
  | "actor_mismatch"
  | "apply_outcome_unknown";

export class PortableServerError extends Error {
  constructor(
    readonly code: PortableServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PortableServerError";
  }
}

export interface PortablePreflightInput {
  mode: "dry_run";
  collisionPolicy: CollisionPolicy;
  identityMap: IdentityMapEntryV1[];
  suppliedBlobs?: ArchiveBlobInventoryEntryV1[];
}

export interface PortablePrivacySummary {
  classification: "share_safe_only" | "contains_owner_only" | "unclassified_content_present";
  ownerOnlyEvidence: number;
  shareSafeEvidence: number;
  unclassifiedContentObjects: number;
  inlineBlobCount: number;
  inlineByteLength: number;
  omittedBlobCount: number;
  privateBlobCount: number;
  redactedBlobCount: number;
}

export interface PortablePreflightResponse {
  schemaId: "cd-collab.portable_investigation_preflight_response.v1";
  report: ArchivePreflightReportV1;
  privacy: PortablePrivacySummary;
  omitted: ArchivePreflightReportV1["reconstructionReasons"];
  unsupported: readonly string[];
  authorization: {
    requiredRole: "case-lead_or_admin";
    evaluatedRole: "case-lead" | "admin";
    actorId: string;
    destinationCatalogSource: "host_visible_catalog";
    destinationCatalogDigest: string;
    sourceRolesTrusted: false;
    destinationMembershipGranted: false;
    destinationRoleGranted: false;
    destinationCapabilityGranted: false;
  };
  apply: {
    available: true;
    requiresExactReconstruction: true;
    typedConfirmation: typeof PORTABLE_APPLY_TYPED_CONFIRMATION;
    confirmationToken: string | null;
    expiresAt: string | null;
    reason: string | null;
    coordination: "single_instance" | "postgres_transactional";
    confirmationRestartDurable: boolean;
  };
}

export interface PortableCapabilities {
  schemaId: "cd-collab.portable_investigation_capabilities.v1";
  exportAvailable: true;
  dryRunPreflightAvailable: true;
  maximumArchiveBytes: number;
  apply: {
    available: true;
    requiresExactReconstruction: true;
    typedConfirmation: typeof PORTABLE_APPLY_TYPED_CONFIRMATION;
    coordination: "single_instance" | "postgres_transactional";
    confirmationRestartDurable: boolean;
  };
}

const APPLY_IDENTITY_ACTIONS = new Set(["map_existing", "preserve_historical_external"]);

interface PortableDeps {
  installationId: string;
  cases: CaseService;
  catalog: CatalogService;
  imports: ImportService;
  triageRuns: TriageRunService;
  experiments: ExperimentService;
  audit: AuditStore;
  applyState: PortableApplyStateStore;
  withTransaction: <T>(operation: (ports: PortablePersistPorts) => Promise<T>) => Promise<T>;
  applyCoordination: "single_instance" | "postgres_transactional";
  confirmationRestartDurable: boolean;
  now?: () => string;
}

interface ActorSeed {
  id: string;
  username?: string | null;
}

interface ProjectedContent {
  digest: string;
  byteLength: number;
  contentType: string | null;
  inclusion: "present" | "omitted";
  payloadBase64: string | null;
}

function providerKind(value: string | null): ProviderKind {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[_ ]/g, "-");
  if (normalized.includes("ollama")) return "ollama";
  if (normalized.includes("grok") || normalized.includes("xai")) return "xai_grok_build";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (
    normalized.includes("openai") ||
    normalized.includes("gateway") ||
    normalized.includes("compatible")
  ) {
    return "openai_compatible";
  }
  return "unknown";
}

function safeActorLabel(actorId: string): string {
  return `historical-${sha256Text(actorId).slice(0, 12)}`;
}

function addActor(actors: Map<string, string>, seed: ActorSeed): void {
  if (!seed.id) return;
  const username = seed.username?.trim();
  const existing = actors.get(seed.id);
  if (!existing || existing.startsWith("historical-")) {
    actors.set(seed.id, username || safeActorLabel(seed.id));
  }
}

function addObjectId(
  catalog: Partial<Record<PortableObjectKind, Set<string>>>,
  kind: PortableObjectKind,
  id: string,
): void {
  const set = catalog[kind] ?? new Set<string>();
  set.add(id);
  catalog[kind] = set;
}

function portableDiscussionId(caseId: string): string {
  return `discussion-${sha256Text(caseId).slice(0, 24)}`;
}

function ensureSha256(value: string, label: string): void {
  if (!SHA256_RE.test(value)) {
    throw new PortableServerError("unsupported_state", `${label} has no portable SHA-256 identity`);
  }
}

function portableFingerprint(value: string, prefix: "task" | "snap"): string {
  const normalized = value.trim().toLowerCase();
  const digest = normalized.startsWith(`${prefix}-`)
    ? normalized.slice(prefix.length + 1)
    : normalized;
  ensureSha256(digest, `${prefix} fingerprint`);
  return digest;
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectCount(bundle: PortableInvestigationUnsigned): number {
  return (
    1 +
    bundle.actors.length +
    bundle.contributions.length +
    bundle.evidence.length +
    bundle.contentObjects.length +
    bundle.sources.length +
    bundle.importedAiRuns.length +
    bundle.snapshots.length +
    bundle.triageJobs.length +
    bundle.experiments.length +
    bundle.helpfulnessObservations.length +
    bundle.decisions.length +
    bundle.gold.length +
    bundle.alignments.length +
    bundle.discussions.length +
    bundle.timeline.length +
    bundle.auditRefs.length +
    bundle.attachments.length
  );
}

function timelinePayload(row: TimelineRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function portableTimelineTarget(
  row: TimelineRow,
  namespaces: Map<string, Set<PortableObjectKind>>,
): { targetId: string; namespace: PortableObjectKind } | null {
  if (row.targetId === null) return null;
  const payload = timelinePayload(row);
  if (/^experiment_decision_/.test(row.kind)) {
    const decisionId = typeof payload.decisionId === "string" ? payload.decisionId : row.targetId;
    if (decisionId && namespaces.get(decisionId)?.has("decision")) {
      return { targetId: decisionId, namespace: "decision" };
    }
    return null;
  }
  if (row.kind === "experiment_gold_promoted") {
    const goldId = typeof payload.goldId === "string" ? payload.goldId : row.targetId;
    if (goldId && namespaces.get(goldId)?.has("gold")) {
      return { targetId: goldId, namespace: "gold" };
    }
    return null;
  }
  if (row.kind === "experiment_helpfulness_recorded") {
    const observationId = typeof payload.observationId === "string" ? payload.observationId : row.targetId;
    if (observationId && namespaces.get(observationId)?.has("helpfulness")) {
      return { targetId: observationId, namespace: "helpfulness" };
    }
    return null;
  }
  if (row.kind === "experiment_trace_imported") {
    const parsed = parsePortableExperimentTraceTarget(row.targetId);
    const traceId = parsed?.traceId
      ?? (typeof payload.traceId === "string" && payload.traceId.trim() ? payload.traceId : null);
    const experimentId = parsed?.experimentId ?? row.targetId;
    if (traceId && namespaces.get(experimentId)?.has("experiment")) {
      return { targetId: `${experimentId}:${traceId}`, namespace: "experiment" };
    }
    return null;
  }
  if (/^triage_candidate_/.test(row.kind)) {
    const attempt = parsePortableTriageAttemptTarget(row.targetId);
    if (attempt && namespaces.get(attempt.jobId)?.has("triage_job")) {
      return { targetId: row.targetId, namespace: "triage_job" };
    }
    return null;
  }
  if (row.kind === "corpus_intake_committed") {
    if (namespaces.get(row.targetId)?.has("intake_batch")) {
      return { targetId: row.targetId, namespace: "intake_batch" };
    }
    return null;
  }
  const namespace = targetNamespace(row, namespaces);
  return namespace ? { targetId: row.targetId, namespace } : null;
}

function targetNamespace(
  row: TimelineRow,
  namespaces: Map<string, Set<PortableObjectKind>>,
): PortableObjectKind | null {
  if (row.targetId === null) return null;
  const byKind: Array<[RegExp, PortableObjectKind]> = [
    [/^case_|^legal_hold$/, "investigation"],
    [/^contribution_|^hypothesis_/, "contribution"],
    [/^evidence_/, "evidence"],
    [/^external_run_|^run_corroboration$/, "imported_ai_run"],
    [/^snapshot_/, "snapshot"],
    [/^triage_/, "triage_job"],
    [/^experiment_/, "experiment"],
  ];
  const available = namespaces.get(row.targetId);
  if (!available?.size) return null;
  for (const [pattern, kind] of byKind) {
    if (pattern.test(row.kind) && available.has(kind)) return kind;
  }
  return available.size === 1 ? [...available][0] ?? null : null;
}

function privacySummary(archive: PortableArchiveV1): PortablePrivacySummary {
  const ownerOnlyEvidence = archive.investigation.evidence.filter(
    (row) => row.privacyClass === "owner_only",
  ).length;
  const inline = archive.blobInventory.filter((row) => row.presence === "inline");
  const evidenceDigests = new Set(archive.investigation.evidence.map((row) => row.digest));
  const unclassifiedContentObjects = archive.investigation.contentObjects.filter(
    (row) => !evidenceDigests.has(row.digest),
  ).length;
  return {
    classification:
      ownerOnlyEvidence > 0
        ? "contains_owner_only"
        : unclassifiedContentObjects > 0
          ? "unclassified_content_present"
          : "share_safe_only",
    ownerOnlyEvidence,
    shareSafeEvidence: archive.investigation.evidence.length - ownerOnlyEvidence,
    unclassifiedContentObjects,
    inlineBlobCount: inline.length,
    inlineByteLength: inline.reduce((total, row) => total + row.byteLength, 0),
    omittedBlobCount: archive.blobInventory.filter((row) => row.presence === "omitted").length,
    privateBlobCount: archive.blobInventory.filter((row) => row.presence === "private").length,
    redactedBlobCount: archive.blobInventory.filter((row) => row.presence === "redacted").length,
  };
}

function decodePortableBase64(raw: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw new PortableServerError("archive_invalid", `${label} is not canonical base64`);
  }
  return new Uint8Array(Buffer.from(raw, "base64"));
}

function validateSuppliedBlobs(
  archive: PortableArchiveV1,
  suppliedBlobs: readonly ArchiveBlobInventoryEntryV1[],
): Map<string, ArchiveBlobInventoryEntryV1> {
  const contentByDigest = new Map(
    archive.investigation.contentObjects.map((row) => [row.digest, row]),
  );
  const inventoryByDigest = new Map(archive.blobInventory.map((row) => [row.digest, row]));
  const supplied = new Map<string, ArchiveBlobInventoryEntryV1>();
  for (const [index, row] of suppliedBlobs.entries()) {
    if (supplied.has(row.digest)) {
      throw new PortableServerError("archive_invalid", `supplied blob ${index} duplicates a digest`);
    }
    const content = contentByDigest.get(row.digest);
    const inventory = inventoryByDigest.get(row.digest);
    if (
      !content ||
      content.inclusion !== "present" ||
      inventory?.presence !== "detached" ||
      inventory.payloadBase64 !== null
    ) {
      throw new PortableServerError("archive_invalid", `supplied blob ${index} is not requested`);
    }
    if (
      row.presence !== "inline" ||
      row.payloadBase64 === null ||
      row.byteLength !== content.byteLength ||
      row.contentType !== content.contentType
    ) {
      throw new PortableServerError("archive_invalid", `supplied blob ${index} metadata does not match`);
    }
    const decoded = decodePortableBase64(row.payloadBase64, `supplied blob ${index}`);
    if (decoded.byteLength !== row.byteLength || bytesDigest(decoded) !== row.digest) {
      throw new PortableServerError("archive_invalid", `supplied blob ${index} failed digest or length validation`);
    }
    supplied.set(row.digest, row);
  }
  return supplied;
}

function materializeContentBytes(
  archive: PortableArchiveV1,
  suppliedBlobs: readonly ArchiveBlobInventoryEntryV1[],
): { bytes: Map<string, Uint8Array>; digest: string } {
  const supplied = validateSuppliedBlobs(archive, suppliedBlobs);

  const bytes = new Map<string, Uint8Array>();
  for (const content of archive.investigation.contentObjects) {
    if (content.inclusion !== "present") continue;
    const inventory = archive.blobInventory.find((row) => row.digest === content.digest);
    const payload =
      inventory?.payloadBase64 ?? content.payloadBase64 ?? supplied.get(content.digest)?.payloadBase64;
    if (payload === null || payload === undefined) {
      throw new PortableServerError("exact_reconstruction_required", "declared content bytes are missing");
    }
    const decoded = decodePortableBase64(payload, `content ${content.digest}`);
    if (decoded.byteLength !== content.byteLength || bytesDigest(decoded) !== content.digest) {
      throw new PortableServerError("archive_invalid", "materialized content failed digest or length validation");
    }
    bytes.set(content.digest, decoded);
  }
  const digest = sha256Text(
    canonicalJson(
      [...bytes.entries()]
        .map(([contentDigest, value]) => ({ digest: contentDigest, byteLength: value.byteLength }))
        .sort((left, right) => left.digest.localeCompare(right.digest)),
    ),
  );
  return { bytes, digest };
}

function applySupportReasons(
  archive: PortableArchiveV1,
): ArchivePreflightReportV1["reconstructionReasons"] {
  const bundle = archive.investigation;
  const reasons: ArchivePreflightReportV1["reconstructionReasons"] = [];
  const block = (path: string, detail: string): void => {
    reasons.push({ code: "blocking_identity_action", path, detail });
  };
  const durableUsernameActors = new Set<string>([
    bundle.investigation.createdBy,
    ...bundle.contributions.map((row) => row.authorId),
    ...bundle.evidence.map((row) => row.createdBy),
    ...bundle.triageJobs.map((row) => row.requestedBy),
    ...bundle.helpfulnessObservations.map((row) => row.reviewerId),
    ...bundle.decisions.flatMap((row) => [row.authorId, ...(row.ownerId ? [row.ownerId] : [])]),
    ...bundle.gold.map((row) => row.promotedById),
    ...bundle.timeline.map((row) => row.actorId),
  ]);
  for (const [index, actor] of bundle.actors.entries()) {
    if (
      actor.email !== null ||
      actor.displayName !== actor.username ||
      actor.roleNote !== "Historical attribution only"
    ) {
      block(
        `$.investigation.actors[${index}]`,
        "actor display, email, or role-note fields cannot round-trip exactly",
      );
    }
    if (!durableUsernameActors.has(actor.sourceActorId) && actor.username !== actor.sourceActorId) {
      block(
        `$.investigation.actors[${index}]`,
        "this actor username has no destination field that can preserve it",
      );
    }
  }
  const derivedPrivacy: PrivacyClass =
    bundle.contributions.some((row) => row.privacyClass === "owner_only") ||
    bundle.evidence.some((row) => row.privacyClass === "owner_only")
      ? "owner_only"
      : "share_safe";
  if (bundle.investigation.privacyClass !== derivedPrivacy) {
    block(
      "$.investigation.investigation.privacyClass",
      "investigation privacy must match the represented contribution and evidence privacy",
    );
  }
  if (bundle.participants.length > 0) {
    block("$.investigation.participants", "source membership is not an applyable destination record");
  }
  if (bundle.sources.some((row) => row.identityId !== null)) {
    block("$.investigation.sources", "source identity ownership is not applyable");
  }
  if (bundle.importedAiRuns.some((row) => row.profileId !== null || row.opaquePayloadJson !== null)) {
    block("$.investigation.importedAiRuns", "profile and opaque imported-run state is unsupported");
  }
  if (bundle.importedAiRuns.some((row) => row.outputDigest === null)) {
    block("$.investigation.importedAiRuns", "imported runs without output bytes are unsupported");
  }
  for (const [index, snapshot] of bundle.snapshots.entries()) {
    const expectedFairness = snapshotFairness(
      snapshot.evidence.map((item) => ({
        evidenceId: item.evidenceId,
        ordinal: item.ordinal,
        contentHash: item.contentHash,
        expectedHash: item.contentHash,
        verificationStatus: item.contentHash ? "verified" : null,
        privacyClass: item.privacyClass,
      })),
    );
    const expectedLineage = snapshot.parentSnapshotId ? "derived" : "root";
    if (
      snapshot.fairnessClass !== expectedFairness ||
      snapshot.lineageClass !== expectedLineage ||
      snapshot.evidence.some((item, ordinal) => item.ordinal !== ordinal)
    ) {
      block(
        `$.investigation.snapshots[${index}]`,
        "snapshot fairness, lineage, or evidence order cannot round-trip exactly",
      );
    }
  }
  for (const [index, evidence] of bundle.evidence.entries()) {
    const registered = bundle.timeline.find(
      (event) => event.kind === "evidence_registered" && event.targetId === evidence.id,
    );
    if (!registered || registered.serverTime !== evidence.createdAt) {
      block(
        `$.investigation.evidence[${index}].createdAt`,
        "evidence creation time requires a matching evidence_registered timeline event",
      );
    }
  }
  for (const [jobIndex, job] of bundle.triageJobs.entries()) {
    const missingJobState = [
      job.requestMode,
      job.question,
      job.taskFingerprint,
      job.sameSnapshot,
      job.agreementNotice,
      job.updatedAt,
      job.startedAt,
      job.finishedAt,
      job.cancelRequestedAt,
      job.stoppedReason,
    ].some((value) => value === undefined);
    if (missingJobState || job.policyFingerprint === undefined || job.concurrency === undefined) {
      block(
        `$.investigation.triageJobs[${jobIndex}]`,
        "legacy triage job state cannot round-trip exactly",
      );
    }
    for (const [candidateIndex, candidate] of job.candidates.entries()) {
      const missingCandidateState = [
        candidate.status,
        candidate.benchmarkRunId,
        candidate.summary,
        candidate.unknowns,
        candidate.errorCode,
        candidate.startedAt,
        candidate.finishedAt,
        candidate.privacyClass,
      ].some((value) => value === undefined);
      if (missingCandidateState) {
        block(
          `$.investigation.triageJobs[${jobIndex}].candidates[${candidateIndex}]`,
          "legacy triage candidate state cannot round-trip exactly",
        );
      }
    }
  }
  if (bundle.alignments.length > 0) {
    block("$.investigation.alignments", "derived alignment details are unsupported");
  }
  if (bundle.auditRefs.length > 0) {
    block("$.investigation.auditRefs", "historical audit references are unsupported");
  }
  for (const [index, attachment] of bundle.attachments.entries()) {
    if (attachment.id !== attachment.evidenceId || attachment.discussionId !== null) {
      block(
        `$.investigation.attachments[${index}]`,
        "only evidence-backed attachments without a discussion binding are supported",
      );
    }
  }
  if (bundle.discussions.length > 0) {
    block("$.investigation.discussions", "discussion containers are unsupported");
  }
  if (bundle.timeline.some((row, index) => row.seq !== index + 1)) {
    block("$.investigation.timeline", "timeline sequence must be contiguous from one");
  }
  return reasons;
}

export class PortableInvestigationService {
  private readonly now: () => string;

  constructor(private readonly deps: PortableDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  capabilities(): PortableCapabilities {
    return {
      schemaId: "cd-collab.portable_investigation_capabilities.v1",
      exportAvailable: true,
      dryRunPreflightAvailable: true,
      maximumArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES,
      apply: {
        available: true,
        requiresExactReconstruction: true,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
        coordination: this.deps.applyCoordination,
        confirmationRestartDurable: this.deps.confirmationRestartDurable,
      },
    };
  }

  async exportArchive(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<PortableArchiveV1> {
    const caseRow = await this.deps.cases.getCase(caseId, actor, isAdmin);
    if (!caseRow) throw new PortableServerError("not_found", "investigation not found");

    const [latestContributions, artifacts, snapshots, timeline, importedRuns, jobs, experiments] =
      await Promise.all([
        this.deps.cases.listContributions(caseId, actor, isAdmin),
        this.deps.cases.listArtifacts(caseId, actor, isAdmin),
        this.deps.cases.listSnapshots(caseId, actor, isAdmin),
        this.deps.cases.listTimeline(caseId),
        this.deps.imports.listRuns(caseId, actor, isAdmin),
        this.deps.triageRuns.list(caseId, actor, isAdmin),
        this.deps.experiments.list(caseId, actor, isAdmin),
      ]);
    const contributionChains = await Promise.all(
      latestContributions.map((row) => this.deps.cases.provenance(caseId, row.id)),
    );
    const contributions = contributionChains.flat();
    const intakeBatchIds = [...new Set(
      artifacts.flatMap((row) => row.intakeBatchId ? [row.intakeBatchId] : []),
    )].sort();
    const intakeBatches = await Promise.all(
      intakeBatchIds.map(async (batchId) => {
        const batch = await this.deps.cases.getCorpusIntakeBatch(caseId, batchId);
        if (!batch) {
          throw new PortableServerError(
            "integrity_failure",
            "investigation evidence has a dangling corpus intake batch",
          );
        }
        return batch;
      }),
    );
    const historicalTimeline = timeline.filter((row) => row.kind !== "portable_archive_applied");
    const sourceIds = new Set<string>([
      ...contributions.map((row) => row.sourceId),
      ...artifacts.map((row) => row.sourceId),
      ...importedRuns.map((row) => row.sourceId),
    ]);
    const allSources = await this.deps.catalog.list();
    const sources = allSources.filter((row) => sourceIds.has(row.id));
    if (sources.length !== sourceIds.size) {
      throw new PortableServerError("integrity_failure", "investigation has a dangling source");
    }

    const actors = new Map<string, string>();
    addActor(actors, { id: caseRow.createdBy });
    for (const row of contributions) {
      addActor(actors, { id: row.authorId, username: row.authorUsername });
    }
    for (const row of artifacts) addActor(actors, { id: row.uploaderId });
    for (const row of intakeBatches) addActor(actors, { id: row.createdBy });
    for (const row of snapshots) addActor(actors, { id: row.createdBy });
    for (const row of jobs) addActor(actors, { id: row.requestedBy, username: row.requestedByUsername });
    for (const row of experiments) {
      for (const observation of row.observations) {
        addActor(actors, { id: observation.reviewerId, username: observation.reviewerUsername });
      }
      for (const decision of row.decisions) {
        addActor(actors, { id: decision.authorId, username: decision.authorUsername });
        if (decision.ownerId) addActor(actors, { id: decision.ownerId, username: decision.ownerUsername });
      }
      for (const gold of row.golds) {
        addActor(actors, { id: gold.promotedById, username: gold.promotedByUsername });
      }
    }
    for (const row of historicalTimeline) {
      addActor(actors, { id: row.actorId, username: row.actorUsername });
    }
    for (const row of sources) {
      addActor(actors, { id: row.createdBy });
    }

    const contents = new Map<string, ProjectedContent>();
    const addContent = (
      digest: string,
      bytes: Uint8Array | null,
      contentType: string | null,
      byteLength: number,
    ): void => {
      ensureSha256(digest, "content");
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new PortableServerError("unsupported_state", "content byte length is unknown");
      }
      if (bytes && (bytes.byteLength !== byteLength || bytesDigest(bytes) !== digest)) {
        throw new PortableServerError("integrity_failure", "stored content failed hash or length verification");
      }
      const prior = contents.get(digest);
      const next: ProjectedContent = {
        digest,
        byteLength,
        contentType,
        inclusion: bytes ? "present" : "omitted",
        payloadBase64: bytes ? Buffer.from(bytes).toString("base64") : null,
      };
      if (!prior) {
        contents.set(digest, next);
        return;
      }
      if (prior.byteLength !== next.byteLength) {
        throw new PortableServerError("integrity_failure", "duplicate content digest has conflicting length");
      }
      if (prior.contentType !== next.contentType) prior.contentType = null;
      if (prior.inclusion === "omitted" && next.inclusion === "present") {
        prior.inclusion = "present";
        prior.payloadBase64 = next.payloadBase64;
      }
    };

    const registeredAt = new Map(
      historicalTimeline
        .filter((row) => row.kind === "evidence_registered" && row.targetId !== null)
        .map((row) => [row.targetId as string, row.serverTime]),
    );
    for (const artifact of artifacts) {
      const digest = artifact.contentHash ?? artifact.expectedHash;
      if (!digest) {
        throw new PortableServerError(
          "unsupported_state",
          "unhashed evidence cannot be represented by the portable contract",
        );
      }
      const bytes = artifact.contentHash
        ? await this.deps.cases.getArtifactBytes(caseId, artifact.id, actor, isAdmin, canReadPrivate)
        : null;
      if (artifact.contentHash && !bytes) {
        throw new PortableServerError("integrity_failure", "held evidence bytes are missing");
      }
      const byteLength = artifact.byteLength ?? bytes?.byteLength;
      if (byteLength === undefined) {
        throw new PortableServerError(
          "unsupported_state",
          "evidence with unknown byte length cannot be represented",
        );
      }
      addContent(digest, bytes, artifact.mediaType, byteLength);
      if (!registeredAt.has(artifact.id)) {
        throw new PortableServerError("integrity_failure", "evidence registration time is missing");
      }
    }

    for (const run of importedRuns) {
      const output = new TextEncoder().encode(run.outputText);
      addContent(run.outputHash, output, "text/plain", output.byteLength);
      if ((run.promptHash === null) !== (run.promptText === null)) {
        throw new PortableServerError("integrity_failure", "imported prompt hash and bytes disagree");
      }
    }

    const contentRows = (): PortableContentObjectV1[] =>
      [...contents.values()].map((row) => ({ ...row, objectHash: "" }));

    const evidence = artifacts.map((artifact) => {
      const digest = artifact.contentHash ?? artifact.expectedHash;
      if (!digest) throw new PortableServerError("unsupported_state", "evidence digest is missing");
      const content = contents.get(digest);
      if (!content) throw new PortableServerError("integrity_failure", "content projection is missing");
      return {
        id: artifact.id,
        title: artifact.filename?.trim() || `${artifact.kind} evidence`,
        artifactKind: artifact.kind,
        sourceId: artifact.sourceId,
        summaryContributionId: artifact.summaryContributionId,
        relativePath: artifact.relativePath ?? artifact.filename,
        intakeBatchId: artifact.intakeBatchId ?? null,
        privacyClass: artifact.privacyClass,
        digest,
        inclusion: content.inclusion,
        contentType: content.contentType,
        byteLength: content.byteLength,
        createdBy: artifact.uploaderId,
        createdAt: registeredAt.get(artifact.id) as string,
        objectHash: "",
      };
    });

    const snapshotFingerprintMap = new Map<string, string>();
    const portableSnapshots = snapshots.map((snapshot) => {
      const projectedEvidence = snapshot.evidence.map((row) => ({
        evidenceId: row.evidenceId,
        ordinal: row.ordinal,
        contentHash: row.contentHash ?? row.expectedHash,
        privacyClass: row.privacyClass,
      }));
      const base = {
        id: snapshot.id,
        parentSnapshotId: snapshot.parentSnapshotId,
        fairnessClass:
          projectedEvidence.length === 0 || projectedEvidence.every((row) => row.contentHash !== null)
            ? ("same_snapshot" as const)
            : ("unknown" as const),
        lineageClass: snapshot.parentSnapshotId ? ("derived" as const) : ("root" as const),
        visibility: snapshot.visibility,
        protocolVersion: snapshot.protocolVersion,
        evidence: projectedEvidence,
        createdAt: snapshot.createdAt,
        createdBy: snapshot.createdBy,
      };
      const fingerprint = portableSnapshotFingerprint(base);
      snapshotFingerprintMap.set(snapshot.fingerprint, fingerprint);
      snapshotFingerprintMap.set(`snap-${snapshot.fingerprint}`, fingerprint);
      return { ...base, fingerprint, objectHash: "" };
    });

    const portableJobs = jobs.map((job) => {
      if (!isPortableTerminalTriageStatus(job.status)) {
        throw new PortableServerError(
          "unsupported_state",
          "nonterminal triage jobs cannot be exported",
        );
      }
      const snapshotFingerprint = snapshotFingerprintMap.get(job.snapshotFingerprint);
      if (!snapshotFingerprint) {
        throw new PortableServerError("integrity_failure", "triage job snapshot is not portable");
      }
      const portableCandidates = job.candidates.map((candidate) => {
        if (!isPortableTerminalTriageStatus(candidate.status)) {
          throw new PortableServerError(
            "unsupported_state",
            "nonterminal triage candidates cannot be exported",
          );
        }
        return {
          candidateId: candidate.candidateId,
          role: candidate.role,
          providerKind: providerKind(candidate.provider),
          profileId: candidate.profileId,
          model: candidate.model,
          version: candidate.version,
          usageStatus: "unknown" as const,
          costStatus: "unknown" as const,
          outputHash: candidate.outputHash,
          evidenceRefs: [...candidate.evidenceRefs],
          status: candidate.status,
          benchmarkRunId: candidate.benchmarkRunId,
          summary: candidate.summary,
          unknowns: [...candidate.unknowns],
          errorCode: candidate.errorCode,
          startedAt: candidate.startedAt,
          finishedAt: candidate.finishedAt,
          privacyClass: candidate.privacyClass,
        };
      });
      return {
        id: job.id,
        snapshotId: job.snapshotId,
        snapshotFingerprint,
        strategyId: job.request.strategyId,
        status: job.status,
        parentJobId: job.parentJobId ?? null,
        requestFingerprint: job.requestFingerprint,
        candidates: portableCandidates,
        requestedBy: job.requestedBy,
        createdAt: job.createdAt,
        requestMode: job.request.mode,
        question: job.request.question,
        policyFingerprint: job.request.policyFingerprint,
        taskFingerprint: job.request.taskFingerprint,
        concurrency: job.request.concurrency ?? null,
        sameSnapshot: job.sameSnapshot,
        agreementNotice: job.agreementNotice,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        cancelRequestedAt: job.cancelRequestedAt,
        stoppedReason: job.stoppedReason,
        objectHash: "",
      };
    });

    const portableExperiments = experiments.map((experiment) => {
      const snapshotFingerprint = snapshotFingerprintMap.get(experiment.snapshotFingerprint);
      if (!snapshotFingerprint) {
        throw new PortableServerError("integrity_failure", "experiment snapshot is not portable");
      }
      return {
        id: experiment.id,
        packageId: experiment.packageId,
        snapshotFingerprint,
        taskFingerprint: portableFingerprint(experiment.taskFingerprint, "task"),
        candidateIds: experiment.candidates.map((candidate) => candidate.candidateId),
        createdAt: experiment.createdAt,
        objectHash: "",
      };
    });

    const helpfulnessObservations = experiments.flatMap((experiment) =>
      experiment.observations.map((row) => ({
        id: row.id,
        experimentId: experiment.id,
        candidateId: row.candidateId,
        dimension: row.dimension,
        score: row.score,
        rationale: row.rationale,
        evidenceRefs: [...row.evidenceRefs],
        reviewerId: row.reviewerId,
        createdAt: row.createdAt,
        objectHash: "",
      })),
    );
    const decisions = experiments.flatMap((experiment) =>
      experiment.decisions.map((row) => ({
        id: row.id,
        experimentId: experiment.id,
        status: row.status,
        revision: row.revision,
        predecessorRevision: row.predecessorRevision,
        text: row.text,
        rationale: row.rationale,
        evidenceRefs: [...row.evidenceRefs],
        authorId: row.authorId,
        ownerId: row.ownerId,
        remainingUnknowns: [...row.remainingUnknowns],
        createdAt: row.createdAt,
        objectHash: "",
      })),
    );
    const gold = experiments.flatMap((experiment) =>
      experiment.golds.map((row) => ({
        goldId: row.goldId,
        version: row.version,
        predecessorGoldId: row.predecessorGoldId,
        experimentId: experiment.id,
        acceptedDecisionId: row.acceptedDecisionId,
        acceptedDecisionRevision: row.acceptedDecisionRevision,
        evidenceAnchors: [...row.evidenceAnchors],
        notes: [...row.notes],
        promotedById: row.promotedById,
        createdAt: row.createdAt,
        objectHash: "",
      })),
    );
    const alignments: PortableInvestigationUnsigned["alignments"] = [];

    const discussions: PortableInvestigationUnsigned["discussions"] = [];

    const attachments = artifacts
      .filter((row) => row.kind === "attachment")
      .map((row) => {
        const digest = row.contentHash ?? row.expectedHash;
        if (!digest) throw new PortableServerError("unsupported_state", "attachment digest is missing");
        const content = contents.get(digest);
        if (!content) throw new PortableServerError("integrity_failure", "attachment content is missing");
        return {
          id: row.id,
          discussionId: null,
          evidenceId: row.id,
          digest,
          inclusion: content.inclusion,
          objectHash: "",
        };
      });

    const namespaceById = new Map<string, Set<PortableObjectKind>>();
    const registerNamespace = (kind: PortableObjectKind, ids: readonly string[]): void => {
      for (const id of ids) {
        const set = namespaceById.get(id) ?? new Set<PortableObjectKind>();
        set.add(kind);
        namespaceById.set(id, set);
      }
    };
    registerNamespace("investigation", [caseId]);
    registerNamespace("contribution", contributions.map((row) => row.id));
    registerNamespace("evidence", evidence.map((row) => row.id));
    registerNamespace("intake_batch", intakeBatches.map((row) => row.id));
    registerNamespace("source", sources.map((row) => row.id));
    registerNamespace("imported_ai_run", importedRuns.map((row) => row.id));
    registerNamespace("snapshot", portableSnapshots.map((row) => row.id));
    registerNamespace("triage_job", portableJobs.map((row) => row.id));
    registerNamespace("experiment", portableExperiments.map((row) => row.id));
    registerNamespace("helpfulness", helpfulnessObservations.map((row) => row.id));
    registerNamespace("decision", decisions.map((row) => row.id));
    registerNamespace("gold", gold.map((row) => row.goldId));
    registerNamespace("alignment", alignments.map((row) => row.id));
    registerNamespace("discussion", discussions.map((row) => row.id));
    registerNamespace("attachment", attachments.map((row) => row.id));

    const portableTimeline = historicalTimeline.map((row) => {
      const addressed = portableTimelineTarget(row, namespaceById);
      if (/^experiment_decision_/.test(row.kind) && addressed?.namespace !== "decision") {
        throw new PortableServerError(
          "unsupported_state",
          "experiment decision timeline is missing a portable decision target",
        );
      }
      if (row.kind === "experiment_gold_promoted" && addressed?.namespace !== "gold") {
        throw new PortableServerError(
          "unsupported_state",
          "experiment gold timeline is missing a portable gold target",
        );
      }
      if (row.kind === "experiment_helpfulness_recorded" && addressed?.namespace !== "helpfulness") {
        throw new PortableServerError(
          "unsupported_state",
          "experiment helpfulness timeline is missing a portable helpfulness target",
        );
      }
      if (row.kind === "experiment_imported" && addressed?.namespace !== "experiment") {
        throw new PortableServerError(
          "unsupported_state",
          "experiment import timeline is missing a portable experiment target",
        );
      }
      if (row.kind === "experiment_trace_imported") {
        const parsed = addressed?.targetId
          ? parsePortableExperimentTraceTarget(addressed.targetId)
          : null;
        if (addressed?.namespace !== "experiment" || !parsed) {
          throw new PortableServerError(
            "unsupported_state",
            "experiment trace timeline is missing a portable experiment+trace target",
          );
        }
      }
      if (/^triage_candidate_/.test(row.kind) && addressed?.namespace !== "triage_job") {
        throw new PortableServerError(
          "unsupported_state",
          "workstream attempt timeline is missing a portable job target",
        );
      }
      if (row.kind === "snapshot_frozen" && addressed?.namespace !== "snapshot") {
        throw new PortableServerError(
          "unsupported_state",
          "snapshot timeline is missing a portable snapshot target",
        );
      }
      if (row.kind === "external_run_imported" && addressed?.namespace !== "imported_ai_run") {
        throw new PortableServerError(
          "unsupported_state",
          "imported-run timeline is missing a portable imported-run target",
        );
      }
      if (
        (/^contribution_/.test(row.kind) || row.kind === "hypothesis_status")
        && addressed?.namespace !== "contribution"
      ) {
        throw new PortableServerError(
          "unsupported_state",
          "contribution timeline is missing a portable contribution target",
        );
      }
      if (/^evidence_/.test(row.kind) && addressed?.namespace !== "evidence") {
        throw new PortableServerError(
          "unsupported_state",
          "evidence timeline is missing a portable evidence target",
        );
      }
      if (/^triage_job_/.test(row.kind)) {
        const parsed = addressed?.targetId ? parsePortableTriageAttemptTarget(addressed.targetId) : null;
        if (addressed?.namespace !== "triage_job" || parsed) {
          throw new PortableServerError(
            "unsupported_state",
            "workstream job timeline is missing a portable job target",
          );
        }
      }
      if (row.kind === "corpus_intake_committed" && addressed?.namespace !== "intake_batch") {
        throw new PortableServerError(
          "unsupported_state",
          "corpus intake timeline is missing a portable intake-batch target",
        );
      }
      return {
        seq: row.seq,
        kind: row.kind,
        actorId: row.actorId,
        targetId: addressed?.targetId ?? null,
        targetNamespace: addressed?.namespace ?? null,
        serverTime: row.serverTime,
        objectHash: "",
      };
    });

    const auditRefs: PortableInvestigationUnsigned["auditRefs"] = [];

    const privacyClass: PrivacyClass =
      contributions.some((row) => row.privacyClass === "owner_only") ||
      artifacts.some((row) => row.privacyClass === "owner_only")
        ? "owner_only"
        : "share_safe";
    const exportedAt = this.now();
    const unsigned: PortableInvestigationUnsigned = {
      schemaId: PORTABLE_SCHEMA_ID,
      protocolVersion: PORTABLE_PROTOCOL_VERSION,
      sourceInstallationId: this.deps.installationId,
      exportedAt,
      permissionCaveat: PORTABLE_PERMISSION_CAVEAT,
      historyCaveat: PORTABLE_HISTORY_CAVEAT,
      investigation: {
        id: caseRow.id,
        title: caseRow.title,
        status: caseRow.status,
        severity: caseRow.severity,
        legalHold: caseRow.legalHold,
        retentionClass: caseRow.retentionClass,
        privacyClass,
        problemStatement: caseRow.problemStatement ?? "",
        affectedParties: caseRow.affectedParties ?? "",
        impact: caseRow.impact ?? "",
        scope: caseRow.scope ?? "",
        openQuestions: [...(caseRow.openQuestions ?? [])],
        situationVersion: caseRow.situationVersion ?? 0,
        createdAt: caseRow.createdAt,
        createdBy: caseRow.createdBy,
        objectHash: "",
      },
      actors: [...actors.entries()].map(([sourceActorId, username]) => ({
        sourceActorId,
        username,
        displayName: username,
        email: null,
        roleNote: "Historical attribution only",
        objectHash: "",
      })),
      participants: [],
      contributions: contributions.map((row) => ({
        id: row.id,
        kind: row.kind,
        revision: row.revision,
        predecessorRevision: row.predecessorRevision,
        body: row.tombstoned ? null : row.body,
        contentHash: row.body === null ? row.contentHash : sha256Text(row.body),
        privacyClass: row.privacyClass,
        tombstoned: row.tombstoned,
        authorId: row.authorId,
        sourceId: row.sourceId,
        createdAt: row.createdAt,
        hypothesisStatus: row.hypothesisStatus,
        objectHash: "",
      })),
      evidence,
      intakeBatches: intakeBatches.map((row) => ({
        id: row.id,
        caseId: row.caseId,
        idempotencyKey: row.idempotencyKey,
        requestDigest: row.requestDigest,
        origin: row.origin,
        sourceLabel: row.sourceLabel,
        privacyClass: row.privacyClass,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        payloadJson: JSON.stringify(row),
      })),
      contentObjects: contentRows(),
      sources: sources.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        lifecycle: row.lifecycle,
        identityId: null,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        objectHash: "",
      })),
      importedAiRuns: importedRuns.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        importedAt: row.createdAt,
        providerKind: providerKind(row.provider),
        model: row.model ?? "unknown",
        version: row.version,
        profileId: null,
        usageStatus: "unknown",
        costStatus: "unknown",
        outputDigest: row.outputHash,
        opaquePayloadJson: null,
        objectHash: "",
      })),
      snapshots: portableSnapshots,
      triageJobs: portableJobs,
      experiments: portableExperiments,
      helpfulnessObservations,
      decisions,
      gold,
      alignments,
      discussions,
      timeline: portableTimeline,
      auditRefs,
      attachments,
    };
    const [caseCheck, timelineCheck] = await Promise.all([
      this.deps.cases.getCase(caseId, actor, isAdmin),
      this.deps.cases.listTimeline(caseId),
    ]);
    if (
      !caseCheck ||
      canonicalJson(caseCheck) !== canonicalJson(caseRow) ||
      canonicalJson(timelineCheck) !== canonicalJson(timeline)
    ) {
      throw new PortableServerError(
        "integrity_failure",
        "investigation changed while the portable archive was being assembled",
      );
    }
    if (objectCount(unsigned) > MAX_PORTABLE_OBJECTS) {
      throw new PortableServerError("archive_size_limit", "portable object count exceeds limit");
    }
    try {
      const investigation = attachPortableIntegrity(unsigned);
      const archive = sealPortableArchive({ investigation, exportedAt });
      const encodedBytes = Buffer.byteLength(JSON.stringify(archive), "utf8");
      if (encodedBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
        throw new PortableServerError("archive_size_limit", "portable archive exceeds size limit");
      }
      return archive;
    } catch (error) {
      if (error instanceof PortableServerError) throw error;
      throw new PortableServerError("integrity_failure", "portable archive projection failed validation");
    }
  }

  async preflight(
    archiveRaw: unknown,
    input: PortablePreflightInput,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<PortablePreflightResponse> {
    const evaluated = await this.evaluateArchive(archiveRaw, input, actor, isAdmin);
    return {
      ...evaluated.response,
      apply: await this.mintApplyOffer(
        actor,
        evaluated.archive,
        evaluated.report,
        input,
        evaluated.materializedContentDigest,
      ),
    };
  }

  private async evaluateArchive(
    archiveRaw: unknown,
    input: PortablePreflightInput,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{
    archive: PortableArchiveV1;
    report: ArchivePreflightReportV1;
    contentBytes: Map<string, Uint8Array>;
    materializedContentDigest: string;
    destinationUsernames: Map<string, string>;
    response: Omit<PortablePreflightResponse, "apply">;
  }> {
    let encodedBytes: number;
    try {
      encodedBytes = Buffer.byteLength(JSON.stringify(archiveRaw), "utf8");
    } catch {
      throw new PortableServerError("archive_invalid", "portable archive failed validation");
    }
    if (encodedBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
      throw new PortableServerError("archive_size_limit", "portable archive exceeds size limit");
    }
    let archive: PortableArchiveV1;
    try {
      archive = parsePortableArchive(archiveRaw);
    } catch {
      throw new PortableServerError("archive_invalid", "portable archive failed validation");
    }
    if (objectCount(archive.investigation) > MAX_PORTABLE_OBJECTS) {
      throw new PortableServerError("archive_size_limit", "portable object count exceeds limit");
    }
    // Validate every supplied entry even when another missing blob makes the
    // overall archive ineligible for exact apply.
    validateSuppliedBlobs(archive, input.suppliedBlobs ?? []);
    const catalog = await this.destinationCatalog(actor, isAdmin);
    const catalogDigest = destinationCatalogDigest(catalog);
    let report: ArchivePreflightReportV1;
    try {
      report = preflightPortableArchive(archive, {
        mode: "dry_run",
        collisionPolicy: input.collisionPolicy,
        identityMap: input.identityMap,
        destination: structuredClone(catalog),
        ...(input.suppliedBlobs ? { suppliedBlobs: input.suppliedBlobs } : {}),
      });
    } catch {
      throw new PortableServerError("archive_invalid", "portable preflight failed validation");
    }
    const supportReasons = applySupportReasons(archive);
    if (supportReasons.length > 0) {
      report = {
        ...report,
        reconstructionStatus: "blocked",
        reconstructionReasons: [...report.reconstructionReasons, ...supportReasons],
        exactReconstruction: false,
        counts: {
          ...report.counts,
          blocked: report.counts.blocked + supportReasons.length,
        },
      };
    }
    report = { ...report, destinationCatalogDigest: catalogDigest };
    const materialized = report.exactReconstruction
      ? materializeContentBytes(archive, input.suppliedBlobs ?? [])
      : { bytes: new Map<string, Uint8Array>(), digest: sha256Text(canonicalJson([])) };
    return {
      archive,
      report,
      contentBytes: materialized.bytes,
      materializedContentDigest: materialized.digest,
      destinationUsernames: new Map(catalog.identities.map((row) => [row.actorId, row.username])),
      response: {
        schemaId: "cd-collab.portable_investigation_preflight_response.v1",
        report,
        privacy: privacySummary(archive),
        omitted: report.reconstructionReasons,
        unsupported: PORTABLE_CONTRACT_UNSUPPORTED,
        authorization: {
          requiredRole: "case-lead_or_admin",
          evaluatedRole: isAdmin ? "admin" : "case-lead",
          actorId: actor.id,
          destinationCatalogSource: "host_visible_catalog",
          destinationCatalogDigest: report.destinationCatalogDigest,
          sourceRolesTrusted: false,
          destinationMembershipGranted: false,
          destinationRoleGranted: false,
          destinationCapabilityGranted: false,
        },
      },
    };
  }

  private identityMapAllowsApply(identityMap: IdentityMapEntryV1[]): boolean {
    return identityMap.every((row) => APPLY_IDENTITY_ACTIONS.has(row.action));
  }

  private async mintApplyOffer(
    actor: Actor,
    archive: PortableArchiveV1,
    report: ArchivePreflightReportV1,
    input: PortablePreflightInput,
    materializedContentDigest: string,
  ): Promise<PortablePreflightResponse["apply"]> {
    const runtime = {
      coordination: this.deps.applyCoordination,
      confirmationRestartDurable: this.deps.confirmationRestartDurable,
    } as const;
    if (!report.exactReconstruction || !this.identityMapAllowsApply(input.identityMap)) {
      return {
        available: true,
        requiresExactReconstruction: true,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
        confirmationToken: null,
        expiresAt: null,
        reason: "exact_reconstruction_required",
        ...runtime,
      };
    }
    const token = `pit1.${randomBytes(24).toString("base64url")}`;
    const expiresAt = Date.parse(this.now()) + APPLY_TOKEN_TTL_MS;
    await this.deps.applyState.putIntent({
      tokenHash: sha256Text(token),
      actorId: actor.id,
      installationId: this.deps.installationId,
      transportHash: archive.transportHash,
      semanticFingerprint: archive.semanticFingerprint,
      destinationCatalogDigest: report.destinationCatalogDigest,
      identityMapDigest: identityMapDigest(input.identityMap),
      materializedContentDigest,
      collisionPolicy: input.collisionPolicy,
      expiresAt: new Date(expiresAt).toISOString(),
      appliedInvestigationId: null,
    });
    return {
      available: true,
      requiresExactReconstruction: true,
      typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
      confirmationToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      reason: null,
      ...runtime,
    };
  }

  async apply(
    archiveRaw: unknown,
    input: {
      confirmationToken: string;
      typedConfirmation: string;
      collisionPolicy: CollisionPolicy;
      identityMap: IdentityMapEntryV1[];
      suppliedBlobs?: ArchiveBlobInventoryEntryV1[];
    },
    actor: Actor,
    isAdmin: boolean,
    origin = "apply",
  ): Promise<PortableApplyResponseV1> {
    if (input.typedConfirmation !== PORTABLE_APPLY_TYPED_CONFIRMATION) {
      throw new PortableServerError("confirmation_invalid", "typed confirmation is required");
    }
    const identityMap = input.identityMap.map((row) => ({ ...row }));
    const collisionPolicy = input.collisionPolicy;
    const suppliedBlobs = input.suppliedBlobs?.map((row) => ({ ...row }));
    const tokenHash = sha256Text(input.confirmationToken);
    const intent = await this.deps.applyState.getIntent(tokenHash);
    if (!intent) {
      throw new PortableServerError("confirmation_invalid", "confirmation token is unknown");
    }
    if (intent.actorId !== actor.id) {
      throw new PortableServerError("actor_mismatch", "confirmation belongs to a different actor");
    }
    if (intent.installationId !== this.deps.installationId) {
      throw new PortableServerError("apply_refused", "installation mismatch");
    }
    if (intent.collisionPolicy !== collisionPolicy) {
      throw new PortableServerError("confirmation_invalid", "collision policy does not match intent");
    }
    if (identityMapDigest(identityMap) !== intent.identityMapDigest) {
      throw new PortableServerError("identity_map_mismatch", "identity map does not match intent");
    }
    if (!this.identityMapAllowsApply(identityMap)) {
      throw new PortableServerError("exact_reconstruction_required", "unresolved identities cannot be applied");
    }
    let replayArchive: PortableArchiveV1;
    try {
      replayArchive = parsePortableArchive(archiveRaw);
    } catch {
      throw new PortableServerError("archive_invalid", "portable archive failed validation");
    }
    const replayContent = materializeContentBytes(replayArchive, suppliedBlobs ?? []);
    if (intent.appliedInvestigationId) {
      if (
        replayArchive.transportHash !== intent.transportHash ||
        replayArchive.semanticFingerprint !== intent.semanticFingerprint ||
        replayContent.digest !== intent.materializedContentDigest
      ) {
        throw new PortableServerError("archive_invalid", "transport hash does not match intent");
      }
      return this.appliedResponse(intent, "idempotent_replay");
    }
    if (Date.parse(this.now()) > Date.parse(intent.expiresAt)) {
      throw new PortableServerError("confirmation_invalid", "confirmation token expired");
    }
    const preview = await this.evaluateArchive(
      archiveRaw,
      {
        mode: "dry_run",
        collisionPolicy,
        identityMap,
        ...(suppliedBlobs ? { suppliedBlobs } : {}),
      },
      actor,
      isAdmin,
    );
    if (preview.report.transportHash !== intent.transportHash) {
      throw new PortableServerError("archive_invalid", "transport hash does not match intent");
    }
    if (preview.report.semanticFingerprint !== intent.semanticFingerprint) {
      throw new PortableServerError("archive_invalid", "semantic fingerprint does not match intent");
    }
    if (preview.report.destinationCatalogDigest !== intent.destinationCatalogDigest) {
      throw new PortableServerError("stale_destination_catalog", "destination catalog changed");
    }
    if (!preview.report.exactReconstruction) {
      throw new PortableServerError("exact_reconstruction_required", "apply requires exact reconstruction");
    }
    if (preview.materializedContentDigest !== intent.materializedContentDigest) {
      throw new PortableServerError("archive_invalid", "materialized content does not match intent");
    }
    try {
      const outcome = await this.deps.withTransaction(async (ports) => {
        const key = {
          actorId: actor.id,
          installationId: this.deps.installationId,
          transportHash: preview.report.transportHash,
        };
        await ports.applyState.lockApply(key);
        const durableIntent = await ports.applyState.getIntent(tokenHash);
        if (!durableIntent || durableIntent.actorId !== actor.id) {
          throw new PortableServerError("confirmation_invalid", "confirmation intent disappeared");
        }
        const prior = await ports.applyState.findApplied(key);
        if (prior?.appliedInvestigationId) {
          await ports.applyState.markApplied(tokenHash, prior.appliedInvestigationId);
          await ports.audit.append({
            identity: actor.id,
            action: "portable_archive_apply_replay",
            target: prior.appliedInvestigationId,
            origin,
            outcome: "success",
          });
          return {
            status: "idempotent_replay" as const,
            investigationId: prior.appliedInvestigationId,
          };
        }
        const investigationId = await persistPortableArchive({
          archive: preview.archive,
          report: preview.report,
          identityMap,
          actor,
          destinationUsernames: preview.destinationUsernames,
          contentBytes: preview.contentBytes,
          ports,
          now: this.now(),
          origin,
        });
        const existing = await ports.cases.getCase(investigationId);
        if (!existing) {
          throw new PortableServerError("integrity_failure", "imported investigation is missing");
        }
        if (
          existing.participants.length !== 1 ||
          existing.participants[0]?.identityId !== actor.id ||
          existing.participants[0]?.username !== actor.username
        ) {
          throw new PortableServerError("apply_refused", "historical people must not become members");
        }
        await ports.applyState.markApplied(tokenHash, investigationId);
        return { status: "applied" as const, investigationId };
      });
      return this.appliedResponse(
        { ...intent, appliedInvestigationId: outcome.investigationId },
        outcome.status,
      );
    } catch (error) {
      if (error instanceof PortableServerError) throw error;
      if (error instanceof PortableCommitOutcomeUnknownError) {
        throw new PortableServerError(
          "apply_outcome_unknown",
          "database commit outcome is unknown; retry is required to resolve replay state",
        );
      }
      throw new PortableServerError("apply_refused", "atomic apply rolled back");
    }
  }

  private appliedResponse(
    intent: StoredPortableApplyIntent,
    status: PortableApplyResponseV1["status"],
  ): PortableApplyResponseV1 {
    if (!intent.appliedInvestigationId) {
      throw new PortableServerError("apply_refused", "applied intent has no investigation");
    }
    return {
      schemaId: PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
      status,
      investigationId: intent.appliedInvestigationId,
      deepLink: portableApplyDeepLink(intent.appliedInvestigationId),
      transportHash: intent.transportHash,
      semanticFingerprint: intent.semanticFingerprint,
      destinationCatalogDigest: intent.destinationCatalogDigest,
      authenticityClaim: "none",
      destinationMembershipGranted: false,
      destinationRoleGranted: false,
      destinationCapabilityGranted: false,
    };
  }

  private async destinationCatalog(actor: Actor, isAdmin: boolean): Promise<DestinationCatalogV1> {
    const cases = await this.deps.cases.listCases(actor, isAdmin);
    const identities = new Map<string, { actorId: string; username: string; email: null; displayName: string }>();
    identities.set(actor.id, {
      actorId: actor.id,
      username: actor.username,
      email: null,
      displayName: actor.username,
    });
    const ids: Partial<Record<PortableObjectKind, Set<string>>> = {};
    const sources = await this.deps.catalog.list();
    for (const source of sources) addObjectId(ids, "source", source.id);
    for (const caseRow of cases) {
      addObjectId(ids, "investigation", caseRow.id);
      for (const participant of caseRow.participants) {
        identities.set(participant.identityId, {
          actorId: participant.identityId,
          username: participant.username,
          email: null,
          displayName: participant.username,
        });
        addObjectId(ids, "actor", participant.identityId);
      }
      const [contributions, artifacts, snapshots, runs, jobs, experiments, timeline] = await Promise.all([
        this.deps.cases.listContributions(caseRow.id, actor, isAdmin),
        this.deps.cases.listArtifacts(caseRow.id, actor, isAdmin),
        this.deps.cases.listSnapshots(caseRow.id, actor, isAdmin),
        this.deps.imports.listRuns(caseRow.id, actor, isAdmin),
        this.deps.triageRuns.list(caseRow.id, actor, isAdmin),
        this.deps.experiments.list(caseRow.id, actor, isAdmin),
        this.deps.cases.listTimeline(caseRow.id),
      ]);
      for (const row of contributions) addObjectId(ids, "contribution", row.id);
      for (const row of artifacts) {
        addObjectId(ids, "evidence", row.id);
        if (row.contentHash) addObjectId(ids, "content", row.contentHash);
        if (row.kind === "attachment") addObjectId(ids, "attachment", row.id);
        if (row.intakeBatchId) addObjectId(ids, "intake_batch", row.intakeBatchId);
      }
      for (const row of snapshots) addObjectId(ids, "snapshot", row.id);
      for (const row of runs) addObjectId(ids, "imported_ai_run", row.id);
      for (const row of jobs) addObjectId(ids, "triage_job", row.id);
      for (const row of experiments) {
        addObjectId(ids, "experiment", row.id);
        for (const observation of row.observations) addObjectId(ids, "helpfulness", observation.id);
        for (const decision of row.decisions) addObjectId(ids, "decision", decision.id);
        for (const gold of row.golds) addObjectId(ids, "gold", gold.goldId);
        if (row.gold) {
          for (const alignment of row.alignments) {
            addObjectId(
              ids,
              "alignment",
              `alignment-${sha256Text(`${row.id}:${row.gold.goldId}:${alignment.candidateId}`).slice(0, 24)}`,
            );
          }
        }
      }
      if (contributions.some((row) => row.kind === "message")) {
        addObjectId(ids, "discussion", portableDiscussionId(caseRow.id));
      }
      for (const row of timeline) addObjectId(ids, "timeline", String(row.seq));
    }
    addObjectId(ids, "actor", actor.id);
    const objectIds: DestinationCatalogV1["objectIds"] = {};
    for (const kind of PORTABLE_OBJECT_KINDS) {
      const values = ids[kind];
      if (values) objectIds[kind] = [...values];
    }
    return {
      identities: [...identities.values()],
      objectIds,
      knownProfileIds: this.deps.triageRuns.listProfiles().map((row) => row.id),
    };
  }
}
