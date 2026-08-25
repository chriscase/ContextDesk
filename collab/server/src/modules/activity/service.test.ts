import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCompactInvestigationLocator,
  formatInvestigationActivityCursor,
  formatInvestigationResourceLocator,
  investigationActivityFilterFingerprint,
  parseInvestigationActivityPage,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { InvestigationActivityError, InvestigationActivityService } from "./service.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const EVE = { id: "eve", username: "eve" };
const HISTORICAL = { id: "historical-operator", username: "historical-operator" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-activity-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const store = new MemoryCaseStore();
  const cases = new CaseService(evidence, audit, store);
  const activity = new InvestigationActivityService({ cases, installationId: INSTALLATION });
  return { cases, store, activity, evidence };
}

describe("investigation activity projection", () => {
  it("projects deterministic activity ids and byte-identical reloads", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic queue investigation" }, "test");
    await cases.addEvidence(created.id, ALICE, {
      kind: "log",
      filename: "mailer.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("2026-08-24T00:00:00Z synthetic timeout\n"),
      summary: "Synthetic mailer timeout log",
    }, "test");
    const first = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const second = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    expect(activity.canonicalPageBytes(first)).toBe(activity.canonicalPageBytes(second));
    expect(first.items.some((item) => item.activityKind === "evidence_added")).toBe(true);
    expect(first.items.some((item) => item.activityKind === "investigation_created")).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/synthetic timeout/);
    expect(JSON.stringify(first)).not.toMatch(/mailer\.log/);
  });

  it("does not leak another investigation or private actor details", async () => {
    const { cases, activity } = await harness();
    const aliceCase = await cases.createCase(ALICE, { title: "Synthetic queue investigation" }, "test");
    await cases.createCase(EVE, { title: "Private synthetic investigation" }, "test");
    await cases.addContribution(aliceCase.id, ALICE, {
      kind: "message",
      body: "Synthetic private observation must stay out of the feed",
      privacyClass: "owner_only",
    }, "test");
    const evePage = await activity.listPage({ actor: EVE, isAdmin: false });
    expect(evePage.items.every((item) => item.investigationId !== aliceCase.id)).toBe(true);
    expect(JSON.stringify(evePage)).not.toContain("alice");
    expect(JSON.stringify(evePage)).not.toContain("Synthetic private");
    expect(JSON.stringify(evePage)).not.toContain(aliceCase.title);
    await expect(activity.listPage({ actor: EVE, isAdmin: false, caseId: aliceCase.id }))
      .rejects.toBeInstanceOf(InvestigationActivityError);
  });

  it("never marks AI or imported output as a human finding", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic comparison" }, "test");
    await cases.appendDomainTimeline(created.id, {
      kind: "external_run_imported",
      actor: ALICE,
      targetId: created.id,
      clientTime: null,
      payload: { summary: "PLANTED_MODEL_OUTPUT" },
    });
    await cases.appendDomainTimeline(created.id, {
      kind: "experiment_trace_imported",
      actor: ALICE,
      targetId: created.id,
      clientTime: null,
      payload: { packageId: "pkg-should-not-leak" },
    });
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const imported = page.items.filter((item) => item.activityKind === "import_recorded");
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.every((item) => item.humanFinding === false)).toBe(true);
    expect(imported.every((item) => item.provenanceClass === "ai_generated")).toBe(true);
    expect(JSON.stringify(page)).not.toContain("PLANTED_MODEL_OUTPUT");
    expect(JSON.stringify(page)).not.toContain("pkg-should-not-leak");
  });

  it("keeps a restored decision historical after its actor is mapped to a current identity", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Restored synthetic decision" }, "test");
    await cases.appendDomainTimeline(created.id, {
      kind: "experiment_decision_accepted",
      actor: { id: ALICE.id, username: ALICE.username },
      targetId: "22222222-2222-4222-8222-222222222222",
      clientTime: null,
      payload: {
        imported: true,
        sourceSeq: 9,
        sourceInstallationId: "inst-synthetic-source",
      },
    });
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const decision = page.items.find((item) => item.activityKind === "decision_accepted");
    expect(decision).toMatchObject({
      actorId: ALICE.id,
      actorLabel: "Historical participant",
      provenanceClass: "historical_restored",
      humanFinding: false,
    });
  });

  it("labels archive-restored historical users without exposing remapped identity", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Restored synthetic investigation" }, "test");
    await cases.appendDomainTimeline(created.id, {
      kind: "portable_archive_applied",
      actor: HISTORICAL,
      targetId: created.id,
      clientTime: null,
      payload: { imported: true },
    });
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const restored = page.items.find((item) => item.activityKind === "restore_recorded");
    expect(restored?.actorLabel).toBe("Historical participant");
    expect(restored?.provenanceClass).toBe("historical_restored");
    expect(restored?.actorLabel).not.toContain("historical-");
    expect(restored?.summary).not.toContain("historical-operator");
  });

  it("orders same timestamps deterministically and ignores duplicate projection", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic ordering" }, "test");
    const stamp = "2026-08-24T15:00:00.000Z";
    await cases.appendDomainTimeline(created.id, {
      kind: "evidence_registered",
      actor: ALICE,
      targetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clientTime: null,
      serverTime: stamp,
      payload: { privacyClass: "owner_only" },
    });
    await cases.appendDomainTimeline(created.id, {
      kind: "contribution_created",
      actor: ALICE,
      targetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      clientTime: null,
      serverTime: stamp,
      payload: { kind: "message", privacyClass: "share_safe" },
    });
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const sameTime = page.items.filter((item) => item.occurredAt === stamp);
    expect(sameTime).toHaveLength(2);
    expect(sameTime[0]!.orderTieBreak).toBeGreaterThan(sameTime[1]!.orderTieBreak);
    const again = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    expect(again.items.map((item) => item.activityId)).toEqual(page.items.map((item) => item.activityId));
  });

  it("rejects malformed and stale cursors instead of restarting", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic pagination" }, "test");
    for (let index = 0; index < 4; index += 1) {
      await cases.appendDomainTimeline(created.id, {
        kind: "case_situation_updated",
        actor: ALICE,
        targetId: created.id,
        clientTime: null,
        payload: { changedFields: ["scope"] },
      });
    }
    const first = await activity.listPage({
      actor: ALICE,
      isAdmin: false,
      caseId: created.id,
      limit: 2,
    });
    expect(first.nextCursor).toBeTruthy();
    await expect(
      activity.listPage({
        actor: ALICE,
        isAdmin: false,
        caseId: created.id,
        limit: 2,
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({ code: "malformed_cursor" });
    const otherFilter = formatInvestigationActivityCursor({
      v: 1,
      occurredAt: first.items[0]!.occurredAt,
      investigationId: created.id,
      seq: first.items[0]!.orderTieBreak,
      activityId: first.items[0]!.activityId,
      filterFingerprint: investigationActivityFilterFingerprint({ actorId: "eve" }),
    });
    await expect(
      activity.listPage({
        actor: ALICE,
        isAdmin: false,
        caseId: created.id,
        limit: 2,
        cursor: otherFilter,
      }),
    ).rejects.toMatchObject({ code: "stale_cursor" });
    const second = await activity.listPage({
      actor: ALICE,
      isAdmin: false,
      caseId: created.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items[0]?.activityId).not.toBe(first.items[0]?.activityId);
    parseInvestigationActivityPage(second);
  });

  it("resolves an authorized locator and fail-closes dangling, cross-case, and revision errors", async () => {
    const { cases, activity } = await harness();
    const aliceCase = await cases.createCase(ALICE, { title: "Synthetic queue investigation" }, "test");
    const eveCase = await cases.createCase(EVE, { title: "Private synthetic investigation" }, "test");
    const uploaded = await cases.addEvidence(aliceCase.id, ALICE, {
      kind: "log",
      filename: "worker.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("synthetic worker stall\n"),
      summary: "Synthetic worker log",
      privacyClass: "owner_only",
    }, "test");
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: aliceCase.id });
    const evidenceItem = page.items.find((item) => item.activityKind === "evidence_added");
    expect(evidenceItem).toBeTruthy();
    const resolved = await activity.resolve(
      ALICE,
      false,
      formatCompactInvestigationLocator(evidenceItem!.locator),
    );
    expect(resolved.locator.pathname).toBe(evidenceItem!.resolvedRoute);
    expect(resolved.authorized).toBe(true);
    expect(resolved.resourceLabel).toBe("Evidence item");

    const swapped = formatCompactInvestigationLocator({
      ...evidenceItem!.locator,
      investigationId: eveCase.id,
      pathname: evidenceItem!.locator.pathname.replace(aliceCase.id, eveCase.id),
    });
    await expect(activity.resolve(ALICE, false, swapped)).rejects.toMatchObject({ code: "not_found" });
    await expect(activity.resolve(EVE, false, formatCompactInvestigationLocator(evidenceItem!.locator)))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(ALICE, false, `cdl.v1/${INSTALLATION}/${aliceCase.id}/evidence_item/${eveCase.id}`),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ALICE,
        false,
        `cdl.v1/${INSTALLATION}/${aliceCase.id}/decision_revision/${uploaded.artifact.id};rev=99`,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(ALICE, false, `cdl.v1/${INSTALLATION}/${aliceCase.id}/evidence_item/../etc/passwd`),
    ).rejects.toMatchObject({ code: "invalid_locator" });
  });

  it("omits redacted content and supports assigned-to-me when identity data exists", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic assignment" }, "test");
    const note = await cases.addContribution(created.id, ALICE, {
      kind: "note",
      body: "Queue depth rose before workers stalled.",
    }, "test");
    await cases.appendDomainTimeline(created.id, {
      kind: "contribution_tombstoned",
      actor: ALICE,
      targetId: note.id,
      clientTime: null,
      payload: { kind: "note", omitted: true },
    });
    await cases.appendDomainTimeline(created.id, {
      kind: "contribution_created",
      actor: ALICE,
      targetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      clientTime: null,
      payload: { kind: "action", assignedTo: ALICE.id },
    });
    const omittedPage = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    expect(JSON.stringify(omittedPage)).not.toContain("Queue depth rose");
    const assigned = await activity.listPage({
      actor: ALICE,
      isAdmin: false,
      caseId: created.id,
      filter: { assignedToMe: true },
    });
    expect(assigned.items.every((item) => item.activityKind === "assignment_recorded")).toBe(true);
    expect(assigned.items.length).toBe(1);
  });

  it("reorders delivery without changing canonical output", async () => {
    const { cases, activity } = await harness();
    const early = "2026-08-24T10:00:00.000Z";
    const late = "2026-08-24T11:00:00.000Z";
    const first = await cases.createCase(ALICE, { title: "Synthetic reorder A" }, "test");
    await cases.appendDomainTimeline(first.id, {
      kind: "evidence_registered",
      actor: ALICE,
      targetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clientTime: null,
      serverTime: late,
      payload: { privacyClass: "share_safe" },
    });
    await cases.appendDomainTimeline(first.id, {
      kind: "contribution_created",
      actor: ALICE,
      targetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      clientTime: null,
      serverTime: early,
      payload: { kind: "message" },
    });
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: first.id });
    const kinds = page.items.map((item) => item.activityKind);
    const evidenceIdx = kinds.indexOf("evidence_added");
    const commentIdx = kinds.indexOf("comment_added");
    expect(evidenceIdx).toBeGreaterThanOrEqual(0);
    expect(commentIdx).toBeGreaterThan(evidenceIdx);
  });

  it("routes comments to Discussion and job-level workstreams to the visible run record", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic routing" }, "test");
    const message = await cases.addContribution(created.id, ALICE, {
      kind: "message",
      body: "Synthetic discussion note for routing.",
      privacyClass: "share_safe",
    }, "test");
    await cases.appendDomainTimeline(created.id, {
      kind: "triage_job_created",
      actor: ALICE,
      targetId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      clientTime: null,
      payload: { jobId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });
    await cases.appendDomainTimeline(created.id, {
      kind: "triage_candidate_started",
      actor: ALICE,
      targetId: "ffffffff-ffff-4fff-8fff-ffffffffffff:reviewer-lane",
      clientTime: null,
      payload: { jobId: "ffffffff-ffff-4fff-8fff-ffffffffffff", candidateId: "reviewer-lane" },
    });
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const comment = page.items.find((item) => item.activityKind === "comment_added");
    expect(comment?.locator.kind).toBe("discussion_message");
    expect(comment?.resolvedRoute).toContain("section=discussion");
    expect(comment?.resolvedRoute).toContain(`item=${message.id}`);
    expect(comment?.resolvedRoute).not.toContain("case-discussion");
    const launched = page.items.find((item) => item.activityKind === "workstream_launched" && item.locator.kind === "workstream");
    expect(launched?.resolvedRoute).toContain("section=triage-lane-runner");
    expect(launched?.resolvedRoute).toContain("kind=triage-run");
    expect(launched?.resolvedRoute).not.toContain("section=workstreams");
    const attempt = page.items.find((item) => item.locator.kind === "workstream_attempt");
    expect(attempt?.resolvedRoute).toContain("section=workstreams");
    expect(attempt?.resolvedRoute).toContain("kind=workstream");
    expect(attempt?.resolvedRoute).toContain("lane=");
    const resolved = await activity.resolve(
      ALICE,
      false,
      formatCompactInvestigationLocator(comment!.locator),
    );
    expect(resolved.resourceLabel).toBe("Discussion message");
    await expect(
      activity.resolve(EVE, false, formatCompactInvestigationLocator(comment!.locator)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reauthorizes locators by resource kind and hides kind-confused existence", async () => {
    const { cases, activity } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic kind isolation" }, "test");
    const note = await cases.addContribution(created.id, ALICE, {
      kind: "note",
      body: "Synthetic queue-depth observation.",
    }, "test");
    const comment = await cases.addContribution(created.id, ALICE, {
      kind: "message",
      body: "Synthetic discussion comment.",
      privacyClass: "share_safe",
    }, "test");
    const uploaded = await cases.addEvidence(created.id, ALICE, {
      kind: "log",
      filename: "mailer.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("synthetic mailer timeout\n"),
      summary: "Synthetic mailer timeout.",
      privacyClass: "owner_only",
    }, "test");
    const snapshot = await cases.createSnapshot(
      created.id,
      ALICE,
      { evidenceIds: [uploaded.artifact.id], visibility: "owner_only" },
      "test",
    );
    const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: created.id });
    const observation = page.items.find((item) => item.activityKind === "observation_recorded");
    const discussion = page.items.find((item) => item.activityKind === "comment_added");
    const evidence = page.items.find((item) => item.activityKind === "evidence_added");
    const frozen = page.items.find((item) => item.activityKind === "evidence_frozen");
    expect(observation?.locator.kind).toBe("observation");
    expect(observation?.locator.resourceId).toBe(note.id);
    expect(discussion?.locator.kind).toBe("discussion_message");
    expect(discussion?.locator.resourceId).toBe(comment.id);
    expect(evidence?.locator.kind).toBe("evidence_item");
    expect(evidence?.locator.resourceId).toBe(uploaded.artifact.id);
    expect(frozen?.locator.kind).toBe("evidence_context");
    expect(frozen?.locator.resourceId).toBe(snapshot.id);

    const confused = [
      { kind: "evidence_item" as const, resourceId: note.id },
      { kind: "discussion_message" as const, resourceId: note.id },
      { kind: "observation" as const, resourceId: comment.id },
      { kind: "discussion_message" as const, resourceId: uploaded.artifact.id },
      { kind: "evidence_item" as const, resourceId: snapshot.id },
    ].map((row) => formatCompactInvestigationLocator(formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: created.id,
      kind: row.kind,
      resourceId: row.resourceId,
    })));
    for (const locator of confused) {
      await expect(activity.resolve(ALICE, false, locator)).rejects.toMatchObject({ code: "not_found" });
      await expect(activity.resolve(EVE, false, locator)).rejects.toMatchObject({ code: "not_found" });
    }

    await expect(activity.resolve(ALICE, false, formatCompactInvestigationLocator(observation!.locator)))
      .resolves.toMatchObject({ authorized: true, resourceLabel: "Observation" });
    await expect(activity.resolve(ALICE, false, formatCompactInvestigationLocator(discussion!.locator)))
      .resolves.toMatchObject({ authorized: true, resourceLabel: "Discussion message" });
    await expect(activity.resolve(ALICE, false, formatCompactInvestigationLocator(evidence!.locator)))
      .resolves.toMatchObject({ authorized: true, resourceLabel: "Evidence item" });
    await expect(activity.resolve(ALICE, false, formatCompactInvestigationLocator(frozen!.locator)))
      .resolves.toMatchObject({ authorized: true, resourceLabel: "Evidence context" });
  });
});
