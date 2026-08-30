/**
 * Archiving and restoring an investigation.
 *
 * Archiving is how an investigation leaves the working list without leaving
 * the record. It is deliberately *not* deletion, and this module exists to
 * keep those two things from quietly converging:
 *
 * - **Nothing here deletes.** There is no delete verb, no purge, no hard
 *   removal path, and adding one is a separate decision with its own review.
 *   An archived investigation keeps every contribution, artifact, timeline
 *   row, and audit entry it had. `describeDeleteRequest` exists only so a
 *   caller asking to delete gets a straight answer about what the workspace
 *   actually offers instead of an unexplained failure.
 * - **Archiving is reversible, and restore is not a guess.** Before this
 *   module, `archived` was one option in the same dropdown as every other
 *   status, so restoring meant a person choosing from memory what the
 *   investigation had been. `restoreTarget` reads the recorded status history
 *   instead, so an investigation that was `monitoring` comes back to
 *   `monitoring` rather than being flattened to `open`.
 *
 * ## Why legal hold refuses an archive
 *
 * `legalHold` already refuses content deletion (`assertCanTombstone`). It was
 * not consulted when an investigation was archived, which left the two
 * controls disagreeing: the workspace would refuse to tombstone a single
 * contribution while allowing the whole investigation to be moved out of the
 * working list in one unconfirmed click. Archiving under hold is therefore
 * refused here, fail-closed, and the refusal names the hold so the operator
 * knows which control to clear rather than guessing at a generic error.
 *
 * Restore is never refused. A hold is a reason to keep a record reachable, so
 * a held investigation that is somehow already archived can always be brought
 * back; refusing that direction would trap the record, which is the opposite
 * of what a hold is for.
 *
 * ## Scope
 *
 * Pure decisions over values a caller already has. No I/O, no clock, no
 * authorization — the caller still checks permissions, and the server still
 * writes the timeline and audit rows. This module only answers "is this
 * transition allowed, and where does restore land".
 */
import {
  CASE_STATUSES,
  parseCase,
  type CaseStatus,
  type CaseV1,
} from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

/**
 * The status an investigation holds while archived. Named rather than spelled
 * inline so a reader can find every place archiving is reasoned about.
 */
export const ARCHIVED_STATUS = "archived" as const satisfies CaseStatus;

/**
 * Where a restore lands when history cannot say where it came from.
 *
 * `open` and not `resolved`: an investigation whose earlier status was lost
 * must come back as work to look at, never as a conclusion nobody recorded.
 */
export const DEFAULT_RESTORE_STATUS = "open" as const satisfies CaseStatus;

/** The two directions this module reasons about. */
export const LIFECYCLE_ACTIONS = ["archive", "restore"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/**
 * Why a transition was refused. Machine-readable so the surface can open the
 * control that would clear it instead of printing a dead end.
 */
export const LIFECYCLE_REFUSALS = [
  "legal_hold",
  "already_archived",
  "not_archived",
  "unknown_status",
] as const;
export type LifecycleRefusal = (typeof LIFECYCLE_REFUSALS)[number];

export interface LifecycleAllowed {
  allowed: true;
  action: LifecycleAction;
  /** The status the caller should write. */
  targetStatus: CaseStatus;
}

export interface LifecycleRefused {
  allowed: false;
  action: LifecycleAction;
  reason: LifecycleRefusal;
  /** One sentence an operator can act on. Never an identifier. */
  detail: string;
}

export type LifecycleVerdict = LifecycleAllowed | LifecycleRefused;

/** The subset of an investigation this decision reads. */
export interface LifecycleSubject {
  status: string;
  legalHold: boolean;
}

/**
 * A recorded status change, oldest or newest first — `restoreTarget` does not
 * care about the order it is handed, only that each row carries the status
 * that was written and when it was recorded.
 */
export interface StatusHistoryEntry {
  status: string;
  /** Server recording clock. Compared as an instant, never displayed here. */
  recordedAt: string;
}

function isCaseStatus(value: string): value is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(value);
}

/**
 * Where a restore should land.
 *
 * Reads the most recent recorded status that was not `archived`. An
 * investigation archived out of `monitoring` returns to `monitoring`; one
 * whose history is empty, unreadable, or entirely archived returns to
 * `DEFAULT_RESTORE_STATUS`.
 *
 * Rows carrying an unparsable or unknown status are skipped rather than
 * trusted: a status this build does not recognise cannot be written back, and
 * guessing at it would be worse than landing on `open`.
 */
export function restoreTarget(history: readonly StatusHistoryEntry[]): CaseStatus {
  let best: { status: CaseStatus; at: number } | null = null;
  for (const entry of history) {
    if (entry.status === ARCHIVED_STATUS) continue;
    if (!isCaseStatus(entry.status)) continue;
    const at = Date.parse(entry.recordedAt);
    if (!Number.isFinite(at)) continue;
    if (best === null || at > best.at) best = { status: entry.status, at };
  }
  return best?.status ?? DEFAULT_RESTORE_STATUS;
}

/**
 * Whether this investigation may be archived, and nothing else.
 *
 * Deliberately does not consult the resolution guard: archiving makes no claim
 * that the question was answered, and requiring a conclusion before a record
 * can be filed away would push people to invent one. That boundary is stated
 * in `investigation-resolution.ts` and is preserved here.
 */
export function evaluateArchive(subject: LifecycleSubject): LifecycleVerdict {
  if (subject.legalHold) {
    return {
      allowed: false,
      action: "archive",
      reason: "legal_hold",
      detail:
        "This investigation is under legal hold, so it stays in the working list. Clear the hold first if it should be archived.",
    };
  }
  if (subject.status === ARCHIVED_STATUS) {
    return {
      allowed: false,
      action: "archive",
      reason: "already_archived",
      detail: "This investigation is already archived.",
    };
  }
  return { allowed: true, action: "archive", targetStatus: ARCHIVED_STATUS };
}

/**
 * Whether this investigation may be restored, and to which status.
 *
 * Never refused for legal hold: a hold is a reason to keep a record reachable.
 */
export function evaluateRestore(
  subject: LifecycleSubject,
  history: readonly StatusHistoryEntry[] = [],
): LifecycleVerdict {
  if (subject.status !== ARCHIVED_STATUS) {
    return {
      allowed: false,
      action: "restore",
      reason: "not_archived",
      detail: "This investigation is not archived, so there is nothing to restore.",
    };
  }
  return { allowed: true, action: "restore", targetStatus: restoreTarget(history) };
}

/**
 * What the workspace offers when someone asks to delete an investigation.
 *
 * Returned rather than thrown: a person asking to delete is asking a
 * reasonable question, and the answer is a description of the two things that
 * do exist — archiving, which keeps the record, and a share-safe export, which
 * produces something disclosable without removing anything.
 */
export interface DeleteRequestAnswer {
  /** Always false. Stated as a value so a caller cannot read past it. */
  supported: false;
  detail: string;
  /** The actions that do exist, in the order worth offering them. */
  alternatives: readonly LifecycleAction[];
}

export function describeDeleteRequest(): DeleteRequestAnswer {
  return {
    supported: false,
    detail:
      "Investigations are archived, never deleted: the record, its evidence, and its audit trail stay intact. Archive it to take it out of the working list, or export a share-safe copy if something needs to leave the workspace.",
    alternatives: ["archive"],
  };
}

export const INVESTIGATION_LIFECYCLE_SCHEMA_ID =
  "cd-collab.investigation_lifecycle.v1" as const;

/**
 * What the two lifecycle controls would do right now, answered together.
 *
 * Served so a surface can label its controls from recorded state instead of
 * describing an outcome it has not checked — the refusal an operator needs to
 * see is the one that arrives before the click, not after it.
 */
export interface InvestigationLifecycleV1 {
  schemaId: typeof INVESTIGATION_LIFECYCLE_SCHEMA_ID;
  investigationId: string;
  status: CaseStatus;
  legalHold: boolean;
  archive: LifecycleVerdict;
  restore: LifecycleVerdict;
  /** Where a restore would land, whether or not one is currently allowed. */
  restoreTarget: CaseStatus;
  deletion: DeleteRequestAnswer;
}

const lifecycleAllowedShape: ObjectShape = {
  allowed: f.req(f.bool),
  action: f.req(f.en(...LIFECYCLE_ACTIONS)),
  targetStatus: f.req(f.en(...CASE_STATUSES)),
};

const lifecycleRefusedShape: ObjectShape = {
  allowed: f.req(f.bool),
  action: f.req(f.en(...LIFECYCLE_ACTIONS)),
  reason: f.req(f.en(...LIFECYCLE_REFUSALS)),
  detail: f.req(f.nstr),
};

const lifecycleVerdictDiscriminatorShape: ObjectShape = {
  allowed: f.req(f.bool),
  action: f.opt(f.en(...LIFECYCLE_ACTIONS)),
  targetStatus: f.opt(f.en(...CASE_STATUSES)),
  reason: f.opt(f.en(...LIFECYCLE_REFUSALS)),
  detail: f.opt(f.nstr),
};

const deleteRequestAnswerShape: ObjectShape = {
  supported: f.req(f.bool),
  detail: f.req(f.nstr),
  alternatives: f.req(f.arr(f.en(...LIFECYCLE_ACTIONS))),
};

const investigationLifecycleEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_LIFECYCLE_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  status: f.req(f.en(...CASE_STATUSES)),
  legalHold: f.req(f.bool),
  // Nested values are replaced with an opaque marker before this shallow
  // envelope check. Their authoritative parsers validate the real values.
  archive: f.req(f.str),
  restore: f.req(f.str),
  restoreTarget: f.req(f.en(...CASE_STATUSES)),
  deletion: f.req(f.str),
};

function recordAt(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

/**
 * Validate an envelope without duplicating the nested contract's shape.
 * Replacing only present nested fields preserves required-field checks while
 * letting the nested authoritative parser own every key below that field.
 */
function checkEnvelope(
  raw: unknown,
  path: string,
  shape: ObjectShape,
  nestedFields: readonly string[],
): Record<string, unknown> {
  const record = recordAt(raw, path);
  const shallow: Record<string, unknown> = { ...record };
  for (const field of nestedFields) {
    if (Object.prototype.hasOwnProperty.call(shallow, field)) shallow[field] = "nested";
  }
  checkObject(path, shape, shallow);
  return record;
}

function lifecycleActionValue(value: unknown, path: string): LifecycleAction {
  if (value === "archive" || value === "restore") return value;
  throw new ContractViolation(path, "expected archive or restore");
}

function caseStatusValue(value: unknown, path: string): CaseStatus {
  if (
    value === "open" ||
    value === "monitoring" ||
    value === "resolved" ||
    value === ARCHIVED_STATUS
  ) {
    return value;
  }
  throw new ContractViolation(path, `expected one of [${CASE_STATUSES.join(", ")}]`);
}

function lifecycleRefusalValue(value: unknown, path: string): LifecycleRefusal {
  if (
    value === "legal_hold" ||
    value === "already_archived" ||
    value === "not_archived" ||
    value === "unknown_status"
  ) {
    return value;
  }
  throw new ContractViolation(
    path,
    `expected one of [${LIFECYCLE_REFUSALS.join(", ")}]`,
  );
}

function nonEmptyStringValue(value: unknown, path: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ContractViolation(path, "expected non-empty string");
}

function parseLifecycleVerdict(raw: unknown, path: string): LifecycleVerdict {
  const record = recordAt(raw, path);
  if (record.allowed === true) {
    checkObject(path, lifecycleAllowedShape, raw);
    return {
      allowed: true,
      action: lifecycleActionValue(record.action, `${path}.action`),
      targetStatus: caseStatusValue(record.targetStatus, `${path}.targetStatus`),
    };
  }
  if (record.allowed === false) {
    checkObject(path, lifecycleRefusedShape, raw);
    return {
      allowed: false,
      action: lifecycleActionValue(record.action, `${path}.action`),
      reason: lifecycleRefusalValue(record.reason, `${path}.reason`),
      detail: nonEmptyStringValue(record.detail, `${path}.detail`),
    };
  }
  checkObject(path, lifecycleVerdictDiscriminatorShape, raw);
  throw new ContractViolation(`${path}.allowed`, "expected boolean");
}

function parseDeleteRequestAnswer(raw: unknown, path: string): DeleteRequestAnswer {
  checkObject(path, deleteRequestAnswerShape, raw);
  const record = recordAt(raw, path);
  if (record.supported !== false) {
    throw new ContractViolation(`${path}.supported`, "investigation deletion is not supported");
  }
  if (!Array.isArray(record.alternatives)) {
    throw new ContractViolation(`${path}.alternatives`, "expected array");
  }
  const alternatives = record.alternatives.map((value, index) =>
    lifecycleActionValue(value, `${path}.alternatives[${index}]`),
  );
  if (alternatives.length !== 1 || alternatives[0] !== "archive") {
    throw new ContractViolation(
      `${path}.alternatives`,
      "archive is the only supported alternative to deletion",
    );
  }
  return {
    supported: false,
    detail: nonEmptyStringValue(record.detail, `${path}.detail`),
    alternatives,
  };
}

function assertLifecycleSemantics(parsed: InvestigationLifecycleV1, path: string): void {
  if (parsed.restoreTarget === ARCHIVED_STATUS) {
    throw new ContractViolation(
      `${path}.restoreTarget`,
      "a restore target must be a working investigation status",
    );
  }

  if (parsed.archive.action !== "archive") {
    throw new ContractViolation(`${path}.archive.action`, "archive verdict must name archive");
  }
  const expectedArchive = evaluateArchive(parsed);
  if (parsed.archive.allowed !== expectedArchive.allowed) {
    throw new ContractViolation(
      `${path}.archive.allowed`,
      "archive verdict does not match status and legal hold",
    );
  }
  if (parsed.archive.allowed) {
    if (parsed.archive.targetStatus !== ARCHIVED_STATUS) {
      throw new ContractViolation(
        `${path}.archive.targetStatus`,
        "an allowed archive must target archived",
      );
    }
  } else if (
    expectedArchive.allowed ||
    parsed.archive.reason !== expectedArchive.reason
  ) {
    throw new ContractViolation(
      `${path}.archive.reason`,
      "archive refusal does not match status and legal hold",
    );
  }

  if (parsed.restore.action !== "restore") {
    throw new ContractViolation(`${path}.restore.action`, "restore verdict must name restore");
  }
  const restoreShouldBeAllowed = parsed.status === ARCHIVED_STATUS;
  if (parsed.restore.allowed !== restoreShouldBeAllowed) {
    throw new ContractViolation(
      `${path}.restore.allowed`,
      "restore verdict does not match the current status",
    );
  }
  if (parsed.restore.allowed) {
    if (parsed.restore.targetStatus !== parsed.restoreTarget) {
      throw new ContractViolation(
        `${path}.restore.targetStatus`,
        "allowed restore must use the authoritative restore target",
      );
    }
  } else if (parsed.restore.reason !== "not_archived") {
    throw new ContractViolation(
      `${path}.restore.reason`,
      "a working investigation must refuse restore as not_archived",
    );
  }
}

/** Parse and semantically validate the authoritative lifecycle preview. */
export function parseInvestigationLifecycle(
  raw: unknown,
  path = "$",
): InvestigationLifecycleV1 {
  const record = checkEnvelope(
    raw,
    path,
    investigationLifecycleEnvelopeShape,
    ["archive", "restore", "deletion"],
  );
  const parsed: InvestigationLifecycleV1 = {
    schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
    investigationId: nonEmptyStringValue(record.investigationId, `${path}.investigationId`),
    status: caseStatusValue(record.status, `${path}.status`),
    legalHold: record.legalHold === true,
    archive: parseLifecycleVerdict(record.archive, `${path}.archive`),
    restore: parseLifecycleVerdict(record.restore, `${path}.restore`),
    restoreTarget: caseStatusValue(record.restoreTarget, `${path}.restoreTarget`),
    deletion: parseDeleteRequestAnswer(record.deletion, `${path}.deletion`),
  };
  assertLifecycleSemantics(parsed, path);
  return parsed;
}

export const INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID =
  "cd-collab.investigation_lifecycle_action_request.v1" as const;
export const INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID =
  "cd-collab.investigation_lifecycle_action_success.v1" as const;
export const INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID =
  "cd-collab.investigation_lifecycle_changed.v1" as const;
export const INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID =
  "cd-collab.investigation_lifecycle_action_refused.v1" as const;

/**
 * Refusal copy is operator-facing guidance, not an unbounded server error.
 * Six hundred characters leaves room for one actionable sentence while
 * keeping a malformed response from becoming an arbitrary payload surface.
 */
export const LIFECYCLE_REFUSAL_DETAIL_MAX_LENGTH = 600;

/** The lifecycle state a caller observed before requesting one action. */
export interface InvestigationLifecycleExpectedV1 {
  status: CaseStatus;
  legalHold: boolean;
  restoreTarget: CaseStatus;
}

export interface InvestigationLifecycleActionRequestV1 {
  schemaId: typeof INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID;
  investigationId: string;
  action: LifecycleAction;
  expected: InvestigationLifecycleExpectedV1;
  clientTime?: string;
}

export interface InvestigationLifecycleActionSuccessV1 {
  schemaId: typeof INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID;
  investigationId: string;
  action: LifecycleAction;
  previousStatus: CaseStatus;
  appliedStatus: CaseStatus;
  case: CaseV1;
}

export interface InvestigationLifecycleChangedV1 {
  schemaId: typeof INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID;
  error: "lifecycle_changed";
  investigationId: string;
  action: LifecycleAction;
  current: InvestigationLifecycleV1;
}

export interface InvestigationLifecycleActionRefusedV1 {
  schemaId: typeof INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID;
  error: "lifecycle_refused";
  investigationId: string;
  action: LifecycleAction;
  reason: LifecycleRefusal;
  /** A bounded operator-facing explanation that says what can be done next. */
  detail: string;
}

const lifecycleExpectedShape: ObjectShape = {
  status: f.req(f.en(...CASE_STATUSES)),
  legalHold: f.req(f.bool),
  restoreTarget: f.req(f.en(...CASE_STATUSES)),
};

const lifecycleActionRequestEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...LIFECYCLE_ACTIONS)),
  expected: f.req(f.str),
  clientTime: f.opt(f.nstr),
};

const lifecycleActionSuccessEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...LIFECYCLE_ACTIONS)),
  previousStatus: f.req(f.en(...CASE_STATUSES)),
  appliedStatus: f.req(f.en(...CASE_STATUSES)),
  case: f.req(f.str),
};

const lifecycleChangedEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID)),
  error: f.req(f.en("lifecycle_changed")),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...LIFECYCLE_ACTIONS)),
  current: f.req(f.str),
};

const lifecycleActionRefusedEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID)),
  error: f.req(f.en("lifecycle_refused")),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...LIFECYCLE_ACTIONS)),
  reason: f.req(f.en(...LIFECYCLE_REFUSALS)),
  detail: f.req(f.nstr),
};

function parseLifecycleExpected(
  raw: unknown,
  path: string,
): InvestigationLifecycleExpectedV1 {
  checkObject(path, lifecycleExpectedShape, raw);
  const record = recordAt(raw, path);
  const expected: InvestigationLifecycleExpectedV1 = {
    status: caseStatusValue(record.status, `${path}.status`),
    legalHold: record.legalHold === true,
    restoreTarget: caseStatusValue(record.restoreTarget, `${path}.restoreTarget`),
  };
  if (expected.restoreTarget === ARCHIVED_STATUS) {
    throw new ContractViolation(
      `${path}.restoreTarget`,
      "a restore target must be a working investigation status",
    );
  }
  return expected;
}

/**
 * Parse an action request. The destination status is deliberately absent:
 * only the server may derive it after comparing and reloading lifecycle state.
 *
 * The observed tuple may describe a refused preview. Structural validation
 * belongs here, but eligibility does not: accepting that tuple lets the
 * server re-evaluate it atomically and return the authoritative refusal.
 */
export function parseInvestigationLifecycleActionRequest(
  raw: unknown,
): InvestigationLifecycleActionRequestV1 {
  const record = checkEnvelope(
    raw,
    "$",
    lifecycleActionRequestEnvelopeShape,
    ["expected"],
  );
  const action = lifecycleActionValue(record.action, "$.action");
  const expected = parseLifecycleExpected(record.expected, "$.expected");
  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId: nonEmptyStringValue(record.investigationId, "$.investigationId"),
    action,
    expected,
    ...(typeof record.clientTime === "string" ? { clientTime: record.clientTime } : {}),
  };
}

function parseNestedCase(raw: unknown, path: string): CaseV1 {
  try {
    return parseCase(raw);
  } catch (error) {
    if (error instanceof ContractViolation) {
      const suffix = error.path === "$" ? "" : error.path.slice(1);
      throw new ContractViolation(`${path}${suffix}`, error.detail);
    }
    throw error;
  }
}

/** Parse a completed action and prove the returned case describes that action. */
export function parseInvestigationLifecycleActionSuccess(
  raw: unknown,
): InvestigationLifecycleActionSuccessV1 {
  const record = checkEnvelope(
    raw,
    "$",
    lifecycleActionSuccessEnvelopeShape,
    ["case"],
  );
  const action = lifecycleActionValue(record.action, "$.action");
  const previousStatus = caseStatusValue(record.previousStatus, "$.previousStatus");
  const appliedStatus = caseStatusValue(record.appliedStatus, "$.appliedStatus");
  const parsedCase = parseNestedCase(record.case, "$.case");
  const investigationId = nonEmptyStringValue(record.investigationId, "$.investigationId");

  if (parsedCase.id !== investigationId) {
    throw new ContractViolation("$.case.id", "case belongs to a different investigation");
  }
  if (parsedCase.status !== appliedStatus) {
    throw new ContractViolation(
      "$.case.status",
      "case status must equal the applied lifecycle status",
    );
  }
  if (action === "archive") {
    if (previousStatus === ARCHIVED_STATUS || appliedStatus !== ARCHIVED_STATUS) {
      throw new ContractViolation(
        "$.appliedStatus",
        "archive must move a working investigation to archived",
      );
    }
  } else if (previousStatus !== ARCHIVED_STATUS || appliedStatus === ARCHIVED_STATUS) {
    throw new ContractViolation(
      "$.appliedStatus",
      "restore must move an archived investigation to a working status",
    );
  }

  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
    investigationId,
    action,
    previousStatus,
    appliedStatus,
    case: parsedCase,
  };
}

/** Parse an optimistic-state conflict carrying the server's current preview. */
export function parseInvestigationLifecycleChanged(
  raw: unknown,
): InvestigationLifecycleChangedV1 {
  const record = checkEnvelope(raw, "$", lifecycleChangedEnvelopeShape, ["current"]);
  const investigationId = nonEmptyStringValue(record.investigationId, "$.investigationId");
  const action = lifecycleActionValue(record.action, "$.action");
  const current = parseInvestigationLifecycle(record.current, "$.current");
  if (current.investigationId !== investigationId) {
    throw new ContractViolation(
      "$.current.investigationId",
      "current lifecycle belongs to a different investigation",
    );
  }
  if (current[action].action !== action) {
    throw new ContractViolation(
      `$.current.${action}.action`,
      "current lifecycle verdict does not match the requested action",
    );
  }
  return {
    schemaId: INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
    error: "lifecycle_changed",
    investigationId,
    action,
    current,
  };
}

function boundedLifecycleRefusalDetail(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if (value.length > LIFECYCLE_REFUSAL_DETAIL_MAX_LENGTH) {
    throw new ContractViolation(
      path,
      `detail exceeds ${LIFECYCLE_REFUSAL_DETAIL_MAX_LENGTH} characters`,
    );
  }
  const detail = value.trim();
  if (detail.length === 0) {
    throw new ContractViolation(path, "expected non-empty actionable detail");
  }
  return detail;
}

/** Parse an action refusal without admitting an arbitrary server error body. */
export function parseInvestigationLifecycleActionRefused(
  raw: unknown,
): InvestigationLifecycleActionRefusedV1 {
  checkObject("$", lifecycleActionRefusedEnvelopeShape, raw);
  const record = recordAt(raw, "$");
  const investigationId = nonEmptyStringValue(record.investigationId, "$.investigationId");
  const action = lifecycleActionValue(record.action, "$.action");
  const reason = lifecycleRefusalValue(record.reason, "$.reason");
  const detail = boundedLifecycleRefusalDetail(record.detail, "$.detail");

  if (
    (reason === "legal_hold" || reason === "already_archived") &&
    action !== "archive"
  ) {
    throw new ContractViolation(
      "$.reason",
      `${reason} can only refuse an archive action`,
    );
  }
  if (reason === "not_archived" && action !== "restore") {
    throw new ContractViolation(
      "$.reason",
      "not_archived can only refuse a restore action",
    );
  }

  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
    error: "lifecycle_refused",
    investigationId,
    action,
    reason,
    detail,
  };
}

/**
 * Whether a status change is one this module governs.
 *
 * Ordinary transitions — `open` to `monitoring`, say — are none of this
 * module's business and must keep flowing through the existing status path
 * untouched.
 */
export function isLifecycleTransition(from: string, to: string): boolean {
  return to === ARCHIVED_STATUS || from === ARCHIVED_STATUS;
}
