import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  EXTERNAL_RUN_JUDGMENT_ERROR,
  EXTERNAL_RUN_JUDGMENT_LIMITS,
  EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID,
  parseExternalRunJudgment,
  parseExternalRunJudgmentConflict,
  parseExternalRunJudgmentList,
  parseExternalRunJudgmentRefused,
  parseExternalRunJudgmentRequest,
  parseExternalRunJudgmentSuccess,
  projectExternalRunJudgmentIdempotencyIntent,
} from "./external-run-judgment.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE_ID = "aabbccdd-eeff-4a11-8b22-ccddeeff0011";
const ARTIFACT_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONTRIBUTION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const RECORDED_AT = "2024-02-11T09:20:00.000Z";
const CREATED_AT = "2024-02-11T08:00:00.000Z";

function actor(overrides: Record<string, unknown> = {}) {
  return { id: ACTOR_ID, username: "operator", ...overrides };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    seq: 1,
    judgment: "corroborates",
    actor: actor(),
    links: [
      { kind: "artifact", id: ARTIFACT_A },
      { kind: "contribution", id: CONTRIBUTION_ID },
    ],
    rationale: "The linked checkout log matches the imported output.",
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    expectedSequence: 0,
    idempotencyKey: "run-judgment-0001",
    judgment: "corroborates",
    links: [
      { kind: "artifact", id: ARTIFACT_A },
      { kind: "contribution", id: CONTRIBUTION_ID },
    ],
    rationale: "The linked checkout log matches the imported output.",
    ...overrides,
  };
}

function runProjection(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    caseId: CASE_ID,
    sourceId: SOURCE_ID,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    applied: record(),
    replayed: false,
    run: runProjection(),
    ...overrides,
  };
}

function refusal(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID,
    error: EXTERNAL_RUN_JUDGMENT_ERROR,
    caseId: CASE_ID,
    runId: RUN_ID,
    reason: "case_archived",
    detail: "The recorded case state does not allow that action.",
    current: null,
    ...overrides,
  };
}

function conflict(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.external_run_judgment_conflict.v1",
    caseId: CASE_ID,
    runId: RUN_ID,
    expectedSequence: 1,
    currentSequence: 2,
    ...overrides,
  };
}

function list(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.external_run_judgment_list.v1",
    caseId: CASE_ID,
    runId: RUN_ID,
    judgments: [record()],
    ...overrides,
  };
}

describe("unknown keys and envelope drift", () => {
  it("rejects unknown keys on every judgment envelope", () => {
    expect(() => parseExternalRunJudgment(record({ extra: true }))).toThrow(/unknown key/);
    expect(() => parseExternalRunJudgmentRequest(request({ actorId: ACTOR_ID }))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunJudgmentSuccess(success({ contribution: {} }))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunJudgmentRefused(refusal({ retryable: false }))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunJudgmentConflict(conflict({ applied: record() }))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunJudgmentList(list({ total: 1 }))).toThrow(/unknown key/);
    expect(() => parseExternalRunJudgmentList(list({ nextCursor: null }))).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunJudgment(record({ actor: { ...actor(), role: "lead" } })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunJudgment(
        record({
          links: [{ kind: "artifact", id: ARTIFACT_A, note: "sidecar" }],
        }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunJudgmentSuccess(success({ run: { ...runProjection(), outputText: "x" } })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunJudgmentSuccess(success({ run: { ...runProjection(), title: "Invented" } })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunJudgmentSuccess(success({ run: { ...runProjection(), source: "Invented" } })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ run: { ...runProjection(), corroborationState: "unverified" } }),
      ),
    ).toThrow(/unknown key/);
    expect(() => parseExternalRunJudgmentList(list({ run: runProjection() }))).toThrow(
      /unknown key/,
    );
  });

  it("refuses JSON.parse __proto__ injection rather than silently accepting it", () => {
    const injected = JSON.parse(`{"schemaId":"${EXTERNAL_RUN_JUDGMENT_SCHEMA_ID}","caseId":"${CASE_ID}","runId":"${RUN_ID}","seq":1,"judgment":"corroborates","actor":{"id":"${ACTOR_ID}","username":"operator"},"links":[],"rationale":null,"recordedAt":"${RECORDED_AT}","__proto__":{"admin":true}}`);
    expect(() => parseExternalRunJudgment(injected)).toThrow(/unknown key/);
  });
});

describe("cycles, sparse arrays, accessors, and prototypes", () => {
  it("rejects cyclic values before contract traversal", () => {
    const cyclicRecord = record() as Record<string, unknown>;
    cyclicRecord.actor = cyclicRecord;
    expect(() => parseExternalRunJudgment(cyclicRecord)).toThrow(/cyclic values/);

    const cyclicRequest = request() as Record<string, unknown>;
    cyclicRequest.links = cyclicRequest;
    expect(() => parseExternalRunJudgmentRequest(cyclicRequest)).toThrow(/cyclic values/);

    const cyclicSuccess = success() as Record<string, unknown>;
    (cyclicSuccess.applied as Record<string, unknown>).cycle = cyclicSuccess;
    expect(() => parseExternalRunJudgmentSuccess(cyclicSuccess)).toThrow(/cyclic values/);
  });

  it("rejects sparse arrays and unknown array keys", () => {
    const sparse = Array(2) as unknown[];
    sparse[1] = { kind: "artifact", id: ARTIFACT_A };
    expect(() => parseExternalRunJudgmentRequest(request({ links: sparse }))).toThrow(
      /sparse arrays/,
    );

    const withNamedKey = [{ kind: "artifact", id: ARTIFACT_A }] as unknown as Record<
      string,
      unknown
    >[];
    Object.defineProperty(withNamedKey, "authority", { value: "admin", enumerable: true });
    expect(() => parseExternalRunJudgmentRequest(request({ links: withNamedKey }))).toThrow(
      /unknown array key/,
    );
  });

  it("rejects inherited prototypes, symbol keys, and accessors", () => {
    const inherited = Object.assign(Object.create({ authority: "admin" }), record());
    expect(() => parseExternalRunJudgment(inherited)).toThrow(/no inherited properties/);

    const withSymbol = record() as Record<PropertyKey, unknown>;
    withSymbol[Symbol("authority")] = "admin";
    expect(() => parseExternalRunJudgment(withSymbol)).toThrow(/symbol keys/);

    let calls = 0;
    const hostile = record();
    Object.defineProperty(hostile, "rationale", {
      enumerable: true,
      get() {
        calls += 1;
        return "should-not-run";
      },
    });
    expect(() => parseExternalRunJudgment(hostile)).toThrow(/accessor properties/);
    expect(calls).toBe(0);
  });
});

describe("malformed identifiers and times", () => {
  it("rejects mixed-case and malformed UUIDs on case, run, source, and link ids", () => {
    expect(() => parseExternalRunJudgmentRequest(request({ caseId: "CASE-1" }))).toThrow(
      /lower-case UUID/,
    );
    expect(() =>
      parseExternalRunJudgmentRequest(request({ runId: RUN_ID.toUpperCase() })),
    ).toThrow(/lower-case UUID/);
    expect(() =>
      parseExternalRunJudgment(
        record({ links: [{ kind: "artifact", id: ARTIFACT_A.toUpperCase() }] }),
      ),
    ).toThrow(/lower-case UUID/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ run: runProjection({ sourceId: SOURCE_ID.toUpperCase() }) }),
      ),
    ).toThrow(/lower-case UUID/);
  });

  it("rejects unsafe, blank, surrounding-whitespace, and overlong actor ids", () => {
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ id: "" }) })),
    ).toThrow(/non-empty text/);
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ id: " operator-42" }) })),
    ).toThrow(/surrounding whitespace/);
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ id: "operator-42 " }) })),
    ).toThrow(/surrounding whitespace/);
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ id: "op\nerator" }) })),
    ).toThrow(/control characters/);
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ id: "op\u202eerator" }) })),
    ).toThrow(/control characters/);
    expect(() =>
      parseExternalRunJudgment(
        record({
          actor: actor({ id: "x".repeat(EXTERNAL_RUN_JUDGMENT_LIMITS.actorIdMaxLength + 1) }),
        }),
      ),
    ).toThrow(/at most 512/);
  });

  it("rejects malformed and noncanonical recordedAt and createdAt instants", () => {
    expect(() => parseExternalRunJudgment(record({ recordedAt: "yesterday" }))).toThrow(
      /ISO-8601/,
    );
    expect(() => parseExternalRunJudgment(record({ recordedAt: "2024-02-11T09:20:00" }))).toThrow(
      /ISO-8601/,
    );
    expect(() =>
      parseExternalRunJudgmentSuccess(success({ run: runProjection({ createdAt: "not-a-time" }) })),
    ).toThrow(/ISO-8601/);
    expect(() =>
      parseExternalRunJudgment(record({ recordedAt: "2024-02-11T09:20:00+00:00" })),
    ).toThrow(/canonical UTC/);
    expect(() =>
      parseExternalRunJudgment(record({ recordedAt: "2024-02-11T09:20:00Z" })),
    ).toThrow(/canonical UTC/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ run: runProjection({ createdAt: "2024-02-11T10:00:00+02:00" }) }),
      ),
    ).toThrow(/canonical UTC/);
  });

  it("rejects unsafe idempotency keys", () => {
    for (const idempotencyKey of ["short", `a${"b".repeat(128)}`, "run/judgment/1", "-leading"]) {
      expect(() => parseExternalRunJudgmentRequest(request({ idempotencyKey }))).toThrow(
        /8\.\.128/,
      );
    }
  });
});

describe("duplicate and unsorted links", () => {
  it("rejects duplicate and unsorted links and more than 64", () => {
    expect(() =>
      parseExternalRunJudgmentRequest(
        request({
          links: [
            { kind: "artifact", id: ARTIFACT_A },
            { kind: "artifact", id: ARTIFACT_A },
          ],
        }),
      ),
    ).toThrow(/duplicate link/);
    expect(() =>
      parseExternalRunJudgmentRequest(
        request({
          links: [
            { kind: "contribution", id: CONTRIBUTION_ID },
            { kind: "artifact", id: ARTIFACT_A },
          ],
        }),
      ),
    ).toThrow(/canonical lexical order/);
    expect(() =>
      parseExternalRunJudgmentRequest(
        request({
          links: [
            { kind: "artifact", id: ARTIFACT_B },
            { kind: "artifact", id: ARTIFACT_A },
          ],
        }),
      ),
    ).toThrow(/canonical lexical order/);
    const tooMany = Array.from({ length: EXTERNAL_RUN_JUDGMENT_LIMITS.linksMax + 1 }, (_, index) => ({
      kind: "artifact" as const,
      id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`,
    }));
    expect(() => parseExternalRunJudgmentRequest(request({ links: tooMany }))).toThrow(
      /at most 64 links/,
    );
  });

  it("accepts lexically sorted mixed-kind links including snapshot", () => {
    const parsed = parseExternalRunJudgmentRequest(
      request({
        links: [
          { kind: "artifact", id: ARTIFACT_A },
          { kind: "artifact", id: ARTIFACT_B },
          { kind: "contribution", id: CONTRIBUTION_ID },
          { kind: "snapshot", id: SNAPSHOT_ID },
        ],
      }),
    );
    expect(parsed.links.map((link) => `${link.kind}:${link.id}`)).toEqual([
      `artifact:${ARTIFACT_A}`,
      `artifact:${ARTIFACT_B}`,
      `contribution:${CONTRIBUTION_ID}`,
      `snapshot:${SNAPSHOT_ID}`,
    ]);
  });
});

describe("negative and unsafe integers", () => {
  it("rejects seq below 1 and unsafe expectedSequence values", () => {
    expect(() => parseExternalRunJudgment(record({ seq: 0 }))).toThrow(/>= 1/);
    expect(() => parseExternalRunJudgment(record({ seq: -1 }))).toThrow(/unsigned safe integer/);
    expect(() => parseExternalRunJudgment(record({ seq: 1.5 }))).toThrow(/unsigned safe integer/);
    expect(() => parseExternalRunJudgment(record({ seq: Number.NaN }))).toThrow(
      /unsigned safe integer/,
    );
    expect(() => parseExternalRunJudgment(record({ seq: Number.POSITIVE_INFINITY }))).toThrow(
      /unsigned safe integer/,
    );
    expect(() =>
      parseExternalRunJudgmentRequest(request({ expectedSequence: -1 })),
    ).toThrow(/unsigned safe integer/);
    expect(() =>
      parseExternalRunJudgmentRequest(request({ expectedSequence: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow(/unsigned safe integer/);
    expect(() =>
      parseExternalRunJudgmentConflict(conflict({ expectedSequence: 1.25, currentSequence: 2 })),
    ).toThrow(/unsigned safe integer/);
  });
});

describe("prohibited text", () => {
  it("rejects control characters and bidi overrides in username and rationale", () => {
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ username: "op\nerator" }) })),
    ).toThrow(/control characters/);
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ username: "op\u202eerator" }) })),
    ).toThrow(/control characters/);
    expect(() => parseExternalRunJudgment(record({ rationale: "because\u202e" }))).toThrow(
      /control characters/,
    );
    expect(() => parseExternalRunJudgment(record({ rationale: "because\r\n" }))).toThrow(
      /control characters/,
    );
  });

  it("rejects empty, whitespace-only, and overlong bounded text", () => {
    expect(() =>
      parseExternalRunJudgment(record({ actor: actor({ username: "   " }) })),
    ).toThrow(/non-empty text/);
    expect(() => parseExternalRunJudgment(record({ rationale: "   " }))).toThrow(/non-empty text/);
    expect(() =>
      parseExternalRunJudgment(
        record({
          actor: actor({
            username: "o".repeat(EXTERNAL_RUN_JUDGMENT_LIMITS.usernameMaxLength + 1),
          }),
        }),
      ),
    ).toThrow(/at most 200/);
    expect(() =>
      parseExternalRunJudgment(
        record({ rationale: "r".repeat(EXTERNAL_RUN_JUDGMENT_LIMITS.rationaleMaxLength + 1) }),
      ),
    ).toThrow(/at most 4000/);
  });

  it("rejects unknown judgment values that would imply a run-state flip", () => {
    expect(() => parseExternalRunJudgment(record({ judgment: "corroborated" }))).toThrow(
      /one of/,
    );
    expect(() => parseExternalRunJudgment(record({ judgment: "unverified" }))).toThrow(/one of/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ run: runProjection({ corroborationState: "corroborated" }) }),
      ),
    ).toThrow(/unknown key/);
  });
});

describe("nested identity mismatch", () => {
  it("rejects success and list rows whose nested identities drift from the envelope", () => {
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ applied: record({ caseId: "99999999-9999-4999-8999-999999999999" }) }),
      ),
    ).toThrow(/must match caseId/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ applied: record({ runId: "99999999-9999-4999-8999-999999999999" }) }),
      ),
    ).toThrow(/must match runId/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ run: runProjection({ id: "99999999-9999-4999-8999-999999999999" }) }),
      ),
    ).toThrow(/must match runId/);
    expect(() =>
      parseExternalRunJudgmentSuccess(
        success({ run: runProjection({ caseId: "99999999-9999-4999-8999-999999999999" }) }),
      ),
    ).toThrow(/must match caseId/);
    expect(() =>
      parseExternalRunJudgmentList(
        list({
          judgments: [record({ caseId: "99999999-9999-4999-8999-999999999999" })],
        }),
      ),
    ).toThrow(/must match caseId/);
    expect(() =>
      parseExternalRunJudgmentList(
        list({
          judgments: [record({ runId: "99999999-9999-4999-8999-999999999999" })],
        }),
      ),
    ).toThrow(/must match runId/);
  });
});

describe("duplicate and noncontiguous judgment records", () => {
  it("rejects lists that do not start at 1 or skip seq", () => {
    expect(() =>
      parseExternalRunJudgmentList(list({ judgments: [record({ seq: 2 })] })),
    ).toThrow(/contiguous sequence starting at 1/);
    expect(() =>
      parseExternalRunJudgmentList(
        list({
          judgments: [record(), record({ seq: 3, links: [], rationale: null })],
        }),
      ),
    ).toThrow(/contiguous sequence starting at 1/);
    expect(() =>
      parseExternalRunJudgmentList(
        list({
          judgments: [record({ seq: 2 }), record({ seq: 1, links: [], rationale: null })],
        }),
      ),
    ).toThrow(/contiguous sequence starting at 1/);
    expect(() =>
      parseExternalRunJudgmentList(
        list({
          judgments: [record(), record({ seq: 1, links: [], rationale: null })],
        }),
      ),
    ).toThrow(/contiguous sequence starting at 1/);
  });
});

describe("refusal and conflict fail-closed cases", () => {
  it("rejects a refusal whose current is not null", () => {
    expect(() => parseExternalRunJudgmentRefused(refusal({ current: "present" }))).toThrow(
      /requires current to be null/,
    );
    expect(() =>
      parseExternalRunJudgmentRefused(refusal({ reason: "privacy_mismatch", current: {} })),
    ).toThrow();
    expect(() =>
      parseExternalRunJudgmentRefused(
        refusal({ reason: "idempotency_intent_mismatch", current: record() }),
      ),
    ).toThrow();
    expect(() =>
      parseExternalRunJudgmentRefused(refusal({ reason: "links_required", current: "x" })),
    ).toThrow(/requires current to be null/);
  });

  it("rejects a conflict whose sequences are equal", () => {
    expect(() =>
      parseExternalRunJudgmentConflict(conflict({ expectedSequence: 2, currentSequence: 2 })),
    ).toThrow(/differ from expectedSequence/);
    expect(() =>
      parseExternalRunJudgmentConflict(conflict({ expectedSequence: 0, currentSequence: 0 })),
    ).toThrow(/differ from expectedSequence/);
  });

  it("rejects an unknown refusal reason", () => {
    expect(() => parseExternalRunJudgmentRefused(refusal({ reason: "run_not_found" }))).toThrow(
      /one of/,
    );
  });
});

describe("idempotency intent is fail-closed", () => {
  it("does not project intent from an invalid request", () => {
    expect(() =>
      projectExternalRunJudgmentIdempotencyIntent(request({ caseId: "not-a-uuid" })),
    ).toThrow(ContractViolation);
    expect(() =>
      projectExternalRunJudgmentIdempotencyIntent(success()),
    ).toThrow(ContractViolation);
  });
});
