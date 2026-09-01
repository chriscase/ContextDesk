import { randomUUID } from "node:crypto";
import {
  EXTERNAL_RUN_SCHEMA_ID,
  type Completeness,
  type CorroborationState,
  type EvidenceVisibility,
  type ExternalRunV1,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { EvidenceStage, EvidenceStore, EvidenceWriteBatch } from "../../evidence/store.js";
import type { AuditStore } from "../audit/index.js";
import type { CatalogService } from "../catalog/index.js";
import { CaseStoreCommitOutcomeUnknownError, type Actor, type CaseService } from "../cases/index.js";
import { defaultPrivacy } from "../contributions/index.js";
import { assertUploadAllowed } from "../evidence/index.js";
import {
  completenessOrUnknown,
  hashRunBytes,
  initialCorroborationState,
  visibilityOrUnknown,
} from "./model.js";
import { MemoryRunStore, type FrozenRunRow, type RunStore } from "./store.js";

export interface ImportInput {
  outputText: string;
  promptText?: string | null;
  sourceId: string;
  operatorId: string;
  operatorUsername: string;
  promptCompleteness?: string;
  outputCompleteness?: string;
  workflowCompleteness?: string;
  evidenceVisibility?: string;
  snapshotBinding?: string | null;
  visibilityNote?: string | null;
  provider?: string | null;
  model?: string | null;
  version?: string | null;
  claimedTraces?: string[];
  uncertainty?: string | null;
  timing?: string | null;
  cost?: string | null;
  redacted?: boolean;
  privacyClass?: PrivacyClass;
}

async function finalizeCommittedEvidenceBatch(batch: EvidenceWriteBatch | null): Promise<void> {
  if (!batch) return;
  try {
    await batch.finalize();
  } catch {
    try {
      await batch.finalize();
    } catch {
      // The catalog COMMIT and canonical bytes are durable. Provider recovery
      // owns remaining journal/staging cleanup; rollback would be destructive.
    }
  }
}

async function settleImportEvidenceFailure(
  error: unknown,
  batch: EvidenceWriteBatch | null,
  stages: EvidenceStage[],
  evidencePromoted: boolean,
): Promise<void> {
  if (error instanceof CaseStoreCommitOutcomeUnknownError && evidencePromoted) {
    if (batch) {
      try {
        await batch.finalize({ retainPendingJournal: true });
      } catch {
        // Recovery must retain the journal while the catalog outcome is unknown.
      }
    }
    return;
  }
  if (batch) {
    await batch.rollback();
  } else {
    await Promise.allSettled(stages.map((stage) => stage.rollback()));
  }
}

export class ImportService {
  private readonly runs: RunStore;

  constructor(
    private readonly deps: {
      evidence: EvidenceStore;
      audit: AuditStore;
      cases: CaseService;
      catalog: CatalogService;
      runs?: RunStore;
    },
  ) {
    this.runs = deps.runs ?? new MemoryRunStore();
  }

  async importRun(
    caseId: string,
    actor: Actor,
    input: ImportInput,
    origin: string,
    isAdmin: boolean,
  ): Promise<ExternalRunV1> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new Error("case not found");
    }
    const source = await this.deps.catalog.requireSource(input.sourceId);
    const output = input.outputText;
    if (!output) throw new Error("output is required");
    const outputBytes = new TextEncoder().encode(output);
    assertUploadAllowed("text/plain", outputBytes.byteLength);
    const outputHash = hashRunBytes(outputBytes);

    const promptText = input.promptText ?? null;
    let promptBytes: Uint8Array | null = null;
    let promptHash: string | null = null;
    if (promptText !== null) {
      promptBytes = new TextEncoder().encode(promptText);
      assertUploadAllowed("text/plain", promptBytes.byteLength);
      promptHash = hashRunBytes(promptBytes);
    }

    const promptCompleteness = completenessOrUnknown(input.promptCompleteness);
    const outputCompleteness = completenessOrUnknown(input.outputCompleteness);
    const workflowCompleteness = completenessOrUnknown(input.workflowCompleteness);
    if (promptText === null && promptCompleteness === "exact") {
      throw new Error("output-only import cannot claim exact prompt completeness");
    }
    const evidenceVisibility = visibilityOrUnknown(input.evidenceVisibility);
    const snapshotBinding = input.snapshotBinding ?? null;
    const privacy = defaultPrivacy(input.privacyClass);

    const contributionInput: {
      kind: string;
      body: string;
      privacyClass: PrivacyClass;
      sourceId: string;
    } = {
      kind: "external_run",
      body: `Imported external run (${outputHash.slice(0, 12)})`,
      privacyClass: privacy,
      sourceId: source.id,
    };

    const stages: EvidenceStage[] = [];
    let evidenceBatch: EvidenceWriteBatch | null = null;
    let evidencePromoted = false;
    const memoryRuns = this.runs instanceof MemoryRunStore ? this.runs : null;
    try {
      evidenceBatch = await this.deps.evidence.beginWriteBatch?.() ?? null;
      const result = await this.deps.cases.withAtomic(async () => {
        // SQLite wraps every method as async; capture/restore must be awaited
        // or restore receives a Promise and throws DataCloneError.
        const runSnapshot = memoryRuns ? await Promise.resolve(memoryRuns.capture()) : undefined;
        try {
          if (evidenceBatch) {
            const outputMeta = await evidenceBatch.put(outputBytes, { contentType: "text/plain" });
            if (outputMeta.hash !== outputHash) {
              throw new Error("hash verification failed after storage");
            }
            if (promptBytes && promptHash) {
              const promptMeta = await evidenceBatch.put(promptBytes, { contentType: "text/plain" });
              if (promptMeta.hash !== promptHash) {
                throw new Error("hash verification failed after storage");
              }
            }
          } else {
            const outputStage = await this.deps.evidence.stage(outputBytes, { contentType: "text/plain" });
            stages.push(outputStage);
            if (outputStage.meta.hash !== outputHash) {
              throw new Error("hash verification failed after storage");
            }
            if (promptBytes && promptHash) {
              const promptStage = await this.deps.evidence.stage(promptBytes, { contentType: "text/plain" });
              stages.push(promptStage);
              if (promptStage.meta.hash !== promptHash) {
                throw new Error("hash verification failed after storage");
              }
            }
          }

          const contribution = await this.deps.cases.persistContribution(
            caseId,
            actor,
            contributionInput,
            origin,
          );
          const now = new Date().toISOString();
          const row: FrozenRunRow = {
            id: randomUUID(),
            caseId,
            contributionId: contribution.id,
            sourceId: source.id,
            outputHash,
            outputText: output,
            promptHash,
            promptText,
            promptCompleteness,
            outputCompleteness,
            workflowCompleteness,
            evidenceVisibility,
            snapshotBinding,
            visibilityNote: input.visibilityNote ?? null,
            importerId: actor.id,
            importerUsername: actor.username,
            operatorId: input.operatorId,
            operatorUsername: input.operatorUsername,
            provider: input.provider ?? null,
            model: input.model ?? null,
            version: input.version ?? null,
            claimedTraces: input.claimedTraces ?? [],
            uncertainty: input.uncertainty ?? null,
            timing: input.timing ?? null,
            cost: input.cost ?? null,
            redacted: input.redacted === true,
            privacyClass: privacy,
            createdAt: now,
          };
          await this.runs.insert(row);
          await this.deps.cases.appendDomainTimeline(caseId, {
            kind: "external_run_imported",
            actor,
            targetId: row.id,
            clientTime: null,
            payload: {
              sourceId: source.id,
              outputHash,
              corroborationState: initialCorroborationState(),
              evidenceVisibility,
              snapshotBinding,
            },
          });
          await this.deps.audit.append({
            identity: actor.id,
            action: "external_run_import",
            target: row.id,
            origin,
            outcome: "success",
          });
          if (evidenceBatch) {
            await evidenceBatch.promote();
          } else {
            for (const stage of stages) await stage.commit();
          }
          evidencePromoted = true;
          if (!(await this.deps.evidence.verify(outputHash))) {
            throw new Error("hash verification failed after storage");
          }
          if (promptHash && !(await this.deps.evidence.verify(promptHash))) {
            throw new Error("hash verification failed after storage");
          }
          return this.toRun(row, initialCorroborationState());
        } catch (error) {
          if (memoryRuns && runSnapshot !== undefined) {
            await Promise.resolve(memoryRuns.restore(runSnapshot));
          }
          throw error;
        }
      });
      await finalizeCommittedEvidenceBatch(evidenceBatch);
      return result;
    } catch (error) {
      await settleImportEvidenceFailure(error, evidenceBatch, stages, evidencePromoted);
      throw error;
    } finally {
      for (const stage of stages) stage.release();
    }
  }

  async getRun(
    caseId: string,
    runId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ExternalRunV1 | null> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return null;
    const row = await this.runs.get(runId);
    if (!row || row.caseId !== caseId || !this.canView(row, actor, isAdmin)) return null;
    return this.toRun(row, await this.currentState(runId));
  }

  async listRuns(caseId: string, actor: Actor, isAdmin: boolean): Promise<ExternalRunV1[]> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return [];
    const rows = await this.runs.listByCase(caseId);
    const out: ExternalRunV1[] = [];
    for (const row of rows) {
      if (!this.canView(row, actor, isAdmin)) continue;
      out.push(this.toRun(row, await this.currentState(row.id)));
    }
    return out;
  }

  async corroborate(
    caseId: string,
    runId: string,
    actor: Actor,
    input: {
      state: "corroborated" | "contradicted";
      links: { kind: "artifact" | "contribution"; id: string }[];
    },
    origin: string,
    isAdmin: boolean,
  ): Promise<ExternalRunV1> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new Error("case not found");
    }
    const before = await this.runs.get(runId);
    if (!before || before.caseId !== caseId || !this.canView(before, actor, isAdmin)) {
      throw new Error("run not found");
    }
    if (input.links.length < 1) {
      throw new Error("corroboration must link at least one artifact or contribution");
    }
    const frozen = this.frozenSnapshot(before);
    const memoryRuns = this.runs instanceof MemoryRunStore ? this.runs : null;
    return this.deps.cases.withAtomic(async () => {
      // SQLite wraps every method as async; capture/restore must be awaited
      // or restore receives a Promise and throws DataCloneError.
      const snapshot = memoryRuns ? await Promise.resolve(memoryRuns.capture()) : undefined;
      try {
        await this.runs.appendCorroboration({
          runId,
          state: input.state,
          actorId: actor.id,
          actorUsername: actor.username,
          evidenceLinks: input.links,
        });
        const after = await this.runs.get(runId);
        if (!after) throw new Error("run not found");
        this.assertFrozen(frozen, after);
        await this.deps.cases.appendDomainTimeline(caseId, {
          kind: "run_corroboration",
          actor,
          targetId: runId,
          clientTime: null,
          payload: { state: input.state, links: input.links },
        });
        await this.deps.audit.append({
          identity: actor.id,
          action: "run_corroboration",
          target: `${runId}:${input.state}`,
          origin,
          outcome: "success",
        });
        return this.toRun(after, input.state);
      } catch (error) {
        if (memoryRuns && snapshot !== undefined) {
          await Promise.resolve(memoryRuns.restore(snapshot));
        }
        throw error;
      }
    });
  }

  frozenInputs(row: FrozenRunRow): {
    outputHash: string;
    promptHash: string | null;
    snapshotBinding: string | null;
    outputText: string;
    promptText: string | null;
  } {
    return this.frozenSnapshot(row);
  }

  private frozenSnapshot(row: FrozenRunRow) {
    return {
      outputHash: row.outputHash,
      promptHash: row.promptHash,
      snapshotBinding: row.snapshotBinding,
      outputText: row.outputText,
      promptText: row.promptText,
    };
  }

  private assertFrozen(
    before: ReturnType<ImportService["frozenSnapshot"]>,
    after: FrozenRunRow,
  ): void {
    const now = this.frozenSnapshot(after);
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      throw new Error("imported run inputs are frozen");
    }
  }

  private async currentState(runId: string): Promise<CorroborationState> {
    const events = await this.runs.listCorroborations(runId);
    const latest = events[events.length - 1];
    return latest?.state ?? initialCorroborationState();
  }

  private canView(row: FrozenRunRow, actor: Actor, isAdmin: boolean): boolean {
    return isAdmin || row.privacyClass === "share_safe" || row.importerId === actor.id;
  }

  private toRun(row: FrozenRunRow, corroborationState: CorroborationState): ExternalRunV1 {
    return {
      schemaId: EXTERNAL_RUN_SCHEMA_ID,
      id: row.id,
      caseId: row.caseId,
      contributionId: row.contributionId,
      sourceId: row.sourceId,
      outputHash: row.outputHash,
      outputText: row.outputText,
      promptHash: row.promptHash,
      promptText: row.promptText,
      promptCompleteness: row.promptCompleteness,
      outputCompleteness: row.outputCompleteness,
      workflowCompleteness: row.workflowCompleteness,
      evidenceVisibility: row.evidenceVisibility,
      snapshotBinding: row.snapshotBinding,
      visibilityNote: row.visibilityNote,
      importerId: row.importerId,
      importerUsername: row.importerUsername,
      operatorId: row.operatorId,
      operatorUsername: row.operatorUsername,
      provider: row.provider,
      model: row.model,
      version: row.version,
      claimedTraces: [...row.claimedTraces],
      uncertainty: row.uncertainty,
      timing: row.timing,
      cost: row.cost,
      redacted: row.redacted,
      privacyClass: row.privacyClass,
      corroborationState,
      createdAt: row.createdAt,
    };
  }
}

export type { Completeness, EvidenceVisibility };
