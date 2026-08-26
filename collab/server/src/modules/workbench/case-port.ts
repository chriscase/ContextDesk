/**
 * Adapts case, evidence, and log-time stores to the Log workbench port.
 */
import { corpusAllowedExtension, type PrivacyClass } from "@cd-collab/contracts";
import type { EvidenceStore } from "../../evidence/store.js";
import type { Actor, CaseService, CaseStore } from "../cases/index.js";
import type {
  WorkbenchCasePort,
  WorkbenchEvidenceFile,
  WorkbenchHostStamps,
} from "./service.js";

export interface WorkbenchCasePortDeps {
  cases: CaseStore;
  domain: Pick<CaseService, "getCase" | "appendDomainTimeline">;
  evidence: EvidenceStore;
  currentNormalizationRevision: (caseId: string) => Promise<number | null>;
  listHostEventStamps?: (caseId: string) => Promise<WorkbenchHostStamps | null>;
}

/**
 * The slice of the log-time service the overlay reads. Declared structurally so
 * the workbench does not reach into another module for a type.
 */
export interface WorkbenchHostEventSource {
  listWorkbenchEvents(caseId: string): Promise<{
    corpusRevision: number;
    search: {
      hits: {
        source: string;
        message: string;
        ts: number;
        timeQuality: string;
        unresolvedLocalTimestamp: string | null;
      }[];
    };
  } | null>;
}

/**
 * Adapt the host corpus reader to the workbench port.
 *
 * There is one definition because there are three callers — the server, the
 * demo, and the browser fixture — and each wires it through a conditional
 * spread. A spread defeats the contextual typing that would otherwise catch a
 * drifting shape, so a hand-rolled copy at each site can go wrong silently and
 * only fail at runtime. Written once, it is checked once.
 */
export function workbenchHostEventStamps(
  logTime: WorkbenchHostEventSource,
): (caseId: string) => Promise<WorkbenchHostStamps | null> {
  return async (caseId) => {
    const listed = await logTime.listWorkbenchEvents(caseId);
    if (listed === null) return null;
    // The revision travels with the stamps: the overlay describes this
    // revision of the host corpus and no other.
    return {
      corpusRevision: listed.corpusRevision,
      stamps: listed.search.hits.map((hit) => ({
        source: hit.source,
        message: hit.message,
        ts: hit.ts,
        timeQuality: hit.timeQuality,
        unresolvedLocalTimestamp: hit.unresolvedLocalTimestamp,
      })),
    };
  };
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
