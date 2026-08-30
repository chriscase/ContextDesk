import {
  ARTIFACT_KINDS,
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  CASE_LIST_SCHEMA_ID,
  CASE_SEVERITIES,
  CASE_STATUSES,
  CONTRIBUTION_LIST_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  HYPOTHESIS_STATUSES,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  PRIVACY_CLASSES,
  PROVENANCE_SCHEMA_ID,
  SNAPSHOT_LIST_SCHEMA_ID,
  TIMELINE_SCHEMA_ID,
  isContributionIdempotencyKey,
  parseInvestigationLifecycleActionRequest,
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
  requireSessionCapability,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import {
  resolutionDomainError,
  resolutionInputFrom,
} from "../resolutions/index.js";
import {
  ContributionConflictError,
  LifecycleActionRequiredError,
  LifecycleChangedError,
  LifecycleRefusedError,
  LegalHoldError,
  StatusChangedError,
  SituationConflictError,
  type Actor,
  type CaseService,
  type CaseSituationInput,
} from "./service.js";

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

function clientTimeInput(body: Record<string, unknown>):
  | { valid: true; value: string | undefined }
  | { valid: false } {
  if (!Object.prototype.hasOwnProperty.call(body, "clientTime")) {
    return { valid: true, value: undefined };
  }
  return typeof body.clientTime === "string"
    ? { valid: true, value: body.clientTime }
    : { valid: false };
}

/**
 * Occurrence fields as supplied. They are passed through verbatim; the
 * contract derives precision and zone from the text so the route cannot
 * become a second, laxer definition of a valid date.
 */
function occurrenceInput(body: Record<string, unknown>): {
  occurredAt?: unknown;
  occurredAtPrecision?: unknown;
  occurredAtZone?: unknown;
} {
  const input: { occurredAt?: unknown; occurredAtPrecision?: unknown; occurredAtZone?: unknown } =
    {};
  if (Object.prototype.hasOwnProperty.call(body, "occurredAt")) input.occurredAt = body.occurredAt;
  if (Object.prototype.hasOwnProperty.call(body, "occurredAtPrecision")) {
    input.occurredAtPrecision = body.occurredAtPrecision;
  }
  if (Object.prototype.hasOwnProperty.call(body, "occurredAtZone")) {
    input.occurredAtZone = body.occurredAtZone;
  }
  return input;
}

const SITUATION_KEYS = [
  "problemStatement",
  "affectedParties",
  "impact",
  "scope",
  "openQuestions",
  "investigationContext",
] as const;

function situationInput(body: Record<string, unknown>):
  | { valid: true; value: Partial<CaseSituationInput>; supplied: boolean }
  | { valid: false } {
  const value: Partial<CaseSituationInput> = {};
  let supplied = false;
  for (const key of SITUATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    supplied = true;
    const field = body[key];
    if (key === "openQuestions") {
      if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
        return { valid: false };
      }
      value.openQuestions = field;
    } else if (key === "investigationContext") {
      if (field !== null && (typeof field !== "object" || Array.isArray(field))) {
        return { valid: false };
      }
      value.investigationContext = field;
    } else {
      if (typeof field !== "string") return { valid: false };
      value[key] = field;
    }
  }
  return { valid: true, value, supplied };
}

function domainError(
  reply: { code: (status: number) => unknown },
  err: unknown,
) {
  if (err instanceof LifecycleChangedError) {
    void reply.code(409);
    return err.conflict;
  }
  if (err instanceof LifecycleActionRequiredError) {
    void reply.code(400);
    return {
      error: "lifecycle_action_required",
      investigationId: err.investigationId,
      action: err.action,
      endpoint: err.endpoint,
    };
  }
  if (err instanceof StatusChangedError) {
    void reply.code(409);
    return { error: "status_changed", currentStatus: err.currentStatus };
  }
  // A refused archive or restore is a conflict with recorded state, not a
  // malformed request. The reason travels with it so the surface can point at
  // the legal-hold control instead of printing an unexplained 400.
  if (err instanceof LifecycleRefusedError) {
    void reply.code(409);
    return {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
      error: "lifecycle_refused",
      investigationId: err.investigationId,
      action: err.action,
      reason: err.reason,
      detail: err.detail,
    };
  }
  if (err instanceof LegalHoldError) {
    void reply.code(409);
    return { error: "legal_hold" };
  }
  if (err instanceof SituationConflictError) {
    void reply.code(409);
    return { error: "situation_conflict", currentVersion: err.currentVersion };
  }
  if (err instanceof ContributionConflictError) {
    void reply.code(409);
    return err.currentRevision === undefined
      ? { error: "contribution_conflict" }
      : { error: "contribution_conflict", currentRevision: err.currentRevision };
  }
  if (err instanceof ContractViolation) {
    void reply.code(400);
    return { error: "invalid", detail: `${err.path}: ${err.detail}` };
  }
  const message = err instanceof Error ? err.message : "invalid";
  if (
    message === "case not found" ||
    message === "contribution not found" ||
    message === "snapshot not found"
  ) {
    void reply.code(404);
    return { error: "not_found" };
  }
  void reply.code(400);
  return { error: message };
}

async function requireCaseAccess(
  domain: CaseService,
  ctx: AuthorizedSession,
  caseId: string,
  reply: { code: (status: number) => unknown },
): Promise<boolean> {
  if (!ctx.has("investigation:read")) {
    void reply.code(403);
    return false;
  }
  if (!(await domain.getCase(caseId, ctx.actor, ctx.isAdmin))) {
    void reply.code(404);
    return false;
  }
  return true;
}

/**
 * Narrow read-only view of the experiments module: enough to surface each
 * experiment's accepted decision on the case board without a module cycle.
 */
export interface AcceptedDecisionSource {
  list(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<
    {
      decisions: { id: string; status: string; text: string; evidenceRefs: string[] }[];
      snapshotFingerprint?: string | null;
    }[]
  >;
}

export interface CaseRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  domain: CaseService;
  experiments?: AcceptedDecisionSource;
}

export async function registerCaseRoutes(
  app: FastifyInstance,
  deps: CaseRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/activity", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const rawLimit = (request.query as { limit?: unknown }).limit;
    const parsedLimit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : 30;
    return {
      schemaId: "cd-collab.activity_feed.v1",
      activities: await deps.domain.listRecentActivity(ctx.actor, ctx.isAdmin, parsedLimit),
    };
  });

  app.get("/api/cases", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    return {
      schemaId: CASE_LIST_SCHEMA_ID,
      cases: await deps.domain.listCases(ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
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
    const situation = situationInput(body);
    const suppliedClientTime = clientTimeInput(body);
    if (!situation.valid || !suppliedClientTime.valid) {
      void reply.code(400);
      return authError("forbidden");
    }
    const input: {
      title: string;
      severity?: CaseSeverity;
      clientTime?: string;
      problemStatement?: string;
      affectedParties?: string;
      impact?: string;
      scope?: string;
      openQuestions?: string[];
      investigationContext?: unknown;
      occurredAt?: unknown;
      occurredAtPrecision?: unknown;
      occurredAtZone?: unknown;
    } = { title, ...situation.value, ...occurrenceInput(body) };
    const severity = str(body.severity);
    if (severity && (CASE_SEVERITIES as readonly string[]).includes(severity)) {
      input.severity = severity as CaseSeverity;
    }
    if (suppliedClientTime.value !== undefined) input.clientTime = suppliedClientTime.value;
    try {
      return await deps.domain.createCase(ctx.actor, input, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    const found = await deps.domain.getCase(id, ctx.actor, ctx.isAdmin);
    if (!found) return { error: "not_found" };
    return found;
  });

  app.post("/api/cases/:id/status", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const status = str(body.status);
    const suppliedClientTime = clientTimeInput(body);
    if (!status || !(CASE_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    let resolution: unknown;
    try {
      resolution = resolutionInputFrom(body.resolution);
    } catch (err) {
      void reply.code(400);
      return { error: "invalid", detail: err instanceof Error ? err.message : "invalid" };
    }
    const options: {
      clientTime?: string;
      resolution?: unknown;
      expectedResolutionRevision?: number;
    } = {};
    if (suppliedClientTime.value !== undefined) options.clientTime = suppliedClientTime.value;
    if (resolution !== undefined) options.resolution = resolution;
    if (typeof body.expectedResolutionRevision === "number") {
      options.expectedResolutionRevision = body.expectedResolutionRevision;
    }
    try {
      return await deps.domain.setStatus(id, ctx.actor, status as CaseStatus, request.ip, options);
    } catch (err) {
      // A refused conclusive transition is not a generic 400: the caller needs
      // to know a resolution record is what is missing, so the UI can open the
      // right form instead of showing an unexplained failure.
      const mapped = resolutionDomainError(reply, err);
      if (mapped) return mapped;
      return domainError(reply, err);
    }
  });

  /**
   * What archiving or restoring this investigation would do, before anyone
   * commits to it.
   *
   * A surface that offers "Archive" without knowing a legal hold will refuse
   * it can only report the refusal after the click. A surface that offers
   * "Restore" without knowing where it lands has to describe the outcome
   * vaguely, or wrongly. Both answers are already derivable from recorded
   * state, so they are served rather than guessed.
   */
  app.get("/api/cases/:id/lifecycle", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    try {
      return await deps.domain.lifecycleFor(id);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/lifecycle", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    try {
      const body = parseInvestigationLifecycleActionRequest(request.body);
      if (body.investigationId !== id) {
        void reply.code(400);
        return {
          error: "invalid",
          detail: "$.investigationId: must match the path investigation id",
        };
      }
      return await deps.domain.applyLifecycleAction(body, ctx.actor, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/occurred-at", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    try {
      return await deps.domain.setOccurredAt(
        id,
        ctx.actor,
        occurrenceInput(body),
        request.ip,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.patch("/api/cases/:id/situation", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const situation = situationInput(body);
    const suppliedClientTime = clientTimeInput(body);
    const expectedVersion = body.expectedVersion;
    if (
      !situation.valid
      || !situation.supplied
      || !suppliedClientTime.valid
      || !Number.isSafeInteger(expectedVersion)
      || (expectedVersion as number) < 0
    ) {
      void reply.code(400);
      return authError("forbidden");
    }
    try {
      return await deps.domain.updateSituation(
        id,
        ctx.actor,
        situation.value,
        expectedVersion as number,
        request.ip,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/participants", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("admin:system_config")) {
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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

  app.get("/api/cases/:id/snapshots", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: SNAPSHOT_LIST_SCHEMA_ID,
      caseId: id,
      snapshots: await deps.domain.listSnapshots(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases/:id/snapshots", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    if (!Array.isArray(body.evidenceIds) || !body.evidenceIds.every((value) => typeof value === "string")) {
      void reply.code(400);
      return { error: "evidenceIds must be an array of strings" };
    }
    const visibility = str(body.visibility);
    const protocolVersion = str(body.protocolVersion);
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    try {
      return await deps.domain.createSnapshot(
        id,
        ctx.actor,
        {
          evidenceIds: body.evidenceIds,
          ...(visibility && (PRIVACY_CLASSES as readonly string[]).includes(visibility)
            ? { visibility: visibility as PrivacyClass }
            : {}),
          ...(protocolVersion ? { protocolVersion } : {}),
          ...(suppliedClientTime.value === undefined
            ? {}
            : { clientTime: suppliedClientTime.value }),
        },
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/board", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    const query = request.query as { snapshotId?: string };
    try {
      let acceptedDecisions;
      if (deps.experiments) {
        const experiments = await deps.experiments.list(id, ctx.actor, ctx.isAdmin);
        acceptedDecisions = experiments.flatMap((experiment) => {
          const accepted = [...experiment.decisions]
            .reverse()
            .find((decision) => decision.status === "accepted");
          return accepted
            ? [{
              id: accepted.id,
              statement: accepted.text,
              evidenceRefs: accepted.evidenceRefs,
              ...(typeof experiment.snapshotFingerprint === "string"
                ? { snapshotFingerprint: experiment.snapshotFingerprint }
                : {}),
            }]
            : [];
        });
      }
      const board = await deps.domain.getCaseBoard(
        id,
        ctx.actor,
        ctx.isAdmin,
        query.snapshotId,
        acceptedDecisions,
      );
      return board ?? { error: "not_found" };
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/contributions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
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
      idempotencyKey?: string;
    } = { kind, body: text };
    const privacy = str(body.privacyClass);
    if (privacy && (PRIVACY_CLASSES as readonly string[]).includes(privacy)) {
      input.privacyClass = privacy as PrivacyClass;
    }
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    if (suppliedClientTime.value !== undefined) input.clientTime = suppliedClientTime.value;
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
    if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey")) {
      const idempotencyKey = str(body.idempotencyKey);
      if (idempotencyKey === undefined || !isContributionIdempotencyKey(idempotencyKey)) {
        void reply.code(400);
        return { error: "invalid contribution idempotency key" };
      }
      input.idempotencyKey = idempotencyKey;
    }
    try {
      return await deps.domain.addContribution(id, ctx.actor, input, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/contributions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: CONTRIBUTION_LIST_SCHEMA_ID,
      caseId: id,
      contributions: await deps.domain.listContributions(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases/:id/contributions/:cid/revisions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const text = str(body.body);
    const suppliedClientTime = clientTimeInput(body);
    if (text === undefined) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      void reply.code(400);
      return { error: "expectedRevision is required" };
    }
    try {
      return await deps.domain.reviseContribution(
        params.id,
        params.cid,
        ctx.actor,
        text,
        request.ip,
        expectedRevision,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/contributions/:cid/tombstone", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const status = str(body.status);
    const suppliedClientTime = clientTimeInput(body);
    if (!status || !(HYPOTHESIS_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
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
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/evidence", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
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
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    if (suppliedClientTime.value !== undefined) evidence.clientTime = suppliedClientTime.value;
    const evidenceSource = str(body.sourceId);
    if (evidenceSource) evidence.sourceId = evidenceSource;
    try {
      const uploaded = await deps.domain.addEvidence(id, ctx.actor, evidence, request.ip);
      return {
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: id,
        ...uploaded,
      };
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/evidence", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: EVIDENCE_LIST_SCHEMA_ID,
      caseId: id,
      artifacts: await deps.domain.listArtifacts(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.get("/api/cases/:id/evidence/:eid", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    const bytes = await deps.domain.getArtifactBytes(
      params.id,
      params.eid,
      ctx.actor,
      ctx.isAdmin,
      ctx.has("evidence:private:read"),
    );
    if (!bytes) {
      void reply.code(403);
      return authError("forbidden");
    }
    return { contentBase64: Buffer.from(bytes).toString("base64") };
  });

  app.post("/api/cases/:id/evidence/:eid/recheck", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
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
