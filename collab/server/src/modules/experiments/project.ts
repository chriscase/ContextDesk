import {
  EXPERIMENT_REVIEW_EXPORT_V2_SCHEMA_ID,
  EXPERIMENT_SHARE_SAFE_CAVEATS,
  HELPFULNESS_DIMENSIONS,
  LAB_EXPORT_V2_SCHEMA_ID,
  LAB_SHARE_SAFE_CAVEATS,
  SHARE_SAFE_INTERACTION_TRACE_V2_SCHEMA_ID,
  STRATEGY_COMPARISON_V2_SCHEMA_ID,
  TRACE_SHARE_SAFE_CAVEATS,
  parseLabExportV2,
  projectShareSafeUnknowns,
  type CandidateGoldAlignmentV1,
  type ExperimentAgreementV1,
  type ExperimentCandidateV1,
  type ExperimentDecisionV1,
  type ExperimentLabExportV2,
  type GoldReferenceV1,
  type HelpfulnessObservationV1,
  type HelpfulnessDimension,
  type InteractionTraceV1,
  type ObservedCountV1,
  type ShareSafeExperimentAgreementV2,
  type ShareSafeInteractionTraceV2,
  type ShareSafeStrategyComparisonV2,
  type StrategyComparisonV1,
  type TraceEfficiencyV1,
} from "@cd-collab/contracts";

export interface ReviewExportSource {
  packageId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1;
  observations: HelpfulnessObservationV1[];
  decisions: ExperimentDecisionV1[];
  gold: GoldReferenceV1 | null;
  golds: GoldReferenceV1[];
  alignments: CandidateGoldAlignmentV1[];
  traces: InteractionTraceV1[];
  comparison: StrategyComparisonV1;
}

class AliasTable {
  private readonly aliases = new Map<string, string>();

  constructor(private readonly prefix: string) {}

  for(raw: string): string {
    const existing = this.aliases.get(raw);
    if (existing) return existing;
    const alias = `${this.prefix}-${this.aliases.size + 1}`;
    this.aliases.set(raw, alias);
    return alias;
  }
}

interface ExportAliases {
  packageAlias: string;
  candidates: AliasTable;
  evidence: AliasTable;
  roles: AliasTable;
  observations: AliasTable;
  decisions: AliasTable;
  golds: AliasTable;
  traces: AliasTable;
  events: AliasTable;
  questions: AliasTable;
}

function createAliases(view: ReviewExportSource): ExportAliases {
  const aliases: ExportAliases = {
    packageAlias: "package-1",
    candidates: new AliasTable("approach"),
    evidence: new AliasTable("evidence"),
    roles: new AliasTable("role"),
    observations: new AliasTable("observation"),
    decisions: new AliasTable("decision"),
    golds: new AliasTable("gold"),
    traces: new AliasTable("trace"),
    events: new AliasTable("event"),
    questions: new AliasTable("question"),
  };
  view.candidates.forEach((candidate) => aliases.candidates.for(candidate.candidateId));
  view.observations.forEach((observation) => aliases.observations.for(observation.id));
  view.decisions.forEach((decision) => aliases.decisions.for(decision.id));
  view.golds.forEach((gold) => aliases.golds.for(gold.goldId));
  view.traces.forEach((trace) => {
    aliases.traces.for(trace.traceId);
    trace.events.forEach((event) => aliases.events.for(event.eventId));
  });
  view.comparison.questionPaths.forEach((path) => aliases.questions.for(path.pathId));
  return aliases;
}

export function projectCandidateMatrix(
  candidates: ExperimentCandidateV1[],
  goldPresent = false,
): ExperimentCandidateV1[] {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    modelLabel: candidate.modelLabel,
    role: candidate.role,
    runStatus: candidate.runStatus,
    observedLatency: candidate.observedLatency,
    cost: { status: "unknown" },
    usage: { status: "unknown" },
    helpfulnessState: candidate.helpfulnessState,
    goldState: goldPresent
      ? "present"
      : candidate.goldState === "absent"
        ? "absent"
        : "unknown",
  }));
}

function projectAgreement(
  agreement: ExperimentAgreementV1,
  aliases: ExportAliases,
): ShareSafeExperimentAgreementV2 {
  return {
    sharedAnchors: agreement.sharedAnchors.map((anchor) => ({
      evidenceAlias: aliases.evidence.for(anchor.evidenceRef),
      roleAlias: aliases.roles.for(anchor.role),
      candidateAliases: anchor.candidateIds.map((id) => aliases.candidates.for(id)),
    })),
    candidateSpecific: agreement.candidateSpecific.map((row) => ({
      candidateAlias: aliases.candidates.for(row.candidateId),
      evidenceAliases: row.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
    })),
    roleConflicts: agreement.roleConflicts.map((conflict) => ({
      evidenceAlias: aliases.evidence.for(conflict.evidenceRef),
      assignments: conflict.assignments.map((assignment) => ({
        candidateAlias: aliases.candidates.for(assignment.candidateId),
        roleAlias: aliases.roles.for(assignment.role),
      })),
    })),
  };
}

function projectCount(value: ObservedCountV1): ObservedCountV1 {
  return value.status === "observed"
    ? { status: "observed", count: value.count }
    : { status: "unknown" };
}

function projectLatency(): { status: "unknown" } {
  return { status: "unknown" };
}

function projectEfficiency(value: TraceEfficiencyV1): TraceEfficiencyV1 {
  return {
    turnCount: projectCount(value.turnCount),
    evidenceAcquisitionSteps: projectCount(value.evidenceAcquisitionSteps),
    latency: projectLatency(),
    cost: { status: "unknown" },
    providerCalls: projectCount(value.providerCalls),
  };
}

function projectTrace(
  trace: InteractionTraceV1,
  aliases: ExportAliases,
): ShareSafeInteractionTraceV2 {
  return {
    schemaId: SHARE_SAFE_INTERACTION_TRACE_V2_SCHEMA_ID,
    traceAlias: aliases.traces.for(trace.traceId),
    candidateAlias: aliases.candidates.for(trace.candidateId),
    sourceKind: trace.sourceKind,
    completeness: trace.completeness,
    privacyClass: "share_safe",
    events: trace.events.map((event) => ({
      eventAlias: aliases.events.for(event.eventId),
      sequence: event.sequence,
      kind: event.kind,
      actor: event.actor,
      roleAlias: event.role ? aliases.roles.for(event.role) : null,
      parentEventAlias: event.parentEventId ? aliases.events.for(event.parentEventId) : null,
      evidenceAliases: event.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
      unknowns: projectShareSafeUnknowns(event.unknowns),
    })),
    efficiency: projectEfficiency(trace.efficiency),
    unknowns: projectShareSafeUnknowns(trace.unknowns),
    excerptsIncluded: false,
    caveats: [...TRACE_SHARE_SAFE_CAVEATS],
  };
}

function projectComparison(
  comparison: StrategyComparisonV1,
  aliases: ExportAliases,
): ShareSafeStrategyComparisonV2 {
  return {
    schemaId: STRATEGY_COMPARISON_V2_SCHEMA_ID,
    packageAlias: aliases.packageAlias,
    questionPaths: comparison.questionPaths.map((path) => ({
      pathAlias: aliases.questions.for(path.pathId),
      candidateAliases: path.candidateIds.map((id) => aliases.candidates.for(id)),
      eventAliases: path.eventIds.map((id) => aliases.events.for(id)),
    })),
    sharedEvidence: comparison.sharedEvidence.map((row) => ({
      evidenceAlias: aliases.evidence.for(row.evidenceRef),
      candidateAliases: row.candidateIds.map((id) => aliases.candidates.for(id)),
      firstSequence: row.firstSequence.map((first) => ({
        candidateAlias: aliases.candidates.for(first.candidateId),
        sequence: first.sequence,
      })),
    })),
    uniqueEvidence: comparison.uniqueEvidence.map((row) => ({
      candidateAlias: aliases.candidates.for(row.candidateId),
      evidenceAliases: row.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
    })),
    discoveryOrder: comparison.discoveryOrder.map((row) => ({
      evidenceAlias: aliases.evidence.for(row.evidenceRef),
      candidateAlias: aliases.candidates.for(row.candidateId),
      sequence: row.sequence,
    })),
    roleConflicts: comparison.roleConflicts.map((conflict) => ({
      evidenceAlias: aliases.evidence.for(conflict.evidenceRef),
      assignments: conflict.assignments.map((assignment) => ({
        candidateAlias: aliases.candidates.for(assignment.candidateId),
        roleAlias: aliases.roles.for(assignment.role),
      })),
    })),
    convergence: comparison.convergence.map((row) => ({
      evidenceAlias: aliases.evidence.for(row.evidenceRef),
      candidateAliases: row.candidateIds.map((id) => aliases.candidates.for(id)),
      inGold: row.inGold,
    })),
    divergence: comparison.divergence.map((row) => ({
      kind: row.kind,
      candidateAliases: row.candidateIds.map((id) => aliases.candidates.for(id)),
    })),
    efficiency: comparison.efficiency.map((row) => ({
      candidateAlias: aliases.candidates.for(row.candidateId),
      efficiency: projectEfficiency(row.efficiency),
    })),
    gold: {
      status: comparison.gold.status,
      version: comparison.gold.version,
      acceptedDecisionAlias: comparison.gold.acceptedDecisionId
        ? aliases.decisions.for(comparison.gold.acceptedDecisionId)
        : null,
    },
    helpfulness: comparison.helpfulness.map((row) => ({
      candidateAlias: aliases.candidates.for(row.candidateId),
      state: row.state,
    })),
    caveats: [...LAB_SHARE_SAFE_CAVEATS],
  };
}

export function projectExperimentLabExport(view: ReviewExportSource): ExperimentLabExportV2 {
  const aliases = createAliases(view);
  const accepted = [...view.decisions]
    .reverse()
    .find((decision) => decision.status === "accepted") ?? null;
  const payload: ExperimentLabExportV2 = {
    schemaId: LAB_EXPORT_V2_SCHEMA_ID,
    privacyClass: "share_safe",
    review: {
      schemaId: EXPERIMENT_REVIEW_EXPORT_V2_SCHEMA_ID,
      privacyClass: "share_safe",
      packageAlias: aliases.packageAlias,
      taskAlias: "task-1",
      snapshotAlias: "snapshot-1",
      candidates: view.candidates.map((candidate) => ({
        candidateAlias: aliases.candidates.for(candidate.candidateId),
        role: candidate.role,
        runStatus: candidate.runStatus,
        observedLatency: projectLatency(),
        cost: { status: "unknown" },
        usage: { status: "unknown" },
        helpfulnessState: candidate.helpfulnessState,
        goldState: candidate.goldState,
      })),
      agreement: projectAgreement(view.agreement, aliases),
      observations: view.observations.map((observation) => ({
        observationAlias: aliases.observations.for(observation.id),
        candidateAlias: aliases.candidates.for(observation.candidateId),
        dimension: observation.dimension,
        score: observation.score,
        evidenceAliases: observation.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
      })),
      decision: accepted
        ? {
            decisionAlias: aliases.decisions.for(accepted.id),
            status: accepted.status,
            revision: accepted.revision,
            predecessorRevision: accepted.predecessorRevision,
            evidenceAliases: accepted.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
          }
        : null,
      gold: view.gold
        ? {
            goldAlias: aliases.golds.for(view.gold.goldId),
            version: view.gold.version,
            predecessorGoldAlias: view.gold.predecessorGoldId
              ? aliases.golds.for(view.gold.predecessorGoldId)
              : null,
            acceptedDecisionAlias: aliases.decisions.for(view.gold.acceptedDecisionId),
            acceptedDecisionRevision: view.gold.acceptedDecisionRevision,
            evidenceAliases: view.gold.evidenceAnchors.map((ref) => aliases.evidence.for(ref)),
            expectedRelationships: (view.gold.expectedRelationships ?? []).map((row) => ({
              evidenceAlias: aliases.evidence.for(row.evidenceRef),
              roleAlias: aliases.roles.for(row.role),
            })),
            helpfulnessDimensions: (view.gold.helpfulnessDimensions ?? []).filter(
              (dimension): dimension is HelpfulnessDimension =>
                (HELPFULNESS_DIMENSIONS as readonly string[]).includes(dimension),
            ),
          }
        : null,
      alignments: view.alignments.map((alignment) => ({
        candidateAlias: aliases.candidates.for(alignment.candidateId),
        status: alignment.status,
        matchedEvidenceAliases: alignment.matchedAnchors.map((ref) => aliases.evidence.for(ref)),
        missingEvidenceAliases: alignment.missingAnchors.map((ref) => aliases.evidence.for(ref)),
        extraEvidenceAliases: alignment.extraAnchors.map((ref) => aliases.evidence.for(ref)),
        roleMismatches: alignment.roleMismatches.map((row) => ({
          evidenceAlias: aliases.evidence.for(row.evidenceRef),
          roleAlias: aliases.roles.for(row.role),
        })),
      })),
      omissions: {
        modelLabelsIncluded: false,
        participantIdentitiesIncluded: false,
        freeTextIncluded: false,
        privateContentIncluded: false,
        correlatableMetadataIncluded: false,
      },
      caveats: [...EXPERIMENT_SHARE_SAFE_CAVEATS],
    },
    traces: view.traces.map((trace) => projectTrace(trace, aliases)),
    comparison: projectComparison(view.comparison, aliases),
  };

  // This is the final recursive gate over the complete assembled export.
  return parseLabExportV2(payload);
}

/** Legacy call-site name; the returned wire contract is intentionally the safe v2 review. */
export function projectReviewExport(view: ReviewExportSource): ExperimentLabExportV2["review"] {
  return projectExperimentLabExport(view).review;
}
