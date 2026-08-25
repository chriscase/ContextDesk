/**
 * Adversarial coverage for what may and may not count as a destination
 * collision during a portable restore.
 *
 * Every id here is synthetic and comes from the checked-in contract fixture.
 * The distinction under test is the one that decides whether an otherwise
 * exact restore is blocked: a raw source id, a per-case timeline sequence, and
 * a content digest are not destination keys, while the deterministic UUID a
 * minted namespace would write is.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_DETERMINISTIC_REMAP_ATTEMPTS,
  PORTABLE_OBJECT_KINDS,
  attachPortableIntegrity,
  isRfc4122Uuid,
  portableDestinationIdCandidates,
  portableDestinationUuid,
  portableIdMintingMode,
  portableMintsDestinationId,
  preflightPortableInvestigation,
  type PortableInvestigationUnsigned,
  type PortableInvestigationV1,
  type PortableObjectKind,
  type PreflightRequestV1,
} from "./investigation-portable.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function unsignedOf(bundle: PortableInvestigationV1): PortableInvestigationUnsigned {
  const { bundleFingerprint: _fp, objectHashes: _hashes, ...rest } = bundle;
  return rest;
}

/** The checked-in synthetic bundle, with every content object present so a
 * clean destination reconstructs exactly and a collision is the only thing
 * that can block it. */
function bundleFixture(): PortableInvestigationV1 {
  const raw = JSON.parse(
    readFileSync(join(fixturesDir, "investigation-portable.valid.json"), "utf8"),
  ) as PortableInvestigationV1;
  const bytes = Buffer.from("synthetic-collision-scope-bytes", "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const withheld = raw.evidence.find((row) => row.inclusion !== "present");
  const content = raw.contentObjects.find((row) => row.digest === withheld?.digest);
  if (!withheld || !content) throw new Error("fixture shape changed");
  const previousDigest = withheld.digest;
  withheld.inclusion = "present";
  withheld.digest = digest;
  withheld.byteLength = bytes.byteLength;
  content.inclusion = "present";
  content.digest = digest;
  content.byteLength = bytes.byteLength;
  content.payloadBase64 = bytes.toString("base64");
  for (const attachment of raw.attachments) {
    if (attachment.digest === previousDigest) attachment.digest = digest;
  }
  return attachPortableIntegrity(unsignedOf(raw));
}

function request(
  bundle: PortableInvestigationV1,
  overlay: Partial<PreflightRequestV1> = {},
): PreflightRequestV1 {
  return {
    mode: "dry_run",
    collisionPolicy: "fail",
    identityMap: bundle.actors.map((actor) => ({
      sourceActorId: actor.sourceActorId,
      action: "preserve_historical_external" as const,
      destinationActorId: null,
    })),
    destination: {
      identities: [],
      objectIds: {},
      knownProfileIds: knownProfiles(bundle),
    },
    ...overlay,
  };
}

/** Every provider profile the bundle references, so `missing_profile` noise
 * never masks the collision signal under test. */
function knownProfiles(bundle: PortableInvestigationV1): string[] {
  const ids = new Set<string>();
  for (const job of bundle.triageJobs) {
    for (const candidate of job.candidates) {
      if (candidate.profileId) ids.add(candidate.profileId);
    }
  }
  for (const run of bundle.importedAiRuns) {
    if (run.profileId) ids.add(run.profileId);
  }
  return [...ids].sort();
}

function minted(
  bundle: PortableInvestigationV1,
  namespace: PortableObjectKind,
  sourceId: string,
  rung = 0,
): string {
  return portableDestinationUuid(bundle.sourceInstallationId, namespace, sourceId, rung);
}

/** Ids from the checked-in synthetic fixture. */
const EVIDENCE_ID = "ev-share";
const CONTRIBUTION_ID = "c-note";

function collisions(report: { referentialIntegrityFailures: { code: string }[] }): number {
  return report.referentialIntegrityFailures.filter((row) => row.code === "id_collision").length;
}

describe("portable restore collision scope", () => {
  it("never treats a raw source id echoed by the destination as a collision", () => {
    const bundle = bundleFixture();
    // The destination reuses every raw source id this bundle carries. None of
    // them is a destination key, so an exact restore must stay unblocked.
    const rawEverywhere = request(bundle, {
      destination: {
        identities: [],
        objectIds: {
          investigation: [bundle.investigation.id],
          contribution: bundle.contributions.map((row) => row.id),
          evidence: bundle.evidence.map((row) => row.id),
          source: bundle.sources.map((row) => row.id),
          snapshot: bundle.snapshots.map((row) => row.id),
          actor: bundle.actors.map((row) => row.sourceActorId),
        },
        knownProfileIds: [],
      },
    });
    const report = preflightPortableInvestigation(bundle, rawEverywhere);
    expect(collisions(report)).toBe(0);
    expect(report.counts.conflict).toBe(0);
    expect(report.counts.blocked).toBe(0);
    expect(report.reconstructionStatus).toBe("exact");
    expect(report.exactReconstruction).toBe(true);

    // And the remap is unchanged from a destination that shares nothing.
    const clean = preflightPortableInvestigation(bundle, request(bundle));
    expect(report.idRemap).toEqual(clean.idRemap);
  });

  it("never collides on a per-case timeline sequence another case already numbered", () => {
    const bundle = bundleFixture();
    const report = preflightPortableInvestigation(
      bundle,
      request(bundle, {
        destination: {
          identities: [],
          // A destination of any age has numbered its own timelines from 1.
          objectIds: { timeline: Array.from({ length: 500 }, (_x, i) => String(i + 1)) },
          knownProfileIds: [],
        },
      }),
    );
    expect(collisions(report)).toBe(0);
    expect(report.counts.blocked).toBe(0);
    expect(report.exactReconstruction).toBe(true);
    expect(portableIdMintingMode("timeline")).toBe("destination_sequenced");
    expect(portableMintsDestinationId("timeline")).toBe(false);
  });

  it("never collides on a content digest the destination already deduplicated", () => {
    const bundle = bundleFixture();
    const report = preflightPortableInvestigation(
      bundle,
      request(bundle, {
        destination: {
          identities: [],
          // Holding these exact bytes already is deduplication, not conflict.
          objectIds: { content: bundle.contentObjects.map((row) => row.digest) },
          knownProfileIds: [],
        },
      }),
    );
    expect(collisions(report)).toBe(0);
    expect(report.counts.blocked).toBe(0);
    expect(report.reconstructionStatus).toBe("exact");
    expect(portableIdMintingMode("content")).toBe("content_addressed");
    expect(portableMintsDestinationId("content")).toBe(false);
  });

  it("fails a real minted collision under the fail policy and names the namespace", () => {
    const bundle = bundleFixture();
    const taken = minted(bundle, "evidence", EVIDENCE_ID);
    const report = preflightPortableInvestigation(
      bundle,
      request(bundle, {
        collisionPolicy: "fail",
        destination: {
          identities: [],
          objectIds: { evidence: [taken] },
          knownProfileIds: [],
        },
      }),
    );
    expect(collisions(report)).toBe(1);
    expect(report.counts.conflict).toBe(1);
    expect(report.counts.blocked).toBeGreaterThan(0);
    expect(report.referentialIntegrityFailures).toContainEqual({
      code: "id_collision",
      path: `evidence:${EVIDENCE_ID}`,
      detail: "deterministic destination id already exists at the destination",
    });
    expect(report.reconstructionStatus).toBe("blocked");
    expect(report.exactReconstruction).toBe(false);
  });

  it("remaps a real minted collision deterministically and identically on replay", () => {
    const bundle = bundleFixture();
    const taken = minted(bundle, "evidence", EVIDENCE_ID);
    const build = (): PreflightRequestV1 =>
      request(bundle, {
        collisionPolicy: "remap_deterministic",
        destination: { identities: [], objectIds: { evidence: [taken] }, knownProfileIds: [] },
      });
    const first = preflightPortableInvestigation(bundle, build());
    const second = preflightPortableInvestigation(bundle, build());
    const row = first.idRemap.find(
      (item) => item.namespace === "evidence" && item.sourceId === EVIDENCE_ID,
    );
    expect(row?.destinationId).toBe(minted(bundle, "evidence", EVIDENCE_ID, 1));
    expect(second.idRemap).toEqual(first.idRemap);
    expect(collisions(first)).toBe(0);
    expect(first.counts.conflict).toBe(0);
  });

  it("keeps a minted collision inside its own namespace", () => {
    const bundle = bundleFixture();
    // The evidence rung-0 id is occupied; the contribution with the same raw
    // id shape must be untouched, and a same-name id in another namespace
    // must not be dragged in.
    const report = preflightPortableInvestigation(
      bundle,
      request(bundle, {
        collisionPolicy: "fail",
        destination: {
          identities: [],
          objectIds: { evidence: [minted(bundle, "evidence", EVIDENCE_ID)] },
          knownProfileIds: [],
        },
      }),
    );
    const failures = report.referentialIntegrityFailures.filter(
      (item) => item.code === "id_collision",
    );
    expect(failures.map((item) => item.path)).toEqual([`evidence:${EVIDENCE_ID}`]);
    const contribution = report.idRemap.find(
      (item) => item.namespace === "contribution" && item.sourceId === CONTRIBUTION_ID,
    );
    expect(contribution?.destinationId).toBe(minted(bundle, "contribution", CONTRIBUTION_ID));
    expect(minted(bundle, "evidence", EVIDENCE_ID)).not.toBe(minted(bundle, "contribution", EVIDENCE_ID));
  });

  it("walks and then exhausts the bounded ladder rather than reusing an occupied id", () => {
    const bundle = bundleFixture();
    const ladder = Array.from({ length: MAX_DETERMINISTIC_REMAP_ATTEMPTS }, (_x, rung) =>
      minted(bundle, "evidence", EVIDENCE_ID, rung),
    );
    const partial = preflightPortableInvestigation(
      bundle,
      request(bundle, {
        collisionPolicy: "remap_deterministic",
        destination: {
          identities: [],
          objectIds: { evidence: ladder.slice(0, 5) },
          knownProfileIds: [],
        },
      }),
    );
    expect(
      partial.idRemap.find(
        (row) => row.namespace === "evidence" && row.sourceId === EVIDENCE_ID,
      )?.destinationId,
    ).toBe(ladder[5]);

    expect(() =>
      preflightPortableInvestigation(
        bundle,
        request(bundle, {
          collisionPolicy: "remap_deterministic",
          destination: { identities: [], objectIds: { evidence: ladder }, knownProfileIds: [] },
        }),
      ),
    ).toThrow(/deterministic remap space exhausted/);
  });

  it("publishes a bounded, archive-scoped candidate ladder for host probing", () => {
    const bundle = bundleFixture();
    const rungs = portableDestinationIdCandidates(bundle.sourceInstallationId, "evidence", EVIDENCE_ID, 4);
    expect(rungs).toHaveLength(4);
    expect(rungs).toEqual([0, 1, 2, 3].map((rung) => minted(bundle, "evidence", EVIDENCE_ID, rung)));
    expect(new Set(rungs).size).toBe(4);
    for (const candidate of rungs) expect(isRfc4122Uuid(candidate)).toBe(true);

    // The ladder is capped, so a host can never be asked for unbounded work.
    expect(
      portableDestinationIdCandidates(bundle.sourceInstallationId, "evidence", EVIDENCE_ID, 10_000),
    ).toHaveLength(MAX_DETERMINISTIC_REMAP_ATTEMPTS);

    // A namespace that mints nothing yields nothing to probe.
    expect(portableDestinationIdCandidates(bundle.sourceInstallationId, "content", "d", 4)).toEqual(
      [],
    );
    expect(portableDestinationIdCandidates(bundle.sourceInstallationId, "timeline", "1", 4)).toEqual(
      [],
    );
  });

  it("classifies every portable namespace exactly once", () => {
    for (const kind of PORTABLE_OBJECT_KINDS) {
      const mode = portableIdMintingMode(kind);
      expect(["minted", "content_addressed", "destination_sequenced"]).toContain(mode);
      expect(portableMintsDestinationId(kind)).toBe(mode === "minted");
    }
    expect(PORTABLE_OBJECT_KINDS.filter((kind) => !portableMintsDestinationId(kind)).sort()).toEqual(
      ["content", "timeline"],
    );
  });

  it("does not let a destination id from another installation collide", () => {
    const bundle = bundleFixture();
    const foreign = portableDestinationUuid("inst-otherlab000001", "evidence", EVIDENCE_ID, 0);
    expect(foreign).not.toBe(minted(bundle, "evidence", EVIDENCE_ID));
    const report = preflightPortableInvestigation(
      bundle,
      request(bundle, {
        destination: { identities: [], objectIds: { evidence: [foreign] }, knownProfileIds: [] },
      }),
    );
    expect(collisions(report)).toBe(0);
    expect(report.exactReconstruction).toBe(true);
  });
});
