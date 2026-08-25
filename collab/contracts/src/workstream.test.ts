import { describe, expect, it } from "vitest";
import {
  operatorKindFor,
  parseWorkstreamList,
  parseWorkstreamView,
  projectWorkstreams,
  readableUnknown,
  strategyLabelFor,
  workstreamKey,
  type WorkstreamProjectionInput,
} from "./workstream.js";
import { TRIAGE_JOB_REQUEST_SCHEMA_ID, TRIAGE_JOB_SCHEMA_ID, type TriageJobV1 } from "./triage-job.js";

function job(overrides: Partial<TriageJobV1> = {}): TriageJobV1 {
  return {
    schemaId: TRIAGE_JOB_SCHEMA_ID,
    id: "job-1",
    caseId: "case-1",
    snapshotId: "snap-1",
    snapshotFingerprint: "f".repeat(64),
    requestFingerprint: "a".repeat(64),
    cancellationId: "cancel-1",
    request: {
      schemaId: TRIAGE_JOB_REQUEST_SCHEMA_ID,
      snapshotId: "snap-1",
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard.synthetic-demo",
      question: "What caused the checkout timeout?",
      policyFingerprint: null,
      taskFingerprint: "task-1",
      candidates: [
        {
          candidateId: "reviewer-lane",
          role: "reviewer",
          provider: "synthetic",
          profileId: null,
          model: "fixture-reviewer-a",
          version: null,
        },
      ],
    },
    status: "completed",
    candidates: [
      {
        candidateId: "reviewer-lane",
        role: "reviewer",
        provider: "synthetic",
        profileId: null,
        model: "fixture-reviewer-a",
        version: null,
        status: "completed",
        benchmarkRunId: null,
        outputHash: "b".repeat(64),
        summary: "Checkout waited on the inventory call before failing.",
        evidenceRefs: ["ev-checkout", "ev-missing"],
        unknowns: ["poolSaturationWindow"],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: null,
        startedAt: "2026-08-24T06:14:20.000Z",
        finishedAt: "2026-08-24T06:14:25.000Z",
        privacyClass: "share_safe",
      },
    ],
    sameSnapshot: true,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: "identity-1",
    requestedByUsername: "dana",
    createdAt: "2026-08-24T06:14:00.000Z",
    updatedAt: "2026-08-24T06:14:25.000Z",
    startedAt: "2026-08-24T06:14:10.000Z",
    finishedAt: "2026-08-24T06:14:25.000Z",
    cancelRequestedAt: null,
    stoppedReason: null,
    ...overrides,
  };
}

function input(overrides: Partial<WorkstreamProjectionInput> = {}): WorkstreamProjectionInput {
  return {
    caseId: "case-1",
    jobs: [job()],
    evidence: [
      {
        id: "ev-checkout",
        kind: "log",
        filename: "checkout.log",
        summary: "Synthetic checkout timeout excerpt.",
        verificationStatus: "verified",
      },
    ],
    snapshots: [
      { id: "snap-1", createdAt: "2026-08-24T06:13:00.000Z", evidenceIds: ["ev-checkout"] },
    ],
    timeline: [],
    ...overrides,
  };
}

describe("workstream projection", () => {
  it("produces a parseable list with one workstream per recorded lane", () => {
    const list = parseWorkstreamList(projectWorkstreams(input()));
    expect(list.caseId).toBe("case-1");
    expect(list.workstreams).toHaveLength(1);
    expect(parseWorkstreamView(list.workstreams[0]!)).toBeTruthy();
  });

  it("addresses each workstream by a stable run-and-lane key", () => {
    const [view] = projectWorkstreams(input()).workstreams;
    expect(view?.key).toBe(workstreamKey("job-1", "reviewer-lane"));
    expect(view?.technical.workstreamKey).toBe(view?.key);
  });

  it("keeps every raw identifier out of the readable fields", () => {
    const [view] = projectWorkstreams(input()).workstreams;
    const readable = [
      view!.label,
      view!.purpose,
      view!.operatorLabel,
      view!.strategyLabel,
      view!.statusLabel,
      view!.statusDetail,
      view!.outcome,
      view!.inputs.snapshotLabel,
      view!.inputs.snapshotProofLabel,
      view!.rerun.note,
      ...view!.activity.map((entry) => `${entry.label} ${entry.actor}`),
    ].join(" ");
    expect(readable).not.toContain("job-1");
    expect(readable).not.toContain("snap-1");
    expect(readable).not.toContain("f".repeat(64));
    expect(readable).not.toContain("a".repeat(64));
    expect(readable).not.toContain("task-1");
  });

  it("preserves every raw identifier in the technical projection", () => {
    const [view] = projectWorkstreams(input()).workstreams;
    expect(view?.technical).toMatchObject({
      runId: "job-1",
      candidateId: "reviewer-lane",
      snapshotId: "snap-1",
      snapshotFingerprint: "f".repeat(64),
      requestFingerprint: "a".repeat(64),
      taskFingerprint: "task-1",
      strategyId: "contextdesk.standard.synthetic-demo",
      modelId: "fixture-reviewer-a",
      outputHash: "b".repeat(64),
      privacyClass: "share_safe",
    });
  });

  it("resolves cited evidence to human labels and marks unresolved references", () => {
    const [view] = projectWorkstreams(input()).workstreams;
    expect(view?.evidenceCited).toHaveLength(2);
    expect(view?.evidenceCited[0]).toMatchObject({
      evidenceId: "ev-checkout",
      label: "checkout.log",
      inFrozenSnapshot: true,
      verification: "verified",
      resolved: true,
    });
    expect(view?.evidenceCited[1]).toMatchObject({
      evidenceId: "ev-missing",
      label: "Evidence no longer registered",
      inFrozenSnapshot: false,
      verification: "not recorded",
      resolved: false,
    });
  });

  it("orders activity chronologically and names the requester", () => {
    const list = projectWorkstreams(
      input({
        timeline: [
          {
            kind: "triage_job_finished",
            actorUsername: "dana",
            targetId: "job-1",
            serverTime: "2026-08-24T06:14:26.000Z",
          },
          {
            kind: "contribution_created",
            actorUsername: "dana",
            targetId: "job-1",
            serverTime: "2026-08-24T06:14:27.000Z",
          },
        ],
      }),
    );
    const activity = list.workstreams[0]!.activity;
    const times = activity.map((entry) => entry.at);
    expect(times).toEqual([...times].sort());
    expect(activity[0]).toMatchObject({ label: "Run queued", actor: "dana" });
    expect(activity.at(-1)?.label).toBe("Run finished");
    // Unrelated timeline kinds are not invented into workstream history.
    expect(activity.some((entry) => entry.label.includes("contribution"))).toBe(false);
  });

  it("never presents an unproven snapshot binding as proven", () => {
    const unknown = projectWorkstreams(input({ jobs: [job({ sameSnapshot: null })] }));
    expect(unknown.workstreams[0]?.inputs.sameSnapshot).toBeNull();
    expect(unknown.workstreams[0]?.inputs.snapshotProofLabel).toMatch(/not yet proven/);
    const mismatched = projectWorkstreams(input({ jobs: [job({ sameSnapshot: false })] }));
    expect(mismatched.workstreams[0]?.inputs.snapshotProofLabel).toMatch(/do not compare it as equal/);
  });

  it("states an outcome without claiming correctness", () => {
    const [view] = projectWorkstreams(input()).workstreams;
    expect(view?.outcome).toContain("cited 2 evidence items");
    expect(view?.outcome).toContain("left 1 thing unknown");
    expect(view?.agreementNotice).toBe("Agreement is not proof of correctness.");
  });

  it("reports no outcome while a workstream is still queued or running", () => {
    const running = projectWorkstreams(
      input({
        jobs: [
          job({
            status: "running",
            candidates: [{ ...job().candidates[0]!, status: "running", finishedAt: null }],
          }),
        ],
      }),
    );
    expect(running.workstreams[0]?.lifecycle).toBe("running");
    expect(running.workstreams[0]?.outcome).toBe("No outcome is recorded yet.");
  });

  it("links a rerun to its parent workstream only when the parent is in view", () => {
    const parentPresent = projectWorkstreams(
      input({ jobs: [job(), job({ id: "job-2", parentJobId: "job-1" })] }),
    );
    const rerun = parentPresent.workstreams.find((row) => row.technical.runId === "job-2");
    expect(rerun?.rerun).toMatchObject({
      isRerun: true,
      parentKey: workstreamKey("job-1", "reviewer-lane"),
    });
    const parentMissing = projectWorkstreams(
      input({ jobs: [job({ id: "job-2", parentJobId: "job-0" })] }),
    );
    expect(parentMissing.workstreams[0]?.rerun).toMatchObject({
      isRerun: true,
      parentKey: null,
    });
    expect(projectWorkstreams(input()).workstreams[0]?.rerun.note).toMatch(/Not a rerun/);
  });

  it("is deterministic for the same recorded input", () => {
    expect(JSON.stringify(projectWorkstreams(input()))).toBe(
      JSON.stringify(projectWorkstreams(input())),
    );
  });
});

describe("workstream readability helpers", () => {
  it("classifies how the work was performed without assuming a model lane", () => {
    expect(operatorKindFor("synthetic", "fixture-reviewer-a")).toBe("ai_assisted");
    expect(operatorKindFor("human", "on-call analyst")).toBe("human");
    expect(operatorKindFor("synthetic", "programmatic-agent")).toBe("programmatic");
    expect(operatorKindFor("import", "chat-operator")).toBe("external_import");
    expect(operatorKindFor("host", "diagnostic-pipeline")).toBe("host_run");
    expect(operatorKindFor("", "")).toBe("unknown");
  });

  it("renders a strategy identifier as words", () => {
    expect(strategyLabelFor("contextdesk.strategy-paths.synthetic-demo")).toBe(
      "Strategy paths synthetic demo strategy",
    );
    expect(strategyLabelFor("")).toBe("Strategy not recorded");
  });

  it("renders recorded unknown keys as readable phrases", () => {
    expect(readableUnknown("poolSaturationWindow")).toBe("pool saturation window");
    expect(readableUnknown("pool_saturation_window")).toBe("pool saturation window");
  });
});
