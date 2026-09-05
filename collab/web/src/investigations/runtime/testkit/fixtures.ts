import {
  ROLE_CAPABILITIES,
  type Capability,
} from "@cd-collab/contracts/admin";
import {
  ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
  ARTIFACT_ANNOTATION_SCHEMA_ID,
  parseArtifactAnnotation,
  parseArtifactAnnotationBulkRequest,
  parseArtifactAnnotationBulkResult,
  type ArtifactAnnotationBulkRequestV1,
  type ArtifactAnnotationBulkResultV1,
  type ArtifactAnnotationV1,
} from "@cd-collab/contracts/evidence-annotations";
import {
  ARTIFACT_SCHEMA_ID,
  CASE_LIST_SCHEMA_ID,
  CASE_SCHEMA_ID,
  CONTRIBUTION_LIST_SCHEMA_ID,
  CONTRIBUTION_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  parseCase,
  parseCaseList,
  parseContributionList,
  parseEvidenceList,
  parseEvidenceUploadSuccess,
  parseInvestigationLifecycle,
  type CaseListV1,
  type CaseV1,
  type ContributionListV1,
  type EvidenceListV1,
  type EvidenceUploadSuccessV1,
  type InvestigationLifecycleV1,
} from "@cd-collab/contracts/investigation-runtime";
import {
  INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
  parseInvestigationOperationsQueuePage,
  type InvestigationOperationsQueuePageV1,
} from "@cd-collab/contracts/investigation-operations-queue";

/** Stable identities used by Runtime V1 conformance tests. */
export const RUNTIME_FIXTURE_IDS = Object.freeze({
  sparseCase: "case-imported-sparse",
  populatedCase: "case-populated",
  evidence: "evidence-checkout-log",
  uploadSummary: "contribution-upload-summary",
  note: "contribution-investigator-note",
});

const CREATED_AT = "2026-02-03T14:05:06.000Z";
const OBSERVED_AT = "2026-02-03T19:42:00.000Z";

/**
 * A pre-context-contract import. Optional wire fields are deliberately absent
 * so the authoritative parser supplies only its documented empty defaults.
 */
export function makeSparseImportedCase(): CaseV1 {
  return parseCase({
    schemaId: CASE_SCHEMA_ID,
    id: RUNTIME_FIXTURE_IDS.sparseCase,
    title: "Imported investigation",
    severity: "low",
    status: "open",
    legalHold: false,
    retentionClass: "standard",
    participants: [],
    createdAt: "2025-11-18T09:00:00.000Z",
    createdBy: "imported-historical:unknown",
  });
}

/** A fully described case for populated-detail and create-result scenarios. */
export function makePopulatedCase(): CaseV1 {
  return parseCase({
    schemaId: CASE_SCHEMA_ID,
    id: RUNTIME_FIXTURE_IDS.populatedCase,
    title: "Checkout latency after 4.8.0 rollout",
    problemStatement: "Checkout requests exceed the recorded latency objective.",
    affectedParties: "Storefront customers in the central region",
    impact: "Some checkouts time out before payment confirmation.",
    scope: "API gateway and checkout service during the 4.8.0 rollout",
    openQuestions: [
      "Did the connection-pool change increase queue time?",
      "Are retries amplifying the affected requests?",
    ],
    situationVersion: 4,
    investigationContext: {
      productName: "ContextDesk Storefront",
      version: "4.8.0",
      build: "2026.02.03.4",
      component: "checkout-api",
      environment: "production",
      organization: "Retail operations",
    },
    occurredAt: OBSERVED_AT,
    occurredAtPrecision: "second",
    occurredAtZone: "explicit",
    severity: "high",
    status: "monitoring",
    legalHold: false,
    retentionClass: "standard",
    participants: [
      { identityId: "identity-alice", username: "alice" },
      { identityId: "identity-ravi", username: "ravi" },
    ],
    createdAt: CREATED_AT,
    createdBy: "identity-alice",
  });
}

export function makeCaseList(): CaseListV1 {
  return parseCaseList({
    schemaId: CASE_LIST_SCHEMA_ID,
    cases: [makeSparseImportedCase(), makePopulatedCase()],
  });
}

/** A joined, actor-scoped queue page whose counts are server-authored fixture data. */
export function makeOperationsQueuePage(
  overrides: Record<string, unknown> = {},
): InvestigationOperationsQueuePageV1 {
  const sparse = makeSparseImportedCase();
  const populated = makePopulatedCase();
  return parseInvestigationOperationsQueuePage({
    schemaId: INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
    items: [
      {
        investigation: populated,
        coordination: {
          schemaId: "cd-collab.investigation_coordination.v1",
          investigationId: populated.id,
          coordinator: { identityId: "identity-alice", username: "alice" },
          revision: 2,
          updatedAt: "2026-02-03T20:00:00.000Z",
          updatedBy: { identityId: "identity-alice", username: "alice" },
          archived: false,
        },
      },
      {
        investigation: sparse,
        coordination: {
          schemaId: "cd-collab.investigation_coordination.v1",
          investigationId: sparse.id,
          coordinator: null,
          revision: 0,
          updatedAt: null,
          updatedBy: null,
          archived: false,
        },
      },
    ],
    nextCursor: null,
    hiddenArchivedCount: 0,
    facets: {
      status: {
        top: [{ key: "open", count: 1 }, { key: "monitoring", count: 1 }],
        otherCount: 0,
      },
      entity: { top: [], otherCount: 0 },
      impactIdentity: { top: [], otherCount: 0 },
      contributor: { top: [], otherCount: 0 },
    },
    coordinationScopeCounts: { allVisible: 2, mine: 1, unassigned: 1 },
    ...overrides,
  });
}

function evidenceArtifact() {
  return {
    schemaId: ARTIFACT_SCHEMA_ID,
    id: RUNTIME_FIXTURE_IDS.evidence,
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    kind: "log",
    filename: "checkout-timeout.log",
    uri: null,
    mediaType: "text/plain",
    byteLength: 1842,
    contentHash: "sha256:24b005aa8796e5655d4c9cc728fdbcd24542d1ee4eab264b8308efcd350a23d1",
    expectedHash: null,
    verificationStatus: "verified",
    privacyClass: "owner_only",
    summaryContributionId: RUNTIME_FIXTURE_IDS.uploadSummary,
    uploaderId: "identity-ravi",
    sourceId: "source-browser-upload",
    relativePath: null,
    intakeBatchId: null,
  } as const;
}

function uploadSummary() {
  return {
    schemaId: CONTRIBUTION_SCHEMA_ID,
    id: RUNTIME_FIXTURE_IDS.uploadSummary,
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    kind: "upload",
    revision: 1,
    predecessorRevision: null,
    body: "Gateway timeout excerpt captured during the affected interval.",
    contentHash: "sha256:40bad44f436320b1a42cb3dbb79022520ffafe2e17227008c238172775487341",
    privacyClass: "owner_only",
    tombstoned: false,
    authorId: "identity-ravi",
    authorUsername: "ravi",
    createdAt: "2026-02-03T14:12:00.000Z",
    hypothesisStatus: null,
    hypothesisLinks: null,
    sourceId: "source-browser-upload",
  } as const;
}

export function makeEvidenceList(): EvidenceListV1 {
  return parseEvidenceList({
    schemaId: EVIDENCE_LIST_SCHEMA_ID,
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    artifacts: [evidenceArtifact()],
  });
}

export function makeEvidenceUploadSuccess(): EvidenceUploadSuccessV1 {
  return parseEvidenceUploadSuccess({
    schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    artifact: evidenceArtifact(),
    summary: uploadSummary(),
  });
}

export function makeContributionList(): ContributionListV1 {
  return parseContributionList({
    schemaId: CONTRIBUTION_LIST_SCHEMA_ID,
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    contributions: [
      uploadSummary(),
      {
        schemaId: CONTRIBUTION_SCHEMA_ID,
        id: RUNTIME_FIXTURE_IDS.note,
        caseId: RUNTIME_FIXTURE_IDS.populatedCase,
        kind: "note",
        revision: 1,
        predecessorRevision: null,
        body: "Queue time rises immediately after the connection-pool rollout.",
        contentHash: "sha256:8f290c672fa73b5e99dd11ea9f67b185884d65f6fc6c45b3a457c59535e12b4c",
        privacyClass: "share_safe",
        tombstoned: false,
        authorId: "identity-alice",
        authorUsername: "alice",
        createdAt: "2026-02-03T14:18:00.000Z",
        hypothesisStatus: null,
        hypothesisLinks: null,
        sourceId: "source-human-note",
      },
    ],
  });
}

/** UUID-shaped identities used by the atomic annotation contract fixtures. */
export const RUNTIME_BULK_ANNOTATION_FIXTURE_IDS = Object.freeze({
  caseId: "30000000-0000-4000-8000-000000000001",
  firstArtifact: "10000000-0000-4000-8000-000000000001",
  secondArtifact: "10000000-0000-4000-8000-000000000002",
  firstAnnotation: "40000000-0000-4000-8000-000000000001",
  secondAnnotation: "40000000-0000-4000-8000-000000000002",
});

export function makeArtifactAnnotation(
  overrides: Partial<ArtifactAnnotationV1> = {},
): ArtifactAnnotationV1 {
  return parseArtifactAnnotation({
    schemaId: ARTIFACT_ANNOTATION_SCHEMA_ID,
    id: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.firstAnnotation,
    caseId: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.caseId,
    artifactId: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.firstArtifact,
    body: "The first selected artifact records the same timeout window.",
    contentHash: "a".repeat(64),
    privacyClass: "share_safe",
    authorId: "identity-alice",
    authorUsername: "alice",
    createdAt: "2026-09-04T10:00:00.000Z",
    sourceId: "source-runtime-fixture",
    ...overrides,
  });
}

export function makeArtifactAnnotationBulkRequest(
  overrides: Partial<ArtifactAnnotationBulkRequestV1> = {},
): ArtifactAnnotationBulkRequestV1 {
  return parseArtifactAnnotationBulkRequest({
    schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
    artifactIds: [
      RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.firstArtifact,
      RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.secondArtifact,
    ],
    body: "The selected artifacts share the same timeout window.",
    idempotencyKey: "runtime-bulk-annotation-0001",
    ...overrides,
  });
}

export function makeArtifactAnnotationBulkResult(
  overrides: Partial<ArtifactAnnotationBulkResultV1> = {},
): ArtifactAnnotationBulkResultV1 {
  return parseArtifactAnnotationBulkResult({
    schemaId: ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
    caseId: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.caseId,
    items: [
      {
        artifactId: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.firstArtifact,
        outcome: "created",
        annotation: makeArtifactAnnotation(),
      },
      {
        artifactId: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.secondArtifact,
        outcome: "replayed",
        annotation: makeArtifactAnnotation({
          id: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.secondAnnotation,
          artifactId: RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.secondArtifact,
        }),
      },
    ],
    ...overrides,
  });
}

const DELETION_ANSWER = {
  supported: false,
  detail: "Investigations are archived, never permanently deleted.",
  alternatives: ["archive"],
} as const;

export function makeArchiveAllowedLifecycle(): InvestigationLifecycleV1 {
  return parseInvestigationLifecycle({
    schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    status: "monitoring",
    legalHold: false,
    archive: { allowed: true, action: "archive", targetStatus: "archived" },
    restore: {
      allowed: false,
      action: "restore",
      reason: "not_archived",
      detail: "This investigation is not archived.",
    },
    restoreTarget: "monitoring",
    deletion: DELETION_ANSWER,
  });
}

export function makeArchiveRefusedLifecycle(): InvestigationLifecycleV1 {
  return parseInvestigationLifecycle({
    schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    status: "monitoring",
    legalHold: true,
    archive: {
      allowed: false,
      action: "archive",
      reason: "legal_hold",
      detail: "Clear the legal hold before archiving this investigation.",
    },
    restore: {
      allowed: false,
      action: "restore",
      reason: "not_archived",
      detail: "This investigation is not archived.",
    },
    restoreTarget: "monitoring",
    deletion: DELETION_ANSWER,
  });
}

export function makeRestoreAllowedLifecycle(): InvestigationLifecycleV1 {
  return parseInvestigationLifecycle({
    schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    status: "archived",
    legalHold: false,
    archive: {
      allowed: false,
      action: "archive",
      reason: "already_archived",
      detail: "This investigation is already archived.",
    },
    restore: { allowed: true, action: "restore", targetStatus: "monitoring" },
    restoreTarget: "monitoring",
    deletion: DELETION_ANSWER,
  });
}

export interface RuntimeCapabilityFixture {
  readonly staticReadOnly: boolean;
  readonly capabilities: readonly Capability[];
}

/** A viewer has no mutation capability even in an ordinary interactive build. */
export const VIEWER_CAPABILITY_FIXTURE: RuntimeCapabilityFixture = Object.freeze({
  staticReadOnly: false,
  capabilities: Object.freeze([...ROLE_CAPABILITIES.viewer]),
});

/** Static read-only mode must suppress writes even for a normally capable lead. */
export const READ_ONLY_CAPABILITY_FIXTURE: RuntimeCapabilityFixture = Object.freeze({
  staticReadOnly: true,
  capabilities: Object.freeze([...ROLE_CAPABILITIES["case-lead"]]),
});
