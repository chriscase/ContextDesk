/**
 * Canonical War Room resource locator and investigation-activity projection.
 * Pure functions: no I/O, no authorization, no second source of truth.
 */
import { RFC4122_UUID_RE, canonicalJson, sha256Text } from "./investigation-portable.js";
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

export const INVESTIGATION_LOCATOR_VERSION = 1 as const;
export const INVESTIGATION_LOCATOR_COMPACT_PREFIX = "cdl.v1" as const;

export const INVESTIGATION_INSTALLATION_ID_RE = /^inst-[a-z0-9]{8,64}$/;
export const INVESTIGATION_TIMELINE_EVENT_ID_RE = /^[1-9][0-9]{0,15}$/;
export const INVESTIGATION_RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const INVESTIGATION_STAGES = [
  "situation",
  "capture",
  "analyze",
  "compare",
  "decide",
] as const;
export type InvestigationStageV1 = (typeof INVESTIGATION_STAGES)[number];

export const INVESTIGATION_RESOURCE_KINDS = [
  "investigation",
  "investigation_stage",
  "evidence_item",
  "evidence_context",
  "workstream",
  "workstream_attempt",
  "workstream_rerun",
  "comparison_finding",
  "comparison_conflict",
  "discussion_message",
  "timeline_event",
  "hypothesis",
  "action",
  "observation",
  "decision_revision",
  "export_event",
  "portable_archive_event",
] as const;
export type InvestigationResourceKindV1 = (typeof INVESTIGATION_RESOURCE_KINDS)[number];

export const INVESTIGATION_ACTIVITY_KINDS = [
  "investigation_created",
  "investigation_updated",
  "evidence_added",
  "evidence_reviewed",
  "evidence_frozen",
  "evidence_omitted",
  "evidence_privacy_classified",
  "workstream_launched",
  "workstream_completed",
  "workstream_partially_completed",
  "workstream_canceled",
  "workstream_failed",
  "workstream_rerun",
  "comment_added",
  "observation_recorded",
  "hypothesis_recorded",
  "hypothesis_updated",
  "action_recorded",
  "assignment_recorded",
  "mention_recorded",
  "handoff_recorded",
  "comparison_disagreement",
  "comparison_unknown",
  "decision_proposed",
  "decision_revised",
  "decision_accepted",
  "decision_superseded",
  "import_recorded",
  "export_recorded",
  "restore_recorded",
] as const;
export type InvestigationActivityKindV1 = (typeof INVESTIGATION_ACTIVITY_KINDS)[number];

export const INVESTIGATION_PROVENANCE_CLASSES = [
  "human",
  "imported",
  "system",
  "ai_generated",
  "historical_restored",
] as const;
export type InvestigationProvenanceClassV1 = (typeof INVESTIGATION_PROVENANCE_CLASSES)[number];

export const INVESTIGATION_PRIVACY_VISIBILITIES = [
  "member",
  "owner_only",
  "share_safe",
  "redacted",
  "omitted",
] as const;
export type InvestigationPrivacyVisibilityV1 = (typeof INVESTIGATION_PRIVACY_VISIBILITIES)[number];

export const INVESTIGATION_ACTIVITY_ERROR_CODES = [
  "invalid_locator",
  "malformed_cursor",
  "stale_cursor",
  "invalid_filter",
  "not_found",
] as const;
export type InvestigationActivityErrorCodeV1 = (typeof INVESTIGATION_ACTIVITY_ERROR_CODES)[number];

export const INVESTIGATION_ACTIVITY_PAGE_CAP = 100 as const;
export const INVESTIGATION_ACTIVITY_DEFAULT_LIMIT = 30 as const;

export const INVESTIGATION_ACTIVITY_NOTICES = [
  "Activity is a projection of recorded investigation events, not a second source of truth.",
  "A resource locator is not an authorization token.",
  "AI or imported output is never a human finding.",
  "Historical restored participants are attribution only.",
] as const;
export type InvestigationActivityNoticeV1 = (typeof INVESTIGATION_ACTIVITY_NOTICES)[number];

export const INVESTIGATION_ACTIVITY_AUTHORITY =
  "Authoritative source is the existing investigation timeline and the durable records it names. Activity rows are a deterministic projection, not a second write path." as const;

export const INVESTIGATION_LOCATOR_NOT_AUTHORIZATION =
  "A resource locator binds identity and a derived pathname. It is not an authorization token. Resolution must reauthorize at request time." as const;

export const INVESTIGATION_AI_NOT_HUMAN_FINDING =
  "AI or imported output is never a human-authored finding and is never marked verified." as const;

const UUID_RE = RFC4122_UUID_RE;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function hasControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x2028 && code <= 0x202f) return true;
    if (code >= 0x2060 && code <= 0x206f) return true;
    if (code === 0xfeff) return true;
  }
  return false;
}
const OPAQUE_EVENT_NAME_RE = /^[a-z][a-z0-9_]{2,64}$/;

export interface InvestigationResourceLocatorV1 {
  schemaId: typeof INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID;
  version: typeof INVESTIGATION_LOCATOR_VERSION;
  installationId: string;
  investigationId: string;
  kind: InvestigationResourceKindV1;
  resourceId: string;
  revision?: number;
  pathname: string;
}

export interface InvestigationActivitySecondaryContextV1 {
  label: string;
  value: string;
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
  secondaryContext?: InvestigationActivitySecondaryContextV1;
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

export interface InvestigationActivityCursorV1 {
  v: typeof INVESTIGATION_LOCATOR_VERSION;
  occurredAt: string;
  investigationId: string;
  seq: number;
  activityId: string;
  filterFingerprint: string;
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

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;



function assertNoInjection(path: string, value: string): void {
  if (hasControlChars(value)) {
    throw new ContractViolation(path, "control characters are not allowed");
  }
  if (
    value.includes("\\") ||
    value.includes("..") ||
    value.includes("%2e") ||
    value.includes("%2E") ||
    value.includes("%2f") ||
    value.includes("%2F") ||
    value.includes("://") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new ContractViolation(path, "path traversal or URL injection is not allowed");
  }
}

export function isInvestigationInstallationId(value: string): boolean {
  return INVESTIGATION_INSTALLATION_ID_RE.test(value);
}

export function isInvestigationUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function resourceIdPattern(kind: InvestigationResourceKindV1): RegExp {
  if (kind === "investigation_stage") {
    return /^(?:situation|capture|analyze|compare|decide)$/;
  }
  if (kind === "timeline_event") {
    return INVESTIGATION_TIMELINE_EVENT_ID_RE;
  }
  if (kind === "investigation") {
    return UUID_RE;
  }
  return INVESTIGATION_RESOURCE_ID_RE;
}

function assertResourceId(path: string, kind: InvestigationResourceKindV1, resourceId: string): void {
  assertNoInjection(path, resourceId);
  if (resourceId.includes("/")) {
    throw new ContractViolation(path, "resource identity must not contain a path separator");
  }
  if (!resourceIdPattern(kind).test(resourceId)) {
    throw new ContractViolation(path, `malformed resource identity for ${kind}`);
  }
  if (kind !== "investigation_stage" && kind !== "timeline_event" && UUID_RE.test(resourceId)) {
    return;
  }
  if (kind === "investigation_stage" || kind === "timeline_event" || kind === "investigation") {
    return;
  }
  if (!INVESTIGATION_RESOURCE_ID_RE.test(resourceId)) {
    throw new ContractViolation(path, "malformed resource identity");
  }
}

export function investigationStageForKind(
  kind: InvestigationResourceKindV1,
  resourceId: string,
): InvestigationStageV1 {
  if (kind === "investigation_stage") {
    return resourceId as InvestigationStageV1;
  }
  if (
    kind === "evidence_context" ||
    kind === "workstream" ||
    kind === "workstream_attempt" ||
    kind === "workstream_rerun" ||
    kind === "hypothesis" ||
    kind === "action"
  ) {
    return "analyze";
  }
  if (kind === "comparison_finding" || kind === "comparison_conflict") {
    return "compare";
  }
  if (kind === "decision_revision" || kind === "export_event") {
    return "decide";
  }
  if (kind === "evidence_item" || kind === "observation") {
    return "capture";
  }
  return "situation";
}

function routeItemKind(kind: InvestigationResourceKindV1): string | null {
  switch (kind) {
    case "evidence_item":
    case "evidence_context":
      return "evidence";
    case "workstream":
    case "workstream_rerun":
      return "triage-run";
    case "workstream_attempt":
      return "triage-candidate";
    case "discussion_message":
      return "comment";
    case "timeline_event":
      return "timeline";
    case "hypothesis":
    case "action":
    case "observation":
      return "contribution";
    default:
      return null;
  }
}

function routeSection(kind: InvestigationResourceKindV1): string | null {
  switch (kind) {
    case "investigation":
      return "situation";
    case "evidence_item":
    case "evidence_context":
      return "evidence";
    case "workstream":
    case "workstream_attempt":
    case "workstream_rerun":
      return "workstream";
    case "comparison_finding":
    case "comparison_conflict":
      return "comparison";
    case "discussion_message":
      return "discussion";
    case "timeline_event":
      return "timeline";
    case "hypothesis":
      return "hypothesis";
    case "action":
      return "action";
    case "observation":
      return "observation";
    case "decision_revision":
      return "decision";
    case "export_event":
      return "export";
    case "portable_archive_event":
      return "portable";
    default:
      return null;
  }
}

export function deriveInvestigationResourcePathname(
  investigationId: string,
  kind: InvestigationResourceKindV1,
  resourceId: string,
): string {
  if (!isInvestigationUuid(investigationId)) {
    throw new ContractViolation("$.investigationId", "expected an RFC 4122 UUID");
  }
  assertResourceId("$.resourceId", kind, resourceId);
  const stage = investigationStageForKind(kind, resourceId);
  const base = `/investigations/${investigationId}/${stage}`;
  if (kind === "investigation") {
    return `${base}?section=situation#situation`;
  }
  if (kind === "investigation_stage") {
    return base;
  }
  const section = routeSection(kind);
  if (!section) {
    return base;
  }
  const params = new URLSearchParams({ section, item: resourceId });
  const itemKind = routeItemKind(kind);
  if (itemKind) params.set("kind", itemKind);
  return `${base}?${params.toString()}#${encodeURIComponent(section)}`;
}

function assertDerivedPathname(locator: InvestigationResourceLocatorV1): void {
  const derived = deriveInvestigationResourcePathname(
    locator.investigationId,
    locator.kind,
    locator.resourceId,
  );
  if (locator.pathname !== derived) {
    throw new ContractViolation("$.pathname", "pathname must match the derived resource destination");
  }
  if (locator.pathname.includes("..") || locator.pathname.includes("//")) {
    throw new ContractViolation("$.pathname", "path traversal is not allowed");
  }
}

const locatorShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID)),
  version: f.req(f.u64),
  installationId: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  kind: f.req(f.en(...INVESTIGATION_RESOURCE_KINDS)),
  resourceId: f.req(f.nstr),
  revision: f.opt(f.u64),
  pathname: f.req(f.nstr),
};

const secondaryShape: ObjectShape = {
  label: f.req(f.nstr),
  value: f.req(f.nstr),
};

const activityItemShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID)),
  activityId: f.req(f.nstr),
  occurredAt: f.req(f.nstr),
  orderTieBreak: f.req(f.u64),
  actorId: f.req(f.nstr),
  actorLabel: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  investigationTitle: f.req(f.nstr),
  activityKind: f.req(f.en(...INVESTIGATION_ACTIVITY_KINDS)),
  summary: f.req(f.nstr),
  locator: f.req(f.obj(locatorShape)),
  resolvedRoute: f.req(f.nstr),
  provenanceClass: f.req(f.en(...INVESTIGATION_PROVENANCE_CLASSES)),
  privacyVisibility: f.req(f.en(...INVESTIGATION_PRIVACY_VISIBILITIES)),
  revision: f.nul(f.u64),
  sourceEventId: f.req(f.nstr),
  secondaryContext: f.opt(f.obj(secondaryShape)),
  humanFinding: f.req(f.bool),
};

const activityPageShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID)),
  items: f.req(f.arr(f.obj(activityItemShape))),
  nextCursor: f.nul(f.str),
  notices: f.req(f.arr(f.en(...INVESTIGATION_ACTIVITY_NOTICES))),
};

const resolveShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID)),
  locator: f.req(f.obj(locatorShape)),
  resourceKind: f.req(f.en(...INVESTIGATION_RESOURCE_KINDS)),
  resourceLabel: f.req(f.nstr),
  investigationTitle: f.req(f.nstr),
  revision: f.nul(f.u64),
  authorized: f.req(f.bool),
};

const errorShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID)),
  error: f.req(f.en(...INVESTIGATION_ACTIVITY_ERROR_CODES)),
};

function assertTimestamp(path: string, value: string): void {
  if (!RFC3339_TIMESTAMP.test(value)) {
    throw new ContractViolation(path, "expected an RFC3339 timestamp");
  }
}

function assertSafePresentation(path: string, value: string): void {
  if (hasControlChars(value)) {
    throw new ContractViolation(path, "control characters are not allowed in display text");
  }
  if (looksLikeOpaqueIdentifier(value)) {
    throw new ContractViolation(path, "opaque identifiers are not allowed as display labels");
  }
}

export function looksLikeOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (UUID_RE.test(trimmed)) return true;
  if (SHA256_HEX_RE.test(trimmed.toLowerCase())) return true;
  if (INVESTIGATION_INSTALLATION_ID_RE.test(trimmed)) return true;
  if (/^(?:pkg|package|fp|fingerprint|hash|sha256)[-_:]/i.test(trimmed)) return true;
  if (/^[0-9a-f]{32,}$/i.test(trimmed)) return true;
  if (OPAQUE_EVENT_NAME_RE.test(trimmed) && trimmed.includes("_")) return true;
  return false;
}

const RESOURCE_KIND_FALLBACK: Record<InvestigationResourceKindV1, string> = {
  investigation: "Investigation",
  investigation_stage: "Investigation stage",
  evidence_item: "Evidence item",
  evidence_context: "Evidence context",
  workstream: "Workstream",
  workstream_attempt: "Workstream attempt",
  workstream_rerun: "Workstream rerun",
  comparison_finding: "Comparison finding",
  comparison_conflict: "Comparison conflict",
  discussion_message: "Discussion message",
  timeline_event: "Timeline event",
  hypothesis: "Hypothesis",
  action: "Action",
  observation: "Observation",
  decision_revision: "Decision",
  export_event: "Export",
  portable_archive_event: "Portable archive event",
};

export function safeResourceLabel(
  kind: InvestigationResourceKindV1,
  recordedLabel?: string | null,
  suffix?: string | null,
): string {
  if (recordedLabel && recordedLabel.trim() && !looksLikeOpaqueIdentifier(recordedLabel)) {
    if (hasControlChars(recordedLabel)) {
      return RESOURCE_KIND_FALLBACK[kind];
    }
    return recordedLabel.trim();
  }
  const fallback = RESOURCE_KIND_FALLBACK[kind];
  if (suffix && /^\d{1,6}$/.test(suffix)) {
    return `${fallback} ${suffix}`;
  }
  return fallback;
}

export function safeActorLabel(username: string, historical = false): string {
  const trimmed = username.trim();
  if (historical || trimmed.startsWith("historical-") || trimmed.startsWith("imported-")) {
    return "Historical participant";
  }
  if (!trimmed || looksLikeOpaqueIdentifier(trimmed) || hasControlChars(trimmed)) {
    return "Participant";
  }
  if (trimmed === "system" || trimmed === "imported-analysis") {
    return trimmed === "system" ? "System" : "Imported analysis";
  }
  return trimmed;
}

export function safeInvestigationTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || looksLikeOpaqueIdentifier(trimmed) || hasControlChars(trimmed)) {
    return "Investigation";
  }
  return trimmed;
}

function revisionRequired(kind: InvestigationResourceKindV1): boolean {
  return kind === "decision_revision";
}

function assertLocatorFields(locator: InvestigationResourceLocatorV1): void {
  if (locator.version !== INVESTIGATION_LOCATOR_VERSION) {
    throw new ContractViolation("$.version", "unsupported locator version");
  }
  if (!isInvestigationInstallationId(locator.installationId)) {
    throw new ContractViolation("$.installationId", "malformed installation identity");
  }
  if (!isInvestigationUuid(locator.investigationId)) {
    throw new ContractViolation("$.investigationId", "expected an RFC 4122 UUID");
  }
  assertResourceId("$.resourceId", locator.kind, locator.resourceId);
  if (revisionRequired(locator.kind) && locator.revision === undefined) {
    throw new ContractViolation("$.revision", "revision is required for this resource kind");
  }
  if (locator.kind === "investigation" && locator.resourceId !== locator.investigationId) {
    throw new ContractViolation("$.resourceId", "investigation locator identity must match investigationId");
  }
  assertDerivedPathname(locator);
}

export function parseInvestigationResourceLocator(raw: unknown): InvestigationResourceLocatorV1 {
  checkObject("$", locatorShape, raw);
  const locator = raw as InvestigationResourceLocatorV1;
  assertLocatorFields(locator);
  return locator;
}

export function formatInvestigationResourceLocator(
  input: Omit<InvestigationResourceLocatorV1, "schemaId" | "version" | "pathname"> & {
    pathname?: string;
  },
): InvestigationResourceLocatorV1 {
  const pathname = deriveInvestigationResourcePathname(
    input.investigationId,
    input.kind,
    input.resourceId,
  );
  const locator: InvestigationResourceLocatorV1 = {
    schemaId: INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
    version: INVESTIGATION_LOCATOR_VERSION,
    installationId: input.installationId,
    investigationId: input.investigationId,
    kind: input.kind,
    resourceId: input.resourceId,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    pathname,
  };
  if (input.pathname !== undefined && input.pathname !== pathname) {
    throw new ContractViolation("$.pathname", "pathname must match the derived resource destination");
  }
  return parseInvestigationResourceLocator(locator);
}

export function formatCompactInvestigationLocator(locator: InvestigationResourceLocatorV1): string {
  const parsed = parseInvestigationResourceLocator(locator);
  const revision = parsed.revision === undefined ? "" : `;rev=${parsed.revision}`;
  return `${INVESTIGATION_LOCATOR_COMPACT_PREFIX}/${parsed.installationId}/${parsed.investigationId}/${parsed.kind}/${parsed.resourceId}${revision}`;
}

export function parseCompactInvestigationLocator(raw: string): InvestigationResourceLocatorV1 {
  if (typeof raw !== "string" || hasControlChars(raw)) {
    throw new ContractViolation("$", "malformed locator");
  }
  const trimmed = raw.trim();
  if (
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("%2e") ||
    trimmed.includes("%2E") ||
    trimmed.includes("%2f") ||
    trimmed.includes("%2F")
  ) {
    throw new ContractViolation("$", "path traversal or URL injection is not allowed");
  }
  const parts = trimmed.split("/");
  if (parts.length !== 5 || parts[0] !== INVESTIGATION_LOCATOR_COMPACT_PREFIX) {
    throw new ContractViolation("$", "malformed compact locator");
  }
  const installationId = parts[1] ?? "";
  const investigationId = parts[2] ?? "";
  const kindRaw = parts[3] ?? "";
  const resourcePart = parts[4] ?? "";
  if (!(INVESTIGATION_RESOURCE_KINDS as readonly string[]).includes(kindRaw)) {
    throw new ContractViolation("$.kind", "unknown resource kind");
  }
  const kind = kindRaw as InvestigationResourceKindV1;
  const revSplit = resourcePart.split(";rev=");
  if (revSplit.length > 2) {
    throw new ContractViolation("$.revision", "malformed revision");
  }
  const resourceId = revSplit[0] ?? "";
  let revision: number | undefined;
  if (revSplit.length === 2) {
    const parsedRev = Number(revSplit[1]);
    if (!Number.isSafeInteger(parsedRev) || parsedRev < 0 || String(parsedRev) !== revSplit[1]) {
      throw new ContractViolation("$.revision", "malformed revision");
    }
    revision = parsedRev;
  }
  return formatInvestigationResourceLocator({
    installationId,
    investigationId,
    kind,
    resourceId,
    ...(revision !== undefined ? { revision } : {}),
  });
}

export function parseInvestigationLocatorInput(raw: unknown): InvestigationResourceLocatorV1 {
  if (typeof raw === "string") {
    return parseCompactInvestigationLocator(raw);
  }
  return parseInvestigationResourceLocator(raw);
}

function assertActivityItem(item: InvestigationActivityItemV1): void {
  assertTimestamp("$.occurredAt", item.occurredAt);
  if (!SHA256_HEX_RE.test(item.activityId)) {
    throw new ContractViolation("$.activityId", "expected a lowercase SHA-256 hex digest");
  }
  if (!isInvestigationUuid(item.investigationId)) {
    throw new ContractViolation("$.investigationId", "expected an RFC 4122 UUID");
  }
  assertLocatorFields(item.locator);
  if (item.locator.investigationId !== item.investigationId) {
    throw new ContractViolation("$.locator.investigationId", "locator investigation must match the activity item");
  }
  if (item.resolvedRoute !== item.locator.pathname) {
    throw new ContractViolation("$.resolvedRoute", "resolved route must equal the locator pathname");
  }
  if (item.revision !== (item.locator.revision ?? null)) {
    throw new ContractViolation("$.revision", "revision must match the locator revision");
  }
  assertSafePresentation("$.actorLabel", item.actorLabel);
  assertSafePresentation("$.investigationTitle", item.investigationTitle);
  assertSafePresentation("$.summary", item.summary);
  if (item.secondaryContext) {
    assertSafePresentation("$.secondaryContext.label", item.secondaryContext.label);
    assertSafePresentation("$.secondaryContext.value", item.secondaryContext.value);
  }
  if (item.humanFinding && item.provenanceClass === "ai_generated") {
    throw new ContractViolation("$.humanFinding", "AI output must not be claimed as a human finding");
  }
  if (item.humanFinding && item.provenanceClass === "imported") {
    throw new ContractViolation("$.humanFinding", "imported output must not be claimed as a human finding");
  }
}

export function parseInvestigationActivityItem(raw: unknown): InvestigationActivityItemV1 {
  checkObject("$", activityItemShape, raw);
  const item = raw as InvestigationActivityItemV1;
  assertActivityItem(item);
  return item;
}

function assertExactNotices(notices: readonly string[]): void {
  if (notices.length !== INVESTIGATION_ACTIVITY_NOTICES.length || new Set(notices).size !== notices.length) {
    throw new ContractViolation("$.notices", "expected each required notice exactly once");
  }
  for (const notice of INVESTIGATION_ACTIVITY_NOTICES) {
    if (!notices.includes(notice)) {
      throw new ContractViolation("$.notices", `must include ${notice}`);
    }
  }
}

export function parseInvestigationActivityPage(raw: unknown): InvestigationActivityPageV1 {
  checkObject("$", activityPageShape, raw);
  const page = raw as InvestigationActivityPageV1;
  if (page.items.length > INVESTIGATION_ACTIVITY_PAGE_CAP) {
    throw new ContractViolation("$.items", `expected at most ${INVESTIGATION_ACTIVITY_PAGE_CAP} items`);
  }
  page.items.forEach((item, index) => {
    try {
      assertActivityItem(item);
    } catch (error) {
      if (error instanceof ContractViolation) {
        throw new ContractViolation(`$.items[${index}]${error.path.slice(1)}`, error.detail);
      }
      throw error;
    }
  });
  if (page.nextCursor !== null) {
    parseInvestigationActivityCursor(page.nextCursor);
  }
  assertExactNotices(page.notices);
  return page;
}

export function parseInvestigationResourceResolve(raw: unknown): InvestigationResourceResolveV1 {
  checkObject("$", resolveShape, raw);
  const resolved = raw as InvestigationResourceResolveV1;
  assertLocatorFields(resolved.locator);
  if (resolved.authorized !== true) {
    throw new ContractViolation("$.authorized", "resolve responses are fail-closed and only represent authorized resources");
  }
  if (resolved.resourceKind !== resolved.locator.kind) {
    throw new ContractViolation("$.resourceKind", "must match locator kind");
  }
  if (resolved.revision !== (resolved.locator.revision ?? null)) {
    throw new ContractViolation("$.revision", "must match locator revision");
  }
  assertSafePresentation("$.resourceLabel", resolved.resourceLabel);
  assertSafePresentation("$.investigationTitle", resolved.investigationTitle);
  return resolved;
}

export function parseInvestigationActivityError(raw: unknown): InvestigationActivityErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as InvestigationActivityErrorV1;
}

const cursorShape: ObjectShape = {
  v: f.req(f.u64),
  occurredAt: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  seq: f.req(f.u64),
  activityId: f.req(f.nstr),
  filterFingerprint: f.req(f.nstr),
};

export function investigationActivityFilterFingerprint(filter: InvestigationActivityFilterV1): string {
  const canonical: Record<string, unknown> = {};
  if (filter.investigationId !== undefined) canonical.investigationId = filter.investigationId;
  if (filter.actorId !== undefined) canonical.actorId = filter.actorId;
  if (filter.activityKind !== undefined) canonical.activityKind = filter.activityKind;
  if (filter.stage !== undefined) canonical.stage = filter.stage;
  if (filter.workstreamId !== undefined) canonical.workstreamId = filter.workstreamId;
  if (filter.from !== undefined) canonical.from = filter.from;
  if (filter.to !== undefined) canonical.to = filter.to;
  if (filter.assignedToMe !== undefined) canonical.assignedToMe = filter.assignedToMe;
  return sha256Text(canonicalJson(canonical));
}

export function formatInvestigationActivityCursor(cursor: InvestigationActivityCursorV1): string {
  if (cursor.v !== INVESTIGATION_LOCATOR_VERSION) {
    throw new ContractViolation("$.v", "unsupported cursor version");
  }
  assertTimestamp("$.occurredAt", cursor.occurredAt);
  if (!isInvestigationUuid(cursor.investigationId)) {
    throw new ContractViolation("$.investigationId", "expected an RFC 4122 UUID");
  }
  if (!SHA256_HEX_RE.test(cursor.activityId) || !SHA256_HEX_RE.test(cursor.filterFingerprint)) {
    throw new ContractViolation("$", "expected lowercase SHA-256 hex digests");
  }
  return Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");
}

export function parseInvestigationActivityCursor(raw: string): InvestigationActivityCursorV1 {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 4096 || hasControlChars(raw)) {
    throw new ContractViolation("$", "malformed cursor");
  }
  if (raw.includes("+") || raw.includes("/") || raw.includes("=") || raw.includes(" ")) {
    throw new ContractViolation("$", "malformed cursor");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new ContractViolation("$", "malformed cursor");
  }
  checkObject("$", cursorShape, decoded);
  const cursor = decoded as InvestigationActivityCursorV1;
  if (cursor.v !== INVESTIGATION_LOCATOR_VERSION) {
    throw new ContractViolation("$.v", "unsupported cursor version");
  }
  assertTimestamp("$.occurredAt", cursor.occurredAt);
  if (!isInvestigationUuid(cursor.investigationId)) {
    throw new ContractViolation("$.investigationId", "expected an RFC 4122 UUID");
  }
  if (!SHA256_HEX_RE.test(cursor.activityId) || !SHA256_HEX_RE.test(cursor.filterFingerprint)) {
    throw new ContractViolation("$", "expected lowercase SHA-256 hex digests");
  }
  const roundTrip = formatInvestigationActivityCursor(cursor);
  if (roundTrip !== raw) {
    throw new ContractViolation("$", "malformed cursor");
  }
  return cursor;
}

export function compareInvestigationActivityItems(
  left: Pick<InvestigationActivityItemV1, "occurredAt" | "investigationId" | "orderTieBreak" | "activityId">,
  right: Pick<InvestigationActivityItemV1, "occurredAt" | "investigationId" | "orderTieBreak" | "activityId">,
): number {
  const byTime = right.occurredAt.localeCompare(left.occurredAt);
  if (byTime !== 0) return byTime;
  const byCase = left.investigationId.localeCompare(right.investigationId);
  if (byCase !== 0) return byCase;
  if (right.orderTieBreak !== left.orderTieBreak) return right.orderTieBreak - left.orderTieBreak;
  return left.activityId.localeCompare(right.activityId);
}

export function activityItemIsAfterCursor(
  item: Pick<InvestigationActivityItemV1, "occurredAt" | "investigationId" | "orderTieBreak" | "activityId">,
  cursor: InvestigationActivityCursorV1,
): boolean {
  return compareInvestigationActivityItems(item, {
    occurredAt: cursor.occurredAt,
    investigationId: cursor.investigationId,
    orderTieBreak: cursor.seq,
    activityId: cursor.activityId,
  }) > 0;
}

export function investigationActivityId(input: {
  installationId: string;
  investigationId: string;
  seq: number;
  kind: string;
  targetId: string | null;
  revision: number | null;
}): string {
  return sha256Text(
    canonicalJson({
      installationId: input.installationId,
      investigationId: input.investigationId,
      kind: input.kind,
      revision: input.revision,
      seq: input.seq,
      targetId: input.targetId ?? "",
    }),
  );
}

export function investigationSourceEventId(investigationId: string, seq: number): string {
  return `${investigationId}:${seq}`;
}

export function canonicalInvestigationActivityBytes(value: unknown): string {
  return canonicalJson(value);
}
