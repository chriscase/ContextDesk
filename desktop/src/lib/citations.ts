/**
 * Citation scheme classification for turn-completion and click routing
 * (#701 / #698). Pure — no host I/O.
 */

import { parseHelpLocator } from "./help";

export type CompletedCitationRoute =
  | "help"
  | "log"
  | "file"
  | "deferred"
  | "invalid";

const GOVERNED_LOG_CITATION =
  /^(?:log_template|log_event):[a-z0-9][a-z0-9._-]*$/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;

/**
 * Classify a citation id before any automatic I/O or Explorer reveal.
 * Governed/in-app identities must never be interpreted as workspace paths.
 */
export function classifyCompletedCitation(
  citationId: string,
): CompletedCitationRoute {
  const id = citationId.trim();
  if (!id || id.includes("\0")) return "invalid";
  if (parseHelpLocator(id)) return "help";
  if (GOVERNED_LOG_CITATION.test(id)) return "log";

  if (
    id.startsWith("help://") ||
    id.startsWith("log_template:") ||
    id.startsWith("log_event:")
  ) {
    return "invalid";
  }

  // These are handled only after an explicit citation click.
  if (/^https?:\/\//i.test(id) || /^memory:[a-z0-9._-]+$/i.test(id)) {
    return "deferred";
  }

  if (URI_SCHEME.test(id) && !WINDOWS_ABSOLUTE_PATH.test(id)) {
    return "invalid";
  }
  return "file";
}

/** Parse a governed log_event identity into a sequence number when numeric. */
export function parseLogEventSeq(sourceId: string): number | null {
  const match = /^log_event:(\d+)$/i.exec(sourceId.trim());
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isFinite(seq) ? seq : null;
}

/** Parse a governed log_template identity into a template id when numeric. */
export function parseLogTemplateId(sourceId: string): number | null {
  const match = /^log_template:(\d+)$/i.exec(sourceId.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

export function isGovernedLogCitationId(sourceId: string): boolean {
  return GOVERNED_LOG_CITATION.test(sourceId.trim());
}

/**
 * Open a persisted log citation against its host-authored corpus only (#698).
 * Never substitutes the chat's currently attached corpus when provenance is
 * missing or the original corpus is gone.
 */
export async function openPersistedLogCitation(
  sourceId: string,
  corpusId: string | undefined,
  showUnavailable: (sourceId: string, message: string) => void,
  openExplorer: (corpusId: string) => Promise<unknown>,
): Promise<void> {
  if (!corpusId) {
    showUnavailable(
      sourceId,
      "This older log citation does not record its original corpus. ContextDesk will not substitute the chat’s current corpus.",
    );
    return;
  }
  try {
    await openExplorer(corpusId);
  } catch (error) {
    showUnavailable(
      sourceId,
      `The original log corpus for this citation is unavailable:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
