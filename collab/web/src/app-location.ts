export const AREA_IDS = [
  "overview",
  "investigations",
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

export type WorkLocation = {
  area: AreaId;
  caseId: string | null;
  stage: StageId;
  focus?: WorkFocus;
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

export const SIGN_IN: SignInLocation = { kind: "sign-in" };

export function isProfileLocation(value: unknown): value is WorkLocation {
  return isWorkLocation(value) && value.area === "profile";
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
    (a.focus?.navigation ?? null) === (b.focus?.navigation ?? null);
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
  const section = boundedFocusValue(params.get("section")) ?? hashSection;
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
    return { area: "investigations", caseId: null, stage: "situation" };
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
  if (path === "/administration" || path === "/admin/people") {
    // /admin/people is a focused sub-view the Administration component
    // itself renders (a People tab); it shares the same area gate (an
    // admin role) as /administration and does not need its own AreaId.
    return { area: "administration", caseId: null, stage: "situation" };
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

export function titleFor(location: ShellLocation, investigationTitle?: string | null): string {
  if (isSignInLocation(location)) {
    return "Sign in · ContextDesk War Room";
  }
  if (isUnknownLocation(location)) {
    return "Page not found · ContextDesk War Room";
  }
  if (location.area === "sources") {
    return "Sources · ContextDesk War Room";
  }
  if (location.area === "help") {
    return "Help · ContextDesk War Room";
  }
  if (location.area === "profile") {
    return "My profile · ContextDesk War Room";
  }
  if (location.area === "administration") {
    return "Administration · ContextDesk War Room";
  }
  if (location.area === "investigations" && location.caseId) {
    const stage = location.stage.slice(0, 1).toUpperCase() + location.stage.slice(1);
    return `${investigationTitle || "Investigation"} · ${stage} · ContextDesk War Room`;
  }
  if (location.area === "investigations") {
    return "Investigations · ContextDesk War Room";
  }
  return "ContextDesk War Room";
}

export function restoreAfterSignIn(pending: ShellLocation | null): WorkLocation {
  if (pending && isWorkLocation(pending)) {
    return pending;
  }
  return { ...HOME };
}
