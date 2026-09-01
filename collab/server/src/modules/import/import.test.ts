import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCase,
  parseExternalRun,
  parseSource,
  parseSourceList,
  parseTimeline,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import {
  FilesystemEvidenceStore,
  abandonWriteBatchForCrashTest,
  sha256Hex,
  type EvidenceFinalizeOptions,
  type EvidenceStage,
  type EvidenceStore,
} from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MapAuthAdapter } from "../auth/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
  MemoryCaseStore,
} from "../cases/index.js";
import { ImportService, MemoryRunStore } from "./index.js";
import { initialCorroborationState } from "./model.js";

const ALICE = "fixture-alice-secret";
const TRANSCRIPT = "The mailer pool is exhausted; workers time out after 30s.";
const PROMPT = "What is failing in the mailer?";
const INJECT = '<script>alert("xss")</script>';

class UnknownCommitStore extends MemoryCaseStore {
  unknownCommit = false;

  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    const result = await super.withAtomic(operation, audit);
    if (this.unknownCommit) throw new CaseStoreCommitOutcomeUnknownError();
    return result;
  }
}

function failBatchFinalizeAfterCleanup(
  store: FilesystemEvidenceStore,
  failureMode: "once" | "always",
): string[] {
  const events: string[] = [];
  const original = store.beginWriteBatch.bind(store);
  store.beginWriteBatch = async () => {
    const batch = await original();
    const promote = batch.promote.bind(batch);
    const rollback = batch.rollback.bind(batch);
    const finalize = batch.finalize.bind(batch);
    let finalizeCalls = 0;
    batch.promote = async () => {
      events.push("promote");
      await promote();
    };
    batch.rollback = async () => {
      events.push("rollback");
      await rollback();
    };
    batch.finalize = async (options?: EvidenceFinalizeOptions) => {
      events.push(options?.retainPendingJournal ? "finalize:retain" : "finalize");
      finalizeCalls += 1;
      await finalize(options);
      if (failureMode === "always" || finalizeCalls === 1) {
        throw new Error("synthetic post-COMMIT finalize cleanup failure");
      }
    };
    return batch;
  };
  return events;
}

async function pendingJournalNames(root: string): Promise<string[]> {
  return (await readdir(join(root, ".pending")).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function stageOnlyEvidence(store: FilesystemEvidenceStore): EvidenceStore & {
  events: string[];
} {
  const events: string[] = [];
  const originalStage = store.stage.bind(store);
  return {
    events,
    get writeCoordination() {
      return store.writeCoordination;
    },
    put: store.put.bind(store),
    stage: async (bytes, options) => {
      const stage = await originalStage(bytes, options);
      const tracked: EvidenceStage = {
        meta: stage.meta,
        commit: async () => {
          events.push("commit");
          await stage.commit();
        },
        rollback: async () => {
          events.push("rollback");
          await stage.rollback();
        },
        release: () => {
          events.push("release");
          stage.release();
        },
      };
      return tracked;
    },
    get: store.get.bind(store),
    head: store.head.bind(store),
    stageStream: store.stageStream.bind(store),
    openRead: store.openRead.bind(store),
    verify: store.verify.bind(store),
    putFileServerReference: store.putFileServerReference.bind(store),
    getFileServerReference: store.getFileServerReference.bind(store),
    verifyFileServerReference: store.verifyFileServerReference.bind(store),
    abandonFileServerReference: store.abandonFileServerReference.bind(store),
    restoreFileServerReference: store.restoreFileServerReference.bind(store),
    ping: store.ping.bind(store),
  };
}

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

function users() {
  return new Map([
    [
      "alice",
      {
        password: ALICE,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: "fixture-dave-secret",
        identity: {
          id: "uid=dave,ou=people,dc=example,dc=test",
          username: "dave",
          displayName: "dave",
        },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "bob",
      {
        password: "fixture-bob-secret",
        identity: {
          id: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
          displayName: "bob",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
    store: FilesystemEvidenceStore;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-import-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases: domain,
    catalog,
    runs: new MemoryRunStore(),
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    imports,
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit,
    },
  });
  try {
    await fn({ app, audit, store });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

describe("external-run import", () => {
  it("imports a pasted transcript with hash round-trip, unknown fields, and distinct identities", async () => {
    await withApp(async ({ app, audit, store }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const bob = await login(app, "bob", "fixture-bob-secret");
      const tool = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "Web assistant", kind: "external-tool" },
            })
          ).body,
        ),
      );
      const created = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/cases",
              headers: { cookie: alice },
              payload: { title: "Import fixture" },
            })
          ).body,
        ),
      );
      const membership = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/participants`,
        headers: { cookie: dave },
        payload: {
          identityId: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
        },
      });
      expect(membership.statusCode).toBe(200);

      const imported = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: TRANSCRIPT,
                promptText: PROMPT,
                sourceId: tool.id,
                operatorId: "uid=operator,ou=people,dc=example,dc=test",
                operatorUsername: "operator",
                promptCompleteness: "exact",
                outputCompleteness: "exact",
                workflowCompleteness: "unknown",
                evidenceVisibility: "unknown",
                snapshotBinding: null,
                provider: "example-assistant",
                model: null,
                version: null,
                claimedTraces: ["mailer-pool"],
                uncertainty: "I am not sure about retries.",
              },
            })
          ).body,
        ),
      );
      expect(imported.outputHash).toBe(sha256Hex(new TextEncoder().encode(TRANSCRIPT)));
      expect(await store.verify(imported.outputHash)).toBe(true);
      expect(imported.outputText).toBe(TRANSCRIPT);
      expect(imported.promptText).toBe(PROMPT);
      expect(imported.workflowCompleteness).toBe("unknown");
      expect(imported.model).toBeNull();
      expect(imported.version).toBeNull();
      expect(imported.evidenceVisibility).toBe("unknown");
      expect(imported.snapshotBinding).toBeNull();
      expect(imported.importerUsername).toBe("alice");
      expect(imported.operatorUsername).toBe("operator");
      expect(imported.importerId).not.toBe(imported.operatorId);
      expect(imported.corroborationState).toBe("unverified");
      expect(imported.corroborationState).toBe(initialCorroborationState());
      expect(imported.privacyClass).toBe("owner_only");
      const bobList = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: bob },
      });
      expect(bobList.statusCode).toBe(200);
      expect((JSON.parse(bobList.body) as { runs?: unknown[] }).runs).toHaveLength(0);
      const bobDetail = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/imports/${imported.id}`,
        headers: { cookie: bob },
      });
      expect(bobDetail.statusCode).toBe(404);

      const described = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: "importer described visibility only",
                sourceId: tool.id,
                evidenceVisibility: "importer_described",
                visibilityNote: "Saw the on-call paste, no package.",
              },
            })
          ).body,
        ),
      );
      expect(described.evidenceVisibility).toBe("importer_described");
      expect(described.snapshotBinding).toBeNull();
      expect(described.promptText).toBeNull();
      expect(described.promptHash).toBeNull();
      expect(described.promptCompleteness).toBe("unknown");
      expect(described.operatorUsername).toBe("alice");
      expect(described.operatorId).toBe(described.importerId);

      for (const partialIdentity of [
        { operatorId: "uid=operator,ou=people,dc=example,dc=test" },
        { operatorUsername: "operator" },
      ]) {
        const rejected = await app.inject({
          method: "POST",
          url: `/api/cases/${created.id}/imports`,
          headers: { cookie: alice },
          payload: {
            outputText: "partial operator identity must fail closed",
            sourceId: tool.id,
            ...partialIdentity,
          },
        });
        expect(rejected.statusCode).toBe(400);
        expect(JSON.parse(rejected.body)).toEqual({
          error: "operatorId and operatorUsername must be provided together",
        });
      }

      const outputOnly = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: "output only",
                sourceId: tool.id,
                operatorId: "uid=operator,ou=people,dc=example,dc=test",
                operatorUsername: "operator",
                promptCompleteness: "unknown",
                outputCompleteness: "partial",
                workflowCompleteness: "unknown",
              },
            })
          ).body,
        ),
      );
      expect(outputOnly.promptText).toBeNull();
      expect(outputOnly.promptCompleteness).toBe("unknown");
      expect(outputOnly.outputCompleteness).toBe("partial");

      const rejectExactPrompt = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: {
          outputText: "x",
          sourceId: tool.id,
          operatorId: "op",
          operatorUsername: "op",
          promptCompleteness: "exact",
        },
      });
      expect(rejectExactPrompt.statusCode).toBe(400);

      const inject = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: INJECT,
                sourceId: tool.id,
                operatorId: "op",
                operatorUsername: "op",
              },
            })
          ).body,
        ),
      );
      expect(inject.outputText).toBe(INJECT);

      const note = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${created.id}/contributions`,
            headers: { cookie: alice },
            payload: { kind: "note", body: "Log line matches the imported claim." },
          })
        ).body,
      ) as { id: string };

      const corroborated = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports/${imported.id}/corroborate`,
              headers: { cookie: alice },
              payload: {
                state: "corroborated",
                links: [{ kind: "contribution", id: note.id }],
              },
            })
          ).body,
        ),
      );
      expect(corroborated.corroborationState).toBe("corroborated");
      expect(corroborated.outputHash).toBe(imported.outputHash);
      expect(corroborated.promptHash).toBe(imported.promptHash);
      expect(corroborated.snapshotBinding).toBe(imported.snapshotBinding);
      expect(corroborated.outputText).toBe(TRANSCRIPT);
      expect(corroborated.promptText).toBe(PROMPT);

      const contradicted = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports/${described.id}/corroborate`,
              headers: { cookie: alice },
              payload: {
                state: "contradicted",
                links: [{ kind: "contribution", id: note.id }],
              },
            })
          ).body,
        ),
      );
      expect(contradicted.corroborationState).toBe("contradicted");

      await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/status`,
        headers: { cookie: dave },
        payload: { status: "resolved" },
      });
      const afterResolve = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${created.id}/imports/${imported.id}`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(afterResolve.outputHash).toBe(imported.outputHash);
      expect(afterResolve.promptHash).toBe(imported.promptHash);
      expect(afterResolve.snapshotBinding).toBeNull();
      expect(afterResolve.outputText).toBe(TRANSCRIPT);

      const timeline = parseTimeline(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${created.id}/timeline`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(timeline.events.some((e) => e.kind === "external_run_imported")).toBe(true);
      expect(timeline.events.some((e) => e.kind === "run_corroboration")).toBe(true);

      const audits = await audit.list();
      expect(audits.some((a) => a.action === "external_run_import")).toBe(true);
      expect(audits.some((a) => a.action === "run_corroboration")).toBe(true);
      expect(audits.every((a) => a.action !== "auto_verify_import")).toBe(true);
    });
  });

  it("rejects imports from a retired source while keeping it listed for attribution", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const legacyTool = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "Legacy assistant", kind: "external-tool" },
            })
          ).body,
        ),
      );
      const activeTool = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "Current assistant", kind: "external-tool" },
            })
          ).body,
        ),
      );
      const created = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/cases",
              headers: { cookie: alice },
              payload: { title: "Retired source fixture" },
            })
          ).body,
        ),
      );

      const retired = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${legacyTool.id}/retire`,
              headers: { cookie: dave },
            })
          ).body,
        ),
      );
      expect(retired.id).toBe(legacyTool.id);
      expect(retired.lifecycle).toBe("retired");

      const listed = parseSourceList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/catalog/sources",
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      const stillListed = listed.sources.find((s) => s.id === legacyTool.id);
      expect(stillListed?.lifecycle).toBe("retired");

      const rejected = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: {
          outputText: "output attributed to a retired tool",
          sourceId: legacyTool.id,
          operatorId: "op",
          operatorUsername: "op",
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body)).toEqual({ error: "source is retired" });

      const accepted = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: "output attributed to an active tool",
                sourceId: activeTool.id,
                operatorId: "op",
                operatorUsername: "op",
              },
            })
          ).body,
        ),
      );
      expect(accepted.sourceId).toBe(activeTool.id);

      const runs = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${created.id}/imports`,
            headers: { cookie: alice },
          })
        ).body,
      ) as { runs: { id: string }[] };
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]?.id).toBe(accepted.id);
    });
  });

  it("never starts an imported run as corroborated or verified evidence", () => {
    expect(initialCorroborationState()).toBe("unverified");
    const src = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/corroborationState:\s*"corroborated"/);
    expect(src).not.toMatch(/corroborationState:\s*"verified"/);
    expect(src.includes("initialCorroborationState()")).toBe(true);
  });

  it("rolls back corroboration when timeline projection fails", async () => {
    class InjectedFailureStore extends MemoryCaseStore {
      failTimelineKind: string | null = null;
      override async appendTimeline(
        caseId: string,
        event: Parameters<MemoryCaseStore["appendTimeline"]>[1],
      ): Promise<Awaited<ReturnType<MemoryCaseStore["appendTimeline"]>>> {
        if (this.failTimelineKind && event.kind === this.failTimelineKind) {
          throw new Error(`injected timeline failure:${event.kind}`);
        }
        return super.appendTimeline(caseId, event);
      }
    }
    const root = await mkdtemp(join(tmpdir(), "cd-collab-corroborate-boom-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const store = new InjectedFailureStore();
    const cases = new CaseService(evidence, audit, store, catalog);
    const runs = new MemoryRunStore();
    const imports = new ImportService({
      evidence,
      audit,
      cases,
      catalog,
      runs,
    });
    try {
      const created = await cases.createCase(actor, { title: "Corroboration atomic fixture" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText: "synthetic imported timeout transcript",
          sourceId: source.id,
          operatorId: "uid=operator,ou=people,dc=example,dc=test",
          operatorUsername: "operator",
        },
        "test",
        false,
      );
      const note = await cases.addContribution(
        created.id,
        actor,
        { kind: "note", body: "Synthetic corroborating observation." },
        "test",
      );
      store.failTimelineKind = "run_corroboration";
      await expect(
        imports.corroborate(
          created.id,
          imported.id,
          actor,
          { state: "corroborated", links: [{ kind: "contribution", id: note.id }] },
          "test",
          false,
        ),
      ).rejects.toThrow(/injected timeline failure:run_corroboration/);
      expect(await runs.listCorroborations(imported.id)).toEqual([]);
      expect((await cases.listTimeline(created.id)).some((event) => event.kind === "run_corroboration")).toBe(false);
      expect(await audit.list({ action: "run_corroboration" })).toEqual([]);
      expect((await imports.getRun(created.id, imported.id, actor, false))?.corroborationState).toBe("unverified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back the contribution and staged bytes when run insert fails", async () => {
    class BoomRunStore extends MemoryRunStore {
      override async insert(): Promise<void> {
        throw new Error("run insert failed");
      }
    }
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-boom-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const cases = new CaseService(evidence, audit, new MemoryCaseStore(), catalog);
    const imports = new ImportService({
      evidence,
      audit,
      cases,
      catalog,
      runs: new BoomRunStore(),
    });
    try {
      const created = await cases.createCase(actor, { title: "Import rollback fixture" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic imported timeout transcript";
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText,
            sourceId: source.id,
            operatorId: "uid=operator,ou=people,dc=example,dc=test",
            operatorUsername: "operator",
          },
          "test",
          false,
        ),
      ).rejects.toThrow(/run insert failed/);
      expect(await cases.listContributions(created.id, actor, false)).toEqual([]);
      expect(await imports.listRuns(created.id, actor, false)).toEqual([]);
      expect(await evidence.head(sha256Hex(new TextEncoder().encode(outputText)))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries transient post-COMMIT import cleanup without rolling bytes back", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-finalize-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "once");
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new MemoryCaseStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Import cleanup retry" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic import transient finalize failure";
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText,
          sourceId: source.id,
          operatorId: actor.id,
          operatorUsername: actor.username,
        },
        "test",
        false,
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await runs.get(imported.id)).not.toBeNull();
      expect(await evidence.verify(imported.outputHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a committed import when post-COMMIT cleanup keeps failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-finalize-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "always");
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new MemoryCaseStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Import cleanup recovery" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic import persistent finalize failure";
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText,
          sourceId: source.id,
          operatorId: actor.id,
          operatorUsername: actor.username,
        },
        "test",
        false,
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await runs.get(imported.id)).not.toBeNull();
      expect(await evidence.verify(imported.outputHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains promoted import bytes and the recovery journal on an unknown COMMIT", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-unknown-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "always");
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new UnknownCommitStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Unknown import commit" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic import unknown commit";
      const outputHash = sha256Hex(new TextEncoder().encode(outputText));
      caseStore.unknownCommit = true;
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText,
            sourceId: source.id,
            operatorId: actor.id,
            operatorUsername: actor.username,
          },
          "test",
          false,
        ),
      ).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      expect(events).toEqual(["promote", "finalize:retain"]);
      expect(events).not.toContain("rollback");
      expect(await runs.listByCase(created.id)).toHaveLength(1);
      expect(await evidence.verify(outputHash)).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases stage-only import bytes without rollback on an unknown COMMIT", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-unknown-stage-"));
    const files = new FilesystemEvidenceStore({ rootDir: root });
    const evidence = stageOnlyEvidence(files);
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new UnknownCommitStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Unknown stage import commit" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic stage-only import unknown commit";
      const outputHash = sha256Hex(new TextEncoder().encode(outputText));
      caseStore.unknownCommit = true;
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText,
            sourceId: source.id,
            operatorId: actor.id,
            operatorUsername: actor.username,
          },
          "test",
          false,
        ),
      ).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      expect(evidence.events).toEqual(["commit", "release"]);
      expect(evidence.events).not.toContain("rollback");
      expect(await runs.listByCase(created.id)).toHaveLength(1);
      expect(await files.verify(outputHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps imported run bytes when recovering unreferenced promote residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-pending-write-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new MemoryCaseStore();
    const runs = new MemoryRunStore();
    evidence.addReferencedContentHashSource(() => caseStore.listReferencedContentHashes());
    evidence.addReferencedContentHashSource(() => runs.listReferencedContentHashes());
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({
      evidence,
      audit,
      cases,
      catalog,
      runs,
    });
    try {
      const created = await cases.createCase(actor, { title: "Import hash recovery fixture" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic imported mailer timeout transcript";
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText,
          sourceId: source.id,
          operatorId: "uid=operator,ou=people,dc=example,dc=test",
          operatorUsername: "operator",
        },
        "test",
        false,
      );
      const crashedBytes = new TextEncoder().encode("2026-08-25T00:01:00Z synthetic import crash residue\n");
      const batch = await evidence.beginWriteBatch();
      const crashedMeta = await batch.put(crashedBytes, { contentType: "text/plain" });
      await batch.promote();
      await abandonWriteBatchForCrashTest(batch);
      const recovered = await evidence.recoverUnreferencedWrites();
      expect(recovered.reclaimed).toEqual([crashedMeta.hash]);
      expect(await evidence.head(crashedMeta.hash)).toBeNull();
      expect(await evidence.verify(imported.outputHash)).toBe(true);
      expect(await runs.listReferencedContentHashes()).toEqual(new Set([imported.outputHash]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
