/**
 * Timezone review, end to end, against the Log workbench overlay.
 *
 * This is the join the overlay exists to serve: a responder previews a zone for
 * one source, applies it, and the workbench must then read the corpus under the
 * revision that apply produced — not the one before it, and not a mixture. The
 * two services are wired here exactly as `index.ts` wires them, so the binding
 * this proves is the binding production uses.
 *
 * The host is scripted. Every timestamp decision in the real system belongs to
 * `contextdesk collab-log-time`; nothing here does timestamp math, and nothing
 * here touches a provider, a network, or real case data.
 */
import { describe, expect, it } from "vitest";
import { LOG_TIME_APPLY_REQUEST_SCHEMA_ID, LOG_TIME_PREVIEW_REQUEST_SCHEMA_ID } from "@cd-collab/contracts";
import { MemoryAuditStore, type AuditStore } from "../audit/index.js";
import {
  LogTimeConflictError,
  LogTimeService,
  MemoryLogTimeStore,
  type HostResult,
  type LogTimeAction,
  type LogTimeBridge,
  type LogTimeCasePort,
} from "../log-time/index.js";
import { MemoryWorkbenchStore } from "./store.js";
import {
  WorkbenchConflictError,
  WorkbenchService,
  type WorkbenchCasePort,
} from "./service.js";

const CASE_ID = "11111111-2222-4333-8444-555555555555";
const ACTOR = { id: "analyst-synthetic-01", username: "analyst-synthetic-01" };
const SOURCE = "worker/batch.log";
const EVIDENCE = "22222222-2222-4222-8222-222222222222";
const CORPUS_ID = "corpus-synthetic-0001";
const FINGERPRINT = "a".repeat(64);
const DIGEST = "c".repeat(64);
const ZONE = "America/Chicago";

/** Bare local calendar times: unreadable as instants until a zone is declared. */
const WORKER_LOG = [
  "2024-03-10 01:30:00 INFO  batch worker starting scheduled sweep",
  "2024-03-10 03:05:00 ERROR batch worker sweep failed retry 1",
  "",
].join("\n");

/** The instants the host reports once the zone is applied. */
const RESOLVED = {
  "2024-03-10 01:30:00": 1_710_055_800,
  "2024-03-10 03:05:00": 1_710_061_500,
} as const;

/**
 * A scripted `contextdesk collab-log-time`.
 *
 * It reproduces the two behaviours everything downstream leans on: revisions
 * only move forward, and a stale expected revision is refused rather than
 * applied. Before a zone is declared its events are order-only; afterwards they
 * carry wall-clock instants, which is what the workbench overlay reads.
 */
class ScriptedHost implements LogTimeBridge {
  revision = 1;
  applied = false;
  declarations: HostResult["declarations"] = {};

  async run(caseId: string, action: LogTimeAction): Promise<HostResult> {
    const base = (): HostResult => ({
      caseId,
      corpusId: CORPUS_ID,
      corpusRevision: this.revision,
      sources: [
        {
          source: SOURCE,
          unresolvedLocalRecords: this.applied ? 0 : 2,
          resolvedLocalRecords: this.applied ? 2 : 0,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        },
      ],
      declarations: this.declarations,
    });
    const requireFresh = (expected: number): void => {
      if (expected !== this.revision) {
        throw new LogTimeConflictError(
          `stale timezone apply: expected revision ${expected}, current ${this.revision}`,
        );
      }
    };

    switch (action.kind) {
      case "build":
        return {
          ...base(),
          build: {
            corpusName: "synthetic",
            eventsImported: 2,
            sourcesSelected: 1,
            sourcesFailed: 0,
            partial: false,
            timezoneAmbiguousSources: [SOURCE],
          },
        };
      case "status":
        return base();
      case "preview":
        requireFresh(action.expectedRevision);
        return {
          ...base(),
          preview: {
            declarationFingerprint: FINGERPRINT,
            source: action.source,
            ianaTimezone: action.ianaTimezone,
            affectedRecords: 2,
            existingWallClockRecords: 0,
            unchangedOrderOnlyRecords: 0,
            firstResolvedInstant: "2024-03-10T07:30:00Z",
            lastResolvedInstant: "2024-03-10T09:05:00Z",
            dstGapCount: 0,
            dstFoldCount: 0,
            unsupportedTimestampCount: 0,
            zoneAbbreviationMismatchCount: 0,
            outOfRangeCount: 0,
            samples: [
              {
                ordinal: 1,
                outcome: "resolved",
                rawTimestamp: "2024-03-10 01:30:00",
                normalizedInstant: "2024-03-10T07:30:00Z",
                utcOffsetSeconds: -21_600,
                unresolvedReason: null,
                excerpt: "batch worker starting scheduled sweep",
              },
            ],
          },
        };
      case "apply": {
        requireFresh(action.expectedRevision);
        const previous = this.revision;
        this.revision += 1;
        this.applied = true;
        this.declarations = {
          [action.source]: {
            source: action.source,
            ianaTimezone: action.ianaTimezone,
            basis: "user_declared",
            declaredAt: action.declaredAt,
            appliedRevision: this.revision,
          },
        };
        return {
          ...base(),
          revision: {
            previousRevision: previous,
            appliedRevision: this.revision,
            restoredRevision: null,
            changedRecords: 2,
            eventCount: 2,
          },
        };
      }
      case "chronology":
        return {
          ...base(),
          chronology: {
            corpusRevision: this.revision,
            rows: Object.entries(RESOLVED).map(([raw, ts], index) => ({
              seq: index,
              source: SOURCE,
              rawTimestamp: raw,
              normalizedInstant: this.applied ? new Date(ts * 1000).toISOString() : null,
              timeState: this.applied ? ("resolved" as const) : ("order_only" as const),
              timestampProvenance: this.applied
                ? ("resolved_local" as const)
                : ("unresolved_local" as const),
              orderOnlyReason: this.applied ? null : ("timezone_unresolved" as const),
              level: "info",
              message: `batch worker record ${index}`,
            })),
            nextCursor: null,
            totalMatched: 2,
            orderOnlyCount: this.applied ? 0 : 2,
            timeQuality: this.applied ? "wall" : "order_only",
          },
        };
      case "events":
      case "search":
        return {
          ...base(),
          search: {
            bounded: false,
            atLeast: 2,
            returned: 2,
            partial: false,
            cancelled: false,
            diagnostic: null,
            hits: Object.entries(RESOLVED).map(([raw, ts], index) => ({
              seq: index,
              source: SOURCE,
              message: `batch worker record ${index}`,
              level: "info",
              ts: this.applied ? ts : index,
              // Before a zone is declared the host reports order only, so the
              // overlay must not hand the workbench a UTC instant.
              timeQuality: this.applied ? "wall clock" : "order only (not calendar time)",
              unresolvedLocalTimestamp: raw,
              excerpt: null,
            })),
          },
        };
      default:
        return base();
    }
  }
}

function harness(options: { snapshots?: { id: string; createdAt: string }[] } = {}) {
  const logTimeStore = new MemoryLogTimeStore();
  const host = new ScriptedHost();
  const audit: AuditStore = new MemoryAuditStore();

  const logTimeCases: LogTimeCasePort = {
    async getCase(id) {
      return id === CASE_ID ? { id } : null;
    },
    async listSnapshotsForCase() {
      return options.snapshots ?? [];
    },
    async listTriageRunsForCase() {
      return [];
    },
    async listCorpusFilesForCase() {
      return [{ relativePath: SOURCE, contentBase64: Buffer.from(WORKER_LOG).toString("base64") }];
    },
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline() {
      return undefined;
    },
  };
  const logTime = new LogTimeService({
    store: logTimeStore,
    bridge: host,
    cases: logTimeCases,
    audit,
    now: () => new Date("2024-03-11T12:00:00Z"),
  });

  // Wired exactly as `index.ts` wires them.
  const workbenchCases: WorkbenchCasePort = {
    async getCase(id) {
      return id === CASE_ID ? { id } : null;
    },
    async listEvidenceFiles() {
      return [
        {
          evidenceId: EVIDENCE,
          relativePath: SOURCE,
          digest: DIGEST,
          intakeBatchId: null,
          privacyClass: "owner_only",
          text: WORKER_LOG,
        },
      ];
    },
    async currentNormalizationRevision(id) {
      return (await logTimeStore.getCorpus(id))?.corpusRevision ?? null;
    },
    async listHostEventStamps(id) {
      const listed = await logTime.listWorkbenchEvents(id);
      if (!listed) return null;
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
    },
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline() {
      return undefined;
    },
  };
  const workbench = new WorkbenchService({
    store: new MemoryWorkbenchStore(),
    cases: workbenchCases,
    audit,
  });
  return { logTime, workbench, host };
}

const applyRequest = (expectedRevision: number, idempotencyKey = "apply-worker-0001") => ({
  schemaId: LOG_TIME_APPLY_REQUEST_SCHEMA_ID,
  source: SOURCE,
  ianaTimezone: ZONE,
  expectedRevision,
  declarationFingerprint: FINGERPRINT,
  idempotencyKey,
});

describe("preview to apply to chronology to freeze", () => {
  it("binds the workbench overlay to the revision the apply produced", async () => {
    const { logTime, workbench } = harness();
    await logTime.buildCorpus(CASE_ID, ACTOR);

    // Before the zone is declared the corpus reads as order-only, and the
    // workbench must show local text with no invented instant.
    const before = await workbench.chronology(CASE_ID, ACTOR, false, "file", []);
    expect(before.expectedNormalizationRevision).toBe(1);
    expect(before.events.every((event) => event.normalizedUtc === null)).toBe(true);

    // Preview never moves the corpus.
    const preview = await logTime.preview(CASE_ID, {
      schemaId: LOG_TIME_PREVIEW_REQUEST_SCHEMA_ID,
      source: SOURCE,
      ianaTimezone: ZONE,
      expectedRevision: 1,
    });
    expect(preview.corpusRevision).toBe(1);
    expect(preview.declarationFingerprint).toBe(FINGERPRINT);
    expect((await logTime.getState(CASE_ID)).corpusRevision).toBe(1);

    // Apply moves it forward exactly once.
    const outcome = await logTime.apply(CASE_ID, ACTOR, applyRequest(1));
    expect(outcome.previousRevision).toBe(1);
    expect(outcome.appliedRevision).toBe(2);
    expect(outcome.replayed).toBe(false);

    // The chronology now reads as normalized wall-clock time under revision 2.
    const after = await workbench.chronology(CASE_ID, ACTOR, false, "file", []);
    expect(after.expectedNormalizationRevision).toBe(2);
    const normalized = after.events
      .map((event) => event.normalizedUtc)
      .filter((value): value is string => value !== null);
    expect(normalized).toHaveLength(2);
    expect(normalized).toEqual([...normalized].sort());
    expect(normalized[0]).toBe(new Date(RESOLVED["2024-03-10 01:30:00"] * 1000).toISOString());

    // A reader still holding revision 1 is refused rather than served rows from
    // a corpus that has moved on.
    await expect(
      workbench.search(CASE_ID, ACTOR, false, {
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query: "batch worker",
        mode: "case_insensitive",
        filters: {
          includeTerms: [],
          excludeTerms: [],
          severity: null,
          component: null,
          file: null,
          rotationFamily: null,
          timeFrom: null,
          timeTo: null,
          evidenceIds: [],
        },
        contextBefore: 0,
        contextAfter: 0,
        cursor: 0,
        limit: 20,
        expectedNormalizationRevision: 1,
      }),
    ).rejects.toBeInstanceOf(WorkbenchConflictError);
  });

  it("tells a frozen evidence set which basis it was frozen under", async () => {
    // Frozen after the corpus was built, so its basis is on record and the
    // apply supersedes it.
    const { logTime } = harness({
      snapshots: [{ id: "snapshot-synthetic-0001", createdAt: "2024-03-11T13:00:00Z" }],
    });
    await logTime.buildCorpus(CASE_ID, ACTOR);
    const outcome = await logTime.apply(CASE_ID, ACTOR, applyRequest(1));

    const snapshot = outcome.dependents.find((row) => row.kind === "snapshot");
    expect(snapshot?.disposition).toBe("revised");
    // `observedRevision` is the revision the freeze actually read under — the
    // one the apply superseded, not the one that replaced it.
    expect(snapshot?.observedRevision).toBe(1);
    expect(outcome.appliedRevision).toBe(2);
    expect(snapshot?.reason).toMatch(/needs a fresh look/);

    const dependents = await logTime.listDependents(CASE_ID);
    expect(dependents.find((row) => row.id === "snapshot-synthetic-0001")?.disposition).toBe(
      "revised",
    );
  });

  it("replays an apply idempotently without moving the revision again", async () => {
    const { logTime, workbench } = harness();
    await logTime.buildCorpus(CASE_ID, ACTOR);
    const first = await logTime.apply(CASE_ID, ACTOR, applyRequest(1));
    const replay = await logTime.apply(CASE_ID, ACTOR, applyRequest(1));
    expect(first.appliedRevision).toBe(2);
    expect(replay.appliedRevision).toBe(2);
    expect(replay.replayed).toBe(true);
    const chronology = await workbench.chronology(CASE_ID, ACTOR, false, "file", []);
    expect(chronology.expectedNormalizationRevision).toBe(2);
  });

  it("refuses a second apply that still believes the old revision", async () => {
    const { logTime } = harness();
    await logTime.buildCorpus(CASE_ID, ACTOR);
    await logTime.apply(CASE_ID, ACTOR, applyRequest(1));
    await expect(
      logTime.apply(CASE_ID, ACTOR, applyRequest(1, "apply-worker-0002")),
    ).rejects.toBeInstanceOf(LogTimeConflictError);
    expect((await logTime.getState(CASE_ID)).corpusRevision).toBe(2);
  });
});
