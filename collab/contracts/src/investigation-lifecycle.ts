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
import { CASE_STATUSES, type CaseStatus } from "./case.js";

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
  status: string;
  legalHold: boolean;
  archive: LifecycleVerdict;
  restore: LifecycleVerdict;
  /** Where a restore would land, whether or not one is currently allowed. */
  restoreTarget: CaseStatus;
  deletion: DeleteRequestAnswer;
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
