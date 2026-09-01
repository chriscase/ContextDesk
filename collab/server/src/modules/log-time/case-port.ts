/**
 * Adapts the case, evidence, and triage-job stores to the narrow port the
 * log-time service needs. Keeping it here means the service depends on five
 * named questions rather than on three whole store interfaces.
 */
import {
  CORPUS_INTAKE_LIMITS,
  corpusAllowedExtension,
  type ContentHash,
  type PrivacyClass,
} from "@cd-collab/contracts";
import { collectBoundedEvidenceBytes } from "../../evidence/bounded-read.js";
import { isContentHash, type EvidenceStore } from "../../evidence/store.js";
import type { Actor, CaseService, CaseStore } from "../cases/index.js";
import type { TriageJobStore } from "../triage-runs/index.js";
import type { LogTimeCasePort } from "./service.js";
import { LogTimeNotFoundError, LogTimeRequestError } from "./bridge.js";

/** The log host's per-source materialization envelope. */
export const LOG_CORPUS_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The analysis builder shares intake's file and expanded-byte envelope. It
 * rejects overflow explicitly instead of handing the host a silent prefix.
 */
export function corpusBuilderCapacityError(
  fileCount: number,
  currentBytes: number,
  nextFileBytes: number,
): string | null {
  if (fileCount > CORPUS_INTAKE_LIMITS.maxFileCount) {
    return `log corpus exceeds the ${CORPUS_INTAKE_LIMITS.maxFileCount.toLocaleString("en-US")}-file intake limit`;
  }
  if (nextFileBytes > LOG_CORPUS_MAX_FILE_BYTES) {
    return "a log corpus file exceeds the 64 MiB intake limit";
  }
  if (nextFileBytes > CORPUS_INTAKE_LIMITS.maxExpandedBytes - currentBytes) {
    return "log corpus exceeds the 512 MiB expanded intake limit";
  }
  return null;
}

export interface LogTimeCasePortDeps {
  cases: CaseStore;
  domain: Pick<CaseService, "getCase" | "getReadableHeldArtifact">;
  evidence: EvidenceStore;
  jobs: TriageJobStore;
}

export function createLogTimeCasePort(deps: LogTimeCasePortDeps): LogTimeCasePort {
  return {
    async getCase(caseId: string, actor: Actor, isAdmin: boolean) {
      const found = await deps.domain.getCase(caseId, actor, isAdmin);
      return found ? { id: found.id } : null;
    },

    async listSnapshotsForCase(caseId: string) {
      const snapshots = await deps.cases.listSnapshotsByCase(caseId);
      return snapshots.map((snapshot) => ({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
      }));
    },

    async listTriageRunsForCase(caseId: string) {
      const jobs = await deps.jobs.listByCase(caseId);
      return jobs.map((job) => ({
        id: job.id,
        snapshotId: job.snapshotId ?? null,
        createdAt: job.createdAt,
      }));
    },

    /**
     * The log files already committed to this case, in a stable order.
     *
     * Only text log artifacts the intake allowlist recognises are included;
     * anything whose stored bytes cannot be read is skipped rather than sent as
     * an empty file, so a corpus never silently contains a blank source.
     */
    async listCorpusFilesForCase(
      caseId: string,
      actor: Actor,
      isAdmin: boolean,
      canReadPrivate: boolean,
    ) {
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      const ordered = artifacts
        .filter((artifact) => {
          const path = artifact.relativePath;
          if (!path || !artifact.contentHash || !isContentHash(artifact.contentHash)) return false;
          return corpusAllowedExtension(path) !== null;
        })
        .sort((left, right) => {
          const leftPath = left.relativePath as string;
          const rightPath = right.relativePath as string;
          if (leftPath === rightPath) return 0;
          return leftPath < rightPath ? -1 : 1;
        });

      const seen = new Set<string>();
      const selected = ordered.filter((artifact) => {
        const path = artifact.relativePath as string;
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      });

      // Privacy authorization precedes even catalog capacity diagnostics: an
      // over-cap hidden source must not reveal its size through a different
      // public error.
      if (!canReadPrivate && selected.some((artifact) => artifact.privacyClass === "owner_only")) {
        throw new LogTimeNotFoundError("not_found");
      }

      const eligible: {
        evidenceId: string;
        relativePath: string;
        contentHash: ContentHash;
        byteLength: number;
        privacyClass: PrivacyClass;
      }[] = [];
      let total = 0;
      for (const artifact of selected) {
        const path = artifact.relativePath as string;
        if (!Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength ?? -1) < 0) {
          throw new LogTimeRequestError("log corpus artifact has an invalid catalog byte length");
        }
        const byteLength = artifact.byteLength as number;
        const capacityError = corpusBuilderCapacityError(
          eligible.length + 1,
          total,
          byteLength,
        );
        if (capacityError) throw new LogTimeRequestError(capacityError);
        total += byteLength;
        eligible.push({
          evidenceId: artifact.id,
          relativePath: path,
          contentHash: artifact.contentHash as ContentHash,
          byteLength,
          privacyClass: artifact.privacyClass,
        });
      }

      const files: { relativePath: string; contentBase64: string }[] = [];
      for (const artifact of eligible) {
        // Re-authorize each selected source immediately before materializing
        // it. A grant checked during catalog preflight is not a read lease.
        const readable = await deps.domain.getReadableHeldArtifact(
          caseId,
          artifact.evidenceId,
          actor,
          isAdmin,
          canReadPrivate,
        );
        if (!readable) throw new LogTimeNotFoundError("not_found");
        if (
          readable.relativePath !== artifact.relativePath
          || readable.contentHash !== artifact.contentHash
          || readable.byteLength !== artifact.byteLength
          || readable.privacyClass !== artifact.privacyClass
        ) {
          throw new LogTimeRequestError("log corpus artifact changed during authorization");
        }
        const bytes = await collectBoundedEvidenceBytes({
          evidence: deps.evidence,
          hash: artifact.contentHash,
          expectedLength: artifact.byteLength,
          maxBytes: LOG_CORPUS_MAX_FILE_BYTES,
        });
        if (!bytes) continue;
        files.push({
          relativePath: artifact.relativePath,
          contentBase64: Buffer.from(bytes).toString("base64"),
        });
      }
      return files;
    },

    /**
     * The corpus inherits the strictest privacy class among the files it was
     * built from. A corpus that contains one owner-only file is owner-only.
     */
    async casePrivacyClass(caseId: string): Promise<PrivacyClass> {
      const artifacts = (await deps.cases.listArtifactsByCase(caseId))
        .filter((artifact) => {
          const path = artifact.relativePath;
          return Boolean(
            path
            && artifact.contentHash
            && isContentHash(artifact.contentHash)
            && corpusAllowedExtension(path) !== null,
          );
        })
        .sort((left, right) => {
          const leftPath = left.relativePath as string;
          const rightPath = right.relativePath as string;
          if (leftPath === rightPath) return 0;
          return leftPath < rightPath ? -1 : 1;
        });
      const seen = new Set<string>();
      const selected = artifacts.filter((artifact) => {
        const path = artifact.relativePath as string;
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      });
      return selected.some((artifact) => artifact.privacyClass === "owner_only")
        ? "owner_only"
        : selected.length > 0
          ? "share_safe"
          : "owner_only";
    },

    async appendTimeline(caseId, event) {
      return deps.cases.appendTimeline(caseId, {
        kind: event.kind,
        actor: event.actor,
        targetId: event.targetId,
        clientTime: null,
        payload: event.payload,
      });
    },
  };
}
