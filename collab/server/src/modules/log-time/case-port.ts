/**
 * Adapts the case, evidence, and triage-job stores to the narrow port the
 * log-time service needs. Keeping it here means the service depends on five
 * named questions rather than on three whole store interfaces.
 */
import {
  CORPUS_INTAKE_LIMITS,
  corpusAllowedExtension,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { EvidenceStore } from "../../evidence/store.js";
import type { Actor, CaseService, CaseStore } from "../cases/index.js";
import type { TriageJobStore } from "../triage-runs/index.js";
import type { LogTimeCasePort } from "./service.js";
import { LogTimeRequestError } from "./bridge.js";

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
  if (nextFileBytes > CORPUS_INTAKE_LIMITS.maxFileBytes) {
    return "a log corpus file exceeds the 64 MiB intake limit";
  }
  if (nextFileBytes > CORPUS_INTAKE_LIMITS.maxExpandedBytes - currentBytes) {
    return "log corpus exceeds the 512 MiB expanded intake limit";
  }
  return null;
}

export interface LogTimeCasePortDeps {
  cases: CaseStore;
  domain: Pick<CaseService, "getCase">;
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
    async listCorpusFilesForCase(caseId: string) {
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      const eligible = artifacts
        .filter((artifact) => {
          const path = artifact.relativePath;
          if (!path || !artifact.contentHash) return false;
          return corpusAllowedExtension(path) !== null;
        })
        .sort((left, right) =>
          (left.relativePath ?? "").localeCompare(right.relativePath ?? ""),
        );

      const files: { relativePath: string; contentBase64: string }[] = [];
      const seen = new Set<string>();
      let total = 0;
      for (const artifact of eligible) {
        const path = artifact.relativePath as string;
        // Intake permits the same relative path across batches; the corpus
        // needs one file per path, so the first committed wins.
        if (seen.has(path)) continue;
        const bytes = await deps.evidence.get(artifact.contentHash as string);
        if (!bytes) continue;
        const capacityError = corpusBuilderCapacityError(
          files.length + 1,
          total,
          bytes.byteLength,
        );
        if (capacityError) throw new LogTimeRequestError(capacityError);
        total += bytes.byteLength;
        seen.add(path);
        files.push({
          relativePath: path,
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
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      return artifacts.some((artifact) => artifact.privacyClass === "owner_only")
        ? "owner_only"
        : artifacts.length > 0
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
