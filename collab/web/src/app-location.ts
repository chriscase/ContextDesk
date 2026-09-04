import {
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  INVESTIGATION_COLLECTION_STATUSES,
  parseInvestigationCollectionQuery,
  type InvestigationCollectionQueryV1,
} from "@cd-collab/contracts/investigation-collection";

export const AREA_IDS = [
  "overview",
  "investigations",
  // The reusable registry of what investigations are about. Deliberately its
  // own area rather than a tab inside Attribution: Attribution answers where
  // information came from, Entities answers who or what the work concerns, and
  // collapsing them would blur the boundary this area exists to make visible.
  "entities",
  "sources",
  "administration",
  "help",
  "profile",
] as const;
export type AreaId = (typeof AREA_IDS)[number];

export const STAGE_IDS = [
  "situation",
  "capture",
  "analyze",
  "compare",
  "decide",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const ROUTE_ITEM_KINDS = [
  "timeline",
  "contribution",
  "comment",
  "evidence",
  "snapshot",
  "imported-run",
  "triage-run",
  "triage-candidate",
  "intake-batch",
  "workstream",
  // One comparison lane. Review-queue entries are about a lane far more often
  // than about a section, and a link that lands on the section leaves the
  // reader to find the row themselves.
  "lane",
  "log-workbench-view",
  "log-workbench-bookmark",
  "log-line",
] as const;
export type RouteItemKind = (typeof ROUTE_ITEM_KINDS)[number];

export type WorkFocus = {
  section: string;
  item: string | null;
  itemKind?: RouteItemKind | null;
  lane: string | null;
  experiment: string | null;
  /** In-memory intent only; canonical URLs deliberately do not encode it. */
  navigation?: "preserve";
};

/**
 * The shareable portion of the collection query. Cursors, page sizes, and the
 * contract schema id stay runtime-owned; putting them in a URL would make a
 * copied link stale or couple navigation to transport details.
 */
export type CollectionQueryLocation = Readonly<{
  q: InvestigationCollectionQueryV1["q"];
  status: readonly InvestigationCollectionQueryV1["status"][number][];
  includeArchived: InvestigationCollectionQueryV1["includeArchived"];
  entityId: InvestigationCollectionQueryV1["entityId"];
  contributorId: InvestigationCollectionQueryV1["contributorId"];
  recordedFrom: InvestigationCollectionQueryV1["recordedFrom"];
  recordedTo: InvestigationCollectionQueryV1["recordedTo"];
}>;

export const DEFAULT_COLLECTION_QUERY: CollectionQueryLocation = Object.freeze({
  q: "",
  status: Object.freeze([]) as readonly InvestigationCollectionQueryV1["status"][number][],
  includeArchived: false,
  entityId: null,
  contributorId: null,
  recordedFrom: null,
  recordedTo: null,
});

export type WorkLocation = {
  area: AreaId;
  caseId: string | null;
  stage: StageId;
  focus?: WorkFocus;
  collectionQuery?: CollectionQueryLocation;
};

export type SignInLocation = { kind: "sign-in" };

export type UnknownLocation = { kind: "unknown"; attempted: string };

export type ShellLocation = WorkLocation | SignInLocation | UnknownLocation;

export const HOME: WorkLocation = {
  area: "overview",
  caseId: null,
  stage: "situation",
};

export const PROFILE: WorkLocation = {
  area: "profile",
  caseId: null,
  stage: "situation",
};

export const ADMINISTRATION: WorkLocation = {
  area: "administration",
  caseId: null,
  stage: "situation",
};

/** Canonical People tab. `/administration` remains the roles alias. */
export const PEOPLE_SECTION = "people";
export const PEOPLE: WorkLocation = {
  area: "administration",
  caseId: null,
  stage: "situation",
  focus: {
    section: PEOPLE_SECTION,
    item: null,
    itemKind: null,
    lane: null,
    experiment: null,
  },
};

/** Canonical Directory (LDAP) administration tab. */
export const LDAP_SECTION = "ldap";
export const LDAP_ADMIN: WorkLocation = {
  area: "administration",
  caseId: null,
  stage: "situation",
  focus: {
    section: LDAP_SECTION,
    item: null,
    itemKind: null,
    lane: null,
    experiment: null,
  },
};

/** Canonical administrator model-purpose policy tab. */
export const MODEL_POLICY_SECTION = "model-policy";
export const MODEL_POLICY: WorkLocation = {
  area: "administration",
  caseId: null,
  stage: "situation",
  focus: {
    section: MODEL_POLICY_SECTION,
    item: null,
    itemKind: null,
    lane: null,
    experiment: null,
  },
};

/** Canonical administrator UI-strategy rollout policy tab. */
export const UI_STRATEGY_POLICY_SECTION = "ui-strategies";
export const UI_STRATEGY_POLICY: WorkLocation = {
  area: "administration",
  caseId: null,
  stage: "situation",
  focus: {
    section: UI_STRATEGY_POLICY_SECTION,
    item: null,
    itemKind: null,
    lane: null,
    experiment: null,
  },
};

/** Canonical administrator evidence-storage diagnostics tab. */
export const EVIDENCE_STORAGE_SECTION = "evidence-storage";
export const EVIDENCE_STORAGE_ADMIN: WorkLocation = {
  area: "administration",
  caseId: null,
  stage: "situation",
  focus: {
    section: EVIDENCE_STORAGE_SECTION,
    item: null,
    itemKind: null,
    lane: null,
    experiment: null,
  },
};

export const SIGN_IN: SignInLocation = { kind: "sign-in" };

export const DISCUSSION_SECTION = "discussion";
export const DISCUSSION_SECTION_LEGACY = "case-discussion";
export const DISCUSSION_ELEMENT_ID = "case-discussion";

export function isDiscussionSection(section: string): boolean {
  return section === DISCUSSION_SECTION || section === DISCUSSION_SECTION_LEGACY;
}

export function canonicalRouteSection(section: string): string {
  return section === DISCUSSION_SECTION_LEGACY ? DISCUSSION_SECTION : section;
}

export function isProfileLocation(value: unknown): value is WorkLocation {
  return isWorkLocation(value) && value.area === "profile";
}

export function isPeopleLocation(value: unknown): value is WorkLocation {
  return (
    isWorkLocation(value)
    && value.area === "administration"
    && value.focus?.section === PEOPLE_SECTION
  );
}

export function isLdapAdminLocation(value: unknown): value is WorkLocation {
  return (
    isWorkLocation(value)
    && value.area === "administration"
    && value.focus?.section === LDAP_SECTION
  );
}

export function isModelPolicyLocation(value: unknown): value is WorkLocation {
  return (
    isWorkLocation(value)
    && value.area === "administration"
    && value.focus?.section === MODEL_POLICY_SECTION
  );
}

export function isUiStrategyPolicyLocation(value: unknown): value is WorkLocation {
  return (
    isWorkLocation(value)
    && value.area === "administration"
    && value.focus?.section === UI_STRATEGY_POLICY_SECTION
  );
}

export function isEvidenceStorageAdminLocation(value: unknown): value is WorkLocation {
  return (
    isWorkLocation(value)
    && value.area === "administration"
    && value.focus?.section === EVIDENCE_STORAGE_SECTION
  );
}

/**
 * Fragment ids that pre-shell surfaces still emit as plain `#anchor` links
 * (the TriageWorkspace rail and the Experiment Lab review queue).
 */
export const LEGACY_ANCHOR_STAGES: Record<string, StageId> = {
  "triage-capture": "capture",
  "corpus-intake": "capture",
  "triage-analyze": "analyze",
  "triage-evidence-board": "analyze",
  "triage-lane-runner": "analyze",
  workstreams: "analyze",
  "triage-compare": "compare",
  "triage-comparison-lab": "compare",
  "triage-decide": "decide",
  "decision-heading": "decide",
  "export-heading": "decide",
};

const AREA_SET = new Set<string>(AREA_IDS);
const STAGE_SET = new Set<string>(STAGE_IDS);
const ROUTE_ITEM_KIND_SET = new Set<string>(ROUTE_ITEM_KINDS);
const CASE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAreaId(value: string): value is AreaId {
  return AREA_SET.has(value);
}

function isStageId(value: string): value is StageId {
  return STAGE_SET.has(value);
}

export function isCaseId(value: string): boolean {
  return CASE_ID_RE.test(value);
}

export function isWorkLocation(value: unknown): value is WorkLocation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind === "string") {
    return false;
  }
  if (!isAreaId(String(candidate.area ?? ""))) {
    return false;
  }
  if (candidate.caseId !== null && typeof candidate.caseId !== "string") {
    return false;
  }
  if (candidate.focus !== undefined) {
    if (!candidate.focus || typeof candidate.focus !== "object") return false;
    const focus = candidate.focus as Record<string, unknown>;
    if (
      typeof focus.section !== "string" ||
      (focus.item !== null && typeof focus.item !== "string") ||
      (focus.itemKind !== undefined && focus.itemKind !== null &&
        !ROUTE_ITEM_KIND_SET.has(String(focus.itemKind))) ||
      (focus.lane !== null && typeof focus.lane !== "string") ||
      (focus.experiment !== null && typeof focus.experiment !== "string") ||
      (focus.navigation !== undefined && focus.navigation !== "preserve")
    ) {
      return false;
    }
  }
  if (candidate.collectionQuery !== undefined) {
    if (candidate.area !== "investigations" || candidate.caseId !== null) return false;
    const query = candidate.collectionQuery;
    if (!query || typeof query !== "object" || Array.isArray(query)) return false;
    try {
      const record = query as Record<string, unknown>;
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        q: record.q,
        status: record.status,
        includeArchived: record.includeArchived,
        entityId: record.entityId,
        contributorId: record.contributorId,
        recordedFrom: record.recordedFrom,
        recordedTo: record.recordedTo,
      });
    } catch {
      return false;
    }
  }
  return isStageId(String(candidate.stage ?? ""));
}

export function isSignInLocation(value: unknown): value is SignInLocation {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "sign-in",
  );
}

export function isUnknownLocation(value: unknown): value is UnknownLocation {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "unknown" &&
      typeof (value as { attempted?: unknown }).attempted === "string",
  );
}

export function isShellLocation(value: unknown): value is ShellLocation {
  return (
    isWorkLocation(value) || isSignInLocation(value) || isUnknownLocation(value)
  );
}

export function sameLocation(a: ShellLocation, b: ShellLocation): boolean {
  if (isSignInLocation(a) || isSignInLocation(b)) {
    return isSignInLocation(a) && isSignInLocation(b);
  }
  if (isUnknownLocation(a) || isUnknownLocation(b)) {
    return (
      isUnknownLocation(a) &&
      isUnknownLocation(b) &&
      a.attempted === b.attempted
    );
  }
  return a.area === b.area && a.caseId === b.caseId && a.stage === b.stage &&
    (a.focus?.section ?? null) === (b.focus?.section ?? null) &&
    (a.focus?.item ?? null) === (b.focus?.item ?? null) &&
    (a.focus?.itemKind ?? null) === (b.focus?.itemKind ?? null) &&
    (a.focus?.lane ?? null) === (b.focus?.lane ?? null) &&
    (a.focus?.experiment ?? null) === (b.focus?.experiment ?? null) &&
    (a.focus?.navigation ?? null) === (b.focus?.navigation ?? null) &&
    queryLocationEqual(a.collectionQuery, b.collectionQuery);
}

export function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  let decoded = trimmed;
  try {
    decoded = decodeURI(trimmed);
  } catch {
    return "/not-found";
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("://") ||
    decoded.includes("\0")
  ) {
    return "/not-found";
  }
  const collapsed = decoded.replace(/\/{2,}/g, "/");
  if (collapsed !== decoded) {
    return "/not-found";
  }
  const withSlash = collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
  if (withSlash.includes("..") || withSlash.includes("%2e") || withSlash.includes("%2E")) {
    return "/not-found";
  }
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function unknownAt(pathname: string): UnknownLocation {
  return { kind: "unknown", attempted: normalizePathname(pathname) };
}

function boundedFocusValue(value: string | null): string | null {
  if (!value || value.length > 256) return null;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return null;
  return value;
}

function parseFocus(search: string, hash: string): WorkFocus | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const hashSection = boundedFocusValue(hash.replace(/^#/, ""));
  const section = canonicalRouteSection(
    boundedFocusValue(params.get("section")) ?? hashSection ?? "",
  );
  if (!section) return undefined;
  return {
    section,
    item: boundedFocusValue(params.get("item")),
    itemKind: ROUTE_ITEM_KIND_SET.has(params.get("kind") ?? "")
      ? params.get("kind") as RouteItemKind
      : null,
    lane: boundedFocusValue(params.get("lane")),
    experiment: boundedFocusValue(params.get("experiment")),
  };
}

const COLLECTION_QUERY_PARAMS = new Set([
  "q",
  "status",
  "includeArchived",
  "entityId",
  "contributorId",
  "recordedFrom",
  "recordedTo",
]);

function orderedStatuses(status: readonly InvestigationCollectionQueryV1["status"][number][]) {
  return [...status].sort(
    (left, right) => INVESTIGATION_COLLECTION_STATUSES.indexOf(left)
      - INVESTIGATION_COLLECTION_STATUSES.indexOf(right),
  );
}

function locationQueryFromContract(query: InvestigationCollectionQueryV1): CollectionQueryLocation {
  return Object.freeze({
    q: query.q,
    status: Object.freeze(orderedStatuses(query.status)),
    includeArchived: query.includeArchived,
    entityId: query.entityId,
    contributorId: query.contributorId,
    recordedFrom: query.recordedFrom,
    recordedTo: query.recordedTo,
  });
}

function parseCollectionQuery(search: string): CollectionQueryLocation | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (![...params.keys()].some((key) => COLLECTION_QUERY_PARAMS.has(key))) return undefined;
  const raw: Record<string, unknown> = { schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID };
  if (params.has("q")) raw.q = params.get("q") ?? "";
  if (params.has("status")) raw.status = params.getAll("status");
  if (params.has("includeArchived")) {
    const value = params.get("includeArchived");
    raw.includeArchived = value === "true" ? true : value === "false" ? false : value;
  }
  for (const key of ["entityId", "contributorId", "recordedFrom", "recordedTo"] as const) {
    if (params.has(key)) raw[key] = params.get(key);
  }
  try {
    return locationQueryFromContract(parseInvestigationCollectionQuery(raw));
  } catch {
    // Invalid or over-broad query strings are deliberately not reflected in
    // shell state. The next canonicalization pass strips them from the URL.
    return undefined;
  }
}

function queryLocationEqual(
  left: CollectionQueryLocation | undefined,
  right: CollectionQueryLocation | undefined,
): boolean {
  const a = left ?? DEFAULT_COLLECTION_QUERY;
  const b = right ?? DEFAULT_COLLECTION_QUERY;
  // Keep the live shell value exact while someone types. Treating a trailing
  // space as equal makes a controlled search input snap back and joins the
  // next word to the previous one. URL serialization remains canonical below.
  return a.q === b.q
    && a.includeArchived === b.includeArchived
    && a.entityId === b.entityId
    && a.contributorId === b.contributorId
    && a.recordedFrom === b.recordedFrom
    && a.recordedTo === b.recordedTo
    && orderedStatuses(a.status).join("\u0000") === orderedStatuses(b.status).join("\u0000");
}

function collectionQueryPath(query: CollectionQueryLocation | undefined): string {
  if (queryLocationEqual(query, undefined)) return "";
  const value = query ?? DEFAULT_COLLECTION_QUERY;
  const params = new URLSearchParams();
  if (value.q.trim()) params.set("q", value.q.trim());
  for (const status of orderedStatuses(value.status)) params.append("status", status);
  if (value.includeArchived) params.set("includeArchived", "true");
  if (value.entityId !== null) params.set("entityId", value.entityId);
  if (value.contributorId !== null) params.set("contributorId", value.contributorId);
  if (value.recordedFrom !== null) params.set("recordedFrom", value.recordedFrom);
  if (value.recordedTo !== null) params.set("recordedTo", value.recordedTo);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function parsePathname(pathname: string, search = "", hash = ""): ShellLocation {
  const path = normalizePathname(pathname);
  if (path === "/not-found") {
    return unknownAt(pathname);
  }
  if (path === "/" || path === "") {
    return { ...HOME };
  }
  if (path === "/signin" || path === "/sign-in" || path === "/login") {
    return SIGN_IN;
  }
  if (path === "/investigations") {
    const collectionQuery = parseCollectionQuery(search);
    return {
      area: "investigations",
      caseId: null,
      stage: "situation",
      ...(collectionQuery ? { collectionQuery } : {}),
    };
  }
  if (path === "/entities") {
    return { area: "entities", caseId: null, stage: "situation" };
  }
  if (path === "/sources") {
    return { area: "sources", caseId: null, stage: "situation" };
  }
  if (path === "/help") {
    return { area: "help", caseId: null, stage: "situation" };
  }
  if (path === "/profile") {
    return { ...PROFILE };
  }
  if (path === "/admin/people") {
    return { ...PEOPLE };
  }
  if (path === "/admin/ldap") {
    return { ...LDAP_ADMIN };
  }
  if (path === "/admin/model-policy") {
    return { ...MODEL_POLICY };
  }
  if (path === "/admin/ui-strategies") {
    return { ...UI_STRATEGY_POLICY };
  }
  if (path === "/admin/storage") {
    return { ...EVIDENCE_STORAGE_ADMIN };
  }
  if (path === "/administration") {
    return { ...ADMINISTRATION };
  }
  const investigation = /^\/investigations\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (investigation) {
    const caseId = investigation[1] ?? "";
    const stagePart = investigation[2];
    if (!isCaseId(caseId)) {
      return unknownAt(path);
    }
    if (stagePart && !isStageId(stagePart)) {
      return unknownAt(path);
    }
    const focus = parseFocus(search, hash);
    return {
      area: "investigations",
      caseId,
      stage: stagePart && isStageId(stagePart) ? stagePart : "situation",
      ...(focus ? { focus } : {}),
    };
  }
  return unknownAt(path);
}

export function areaPathFor(location: WorkLocation): string {
  if (location.area === "overview") {
    return "/";
  }
  if (location.area === "entities") {
    return "/entities";
  }
  if (location.area === "sources") {
    return "/sources";
  }
  if (location.area === "help") {
    return "/help";
  }
  if (location.area === "profile") {
    return "/profile";
  }
  if (location.area === "administration") {
    if (isPeopleLocation(location)) return "/admin/people";
    if (isLdapAdminLocation(location)) return "/admin/ldap";
    if (isModelPolicyLocation(location)) return "/admin/model-policy";
    if (isUiStrategyPolicyLocation(location)) return "/admin/ui-strategies";
    if (isEvidenceStorageAdminLocation(location)) return "/admin/storage";
    return "/administration";
  }
  return "/investigations";
}

export function pathFor(location: ShellLocation): string {
  if (isSignInLocation(location)) {
    return "/signin";
  }
  if (isUnknownLocation(location)) {
    return "/not-found";
  }
  if (location.caseId && isCaseId(location.caseId) && location.area === "investigations") {
    const base = `/investigations/${location.caseId}/${location.stage}`;
    if (!location.focus) return base;
    const params = new URLSearchParams({ section: location.focus.section });
    if (location.focus.item) params.set("item", location.focus.item);
    if (location.focus.itemKind) params.set("kind", location.focus.itemKind);
    if (location.focus.lane) params.set("lane", location.focus.lane);
    if (location.focus.experiment) params.set("experiment", location.focus.experiment);
    return `${base}?${params.toString()}#${encodeURIComponent(location.focus.section)}`;
  }
  if (location.area === "investigations" && location.caseId === null) {
    return `/investigations${collectionQueryPath(location.collectionQuery)}`;
  }
  return areaPathFor(location);
}

/**
 * Investigation focus is always canonical in the address bar. Reload, Back,
 * Forward, and copied links must restore the exact investigation and stage;
 * focused sections/items/lanes are encoded by pathFor above.
 */
export function historyUrl(next: ShellLocation, _currentPath: string): string {
  return pathFor(next);
}

export function parseHashStage(hash: string): StageId | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return LEGACY_ANCHOR_STAGES[raw] ?? null;
}

export function titleFor(
  location: ShellLocation,
  investigationTitle?: string | null,
  options: {
    surfaceName?: string;
    includeInvestigationStage?: boolean;
  } = {},
): string {
  const shellTitle = `ContextDesk ${options.surfaceName ?? "War Room"}`;
  if (isSignInLocation(location)) {
    return `Sign in · ${shellTitle}`;
  }
  if (isUnknownLocation(location)) {
    return `Page not found · ${shellTitle}`;
  }
  if (location.area === "entities") {
    return `Entities · ${shellTitle}`;
  }
  if (location.area === "sources") {
    return `Attribution · ${shellTitle}`;
  }
  if (location.area === "help") {
    return `Help · ${shellTitle}`;
  }
  if (location.area === "profile") {
    return `My profile · ${shellTitle}`;
  }
  if (location.area === "administration") {
    return isPeopleLocation(location)
      ? `People · Administration · ${shellTitle}`
        : isLdapAdminLocation(location)
          ? `Directory · Administration · ${shellTitle}`
          : isModelPolicyLocation(location)
            ? `Model use · Administration · ${shellTitle}`
            : isUiStrategyPolicyLocation(location)
              ? `Investigation experiences · Administration · ${shellTitle}`
              : isEvidenceStorageAdminLocation(location)
                ? `Evidence storage · Administration · ${shellTitle}`
                : `Administration · ${shellTitle}`;
  }
  if (location.area === "investigations" && location.caseId) {
    if (options.includeInvestigationStage === false) {
      return `${investigationTitle || "Investigation"} · ${shellTitle}`;
    }
    const stage = location.stage.slice(0, 1).toUpperCase() + location.stage.slice(1);
    return `${investigationTitle || "Investigation"} · ${stage} · ${shellTitle}`;
  }
  if (location.area === "investigations") {
    return `Investigations · ${shellTitle}`;
  }
  if (location.area === "overview") {
    return `Overview · ${shellTitle}`;
  }
  return shellTitle;
}

export function restoreAfterSignIn(pending: ShellLocation | null): WorkLocation {
  if (pending && isWorkLocation(pending)) {
    return pending;
  }
  return { ...HOME };
}
