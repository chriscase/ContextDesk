/**
 * Truthful re-analysis copy, mirroring
 * `cd_core::log_analysis::reanalysis_plan`.
 *
 * These live outside `lib/host.ts` on purpose. They are product copy, not IPC:
 * keeping them here means a component can render the honest sentence without
 * pulling in the host surface, and — because component tests mock the host
 * module — that a test double can never accidentally stand in for the wording
 * a user is shown before their log content moves.
 *
 * The two strings share no claim about egress, so a surface cannot describe a
 * remote operation with local wording. {@link reanalysisLocalityCopy} is the
 * only supported way to choose between them.
 */

/** Shown before a re-analysis that runs in-process. */
export const LOCAL_REANALYSIS_COPY =
  "Re-analysis runs on this machine. Log content does not leave this machine.";

/**
 * Shown before a re-analysis that sends template text to another machine.
 *
 * It names both facts a person needs in order to consent: what is sent
 * (template text, not the whole corpus) and that it leaves the machine.
 */
export const REMOTE_REANALYSIS_COPY =
  "Re-analysis sends log template text to a remote embedding provider. " +
  "Log content leaves this machine.";

/** Pick the truthful sentence for a re-analysis by where its work runs. */
export function reanalysisLocalityCopy(leavesMachine: boolean): string {
  return leavesMachine ? REMOTE_REANALYSIS_COPY : LOCAL_REANALYSIS_COPY;
}
