import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactV1,
  ContributionV1,
  ExternalRunJudgmentListV1,
  InvestigationRuntime,
  ResourceState,
} from "../runtime/public.js";
import { RuntimeExternalRunJudgments } from "./runtime-external-run-judgments.js";

const runtimeRef: { current: InvestigationRuntime } = {
  current: null as unknown as InvestigationRuntime,
};

vi.mock("../runtime/public.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/public.js")>();
  return {
    ...actual,
    useInvestigationRuntime: () => runtimeRef.current,
  };
});

const RUN_A = "22222222-2222-4222-8222-222222222222";
const RUN_B = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const NOTE_ID = "55555555-5555-4555-8555-555555555555";
const TOMBSTONE_ID = "66666666-6666-4666-8666-666666666666";

function idle<T>(): ResourceState<T> {
  return { status: "idle" };
}

function artifact(overrides: Partial<ArtifactV1> = {}): ArtifactV1 {
  return {
    schemaId: "cd-collab.artifact.v1",
    id: ARTIFACT_ID,
    caseId: "case-1",
    kind: "log",
    filename: "checkout-timeout.log",
    uri: "file://ignored",
    mediaType: "text/plain",
    byteLength: 12,
    contentHash: null,
    expectedHash: null,
    verificationStatus: null,
    privacyClass: "share_safe",
    summaryContributionId: null,
    uploaderId: "u1",
    sourceId: "s1",
    ...overrides,
  };
}

function contribution(overrides: Partial<ContributionV1> = {}): ContributionV1 {
  return {
    schemaId: "cd-collab.contribution.v1",
    id: NOTE_ID,
    caseId: "case-1",
    kind: "note",
    revision: 1,
    predecessorRevision: null,
    body: "Queue time rises immediately after the connection-pool rollout.",
    contentHash: "hash",
    privacyClass: "share_safe",
    tombstoned: false,
    authorId: "u1",
    authorUsername: "alice",
    createdAt: "2026-09-09T12:00:00.000Z",
    hypothesisStatus: null,
    hypothesisLinks: null,
    sourceId: "s1",
    ...overrides,
  };
}

function list(overrides: Partial<ExternalRunJudgmentListV1> = {}): ExternalRunJudgmentListV1 {
  return {
    schemaId: "cd-collab.external_run_judgment_list.v1",
    caseId: "11111111-1111-4111-8111-111111111111",
    runId: RUN_A,
    judgments: [],
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<{
  presentationScopeKey: string;
  runId: string | null;
  judgments: ResourceState<ExternalRunJudgmentListV1>;
  evidence: ResourceState<readonly ArtifactV1[]>;
  contributions: ResourceState<readonly ContributionV1[]>;
  mutation: InvestigationRuntime["mutations"]["externalRunJudgment"];
  contributionMutation: InvestigationRuntime["mutations"]["createContribution"];
  query: ((runId: string) => void) | null;
  create: InvestigationRuntime["commands"]["createExternalRunJudgment"];
  refresh: () => void;
  otherRefresh: () => void;
}> = {}): InvestigationRuntime {
  const idleMutation = { status: "idle" as const };
  return {
    presentationScopeKey: overrides.presentationScopeKey ?? "scope-1",
    identity: { id: "id-1", username: "alice", displayName: "Alice" },
    capabilities: {
      canRead: true,
      canReadPrivate: false,
      canCreate: true,
      canUpload: true,
      canContribute: true,
      canEditSituation: true,
      canManageLifecycle: false,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
      canRecordRunJudgment: true,
    },
    resources: {
      investigations: idle(),
      investigationCollection: idle(),
      investigationCollectionQuery: null,
      operationsQueue: idle(),
      operationsQueueQuery: null,
      operationsQueueRequestGeneration: 0,
      investigation: idle(),
      evidence: overrides.evidence ?? { status: "ready", value: [artifact()] },
      contributions: overrides.contributions ?? {
        status: "ready",
        value: [
          contribution(),
          contribution({ id: TOMBSTONE_ID, body: "Removed.", tombstoned: true }),
        ],
      },
      lifecycle: idle(),
      coordination: idle(),
      artifactAnnotations: idle(),
      externalRunJudgments: overrides.judgments ?? idle(),
      externalRunJudgmentsRunId: overrides.runId === undefined ? RUN_A : overrides.runId,
    },
    mutations: {
      create: idleMutation,
      uploadEvidence: idleMutation,
      createContribution: overrides.contributionMutation ?? idleMutation,
      updateSituation: idleMutation,
      lifecycle: idleMutation,
      coordination: idleMutation,
      namedCoordinationSelf: idleMutation,
      namedCoordinationParticipant: idleMutation,
      createArtifactAnnotation: idleMutation,
      createArtifactAnnotations: idleMutation,
      externalRunJudgment: overrides.mutation ?? idleMutation,
    },
    evidencePreview: {
      state: idleMutation,
      preview: vi.fn(async () => ({ status: "ignored" as const, reason: "not_ready" as const })),
      clear: vi.fn(),
    },
    refresh: {
      investigations: overrides.otherRefresh ?? vi.fn(),
      investigationCollection: vi.fn(),
      operationsQueue: vi.fn(),
      investigation: vi.fn(),
      evidence: vi.fn(),
      contributions: vi.fn(),
      lifecycle: vi.fn(),
      coordination: vi.fn(),
      artifactAnnotations: vi.fn(async () => undefined),
      externalRunJudgments: overrides.refresh ?? vi.fn(),
      activeInvestigation: vi.fn(),
    },
    commands: {
      createInvestigation: null,
      uploadEvidence: null,
      createContribution: vi.fn(async () => ({ status: "ignored" as const, reason: "not_ready" as const })),
      updateSituation: null,
      applyLifecycle: null,
      applyCoordinationAction: null,
      applyNamedCoordinationSelf: null,
      applyNamedCoordinationParticipant: null,
      createArtifactAnnotation: null,
      createArtifactAnnotations: null,
      queryExternalRunJudgments: overrides.query === undefined ? vi.fn() : overrides.query,
      createExternalRunJudgment: overrides.create === undefined
        ? vi.fn(async () => ({ status: "succeeded" as const, value: {} as never }))
        : overrides.create,
    },
  };
}

function renderFor(runId = RUN_A, runtime?: InvestigationRuntime) {
  runtimeRef.current = runtime ?? makeRuntime();
  return render(<RuntimeExternalRunJudgments runId={runId} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("runtime external run judgments adapter", () => {
  it("queries the current run exactly once when the command exists", () => {
    const query = vi.fn();
    renderFor(RUN_A, makeRuntime({ query, runId: null }));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(RUN_A);
  });

  it("makes zero query calls and conceals matching stale data when the command is null", () => {
    renderFor(RUN_A, makeRuntime({
      query: null,
      runId: RUN_A,
      judgments: {
        status: "ready",
        value: list({
          judgments: [{
            schemaId: "cd-collab.external_run_judgment.v1",
            caseId: "11111111-1111-4111-8111-111111111111",
            runId: RUN_A,
            seq: 1,
            judgment: "corroborates",
            actor: { id: "id-1", username: "stale-actor" },
            links: [],
            rationale: "Stale rationale must disappear.",
            recordedAt: "2026-09-09T12:00:00.000Z",
          }],
        }),
      },
      mutation: { status: "running" },
    }));
    expect(screen.queryByText("Stale rationale must disappear.")).toBeNull();
    expect(screen.queryByText("Recording the assessment once…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record assessment" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("could not be loaded right now");
  });

  it("masks a resource whose run id does not match the focused run", () => {
    renderFor(RUN_A, makeRuntime({
      runId: RUN_B,
      judgments: {
        status: "ready",
        value: list({
          runId: RUN_B,
          judgments: [{
            schemaId: "cd-collab.external_run_judgment.v1",
            caseId: "11111111-1111-4111-8111-111111111111",
            runId: RUN_B,
            seq: 1,
            judgment: "corroborates",
            actor: { id: "id-1", username: "stale-actor" },
            links: [],
            rationale: "Stale run reading.",
            recordedAt: "2026-09-09T12:00:00.000Z",
          }],
        }),
      },
    }));
    expect(screen.queryByText("Stale run reading.")).toBeNull();
    expect(screen.getByText("Waiting for recorded human assessments.")).toBeTruthy();
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
  });

  it("requeries and resets the draft when the presentation scope or run changes", () => {
    const query = vi.fn();
    const view = renderFor(RUN_A, makeRuntime({
      query,
      runId: RUN_A,
      judgments: { status: "ready", value: list() },
    }));
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rationale (optional)" }), {
      target: { value: "Draft for run A." },
    });
    expect(query).toHaveBeenCalledTimes(1);

    runtimeRef.current = makeRuntime({
      query,
      presentationScopeKey: "scope-2",
      runId: RUN_B,
      judgments: { status: "ready", value: list({ runId: RUN_B }) },
    });
    view.rerender(<RuntimeExternalRunJudgments runId={RUN_B} />);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(RUN_B);
    expect((screen.getByRole("textbox", { name: "Rationale (optional)" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("maps a previous refresh snapshot instead of claiming empty", () => {
    renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: {
        status: "loading",
        previous: list({
          judgments: [{
            schemaId: "cd-collab.external_run_judgment.v1",
            caseId: "11111111-1111-4111-8111-111111111111",
            runId: RUN_A,
            seq: 1,
            judgment: "insufficient_evidence",
            actor: { id: "id-1", username: "alice" },
            links: [],
            rationale: "Previous reading.",
            recordedAt: "2026-09-09T12:00:00.000Z",
          }],
        }),
      },
    }));
    expect(screen.getByText("Previous reading.")).toBeTruthy();
    expect(screen.getByText("Refreshing recorded human assessments…")).toBeTruthy();
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
  });

  it("filters citation choices to current non-tombstoned evidence and contributions", () => {
    renderFor(RUN_A, makeRuntime({
      judgments: { status: "ready", value: list() },
      evidence: {
        status: "ready",
        value: [
          artifact(),
          artifact({ id: "unnamed-1", filename: null, uri: null }),
        ],
      },
      contributions: {
        status: "ready",
        value: [
          contribution(),
          contribution({ id: TOMBSTONE_ID, body: "Gone.", tombstoned: true }),
        ],
      },
    }));
    expect(screen.getByRole("checkbox", { name: "checkout-timeout.log" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Unnamed evidence" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /note: Queue time rises/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Gone/ })).toBeNull();
  });

  it("omits citation choices from an unavailable evidence or contribution resource", () => {
    renderFor(RUN_A, makeRuntime({
      judgments: { status: "ready", value: list() },
      evidence: { status: "failed", error: { kind: "unavailable", status: 503 } },
      contributions: { status: "failed", error: { kind: "not_found", status: 404 } },
    }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("No citable records are available in this view.")).toBeTruthy();
  });

  it.each([
    ["auth_lost", { kind: "auth_lost", status: 403 } as const],
    ["not_found", { kind: "not_found", status: 404 } as const],
  ] as const)("conceals prior judgment and citation bytes after %s", (_label, error) => {
    const staleList = list({
      judgments: [{
        schemaId: "cd-collab.external_run_judgment.v1",
        caseId: "11111111-1111-4111-8111-111111111111",
        runId: RUN_A,
        seq: 1,
        judgment: "corroborates",
        actor: { id: "id-1", username: "prior-reader" },
        links: [],
        rationale: "Previously visible private reading.",
        recordedAt: "2026-09-09T12:00:00.000Z",
      }],
    });
    renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: { status: "failed", error, previous: staleList },
      evidence: {
        status: "failed",
        error,
        previous: [artifact({ filename: "previously-private.log" })],
      },
      contributions: {
        status: "failed",
        error,
        previous: [contribution({ body: "Previously private note." })],
      },
    }));
    expect(screen.queryByText("Previously visible private reading.")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "previously-private.log" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Previously private note/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record assessment" })).toBeNull();
  });

  it("maps only the dedicated judgment mutation and ignores a contribution mutation", () => {
    renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: { status: "ready", value: list() },
      mutation: { status: "idle" },
      contributionMutation: { status: "running" },
    }));
    expect(screen.queryByText("Recording the assessment once…")).toBeNull();
  });

  it.each([
    [
      "conflict",
      {
        status: "failed",
        error: {
          kind: "judgment_conflict",
          status: 409,
          caseId: "11111111-1111-4111-8111-111111111111",
          runId: RUN_A,
          expectedSequence: 0,
          currentSequence: 1,
        },
      },
      /Another assessment was recorded first/,
      true,
    ],
    [
      "refusal",
      {
        status: "failed",
        error: {
          kind: "judgment_refused",
          status: 409,
          caseId: "11111111-1111-4111-8111-111111111111",
          runId: RUN_A,
          reason: "links_required",
          detail: "private server detail",
        },
      },
      /needs at least one citation/,
      false,
    ],
    [
      "limit",
      { status: "failed", error: { kind: "judgment_limit_reached", status: 413 } },
      /recorded assessment limit/,
      true,
    ],
    [
      "unknown outcome",
      {
        status: "failed",
        error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
      },
      /could not confirm the result/,
      true,
    ],
    [
      "busy",
      { status: "ignored", reason: "busy" },
      /already being recorded/,
      false,
    ],
  ] as const)("maps the dedicated %s command outcome", async (_label, outcome, copy, blocked) => {
    const create = vi.fn<NonNullable<InvestigationRuntime["commands"]["createExternalRunJudgment"]>>(
      async () => outcome,
    );
    renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: { status: "ready", value: list() },
      create,
    }));
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(copy);
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: "Insufficient evidence" }).matches(":disabled"))
      .toBe(blocked);
    expect(document.body.textContent).not.toContain("private server detail");
  });

  it("maps dedicated running and failed mutation state without borrowing another mutation", () => {
    const running = renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: { status: "ready", value: list() },
      mutation: { status: "running" },
    }));
    expect(screen.getByText("Recording the assessment once…")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Insufficient evidence" }).matches(":disabled")).toBe(true);
    running.unmount();

    renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: { status: "ready", value: list() },
      mutation: {
        status: "failed",
        error: {
          kind: "judgment_refused",
          status: 409,
          caseId: "11111111-1111-4111-8111-111111111111",
          runId: RUN_A,
          reason: "case_archived",
          detail: "private server detail",
        },
      },
    }));
    expect(screen.getByRole("alert").textContent).toContain("investigation is archived");
    expect(screen.getByRole("radio", { name: "Insufficient evidence" }).matches(":disabled")).toBe(true);
    expect(document.body.textContent).not.toContain("private server detail");
  });

  it("posts the exact public command payload and never calls fetch", async () => {
    const create = vi.fn<NonNullable<InvestigationRuntime["commands"]["createExternalRunJudgment"]>>(
      async () => ({ status: "succeeded" as const, value: {} as never }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    renderFor(RUN_A, makeRuntime({
      runId: RUN_A,
      judgments: { status: "ready", value: list() },
      create,
    }));
    fireEvent.click(screen.getByRole("radio", { name: "Corroborates" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "checkout-timeout.log" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /note: Queue time rises/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rationale (optional)" }), {
      target: { value: "  Human reading.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0];
    expect(payload).toEqual({
      runId: RUN_A,
      judgment: "corroborates",
      links: [
        { kind: "artifact", id: ARTIFACT_ID },
        { kind: "contribution", id: NOTE_ID },
      ],
      rationale: "Human reading.",
      idempotencyKey: expect.stringMatching(/^assess-/),
    });
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "idempotencyKey",
      "judgment",
      "links",
      "rationale",
      "runId",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not reach private controllers, gateways, protected-api, server, or raw routes", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "runtime-external-run-judgments.tsx"),
      "utf8",
    );
    expect(source).not.toContain("controllers/");
    expect(source).not.toContain("gateway");
    expect(source).not.toContain("protected-api");
    expect(source).not.toContain("/api/");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("collab/server");
    expect(source).toContain("../runtime/public.js");
    expect(source).toContain("./shared/index.js");
  });
});
