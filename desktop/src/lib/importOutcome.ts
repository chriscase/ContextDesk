/**
 * Fail-closed operator seal for import error strings.
 *
 * The host is supposed to strip the `[member=` transport marker before a
 * string crosses IPC. This is the second seal: a leaky host string is cut
 * at the first marker, whether or not the frame parses. A ZIP member name
 * that itself contains `[member=` therefore cannot appear in the UI.
 */
import {
  hostImportFailure,
  type ImportOutcomeReport,
} from "@contextdesk/client";

export function sealImportOperatorMessage(message: string): string {
  const marker = "[member=";
  const at = message.indexOf(marker);
  if (at === -1) return message;
  const cut = at > 0 && message[at - 1] === " " ? at - 1 : at;
  return message.slice(0, cut).trimEnd();
}

/**
 * Operator-visible import-command rejection.
 *
 * Tauri v2 rejects `invoke` with the serialized `ImportCommandErrorDto`
 * (`{ message, outcome? }`). `String(error)` is `[object Object]`. Unwrap
 * through the same host reader `log_run_import` already uses, then seal.
 */
export function operatorImportCommandFailure(error: unknown): {
  message: string;
  outcome?: ImportOutcomeReport;
} {
  const { message, outcome } = hostImportFailure(error);
  const sealed = sealImportOperatorMessage(message);
  if (outcome?.class === "rejected") {
    return { message: `Import rejected: ${sealed}`, outcome };
  }
  return { message: sealed, outcome };
}
