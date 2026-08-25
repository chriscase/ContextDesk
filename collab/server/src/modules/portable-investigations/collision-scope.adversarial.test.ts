/**
 * Adversarial coverage for portable restore collision scope and scaling at the
 * server boundary.
 *
 * All data is synthetic. What is under test: an unrelated destination corpus
 * must not cost more probes and must not fabricate collisions; a real
 * deterministic destination id must still block or remap; apply must recompute
 * server-side, refuse stale destination state, and roll back rather than
 * overwrite a key taken concurrently; and the memory and PostgreSQL stores must
 * answer the same probes the same way.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PORTABLE_OBJECT_KINDS,
  portableDestinationUuid,
  type PortableArchiveV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CatalogService, MemoryCatalogStore, PgCatalogStore } from "../catalog/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import {
  ExperimentService,
  MemoryExperimentStore,
  PgExperimentStore,
} from "../experiments/index.js";
import { ImportService, MemoryRunStore, PgRunStore } from "../import/index.js";
import { MemoryTriageJobStore, PgTriageJobStore, TriageRunService } from "../triage-runs/index.js";
import {
  assertDestinationIdsUnoccupied,
  PortableDestinationOccupiedError,
  probePortableCollisions,
  PROBED_PORTABLE_NAMESPACES,
  unprobedNamespaceReason,
  type PortableCollisionProbePorts,
} from "./collision-probe.js";
import {
  memoryApplyBoundary,
  MemoryPortableApplyStateStore,
  type MemoryApplyBoundary,
} from "./persist.js";
import {
  PortableInvestigationService,
  PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
} from "./service.js";

const ACTOR = { id: "actor-north", username: "operator-north" };
const LOG_BYTES = new TextEncoder().encode(
  "2042-03-04T10:00:00Z queue-worker WARN synthetic backlog exceeded 40 items\n",
);
const NOW = "2042-03-04T12:00:00.000Z";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Lab {
  root: string;
  caseStore: MemoryCaseStore;
  catalogStore: MemoryCatalogStore;
  runStore: MemoryRunStore;
  experimentStore: MemoryExperimentStore;
  jobStore: MemoryTriageJobStore;
  cases: CaseService;
  portable: PortableInvestigationService;
  applyBoundary: MemoryApplyBoundary;
  probe: PortableCollisionProbePorts;
  caseId: string;
  calls: () => number;
  resetCalls: () => void;
}

/** Wraps every probe port so a test can bound the store round trips a
 * preflight spends. */
function countingProbe(inner: PortableCollisionProbePorts): {
  ports: PortableCollisionProbePorts;
  calls: () => number;
  reset: () => void;
} {
  let calls = 0;
  const tally =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls += 1;
      return fn(...args);
    };
  const ports = {
    cases: {
      probeExistingIds: tally(inner.cases.probeExistingIds.bind(inner.cases)),
      probeParticipants: tally(inner.cases.probeParticipants.bind(inner.cases)),
    },
    catalog: { probeExistingIds: tally(inner.catalog.probeExistingIds.bind(inner.catalog)) },
    experiments: {
      probeExistingIds: tally(inner.experiments.probeExistingIds.bind(inner.experiments)),
    },
    runs: { probeExistingIds: tally(inner.runs.probeExistingIds.bind(inner.runs)) },
    jobs: { probeExistingIds: tally(inner.jobs.probeExistingIds.bind(inner.jobs)) },
  } as unknown as PortableCollisionProbePorts;
  return {
    ports,
    calls: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}

async function lab(): Promise<Lab> {
  const root = await mkdtemp(join(tmpdir(), "cd-portable-collision-"));
  roots.push(root);
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const caseStore = new MemoryCaseStore();
  const catalogStore = new MemoryCatalogStore();
  const runStore = new MemoryRunStore();
  const experimentStore = new MemoryExperimentStore();
  const jobStore = new MemoryTriageJobStore();
  const applyState = new MemoryPortableApplyStateStore();
  const catalog = new CatalogService(catalogStore, audit);
  const cases = new CaseService(store, audit, caseStore, catalog);
  const imports = new ImportService({ evidence: store, audit, cases, catalog, runs: runStore });
  const triageRuns = new TriageRunService({ cases, audit, jobs: jobStore, profiles: [] });
  const experiments = new ExperimentService({ cases, audit, experiments: experimentStore });
  const applyBoundary = memoryApplyBoundary({
    cases: caseStore,
    catalog: catalogStore,
    experiments: experimentStore,
    runs: runStore,
    jobs: jobStore,
    evidence: store,
    audit,
    applyState,
  });
  const counting = countingProbe({
    cases: caseStore,
    catalog: catalogStore,
    experiments: experimentStore,
    runs: runStore,
    jobs: jobStore,
  });
  const portable = new PortableInvestigationService({
    installationId: "inst-syntheticnorth",
    cases,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    applyState,
    probe: counting.ports,
    withTransaction: applyBoundary.withTransaction,
    applyCoordination: "single_instance",
    confirmationRestartDurable: false,
    now: () => NOW,
  });

  const caseRow = await cases.createCase(
    ACTOR,
    {
      title: "Synthetic queue stall",
      severity: "high",
      problemStatement: "Synthetic workers stop draining a bounded queue.",
      affectedParties: "Synthetic operations group",
      impact: "Synthetic requests wait longer than expected.",
      scope: "One fictional worker pool.",
      openQuestions: ["Which synthetic signal precedes the stall?"],
    },
    "fixture",
  );
  await cases.addContribution(
    caseRow.id,
    ACTOR,
    { kind: "note", body: "Queue depth rose before workers stalled.", privacyClass: "share_safe" },
    "fixture",
  );
  await cases.addEvidence(
    caseRow.id,
    ACTOR,
    {
      kind: "log",
      filename: "synthetic-worker.log",
      mediaType: "text/plain",
      bytes: LOG_BYTES,
      summary: "Synthetic worker warning",
      privacyClass: "share_safe",
    },
    "fixture",
  );

  return {
    root,
    caseStore,
    catalogStore,
    runStore,
    experimentStore,
    jobStore,
    cases,
    portable,
    applyBoundary,
    probe: {
      cases: caseStore,
      catalog: catalogStore,
      experiments: experimentStore,
      runs: runStore,
      jobs: jobStore,
    },
    caseId: caseRow.id,
    calls: counting.calls,
    resetCalls: counting.reset,
  };
}

function identityMapFor(archive: PortableArchiveV1) {
  return archive.investigation.actors.map((source) =>
    source.sourceActorId === ACTOR.id
      ? {
          sourceActorId: source.sourceActorId,
          action: "map_existing" as const,
          destinationActorId: ACTOR.id,
        }
      : {
          sourceActorId: source.sourceActorId,
          action: "preserve_historical_external" as const,
          destinationActorId: null,
        },
  );
}

/** Grows the destination with cases that share nothing with the archive. */
async function growUnrelatedCorpus(row: Lab, cases: number, perCase: number): Promise<void> {
  for (let index = 0; index < cases; index += 1) {
    const created = await row.cases.createCase(
      ACTOR,
      { title: `Synthetic unrelated case ${index}`, severity: "low" },
      "fixture",
    );
    for (let item = 0; item < perCase; item += 1) {
      await row.cases.addContribution(
        created.id,
        ACTOR,
        {
          kind: "note",
          body: `Synthetic unrelated note ${index}-${item}.`,
          privacyClass: "share_safe",
        },
        "fixture",
      );
      await row.cases.addEvidence(
        created.id,
        ACTOR,
        {
          kind: "log",
          filename: `unrelated-${index}-${item}.log`,
          mediaType: "text/plain",
          bytes: new TextEncoder().encode(`synthetic unrelated line ${index}-${item}\n`),
          summary: "Synthetic unrelated evidence",
          privacyClass: "share_safe",
        },
        "fixture",
      );
    }
  }
}

describe("portable restore collision scope at the server boundary", () => {
  it("keeps probe call count and catalog digest flat as an unrelated corpus grows", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const dryRun = {
      mode: "dry_run" as const,
      collisionPolicy: "remap_deterministic" as const,
      identityMap,
    };

    row.resetCalls();
    const small = await row.portable.preflight(archive, dryRun, ACTOR, false);
    const smallCalls = row.calls();

    // Twelve unrelated cases, each with its own contributions, evidence, and
    // timeline. The old catalog walked all of them seven ways per case.
    await growUnrelatedCorpus(row, 12, 3);

    row.resetCalls();
    const large = await row.portable.preflight(archive, dryRun, ACTOR, false);
    const largeCalls = row.calls();

    expect(largeCalls).toBe(smallCalls);
    // One batched probe per probed namespace present in the archive, plus one
    // participant lookup. Nothing here scales with the destination corpus.
    expect(largeCalls).toBeLessThanOrEqual(PROBED_PORTABLE_NAMESPACES.length + 1);
    expect(large.report.destinationCatalogDigest).toBe(small.report.destinationCatalogDigest);
    expect(large.report.idRemap).toEqual(small.report.idRemap);
    expect(large.report.referentialIntegrityFailures).toEqual(
      small.report.referentialIntegrityFailures,
    );
    expect(large.report.exactReconstruction).toBe(true);
  });

  it("does not fabricate a collision from an unrelated large-case corpus", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    await growUnrelatedCorpus(row, 8, 4);
    const response = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "fail", identityMap: identityMapFor(archive) },
      ACTOR,
      false,
    );
    expect(
      response.report.referentialIntegrityFailures.filter((row) => row.code === "id_collision"),
    ).toEqual([]);
    expect(response.report.counts.conflict).toBe(0);
    expect(response.report.exactReconstruction).toBe(true);
    expect(response.apply.confirmationToken).not.toBeNull();

    // The destination now holds many timeline sequences and content digests
    // that overlap the archive's own. Neither is a destination key.
    const timeline = await row.caseStore.listTimeline(row.caseId);
    expect(timeline.length).toBeGreaterThan(0);
    const probe = await probePortableCollisions(archive.investigation, row.probe);
    expect(probe.occupiedByNamespace.timeline).toBeUndefined();
    expect(probe.occupiedByNamespace.content).toBeUndefined();
  });

  it("still blocks a real deterministic destination id under the fail policy", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const evidenceId = archive.investigation.evidence[0]?.id;
    if (!evidenceId) throw new Error("synthetic archive has no evidence");
    const taken = portableDestinationUuid(
      archive.investigation.sourceInstallationId,
      "evidence",
      evidenceId,
      0,
    );
    const template = (await row.caseStore.listArtifactsByCase(row.caseId))[0];
    if (!template) throw new Error("synthetic artifact is missing");
    await row.caseStore.insertArtifact({ ...template, id: taken });

    const probe = await probePortableCollisions(archive.investigation, row.probe);
    expect(probe.occupiedByNamespace.evidence).toEqual([taken]);

    const failed = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "fail", identityMap: identityMapFor(archive) },
      ACTOR,
      false,
    );
    expect(failed.report.counts.conflict).toBeGreaterThan(0);
    expect(
      failed.report.reconstructionReasons.some((reason) => reason.code === "id_collision"),
    ).toBe(true);
    expect(failed.report.exactReconstruction).toBe(false);
    expect(failed.apply.confirmationToken).toBeNull();

    // The same occupancy under remap must resolve to the next ladder rung.
    const remapped = await row.portable.preflight(
      archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap: identityMapFor(archive),
      },
      ACTOR,
      false,
    );
    expect(
      remapped.report.idRemap.find(
        (item) => item.namespace === "evidence" && item.sourceId === evidenceId,
      )?.destinationId,
    ).toBe(
      portableDestinationUuid(
        archive.investigation.sourceInstallationId,
        "evidence",
        evidenceId,
        1,
      ),
    );
    expect(remapped.report.exactReconstruction).toBe(true);
  });

  it("escalates the deterministic ladder only for ids whose rung is occupied", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const evidenceId = archive.investigation.evidence[0]?.id;
    if (!evidenceId) throw new Error("synthetic archive has no evidence");
    const template = (await row.caseStore.listArtifactsByCase(row.caseId))[0];
    if (!template) throw new Error("synthetic artifact is missing");
    for (const rung of [0, 1, 2]) {
      await row.caseStore.insertArtifact({
        ...template,
        id: portableDestinationUuid(
          archive.investigation.sourceInstallationId,
          "evidence",
          evidenceId,
          rung,
        ),
      });
    }
    const clean = await probePortableCollisions(archive.investigation, row.probe);
    // Three occupied rungs cost four evidence probes: rungs 0-2 hit, rung 3 clears.
    expect(clean.occupiedByNamespace.evidence).toHaveLength(3);
    expect(clean.deepestRung).toBe(3);
    expect(clean.probeCalls).toBeLessThanOrEqual(PROBED_PORTABLE_NAMESPACES.length + 3);
  });

  it("refuses a stale intent when a probed destination id is taken after preflight", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const token = preview.apply.confirmationToken;
    if (!token) throw new Error("synthetic preflight did not mint a confirmation");

    const evidenceId = archive.investigation.evidence[0]?.id;
    if (!evidenceId) throw new Error("synthetic archive has no evidence");
    const template = (await row.caseStore.listArtifactsByCase(row.caseId))[0];
    if (!template) throw new Error("synthetic artifact is missing");
    await row.caseStore.insertArtifact({
      ...template,
      id: portableDestinationUuid(
        archive.investigation.sourceInstallationId,
        "evidence",
        evidenceId,
        0,
      ),
    });

    const casesBefore = (await row.caseStore.listCases()).length;
    await expect(
      row.portable.apply(
        archive,
        {
          confirmationToken: token,
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
          collisionPolicy: "remap_deterministic",
          identityMap,
        },
        ACTOR,
        false,
      ),
    ).rejects.toMatchObject({ code: "stale_destination_catalog" });
    // Refused before any mutation.
    expect((await row.caseStore.listCases()).length).toBe(casesBefore);
  });

  it("rolls back rather than overwriting a destination key taken inside the transaction", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const investigationId = portableDestinationUuid(
      archive.investigation.sourceInstallationId,
      "investigation",
      archive.investigation.investigation.id,
      0,
    );
    const template = (await row.caseStore.listCases())[0];
    if (!template) throw new Error("synthetic case is missing");
    await row.caseStore.insertCase({
      ...template,
      id: investigationId,
      title: "synthetic concurrent claim",
    });

    // The guard is what apply runs inside its transaction. It must refuse a
    // report whose destination ids are no longer free, so the surrounding
    // transaction rolls back instead of clobbering the row above.
    await expect(
      assertDestinationIdsUnoccupied(
        { idRemap: [{ namespace: "investigation", destinationId: investigationId }] },
        row.probe,
      ),
    ).rejects.toBeInstanceOf(PortableDestinationOccupiedError);

    // A clean report passes the same guard.
    await expect(
      assertDestinationIdsUnoccupied(
        {
          idRemap: [
            {
              namespace: "investigation",
              destinationId: portableDestinationUuid(
                archive.investigation.sourceInstallationId,
                "investigation",
                archive.investigation.investigation.id,
                1,
              ),
            },
          ],
        },
        row.probe,
      ),
    ).resolves.toBeUndefined();

    // The concurrently claimed row is untouched.
    expect((await row.caseStore.getCase(investigationId))?.title).toBe(
      "synthetic concurrent claim",
    );
  });

  it("never treats a non-keying namespace as probeable", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    for (const kind of PORTABLE_OBJECT_KINDS) {
      const reason = unprobedNamespaceReason(kind);
      const probed = PROBED_PORTABLE_NAMESPACES.includes(kind);
      expect(probed).toBe(reason === null);
      if (!probed) expect(reason).toMatch(/\w/);
    }
    expect([...PROBED_PORTABLE_NAMESPACES].sort()).toEqual(
      [
        "contribution",
        "evidence",
        "experiment",
        "gold",
        "helpfulness",
        "imported_ai_run",
        "investigation",
        "snapshot",
        "source",
        "triage_job",
        "attachment",
      ].sort(),
    );
    // Probing a bundle with no occupied ids reports nothing at all.
    const probe = await probePortableCollisions(archive.investigation, row.probe);
    expect(probe.occupiedByNamespace).toEqual({});
    expect(probe.deepestRung).toBe(0);
  });

  it("applies cleanly and replays idempotently after the scoped probe", async () => {
    const row = await lab();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    await growUnrelatedCorpus(row, 5, 2);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const token = preview.apply.confirmationToken;
    if (!token) throw new Error("synthetic preflight did not mint a confirmation");
    const input = {
      confirmationToken: token,
      typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
      collisionPolicy: "remap_deterministic" as const,
      identityMap,
    };
    const applied = await row.portable.apply(archive, input, ACTOR, false);
    expect(applied.status).toBe("applied");
    expect(applied.destinationMembershipGranted).toBe(false);
    expect(applied.destinationRoleGranted).toBe(false);
    expect(applied.destinationCapabilityGranted).toBe(false);

    const replay = await row.portable.apply(archive, input, ACTOR, false);
    expect(replay.status).toBe("idempotent_replay");
    expect(replay.investigationId).toBe(applied.investigationId);

    // The applied investigation is the deterministic id the probe cleared, and
    // only the applying actor is a member.
    expect(applied.investigationId).toBe(
      portableDestinationUuid(
        archive.investigation.sourceInstallationId,
        "investigation",
        archive.investigation.investigation.id,
        0,
      ),
    );
    const imported = await row.caseStore.getCase(applied.investigationId);
    expect(imported?.participants).toEqual([
      { identityId: ACTOR.id, username: ACTOR.username },
    ]);
  });
});

describe.skipIf(!adminUrl())("portable collision probe memory/PostgreSQL parity", () => {
  it("answers identical probes from the memory and PostgreSQL stores", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const root = await mkdtemp(join(tmpdir(), "cd-portable-parity-"));
      roots.push(root);
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const memoryAudit = new MemoryAuditStore();
      // PostgreSQL case writes require an audit store bound to the same
      // connection, so each backend gets its own matched pair.
      const pgAudit = new PgAuditStore(client);

      const memoryCases = new MemoryCaseStore();
      const memoryCatalog = new MemoryCatalogStore();
      const pgCases = new PgCaseStore(client);
      const pgCatalog = new PgCatalogStore(client);

      // Same synthetic writes into both backends.
      const memoryService = new CaseService(
        store,
        memoryAudit,
        memoryCases,
        new CatalogService(memoryCatalog, memoryAudit),
      );
      const pgService = new CaseService(
        store,
        pgAudit,
        pgCases,
        new CatalogService(pgCatalog, pgAudit),
      );
      const created: string[] = [];
      const contributions: string[] = [];
      for (const service of [memoryService, pgService]) {
        const row = await service.createCase(
          ACTOR,
          { title: "Synthetic parity case", severity: "low" },
          "fixture",
        );
        created.push(row.id);
        const note = await service.addContribution(
          row.id,
          ACTOR,
          { kind: "note", body: "Synthetic parity note.", privacyClass: "share_safe" },
          "fixture",
        );
        contributions.push(note.id);
      }
      const [memoryCaseId, pgCaseId] = created;
      const [memoryContributionId, pgContributionId] = contributions;
      if (!memoryCaseId || !pgCaseId || !memoryContributionId || !pgContributionId) {
        throw new Error("synthetic parity fixture is incomplete");
      }

      const absent = portableDestinationUuid("inst-paritylab00001", "investigation", "nope", 0);

      // Present id, absent id, empty batch, and duplicate input all agree.
      expect(await memoryCases.probeExistingIds("case", [memoryCaseId, absent])).toEqual([
        memoryCaseId,
      ]);
      expect(await pgCases.probeExistingIds("case", [pgCaseId, absent])).toEqual([pgCaseId]);
      expect(await memoryCases.probeExistingIds("case", [])).toEqual([]);
      expect(await pgCases.probeExistingIds("case", [])).toEqual([]);
      expect(await memoryCases.probeExistingIds("case", [absent, absent])).toEqual([]);
      expect(await pgCases.probeExistingIds("case", [absent, absent])).toEqual([]);
      expect(
        await memoryCases.probeExistingIds("case", [memoryCaseId, memoryCaseId]),
      ).toEqual([memoryCaseId]);
      expect(await pgCases.probeExistingIds("case", [pgCaseId, pgCaseId])).toEqual([pgCaseId]);

      expect(
        await memoryCases.probeExistingIds("contribution", [memoryContributionId, absent]),
      ).toEqual([memoryContributionId]);
      expect(await pgCases.probeExistingIds("contribution", [pgContributionId, absent])).toEqual([
        pgContributionId,
      ]);

      // A case id must not answer a contribution probe in either backend.
      expect(await memoryCases.probeExistingIds("contribution", [memoryCaseId])).toEqual([]);
      expect(await pgCases.probeExistingIds("contribution", [pgCaseId])).toEqual([]);
      expect(await memoryCases.probeExistingIds("artifact", [memoryCaseId])).toEqual([]);
      expect(await pgCases.probeExistingIds("artifact", [pgCaseId])).toEqual([]);
      expect(await memoryCases.probeExistingIds("snapshot", [memoryCaseId])).toEqual([]);
      expect(await pgCases.probeExistingIds("snapshot", [pgCaseId])).toEqual([]);

      // Participants resolve by id and by username, and unknown names resolve
      // to nothing rather than to a guess. The probe answers from the caller's
      // own view, so an outsider's scope resolves to nothing in either backend.
      const scope = { actorId: ACTOR.id, isAdmin: false };
      const outsider = { actorId: "actor-outsider", isAdmin: false };
      expect(await memoryCases.probeParticipants({ scope, identityIds: [ACTOR.id] })).toEqual([
        { identityId: ACTOR.id, username: ACTOR.username },
      ]);
      expect(await pgCases.probeParticipants({ scope, identityIds: [ACTOR.id] })).toEqual([
        { identityId: ACTOR.id, username: ACTOR.username },
      ]);
      expect(await memoryCases.probeParticipants({ scope, usernames: [ACTOR.username] })).toEqual([
        { identityId: ACTOR.id, username: ACTOR.username },
      ]);
      expect(await pgCases.probeParticipants({ scope, usernames: [ACTOR.username] })).toEqual([
        { identityId: ACTOR.id, username: ACTOR.username },
      ]);
      expect(
        await memoryCases.probeParticipants({ scope, usernames: ["operator-nobody"] }),
      ).toEqual([]);
      expect(await pgCases.probeParticipants({ scope, usernames: ["operator-nobody"] })).toEqual([]);
      expect(await memoryCases.probeParticipants({ scope })).toEqual([]);
      expect(await pgCases.probeParticipants({ scope })).toEqual([]);
      expect(
        await memoryCases.probeParticipants({ scope: outsider, identityIds: [ACTOR.id] }),
      ).toEqual([]);
      expect(
        await pgCases.probeParticipants({ scope: outsider, identityIds: [ACTOR.id] }),
      ).toEqual([]);
      // An admin scope sees the same rows the member scope does.
      expect(
        await memoryCases.probeParticipants({
          scope: { actorId: "actor-outsider", isAdmin: true },
          identityIds: [ACTOR.id],
        }),
      ).toEqual([{ identityId: ACTOR.id, username: ACTOR.username }]);
      expect(
        await pgCases.probeParticipants({
          scope: { actorId: "actor-outsider", isAdmin: true },
          identityIds: [ACTOR.id],
        }),
      ).toEqual([{ identityId: ACTOR.id, username: ACTOR.username }]);

      // The remaining probe ports agree on an empty destination.
      const memoryPorts: PortableCollisionProbePorts = {
        cases: memoryCases,
        catalog: memoryCatalog,
        experiments: new MemoryExperimentStore(),
        runs: new MemoryRunStore(),
        jobs: new MemoryTriageJobStore(),
      };
      const pgPorts: PortableCollisionProbePorts = {
        cases: pgCases,
        catalog: pgCatalog,
        experiments: new PgExperimentStore(client),
        runs: new PgRunStore(client),
        jobs: new PgTriageJobStore(client),
      };
      for (const ports of [memoryPorts, pgPorts]) {
        expect(await ports.catalog.probeExistingIds([absent])).toEqual([]);
        expect(await ports.runs.probeExistingIds([absent])).toEqual([]);
        expect(await ports.jobs.probeExistingIds([absent])).toEqual([]);
        expect(await ports.experiments.probeExistingIds("experiment", [absent])).toEqual([]);
        expect(await ports.experiments.probeExistingIds("helpfulness", [absent])).toEqual([]);
        expect(await ports.experiments.probeExistingIds("gold", [absent])).toEqual([]);
      }
    });
  });
});
