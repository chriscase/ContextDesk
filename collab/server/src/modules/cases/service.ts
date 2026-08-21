import { randomUUID } from "node:crypto";
import {
  ARTIFACT_SCHEMA_ID,
  CASE_SCHEMA_ID,
  CONTRIBUTION_SCHEMA_ID,
  type ArtifactKind,
  type ArtifactV1,
  type CaseSeverity,
  type CaseStatus,
  type CaseV1,
  type ContributionV1,
  type HypothesisStatus,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { EvidenceStore } from "../../evidence/store.js";
import type { AuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  assertSupportedLinks,
  defaultPrivacy,
  hashContributionContent,
  isContributionKind,
} from "../contributions/index.js";
import { assertSafeFilename, assertUploadAllowed } from "../evidence/index.js";
import { LegalHoldError, assertCanTombstone, visibleBody } from "../provenance/index.js";
import {
  MemoryCaseStore,
  type Actor,
  type ArtifactRow,
  type CaseStore,
  type RevisionRow,
  type TimelineInsert,
  type TimelineRow,
} from "./store.js";

export type { Actor, TimelineRow } from "./store.js";

export class CaseService {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly audit: AuditStore,
    private readonly store: CaseStore = new MemoryCaseStore(),
    private readonly catalog: CatalogService = new CatalogService(),
  ) {}

  async appendDomainTimeline(caseId: string, event: TimelineInsert): Promise<TimelineRow> {
    await this.requireCase(caseId);
    return this.store.appendTimeline(caseId, event);
  }

  async listCases(actor: Actor, isAdmin: boolean): Promise<CaseV1[]> {
    const rows = await this.store.listCases();
    return rows.filter((c) => isAdmin || this.isMember(c, actor.id)).map((c) => this.toCase(c));
  }

  async getCase(id: string, actor: Actor, isAdmin: boolean): Promise<CaseV1 | null> {
    const row = await this.store.getCase(id);
    if (!row) return null;
    if (!isAdmin && !this.isMember(row, actor.id)) return null;
    return this.toCase(row);
  }

  async createCase(
    actor: Actor,
    input: { title: string; severity?: CaseSeverity; clientTime?: string },
    origin: string,
  ): Promise<CaseV1> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      title: input.title,
      severity: input.severity ?? "medium",
      status: "open" as const,
      legalHold: false,
      retentionClass: "standard",
      createdAt: now,
      createdBy: actor.id,
      createdByUsername: actor.username,
      participants: [{ identityId: actor.id, username: actor.username }],
    };
    await this.store.insertCase(row);
    await this.store.appendTimeline(id, {
      kind: "case_created",
      actor,
      targetId: id,
      clientTime: input.clientTime ?? null,
      payload: { title: row.title },
    });
    await this.audit.append({
      identity: actor.id,
      action: "case_create",
      target: id,
      origin,
      outcome: "success",
    });
    return this.toCase(row);
  }

  async setStatus(
    caseId: string,
    actor: Actor,
    status: CaseStatus,
    origin: string,
    clientTime?: string,
  ): Promise<CaseV1> {
    const row = await this.requireCase(caseId);
    row.status = status;
    await this.store.updateCaseMeta(row);
    await this.store.appendTimeline(caseId, {
      kind: "case_status",
      actor,
      targetId: caseId,
      clientTime: clientTime ?? null,
      payload: { status },
    });
    await this.audit.append({
      identity: actor.id,
      action: "case_status",
      target: `${caseId}:${status}`,
      origin,
      outcome: "success",
    });
    return this.toCase(row);
  }

  async addParticipant(
    caseId: string,
    actor: Actor,
    participant: { identityId: string; username: string },
    origin: string,
  ): Promise<CaseV1> {
    await this.requireCase(caseId);
    await this.store.addParticipant(caseId, participant, actor.id);
    await this.store.appendTimeline(caseId, {
      kind: "membership",
      actor,
      targetId: participant.identityId,
      clientTime: null,
      payload: { username: participant.username },
    });
    await this.audit.append({
      identity: actor.id,
      action: "case_membership",
      target: `${caseId}:${participant.identityId}`,
      origin,
      outcome: "success",
    });
    const updated = await this.requireCase(caseId);
    return this.toCase(updated);
  }

  async setLegalHold(
    caseId: string,
    actor: Actor,
    legalHold: boolean,
    origin: string,
  ): Promise<CaseV1> {
    const row = await this.requireCase(caseId);
    row.legalHold = legalHold;
    await this.store.updateCaseMeta(row);
    await this.store.appendTimeline(caseId, {
      kind: "legal_hold",
      actor,
      targetId: caseId,
      clientTime: null,
      payload: { legalHold },
    });
    await this.audit.append({
      identity: actor.id,
      action: "legal_hold",
      target: `${caseId}:${legalHold}`,
      origin,
      outcome: "success",
    });
    return this.toCase(row);
  }

  async listTimeline(caseId: string): Promise<TimelineRow[]> {
    await this.requireCase(caseId);
    return this.store.listTimeline(caseId);
  }

  async listContributions(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ContributionV1[]> {
    if (!(await this.getCase(caseId, actor, isAdmin))) return [];
    const rows = await this.store.listLatestRevisions(caseId);
    return rows.map((row) => this.toContribution(row, row.tombstone));
  }

  async listArtifacts(caseId: string, actor: Actor, isAdmin: boolean): Promise<ArtifactV1[]> {
    if (!(await this.getCase(caseId, actor, isAdmin))) return [];
    return (await this.store.listArtifactsByCase(caseId)).map((row) => this.toArtifact(row));
  }

  async addContribution(
    caseId: string,
    actor: Actor,
    input: {
      kind: string;
      body: string;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      hypothesisStatus?: HypothesisStatus;
      hypothesisLinks?: { kind: "artifact" | "contribution"; id: string }[];
      sourceId?: string;
    },
    origin: string,
  ): Promise<ContributionV1> {
    await this.requireCase(caseId);
    if (!isContributionKind(input.kind)) {
      throw new Error(`unknown contribution kind: ${input.kind}`);
    }
    const links = input.hypothesisLinks ?? [];
    if (input.kind === "hypothesis") {
      assertSupportedLinks(input.hypothesisStatus ?? "proposed", links);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const privacy = defaultPrivacy(input.privacyClass);
    const hash = hashContributionContent(input.kind, input.body);
    const sourceId = await this.resolveSourceId(actor, input.sourceId);
    const rev: RevisionRow = {
      contributionId: id,
      caseId,
      kind: input.kind,
      revision: 1,
      predecessorRevision: null,
      body: input.body,
      contentHash: hash,
      privacyClass: privacy,
      tombstone: false,
      authorId: actor.id,
      authorUsername: actor.username,
      createdAt: now,
      hypothesisStatus: input.kind === "hypothesis" ? (input.hypothesisStatus ?? "proposed") : null,
      hypothesisLinks: links,
      sourceId,
    };
    await this.store.insertRevision(rev);
    await this.store.appendTimeline(caseId, {
      kind: "contribution_created",
      actor,
      targetId: id,
      clientTime: input.clientTime ?? null,
      payload: { kind: input.kind, contentHash: hash, privacyClass: privacy, sourceId },
    });
    await this.audit.append({
      identity: actor.id,
      action: "contribution_create",
      target: id,
      origin,
      outcome: "success",
    });
    return this.toContribution(rev, false);
  }

  async reviseContribution(
    caseId: string,
    contributionId: string,
    actor: Actor,
    body: string,
    origin: string,
    clientTime?: string,
  ): Promise<ContributionV1> {
    const latest = await this.requireLatest(caseId, contributionId);
    if (latest.tombstone) throw new Error("contribution not found");
    const next: RevisionRow = {
      ...latest,
      revision: latest.revision + 1,
      predecessorRevision: latest.revision,
      body,
      contentHash: hashContributionContent(latest.kind, body),
      authorId: actor.id,
      authorUsername: actor.username,
      createdAt: new Date().toISOString(),
      tombstone: false,
    };
    await this.store.insertRevision(next);
    await this.store.appendTimeline(caseId, {
      kind: "contribution_revised",
      actor,
      targetId: contributionId,
      clientTime: clientTime ?? null,
      payload: {
        revision: next.revision,
        predecessor: latest.revision,
        contentHash: next.contentHash,
      },
    });
    await this.audit.append({
      identity: actor.id,
      action: "contribution_revise",
      target: `${contributionId}:${next.revision}`,
      origin,
      outcome: "success",
    });
    return this.toContribution(next, false);
  }

  async tombstoneContribution(
    caseId: string,
    contributionId: string,
    actor: Actor,
    origin: string,
  ): Promise<ContributionV1> {
    const row = await this.requireCase(caseId);
    assertCanTombstone(row.legalHold);
    const latest = await this.requireLatest(caseId, contributionId);
    const next: RevisionRow = {
      ...latest,
      revision: latest.revision + 1,
      predecessorRevision: latest.revision,
      body: "",
      contentHash: hashContributionContent(latest.kind, ""),
      authorId: actor.id,
      authorUsername: actor.username,
      createdAt: new Date().toISOString(),
      tombstone: true,
    };
    await this.store.insertRevision(next);
    await this.store.appendTimeline(caseId, {
      kind: "contribution_tombstoned",
      actor,
      targetId: contributionId,
      clientTime: null,
      payload: { revision: next.revision },
    });
    await this.audit.append({
      identity: actor.id,
      action: "contribution_tombstone",
      target: contributionId,
      origin,
      outcome: "success",
    });
    return this.toContribution(next, true);
  }

  async provenance(caseId: string, contributionId: string): Promise<ContributionV1[]> {
    const chain = await this.store.listRevisions(contributionId);
    if (!chain.length || chain[0]?.caseId !== caseId) {
      throw new Error("contribution not found");
    }
    return chain.map((rev) => this.toContribution(rev, false));
  }

  async setHypothesisStatus(
    caseId: string,
    contributionId: string,
    actor: Actor,
    status: HypothesisStatus,
    links: { kind: "artifact" | "contribution"; id: string }[],
    origin: string,
    clientTime?: string,
  ): Promise<ContributionV1> {
    assertSupportedLinks(status, links);
    const latest = await this.requireLatest(caseId, contributionId);
    if (latest.kind !== "hypothesis" || latest.tombstone) {
      throw new Error("hypothesis not found");
    }
    const next: RevisionRow = {
      ...latest,
      revision: latest.revision + 1,
      predecessorRevision: latest.revision,
      contentHash: hashContributionContent(latest.kind, latest.body),
      authorId: actor.id,
      authorUsername: actor.username,
      createdAt: new Date().toISOString(),
      hypothesisStatus: status,
      hypothesisLinks: links,
    };
    await this.store.insertRevision(next);
    await this.store.appendTimeline(caseId, {
      kind: "hypothesis_status",
      actor,
      targetId: contributionId,
      clientTime: clientTime ?? null,
      payload: { status, links },
    });
    await this.audit.append({
      identity: actor.id,
      action: "hypothesis_status",
      target: `${contributionId}:${status}`,
      origin,
      outcome: "success",
    });
    return this.toContribution(next, false);
  }

  async addEvidence(
    caseId: string,
    actor: Actor,
    input: {
      kind: ArtifactKind;
      filename?: string;
      mediaType?: string;
      bytes?: Uint8Array;
      uri?: string;
      expectedHash?: string | null;
      summary: string;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      sourceId?: string;
    },
    origin: string,
  ): Promise<{ artifact: ArtifactV1; summary: ContributionV1 }> {
    await this.requireCase(caseId);
    if (input.filename) assertSafeFilename(input.filename);
    const privacy = defaultPrivacy(input.privacyClass);
    const sourceId = await this.resolveSourceId(actor, input.sourceId);
    const id = randomUUID();
    let contentHash: string | null = null;
    let byteLength: number | null = null;
    let verificationStatus: string | null = null;
    let expectedHash: string | null = input.expectedHash ?? null;
    let refId: string | null = null;
    const uri: string | null = input.uri ?? null;
    let mediaType = input.mediaType ?? null;

    if (input.kind === "file_server_ref") {
      if (!input.uri) throw new Error("file-server reference requires a URI");
      const ref = await this.evidence.putFileServerReference({
        uri: input.uri,
        expectedHash,
        verificationStatus: "unverified",
      });
      refId = ref.id;
      verificationStatus = ref.verificationStatus;
      expectedHash = ref.expectedHash;
    } else {
      if (!input.bytes) throw new Error("held artifact requires bytes");
      mediaType = mediaType ?? (input.kind === "email" ? "message/rfc822" : "text/plain");
      assertUploadAllowed(mediaType, input.bytes.byteLength);
      const meta = await this.evidence.put(input.bytes, { contentType: mediaType });
      contentHash = meta.hash;
      byteLength = meta.byteLength;
      if (!(await this.evidence.verify(meta.hash))) {
        throw new Error("hash verification failed after storage");
      }
    }

    const summaryInput: {
      kind: string;
      body: string;
      privacyClass: PrivacyClass;
      clientTime?: string;
      sourceId: string;
    } = {
      kind: "upload",
      body: input.summary,
      privacyClass: privacy,
      sourceId,
    };
    if (input.clientTime !== undefined) summaryInput.clientTime = input.clientTime;
    const summary = await this.addContribution(caseId, actor, summaryInput, origin);

    const row: ArtifactRow = {
      id,
      caseId,
      kind: input.kind,
      filename: input.filename ?? null,
      uri,
      mediaType,
      byteLength,
      contentHash,
      expectedHash,
      verificationStatus,
      refId,
      privacyClass: privacy,
      summaryContributionId: summary.id,
      uploaderId: actor.id,
      uploaderUsername: actor.username,
      sourceId,
    };
    await this.store.insertArtifact(row);
    await this.store.appendTimeline(caseId, {
      kind: "evidence_registered",
      actor,
      targetId: id,
      clientTime: input.clientTime ?? null,
      payload: {
        artifactKind: input.kind,
        contentHash,
        privacyClass: privacy,
        summaryId: summary.id,
      },
    });
    await this.audit.append({
      identity: actor.id,
      action: "evidence_register",
      target: id,
      origin,
      outcome: "success",
    });
    return { artifact: this.toArtifact(row), summary };
  }

  async getArtifact(caseId: string, artifactId: string): Promise<ArtifactV1 | null> {
    const row = await this.store.getArtifact(artifactId);
    if (!row || row.caseId !== caseId) return null;
    return this.toArtifact(row);
  }

  async getArtifactBytes(
    caseId: string,
    artifactId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<Uint8Array | null> {
    const caseRow = await this.requireCase(caseId);
    const row = await this.store.getArtifact(artifactId);
    if (!row || row.caseId !== caseId || !row.contentHash) return null;
    if (row.privacyClass === "owner_only" && !isAdmin && !this.isMember(caseRow, actor.id)) {
      return null;
    }
    return this.evidence.get(row.contentHash);
  }

  async recheckReference(
    caseId: string,
    artifactId: string,
    actor: Actor,
    origin: string,
  ): Promise<{ artifact: ArtifactV1; status: string }> {
    const row = await this.store.getArtifact(artifactId);
    if (!row || row.caseId !== caseId || !row.refId) {
      throw new Error("file-server reference not found");
    }
    const snapshot = { ...row };
    const checked = await this.evidence.verifyFileServerReference(row.refId);
    await this.store.appendTimeline(caseId, {
      kind: "evidence_recheck",
      actor,
      targetId: artifactId,
      clientTime: null,
      payload: {
        verificationStatus: checked.verificationStatus,
        originalVerificationStatus: snapshot.verificationStatus,
      },
    });
    await this.audit.append({
      identity: actor.id,
      action: "evidence_recheck",
      target: artifactId,
      origin,
      outcome: checked.verificationStatus === "verified" ? "success" : "failure",
    });
    return { artifact: this.toArtifact(snapshot), status: checked.verificationStatus };
  }

  async isMemberOf(caseId: string, identityId: string): Promise<boolean> {
    const row = await this.store.getCase(caseId);
    return row ? this.isMember(row, identityId) : false;
  }

  private isMember(row: { participants: { identityId: string }[] }, identityId: string): boolean {
    return row.participants.some((p) => p.identityId === identityId);
  }

  private async requireCase(id: string) {
    const row = await this.store.getCase(id);
    if (!row) throw new Error("case not found");
    return row;
  }

  private async requireLatest(caseId: string, contributionId: string): Promise<RevisionRow> {
    const chain = await this.store.listRevisions(contributionId);
    if (!chain.length || chain[0]?.caseId !== caseId) {
      throw new Error("contribution not found");
    }
    const latest = chain[chain.length - 1];
    if (!latest) throw new Error("contribution not found");
    return latest;
  }

  private toCase(row: {
    id: string;
    title: string;
    severity: CaseSeverity;
    status: CaseStatus;
    legalHold: boolean;
    retentionClass: string;
    participants: { identityId: string; username: string }[];
    createdAt: string;
    createdBy: string;
  }): CaseV1 {
    return {
      schemaId: CASE_SCHEMA_ID,
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      legalHold: row.legalHold,
      retentionClass: row.retentionClass,
      participants: row.participants.map((p) => ({
        identityId: p.identityId,
        username: p.username,
      })),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    };
  }

  private toContribution(rev: RevisionRow, hide: boolean): ContributionV1 {
    return {
      schemaId: CONTRIBUTION_SCHEMA_ID,
      id: rev.contributionId,
      caseId: rev.caseId,
      kind: rev.kind,
      revision: rev.revision,
      predecessorRevision: rev.predecessorRevision,
      body: hide ? visibleBody(true, rev.body) : rev.body,
      contentHash: rev.contentHash,
      privacyClass: rev.privacyClass,
      tombstoned: rev.tombstone,
      authorId: rev.authorId,
      authorUsername: rev.authorUsername,
      createdAt: rev.createdAt,
      hypothesisStatus: rev.hypothesisStatus,
      hypothesisLinks: rev.kind === "hypothesis" ? rev.hypothesisLinks : null,
      sourceId: rev.sourceId,
    };
  }

  private toArtifact(row: ArtifactRow): ArtifactV1 {
    return {
      schemaId: ARTIFACT_SCHEMA_ID,
      id: row.id,
      caseId: row.caseId,
      kind: row.kind,
      filename: row.filename,
      uri: row.uri,
      mediaType: row.mediaType,
      byteLength: row.byteLength,
      contentHash: row.contentHash,
      expectedHash: row.expectedHash,
      verificationStatus: row.verificationStatus,
      privacyClass: row.privacyClass,
      summaryContributionId: row.summaryContributionId,
      uploaderId: row.uploaderId,
      sourceId: row.sourceId,
    };
  }

  private async resolveSourceId(actor: Actor, sourceId?: string): Promise<string> {
    if (sourceId) {
      const found = await this.catalog.get(sourceId);
      if (!found) throw new Error("source not found");
      return found.id;
    }
    return (await this.catalog.ensureHumanSource(actor)).id;
  }
}

export { LegalHoldError };
export { MemoryCaseStore, PgCaseStore } from "./store.js";
export type { CaseStore } from "./store.js";
