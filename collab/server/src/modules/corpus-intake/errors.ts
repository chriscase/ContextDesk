import {
  ContractViolation,
  corpusIntakeError,
  type CorpusIntakeErrorCode,
  type CorpusIntakeErrorV1,
  type CorpusRejectionReason,
} from "@cd-collab/contracts";

/**
 * A refusal carried to the client as a structured, named cause.
 *
 * Intake failures are almost always something the operator can act on — split
 * the archive, drop the binary, widen a configured limit — so the wire shape
 * carries the code, the limit, and what was observed rather than a bare string.
 */
export class CorpusIntakeRequestError extends Error {
  readonly status: number;

  constructor(
    readonly payload: CorpusIntakeErrorV1,
    status = 400,
  ) {
    super(payload.message);
    this.name = "CorpusIntakeRequestError";
    this.status = status;
  }
}

export function intakeError(
  code: CorpusIntakeErrorCode,
  message: string,
  extra: Partial<Omit<CorpusIntakeErrorV1, "schemaId" | "code" | "message">> & { status?: number } = {},
): CorpusIntakeRequestError {
  const { status, ...rest } = extra;
  return new CorpusIntakeRequestError(corpusIntakeError(code, message, rest), status ?? 400);
}

/**
 * Map a per-member rejection reason onto the envelope vocabulary.
 *
 * Both vocabularies exist for a reason: the rejection reason is what the intake
 * report records per file, while the error code is what an aborted request
 * returns. Keeping the mapping in one place stops the two from disagreeing
 * about the same refusal.
 */
const REASON_TO_CODE: Partial<Record<CorpusRejectionReason, CorpusIntakeErrorCode>> = {
  absolute_path: "unsafe_archive_path",
  path_traversal: "unsafe_archive_path",
  drive_or_unc_path: "unsafe_archive_path",
  nul_in_path: "unsafe_archive_path",
  empty_path: "unsafe_archive_path",
  unsafe_archive_path: "unsafe_archive_path",
  symlink_or_hardlink: "link_or_special_file",
  device_entry: "link_or_special_file",
  duplicate_normalized_path: "duplicate_path",
  nested_archive: "archive_depth_exceeded",
  archive_depth_exceeded: "archive_depth_exceeded",
  encrypted_archive: "unsupported_archive_feature",
  malformed_zip: "malformed_archive",
  unsupported_zip64: "unsupported_archive_feature",
  oversized_archive: "compressed_budget_exceeded",
  oversized_expanded: "expanded_budget_exceeded",
  extreme_ratio: "archive_ratio_exceeded",
  too_many_files: "file_count_exceeded",
  path_too_deep: "path_depth_exceeded",
  path_too_long: "path_too_long",
  file_too_large: "per_file_bytes_exceeded",
  processing_timeout: "expansion_timeout",
  invalid_encoding: "unsupported_encoding",
  unsupported_encoding: "unsupported_encoding",
  redaction_failed: "privacy_gate_rejected",
  line_too_long: "per_file_bytes_exceeded",
  structured_too_large: "per_file_bytes_exceeded",
};

export function codeForRejection(reason: CorpusRejectionReason): CorpusIntakeErrorCode {
  return REASON_TO_CODE[reason] ?? "malformed_archive";
}

/**
 * Contract violations from an intake body already name their cause as a
 * `code: detail` prefix where the shape check can identify one. Lifting that
 * prefix here keeps one structured vocabulary on the wire instead of a mix of
 * codes and bare validation strings.
 */
const CONTRACT_CODES = [
  "request_too_large",
  "expanded_budget_exceeded",
  "file_count_exceeded",
  "per_file_bytes_exceeded",
  "compressed_budget_exceeded",
  "path_too_long",
  "duplicate_path",
] as const;

export function intakeErrorFromContractViolation(
  error: ContractViolation,
): CorpusIntakeRequestError {
  const prefix = error.detail.split(":")[0]?.trim() ?? "";
  const matched = CONTRACT_CODES.find((candidate) => candidate === prefix);
  return intakeError(matched ?? "session_state_invalid", error.message, {
    detail: error.message,
  });
}
