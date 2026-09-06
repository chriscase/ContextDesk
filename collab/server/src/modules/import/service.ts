import { createHash, randomUUID } from "node:crypto";
import {
  EXTERNAL_RUN_IMPORT_IDEMPOTENCY,
  EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
  EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID,
  EXTERNAL_RUN_SCHEMA_ID,
  IMPORTABLE_SOURCE_KINDS,
  parseExternalRunImportRefused,
  parseExternalRunImportSuccess,
  type Completeness,
  type ContributionV1,
  type CorroborationState,
  type EvidenceVisibility,
  type ExternalRunImportRefusal,
  type ExternalRunImportRefusedV1,
  type ExternalRunImportRequestV1,
  type ExternalRunImportSuccessV1,
  type ExternalRunV1,
  type PrivacyClass,
  type SourceV1,
} from "@cd-collab/contracts";
import type { EvidenceStage, EvidenceStore, EvidenceWriteBatch } from "../../evidence/store.js";
import type { AuditStore } from "../audit/index.js";
import { projectSourceForCaller, type CatalogService } from "../catalog/index.js";
import { CaseStoreCommitOutcomeUnknownError, type Actor, type CaseService } from "../cases/index.js";
import { defaultPrivacy } from "../contributions/index.js";
import { assertUploadAllowed } from "../evidence/index.js";
import {
  completenessOrUnknown,
  hashRunBytes,
  initialCorroborationState,
  visibilityOrUnknown,
} from "./model.js";
import {
  MemoryRunStore,
  type ExternalRunImportSuccessIntent,
  type FrozenRunRow,
  type RunStore,
} from "./store.js";

export class ExternalRunImportRefusedError extends Error {
  constructor(readonly body: ExternalRunImportRefusedV1) {
    super(body.reason);
    this.name = "ExternalRunImportRefusedError";
  }
}

export class ExternalRunImportNotFoundError extends Error {
  constructor() {
    super("strict external run import target not found");
    this.name = "ExternalRunImportNotFoundError";
  }
}

function strictImportIntentDigest(request: ExternalRunImportRequestV1): string {
  const intent = { ...request } as Record<string, unknown>;
  for (const field of EXTERNAL_RUN_IMPORT_IDEMPOTENCY.excludesFromIntent) {
    delete intent[field];
  }
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

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

  async importRunStrict(
    routeCaseId: string,
    actor: Actor,
    request: ExternalRunImportRequestV1,
    origin: string,
    isAdmin: boolean,
    access: { canReadPrivate: boolean; canSeeDirectoryIdentities: boolean },
  ): Promise<ExternalRunImportSuccessV1> {
    const digest = strictImportIntentDigest(request);
    const outputBytes = new TextEncoder().encode(request.outputText);
    const outputHash = hashRunBytes(outputBytes);
    const promptBytes = request.promptText === null
      ? null
      : new TextEncoder().encode(request.promptText);
    const promptHash = promptBytes === null ? null : hashRunBytes(promptBytes);
    const stages: EvidenceStage[] = [];
    let evidenceBatch: EvidenceWriteBatch | null = null;
    let evidencePromoted = false;
    const memoryRuns = this.runs instanceof MemoryRunStore ? this.runs : null;

    try {
      const result = await this.deps.cases.withAtomic(async () => {
        const runSnapshot = memoryRuns ? await Promise.resolve(memoryRuns.capture()) : undefined;
        try {
          const lockedCase = await this.deps.cases.lockVisibleCaseForImport(
            routeCaseId,
            actor,
            isAdmin,
          );
          if (!lockedCase) throw new ExternalRunImportNotFoundError();

          const prior = await this.runs.lockImportSuccessIntent(
            routeCaseId,
            actor.id,
            request.idempotencyKey,
          );
          if (prior) return await this.replayStrictImport(prior, request, digest, actor);

          if (lockedCase.status === "archived") {
            throw this.strictRefusal(
              request,
              "case_archived",
              "Archived investigations cannot accept imported runs.",
              null,
            );
          }

          return await this.deps.catalog.inspectLockedSourceForImport(
            request.sourceId,
            async (source) => {
              if (!source) throw new ExternalRunImportNotFoundError();
              const projectedSource = projectSourceForCaller(
                source,
                access.canSeeDirectoryIdentities,
              );
              if (source.revision === undefined) {
                throw this.strictRefusal(
                  request,
                  "source_not_versioned",
                  "This source has no revision and cannot be used for a strict import.",
                  projectedSource,
                );
              }
              if (source.lifecycle === "retired") {
                throw this.strictRefusal(
                  request,
                  "source_retired",
                  "This source is retired and cannot accept new attribution.",
                  projectedSource,
                );
              }
              if (source.revision !== request.expectedSourceRevision) {
                throw this.strictRefusal(
                  request,
                  "source_revision_mismatch",
                  "The recorded source revision does not match expectedSourceRevision.",
                  projectedSource,
                );
              }
              if (!(IMPORTABLE_SOURCE_KINDS as readonly string[]).includes(source.kind)) {
                throw this.strictRefusal(
                  request,
                  "source_kind_not_importable",
                  "This source kind cannot be used for an external-run import.",
                  projectedSource,
                );
              }

              const evidence = await this.deps.cases.validateExternalRunImportEvidence({
                caseId: routeCaseId,
                evidenceArtifactIds: request.evidenceArtifactIds,
                snapshotBinding: request.snapshotBinding,
                privacyClass: request.privacyClass,
                canReadPrivate: access.canReadPrivate,
              });
              if (evidence === "not_found") throw new ExternalRunImportNotFoundError();
              if (evidence === "privacy_mismatch") {
                throw this.strictRefusal(
                  request,
                  "privacy_mismatch",
                  "Share-safe imports cannot cite owner-only evidence or snapshots.",
                  null,
                );
              }

              evidenceBatch = await this.deps.evidence.beginWriteBatch?.() ?? null;
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
                const outputStage = await this.deps.evidence.stage(outputBytes, {
                  contentType: "text/plain",
                });
                stages.push(outputStage);
                if (outputStage.meta.hash !== outputHash) {
                  throw new Error("hash verification failed after storage");
                }
                if (promptBytes && promptHash) {
                  const promptStage = await this.deps.evidence.stage(promptBytes, {
                    contentType: "text/plain",
                  });
                  stages.push(promptStage);
                  if (promptStage.meta.hash !== promptHash) {
                    throw new Error("hash verification failed after storage");
                  }
                }
              }

              const contribution = await this.deps.cases.persistContribution(
                routeCaseId,
                actor,
                {
                  kind: "external_run",
                  body: `Imported external run (${outputHash.slice(0, 12)})`,
                  privacyClass: request.privacyClass,
                  sourceId: source.id,
                  ...(request.clientTime === undefined ? {} : { clientTime: request.clientTime }),
                },
                origin,
              );
              const now = new Date().toISOString();
              const operator = request.operator ?? {
                identityId: actor.id,
                username: actor.username,
              };
              const row: FrozenRunRow = {
                id: randomUUID(),
                caseId: routeCaseId,
                contributionId: contribution.id,
                sourceId: source.id,
                outputHash,
                outputText: request.outputText,
                promptHash,
                promptText: request.promptText,
                promptCompleteness: request.promptCompleteness,
                outputCompleteness: request.outputCompleteness,
                workflowCompleteness: request.workflowCompleteness,
                evidenceVisibility: request.evidenceVisibility,
                snapshotBinding: request.snapshotBinding,
                visibilityNote: request.visibilityNote,
                importerId: actor.id,
                importerUsername: actor.username,
                operatorId: operator.identityId,
                operatorUsername: operator.username,
                provider: request.provider,
                model: request.model,
                version: request.version,
                claimedTraces: [...request.claimedTraces],
                uncertainty: request.uncertainty,
                timing: request.timing,
                cost: request.cost,
                redacted: request.redacted,
                privacyClass: request.privacyClass,
                createdAt: now,
                importMode: "manual",
                sourceRevision: source.revision,
                evidenceArtifactIds: [...request.evidenceArtifactIds],
              };
              await this.runs.insert(row);
              await this.deps.cases.appendDomainTimeline(routeCaseId, {
                kind: "external_run_imported",
                actor,
                targetId: row.id,
                clientTime: request.clientTime ?? null,
                payload: {
                  sourceId: source.id,
                  sourceRevision: source.revision,
                  outputHash,
                  corroborationState: initialCorroborationState(),
                  evidenceVisibility: request.evidenceVisibility,
                  evidenceArtifactIds: request.evidenceArtifactIds,
                  snapshotBinding: request.snapshotBinding,
                  privacyClass: request.privacyClass,
                },
              });
              await this.deps.audit.append({
                identity: actor.id,
                action: "external_run_import",
                target: row.id,
                origin,
                outcome: "success",
              });

              const success = this.strictSuccess(request, row, contribution, false);
              await this.runs.insertImportSuccessIntent({
                caseId: routeCaseId,
                actorId: actor.id,
                idempotencyKey: request.idempotencyKey,
                requestDigest: digest,
                runId: row.id,
                successJson: JSON.stringify(success),
                createdAt: now,
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
              return success;
            },
          );
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

  private async replayStrictImport(
    prior: ExternalRunImportSuccessIntent,
    request: ExternalRunImportRequestV1,
    digest: string,
    actor: Actor,
  ): Promise<ExternalRunImportSuccessV1> {
    if (prior.requestDigest !== digest) {
      throw this.strictRefusal(
        request,
        "idempotency_intent_mismatch",
        "This idempotency key was already used with a different import intent.",
        null,
      );
    }
    let original: ExternalRunImportSuccessV1;
    try {
      original = parseExternalRunImportSuccess(JSON.parse(prior.successJson) as unknown);
    } catch {
      throw new Error("external run import success intent is corrupt");
    }
    const row = await this.runs.get(prior.runId);
    if (
      prior.caseId !== request.caseId
      || prior.actorId !== actor.id
      || prior.idempotencyKey !== request.idempotencyKey
      || original.caseId !== prior.caseId
      || original.applied.id !== prior.runId
      || original.applied.importerId !== prior.actorId
      || !row
      || row.id !== prior.runId
      || row.caseId !== prior.caseId
      || row.contributionId !== original.contribution.id
      || row.sourceId !== original.sourceId
      || row.sourceRevision !== original.applied.sourceRevision
      || JSON.stringify(this.toRun(row, initialCorroborationState()))
        !== JSON.stringify(original.applied)
    ) {
      throw new Error("external run import success intent is incoherent");
    }
    return parseExternalRunImportSuccess({ ...original, replayed: true });
  }

  private strictSuccess(
    request: ExternalRunImportRequestV1,
    row: FrozenRunRow,
    contribution: ContributionV1,
    replayed: boolean,
  ): ExternalRunImportSuccessV1 {
    return parseExternalRunImportSuccess({
      schemaId: EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID,
      importMode: "manual",
      caseId: row.caseId,
      sourceId: row.sourceId,
      expectedSourceRevision: request.expectedSourceRevision,
      replayed,
      applied: this.toRun(row, initialCorroborationState()),
      contribution,
    });
  }

  private strictRefusal(
    request: ExternalRunImportRequestV1,
    reason: ExternalRunImportRefusal,
    detail: string,
    current: SourceV1 | null,
  ): ExternalRunImportRefusedError {
    return new ExternalRunImportRefusedError(
      parseExternalRunImportRefused({
        schemaId: EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
        error: "external_run_import_refused",
        importMode: "manual",
        caseId: request.caseId,
        sourceId: request.sourceId,
        expectedSourceRevision: request.expectedSourceRevision,
        reason,
        detail,
        current,
      }),
    );
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
    const run: ExternalRunV1 = {
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
    if (
      row.importMode !== undefined
      && row.sourceRevision !== undefined
      && row.evidenceArtifactIds !== undefined
    ) {
      run.importMode = row.importMode;
      run.sourceRevision = row.sourceRevision;
      run.evidenceArtifactIds = [...row.evidenceArtifactIds];
    }
    return run;
  }
}

export type { Completeness, EvidenceVisibility };
