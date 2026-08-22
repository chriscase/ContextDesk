import {
  ContractViolation,
  EXPERIMENT_DECISION_SCHEMA_ID,
  EXPERIMENT_SHARE_SAFE_CAVEATS,
  GOLD_ALIGNMENT_NOT_CORRECTNESS,
  GOLD_ALIGNMENT_SCHEMA_ID,
  GOLD_IS_HUMAN_BENCHMARK,
  GOLD_REFERENCE_SCHEMA_ID,
  HELPFULNESS_OBSERVATION_SCHEMA_ID,
  INTERACTION_TRACE_SCHEMA_ID,
  LAB_SHARE_SAFE_CAVEATS,
  TRACE_SHARE_SAFE_CAVEATS,
  TRACE_UNKNOWN_STAYS_UNKNOWN,
  buildStrategyComparison,
  parseLabExportV2,
  type ExperimentCandidateV1,
  type ExperimentDecisionV1,
  type ExperimentLabExportV2,
  type GoldReferenceV1,
  type HelpfulnessObservationV1,
  type InteractionTraceV1,
  type TraceEfficiencyV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  projectExperimentLabExport,
  type ReviewExportSource,
} from "./project.js";

const TASK_FP = `task-${"a1b2c3d4".repeat(8)}`;
const SNAP_FP = `snap-${"b2c3d4e5".repeat(8)}`;
const FOREIGN_TASK_FP = `task-${"c3d4e5f6".repeat(8)}`;
const FOREIGN_SNAP_FP = `snap-${"d4e5f6a7".repeat(8)}`;

const IDS = {
  pkg: "xid-pkg-heldout-ee55",
  exp: "xid-exp-heldout-ff66",
  case: "xid-case-heldout-aa11",
  foreignPkg: "xid-pkg-foreign-zz99",
  foreignExp: "xid-exp-foreign-yy88",
  candNimbus: "xid-cand-nimbus-aa11",
  candOrion: "xid-cand-orion-bb22",
  evVelvet: "xid-ev-velvet-cc33",
  evQuartz: "xid-ev-quartz-dd44",
  evDangling: "xid-ev-dangle-dead",
  decAccepted: "xid-dec-heldout-aa00",
  decNoise: "xid-dec-noise-proposed",
  gold: "xid-gold-heldout-bb00",
  goldPred: "xid-gold-pred-cc11",
  goldDangling: "xid-gold-dangle-dead",
  obs: "xid-obs-heldout-cc00",
  traceNimbus: "xid-trace-nimbus-dd00",
  traceOrion: "xid-trace-orion-ee00",
  eventNimbusQ: "xid-event-nimbus-q",
  eventNimbusA: "xid-event-nimbus-a",
  eventOrionQ: "xid-event-orion-q",
  eventOrionA: "xid-event-orion-a",
  shared: "xid-shared-ns-token",
} as const;

const LEAK = {
  model: "grok-heldout-private-label",
  username: "user-nile-vault",
  reviewer: "user-heldout-reviewer",
  freeText: "Keep the heldout vault sealed.",
  rationale: "request_id=req-heldout991188 belongs to the sealed vault.",
  endpoint: "https://heldout-gateway.example/v1",
  token: "sk-heldoutzz9token",
  path: "/opt/heldout/vault/secret.txt",
  requestId: "req-heldout991188",
  privateContent: "PRIVATE-HELD-OUT-BODY",
  bearer: "Bearer heldout-secret-value",
  hostname: "db09.heldout.internal.test",
  createdAt: "2026-08-22T04:05:06.789Z",
  rawHash: "e".repeat(64),
  excerptHash: "f".repeat(64),
} as const;

const LEAK_TOKENS = [
  LEAK.model,
  LEAK.username,
  LEAK.reviewer,
  LEAK.freeText,
  LEAK.rationale,
  LEAK.endpoint,
  LEAK.token,
  LEAK.path,
  LEAK.requestId,
  LEAK.privateContent,
  LEAK.bearer,
  LEAK.hostname,
  LEAK.createdAt,
  LEAK.rawHash,
  LEAK.excerptHash,
  IDS.pkg,
  IDS.exp,
  IDS.case,
  IDS.candNimbus,
  IDS.candOrion,
  IDS.evVelvet,
  IDS.evQuartz,
  IDS.decAccepted,
  IDS.decNoise,
  IDS.gold,
  IDS.goldPred,
  IDS.obs,
  IDS.traceNimbus,
  IDS.traceOrion,
  IDS.eventNimbusQ,
  IDS.eventNimbusA,
  IDS.eventOrionQ,
  IDS.eventOrionA,
  TASK_FP,
  SNAP_FP,
  '"modelLabel"',
  '"reviewerUsername"',
  '"authorUsername"',
  '"promotedByUsername"',
  '"rationale"',
  '"excerpt"',
  '"notes"',
  '"taskFingerprint"',
  '"snapshotFingerprint"',
  '"rawHash"',
  '"excerptHash"',
  '"createdAt"',
  '"milliseconds"',
] as const;

const OMISSIONS = {
  modelLabelsIncluded: false,
  participantIdentitiesIncluded: false,
  freeTextIncluded: false,
  privateContentIncluded: false,
  correlatableMetadataIncluded: false,
} as const;

function efficiency(): TraceEfficiencyV1 {
  return {
    turnCount: { status: "observed", count: 2 },
    evidenceAcquisitionSteps: { status: "observed", count: 1 },
    latency: { status: "observed", milliseconds: 4400 },
    cost: { status: "unknown" },
    providerCalls: { status: "observed", count: 1 },
  };
}

function candidate(
  candidateId: string,
  role: ExperimentCandidateV1["role"],
): ExperimentCandidateV1 {
  return {
    candidateId,
    modelLabel: LEAK.model,
    role,
    runStatus: "completed",
    observedLatency: { status: "observed", milliseconds: 4400 },
    cost: { status: "unknown" },
    usage: { status: "unknown" },
    helpfulnessState: candidateId === IDS.candNimbus ? "observed" : "unreviewed",
    goldState: "present",
  };
}

function decision(
  partial: Partial<ExperimentDecisionV1> &
    Pick<ExperimentDecisionV1, "id" | "status" | "revision" | "predecessorRevision">,
): ExperimentDecisionV1 {
  return {
    schemaId: EXPERIMENT_DECISION_SCHEMA_ID,
    experimentId: IDS.exp,
    text: LEAK.freeText,
    rationale: LEAK.rationale,
    evidenceRefs: [IDS.evVelvet, IDS.evQuartz],
    packageId: IDS.pkg,
    authorId: "xid-author-heldout",
    authorUsername: LEAK.username,
    createdAt: LEAK.createdAt,
    ...partial,
  };
}

function observation(): HelpfulnessObservationV1 {
  return {
    schemaId: HELPFULNESS_OBSERVATION_SCHEMA_ID,
    id: IDS.obs,
    experimentId: IDS.exp,
    candidateId: IDS.candNimbus,
    dimension: "evidence_support",
    score: 2,
    rationale: `${LEAK.freeText} ${LEAK.path}`,
    evidenceRefs: [IDS.evVelvet],
    reviewerId: "xid-reviewer-heldout",
    reviewerUsername: LEAK.reviewer,
    createdAt: LEAK.createdAt,
  };
}

function gold(partial: Partial<GoldReferenceV1> = {}): GoldReferenceV1 {
  return {
    schemaId: GOLD_REFERENCE_SCHEMA_ID,
    goldId: IDS.gold,
    version: 1,
    predecessorGoldId: null,
    caseId: IDS.case,
    experimentId: IDS.exp,
    packageId: IDS.pkg,
    taskFingerprint: TASK_FP,
    snapshotFingerprint: SNAP_FP,
    acceptedDecisionId: IDS.decAccepted,
    acceptedDecisionRevision: 2,
    auditRefs: [`experiment_gold_promote:${IDS.gold}:1`],
    evidenceAnchors: [IDS.evVelvet, IDS.evQuartz],
    expectedRelationships: [
      { evidenceRef: IDS.evVelvet, role: "symptom" },
      { evidenceRef: IDS.evQuartz, role: "cause" },
    ],
    helpfulnessDimensions: ["evidence_support"],
    notes: [GOLD_IS_HUMAN_BENCHMARK, LEAK.privateContent, LEAK.hostname],
    promotedById: "xid-promoter-heldout",
    promotedByUsername: LEAK.username,
    createdAt: LEAK.createdAt,
    ...partial,
  };
}

function trace(
  traceId: string,
  candidateId: string,
  events: InteractionTraceV1["events"],
): InteractionTraceV1 {
  return {
    schemaId: INTERACTION_TRACE_SCHEMA_ID,
    traceId,
    candidateId,
    sourceKind: "programmatic",
    completeness: "exact",
    privacyClass: "share_safe",
    rawHash: LEAK.rawHash,
    events,
    efficiency: efficiency(),
    unknowns: ["timestamp"],
    notes: [TRACE_UNKNOWN_STAYS_UNKNOWN, LEAK.endpoint, LEAK.bearer],
    createdAt: LEAK.createdAt,
  };
}

function event(
  eventId: string,
  sequence: number,
  kind: InteractionTraceV1["events"][number]["kind"],
  evidenceRefs: string[],
  parentEventId: string | null,
): InteractionTraceV1["events"][number] {
  return {
    eventId,
    sequence,
    kind,
    actor: kind === "question" ? "human" : "assistant",
    role: null,
    parentEventId,
    evidenceRefs,
    observedAt: { status: "observed", timestamp: LEAK.createdAt },
    excerpt: `${LEAK.freeText} ${LEAK.token}`,
    excerptHash: LEAK.excerptHash,
    unknowns: ["timestamp"],
  };
}

function opaqueSource(): ReviewExportSource {
  const candidates = [candidate(IDS.candNimbus, "contributor"), candidate(IDS.candOrion, "finalizer")];
  const agreement = {
    sharedAnchors: [
      {
        evidenceRef: IDS.evVelvet,
        role: "symptom",
        candidateIds: [IDS.candNimbus, IDS.candOrion],
      },
    ],
    candidateSpecific: [
      { candidateId: IDS.candNimbus, evidenceRefs: [IDS.evQuartz] },
      { candidateId: IDS.candOrion, evidenceRefs: [] },
    ],
    roleConflicts: [
      {
        evidenceRef: IDS.evQuartz,
        assignments: [
          { candidateId: IDS.candNimbus, role: "cause" },
          { candidateId: IDS.candOrion, role: "symptom" },
        ],
      },
    ],
    notes: ["Agreement is not proof of correctness.", LEAK.privateContent],
  };
  const traces = [
    trace(IDS.traceNimbus, IDS.candNimbus, [
      event(IDS.eventNimbusQ, 1, "question", [], null),
      event(IDS.eventNimbusA, 2, "assistant_response", [IDS.evVelvet, IDS.evQuartz], IDS.eventNimbusQ),
    ]),
    trace(IDS.traceOrion, IDS.candOrion, [
      event(IDS.eventOrionQ, 1, "question", [], null),
      event(IDS.eventOrionA, 2, "assistant_response", [IDS.evVelvet], IDS.eventOrionQ),
    ]),
  ];
  const goldRow = gold();
  const decisions = [
    decision({
      id: IDS.decNoise,
      status: "proposed",
      revision: 1,
      predecessorRevision: null,
      evidenceRefs: [IDS.evVelvet],
    }),
    decision({
      id: IDS.decAccepted,
      status: "proposed",
      revision: 1,
      predecessorRevision: null,
    }),
    decision({
      id: IDS.decAccepted,
      status: "accepted",
      revision: 2,
      predecessorRevision: 1,
    }),
  ];
  const source: Omit<ReviewExportSource, "comparison"> = {
    packageId: IDS.pkg,
    taskFingerprint: TASK_FP,
    snapshotFingerprint: SNAP_FP,
    candidates,
    agreement,
    observations: [observation()],
    decisions,
    gold: goldRow,
    golds: [goldRow],
    alignments: [
      {
        schemaId: GOLD_ALIGNMENT_SCHEMA_ID,
        candidateId: IDS.candNimbus,
        status: "aligned",
        matchedAnchors: [IDS.evVelvet, IDS.evQuartz],
        missingAnchors: [],
        extraAnchors: [],
        roleMismatches: [],
        notes: [GOLD_ALIGNMENT_NOT_CORRECTNESS, LEAK.freeText],
      },
      {
        schemaId: GOLD_ALIGNMENT_SCHEMA_ID,
        candidateId: IDS.candOrion,
        status: "partial",
        matchedAnchors: [IDS.evVelvet],
        missingAnchors: [IDS.evQuartz],
        extraAnchors: [],
        roleMismatches: [],
        notes: [GOLD_ALIGNMENT_NOT_CORRECTNESS],
      },
    ],
    traces,
  };
  return {
    ...source,
    comparison: buildStrategyComparison({
      packageId: source.packageId,
      candidates: source.candidates,
      traces: source.traces,
      agreement: source.agreement,
      gold: source.gold,
    }),
  };
}

function reverseBags(source: ReviewExportSource): ReviewExportSource {
  const clone = structuredClone(source);
  clone.agreement.sharedAnchors.reverse();
  for (const anchor of clone.agreement.sharedAnchors) anchor.candidateIds.reverse();
  clone.agreement.candidateSpecific.reverse();
  for (const row of clone.agreement.candidateSpecific) row.evidenceRefs.reverse();
  clone.agreement.roleConflicts.reverse();
  for (const conflict of clone.agreement.roleConflicts) conflict.assignments.reverse();
  clone.observations.reverse();
  clone.decisions.reverse();
  clone.golds.reverse();
  clone.alignments.reverse();
  clone.traces.reverse();
  for (const row of clone.traces) {
    row.events.reverse();
    for (const item of row.events) item.evidenceRefs.reverse();
  }
  if (clone.gold) {
    clone.gold.evidenceAnchors.reverse();
    clone.gold.expectedRelationships = [...(clone.gold.expectedRelationships ?? [])].reverse();
    clone.gold.helpfulnessDimensions = [...(clone.gold.helpfulnessDimensions ?? [])].reverse();
  }
  clone.comparison.questionPaths.reverse();
  for (const path of clone.comparison.questionPaths) {
    path.candidateIds.reverse();
    path.eventIds.reverse();
  }
  clone.comparison.sharedEvidence.reverse();
  for (const row of clone.comparison.sharedEvidence) {
    row.candidateIds.reverse();
    row.firstSequence.reverse();
  }
  clone.comparison.uniqueEvidence.reverse();
  for (const row of clone.comparison.uniqueEvidence) row.evidenceRefs.reverse();
  clone.comparison.discoveryOrder.reverse();
  clone.comparison.roleConflicts.reverse();
  for (const conflict of clone.comparison.roleConflicts) conflict.assignments.reverse();
  clone.comparison.convergence.reverse();
  for (const row of clone.comparison.convergence) row.candidateIds.reverse();
  clone.comparison.divergence.reverse();
  for (const row of clone.comparison.divergence) row.candidateIds.reverse();
  clone.comparison.efficiency.reverse();
  clone.comparison.helpfulness.reverse();
  return clone;
}

function assertNoLeaks(exported: ExperimentLabExportV2): void {
  const encoded = JSON.stringify(exported);
  for (const token of LEAK_TOKENS) {
    expect(encoded, `leaked ${token}`).not.toContain(token);
  }
}

function assertShareSafeExact(exported: ExperimentLabExportV2): void {
  expect(exported.review.decision?.status).toBe("accepted");
  expect(exported.review.gold?.acceptedDecisionAlias).toBe(
    exported.review.decision?.decisionAlias,
  );
  expect(exported.review.gold?.acceptedDecisionRevision).toBe(
    exported.review.decision?.revision,
  );
  expect(exported.review.caveats).toEqual([...EXPERIMENT_SHARE_SAFE_CAVEATS]);
  expect(exported.comparison.caveats).toEqual([...LAB_SHARE_SAFE_CAVEATS]);
  expect(exported.review.omissions).toEqual(OMISSIONS);
  expect(
    exported.traces.every(
      (row) => JSON.stringify(row.caveats) === JSON.stringify([...TRACE_SHARE_SAFE_CAVEATS]),
    ),
  ).toBe(true);
  expect(exported.review.packageAlias).toBe("package-1");
  expect(exported.review.taskAlias).toBe("task-1");
  expect(exported.review.snapshotAlias).toBe("snapshot-1");
  expect(exported.comparison.packageAlias).toBe(exported.review.packageAlias);
  assertNoLeaks(exported);
}

type ProjectionRow = {
  name: string;
  apply: (source: ReviewExportSource) => ReviewExportSource;
  expect: "export" | "reject";
  prove?: (exported: ExperimentLabExportV2) => void;
};

type TamperRow = {
  name: string;
  apply: (assembled: ExperimentLabExportV2) => unknown;
};

const PROJECTION_MATRIX: ProjectionRow[] = [
  {
    name: "proposed_only_omits_decision_and_gold",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.decisions = clone.decisions.filter((row) => row.status === "proposed");
      clone.gold = null;
      clone.golds = [];
      clone.candidates = clone.candidates.map((row) => ({ ...row, goldState: "unknown" }));
      clone.alignments = clone.alignments.map((row) => ({
        ...row,
        status: "unknown",
        matchedAnchors: [],
        missingAnchors: [],
        extraAnchors: [],
        roleMismatches: [],
      }));
      clone.comparison = buildStrategyComparison({
        packageId: clone.packageId,
        candidates: clone.candidates,
        traces: clone.traces,
        agreement: clone.agreement,
        gold: null,
      });
      return clone;
    },
    expect: "export",
    prove: (exported) => {
      expect(exported.review.decision).toBeNull();
      expect(exported.review.gold).toBeNull();
      expect(exported.comparison.gold.status).not.toBe("present");
      assertNoLeaks(exported);
    },
  },
  {
    name: "mixed_proposed_and_accepted_exports_only_accepted",
    apply: (source) => source,
    expect: "export",
    prove: (exported) => {
      expect(exported.review.decision?.status).toBe("accepted");
      expect(JSON.stringify(exported)).not.toContain(IDS.decNoise);
      assertShareSafeExact(exported);
    },
  },
  {
    name: "equivalent_reorder_candidates_evidence_decisions_traces",
    apply: (source) => reverseBags(source),
    expect: "export",
    prove: (exported) => {
      const baseline = projectExperimentLabExport(opaqueSource());
      expect(JSON.stringify(exported)).toBe(JSON.stringify(baseline));
      assertShareSafeExact(exported);
    },
  },
  {
    name: "identical_raw_ids_across_namespaces_do_not_collide",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.candidates[0] = { ...clone.candidates[0]!, candidateId: IDS.shared };
      clone.agreement.sharedAnchors[0] = {
        ...clone.agreement.sharedAnchors[0]!,
        candidateIds: [IDS.shared, IDS.candOrion],
      };
      clone.agreement.sharedAnchors[0]!.evidenceRef = IDS.shared;
      clone.agreement.roleConflicts[0] = {
        evidenceRef: IDS.shared,
        assignments: [
          { candidateId: IDS.shared, role: "cause" },
          { candidateId: IDS.candOrion, role: "symptom" },
        ],
      };
      clone.observations[0] = { ...clone.observations[0]!, candidateId: IDS.shared, evidenceRefs: [IDS.shared] };
      clone.decisions = clone.decisions.map((row) => ({
        ...row,
        evidenceRefs: [IDS.shared],
      }));
      clone.agreement.candidateSpecific = [
        { candidateId: IDS.shared, evidenceRefs: [IDS.shared] },
        { candidateId: IDS.candOrion, evidenceRefs: [IDS.shared] },
      ];
      clone.gold = gold({
        evidenceAnchors: [IDS.shared],
        expectedRelationships: [{ evidenceRef: IDS.shared, role: "symptom" }],
      });
      clone.golds = [clone.gold];
      clone.alignments[0] = {
        ...clone.alignments[0]!,
        candidateId: IDS.shared,
        matchedAnchors: [IDS.shared],
        missingAnchors: [],
      };
      clone.alignments = clone.alignments.map((row, index) => ({
        ...row,
        candidateId: index === 0 ? IDS.shared : IDS.candOrion,
        status: "aligned",
        matchedAnchors: [IDS.shared],
        missingAnchors: [],
        extraAnchors: [],
        roleMismatches: [],
      }));
      clone.traces = clone.traces.map((row, index) => ({
        ...row,
        candidateId: index === 0 ? IDS.shared : row.candidateId,
        events: row.events.map((item) => ({
          ...item,
          evidenceRefs: item.evidenceRefs.length > 0 ? [IDS.shared] : [],
        })),
      }));
      clone.comparison = buildStrategyComparison({
        packageId: clone.packageId,
        candidates: clone.candidates,
        traces: clone.traces,
        agreement: clone.agreement,
        gold: clone.gold,
      });
      return clone;
    },
    expect: "export",
    prove: (exported) => {
      const encoded = JSON.stringify(exported);
      expect(encoded).not.toContain(IDS.shared);
      const nimbus = exported.review.candidates[0];
      const velvet = exported.review.agreement.sharedAnchors[0];
      expect(nimbus?.candidateAlias).toMatch(/^approach-[1-9][0-9]*$/);
      expect(velvet?.evidenceAlias).toMatch(/^evidence-[1-9][0-9]*$/);
      expect(nimbus?.candidateAlias).not.toBe(velvet?.evidenceAlias);
      expect(exported.review.decision?.decisionAlias).not.toBe(nimbus?.candidateAlias);
      expect(exported.review.gold?.goldAlias).not.toBe(exported.review.decision?.decisionAlias);
      assertShareSafeExact(exported);
    },
  },
  {
    name: "dishonest_predecessor_revision",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.decisions = clone.decisions.map((row) =>
        row.status === "accepted" ? { ...row, predecessorRevision: 99 } : row,
      );
      return clone;
    },
    expect: "reject",
  },
  {
    name: "gold_points_at_wrong_decision",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = { ...clone.gold!, acceptedDecisionId: IDS.decNoise };
      clone.golds = [clone.gold];
      clone.comparison = {
        ...clone.comparison,
        gold: { ...clone.comparison.gold, acceptedDecisionId: IDS.decNoise },
      };
      return clone;
    },
    expect: "reject",
  },
  {
    name: "gold_points_at_wrong_revision",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = { ...clone.gold!, acceptedDecisionRevision: 1 };
      clone.golds = [clone.gold];
      return clone;
    },
    expect: "reject",
  },
  {
    name: "crossed_package_identity",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = { ...clone.gold!, packageId: IDS.foreignPkg };
      clone.golds = [clone.gold];
      return clone;
    },
    expect: "reject",
  },
  {
    name: "crossed_task_fingerprint",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = { ...clone.gold!, taskFingerprint: FOREIGN_TASK_FP };
      clone.golds = [clone.gold];
      return clone;
    },
    expect: "reject",
  },
  {
    name: "crossed_snapshot_fingerprint",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = { ...clone.gold!, snapshotFingerprint: FOREIGN_SNAP_FP };
      clone.golds = [clone.gold];
      return clone;
    },
    expect: "reject",
  },
  {
    name: "crossed_experiment_identity",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.decisions = clone.decisions.map((row) => ({ ...row, experimentId: IDS.foreignExp }));
      return clone;
    },
    expect: "reject",
  },
  {
    name: "stale_gold_predecessor",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = gold({
        version: 2,
        predecessorGoldId: IDS.goldDangling,
      });
      clone.golds = [clone.gold];
      clone.comparison = {
        ...clone.comparison,
        gold: { ...clone.comparison.gold, version: 2 },
      };
      return clone;
    },
    expect: "reject",
  },
  {
    name: "selected_gold_disagrees_with_same_id_history_row",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = gold({
        version: 2,
        predecessorGoldId: IDS.goldDangling,
      });
      clone.comparison = {
        ...clone.comparison,
        gold: { ...clone.comparison.gold, version: 2 },
      };
      // Keep clone.golds unchanged: the selected pointer reuses the same goldId
      // while disagreeing with the authoritative history row.
      return clone;
    },
    expect: "reject",
  },
  {
    name: "contradictory_comparison_gold",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.comparison = {
        ...clone.comparison,
        gold: {
          status: "present",
          version: 9,
          acceptedDecisionId: clone.gold!.acceptedDecisionId,
        },
      };
      return clone;
    },
    expect: "reject",
  },
  {
    name: "duplicate_candidate_ids",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.candidates = [clone.candidates[0]!, { ...clone.candidates[1]!, candidateId: IDS.candNimbus }];
      return clone;
    },
    expect: "reject",
  },
  {
    name: "missing_accepted_decision_for_gold",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.decisions = clone.decisions.filter((row) => row.status !== "accepted");
      return clone;
    },
    expect: "reject",
  },
  {
    name: "dangling_gold_evidence",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.gold = {
        ...clone.gold!,
        evidenceAnchors: [IDS.evVelvet, IDS.evDangling],
        expectedRelationships: [
          { evidenceRef: IDS.evVelvet, role: "symptom" },
          { evidenceRef: IDS.evDangling, role: "cause" },
        ],
      };
      clone.golds = [clone.gold];
      return clone;
    },
    expect: "reject",
  },
  {
    name: "dangling_trace_candidate",
    apply: (source) => {
      const clone = structuredClone(source);
      clone.traces[0] = { ...clone.traces[0]!, candidateId: "xid-cand-missing-zz00" };
      return clone;
    },
    expect: "reject",
  },
];

const TAMPER_MATRIX: TamperRow[] = [
  {
    name: "unknown_top_level_field",
    apply: (assembled) => ({ ...assembled, heldoutExtra: true }),
  },
  {
    name: "unknown_review_field",
    apply: (assembled) => ({
      ...assembled,
      review: { ...assembled.review, heldoutExtra: true },
    }),
  },
  {
    name: "tampered_schema_id",
    apply: (assembled) => ({
      ...assembled,
      schemaId: "cd-collab.experiment_lab_export.v1",
    }),
  },
  {
    name: "tampered_omissions",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        omissions: { ...assembled.review.omissions, modelLabelsIncluded: true },
      },
    }),
  },
  {
    name: "tampered_caveats_missing",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        caveats: assembled.review.caveats.slice(1),
      },
    }),
  },
  {
    name: "tampered_caveats_duplicate",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        caveats: [...assembled.review.caveats, assembled.review.caveats[0]],
      },
    }),
  },
  {
    name: "tampered_gold_revision",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        gold: assembled.review.gold
          ? { ...assembled.review.gold, acceptedDecisionRevision: 99 }
          : null,
      },
    }),
  },
  {
    name: "tampered_gold_decision_alias",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        gold: assembled.review.gold
          ? { ...assembled.review.gold, acceptedDecisionAlias: "decision-9" }
          : null,
      },
    }),
  },
  {
    name: "planted_leak_string",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        packageAlias: LEAK.endpoint,
      },
    }),
  },
  {
    name: "planted_forbidden_key",
    apply: (assembled) => ({
      ...assembled,
      review: {
        ...assembled.review,
        apiKey: LEAK.token,
      },
    }),
  },
];

describe("share-safe accepted-human-decision export adversarial lab", () => {
  it("projects only the accepted human decision through the shipped parser", () => {
    const exported = projectExperimentLabExport(opaqueSource());
    const roundTrip = parseLabExportV2(JSON.parse(JSON.stringify(exported)));
    expect(roundTrip).toEqual(exported);
    assertShareSafeExact(exported);
    expect(exported.review.decision?.revision).toBe(2);
    expect(exported.review.decision?.predecessorRevision).toBe(1);
    expect(exported.review.gold?.version).toBe(1);
    expect(exported.review.gold?.predecessorGoldAlias).toBeNull();
  });

  it("does not collide identical raw ids that belong to separate experiments", () => {
    const left = opaqueSource();
    const right = opaqueSource();
    right.packageId = IDS.foreignPkg;
    right.taskFingerprint = FOREIGN_TASK_FP;
    right.snapshotFingerprint = FOREIGN_SNAP_FP;
    right.decisions = right.decisions.map((row) => ({
      ...row,
      experimentId: IDS.foreignExp,
      packageId: IDS.foreignPkg,
    }));
    right.observations = right.observations.map((row) => ({
      ...row,
      experimentId: IDS.foreignExp,
    }));
    right.gold = gold({
      packageId: IDS.foreignPkg,
      experimentId: IDS.foreignExp,
      taskFingerprint: FOREIGN_TASK_FP,
      snapshotFingerprint: FOREIGN_SNAP_FP,
    });
    right.golds = [right.gold];
    right.comparison = buildStrategyComparison({
      packageId: right.packageId,
      candidates: right.candidates,
      traces: right.traces,
      agreement: right.agreement,
      gold: right.gold,
    });
    const exportedLeft = projectExperimentLabExport(left);
    const exportedRight = projectExperimentLabExport(right);
    expect(JSON.stringify(exportedLeft)).not.toContain(IDS.pkg);
    expect(JSON.stringify(exportedRight)).not.toContain(IDS.foreignPkg);
    expect(JSON.stringify(exportedLeft)).not.toContain(TASK_FP);
    expect(JSON.stringify(exportedRight)).not.toContain(FOREIGN_TASK_FP);
    expect(exportedLeft.review.packageAlias).toBe(exportedRight.review.packageAlias);
    assertShareSafeExact(exportedLeft);
    assertShareSafeExact(exportedRight);
  });

  for (const row of PROJECTION_MATRIX) {
    it(`projection matrix: ${row.name}`, () => {
      const source = row.apply(opaqueSource());
      if (row.expect === "reject") {
        expect(() => projectExperimentLabExport(source)).toThrow(ContractViolation);
        return;
      }
      const exported = projectExperimentLabExport(source);
      row.prove?.(exported);
    });
  }

  for (const row of TAMPER_MATRIX) {
    it(`tamper matrix: ${row.name}`, () => {
      const assembled = projectExperimentLabExport(opaqueSource());
      const mutated = row.apply(structuredClone(assembled));
      expect(() => parseLabExportV2(mutated)).toThrow(ContractViolation);
    });
  }
});
