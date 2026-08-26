/**
 * The investigation record graph over HTTP.
 *
 * These exercise the whole vertical slice the way an operator meets it:
 * open a historical investigation with the date it actually happened, name
 * who and what it involves with labels that survive being reused, cite an
 * older investigation, and conclude it with a human-only resolution.
 *
 * Every identity, label, and body is synthetic.
 */
import {
  parseCase,
  parseInvestigationEntity,
  parseInvestigationEntityList,
  parseInvestigationInvolvement,
  parseInvestigationInvolvementList,
  parseInvestigationReferenceList,
  parseInvestigationResolution,
  parseInvestigationResolutionList,
  parseInvolvementIndex,
  parseSoftwareImpact,
  parseSoftwareImpactList,
  parseSoftwareImpactSuggestions,
  parseTimeline,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  body,
  createEntity,
  createInvestigation,
  login,
  withRecordApp,
} from "./test/investigation-record-harness.js";

describe("occurred-at versus recorded-at on an investigation", () => {
  it("opens a case for work that happened two years ago without touching the audit clock", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const created = parseCase(
        await createInvestigation(app, alice, {
          title: "Synthetic checkout timeouts",
          occurredAt: "2024-11-04",
        }),
      );
      expect(created.occurredAt).toBe("2024-11-04");
      expect(created.occurredAtPrecision).toBe("day");
      // The operator typed a date, not an instant. Nothing invented an offset.
      expect(created.occurredAtZone).toBe("unspecified");
      // The recording clock is today and is entirely separate.
      expect(created.createdAt).not.toBe("2024-11-04");
      expect(Date.parse(created.createdAt)).toBeGreaterThan(Date.parse("2025-01-01T00:00:00Z"));
    });
  });

  it("backfills an occurrence later without rewriting created-at or the timeline", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const created = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic backfill" }),
      );
      expect(created.occurredAt).toBeNull();
      expect(created.occurredAtPrecision).toBe("unknown");

      const before = parseTimeline(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${created.id}/timeline`,
            headers: { cookie: alice },
          }),
        ),
      );

      const patched = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/occurred-at`,
        headers: { cookie: alice },
        payload: { occurredAt: "2019-06" },
      });
      expect(patched.statusCode).toBe(200);
      const updated = parseCase(body(patched));
      expect(updated.occurredAt).toBe("2019-06");
      expect(updated.occurredAtPrecision).toBe("month");
      expect(updated.createdAt).toBe(created.createdAt);

      const after = parseTimeline(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${created.id}/timeline`,
            headers: { cookie: alice },
          }),
        ),
      );
      // History is appended to, never rewritten: the earlier events are
      // byte-identical and the backfill is a new event of its own.
      expect(after.events.slice(0, before.events.length)).toEqual(before.events);
      expect(after.events.at(-1)?.kind).toBe("case_occurred_at");
    });
  });

  it("refuses a future or impossible occurrence with an actionable message", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      for (const occurredAt of ["2999-01-01", "2024-02-30", "yesterday", "04/11/2024"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/cases",
          headers: { cookie: alice },
          payload: { title: "Synthetic rejected", occurredAt },
        });
        expect(res.statusCode).toBe(400);
        expect(String(body(res).detail ?? "")).toContain("occurredAt");
      }
    });
  });
});

describe("the reusable entity registry", () => {
  it("creates, filters, and reuses labels across investigations", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const org = parseInvestigationEntity(
        await createEntity(app, alice, {
          kind: "organization",
          label: "Fable Harbor",
          profile: { summary: "Synthetic counterparty in the fixture corpus.", reference: "SYN-1" },
        }),
      );
      await createEntity(app, alice, { kind: "service", label: "Synthetic checkout" });

      const all = parseInvestigationEntityList(
        body(await app.inject({ method: "GET", url: "/api/entities", headers: { cookie: alice } })),
      );
      expect(all.entities).toHaveLength(2);

      const orgsOnly = parseInvestigationEntityList(
        body(
          await app.inject({
            method: "GET",
            url: "/api/entities?kind=organization",
            headers: { cookie: alice },
          }),
        ),
      );
      expect(orgsOnly.entities.map((row) => row.id)).toEqual([org.id]);

      const searched = parseInvestigationEntityList(
        body(
          await app.inject({
            method: "GET",
            url: "/api/entities?q=harbor",
            headers: { cookie: alice },
          }),
        ),
      );
      expect(searched.entities.map((row) => row.label)).toEqual(["Fable Harbor"]);

      // The whole point of a registry: the second investigation gets the same
      // row rather than a near-duplicate.
      const reused = await app.inject({
        method: "POST",
        url: "/api/entities",
        headers: { cookie: alice },
        payload: { kind: "organization", label: "  fable harbor  ", reuseExisting: true },
      });
      expect(reused.statusCode).toBe(201);
      expect(parseInvestigationEntity(body(reused)).id).toBe(org.id);
    });
  });

  it("refuses a duplicate active label instead of silently forking it", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const first = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "organization", label: "Fable Harbor" }),
      );
      const clash = await app.inject({
        method: "POST",
        url: "/api/entities",
        headers: { cookie: alice },
        payload: { kind: "organization", label: "Fable Harbor" },
      });
      expect(clash.statusCode).toBe(409);
      expect(body(clash)).toMatchObject({ error: "entity_exists", existingId: first.id });
    });
  });

  it("keeps a profile a descriptor rather than a place to paste evidence", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const res = await app.inject({
        method: "POST",
        url: "/api/entities",
        headers: { cookie: alice },
        payload: {
          kind: "system",
          label: "Synthetic scheduler",
          profile: {
            summary: "2019-06-04T02:11:07Z WARN pool exhausted\n2019-06-04T02:11:08Z WARN again",
            reference: "",
          },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(String(body(res).detail ?? "")).toContain("single line");
    });
  });
});

describe("involvement links and immutable historical attribution", () => {
  it("records who an investigation involves and keeps the label it was linked with", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic queue delay" }),
      );
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "organization", label: "Fable Harbor" }),
      );

      const linked = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/involvement`,
        headers: { cookie: alice },
        payload: {
          entityId: entity.id,
          relationship: "affected",
          note: "Named in the synthetic intake summary.",
          occurredAt: "2024-11-04",
        },
      });
      expect(linked.statusCode).toBe(201);
      const link = parseInvestigationInvolvement(body(linked));
      expect(link.recordedLabel).toBe("Fable Harbor");
      expect(link.occurredAt).toBe("2024-11-04");
      expect(link.occurredAtZone).toBe("unspecified");

      // Rename the registry entry. The older investigation must still read the
      // way it was written.
      const renamed = await app.inject({
        method: "POST",
        url: `/api/entities/${entity.id}`,
        headers: { cookie: alice },
        payload: { label: "Fable Harbor Holdings" },
      });
      expect(renamed.statusCode).toBe(200);

      const listed = parseInvestigationInvolvementList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/involvement`,
            headers: { cookie: alice },
          }),
        ),
      );
      const current = listed.involvements[0];
      expect(current?.recordedLabel).toBe("Fable Harbor");
      expect(current?.currentLabel).toBe("Fable Harbor Holdings");
    });
  });

  it("retires a label for new work while older investigations keep naming it", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(await createInvestigation(app, alice, { title: "Synthetic older" }));
      const newer = parseCase(await createInvestigation(app, alice, { title: "Synthetic newer" }));
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "service", label: "Synthetic legacy service" }),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${older.id}/involvement`,
            headers: { cookie: alice },
            payload: { entityId: entity.id, relationship: "affected" },
          })
        ).statusCode,
      ).toBe(201);

      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/entities/${entity.id}/retire`,
            headers: { cookie: alice },
          })
        ).statusCode,
      ).toBe(200);

      const blocked = await app.inject({
        method: "POST",
        url: `/api/cases/${newer.id}/involvement`,
        headers: { cookie: alice },
        payload: { entityId: entity.id, relationship: "affected" },
      });
      expect(blocked.statusCode).toBe(409);
      expect(body(blocked)).toMatchObject({ error: "entity_retired" });

      const stillThere = parseInvestigationInvolvementList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${older.id}/involvement`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(stillThere.involvements[0]?.recordedLabel).toBe("Synthetic legacy service");
      expect(stillThere.involvements[0]?.currentLifecycle).toBe("retired");
    });
  });

  it("releases an involvement without deleting that it ever existed", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic release" }),
      );
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "person", label: "Synthetic reporter" }),
      );
      const link = parseInvestigationInvolvement(
        body(
          await app.inject({
            method: "POST",
            url: `/api/cases/${investigation.id}/involvement`,
            headers: { cookie: alice },
            payload: { entityId: entity.id, relationship: "reporting" },
          }),
        ),
      );
      const released = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/involvement/${link.id}/release`,
        headers: { cookie: alice },
      });
      expect(released.statusCode).toBe(200);
      const after = parseInvestigationInvolvement(body(released));
      expect(after.state).toBe("released");
      expect(after.releasedAt).not.toBeNull();

      const listed = parseInvestigationInvolvementList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/involvement`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(listed.involvements).toHaveLength(1);
    });
  });

  it("indexes involvement only across investigations the reader can already list", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const bob = await login(app, "bob");
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "organization", label: "Fable Harbor" }),
      );
      const aliceCase = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic alice case" }),
      );
      const bobCase = parseCase(
        await createInvestigation(app, bob, { title: "Synthetic bob case" }),
      );
      for (const [cookie, id] of [
        [alice, aliceCase.id],
        [bob, bobCase.id],
      ] as const) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${id}/involvement`,
              headers: { cookie },
              payload: { entityId: entity.id, relationship: "affected" },
            })
          ).statusCode,
        ).toBe(201);
      }

      const aliceIndex = parseInvolvementIndex(
        body(
          await app.inject({
            method: "GET",
            url: "/api/involvement/index",
            headers: { cookie: alice },
          }),
        ),
      );
      expect(aliceIndex.entries.map((row) => row.investigationId)).toEqual([aliceCase.id]);

      const daveIndex = parseInvolvementIndex(
        body(
          await app.inject({
            method: "GET",
            url: "/api/involvement/index",
            headers: { cookie: await login(app, "dave") },
          }),
        ),
      );
      expect(daveIndex.entries.map((row) => row.investigationId).sort()).toEqual(
        [aliceCase.id, bobCase.id].sort(),
      );
    });
  });
});

describe("authorized cross-investigation references", () => {
  it("cites an older investigation and deep-links to it without copying anything", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(
        await createInvestigation(app, alice, {
          title: "Synthetic checkout timeouts (2019)",
          problemStatement: "Synthetic prior analysis that must not be copied.",
        }),
      );
      const current = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic checkout timeouts (today)" }),
      );

      const cited = await app.inject({
        method: "POST",
        url: `/api/cases/${current.id}/references`,
        headers: { cookie: alice },
        payload: {
          toInvestigationId: older.id,
          note: "Same synthetic timeout signature.",
        },
      });
      expect(cited.statusCode).toBe(201);

      const listed = parseInvestigationReferenceList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${current.id}/references`,
            headers: { cookie: alice },
          }),
        ),
      );
      const reference = listed.outbound[0];
      expect(reference?.visibility).toBe("resolved");
      expect(reference?.recordedTitle).toBe("Synthetic checkout timeouts (2019)");
      expect(reference?.locator).toBe(`/investigations/${older.id}/situation?section=stage-situation#stage-situation`);
      // The citation carries no content from the cited investigation.
      expect(JSON.stringify(reference)).not.toContain("must not be copied");

      // The cited investigation itself is untouched.
      const olderAfter = parseCase(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${older.id}`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(olderAfter.situationVersion).toBe(older.situationVersion);
      expect(olderAfter.status).toBe(older.status);
    });
  });

  it("shows the cited investigation the citation from the other side", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(await createInvestigation(app, alice, { title: "Synthetic cited" }));
      const current = parseCase(await createInvestigation(app, alice, { title: "Synthetic citing" }));
      await app.inject({
        method: "POST",
        url: `/api/cases/${current.id}/references`,
        headers: { cookie: alice },
        payload: { toInvestigationId: older.id },
      });
      const listed = parseInvestigationReferenceList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${older.id}/references`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(listed.outbound).toHaveLength(0);
      expect(listed.inbound).toHaveLength(1);
      expect(listed.inbound[0]?.fromInvestigationId).toBe(current.id);
    });
  });

  it("withdraws a citation by marking it, never by erasing it", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(await createInvestigation(app, alice, { title: "Synthetic cited" }));
      const current = parseCase(await createInvestigation(app, alice, { title: "Synthetic citing" }));
      const created = body(
        await app.inject({
          method: "POST",
          url: `/api/cases/${current.id}/references`,
          headers: { cookie: alice },
          payload: { toInvestigationId: older.id },
        }),
      );
      const withdrawn = await app.inject({
        method: "POST",
        url: `/api/cases/${current.id}/references/${String(created.id)}/withdraw`,
        headers: { cookie: alice },
      });
      expect(withdrawn.statusCode).toBe(200);
      const listed = parseInvestigationReferenceList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${current.id}/references`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(listed.outbound[0]?.state).toBe("withdrawn");
      expect(listed.outbound[0]?.withdrawnAt).not.toBeNull();
    });
  });
});

describe("human-only resolution and the resolved-status guard", () => {
  it("refuses to resolve an investigation with nothing recorded behind it", async () => {
    await withRecordApp(async ({ app, audit }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic manual investigation" }),
      );
      const refused = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: { status: "resolved" },
      });
      expect(refused.statusCode).toBe(409);
      expect(body(refused)).toMatchObject({ error: "resolution_required", status: "resolved" });

      // The refusal leaves the investigation exactly as it was.
      const unchanged = parseCase(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(unchanged.status).toBe("open");
      expect(
        (await audit.list({ action: "case_status" })).some((row) => row.outcome === "success"),
      ).toBe(false);
    });
  });

  it("resolves on human reasoning alone, with no experiment anywhere in the case", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, {
          title: "Synthetic manual investigation",
          occurredAt: "2024-11-04",
        }),
      );
      const resolved = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: {
          status: "resolved",
          resolution: {
            basis: "human_only",
            rationale:
              "The synthetic retry window matches the scheduled batch and stopped when the batch moved.",
            unknowns: ["Which upstream change moved the batch schedule."],
            occurredAt: "2024-11-06",
          },
        },
      });
      expect(resolved.statusCode).toBe(200);
      expect(parseCase(body(resolved)).status).toBe("resolved");

      const history = parseInvestigationResolutionList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/resolutions`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(history.resolutions).toHaveLength(1);
      const head = history.resolutions[0];
      expect(head?.basis).toBe("human_only");
      expect(head?.provenance).toBe("human");
      expect(head?.experimentDecisionId).toBeNull();
      expect(head?.unknowns).toHaveLength(1);
      expect(head?.occurredAt).toBe("2024-11-06");
      expect(head?.revision).toBe(1);
    });
  });

  it("accepts a resolution recorded first and then a plain status transition", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic two step" }),
      );
      const recorded = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/resolutions`,
        headers: { cookie: alice },
        payload: {
          basis: "reasoned_exception",
          rationale: "Closed without its own conclusion so the two records do not diverge.",
          exceptionReason: "Duplicate of a consolidated synthetic investigation.",
        },
      });
      expect(recorded.statusCode).toBe(201);
      expect(parseInvestigationResolution(body(recorded)).basis).toBe("reasoned_exception");

      const resolved = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: { status: "resolved" },
      });
      expect(resolved.statusCode).toBe(200);
      expect(parseCase(body(resolved)).status).toBe("resolved");
    });
  });

  it("supersedes the reasoning when the investigation is reopened, and keeps it readable", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic reopened" }),
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: {
          status: "resolved",
          resolution: { basis: "human_only", rationale: "First synthetic conclusion." },
        },
      });
      const reopened = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: { status: "open" },
      });
      expect(reopened.statusCode).toBe(200);

      const history = parseInvestigationResolutionList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/resolutions`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(history.resolutions).toHaveLength(1);
      // Withdrawn, not deleted: the earlier reasoning is still on the record.
      expect(history.resolutions[0]?.supersededAt).not.toBeNull();
      expect(history.resolutions[0]?.rationale).toBe("First synthetic conclusion.");

      // Re-resolving needs its own fresh record rather than reusing the old one.
      const refused = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: { status: "resolved" },
      });
      expect(refused.statusCode).toBe(409);
      expect(body(refused)).toMatchObject({ error: "resolution_required" });
    });
  });

  it("supersedes rather than overwrites when a second resolution is recorded", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic revised" }),
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/resolutions`,
        headers: { cookie: alice },
        payload: { basis: "human_only", rationale: "First synthetic conclusion." },
      });
      const second = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/resolutions`,
        headers: { cookie: alice },
        payload: {
          basis: "human_only",
          rationale: "Revised synthetic conclusion after re-reading the log.",
          expectedRevision: 1,
        },
      });
      expect(second.statusCode).toBe(201);

      const history = parseInvestigationResolutionList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/resolutions`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(history.resolutions.map((row) => row.revision)).toEqual([2, 1]);
      expect(history.resolutions[1]?.rationale).toBe("First synthetic conclusion.");
      expect(history.resolutions[0]?.predecessorRevision).toBe(1);
    });
  });

  it("conflicts loudly when two people resolve against the same revision", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic concurrent" }),
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/resolutions`,
        headers: { cookie: alice },
        payload: { basis: "human_only", rationale: "First synthetic conclusion." },
      });
      const stale = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/resolutions`,
        headers: { cookie: alice },
        payload: {
          basis: "human_only",
          rationale: "Written against a revision that already moved.",
          expectedRevision: 0,
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(body(stale)).toMatchObject({ error: "resolution_conflict", currentRevision: 1 });
    });
  });

  it("leaves monitoring and archived unguarded, because neither claims an answer", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic unguarded" }),
      );
      for (const status of ["monitoring", "archived"] as const) {
        const res = await app.inject({
          method: "POST",
          url: `/api/cases/${investigation.id}/status`,
          headers: { cookie: alice },
          payload: { status },
        });
        expect(res.statusCode).toBe(200);
        expect(parseCase(body(res)).status).toBe(status);
      }
    });
  });
});

describe("investigation-scoped software impact", () => {
  it("records several named identities in recording order and never ranks their builds", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic impact case" }),
      );

      const firstRes = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/software-impact`,
        headers: { cookie: alice },
        payload: { productName: "Fixture Desk", version: "4.1", status: "ruled_out" },
      });
      expect(firstRes.statusCode).toBe(201);
      const first = parseSoftwareImpact(body(firstRes));

      const secondRes = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/software-impact`,
        headers: { cookie: alice },
        payload: {
          productName: "Fixture Desk",
          version: "4.2",
          build: "build-007",
          status: "confirmed",
          note: "Failing line appears only on this synthetic worker image.",
        },
      });
      expect(secondRes.statusCode).toBe(201);
      const second = parseSoftwareImpact(body(secondRes));

      const listed = parseSoftwareImpactList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/software-impact`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(listed.ordering).toBe("recorded_at");
      expect(listed.records.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(listed.records.map((row) => row.status)).toEqual(["ruled_out", "confirmed"]);
    });
  });

  it("refuses a second active claim for the same identity", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic duplicate impact" }),
      );
      const created = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/software-impact`,
        headers: { cookie: alice },
        payload: { productName: "Fixture Desk", build: "build-007", status: "suspected" },
      });
      expect(created.statusCode).toBe(201);
      const clash = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/software-impact`,
        headers: { cookie: alice },
        payload: { productName: "fixture desk", build: "BUILD-007", status: "confirmed" },
      });
      expect(clash.statusCode).toBe(409);
      expect(body(clash)).toMatchObject({
        error: "already_recorded",
        existingId: parseSoftwareImpact(body(created)).id,
      });
    });
  });

  it("offers suggestions only from investigations the reader can already see", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const bob = await login(app, "bob");
      const aliceCase = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic alice impact" }),
      );
      const bobCase = parseCase(await createInvestigation(app, bob, { title: "Synthetic bob impact" }));
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${aliceCase.id}/software-impact`,
            headers: { cookie: alice },
            payload: { environment: "QA / us-central", status: "observed" },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${bobCase.id}/software-impact`,
            headers: { cookie: bob },
            payload: { productName: "Secret Catalog", environment: "prod-west", status: "confirmed" },
          })
        ).statusCode,
      ).toBe(201);

      const suggestions = parseSoftwareImpactSuggestions(
        body(
          await app.inject({
            method: "GET",
            url: "/api/software-impact/suggestions?field=environment",
            headers: { cookie: alice },
          }),
        ),
      );
      expect(suggestions.values).toEqual(["QA / us-central"]);

      const hidden = await app.inject({
        method: "GET",
        url: `/api/cases/${bobCase.id}/software-impact`,
        headers: { cookie: alice },
      });
      expect(hidden.statusCode).toBe(404);
    });
  });

  it("lets a viewer read and refuses their writes", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const carol = await login(app, "carol");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic viewer impact" }),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${investigation.id}/participants`,
            headers: { cookie: alice },
            payload: {
              identityId: "uid=carol,ou=people,dc=example,dc=test",
              username: "carol",
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${investigation.id}/software-impact`,
            headers: { cookie: alice },
            payload: { component: "queue-worker", status: "observed" },
          })
        ).statusCode,
      ).toBe(201);

      const listed = await app.inject({
        method: "GET",
        url: `/api/cases/${investigation.id}/software-impact`,
        headers: { cookie: carol },
      });
      expect(listed.statusCode).toBe(200);
      expect(parseSoftwareImpactList(body(listed)).records).toHaveLength(1);

      const write = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/software-impact`,
        headers: { cookie: carol },
        payload: { component: "queue-worker", status: "confirmed" },
      });
      expect(write.statusCode).toBe(403);
    });
  });
});
