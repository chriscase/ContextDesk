import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArtifact,
  parseCase,
  parseCaseList,
  parseContribution,
  parseProvenance,
  parseTimeline,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore, sha256Hex } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MapAuthAdapter } from "../auth/index.js";
import { createAuthLog, createRateLimiter, MemorySessionStore, defaultSessionPolicy } from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CaseService } from "./service.js";

const ALICE = "fixture-alice-secret";
const LOG = "2026-08-15T00:00:00Z mailer timeout id=syn-1\n";
const EML = [
  "From: sender@example.test",
  "To: oncall@example.test",
  "Subject: synthetic timeout",
  "",
  "The mailer worker timed out.\n",
].join("\r\n");

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
      "carol",
      {
        password: "fixture-carol-secret",
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
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
  ]);
}

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
    domain: CaseService;
    store: FilesystemEvidenceStore;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-cases-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const domain = new CaseService(store, audit);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
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
    await fn({ app, audit, domain, store });
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

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

describe("cases timeline evidence provenance", () => {
  it("round-trips a fixture incident with attribution, hashes, revisions, and privacy", async () => {
    await withApp(async ({ app, audit, store }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: {
          title: "Synthetic mailer timeout",
          severity: "high",
          clientTime: "2000-01-01T00:00:00.000Z",
        },
      });
      expect(created.statusCode).toBe(200);
      const caseBody = parseCase(JSON.parse(created.body));
      expect(caseBody.status).toBe("open");
      const caseId = caseBody.id;

      const listed = parseCaseList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/cases",
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(listed.cases.map((c) => c.id)).toContain(caseId);

      const message = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
              payload: {
                kind: "message",
                body: "Seeing timeouts on the mailer worker.",
                clientTime: "1999-01-01T00:00:00.000Z",
              },
            })
          ).body,
        ),
      );
      expect(message.authorUsername).toBe("alice");
      expect(message.privacyClass).toBe("owner_only");

      const note = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
              payload: { kind: "note", body: "First look: queue depth climbed." },
            })
          ).body,
        ),
      );

      const hypothesis = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
              payload: {
                kind: "hypothesis",
                body: "Mailer pool exhaustion",
                hypothesisStatus: "proposed",
              },
            })
          ).body,
        ),
      );

      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "action", body: "Page the mailer on-call." },
      });

      const logUpload = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
            payload: {
              kind: "log",
              filename: "app.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from(LOG).toString("base64"),
              summary: "Synthetic mailer timeout log",
            },
          })
        ).body,
      ) as { artifact: unknown; summary: unknown };
      const logArt = parseArtifact(logUpload.artifact);
      expect(logArt.contentHash).toBe(sha256Hex(new TextEncoder().encode(LOG)));
      expect(await store.verify(logArt.contentHash ?? "")).toBe(true);
      expect(logArt.privacyClass).toBe("owner_only");
      const logSummary = parseContribution(logUpload.summary);

      const emailUpload = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
            payload: {
              kind: "email",
              filename: "alert.eml",
              mediaType: "message/rfc822",
              contentBase64: Buffer.from(EML).toString("base64"),
              summary: "Synthetic alert email",
              privacyClass: "share_safe",
            },
          })
        ).body,
      ) as { artifact: unknown };
      const emailArt = parseArtifact(emailUpload.artifact);
      expect(emailArt.contentHash).toBe(sha256Hex(new TextEncoder().encode(EML)));
      expect(emailArt.privacyClass).toBe("share_safe");

      const edited = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions/${logSummary.id}/revisions`,
              headers: { cookie: alice },
              payload: { body: "Updated summary; original bytes must stay." },
            })
          ).body,
        ),
      );
      expect(edited.revision).toBe(2);
      expect(edited.predecessorRevision).toBe(1);
      expect(logArt.contentHash).toBe(sha256Hex(new TextEncoder().encode(LOG)));

      const supported = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/hypotheses/${hypothesis.id}/status`,
              headers: { cookie: alice },
              payload: {
                status: "supported",
                links: [{ kind: "artifact", id: logArt.id }],
              },
            })
          ).body,
        ),
      );
      expect(supported.hypothesisStatus).toBe("supported");
      expect(supported.hypothesisLinks).toEqual([{ kind: "artifact", id: logArt.id }]);

      const noLink = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/hypotheses/${hypothesis.id}/status`,
        headers: { cookie: alice },
        payload: { status: "supported", links: [] },
      });
      expect(noLink.statusCode).toBe(400);

      const refUpload = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
            payload: {
              kind: "file_server_ref",
              uri: "https://files.example.test/incident/core.bin",
              expectedHash: sha256Hex(new TextEncoder().encode("remote")),
              summary: "Core dump stays on the file server",
            },
          })
        ).body,
      ) as { artifact: unknown };
      const refArt = parseArtifact(refUpload.artifact);
      expect(refArt.uri).toBe("https://files.example.test/incident/core.bin");
      expect(refArt.verificationStatus).toBe("unverified");
      const originalRef = { ...refArt };

      const recheck = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence/${refArt.id}/recheck`,
            headers: { cookie: alice },
          })
        ).body,
      ) as { artifact: unknown; status: string };
      expect(recheck.status).toBe("unreachable");
      const afterRecheck = parseArtifact(recheck.artifact);
      expect(afterRecheck.verificationStatus).toBe(originalRef.verificationStatus);
      expect(afterRecheck.uri).toBe(originalRef.uri);
      expect(afterRecheck.expectedHash).toBe(originalRef.expectedHash);

      const provenance = parseProvenance(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions/${note.id}/provenance`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      const noteV2 = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions/${note.id}/revisions`,
              headers: { cookie: alice },
              payload: { body: "Revised observation after the log upload." },
            })
          ).body,
        ),
      );
      expect(noteV2.revision).toBe(2);
      const chain = parseProvenance(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions/${note.id}/provenance`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(chain.revisions).toHaveLength(2);
      expect(chain.revisions[0]?.body).toBe("First look: queue depth climbed.");
      expect(chain.revisions[1]?.body).toBe("Revised observation after the log upload.");
      expect(provenance.revisions[0]?.revision).toBe(1);

      const dave = await login(app, "dave", "fixture-dave-secret");
      const statusRes = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/status`,
              headers: { cookie: dave },
              payload: { status: "monitoring" },
            })
          ).body,
        ),
      );
      expect(statusRes.status).toBe("monitoring");

      const bytesOk = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${logArt.id}/bytes`,
        headers: { cookie: alice },
      });
      expect(bytesOk.statusCode).toBe(200);
      expect(
        Buffer.from(
          (JSON.parse(bytesOk.body) as { contentBase64: string }).contentBase64,
          "base64",
        ).toString("utf8"),
      ).toBe(LOG);

      const carol = await login(app, "carol", "fixture-carol-secret");
      const bytesDenied = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${logArt.id}/bytes`,
        headers: { cookie: carol },
      });
      expect(bytesDenied.statusCode).toBe(404);

      const added = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/participants`,
              headers: { cookie: dave },
              payload: {
                identityId: "uid=carol,ou=people,dc=example,dc=test",
                username: "carol",
              },
            })
          ).body,
        ),
      );
      expect(added.participants.some((p) => p.username === "carol")).toBe(true);
      const carolCase = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}`,
        headers: { cookie: carol },
      });
      expect(carolCase.statusCode).toBe(200);

      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/legal-hold`,
        headers: { cookie: dave },
        payload: { legalHold: true },
      });
      const held = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions/${message.id}/tombstone`,
        headers: { cookie: alice },
      });
      expect(held.statusCode).toBe(409);

      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/legal-hold`,
        headers: { cookie: dave },
        payload: { legalHold: false },
      });
      const tomb = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions/${message.id}/tombstone`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(tomb.tombstoned).toBe(true);
      expect(tomb.body).toBeNull();
      const tombChain = parseProvenance(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions/${message.id}/provenance`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(tombChain.revisions[0]?.body).toBe("Seeing timeouts on the mailer worker.");

      const timeline = parseTimeline(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/timeline`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      const seqs = timeline.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(timeline.events.some((e) => e.clientTime === "1999-01-01T00:00:00.000Z")).toBe(
        true,
      );
      const firstUserEvent = timeline.events.find((e) => e.kind === "contribution_created");
      expect(firstUserEvent?.seq).toBeLessThan(
        timeline.events.find((e) => e.kind === "evidence_recheck")?.seq ?? 0,
      );
      expect(timeline.events.some((e) => e.kind === "hypothesis_status")).toBe(true);
      expect(timeline.events.some((e) => e.kind === "evidence_recheck")).toBe(true);
      expect(timeline.events.every((e) => e.actorUsername.length > 0)).toBe(true);

      const audits = await audit.list();
      expect(audits.some((a) => a.action === "case_create" && a.identity?.includes("alice"))).toBe(
        true,
      );
      expect(audits.filter((a) => a.action === "contribution_create").length).toBeGreaterThan(3);
      expect(audits.some((a) => a.action === "evidence_register")).toBe(true);
      expect(audits.some((a) => a.action === "hypothesis_status")).toBe(true);
      expect(audits.some((a) => a.action === "contribution_tombstone")).toBe(true);
    });
  });
});
