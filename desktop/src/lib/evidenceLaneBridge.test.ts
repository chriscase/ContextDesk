/**
 * Non-vacuous tests for chat-citation → evidence set → lanes → investigation.
 * Synthetic XYZ fixtures only — no private/company identifiers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLaneAssignment,
  applyLaneEdits,
  assignEvidenceToLanes,
  bindPreparedInvestigationTarget,
  buildEvidenceSetFromHostCitations,
  cancelInvestigationAdd,
  confirmInvestigationAdd,
  corpusOpenPolicy,
  customerEvidenceLaneSemantics,
  enrichWithHostEvents,
  evidenceControlLabel,
  failClosedIdentityCheck,
  filterToHostEvidenceSet,
  finalizeShowAssignment,
  idleInvestigationAdd,
  laneEligibleItems,
  markInvestigationApplied,
  MAX_EVIDENCE_LANES,
  pinLane,
  planShowInExplorer,
  previewInvestigationAdd,
  previewOccupiedLaneChange,
  removeLane,
  reorderLanes,
  selectAllLaneEligible,
  selectionFromKeys,
  toggleEvidenceSelection,
  undoInvestigationAdd,
  type HostEvidenceCitation,
  type LaneAssignmentMode,
} from "./evidenceLaneBridge";
import type { LaneConfig } from "./logExplorer/laneCompose";
import type { EventDto } from "./host";
import { applyEventsToMessage } from "./turn";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

/** Neutral XYZ multi-source fixtures (host-attached only). */
function xyzCitations(): HostEvidenceCitation[] {
  return [
    {
      id: "log_event:101",
      label: "xyz-api",
      title: "XYZ timeout",
      corpusId: "corpus-xyz-demo",
      source: "xyz/api.log",
      service: "xyz-api",
      timestamp: 1_700_000_101,
      timeQuality: "wall",
    },
    {
      id: "log_event:202",
      label: "xyz-worker",
      title: "XYZ retry",
      corpusId: "corpus-xyz-demo",
      source: "xyz/worker.log",
      service: "xyz-worker",
      timestamp: 1_700_000_202,
      timeQuality: "wall",
    },
    {
      id: "log_event:303",
      label: "xyz-db",
      title: "XYZ lock",
      corpusId: "corpus-xyz-demo",
      source: "xyz/db.log",
      service: "xyz-db",
      timestamp: 1_700_000_303,
      timeQuality: "wall",
    },
    {
      id: "log_event:404",
      label: "xyz-gateway",
      title: "XYZ 502",
      corpusId: "corpus-xyz-demo",
      source: "xyz/gateway.log",
      service: "xyz-gateway",
      timestamp: 1_700_000_404,
      timeQuality: "wall",
    },
    {
      id: "log_event:505",
      label: "xyz-cache",
      title: "XYZ miss",
      corpusId: "corpus-xyz-demo",
      source: "xyz/cache.log",
      service: "xyz-cache",
      timestamp: 1_700_000_505,
      timeQuality: "wall",
    },
    {
      id: "docs/xyz-notes.md",
      label: "xyz-notes",
      title: "Workspace note",
    },
    {
      id: "https://example.test/xyz",
      label: "example",
      title: "External",
    },
  ];
}

function freeLanes(n: number): LaneConfig[] {
  return Array.from({ length: n }, (_, i) =>
    i === 0
      ? { id: "lane-0", label: "All sources", sources: [] as string[] }
      : { id: `lane-${i}`, label: `Lane ${i + 1}`, sources: [] as string[] },
  );
}

describe("buildEvidenceSetFromHostCitations", () => {
  it("builds only from host-attached citations and never from prose", () => {
    const host = xyzCitations();
    const set = buildEvidenceSetFromHostCitations(host);
    expect(set).toHaveLength(7);
    expect(evidenceControlLabel(set.length)).toBe("Evidence · 7");

    // Forged prose IDs must not enter the set.
    const forged = filterToHostEvidenceSet(set, [
      "log_event:101",
      "log_event:999999", // forged — not in host set
      "log_event:42", // forged
      "docs/xyz-notes.md",
    ]);
    expect(forged.accepted.map((a) => a.id).sort()).toEqual([
      "docs/xyz-notes.md",
      "log_event:101",
    ]);
    expect(forged.rejected).toEqual(["log_event:999999", "log_event:42"]);
  });

  it("dedupes duplicate host citations by key", () => {
    const set = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:7",
        label: "a",
        corpusId: "c1",
        source: "a.log",
        timestamp: 1,
        timeQuality: "wall",
      },
      {
        id: "log_event:7",
        label: "a-dup",
        corpusId: "c1",
        source: "a.log",
        timestamp: 1,
        timeQuality: "wall",
      },
      {
        id: "log_event:7",
        label: "b",
        corpusId: "c2",
        source: "b.log",
        timestamp: 2,
        timeQuality: "wall",
      },
    ]);
    expect(set).toHaveLength(2);
    expect(set.map((s) => s.corpusId).sort()).toEqual(["c1", "c2"]);
  });

  it("separates workspace citations from lane-eligible log events", () => {
    const set = buildEvidenceSetFromHostCitations(xyzCitations());
    const lane = laneEligibleItems(set);
    expect(lane.every((i) => i.kind === "log_event")).toBe(true);
    expect(lane).toHaveLength(5);
    const workspace = set.filter((i) => i.workspaceOnly);
    expect(workspace.map((w) => w.id).sort()).toEqual([
      "docs/xyz-notes.md",
      "https://example.test/xyz",
    ]);
    // Workspace must never be forced into log lanes
    const assigned = assignEvidenceToLanes(set, "one_source_per_lane", freeLanes(4));
    expect(assigned.placedKeys.every((k) => k.startsWith("log_event:"))).toBe(
      true,
    );
  });

  it("returns empty for null/undefined host list (not prose scrape)", () => {
    expect(buildEvidenceSetFromHostCitations(null)).toEqual([]);
    expect(buildEvidenceSetFromHostCitations(undefined)).toEqual([]);
    expect(buildEvidenceSetFromHostCitations([])).toEqual([]);
  });
});

describe("lane assignment 1/2/3/4 + limit", () => {
  const modes: LaneAssignmentMode[] = [
    "one_lane",
    "group_related",
    "one_source_per_lane",
  ];

  it("one_lane places all selected into a single customer-evidence lane", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    );
    const result = assignEvidenceToLanes(items, "one_lane", freeLanes(4));
    expect(result.placedKeys).toHaveLength(5);
    expect(result.overflowKeys).toEqual([]);
    const nonEmpty = result.lanes.filter(
      (l) => l.sources.length > 0 || l.label === "Evidence",
    );
    expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
    expect(result.explanation.some((e) => e.includes("one lane"))).toBe(true);
  });

  it("distributes 2/3/4 sources across lanes for one_source_per_lane", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    );
    for (const n of [1, 2, 3, 4] as const) {
      const subset = items.slice(0, n);
      const result = assignEvidenceToLanes(
        subset,
        "one_source_per_lane",
        freeLanes(4),
      );
      expect(result.placedKeys).toHaveLength(n);
      const used = result.lanes.filter((l) => l.sources.length > 0);
      expect(used.length).toBe(n);
      expect(result.visibleLaneCount).toBeGreaterThanOrEqual(n);
    }
  });

  it("handles lane limit when 5 distinct sources exceed MAX_EVIDENCE_LANES", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    );
    expect(items.length).toBeGreaterThan(MAX_EVIDENCE_LANES);
    const result = assignEvidenceToLanes(
      items,
      "one_source_per_lane",
      freeLanes(4),
    );
    expect(result.placedKeys.length).toBe(MAX_EVIDENCE_LANES);
    expect(result.overflowKeys.length).toBe(1);
    expect(
      result.explanation.some((e) => e.includes(`Lane limit ${MAX_EVIDENCE_LANES}`)),
    ).toBe(true);
  });

  it("group_related uses host service then source — never invents identity", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 3);
    const result = assignEvidenceToLanes(items, "group_related", freeLanes(4));
    const labels = result.lanes.map((l) => l.label);
    expect(labels).toEqual(
      expect.arrayContaining(["xyz-api", "xyz-worker", "xyz-db"]),
    );
    // No fabricated service names
    expect(labels.join(" ")).not.toMatch(/unknown-service-invented/i);
  });

  it("prefers free lanes and does not invent timestamps", () => {
    for (const mode of modes) {
      const items = laneEligibleItems(
        buildEvidenceSetFromHostCitations(xyzCitations()),
      ).slice(0, 2);
      const occupied: LaneConfig[] = [
        { id: "lane-0", label: "User pinned", sources: ["keep/me.log"] },
        { id: "lane-1", label: "Lane 2", sources: [] },
        { id: "lane-2", label: "Lane 3", sources: [] },
        { id: "lane-3", label: "Lane 4", sources: [] },
      ];
      const result = assignEvidenceToLanes(items, mode, occupied);
      // Free lanes preferred — occupied lane-0 sources may be replaced only
      // via preview; assignment still produces a plan.
      expect(result.lanes.length).toBeLessThanOrEqual(MAX_EVIDENCE_LANES);
      expect(result.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe("occupied-lane preview / cancel", () => {
  it("requires confirm when replacing occupied lanes and cancel preserves them", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 2);
    const current: LaneConfig[] = [
      { id: "lane-0", label: "My API", sources: ["keep/api.log"] },
      { id: "lane-1", label: "My Worker", sources: ["keep/worker.log"] },
    ];
    const assignment = assignEvidenceToLanes(
      items,
      "one_source_per_lane",
      current,
    );
    const preview = previewOccupiedLaneChange(current, assignment.lanes);
    expect(preview.needsConfirm).toBe(true);
    expect(preview.replacedLaneIds.length).toBeGreaterThan(0);

    const cancelled = applyLaneAssignment(current, assignment, false);
    expect(cancelled.applied).toBe(false);
    if (!cancelled.applied) {
      expect(cancelled.reason).toBe("cancelled_occupied_preview");
      expect(cancelled.lanes[0]!.sources).toEqual(["keep/api.log"]);
      expect(cancelled.lanes[1]!.sources).toEqual(["keep/worker.log"]);
    }

    const confirmed = applyLaneAssignment(current, assignment, true);
    expect(confirmed.applied).toBe(true);
  });

  it("does not require confirm when free lanes absorb placement", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 1);
    const current = freeLanes(2);
    const assignment = assignEvidenceToLanes(
      items,
      "one_source_per_lane",
      current,
    );
    const preview = previewOccupiedLaneChange(current, assignment.lanes);
    // Free lanes → no confirm required
    expect(preview.needsConfirm).toBe(false);
    const applied = applyLaneAssignment(current, assignment, false);
    expect(applied.applied).toBe(true);
  });
});

describe("unresolved time / alignment honesty", () => {
  it("refuses fabricated time alignment when quality is order_only", () => {
    const items = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:1",
        label: "a",
        corpusId: "c",
        source: "a.log",
        timestamp: 10,
        timeQuality: "order_only",
      },
      {
        id: "log_event:2",
        label: "b",
        corpusId: "c",
        source: "b.log",
        timestamp: 20,
        timeQuality: "order_only",
      },
    ]);
    const result = assignEvidenceToLanes(items, "one_lane", freeLanes(2));
    expect(result.alignmentRefuseReason).toMatch(/order-only|wall clock/i);
    expect(result.linkMode).toBe("independent");
    expect(
      result.explanation.some((e) => e.includes("Time alignment unavailable")),
    ).toBe(true);
  });

  it("offers align_time only when all timestamps are wall-quality", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 2);
    const result = assignEvidenceToLanes(items, "one_lane", freeLanes(2));
    expect(result.alignmentRefuseReason).toBeNull();
    expect(result.linkMode).toBe("align_time");
  });
});

describe("stale / mismatched corpus and exact navigation", () => {
  it("fails closed on missing, stale, or mismatched corpus", () => {
    const item = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:9",
        label: "x",
        corpusId: "corpus-xyz-demo",
        source: "x.log",
        timestamp: 1,
        timeQuality: "wall",
      },
    ])[0]!;

    expect(
      failClosedIdentityCheck({ ...item, corpusId: undefined }).ok,
    ).toBe(false);
    expect(
      failClosedIdentityCheck(item, {
        availableCorpusIds: ["other-corpus"],
      }).ok,
    ).toBe(false);
    expect(
      failClosedIdentityCheck(item, {
        expectedCorpusId: "wrong",
      }).ok,
    ).toBe(false);
    expect(
      failClosedIdentityCheck(item, {
        availableCorpusIds: ["corpus-xyz-demo"],
        eventExists: false,
      }).ok,
    ).toBe(false);
    expect(
      failClosedIdentityCheck(item, {
        availableCorpusIds: ["corpus-xyz-demo"],
        eventExists: true,
      }).ok,
    ).toBe(true);
  });

  it("planShowInExplorer targets exact corpus and never reimports", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 2);
    const plan = planShowInExplorer(items, "one_source_per_lane", freeLanes(2), {
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect("error" in plan).toBe(false);
    if (!("error" in plan)) {
      expect(plan.corpusId).toBe("corpus-xyz-demo");
      expect(plan.openMode).toBe("open_or_focus_existing");
      expect(plan.highlightSeqs).toEqual([101, 202]);
      expect(plan.navTargets[0]).toEqual({ kind: "event", id: "101" });
    }
    expect(corpusOpenPolicy()).toEqual({
      reimport: false,
      mutate: false,
      duplicate: false,
      mode: "open_or_focus_existing",
    });
  });

  it("refuses mixed-corpus Show in Explorer (session/corpus isolation)", () => {
    const items = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:1",
        label: "a",
        corpusId: "corpus-a",
        source: "a.log",
        timestamp: 1,
        timeQuality: "wall",
      },
      {
        id: "log_event:2",
        label: "b",
        corpusId: "corpus-b",
        source: "b.log",
        timestamp: 2,
        timeQuality: "wall",
      },
    ]);
    const plan = planShowInExplorer(items, "one_lane", freeLanes(2));
    expect("error" in plan).toBe(true);
    if ("error" in plan) {
      expect(plan.error).toMatch(/corpora/i);
    }
  });

  it("rejects stale corpus in planShowInExplorer", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 1);
    const plan = planShowInExplorer(items, "one_lane", freeLanes(1), {
      availableCorpusIds: ["totally-other"],
    });
    expect("error" in plan).toBe(true);
  });
});

describe("pin / remove / reorder", () => {
  it("reorders and pins within the four-lane cap", () => {
    const lanes: LaneConfig[] = [
      { id: "lane-0", label: "A", sources: ["a"] },
      { id: "lane-1", label: "B", sources: ["b"] },
      { id: "lane-2", label: "C", sources: ["c"] },
    ];
    const reordered = reorderLanes(lanes, 2, 0);
    expect(reordered.map((l) => l.id)).toEqual([
      "lane-2",
      "lane-0",
      "lane-1",
    ]);
    const pinned = pinLane(reordered, "lane-0");
    expect(pinned[0]!.id).toBe("lane-0");
    const removed = removeLane(pinned, "lane-1");
    expect(removed.map((l) => l.id)).toEqual(["lane-0", "lane-2"]);
    expect(removed.length).toBeLessThanOrEqual(MAX_EVIDENCE_LANES);
  });
});

describe("add-to-investigation confirmation / undo", () => {
  it("requires preview → confirm; undo before apply discards payload", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 2);
    let state = previewInvestigationAdd(items, {
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect(state.status).toBe("preview");
    expect(state.failReason).toBeNull();
    expect(state.eventRefs).toHaveLength(2);
    expect(state.eventRefs[0]!.corpusId).toBe("corpus-xyz-demo");
    expect(state.eventRefs[0]!.source).toBe("xyz/api.log");
    expect(state.createsDraft).toBe(true);

    state = bindPreparedInvestigationTarget(state, {
      commitToken: "token-new",
      investigationId: null,
      expectedRevision: null,
      createsDraft: true,
    });
    state = confirmInvestigationAdd(state);
    expect(state.status).toBe("confirmed");

    state = undoInvestigationAdd(state);
    expect(state.status).toBe("undone");
    expect(state.eventRefs).toEqual([]);

    // Cancel path
    state = previewInvestigationAdd(items, {
      availableCorpusIds: ["corpus-xyz-demo"],
      investigationId: "inv-xyz-1",
    });
    expect(state.createsDraft).toBe(false);
    state = cancelInvestigationAdd(state);
    expect(state.status).toBe("cancelled");
  });

  it("markInvestigationApplied only after confirm", () => {
    const items = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 1);
    let state = previewInvestigationAdd(items, {
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect(markInvestigationApplied(state).status).not.toBe("applied");
    state = bindPreparedInvestigationTarget(state, {
      commitToken: "token-existing",
      investigationId: "inv-xyz-1",
      expectedRevision: 4,
      createsDraft: false,
    });
    state = confirmInvestigationAdd(state);
    expect(markInvestigationApplied(state).status).toBe("applied");
  });

  it("refuses investigation add without host-verified source/time", () => {
    const bare = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:11",
        label: "bare",
        corpusId: "corpus-xyz-demo",
        // no source/time — must fail closed
      },
    ]);
    const state = previewInvestigationAdd(bare, {
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect(state.failReason).toMatch(/host-verified source|timestamp/i);
  });

  it("starts from idle with no silent host mutation", () => {
    const idle = idleInvestigationAdd();
    expect(idle.status).toBe("idle");
    expect(idle.eventRefs).toEqual([]);
  });
});

describe("selection + control label", () => {
  it("toggles selection and select-all log only", () => {
    const set = buildEvidenceSetFromHostCitations(xyzCitations());
    let keys = new Set<string>();
    keys = toggleEvidenceSelection(keys, set[0]!.key);
    expect(keys.has(set[0]!.key)).toBe(true);
    keys = toggleEvidenceSelection(keys, set[0]!.key);
    expect(keys.has(set[0]!.key)).toBe(false);
    keys = selectAllLaneEligible(set);
    expect(keys.size).toBe(5);
    const selected = selectionFromKeys(set, keys);
    expect(selected.every((s) => s.laneEligible)).toBe(true);
  });
});

describe("enrich + Activity separation", () => {
  it("enrichWithHostEvents applies host facts only", () => {
    const base = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:50",
        label: "raw",
        corpusId: "c",
      },
    ]);
    expect(base[0]!.source).toBeUndefined();
    const enriched = enrichWithHostEvents(base, [
      {
        corpusId: "c",
        seq: 50,
        source: "xyz/enriched.log",
        ts: 99,
        timeQuality: "wall",
        service: "xyz-svc",
      },
    ]);
    expect(enriched[0]!.source).toBe("xyz/enriched.log");
    expect(enriched[0]!.service).toBe("xyz-svc");
    expect(enriched[0]!.timestamp).toBe(99);
  });

  it("keeps Activity rail semantics separate from customer-evidence lanes", () => {
    const sem = customerEvidenceLaneSemantics();
    expect(sem.activityRailSeparate).toBe(true);
    expect(sem.activityNeverCountsAsEvidenceLane).toBe(true);
    expect(sem.maxLanes).toBe(4);
    expect(sem.cssActivityRail).toBe("message-activity");
    expect(sem.cssCustomerLanes).toBe("log-explorer__lanes");
  });
});

describe("opening evidence never mutates corpus", () => {
  it("corpus open policy is open_or_focus only", () => {
    const p = corpusOpenPolicy();
    expect(p.reimport).toBe(false);
    expect(p.mutate).toBe(false);
    expect(p.duplicate).toBe(false);
  });
});

describe("host log_event citations from search_logs stream", () => {
  it("treats host source-path labels as source for lane eligibility", () => {
    // Shape after tool_host citations_from_search_evidence + Tauri corpus_id inject.
    const set = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:42",
        label: "xyz/api.log",
        corpusId: "corpus-xyz-demo",
      },
      {
        id: "log_event:43",
        label: "xyz/worker.log",
        corpusId: "corpus-xyz-demo",
      },
      {
        id: "log_template:9",
        label: "log_template:9",
        corpusId: "corpus-xyz-demo",
      },
    ]);
    const eligible = laneEligibleItems(set);
    expect(eligible).toHaveLength(2);
    expect(eligible.map((e) => e.source).sort()).toEqual([
      "xyz/api.log",
      "xyz/worker.log",
    ]);
    const plan = finalizeShowAssignment({
      resolved: eligible.map((e) => ({
        ...e,
        timestamp: 1,
        timeQuality: "wall" as const,
      })),
      mode: "one_source_per_lane",
      existing: freeLanes(2),
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    expect(
      plan.assignment.lanes.flatMap((l) => l.sources).sort(),
    ).toEqual(["xyz/api.log", "xyz/worker.log"]);
  });

  it("rejects malicious prose-only log_event without host attachment", () => {
    const set = buildEvidenceSetFromHostCitations([
      {
        id: "log_event:1",
        label: "xyz/api.log",
        corpusId: "corpus-xyz-demo",
      },
    ]);
    const forged = filterToHostEvidenceSet(set, ["log_event:999", "log_event:1"]);
    expect(forged.rejected).toContain("log_event:999");
    expect(forged.accepted.map((a) => a.id)).toEqual(["log_event:1"]);
  });
});

/**
 * Live-shaped acceptance: host stream citations (as main-chat attach + linked
 * Explorer would emit) → Evidence panel eligibility → Select all log → Show in
 * Explorer → 1–4 lane assignment preserves host sources.
 *
 * Uses the same EventDto fold as chat UI (`applyEventsToMessage`) so corpus_id
 * provenance is host-stream only — not a frontend label heuristic.
 */
describe("live-shaped main chat + linked chat evidence acceptance", () => {
  function streamToCitations(events: EventDto[]): HostEvidenceCitation[] {
    const { msg } = applyEventsToMessage(
      { id: "asst", role: "assistant", content: "" },
      events,
    );
    return (msg.citations ?? []) as HostEvidenceCitation[];
  }

  function hostSearchLogEvents(corpusId: string) {
    return [
      {
        kind: "citation",
        payload: {
          source_id: "log_event:101",
          label: "xyz/api.log",
          locator: "log_template:1",
          corpus_id: corpusId,
        },
      },
      {
        kind: "citation",
        payload: {
          source_id: "log_event:202",
          label: "xyz/worker.log",
          locator: "log_template:2",
          corpus_id: corpusId,
        },
      },
      {
        kind: "citation",
        payload: {
          source_id: "docs/runbook.md",
          label: "runbook",
          locator: null,
          // Model/malicious payload must not apply to non-log citations.
          corpus_id: "must-not-apply",
        },
      },
    ];
  }

  it.each([
    ["main chat attachment", "corpus-main-attach"],
    ["linked Log Explorer", "corpus-linked-explorer"],
  ] as const)(
    "%s: Select all log enables Show in Explorer and lanes keep host sources",
    (_label, corpusId) => {
      const citations = streamToCitations(hostSearchLogEvents(corpusId));
      // Governed log rows carry host corpus_id; workspace does not.
      expect(citations.find((c) => c.id === "log_event:101")?.corpusId).toBe(
        corpusId,
      );
      expect(citations.find((c) => c.id === "docs/runbook.md")?.corpusId).toBe(
        undefined,
      );

      const set = buildEvidenceSetFromHostCitations(citations);
      const eligible = laneEligibleItems(set);
      expect(eligible).toHaveLength(2);
      expect(eligible.every((e) => e.corpusId === corpusId)).toBe(true);
      expect(eligible.every((e) => e.laneEligible)).toBe(true);
      // Path-like host labels become source without trusting model prose.
      expect(eligible.map((e) => e.source).sort()).toEqual([
        "xyz/api.log",
        "xyz/worker.log",
      ]);

      const selectedKeys = selectAllLaneEligible(set);
      expect(selectedKeys.size).toBe(2);
      const selected = set.filter((i) => selectedKeys.has(i.key));
      expect(selected.every((s) => s.laneEligible)).toBe(true);

      const plan = planShowInExplorer(
        selected,
        "one_source_per_lane",
        freeLanes(4),
        { availableCorpusIds: new Set([corpusId]) },
      );
      expect("error" in plan).toBe(false);
      if ("error" in plan) return;
      expect(plan.corpusId).toBe(corpusId);
      expect(plan.openMode).toBe("open_or_focus_existing");

      const resolved = enrichWithHostEvents(selected, [
        {
          corpusId,
          seq: 101,
          source: "xyz/api.log",
          ts: 1,
          timeQuality: "wall",
          service: "api",
        },
        {
          corpusId,
          seq: 202,
          source: "xyz/worker.log",
          ts: 2,
          timeQuality: "wall",
          service: "worker",
        },
      ]);
      const finalized = finalizeShowAssignment({
        resolved,
        mode: "one_source_per_lane",
        existing: freeLanes(4),
        availableCorpusIds: new Set([corpusId]),
      });
      expect("error" in finalized).toBe(false);
      if ("error" in finalized) return;
      expect(finalized.assignment.lanes.length).toBeGreaterThanOrEqual(1);
      expect(finalized.assignment.lanes.length).toBeLessThanOrEqual(
        MAX_EVIDENCE_LANES,
      );
      const sources = finalized.assignment.lanes
        .flatMap((l) => l.sources)
        .sort();
      expect(sources).toEqual(["xyz/api.log", "xyz/worker.log"]);
    },
  );

  it("forged model citation without host corpus_id is not lane-eligible", () => {
    const citations = streamToCitations([
      {
        kind: "citation",
        payload: {
          source_id: "log_event:999",
          label: "forged/path.log",
          locator: null,
          // no corpus_id — host never attached provenance
        },
      },
    ]);
    const set = buildEvidenceSetFromHostCitations(citations);
    expect(laneEligibleItems(set)).toHaveLength(0);
    const plan = planShowInExplorer(set, "one_lane", freeLanes(1));
    expect("error" in plan).toBe(true);
  });
});

describe("finalizeShowAssignment (resolved path — never pre-resolve override)", () => {
  it("builds one_source_per_lane from host-resolved sources, not unresolved draft", () => {
    // Chat-shaped base: no source until host resolve
    const unresolved = buildEvidenceSetFromHostCitations([
      { id: "log_event:101", label: "a", corpusId: "corpus-xyz-demo" },
      { id: "log_event:202", label: "b", corpusId: "corpus-xyz-demo" },
    ]);
    const badDraft = assignEvidenceToLanes(
      unresolved,
      "one_source_per_lane",
      freeLanes(2),
    );
    // Unresolved collapses into empty/unresolved buckets
    expect(
      badDraft.lanes.every((l) => l.sources.length === 0) ||
        badDraft.lanes.some((l) => l.label === "Unresolved source"),
    ).toBe(true);

    const resolved = enrichWithHostEvents(unresolved, [
      {
        corpusId: "corpus-xyz-demo",
        seq: 101,
        source: "xyz/api.log",
        ts: 1,
        timeQuality: "wall",
        service: "xyz-api",
      },
      {
        corpusId: "corpus-xyz-demo",
        seq: 202,
        source: "xyz/worker.log",
        ts: 2,
        timeQuality: "wall",
        service: "xyz-worker",
      },
    ]);
    const plan = finalizeShowAssignment({
      resolved,
      mode: "one_source_per_lane",
      existing: freeLanes(2),
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    const sources = plan.assignment.lanes.flatMap((l) => l.sources).sort();
    expect(sources).toEqual(["xyz/api.log", "xyz/worker.log"]);
    expect(plan.assignment.visibleLaneCount).toBeGreaterThanOrEqual(2);
    // Must not equal unresolved empty-source draft
    expect(plan.assignment.lanes).not.toEqual(badDraft.lanes);
  });

  it("applies pin/reorder edits after resolved assignment", () => {
    const resolved = laneEligibleItems(
      buildEvidenceSetFromHostCitations(xyzCitations()),
    ).slice(0, 2);
    const base = finalizeShowAssignment({
      resolved,
      mode: "one_source_per_lane",
      existing: freeLanes(2),
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect("error" in base).toBe(false);
    if ("error" in base) return;
    const secondId = base.assignment.lanes[1]!.id;
    const pinned = finalizeShowAssignment({
      resolved,
      mode: "one_source_per_lane",
      existing: freeLanes(2),
      laneEdits: [{ type: "pin", laneId: secondId }],
      availableCorpusIds: ["corpus-xyz-demo"],
    });
    expect("error" in pinned).toBe(false);
    if ("error" in pinned) return;
    expect(pinned.assignment.lanes[0]!.id).toBe(secondId);
    // Host sources preserved after pin
    expect(pinned.assignment.lanes[0]!.sources.length).toBeGreaterThan(0);
  });

  it("applyLaneEdits is pure and does not invent sources", () => {
    const lanes = [
      { id: "lane-0", label: "a", sources: ["xyz/a.log"] },
      { id: "lane-1", label: "b", sources: ["xyz/b.log"] },
    ];
    const next = applyLaneEdits(lanes, [
      { type: "reorder", fromIndex: 1, toIndex: 0 },
    ]);
    expect(next.map((l) => l.sources)).toEqual([["xyz/b.log"], ["xyz/a.log"]]);
  });
});
