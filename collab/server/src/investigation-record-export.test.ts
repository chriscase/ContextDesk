/**
 * The record graph as it leaves the tool.
 *
 * An owner-only brief carries the whole record. A share-safe brief carries the
 * shape of it — which parties, which relationships, which citations, how the
 * conclusion was reached — while withholding the names and reasoning that
 * belong inside. What it must never do is look complete while quietly dropping
 * the fact that unknowns remained.
 *
 * Every identity, label, and body is synthetic.
 */
import { parseBrief, parseCase, parseExportEnvelope } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { shareSafeEntityHandle } from "./modules/export/index.js";
import {
  body,
  createEntity,
  createInvestigation,
  login,
  withRecordApp,
} from "./test/investigation-record-harness.js";

/**
 * Builds one investigation carrying every part of the record graph, then
 * exports it in both variants through the real HTTP export route.
 */
async function withExportedBriefs(
  fn: (ctx: {
    ownerOnly: ReturnType<typeof parseBrief>;
    shareSafe: ReturnType<typeof parseBrief>;
    disclosedEntityId: string;
    withheldEntityId: string;
    citedId: string;
  }) => Promise<void>,
): Promise<void> {
  await withRecordApp(async (ctx) => {
    const { app } = ctx;
    const alice = await login(app, "alice");
    const cited = parseCase(
      await createInvestigation(app, alice, { title: "Synthetic prior investigation" }),
    );
    const investigation = parseCase(
      await createInvestigation(app, alice, {
        title: "Synthetic current investigation",
        occurredAt: "2024-11-04",
      }),
    );

    // One label the registry has cleared to leave the tool, one it has not.
    const disclosed = body(
      await app.inject({
        method: "POST",
        url: "/api/entities",
        headers: { cookie: alice },
        payload: { kind: "service", label: "Synthetic checkout", privacyClass: "share_safe" },
      }),
    );
    const withheld = await createEntity(app, alice, {
      kind: "organization",
      label: "Fable Harbor",
    });

    for (const entityId of [String(disclosed.id), String(withheld.id)]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${investigation.id}/involvement`,
            headers: { cookie: alice },
            payload: { entityId, relationship: "affected", occurredAt: "2024-11-04" },
          })
        ).statusCode,
      ).toBe(201);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/cases/${investigation.id}/references`,
          headers: { cookie: alice },
          payload: { toInvestigationId: cited.id, note: "Same synthetic signature." },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/cases/${investigation.id}/status`,
          headers: { cookie: alice },
          payload: {
            status: "resolved",
            resolution: {
              basis: "human_only",
              rationale: "Synthetic reasoning that must not leave the tool.",
              unknowns: ["Which synthetic upstream change moved the batch."],
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const briefs: Record<string, ReturnType<typeof parseBrief>> = {};
    for (const variant of ["owner_only", "share_safe"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/export/brief`,
        headers: { cookie: alice },
        payload: { variant },
      });
      expect(res.statusCode).toBe(200);
      const envelope = parseExportEnvelope(body(res));
      briefs[variant] = parseBrief(envelope.payload);
    }
    await fn({
      ownerOnly: briefs.owner_only as ReturnType<typeof parseBrief>,
      shareSafe: briefs.share_safe as ReturnType<typeof parseBrief>,
      disclosedEntityId: String(disclosed.id),
      withheldEntityId: String(withheld.id),
      citedId: cited.id,
    });
  });
}

describe("the record graph in an owner-only brief", () => {
  it("carries the labels, citation, and reasoning in full", async () => {
    await withExportedBriefs(async ({ ownerOnly, citedId }) => {
      expect(ownerOnly.involvement?.map((row) => row.entityRef).sort()).toEqual(
        ["Fable Harbor", "Synthetic checkout"].sort(),
      );
      expect(ownerOnly.involvement?.every((row) => row.labelDisclosed)).toBe(true);
      expect(ownerOnly.involvement?.[0]?.occurredAt).toBe("2024-11-04");
      expect(ownerOnly.involvement?.[0]?.occurredAtZone).toBe("unspecified");

      expect(ownerOnly.references).toHaveLength(1);
      expect(ownerOnly.references?.[0]?.toInvestigationId).toBe(citedId);
      expect(ownerOnly.references?.[0]?.citedTitle).toBe("Synthetic prior investigation");

      expect(ownerOnly.resolution?.basis).toBe("human_only");
      expect(ownerOnly.resolution?.rationaleIncluded).toBe(true);
      expect(ownerOnly.resolution?.rationale).toContain("Synthetic reasoning");
      expect(ownerOnly.resolution?.unknowns).toHaveLength(1);
      expect(ownerOnly.resolution?.unknownCount).toBe(1);
    });
  });
});

describe("the record graph in a share-safe brief", () => {
  it("keeps a cleared label and pseudonymises one that was never cleared", async () => {
    await withExportedBriefs(async ({ shareSafe, withheldEntityId }) => {
      const refs = shareSafe.involvement ?? [];
      expect(refs).toHaveLength(2);
      const disclosed = refs.filter((row) => row.labelDisclosed);
      const withheldRows = refs.filter((row) => !row.labelDisclosed);
      expect(disclosed.map((row) => row.entityRef)).toEqual(["Synthetic checkout"]);
      expect(withheldRows.map((row) => row.entityRef)).toEqual([
        shareSafeEntityHandle(withheldEntityId),
      ]);
      // The name never appears anywhere in the payload.
      expect(JSON.stringify(shareSafe)).not.toContain("Fable Harbor");
      // The kind and relationship survive, so the shape of the case is still
      // readable without the name.
      expect(withheldRows[0]?.kind).toBe("organization");
      expect(withheldRows[0]?.relationship).toBe("affected");
    });
  });

  it("gives the same party the same handle across exports", async () => {
    expect(shareSafeEntityHandle("8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91")).toBe(
      shareSafeEntityHandle("8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91"),
    );
    expect(shareSafeEntityHandle("8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91")).not.toBe(
      shareSafeEntityHandle("0d9c8b7a-6543-4210-9fed-cba987654321"),
    );
    expect(shareSafeEntityHandle("8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91")).toMatch(
      /^entity:[0-9a-f]{12}$/,
    );
  });

  it("keeps the citation pointer and withholds the other investigation's title", async () => {
    await withExportedBriefs(async ({ shareSafe, citedId }) => {
      const reference = shareSafe.references?.[0];
      expect(reference?.toInvestigationId).toBe(citedId);
      expect(reference?.locator).toContain(citedId);
      expect(reference?.citedTitle).toBeNull();
      expect(JSON.stringify(shareSafe)).not.toContain("Synthetic prior investigation");
    });
  });

  it("withholds the reasoning but never hides that unknowns remained", async () => {
    await withExportedBriefs(async ({ shareSafe }) => {
      expect(shareSafe.resolution?.basis).toBe("human_only");
      expect(shareSafe.resolution?.provenance).toBe("human");
      expect(shareSafe.resolution?.rationaleIncluded).toBe(false);
      expect(shareSafe.resolution?.rationale).toBeNull();
      expect(shareSafe.resolution?.unknowns).toBeNull();
      // The count is the honest part that must not be lost with the text.
      expect(shareSafe.resolution?.unknownCount).toBe(1);
      expect(JSON.stringify(shareSafe)).not.toContain("must not leave the tool");
    });
  });

  it("re-exports byte-identically when nothing changed", async () => {
    await withRecordApp(async (ctx) => {
      const { app } = ctx;
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic deterministic" }),
      );
      const entity = await createEntity(app, alice, { kind: "system", label: "Synthetic system" });
      await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/involvement`,
        headers: { cookie: alice },
        payload: { entityId: String(entity.id), relationship: "responsible" },
      });
      const exports = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: `/api/cases/${investigation.id}/export/brief`,
          headers: { cookie: alice },
          payload: { variant: "owner_only" },
        });
        expect(res.statusCode).toBe(200);
        const envelope = parseExportEnvelope(body(res));
        exports.push(JSON.stringify(envelope.payload));
      }
      expect(exports[0]).toBe(exports[1]);
    });
  });
});

describe("an installation without the record graph", () => {
  it("says nothing was recorded rather than looking redacted", async () => {
    await withRecordApp(async (ctx) => {
      const { app } = ctx;
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic bare" }),
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/export/brief`,
        headers: { cookie: alice },
        payload: { variant: "owner_only" },
      });
      expect(res.statusCode).toBe(200);
      const brief = parseBrief(parseExportEnvelope(body(res)).payload);
      expect(brief.involvement).toEqual([]);
      expect(brief.references).toEqual([]);
      expect(brief.resolution).toBeNull();
    });
  });
});
