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
import type { WorkbenchCasePort, WorkbenchEvidenceFile } from "./service.js";

export interface WorkbenchCasePortDeps {
  cases: CaseStore;
  domain: Pick<CaseService, "getCase" | "appendDomainTimeline">;
  evidence: EvidenceStore;
  currentNormalizationRevision: (caseId: string) => Promise<number | null>;
  listHostEventStamps?: (caseId: string) => Promise<HostEventStampV1[] | null>;
}

export function createWorkbenchCasePort(deps: WorkbenchCasePortDeps): WorkbenchCasePort {
  return {
    async getCase(caseId: string, actor: Actor, isAdmin: boolean) {
      const found = await deps.domain.getCase(caseId, actor, isAdmin);
      return found ? { id: found.id } : null;
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
      return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    },

    currentNormalizationRevision: deps.currentNormalizationRevision,

    ...(deps.listHostEventStamps
      ? { listHostEventStamps: deps.listHostEventStamps }
      : {}),

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
