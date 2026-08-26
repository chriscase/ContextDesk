/**
 * War Room log-time review service.
 *
 * The host pipeline is scripted here so these tests cover exactly what the
 * server owns: the durable record, fail-closed revision handling, idempotent
 * replay, and the honest accounting of what a time change did to work already
 * produced. Timestamp math itself is covered against the real pipeline in
 * `crates/cd-cli/tests/collab_log_time_cli.rs`.
 *
 * All data is synthetic: an invented batch worker, an invented edge gateway,
 * and placeholder analyst identities.
 */
import { describe, expect, it } from "vitest";
import type { AuditStore } from "../audit/index.js";
import {
  LogTimeConflictError,
  LogTimeNotFoundError,
  LogTimeRequestError,
  type HostResult,
  type LogTimeAction,
  type LogTimeBridge,
} from "./bridge.js";
import { LogTimeService, type LogTimeCasePort } from "./service.js";
import { MemoryLogTimeStore } from "./store.js";

const CASE_ID = "11111111-2222-4333-8444-555555555555";
const ACTOR = { id: "analyst-synthetic-01", username: "analyst-synthetic-01" };
const SOURCE = "worker/batch.log";
const FINGERPRINT = "a".repeat(64);
const CORPUS_ID = "corpus-synthetic-0001";

interface HostState {
  revision: number;
  declarations: Record<
    string,
    {
      source: string;
      ianaTimezone: string;
      basis: "user_declared";
      declaredAt: number;
      appliedRevision: number;
    }
  >;
  unresolved: number;
  resolved: number;
}

/**
 * A scripted stand-in for `contextdesk collab-log-time`. It reproduces the two
 * behaviours the server depends on: revisions only ever move forward, and a
 * stale expected revision is refused rather than applied.
 */
class FakeBridge implements LogTimeBridge {
  calls: LogTimeAction[] = [];
  state: HostState = {
    revision: 1,
    declarations: {},
    unresolved: 5,
    resolved: 0,
  };
  failNextWith: Error | null = null;

  async run(caseId: string, action: LogTimeAction): Promise<HostResult> {
    this.calls.push(action);
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
    const base = () => ({
      caseId,
      corpusId: CORPUS_ID,
      corpusRevision: this.state.revision,
      sources: [
        {
          source: SOURCE,
          unresolvedLocalRecords: this.state.unresolved,
          resolvedLocalRecords: this.state.resolved,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        },
      ],
      declarations: this.state.declarations,
    });

    const requireFresh = (expected: number) => {
      if (expected !== this.state.revision) {
        throw new LogTimeConflictError(
          `stale timezone apply: expected revision ${expected}, current ${this.state.revision}`,
        );
      }
    };

    switch (action.kind) {
      case "build":
        return {
          ...base(),
          build: {
            corpusName: "synthetic",
            eventsImported: 8,
            sourcesSelected: 2,
            sourcesFailed: 0,
            partial: false,
            timezoneAmbiguousSources: [SOURCE],
          },
        };
      case "status":
        return base();
      case "search":
      case "events":
        return {
          ...base(),
          search: {
            bounded: false,
            atLeast: 0,
            returned: 0,
            partial: false,
            cancelled: false,
            diagnostic: null,
            hits: [],
          },
        };
      case "preview": {
        requireFresh(action.expectedRevision);
        return {
          ...base(),
          sources: undefined,
          preview: {
            declarationFingerprint: FINGERPRINT,
            source: action.source,
            ianaTimezone: action.ianaTimezone,
            affectedRecords: 4,
            existingWallClockRecords: 0,
            unchangedOrderOnlyRecords: 0,
            firstResolvedInstant: "2024-03-10T07:30:00Z",
            lastResolvedInstant: "2024-03-10T08:20:00Z",
            dstGapCount: 1,
            dstFoldCount: 0,
            unsupportedTimestampCount: 0,
            zoneAbbreviationMismatchCount: 0,
            outOfRangeCount: 0,
            samples: [
              {
                ordinal: 3,
                outcome: "resolved",
                rawTimestamp: "2024-03-10 01:30:00",
                normalizedInstant: "2024-03-10T07:30:00Z",
                utcOffsetSeconds: -21600,
                unresolvedReason: null,
                excerpt: "batch worker starting scheduled sweep",
              },
              {
                ordinal: 5,
                outcome: "unresolved",
                rawTimestamp: "2024-03-10 02:30:00",
                normalizedInstant: null,
                utcOffsetSeconds: null,
                unresolvedReason: "nonexistent_dst_gap",
                excerpt: "batch worker heartbeat late",
              },
            ],
          },
        };
      }
      case "apply": {
        requireFresh(action.expectedRevision);
        const previous = this.state.revision;
        this.state.revision += 1;
        this.state.declarations = {
          [action.source]: {
            source: action.source,
            ianaTimezone: action.ianaTimezone,
            basis: "user_declared",
            declaredAt: action.declaredAt,
            appliedRevision: this.state.revision,
          },
        };
        this.state.unresolved = 1;
        this.state.resolved = 4;
        return {
          ...base(),
          revision: {
            previousRevision: previous,
            appliedRevision: this.state.revision,
            restoredRevision: null,
            changedRecords: 4,
            eventCount: 8,
          },
        };
      }
      case "clear": {
        requireFresh(action.expectedRevision);
        const previous = this.state.revision;
        this.state.revision += 1;
        this.state.declarations = {};
        this.state.unresolved = 5;
        this.state.resolved = 0;
        return {
          ...base(),
          revision: {
            previousRevision: previous,
            appliedRevision: this.state.revision,
            restoredRevision: null,
            changedRecords: 4,
            eventCount: 8,
          },
        };
      }
      case "undo": {
        requireFresh(action.expectedRevision);
        const previous = this.state.revision;
        this.state.revision += 1;
        this.state.declarations = {
          [SOURCE]: {
            source: SOURCE,
            ianaTimezone: "America/Chicago",
            basis: "user_declared",
            declaredAt: 1_710_093_600,
            appliedRevision: this.state.revision,
          },
        };
        this.state.unresolved = 1;
        this.state.resolved = 4;
        return {
          ...base(),
          revision: {
            previousRevision: previous,
            appliedRevision: this.state.revision,
            restoredRevision: previous - 1,
            changedRecords: 4,
            eventCount: 8,
          },
        };
      }
    }
  }
}

class FakeAudit implements Pick<AuditStore, "append"> {
  entries: { identity: string; action: string; outcome: string }[] = [];
  async append(entry: {
    identity: string;
    action: string;
    target?: string | null;
    origin?: string | null;
    outcome: string;
  }): Promise<void> {
    this.entries.push({
      identity: entry.identity,
      action: entry.action,
      outcome: entry.outcome,
    });
  }
}

interface HarnessOptions {
  snapshots?: { id: string; createdAt: string }[];
  runs?: { id: string; snapshotId: string | null; createdAt: string }[];
  files?: { relativePath: string; contentBase64: string }[];
}

function harness(options: HarnessOptions = {}) {
  const store = new MemoryLogTimeStore();
  const bridge = new FakeBridge();
  const audit = new FakeAudit();
  const timeline: { kind: string; payload: Record<string, unknown> }[] = [];
  let clock = Date.parse("2024-03-11T12:00:00Z");

  const cases: LogTimeCasePort = {
    async getCase(id) {
      return id === CASE_ID ? { id } : null;
    },
    async listSnapshotsForCase() {
      return options.snapshots ?? [];
    },
    async listTriageRunsForCase() {
      return options.runs ?? [];
    },
    async listCorpusFilesForCase() {
      return (
        options.files ?? [
          { relativePath: SOURCE, contentBase64: Buffer.from("synthetic\n").toString("base64") },
        ]
      );
    },
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline(_caseId, event) {
      timeline.push({ kind: event.kind, payload: event.payload });
      return undefined;
    },
  };

  const service = new LogTimeService({
    store,
    bridge,
    cases,
    audit: audit as unknown as AuditStore,
    now: () => new Date((clock += 1000)),
  });
  return { service, store, bridge, audit, timeline };
}

async function built(options: HarnessOptions = {}) {
  const h = harness(options);
  await h.service.buildCorpus(CASE_ID, ACTOR);
  return h;
}

describe("workbench host events", () => {
  it("asks the host for corpus events without a search query", async () => {
    const { service, bridge } = await built();
    const listed = await service.listWorkbenchEvents(CASE_ID);
    expect(listed).not.toBeNull();
    expect(bridge.calls.some((call) => call.kind === "events")).toBe(true);
  });
});

function applyRequest(expectedRevision: number, key = "apply-worker-0001") {
  return {
    schemaId: "cd-collab.log_time_apply_request.v1",
    source: SOURCE,
    ianaTimezone: "America/Chicago",
    expectedRevision,
    declarationFingerprint: FINGERPRINT,
    idempotencyKey: key,
  };
}

describe("case-bound log corpus", () => {
  it("reports no corpus and no outstanding review before one is built", async () => {
    const { service } = harness();
    const state = await service.getState(CASE_ID);
    expect(state.corpusId).toBeNull();
    expect(state.corpusRevision).toBe(0);
    expect(state.sources).toEqual([]);
    expect(state.reviewOutstanding).toBe(false);
  });

  it("builds a durable corpus that starts with no declaration at all", async () => {
    const { service, store } = await built();
    const state = await service.getState(CASE_ID);

    expect(state.corpusId).toBe(CORPUS_ID);
    expect(state.sources[0]?.declaration).toBeNull();
    expect(state.sources[0]?.unresolvedLocalRecords).toBe(5);
    expect(state.reviewOutstanding).toBe(true);
    expect(await store.listDeclarations(CASE_ID)).toEqual([]);
  });

  it("refuses to rebuild over an existing corpus", async () => {
    const { service } = await built();
    await expect(service.buildCorpus(CASE_ID, ACTOR)).rejects.toBeInstanceOf(
      LogTimeConflictError,
    );
  });

  it("refuses to build a corpus from a case with no committed log files", async () => {
    const h = harness({ files: [] });
    await expect(h.service.buildCorpus(CASE_ID, ACTOR)).rejects.toBeInstanceOf(
      LogTimeRequestError,
    );
  });

  it("fails closed on every review operation before a corpus exists", async () => {
    const { service } = harness();
    await expect(
      service.preview(CASE_ID, {
        schemaId: "cd-collab.log_time_preview_request.v1",
        source: SOURCE,
        ianaTimezone: "America/Chicago",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(LogTimeNotFoundError);
    await expect(
      service.apply(CASE_ID, ACTOR, applyRequest(1)),
    ).rejects.toBeInstanceOf(LogTimeNotFoundError);
  });
});

describe("preview", () => {
  it("returns DST reporting and raw-beside-normalized samples without mutating", async () => {
    const { service, store } = await built();
    const preview = await service.preview(CASE_ID, {
      schemaId: "cd-collab.log_time_preview_request.v1",
      source: SOURCE,
      ianaTimezone: "America/Chicago",
      expectedRevision: 1,
    });

    expect(preview.dstGapCount).toBe(1);
    expect(preview.samples[0]?.rawTimestamp).toBe("2024-03-10 01:30:00");
    expect(preview.samples[0]?.normalizedInstant).toBe("2024-03-10T07:30:00Z");
    expect(preview.samples[1]?.unresolvedReason).toBe("nonexistent_dst_gap");

    const corpus = await store.getCorpus(CASE_ID);
    expect(corpus?.corpusRevision).toBe(1);
    expect(await store.listDeclarations(CASE_ID)).toEqual([]);
  });

  it("rejects a zone that is not an IANA identifier before reaching the host", async () => {
    const { service, bridge } = await built();
    const before = bridge.calls.length;
    await expect(
      service.preview(CASE_ID, {
        schemaId: "cd-collab.log_time_preview_request.v1",
        source: SOURCE,
        ianaTimezone: "CST (probably)",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/IANA zone id/);
    expect(bridge.calls.length).toBe(before);
  });
});

describe("apply, clear, undo", () => {
  it("records the declaration with the fingerprint and identity that decided it", async () => {
    const { service, store } = await built();
    const outcome = await service.apply(CASE_ID, ACTOR, applyRequest(1));

    expect(outcome.operation).toBe("apply");
    expect(outcome.appliedRevision).toBe(2);
    expect(outcome.changedRecords).toBe(4);
    expect(outcome.declarations[0]?.declarationFingerprint).toBe(FINGERPRINT);
    expect(outcome.declarations[0]?.declaredBy).toBe(ACTOR.id);
    expect(outcome.declarations[0]?.basis).toBe("user_declared");

    const corpus = await store.getCorpus(CASE_ID);
    expect(corpus?.corpusRevision).toBe(2);
    expect(corpus?.undoableRevision).toBe(1);
  });

  it("keeps the unresolvable line as order-only evidence after applying", async () => {
    const { service } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    const state = await service.getState(CASE_ID);

    expect(state.sources[0]?.resolvedLocalRecords).toBe(4);
    expect(state.sources[0]?.unresolvedLocalRecords).toBe(1);
    expect(state.reviewOutstanding).toBe(true);
  });

  it("fails closed when the caller's revision has moved", async () => {
    const { service } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    await expect(
      service.apply(CASE_ID, ACTOR, applyRequest(1, "apply-worker-0002")),
    ).rejects.toBeInstanceOf(LogTimeConflictError);
  });

  it("replays an identical retry without publishing a second revision", async () => {
    const { service, store } = await built();
    const first = await service.apply(CASE_ID, ACTOR, applyRequest(1));
    const second = await service.apply(CASE_ID, ACTOR, applyRequest(1));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.appliedRevision).toBe(first.appliedRevision);
    expect((await store.getCorpus(CASE_ID))?.corpusRevision).toBe(2);
  });

  it("refuses to reuse an idempotency key for a different request", async () => {
    const { service } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    await expect(
      service.apply(CASE_ID, ACTOR, {
        ...applyRequest(2),
        ianaTimezone: "Europe/Berlin",
      }),
    ).rejects.toBeInstanceOf(LogTimeConflictError);
  });

  it("clearing returns the source to order-only and drops the declaration", async () => {
    const { service, store } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    const outcome = await service.clear(CASE_ID, ACTOR, {
      schemaId: "cd-collab.log_time_clear_request.v1",
      source: SOURCE,
      expectedRevision: 2,
      idempotencyKey: "clear-worker-0001",
    });

    expect(outcome.operation).toBe("clear");
    expect(outcome.appliedRevision).toBe(3);
    expect(outcome.declarations).toEqual([]);
    expect(await store.listDeclarations(CASE_ID)).toEqual([]);

    const state = await service.getState(CASE_ID);
    expect(state.sources[0]?.unresolvedLocalRecords).toBe(5);
    expect(state.sources[0]?.declaration).toBeNull();
  });

  it("undo advances the revision and names the earlier one it restored", async () => {
    const { service } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    await service.clear(CASE_ID, ACTOR, {
      schemaId: "cd-collab.log_time_clear_request.v1",
      source: SOURCE,
      expectedRevision: 2,
      idempotencyKey: "clear-worker-0001",
    });
    const outcome = await service.undo(CASE_ID, ACTOR, {
      schemaId: "cd-collab.log_time_undo_request.v1",
      expectedRevision: 3,
      idempotencyKey: "undo-worker-0001",
    });

    expect(outcome.operation).toBe("undo");
    expect(outcome.previousRevision).toBe(3);
    expect(outcome.appliedRevision).toBe(4);
    expect(outcome.restoredRevision).toBe(2);
    expect(outcome.declarations).toHaveLength(1);
  });

  it("keeps the original preview fingerprint on a declaration undo restores", async () => {
    const { service } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    await service.clear(CASE_ID, ACTOR, {
      schemaId: "cd-collab.log_time_clear_request.v1",
      source: SOURCE,
      expectedRevision: 2,
      idempotencyKey: "clear-worker-0001",
    });
    const outcome = await service.undo(CASE_ID, ACTOR, {
      schemaId: "cd-collab.log_time_undo_request.v1",
      expectedRevision: 3,
      idempotencyKey: "undo-worker-0001",
    });

    // The clear removed the durable row, so the restored declaration has no
    // fingerprint we can vouch for. It must be marked, not invented.
    expect(outcome.declarations[0]?.declarationFingerprint).toBe("0".repeat(64));
  });

  it("audits every durable change", async () => {
    const { service, audit } = await built();
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "log_corpus_build",
      "log_time_apply",
    ]);
    expect(audit.entries.every((entry) => entry.outcome === "success")).toBe(true);
  });
});

describe("dependent snapshots and runs", () => {
  const AFTER_BUILD = "2024-03-11T13:00:00Z";
  const BEFORE_BUILD = "2020-01-01T00:00:00Z";

  it("revises a snapshot frozen under the superseded basis and invalidates its run", async () => {
    const { service } = await built({
      snapshots: [{ id: "snapshot-synthetic-0001", createdAt: AFTER_BUILD }],
      runs: [
        {
          id: "run-synthetic-0001",
          snapshotId: "snapshot-synthetic-0001",
          createdAt: AFTER_BUILD,
        },
      ],
    });
    const outcome = await service.apply(CASE_ID, ACTOR, applyRequest(1));

    const snapshot = outcome.dependents.find((d) => d.kind === "snapshot");
    const run = outcome.dependents.find((d) => d.kind === "triage_run");
    expect(snapshot?.disposition).toBe("revised");
    expect(snapshot?.observedRevision).toBe(1);
    expect(run?.disposition).toBe("invalidated");
    // The snapshot's bytes never changed, so it is never called invalid.
    expect(snapshot?.reason).toMatch(/files themselves have not changed/);
    expect(run?.reason).toMatch(/no longer current/);
  });

  it("says unknown_basis rather than guessing for work that predates the corpus", async () => {
    const { service } = await built({
      snapshots: [{ id: "snapshot-synthetic-0002", createdAt: BEFORE_BUILD }],
      runs: [
        {
          id: "run-synthetic-0002",
          snapshotId: "snapshot-synthetic-0002",
          createdAt: BEFORE_BUILD,
        },
      ],
    });
    const outcome = await service.apply(CASE_ID, ACTOR, applyRequest(1));

    for (const dependent of outcome.dependents) {
      expect(dependent.disposition).toBe("unknown_basis");
      expect(dependent.observedRevision).toBeNull();
    }
  });

  it("marks a run with no snapshot binding as unknown_basis, never unaffected", async () => {
    const { service } = await built({
      runs: [
        { id: "run-synthetic-0003", snapshotId: null, createdAt: AFTER_BUILD },
      ],
    });
    const outcome = await service.apply(CASE_ID, ACTOR, applyRequest(1));
    expect(outcome.dependents[0]?.disposition).toBe("unknown_basis");
  });

  it("marks nothing when a change rewrote no timestamps", async () => {
    const h = await built({
      snapshots: [{ id: "snapshot-synthetic-0004", createdAt: AFTER_BUILD }],
    });
    // A no-op host revision: the corpus advanced but no timestamp moved.
    const original = h.bridge.run.bind(h.bridge);
    h.bridge.run = async (caseId, action) => {
      const result = await original(caseId, action);
      if (result.revision) result.revision.changedRecords = 0;
      return result;
    };
    const outcome = await h.service.apply(CASE_ID, ACTOR, applyRequest(1));
    expect(outcome.dependents).toEqual([]);
  });

  it("surfaces the latest disposition per dependent on the review surface", async () => {
    const { service } = await built({
      snapshots: [{ id: "snapshot-synthetic-0001", createdAt: AFTER_BUILD }],
    });
    await service.apply(CASE_ID, ACTOR, applyRequest(1));
    await service.clear(CASE_ID, ACTOR, {
      schemaId: "cd-collab.log_time_clear_request.v1",
      source: SOURCE,
      expectedRevision: 2,
      idempotencyKey: "clear-worker-0001",
    });

    const dependents = await service.listDependents(CASE_ID);
    expect(dependents).toHaveLength(1);
    expect(dependents[0]?.disposition).toBe("revised");
  });

  it("records the timeline entry a reviewer reads after a change", async () => {
    const { service, timeline } = await built({
      snapshots: [{ id: "snapshot-synthetic-0001", createdAt: AFTER_BUILD }],
      runs: [
        {
          id: "run-synthetic-0001",
          snapshotId: "snapshot-synthetic-0001",
          createdAt: AFTER_BUILD,
        },
      ],
    });
    await service.apply(CASE_ID, ACTOR, applyRequest(1));

    const entry = timeline.find((item) => item.kind === "log_time_apply");
    expect(entry?.payload.revisedSnapshots).toBe(1);
    expect(entry?.payload.invalidatedRuns).toBe(1);
  });
});
