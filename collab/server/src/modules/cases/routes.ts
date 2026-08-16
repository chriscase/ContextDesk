import {
  ARTIFACT_KINDS,
  AUTH_ERROR_SCHEMA_ID,
  CASE_LIST_SCHEMA_ID,
  CASE_SEVERITIES,
  CASE_STATUSES,
  HYPOTHESIS_STATUSES,
  PRIVACY_CLASSES,
  PROVENANCE_SCHEMA_ID,
  TIMELINE_SCHEMA_ID,
  type ArtifactKind,
  type AuthErrorV1,
  type CaseSeverity,
  type CaseStatus,
  type HypothesisStatus,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  resolveActiveSession,
  type ActiveSessionDeps,
} from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import { LegalHoldError, type Actor, type CaseService } from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function domainError(
  reply: { code: (status: number) => unknown },
  err: unknown,
): { error: string } {
  if (err instanceof LegalHoldError) {
    void reply.code(409);
    return { error: "legal_hold" };
  }
  const message = err instanceof Error ? err.message : "invalid";
  if (message === "case not found" || message === "contribution not found") {
    void reply.code(404);
    return { error: "not_found" };
  }
  void reply.code(400);
  return { error: message };
}

interface CaseSessionContext {
  actor: Actor;
  isAdmin: boolean;
  canRead: boolean;
}

async function requireCaseAccess(
  domain: CaseService,
  ctx: CaseSessionContext,
  caseId: string,
  reply: { code: (status: number) => unknown },
): Promise<boolean> {
  if (!ctx.canRead) {
    void reply.code(403);
    return false;
  }
  if (!(await domain.getCase(caseId, ctx.actor, ctx.isAdmin))) {
    void reply.code(404);
    return false;
  }
  return true;
}

export interface CaseRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  domain: CaseService;
}

export async function registerCaseRoutes(
  app: FastifyInstance,
  deps: CaseRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest) {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: { id: session.identity.id, username: session.identity.username },
      roles,
      isAdmin: canPerform(roles, "admin"),
      canRead: canPerform(roles, "read"),
      canWrite: canPerform(roles, "mutate"),
      canLead: canPerform(roles, "lead"),
    };
  }

  app.get("/api/cases", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    return {
      schemaId: CASE_LIST_SCHEMA_ID,
      cases: await deps.domain.listCases(ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "case_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const title = str(body.title);
    if (!title) {
      void reply.code(400);
      return authError("forbidden");
    }
    const input: { title: string; severity?: CaseSeverity; clientTime?: string } = { title };
    const severity = str(body.severity);
    if (severity && (CASE_SEVERITIES as readonly string[]).includes(severity)) {
      input.severity = severity as CaseSeverity;
    }
    const clientTime = str(body.clientTime);
    if (clientTime) input.clientTime = clientTime;
    return deps.domain.createCase(ctx.actor, input, request.ip);
  });

  app.get("/api/cases/:id", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    const found = await deps.domain.getCase(id, ctx.actor, ctx.isAdmin);
    if (!found) return { error: "not_found" };
    return found;
  });

  app.post("/api/cases/:id/status", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const status = str(asRecord(request.body).status);
    if (!status || !(CASE_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400);
      return authError("forbidden");
    }
    try {
      return await deps.domain.setStatus(id, ctx.actor, status as CaseStatus, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/participants", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const identityId = str(body.identityId);
    const username = str(body.username);
    if (!identityId || !username) {
      void reply.code(400);
      return authError("forbidden");
    }
    try {
      return await deps.domain.addParticipant(
        id,
        ctx.actor,
        { identityId, username },
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/legal-hold", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.isAdmin) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const legalHold = asRecord(request.body).legalHold === true;
    try {
      return await deps.domain.setLegalHold(id, ctx.actor, legalHold, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/timeline", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: TIMELINE_SCHEMA_ID,
      caseId: id,
      events: await deps.domain.listTimeline(id),
    };
  });

  app.post("/api/cases/:id/contributions", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "contribution_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const kind = str(body.kind);
    const text = str(body.body);
    if (!kind || text === undefined) {
      void reply.code(400);
      return authError("forbidden");
    }
    const input: {
      kind: string;
      body: string;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      hypothesisStatus?: HypothesisStatus;
      hypothesisLinks?: { kind: "artifact" | "contribution"; id: string }[];
      sourceId?: string;
    } = { kind, body: text };
    const privacy = str(body.privacyClass);
    if (privacy && (PRIVACY_CLASSES as readonly string[]).includes(privacy)) {
      input.privacyClass = privacy as PrivacyClass;
    }
    const clientTime = str(body.clientTime);
    if (clientTime) input.clientTime = clientTime;
    const hypothesisStatus = str(body.hypothesisStatus);
    if (
      hypothesisStatus &&
      (HYPOTHESIS_STATUSES as readonly string[]).includes(hypothesisStatus)
    ) {
      input.hypothesisStatus = hypothesisStatus as HypothesisStatus;
    }
    if (Array.isArray(body.hypothesisLinks)) {
      input.hypothesisLinks = body.hypothesisLinks as {
        kind: "artifact" | "contribution";
        id: string;
      }[];
    }
    const sourceId = str(body.sourceId);
    if (sourceId) input.sourceId = sourceId;
    try {
      return await deps.domain.addContribution(id, ctx.actor, input, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/contributions/:cid/revisions", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const text = str(asRecord(request.body).body);
    if (text === undefined) {
      void reply.code(400);
      return authError("forbidden");
    }
    try {
      return await deps.domain.reviseContribution(
        params.id,
        params.cid,
        ctx.actor,
        text,
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/contributions/:cid/tombstone", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    try {
      return await deps.domain.tombstoneContribution(
        params.id,
        params.cid,
        ctx.actor,
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/contributions/:cid/provenance", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    try {
      return {
        schemaId: PROVENANCE_SCHEMA_ID,
        contributionId: params.cid,
        revisions: await deps.domain.provenance(params.id, params.cid),
      };
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/hypotheses/:cid/status", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const status = str(body.status);
    if (!status || !(HYPOTHESIS_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400);
      return authError("forbidden");
    }
    const links = Array.isArray(body.links)
      ? (body.links as { kind: "artifact" | "contribution"; id: string }[])
      : [];
    try {
      return await deps.domain.setHypothesisStatus(
        params.id,
        params.cid,
        ctx.actor,
        status as HypothesisStatus,
        links,
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/evidence", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const kind = str(body.kind);
    const summary = str(body.summary);
    if (!kind || !summary) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
      void reply.code(400);
      return authError("forbidden");
    }
    const raw = str(body.contentBase64);
    const evidence: {
      kind: ArtifactKind;
      summary: string;
      filename?: string;
      mediaType?: string;
      bytes?: Uint8Array;
      uri?: string;
      expectedHash?: string | null;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      sourceId?: string;
    } = { kind: kind as ArtifactKind, summary };
    const filename = str(body.filename);
    if (filename) evidence.filename = filename;
    const mediaType = str(body.mediaType);
    if (mediaType) evidence.mediaType = mediaType;
    if (raw) evidence.bytes = Uint8Array.from(Buffer.from(raw, "base64"));
    const uri = str(body.uri);
    if (uri) evidence.uri = uri;
    if (body.expectedHash === null) evidence.expectedHash = null;
    else {
      const expectedHash = str(body.expectedHash);
      if (expectedHash) evidence.expectedHash = expectedHash;
    }
    const privacy = str(body.privacyClass);
    if (privacy && (PRIVACY_CLASSES as readonly string[]).includes(privacy)) {
      evidence.privacyClass = privacy as PrivacyClass;
    }
    const clientTime = str(body.clientTime);
    if (clientTime) evidence.clientTime = clientTime;
    const evidenceSource = str(body.sourceId);
    if (evidenceSource) evidence.sourceId = evidenceSource;
    try {
      return await deps.domain.addEvidence(id, ctx.actor, evidence, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/evidence/:eid", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    const found = await deps.domain.getArtifact(params.id, params.eid);
    if (!found) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return found;
  });

  app.get("/api/cases/:id/evidence/:eid/bytes", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    const bytes = await deps.domain.getArtifactBytes(
      params.id,
      params.eid,
      ctx.actor,
      ctx.isAdmin,
    );
    if (!bytes) {
      void reply.code(403);
      return authError("forbidden");
    }
    return { contentBase64: Buffer.from(bytes).toString("base64") };
  });

  app.post("/api/cases/:id/evidence/:eid/recheck", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    try {
      return await deps.domain.recheckReference(
        params.id,
        params.eid,
        ctx.actor,
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });
}
