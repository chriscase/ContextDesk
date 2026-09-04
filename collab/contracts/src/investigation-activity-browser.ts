/**
 * Browser-safe read contract for the investigation activity projection.
 *
 * Cursor encoding and fingerprinting deliberately stay in the server-owned
 * `investigation-activity` module because they depend on Node crypto/Buffer.
 * Browsers validate cursors as bounded opaque tokens and send them back
 * unchanged.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID =
  "cd-collab.investigation_resource_locator.v1" as const;
export const INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID =
  "cd-collab.investigation_activity_item.v1" as const;
export const INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID =
  "cd-collab.investigation_activity_page.v1" as const;
export const INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID =
  "cd-collab.investigation_resource_resolve.v1" as const;
export const INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID =
  "cd-collab.investigation_activity_error.v1" as const;

export const INVESTIGATION_ACTIVITY_KINDS = [
  "investigation_created", "investigation_updated", "evidence_added",
  "evidence_reviewed", "evidence_frozen", "evidence_omitted",
  "evidence_privacy_classified", "workstream_launched", "workstream_completed",
  "workstream_partially_completed", "workstream_canceled", "workstream_failed",
  "workstream_rerun", "comment_added", "observation_recorded",
  "hypothesis_recorded", "hypothesis_updated", "action_recorded",
  "assignment_recorded", "mention_recorded", "handoff_recorded",
  "comparison_disagreement", "comparison_unknown", "decision_proposed",
  "decision_revised", "decision_accepted", "decision_superseded",
  "import_recorded", "export_recorded", "restore_recorded",
] as const;
export type InvestigationActivityKindV1 = (typeof INVESTIGATION_ACTIVITY_KINDS)[number];

export const INVESTIGATION_STAGES = ["situation", "capture", "analyze", "compare", "decide"] as const;
export type InvestigationStageV1 = (typeof INVESTIGATION_STAGES)[number];

export const INVESTIGATION_PROVENANCE_CLASSES = [
  "human", "imported", "system", "ai_generated", "historical_restored",
] as const;
export type InvestigationProvenanceClassV1 = (typeof INVESTIGATION_PROVENANCE_CLASSES)[number];

export const INVESTIGATION_PRIVACY_VISIBILITIES = [
  "member", "owner_only", "share_safe", "redacted", "omitted",
] as const;
export type InvestigationPrivacyVisibilityV1 = (typeof INVESTIGATION_PRIVACY_VISIBILITIES)[number];

export const INVESTIGATION_ACTIVITY_ERROR_CODES = [
  "invalid_locator", "malformed_cursor", "stale_cursor", "invalid_filter", "not_found",
] as const;
export type InvestigationActivityErrorCodeV1 = (typeof INVESTIGATION_ACTIVITY_ERROR_CODES)[number];

export const INVESTIGATION_RESOURCE_KINDS = [
  "investigation", "investigation_stage", "evidence_item", "intake_batch",
  "evidence_context", "imported_ai_run", "workstream", "workstream_attempt",
  "workstream_rerun", "comparison_finding", "comparison_conflict", "helpfulness",
  "interaction_trace", "experiment", "discussion_message", "timeline_event",
  "hypothesis", "action", "observation", "decision_revision", "gold",
  "export_event", "portable_archive_event", "log_workbench_view",
  "log_workbench_bookmark", "log_workbench_line",
] as const;
export type InvestigationResourceKindV1 = (typeof INVESTIGATION_RESOURCE_KINDS)[number];

export const INVESTIGATION_ACTIVITY_NOTICES = [
  "Activity is a projection of recorded investigation events, not a second source of truth.",
  "A resource locator is not an authorization token.",
  "AI or imported output is never a human finding.",
  "Historical restored participants are attribution only.",
] as const;
export type InvestigationActivityNoticeV1 = (typeof INVESTIGATION_ACTIVITY_NOTICES)[number];

export interface InvestigationResourceLocatorV1 {
  schemaId: typeof INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID;
  version: 1;
  installationId: string;
  investigationId: string;
  kind: InvestigationResourceKindV1;
  resourceId: string;
  revision?: number;
  pathname: string;
}

export interface InvestigationActivityItemV1 {
  schemaId: typeof INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID;
  activityId: string;
  occurredAt: string;
  orderTieBreak: number;
  actorId: string;
  actorLabel: string;
  investigationId: string;
  investigationTitle: string;
  activityKind: InvestigationActivityKindV1;
  summary: string;
  locator: InvestigationResourceLocatorV1;
  resolvedRoute: string;
  provenanceClass: InvestigationProvenanceClassV1;
  privacyVisibility: InvestigationPrivacyVisibilityV1;
  revision: number | null;
  sourceEventId: string;
  secondaryContext?: { label: string; value: string };
  humanFinding: boolean;
}

export interface InvestigationActivityPageV1 {
  schemaId: typeof INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID;
  items: InvestigationActivityItemV1[];
  nextCursor: string | null;
  notices: InvestigationActivityNoticeV1[];
}

export interface InvestigationResourceResolveV1 {
  schemaId: typeof INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID;
  locator: InvestigationResourceLocatorV1;
  resourceKind: InvestigationResourceKindV1;
  resourceLabel: string;
  investigationTitle: string;
  revision: number | null;
  authorized: true;
}

export interface InvestigationActivityErrorV1 {
  schemaId: typeof INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID;
  error: InvestigationActivityErrorCodeV1;
}

export interface InvestigationActivityFilterV1 {
  investigationId?: string;
  actorId?: string;
  activityKind?: InvestigationActivityKindV1;
  stage?: InvestigationStageV1;
  workstreamId?: string;
  from?: string;
  to?: string;
  assignedToMe?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const OPAQUE_CURSOR_RE = /^[A-Za-z0-9_-]{8,4096}$/;

const locatorShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID)), version: f.req(f.u64),
  installationId: f.req(f.nstr), investigationId: f.req(f.nstr),
  kind: f.req(f.en(...INVESTIGATION_RESOURCE_KINDS)), resourceId: f.req(f.nstr),
  revision: f.opt(f.u64), pathname: f.req(f.nstr),
};
const itemShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID)), activityId: f.req(f.nstr),
  occurredAt: f.req(f.nstr), orderTieBreak: f.req(f.u64), actorId: f.req(f.nstr),
  actorLabel: f.req(f.nstr), investigationId: f.req(f.nstr), investigationTitle: f.req(f.nstr),
  activityKind: f.req(f.en(...INVESTIGATION_ACTIVITY_KINDS)), summary: f.req(f.nstr),
  locator: f.req(f.obj(locatorShape)), resolvedRoute: f.req(f.nstr),
  provenanceClass: f.req(f.en(...INVESTIGATION_PROVENANCE_CLASSES)),
  privacyVisibility: f.req(f.en(...INVESTIGATION_PRIVACY_VISIBILITIES)),
  revision: f.nul(f.u64), sourceEventId: f.req(f.nstr),
  secondaryContext: f.opt(f.obj({ label: f.req(f.nstr), value: f.req(f.nstr) })),
  humanFinding: f.req(f.bool),
};
const pageShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID)), items: f.req(f.arr(f.obj(itemShape))),
  nextCursor: f.nul(f.str), notices: f.req(f.arr(f.en(...INVESTIGATION_ACTIVITY_NOTICES))),
};
const resolveShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID)), locator: f.req(f.obj(locatorShape)),
  resourceKind: f.req(f.en(...INVESTIGATION_RESOURCE_KINDS)), resourceLabel: f.req(f.nstr),
  investigationTitle: f.req(f.nstr), revision: f.nul(f.u64), authorized: f.req(f.bool),
};
const errorShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID)),
  error: f.req(f.en(...INVESTIGATION_ACTIVITY_ERROR_CODES)),
};

function assertText(path: string, value: string): void {
  let hasControl = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) {
      hasControl = true;
      break;
    }
  }
  if (!value.trim() || hasControl) {
    throw new ContractViolation(path, "expected safe display text");
  }
}

function assertLocator(locator: InvestigationResourceLocatorV1): void {
  if (locator.version !== 1 || !/^inst-[a-z0-9]{8,64}$/.test(locator.installationId)) {
    throw new ContractViolation("$.locator", "invalid locator identity");
  }
  if (!UUID_RE.test(locator.investigationId) || locator.resourceId.includes("..")) {
    throw new ContractViolation("$.locator", "invalid resource identity");
  }
  const prefix = `/investigations/${locator.investigationId}`;
  if (!locator.pathname.startsWith(prefix) || locator.pathname.includes("\\") || locator.pathname.includes("//")) {
    throw new ContractViolation("$.locator.pathname", "expected a canonical investigation route");
  }
}

function assertItem(item: InvestigationActivityItemV1): void {
  if (!SHA256_RE.test(item.activityId) || !TIMESTAMP_RE.test(item.occurredAt) || !UUID_RE.test(item.investigationId)) {
    throw new ContractViolation("$.items", "invalid activity identity or timestamp");
  }
  assertLocator(item.locator);
  if (item.locator.investigationId !== item.investigationId || item.resolvedRoute !== item.locator.pathname) {
    throw new ContractViolation("$.resolvedRoute", "activity and locator must name the same route");
  }
  if (item.revision !== (item.locator.revision ?? null)) {
    throw new ContractViolation("$.revision", "revision must match the locator");
  }
  assertText("$.actorLabel", item.actorLabel);
  assertText("$.investigationTitle", item.investigationTitle);
  assertText("$.summary", item.summary);
  if (item.humanFinding && (item.provenanceClass === "ai_generated" || item.provenanceClass === "imported")) {
    throw new ContractViolation("$.humanFinding", "non-human output cannot be a human finding");
  }
}

export function parseInvestigationActivityPage(raw: unknown): InvestigationActivityPageV1 {
  checkObject("$", pageShape, raw);
  const page = raw as InvestigationActivityPageV1;
  if (page.items.length > 100) throw new ContractViolation("$.items", "expected at most 100 items");
  page.items.forEach(assertItem);
  if (page.nextCursor !== null && !OPAQUE_CURSOR_RE.test(page.nextCursor)) {
    throw new ContractViolation("$.nextCursor", "expected a bounded opaque cursor");
  }
  if (page.notices.length !== INVESTIGATION_ACTIVITY_NOTICES.length ||
      INVESTIGATION_ACTIVITY_NOTICES.some((notice) => !page.notices.includes(notice))) {
    throw new ContractViolation("$.notices", "expected each required notice exactly once");
  }
  return page;
}

export function parseInvestigationResourceResolve(raw: unknown): InvestigationResourceResolveV1 {
  checkObject("$", resolveShape, raw);
  const resolved = raw as InvestigationResourceResolveV1;
  assertLocator(resolved.locator);
  if (resolved.authorized !== true || resolved.resourceKind !== resolved.locator.kind ||
      resolved.revision !== (resolved.locator.revision ?? null)) {
    throw new ContractViolation("$", "resolve response does not match its locator");
  }
  assertText("$.resourceLabel", resolved.resourceLabel);
  assertText("$.investigationTitle", resolved.investigationTitle);
  return resolved;
}

export function parseInvestigationActivityError(raw: unknown): InvestigationActivityErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as InvestigationActivityErrorV1;
}

export function compactInvestigationLocator(locator: InvestigationResourceLocatorV1): string {
  assertLocator(locator);
  const revision = locator.revision === undefined ? "" : `;rev=${locator.revision}`;
  return `cdl.v1/${locator.installationId}/${locator.investigationId}/${locator.kind}/${locator.resourceId}${revision}`;
}
