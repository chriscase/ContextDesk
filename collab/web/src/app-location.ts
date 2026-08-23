export const AREA_IDS = ["overview", "investigations", "sources", "help"] as const;
export type AreaId = (typeof AREA_IDS)[number];

export const STAGE_IDS = [
  "situation",
  "capture",
  "analyze",
  "compare",
  "decide",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type WorkLocation = {
  area: AreaId;
  caseId: string | null;
  stage: StageId;
};

export type SignInLocation = { kind: "sign-in" };

export type UnknownLocation = { kind: "unknown"; attempted: string };

export type ShellLocation = WorkLocation | SignInLocation | UnknownLocation;

export const HOME: WorkLocation = {
  area: "overview",
  caseId: null,
  stage: "situation",
};

export const SIGN_IN: SignInLocation = { kind: "sign-in" };

/**
 * Fragment ids that pre-shell surfaces still emit as plain `#anchor` links
 * (the TriageWorkspace rail and the Experiment Lab review queue).
 */
export const LEGACY_ANCHOR_STAGES: Record<string, StageId> = {
  "triage-capture": "capture",
  "triage-analyze": "analyze",
  "triage-evidence-board": "analyze",
  "triage-lane-runner": "analyze",
  "triage-compare": "compare",
  "triage-comparison-lab": "compare",
  "triage-decide": "decide",
  "decision-heading": "decide",
  "export-heading": "decide",
};

const AREA_SET = new Set<string>(AREA_IDS);
const STAGE_SET = new Set<string>(STAGE_IDS);
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
  return a.area === b.area && a.caseId === b.caseId && a.stage === b.stage;
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

export function parsePathname(pathname: string): ShellLocation {
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
    return {
      area: "investigations",
      caseId,
      stage: stagePart && isStageId(stagePart) ? stagePart : "situation",
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
    return `/investigations/${location.caseId}/${location.stage}`;
  }
  return areaPathFor(location);
}

/**
 * In-app case focus keeps the current area pathname so existing reload-to-list
 * flows stay on overview/investigations. Canonical case URLs are written when
 * the address bar already names a case, or when restoring a parsed deep link
 * after sign-in.
 */
export function historyUrl(next: ShellLocation, currentPath: string): string {
  if (!isWorkLocation(next)) {
    return pathFor(next);
  }
  const current = parsePathname(currentPath);
  if (next.caseId) {
    if (isCaseId(next.caseId) && (isSignInLocation(current) || isUnknownLocation(current))) {
      return pathFor(next);
    }
    if (
      isCaseId(next.caseId) &&
      isWorkLocation(current) &&
      current.caseId !== null &&
      isCaseId(current.caseId)
    ) {
      return pathFor(next);
    }
    if (isWorkLocation(current)) {
      return areaPathFor({ ...current, caseId: null, stage: "situation" });
    }
  }
  return areaPathFor(next);
}

export function parseHashStage(hash: string): StageId | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return LEGACY_ANCHOR_STAGES[raw] ?? null;
}

export function titleFor(location: ShellLocation): string {
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
  if (location.area === "investigations" && location.caseId) {
    return "Investigation · ContextDesk War Room";
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
