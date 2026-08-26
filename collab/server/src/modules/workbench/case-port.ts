/**
 * Adapts case, evidence, and log-time stores to the Log workbench port.
 */
import {
  corpusAllowedExtension,
  type HostEventStampV1,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { EvidenceStore } from "../../evidence/store.js";
import type { Actor, CaseService, CaseStore } from "../cases/index.js";
import type {
  WorkbenchCasePort,
  WorkbenchEvidenceDescriptor,
  WorkbenchEvidenceFile,
  WorkbenchHostSearchInput,
  WorkbenchHostSearchOutcome,
} from "./service.js";

export interface WorkbenchCasePortDeps {
  cases: CaseStore;
  domain: Pick<CaseService, "getCase" | "appendDomainTimeline">;
  evidence: EvidenceStore;
  currentNormalizationRevision: (caseId: string) => Promise<number | null>;
  listHostEventStamps?: (
    caseId: string,
    sources?: string[],
    k?: number,
  ) => Promise<HostEventStampV1[] | null>;
  hostSearch?: (
    caseId: string,
    input: WorkbenchHostSearchInput,
  ) => Promise<WorkbenchHostSearchOutcome | null>;
}

/**
 * Total order over intake paths.
 *
 * Deliberately not `localeCompare`: locale collation can report two distinct
 * paths as equal, and a resume cursor that names "the file after this one" is
 * only meaningful when that answer is the same on every request and every
 * machine.
 */
function byPath(
  left: { relativePath: string; evidenceId: string },
  right: { relativePath: string; evidenceId: string },
): number {
  if (left.relativePath !== right.relativePath) {
    return left.relativePath < right.relativePath ? -1 : 1;
  }
  if (left.evidenceId === right.evidenceId) return 0;
  return left.evidenceId < right.evidenceId ? -1 : 1;
}

export function createWorkbenchCasePort(deps: WorkbenchCasePortDeps): WorkbenchCasePort {
  return {
    async getCase(caseId: string, actor: Actor, isAdmin: boolean) {
      const found = await deps.domain.getCase(caseId, actor, isAdmin);
      return found ? { id: found.id } : null;
    },

    /**
     * Which log files this investigation owns, without their bytes.
     *
     * Existence is checked with a metadata probe rather than a read, so a
     * listing costs nothing per byte and a selection can be applied before any
     * file is opened.
     */
    async listEvidenceDescriptors(caseId: string): Promise<WorkbenchEvidenceDescriptor[]> {
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      const files: WorkbenchEvidenceDescriptor[] = [];
      for (const artifact of artifacts) {
        const path = artifact.relativePath ?? artifact.filename;
        if (!path || !artifact.contentHash) continue;
        if (corpusAllowedExtension(path) === null) continue;
        if (!(await deps.evidence.head(artifact.contentHash))) continue;
        files.push({
          evidenceId: artifact.id,
          relativePath: path,
          digest: artifact.contentHash,
          intakeBatchId: artifact.intakeBatchId ?? null,
          privacyClass: artifact.privacyClass,
        });
      }
      return files.sort(byPath);
    },

    /** One file's bytes, read only once that file is known to be in scope. */
    async readEvidenceText(caseId: string, evidenceId: string): Promise<string | null> {
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      const artifact = artifacts.find((item) => item.id === evidenceId);
      if (!artifact?.contentHash) return null;
      const path = artifact.relativePath ?? artifact.filename;
      if (!path || corpusAllowedExtension(path) === null) return null;
      const bytes = await deps.evidence.get(artifact.contentHash);
      if (!bytes) return null;
      return new TextDecoder("utf-8").decode(bytes);
    },

    async listEvidenceFiles(caseId: string): Promise<WorkbenchEvidenceFile[]> {
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      const files: WorkbenchEvidenceFile[] = [];
      for (const artifact of artifacts) {
        const path = artifact.relativePath ?? artifact.filename;
        if (!path || !artifact.contentHash) continue;
        if (corpusAllowedExtension(path) === null) continue;
        const bytes = await deps.evidence.get(artifact.contentHash);
        if (!bytes) continue;
        files.push({
          evidenceId: artifact.id,
          relativePath: path,
          digest: artifact.contentHash,
          intakeBatchId: artifact.intakeBatchId ?? null,
          privacyClass: artifact.privacyClass,
          text: new TextDecoder("utf-8").decode(bytes),
        });
      }
      return files.sort(byPath);
    },

    currentNormalizationRevision: deps.currentNormalizationRevision,

    ...(deps.listHostEventStamps
      ? { listHostEventStamps: deps.listHostEventStamps }
      : {}),

    ...(deps.hostSearch ? { hostSearch: deps.hostSearch } : {}),

    async casePrivacyClass(caseId: string): Promise<PrivacyClass> {
      const artifacts = await deps.cases.listArtifactsByCase(caseId);
      return artifacts.some((artifact) => artifact.privacyClass === "owner_only")
        ? "owner_only"
        : "share_safe";
    },

    async appendTimeline(caseId, event) {
      return deps.domain.appendDomainTimeline(caseId, {
        kind: event.kind,
        actor: event.actor,
        targetId: event.targetId,
        clientTime: null,
        payload: event.payload,
      });
    },
  };
}
