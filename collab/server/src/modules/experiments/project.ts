import {
  ContractViolation,
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
  type ShareSafeSnapshotProofV2,
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
  snapshotProof: Omit<ShareSafeSnapshotProofV2, "parentSnapshotAlias">;
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

function compareAlias(a: string, b: string): number {
  return a.localeCompare(b);
}

function uniqueSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => id.length > 0).sort(compareAlias);
}

function sortedAliases(values: string[]): string[] {
  return [...values].sort(compareAlias);
}

function throwViolation(path: string, detail: string): never {
  throw new ContractViolation(path, detail);
}

function assertSame(path: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throwViolation(path, "identity does not match the exported experiment");
  }
}

function assertUniqueIds(path: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (!id) throwViolation(`${path}[${index}]`, "id must not be empty");
    if (seen.has(id)) throwViolation(`${path}[${index}]`, "duplicate id");
    seen.add(id);
  }
}

function knownCandidateIds(view: ReviewExportSource): Set<string> {
  return new Set(view.candidates.map((candidate) => candidate.candidateId));
}

function knownEvidenceIds(view: ReviewExportSource): Set<string> {
  const ids = new Set<string>();
  for (const anchor of view.agreement.sharedAnchors) ids.add(anchor.evidenceRef);
  for (const row of view.agreement.candidateSpecific) {
    for (const ref of row.evidenceRefs) ids.add(ref);
  }
  for (const conflict of view.agreement.roleConflicts) ids.add(conflict.evidenceRef);
  for (const trace of view.traces) {
    for (const event of trace.events) {
      for (const ref of event.evidenceRefs) ids.add(ref);
    }
  }
  return ids;
}

function collectEvidenceIds(view: ReviewExportSource): string[] {
  const ids: string[] = [...knownEvidenceIds(view)];
  for (const observation of view.observations) ids.push(...observation.evidenceRefs);
  for (const decision of view.decisions) ids.push(...decision.evidenceRefs);
  if (view.gold) {
    ids.push(...view.gold.evidenceAnchors);
    for (const row of view.gold.expectedRelationships ?? []) ids.push(row.evidenceRef);
  }
  for (const gold of view.golds) {
    ids.push(...gold.evidenceAnchors);
    for (const row of gold.expectedRelationships ?? []) ids.push(row.evidenceRef);
  }
  for (const alignment of view.alignments) {
    ids.push(
      ...alignment.matchedAnchors,
      ...alignment.missingAnchors,
      ...alignment.extraAnchors,
    );
    for (const row of alignment.roleMismatches) ids.push(row.evidenceRef);
  }
  for (const row of view.comparison.sharedEvidence) ids.push(row.evidenceRef);
  for (const row of view.comparison.uniqueEvidence) ids.push(...row.evidenceRefs);
  for (const row of view.comparison.discoveryOrder) ids.push(row.evidenceRef);
  for (const row of view.comparison.roleConflicts) ids.push(row.evidenceRef);
  for (const row of view.comparison.convergence) ids.push(row.evidenceRef);
  return uniqueSorted(ids);
}

function collectRoleIds(view: ReviewExportSource): string[] {
  const ids: string[] = [];
  for (const anchor of view.agreement.sharedAnchors) ids.push(anchor.role);
  for (const conflict of view.agreement.roleConflicts) {
    for (const assignment of conflict.assignments) ids.push(assignment.role);
  }
  for (const row of view.gold?.expectedRelationships ?? []) ids.push(row.role);
  for (const gold of view.golds) {
    for (const row of gold.expectedRelationships ?? []) ids.push(row.role);
  }
  for (const alignment of view.alignments) {
    for (const row of alignment.roleMismatches) ids.push(row.role);
  }
  for (const trace of view.traces) {
    for (const event of trace.events) {
      if (event.role) ids.push(event.role);
    }
  }
  for (const conflict of view.comparison.roleConflicts) {
    for (const assignment of conflict.assignments) ids.push(assignment.role);
  }
  return uniqueSorted(ids);
}

function assertKnownCandidate(path: string, id: string, known: ReadonlySet<string>): void {
  if (!known.has(id)) throwViolation(path, "unknown candidate id");
}

function assertKnownEvidence(path: string, id: string, known: ReadonlySet<string>): void {
  if (!known.has(id)) throwViolation(path, "dangling evidence ref");
}

function assertDecisionChain(path: string, decision: ExperimentDecisionV1): void {
  if (decision.revision < 1) throwViolation(`${path}.revision`, "must be >= 1");
  if (decision.revision === 1) {
    if (decision.predecessorRevision !== null) {
      throwViolation(`${path}.predecessorRevision`, "revision 1 must not name a predecessor");
    }
    return;
  }
  if (decision.predecessorRevision !== decision.revision - 1) {
    throwViolation(`${path}.predecessorRevision`, "must be the immediate predecessor revision");
  }
}

function goldProjectionIdentity(gold: GoldReferenceV1): string {
  return JSON.stringify({
    version: gold.version,
    predecessorGoldId: gold.predecessorGoldId,
    acceptedDecisionId: gold.acceptedDecisionId,
    acceptedDecisionRevision: gold.acceptedDecisionRevision,
    evidenceAnchors: uniqueSorted(gold.evidenceAnchors),
    expectedRelationships: [...(gold.expectedRelationships ?? [])]
      .map((row) => ({ evidenceRef: row.evidenceRef, role: row.role }))
      .sort(
        (a, b) =>
          a.evidenceRef.localeCompare(b.evidenceRef) || a.role.localeCompare(b.role),
      ),
    helpfulnessDimensions: uniqueSorted(gold.helpfulnessDimensions ?? []),
  });
}

function assertExportIntegrity(view: ReviewExportSource): void {
  if (
    !view.snapshotProof ||
    typeof view.snapshotProof.basis !== "string" ||
    typeof view.snapshotProof.fairnessClass !== "string" ||
    typeof view.snapshotProof.lineageClass !== "string"
  ) {
    throwViolation("$.snapshotProof", "host snapshot proof is required");
  }
  if (view.candidates.length === 0) {
    throwViolation("$.candidates", "at least one candidate is required");
  }
  assertUniqueIds(
    "$.candidates",
    view.candidates.map((candidate) => candidate.candidateId),
  );
  assertUniqueIds(
    "$.observations",
    view.observations.map((observation) => observation.id),
  );
  assertUniqueIds(
    "$.golds",
    view.golds.map((gold) => gold.goldId),
  );
  assertUniqueIds(
    "$.traces",
    view.traces.map((trace) => trace.traceId),
  );
  assertUniqueIds(
    "$.traces.events",
    view.traces.flatMap((trace) => trace.events.map((event) => event.eventId)),
  );

  const candidates = knownCandidateIds(view);
  const evidence = knownEvidenceIds(view);
  const goldById = new Map(view.golds.map((gold) => [gold.goldId, gold]));

  const experimentIds = [
    ...view.decisions.map((decision) => decision.experimentId),
    ...view.observations.map((observation) => observation.experimentId),
    ...view.golds.map((gold) => gold.experimentId),
    ...(view.gold ? [view.gold.experimentId] : []),
  ];
  const experimentId = experimentIds[0];
  for (const [index, id] of experimentIds.entries()) {
    if (experimentId !== undefined) assertSame(`$.experimentId[${index}]`, id, experimentId);
  }

  assertSame("$.comparison.packageId", view.comparison.packageId, view.packageId);
  for (const [index, decision] of view.decisions.entries()) {
    assertSame(`$.decisions[${index}].packageId`, decision.packageId, view.packageId);
    assertDecisionChain(`$.decisions[${index}]`, decision);
    for (const [refIndex, ref] of decision.evidenceRefs.entries()) {
      assertKnownEvidence(`$.decisions[${index}].evidenceRefs[${refIndex}]`, ref, evidence);
    }
  }
  for (const [index, observation] of view.observations.entries()) {
    assertKnownCandidate(
      `$.observations[${index}].candidateId`,
      observation.candidateId,
      candidates,
    );
    for (const [refIndex, ref] of observation.evidenceRefs.entries()) {
      assertKnownEvidence(`$.observations[${index}].evidenceRefs[${refIndex}]`, ref, evidence);
    }
  }
  for (const [index, anchor] of view.agreement.sharedAnchors.entries()) {
    assertKnownEvidence(`$.agreement.sharedAnchors[${index}].evidenceRef`, anchor.evidenceRef, evidence);
    for (const [candIndex, id] of anchor.candidateIds.entries()) {
      assertKnownCandidate(
        `$.agreement.sharedAnchors[${index}].candidateIds[${candIndex}]`,
        id,
        candidates,
      );
    }
  }
  for (const [index, row] of view.agreement.candidateSpecific.entries()) {
    assertKnownCandidate(
      `$.agreement.candidateSpecific[${index}].candidateId`,
      row.candidateId,
      candidates,
    );
    for (const [refIndex, ref] of row.evidenceRefs.entries()) {
      assertKnownEvidence(
        `$.agreement.candidateSpecific[${index}].evidenceRefs[${refIndex}]`,
        ref,
        evidence,
      );
    }
  }
  for (const [index, conflict] of view.agreement.roleConflicts.entries()) {
    assertKnownEvidence(
      `$.agreement.roleConflicts[${index}].evidenceRef`,
      conflict.evidenceRef,
      evidence,
    );
    for (const [assignmentIndex, assignment] of conflict.assignments.entries()) {
      assertKnownCandidate(
        `$.agreement.roleConflicts[${index}].assignments[${assignmentIndex}].candidateId`,
        assignment.candidateId,
        candidates,
      );
    }
  }
  for (const [index, trace] of view.traces.entries()) {
    assertKnownCandidate(`$.traces[${index}].candidateId`, trace.candidateId, candidates);
    for (const [eventIndex, event] of trace.events.entries()) {
      for (const [refIndex, ref] of event.evidenceRefs.entries()) {
        assertKnownEvidence(
          `$.traces[${index}].events[${eventIndex}].evidenceRefs[${refIndex}]`,
          ref,
          evidence,
        );
      }
    }
  }
  for (const [index, alignment] of view.alignments.entries()) {
    assertKnownCandidate(`$.alignments[${index}].candidateId`, alignment.candidateId, candidates);
    const refs = [
      ...alignment.matchedAnchors,
      ...alignment.missingAnchors,
      ...alignment.extraAnchors,
      ...alignment.roleMismatches.map((row) => row.evidenceRef),
    ];
    for (const [refIndex, ref] of refs.entries()) {
      assertKnownEvidence(`$.alignments[${index}].evidence[${refIndex}]`, ref, evidence);
    }
  }

  const acceptedRows = view.decisions.filter((decision) => decision.status === "accepted");
  const acceptedIds = new Set(acceptedRows.map((decision) => decision.id));
  if (acceptedIds.size > 1) {
    throwViolation("$.decisions", "multiple accepted decision identities");
  }
  const accepted =
    [...acceptedRows].sort((a, b) => a.revision - b.revision).at(-1) ??
    null;

  for (const [index, gold] of view.golds.entries()) {
    const path = `$.golds[${index}]`;
    assertSame(`${path}.packageId`, gold.packageId, view.packageId);
    assertSame(`${path}.taskFingerprint`, gold.taskFingerprint, view.taskFingerprint);
    assertSame(`${path}.snapshotFingerprint`, gold.snapshotFingerprint, view.snapshotFingerprint);
    if (gold.version === 1 && gold.predecessorGoldId !== null) {
      throwViolation(`${path}.predecessorGoldId`, "version 1 must not name a predecessor");
    }
    if (gold.version > 1) {
      if (!gold.predecessorGoldId) {
        throwViolation(`${path}.predecessorGoldId`, "version > 1 requires a predecessor");
      } else if (!goldById.has(gold.predecessorGoldId)) {
        throwViolation(`${path}.predecessorGoldId`, "dangling gold predecessor");
      } else if (gold.predecessorGoldId === gold.goldId) {
        throwViolation(`${path}.predecessorGoldId`, "cannot name the current gold");
      }
    }
    for (const [refIndex, ref] of gold.evidenceAnchors.entries()) {
      assertKnownEvidence(`${path}.evidenceAnchors[${refIndex}]`, ref, evidence);
    }
  }

  if (view.gold) {
    const historicalGold = goldById.get(view.gold.goldId);
    if (!historicalGold) {
      throwViolation("$.gold.goldId", "exported gold is missing from gold history");
    }
    if (goldProjectionIdentity(view.gold) !== goldProjectionIdentity(historicalGold)) {
      throwViolation("$.gold", "selected gold does not match its history row");
    }
    assertSame("$.gold.packageId", view.gold.packageId, view.packageId);
    assertSame("$.gold.taskFingerprint", view.gold.taskFingerprint, view.taskFingerprint);
    assertSame("$.gold.snapshotFingerprint", view.gold.snapshotFingerprint, view.snapshotFingerprint);
    if (!accepted || view.gold.acceptedDecisionId !== accepted.id) {
      throwViolation("$.gold.acceptedDecisionId", "must name the exported accepted decision");
    }
    if (view.gold.acceptedDecisionRevision !== accepted.revision) {
      throwViolation(
        "$.gold.acceptedDecisionRevision",
        "must match the exported accepted decision revision",
      );
    }
  }
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
  // Candidate aliases follow the stored matrix order so existing package-order
  // exports keep approach-1 on the first candidate. Other namespaces are seeded
  // from sorted unique ids so equivalent bag reorders stay deterministic.
  view.candidates.forEach((candidate) => aliases.candidates.for(candidate.candidateId));
  for (const id of uniqueSorted(view.observations.map((observation) => observation.id))) {
    aliases.observations.for(id);
  }
  for (const decision of [...view.decisions].sort(
    (a, b) => a.revision - b.revision || a.id.localeCompare(b.id),
  )) {
    aliases.decisions.for(decision.id);
  }
  for (const gold of [...view.golds].sort(
    (a, b) => a.version - b.version || a.goldId.localeCompare(b.goldId),
  )) {
    aliases.golds.for(gold.goldId);
  }
  for (const id of collectEvidenceIds(view)) aliases.evidence.for(id);
  for (const id of collectRoleIds(view)) aliases.roles.for(id);
  for (const trace of [...view.traces].sort((a, b) => a.traceId.localeCompare(b.traceId))) {
    aliases.traces.for(trace.traceId);
    for (const event of [...trace.events].sort(
      (a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId),
    )) {
      aliases.events.for(event.eventId);
    }
  }
  for (const id of uniqueSorted(view.comparison.questionPaths.map((path) => path.pathId))) {
    aliases.questions.for(id);
  }
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
  const sharedAnchors = agreement.sharedAnchors.map((anchor) => ({
    evidenceAlias: aliases.evidence.for(anchor.evidenceRef),
    roleAlias: aliases.roles.for(anchor.role),
    candidateAliases: sortedAliases(anchor.candidateIds.map((id) => aliases.candidates.for(id))),
  }));
  const candidateSpecific = agreement.candidateSpecific.map((row) => ({
    candidateAlias: aliases.candidates.for(row.candidateId),
    evidenceAliases: sortedAliases(row.evidenceRefs.map((ref) => aliases.evidence.for(ref))),
  }));
  const roleConflicts = agreement.roleConflicts.map((conflict) => ({
    evidenceAlias: aliases.evidence.for(conflict.evidenceRef),
    assignments: [...conflict.assignments]
      .map((assignment) => ({
        candidateAlias: aliases.candidates.for(assignment.candidateId),
        roleAlias: aliases.roles.for(assignment.role),
      }))
      .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
  }));
  return {
    sharedAnchors: [...sharedAnchors].sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
    candidateSpecific: [...candidateSpecific].sort((a, b) =>
      compareAlias(a.candidateAlias, b.candidateAlias),
    ),
    roleConflicts: [...roleConflicts].sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
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
    events: [...trace.events]
      .sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))
      .map((event) => ({
        eventAlias: aliases.events.for(event.eventId),
        sequence: event.sequence,
        kind: event.kind,
        actor: event.actor,
        roleAlias: event.role ? aliases.roles.for(event.role) : null,
        parentEventAlias: event.parentEventId ? aliases.events.for(event.parentEventId) : null,
        evidenceAliases: sortedAliases(event.evidenceRefs.map((ref) => aliases.evidence.for(ref))),
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
    questionPaths: [...comparison.questionPaths]
      .map((path) => ({
        pathAlias: aliases.questions.for(path.pathId),
        candidateAliases: sortedAliases(path.candidateIds.map((id) => aliases.candidates.for(id))),
        eventAliases: sortedAliases(path.eventIds.map((id) => aliases.events.for(id))),
      }))
      .sort((a, b) => compareAlias(a.pathAlias, b.pathAlias)),
    sharedEvidence: [...comparison.sharedEvidence]
      .map((row) => ({
        evidenceAlias: aliases.evidence.for(row.evidenceRef),
        candidateAliases: sortedAliases(row.candidateIds.map((id) => aliases.candidates.for(id))),
        firstSequence: [...row.firstSequence]
          .map((first) => ({
            candidateAlias: aliases.candidates.for(first.candidateId),
            sequence: first.sequence,
          }))
          .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
      }))
      .sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
    uniqueEvidence: [...comparison.uniqueEvidence]
      .map((row) => ({
        candidateAlias: aliases.candidates.for(row.candidateId),
        evidenceAliases: sortedAliases(row.evidenceRefs.map((ref) => aliases.evidence.for(ref))),
      }))
      .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
    discoveryOrder: [...comparison.discoveryOrder]
      .map((row) => ({
        evidenceAlias: aliases.evidence.for(row.evidenceRef),
        candidateAlias: aliases.candidates.for(row.candidateId),
        sequence: row.sequence,
      }))
      .sort(
        (a, b) =>
          a.sequence - b.sequence ||
          compareAlias(a.candidateAlias, b.candidateAlias) ||
          compareAlias(a.evidenceAlias, b.evidenceAlias),
      ),
    roleConflicts: [...comparison.roleConflicts]
      .map((conflict) => ({
        evidenceAlias: aliases.evidence.for(conflict.evidenceRef),
        assignments: [...conflict.assignments]
          .map((assignment) => ({
            candidateAlias: aliases.candidates.for(assignment.candidateId),
            roleAlias: aliases.roles.for(assignment.role),
          }))
          .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
      }))
      .sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
    convergence: [...comparison.convergence]
      .map((row) => ({
        evidenceAlias: aliases.evidence.for(row.evidenceRef),
        candidateAliases: sortedAliases(row.candidateIds.map((id) => aliases.candidates.for(id))),
        inGold: row.inGold,
      }))
      .sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
    divergence: [...comparison.divergence]
      .map((row) => ({
        kind: row.kind,
        candidateAliases: sortedAliases(row.candidateIds.map((id) => aliases.candidates.for(id))),
      }))
      .sort(
        (a, b) => a.kind.localeCompare(b.kind) || compareAlias(a.candidateAliases[0] ?? "", b.candidateAliases[0] ?? ""),
      ),
    efficiency: [...comparison.efficiency]
      .map((row) => ({
        candidateAlias: aliases.candidates.for(row.candidateId),
        efficiency: projectEfficiency(row.efficiency),
      }))
      .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
    gold: {
      status: comparison.gold.status,
      version: comparison.gold.version,
      acceptedDecisionAlias: comparison.gold.acceptedDecisionId
        ? aliases.decisions.for(comparison.gold.acceptedDecisionId)
        : null,
    },
    helpfulness: [...comparison.helpfulness]
      .map((row) => ({
        candidateAlias: aliases.candidates.for(row.candidateId),
        state: row.state,
      }))
      .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
    caveats: [...LAB_SHARE_SAFE_CAVEATS],
  };
}

export function projectExperimentLabExport(view: ReviewExportSource): ExperimentLabExportV2 {
  assertExportIntegrity(view);
  const aliases = createAliases(view);
  const accepted =
    [...view.decisions]
      .filter((decision) => decision.status === "accepted")
      .sort((a, b) => a.revision - b.revision)
      .at(-1) ?? null;
  const payload: ExperimentLabExportV2 = {
    schemaId: LAB_EXPORT_V2_SCHEMA_ID,
    privacyClass: "share_safe",
    review: {
      schemaId: EXPERIMENT_REVIEW_EXPORT_V2_SCHEMA_ID,
      privacyClass: "share_safe",
      packageAlias: aliases.packageAlias,
      taskAlias: "task-1",
      snapshotAlias: "snapshot-1",
      snapshotProof: {
        ...view.snapshotProof,
        parentSnapshotAlias:
          view.snapshotProof.lineageClass === "derived" ? "snapshot-parent-1" : null,
      },
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
      observations: [...view.observations]
        .map((observation) => ({
          observationAlias: aliases.observations.for(observation.id),
          candidateAlias: aliases.candidates.for(observation.candidateId),
          dimension: observation.dimension,
          score: observation.score,
          evidenceAliases: sortedAliases(
            observation.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
          ),
        }))
        .sort((a, b) => compareAlias(a.observationAlias, b.observationAlias)),
      decision: accepted
        ? {
            decisionAlias: aliases.decisions.for(accepted.id),
            status: accepted.status,
            revision: accepted.revision,
            predecessorRevision: accepted.predecessorRevision,
            evidenceAliases: sortedAliases(
              accepted.evidenceRefs.map((ref) => aliases.evidence.for(ref)),
            ),
            ownerState:
              accepted.ownerId && accepted.ownerUsername ? "assigned" : "unassigned",
            remainingUnknownCount: (accepted.remainingUnknowns ?? []).length,
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
            evidenceAliases: sortedAliases(
              view.gold.evidenceAnchors.map((ref) => aliases.evidence.for(ref)),
            ),
            expectedRelationships: [...(view.gold.expectedRelationships ?? [])]
              .map((row) => ({
                evidenceAlias: aliases.evidence.for(row.evidenceRef),
                roleAlias: aliases.roles.for(row.role),
              }))
              .sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
            helpfulnessDimensions: (view.gold.helpfulnessDimensions ?? [])
              .filter((dimension): dimension is HelpfulnessDimension =>
                (HELPFULNESS_DIMENSIONS as readonly string[]).includes(dimension),
              )
              .slice()
              .sort(compareAlias),
          }
        : null,
      alignments: [...view.alignments]
        .map((alignment) => ({
          candidateAlias: aliases.candidates.for(alignment.candidateId),
          status: alignment.status,
          matchedEvidenceAliases: sortedAliases(
            alignment.matchedAnchors.map((ref) => aliases.evidence.for(ref)),
          ),
          missingEvidenceAliases: sortedAliases(
            alignment.missingAnchors.map((ref) => aliases.evidence.for(ref)),
          ),
          extraEvidenceAliases: sortedAliases(
            alignment.extraAnchors.map((ref) => aliases.evidence.for(ref)),
          ),
          roleMismatches: [...alignment.roleMismatches]
            .map((row) => ({
              evidenceAlias: aliases.evidence.for(row.evidenceRef),
              roleAlias: aliases.roles.for(row.role),
            }))
            .sort((a, b) => compareAlias(a.evidenceAlias, b.evidenceAlias)),
        }))
        .sort((a, b) => compareAlias(a.candidateAlias, b.candidateAlias)),
      omissions: {
        modelLabelsIncluded: false,
        participantIdentitiesIncluded: false,
        freeTextIncluded: false,
        privateContentIncluded: false,
        correlatableMetadataIncluded: false,
      },
      caveats: [...EXPERIMENT_SHARE_SAFE_CAVEATS],
    },
    traces: [...view.traces]
      .map((trace) => projectTrace(trace, aliases))
      .sort((a, b) => compareAlias(a.traceAlias, b.traceAlias)),
    comparison: projectComparison(view.comparison, aliases),
  };

  // This is the final recursive gate over the complete assembled export.
  return parseLabExportV2(payload);
}

/** Legacy call-site name; the returned wire contract is intentionally the safe v2 review. */
export function projectReviewExport(view: ReviewExportSource): ExperimentLabExportV2["review"] {
  return projectExperimentLabExport(view).review;
}
