/**
 * Adversarial pressure on the investigation record graph.
 *
 * The shape of every case here: someone tries to get more out of the record
 * graph than their access allows, or tries to make a record say something it
 * did not. UI visibility is never authorization, and neither is having found
 * an identifier.
 *
 * Every identity, label, and body is synthetic.
 */
import {
  parseCase,
  parseInvestigationEntity,
  parseInvestigationReferenceList,
  parseInvestigationResolutionList,
  parseInvolvementIndex,
  referenceLocator,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  body,
  createEntity,
  createInvestigation,
  login,
  withRecordApp,
} from "./test/investigation-record-harness.js";

const UNKNOWN_CASE = "99999999-9999-4999-8999-999999999999";

describe("capability gates on the registry", () => {
  it("refuses registry and involvement writes to a viewer", async () => {
    await withRecordApp(async ({ app, audit }) => {
      const alice = await login(app, "alice");
      const carol = await login(app, "carol");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic gated" }),
      );
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "system", label: "Synthetic system" }),
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/entities",
        headers: { cookie: carol },
        payload: { kind: "system", label: "Synthetic viewer attempt" },
      });
      expect(created.statusCode).toBe(403);

      const involved = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/involvement`,
        headers: { cookie: carol },
        payload: { entityId: entity.id, relationship: "affected" },
      });
      expect(involved.statusCode).toBe(403);

      const denials = await audit.list({ action: "entity_create" });
      expect(denials.some((row) => row.outcome === "denied")).toBe(true);
    });
  });

  it("refuses retiring a shared label without case-lead standing", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const carol = await login(app, "carol");
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "service", label: "Synthetic shared service" }),
      );
      const retired = await app.inject({
        method: "POST",
        url: `/api/entities/${entity.id}/retire`,
        headers: { cookie: carol },
      });
      expect(retired.statusCode).toBe(403);
    });
  });

  it("refuses recording a conclusion without decision-accept standing", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const carol = await login(app, "carol");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic conclusion gate" }),
      );
      const recorded = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/resolutions`,
        headers: { cookie: carol },
        payload: { basis: "human_only", rationale: "Synthetic attempt." },
      });
      expect(recorded.statusCode).toBe(403);
    });
  });
});

describe("membership is not disclosed by the record graph", () => {
  it("reports an unreadable investigation as not found, for reads and writes alike", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const bob = await login(app, "bob");
      const hidden = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic hidden" }),
      );
      const entity = parseInvestigationEntity(
        await createEntity(app, bob, { kind: "system", label: "Synthetic probe target" }),
      );

      for (const [method, url, payload] of [
        ["GET", `/api/cases/${hidden.id}/involvement`, undefined],
        ["GET", `/api/cases/${hidden.id}/references`, undefined],
        ["GET", `/api/cases/${hidden.id}/resolutions`, undefined],
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie: bob }, ...(payload ?? {}) });
        expect(res.statusCode).toBe(404);
      }

      const write = await app.inject({
        method: "POST",
        url: `/api/cases/${hidden.id}/involvement`,
        headers: { cookie: bob },
        payload: { entityId: entity.id, relationship: "affected" },
      });
      expect(write.statusCode).toBe(404);
      // An investigation that does not exist answers identically, so the code
      // cannot be used to probe which investigations are real.
      const missing = await app.inject({
        method: "GET",
        url: `/api/cases/${UNKNOWN_CASE}/involvement`,
        headers: { cookie: bob },
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  it("keeps the involvement index from widening what a reader can see", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const bob = await login(app, "bob");
      const entity = parseInvestigationEntity(
        await createEntity(app, alice, { kind: "organization", label: "Fable Harbor" }),
      );
      const hidden = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic hidden" }),
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${hidden.id}/involvement`,
        headers: { cookie: alice },
        payload: { entityId: entity.id, relationship: "affected" },
      });
      const index = parseInvolvementIndex(
        body(
          await app.inject({
            method: "GET",
            url: "/api/involvement/index",
            headers: { cookie: bob },
          }),
        ),
      );
      expect(index.entries).toEqual([]);
    });
  });
});

describe("a citation is a pointer, never a grant", () => {
  it("refuses to cite an investigation the author cannot read, and audits the refusal", async () => {
    await withRecordApp(async ({ app, audit }) => {
      const alice = await login(app, "alice");
      const bob = await login(app, "bob");
      const hidden = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic hidden" }),
      );
      const bobCase = parseCase(await createInvestigation(app, bob, { title: "Synthetic bob" }));

      const refused = await app.inject({
        method: "POST",
        url: `/api/cases/${bobCase.id}/references`,
        headers: { cookie: bob },
        payload: { toInvestigationId: hidden.id },
      });
      expect(refused.statusCode).toBe(403);
      expect(body(refused)).toMatchObject({ error: "cited_investigation_forbidden" });

      // An investigation that does not exist is refused the same way, so the
      // response cannot distinguish "hidden from you" from "not real".
      const missing = await app.inject({
        method: "POST",
        url: `/api/cases/${bobCase.id}/references`,
        headers: { cookie: bob },
        payload: { toInvestigationId: UNKNOWN_CASE },
      });
      expect(missing.statusCode).toBe(403);

      const denials = await audit.list({ action: "investigation_reference_create" });
      expect(denials.filter((row) => row.outcome === "denied")).toHaveLength(2);
    });
  });

  it("withholds the cited title from a reader who cannot open it", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const dave = await login(app, "dave");
      const hidden = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic restricted target" }),
      );
      // dave is an admin, so he can both see the hidden case and add bob to
      // the citing one; bob then reads a citation whose target he cannot open.
      const citing = parseCase(
        await createInvestigation(app, dave, { title: "Synthetic citing" }),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${citing.id}/references`,
            headers: { cookie: dave },
            payload: { toInvestigationId: hidden.id, note: "Synthetic citation." },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${citing.id}/participants`,
            headers: { cookie: dave },
            payload: {
              identityId: "uid=bob,ou=people,dc=example,dc=test",
              username: "bob",
            },
          })
        ).statusCode,
      ).toBe(200);

      const bob = await login(app, "bob");
      const listed = parseInvestigationReferenceList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${citing.id}/references`,
            headers: { cookie: bob },
          }),
        ),
      );
      const reference = listed.outbound[0];
      expect(reference?.visibility).toBe("restricted");
      expect(reference?.currentTitle).toBeNull();
      // The pointer survives so bob can ask for access knowingly.
      expect(reference?.locator).toContain(hidden.id);
      // Reading the citation grants nothing.
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${hidden.id}`,
            headers: { cookie: bob },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it("derives the locator itself and ignores a forged one", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(await createInvestigation(app, alice, { title: "Synthetic cited" }));
      const citing = parseCase(await createInvestigation(app, alice, { title: "Synthetic citing" }));
      const created = await app.inject({
        method: "POST",
        url: `/api/cases/${citing.id}/references`,
        headers: { cookie: alice },
        payload: {
          toInvestigationId: older.id,
          locator: "https://evil.invalid/steal",
          recordedTitle: "Forged title",
          visibility: "resolved",
        },
      });
      expect(created.statusCode).toBe(201);
      const reference = body(created);
      expect(reference.locator).toBe(referenceLocator(older.id, "investigation", older.id));
      expect(reference.recordedTitle).toBe("Synthetic cited");
    });
  });

  it("refuses a resource citation whose identity cannot address a real destination", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(await createInvestigation(app, alice, { title: "Synthetic cited" }));
      const citing = parseCase(await createInvestigation(app, alice, { title: "Synthetic citing" }));
      for (const resourceId of ["../../admin", "a/b", "", "with space"]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/cases/${citing.id}/references`,
          headers: { cookie: alice },
          payload: {
            toInvestigationId: older.id,
            resourceKind: "evidence_item",
            resourceId,
          },
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  it("refuses a self-citation, which is a section link and not a reference", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic self" }),
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/references`,
        headers: { cookie: alice },
        payload: { toInvestigationId: investigation.id },
      });
      expect(res.statusCode).toBe(400);
      expect(body(res)).toMatchObject({ error: "self_reference" });
    });
  });

  it("does not turn a citation into evidence or a contribution", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const older = parseCase(await createInvestigation(app, alice, { title: "Synthetic cited" }));
      const citing = parseCase(await createInvestigation(app, alice, { title: "Synthetic citing" }));
      await app.inject({
        method: "POST",
        url: `/api/cases/${citing.id}/references`,
        headers: { cookie: alice },
        payload: { toInvestigationId: older.id },
      });
      const contributions = body(
        await app.inject({
          method: "GET",
          url: `/api/cases/${citing.id}/contributions`,
          headers: { cookie: alice },
        }),
      );
      expect((contributions.contributions as unknown[]) ?? []).toHaveLength(0);
      const artifacts = body(
        await app.inject({
          method: "GET",
          url: `/api/cases/${citing.id}/artifacts`,
          headers: { cookie: alice },
        }),
      );
      expect((artifacts.artifacts as unknown[]) ?? []).toHaveLength(0);
    });
  });
});

describe("a resolution cannot be forged or bypassed", () => {
  it("refuses a resolution whose basis does not match its fields", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic forged basis" }),
      );
      for (const payload of [
        {
          basis: "human_only",
          rationale: "Synthetic.",
          experimentDecisionId: "3d2c1b0a-9887-4766-a554-433221100fee",
        },
        { basis: "experiment_decision", rationale: "Synthetic." },
        { basis: "reasoned_exception", rationale: "Synthetic." },
        { basis: "human_only", rationale: "Synthetic.", provenance: "ai_generated" },
        { basis: "human_only", rationale: "   " },
        { basis: "not_a_basis", rationale: "Synthetic." },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/cases/${investigation.id}/resolutions`,
          headers: { cookie: alice },
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
      const history = parseInvestigationResolutionList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/resolutions`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(history.resolutions).toEqual([]);
    });
  });

  it("refuses a status transition carrying a malformed resolution, leaving nothing behind", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic partial write" }),
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/cases/${investigation.id}/status`,
        headers: { cookie: alice },
        payload: { status: "resolved", resolution: { basis: "human_only", rationale: "" } },
      });
      expect(res.statusCode).toBe(400);

      const after = parseCase(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(after.status).toBe("open");
      const history = parseInvestigationResolutionList(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}/resolutions`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(history.resolutions).toEqual([]);
    });
  });

  it("does not let a resolution recorded on one investigation resolve another", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const resolvedCase = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic resolved" }),
      );
      const otherCase = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic other" }),
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${resolvedCase.id}/resolutions`,
        headers: { cookie: alice },
        payload: { basis: "human_only", rationale: "Synthetic conclusion for one case only." },
      });
      const refused = await app.inject({
        method: "POST",
        url: `/api/cases/${otherCase.id}/status`,
        headers: { cookie: alice },
        payload: { status: "resolved" },
      });
      expect(refused.statusCode).toBe(409);
      expect(body(refused)).toMatchObject({ error: "resolution_required" });
    });
  });

  it("refuses an occurrence that would let a record predate what it describes", async () => {
    await withRecordApp(async ({ app }) => {
      const alice = await login(app, "alice");
      const investigation = parseCase(
        await createInvestigation(app, alice, { title: "Synthetic clock" }),
      );
      for (const occurredAt of ["2999-01-01", "0202", "2024-11-04T25:00"]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/cases/${investigation.id}/occurred-at`,
          headers: { cookie: alice },
          payload: { occurredAt },
        });
        expect(res.statusCode).toBe(400);
      }
      const unchanged = parseCase(
        body(
          await app.inject({
            method: "GET",
            url: `/api/cases/${investigation.id}`,
            headers: { cookie: alice },
          }),
        ),
      );
      expect(unchanged.occurredAt).toBeNull();
    });
  });
});
