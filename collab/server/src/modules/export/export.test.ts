import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBrief,
  parseExportEnvelope,
  parseExportInventory,
  parseExternalRun,
  parsePromptPackage,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
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
import { CaseService } from "../cases/index.js";
import { ImportService, MemoryRunStore } from "../import/index.js";
import { canonicalJson } from "./canonical.js";
import { testExportPrivacyConfig } from "./config.js";
import { ExportService } from "./service.js";

const ALICE = "fixture-alice-secret";
const LOG = "2026-08-15T00:00:00Z mailer timeout id=syn-1\n";
const EML = [
  "From: sender@example.test",
  "To: oncall@example.test",
  "Subject: synthetic timeout",
  "",
  "The mailer worker timed out.\n",
].join("\r\n");
const TRANSCRIPT = "The mailer pool is exhausted; workers time out after 30s.";
const PLANTED_KEY = "AKIAIOSFODNN7EXAMPLE";
const PLANTED_HOST = "db.internal.example.test";

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
      "bob",
      {
        password: "fixture-bob-secret",
        identity: {
          id: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
          displayName: "bob",
        },
        groups: ["cn=unmapped,ou=groups,dc=example,dc=test"],
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

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-export-"));
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
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: testExportPrivacyConfig(),
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    imports,
    exporter,
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
    await fn({ app, audit });
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

async function seedFixture(app: Awaited<ReturnType<typeof buildApp>>) {
  const alice = await login(app, "alice", ALICE);
  const dave = await login(app, "dave", "fixture-dave-secret");
  const created = JSON.parse(
    (
      await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic mailer timeout", severity: "high" },
      })
    ).body,
  ) as { id: string };
  const caseId = created.id;

  const note = JSON.parse(
    (
      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "note", body: "First look: queue depth climbed." },
      })
    ).body,
  ) as { id: string };

  const hypothesis = JSON.parse(
    (
      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "hypothesis", body: "Mailer pool exhaustion", hypothesisStatus: "proposed" },
      })
    ).body,
  ) as { id: string };

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
  ) as { artifact: { id: string; contentHash: string | null; privacyClass: string; sourceId: string } };

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
  ) as { artifact: { id: string; contentHash: string | null; privacyClass: string; sourceId: string } };

  await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/hypotheses/${hypothesis.id}/status`,
    headers: { cookie: alice },
    payload: { status: "supported", links: [{ kind: "artifact", id: logUpload.artifact.id }] },
  });

  const tool = JSON.parse(
    (
      await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: { name: "Web assistant", kind: "external-tool" },
      })
    ).body,
  ) as { id: string };

  const imported = parseExternalRun(
    JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/imports`,
          headers: { cookie: alice },
          payload: {
            outputText: TRANSCRIPT,
            sourceId: tool.id,
            operatorId: "uid=operator,ou=people,dc=example,dc=test",
            operatorUsername: "operator",
          },
        })
      ).body,
    ),
  );

  await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/imports/${imported.id}/corroborate`,
    headers: { cookie: alice },
    payload: { state: "corroborated", links: [{ kind: "contribution", id: note.id }] },
  });

  await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/status`,
    headers: { cookie: dave },
    payload: { status: "resolved" },
  });

  return {
    alice,
    dave,
    caseId,
    noteId: note.id,
    logId: logUpload.artifact.id,
    logHash: logUpload.artifact.contentHash,
    logSourceId: logUpload.artifact.sourceId,
    emailId: emailUpload.artifact.id,
    emailHash: emailUpload.artifact.contentHash,
    importedId: imported.id,
    toolId: tool.id,
  };
}

describe("triage brief and prompt-package export", () => {
  it("meets the #888 acceptance boxes on the fixture case", async () => {
    await withApp(async ({ app, audit }) => {
      const fx = await seedFixture(app);

      const carol = await login(app, "carol", "fixture-carol-secret");
      const addedBob = await app.inject({
        method: "POST",
        url: `/api/cases/${fx.caseId}/participants`,
        headers: { cookie: fx.dave },
        payload: {
          identityId: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
        },
      });
      expect(addedBob.statusCode).toBe(200);
      const viewerDenied = await app.inject({
        method: "POST",
        url: `/api/cases/${fx.caseId}/export/brief`,
        headers: { cookie: carol },
        payload: { variant: "owner_only" },
      });
      expect(viewerDenied.statusCode).toBe(403);

      const contributorShareDenied = await app.inject({
        method: "POST",
        url: `/api/cases/${fx.caseId}/export/brief`,
        headers: { cookie: fx.alice },
        payload: { variant: "share_safe" },
      });
      expect(contributorShareDenied.statusCode).toBe(403);

      const briefA = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/brief`,
              headers: { cookie: fx.alice },
              payload: { variant: "owner_only" },
            })
          ).body,
        ),
      );
      const briefB = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/brief`,
              headers: { cookie: fx.alice },
              payload: { variant: "owner_only" },
            })
          ).body,
        ),
      );
      const briefPayloadA = parseBrief(briefA.payload);
      const briefPayloadB = parseBrief(briefB.payload);
      expect(canonicalJson(briefPayloadA)).toBe(canonicalJson(briefPayloadB));
      expect(briefA.markdown).toBe(briefB.markdown);
      expect(briefA.exportedAt).not.toBe("");
      expect(briefA.markdown.includes(briefA.exportedAt)).toBe(false);
      expect(canonicalJson(briefPayloadA).includes(briefA.exportedAt)).toBe(false);

      const ownerLog = briefPayloadA.evidence.find((e) => e.id === fx.logId);
      expect(ownerLog?.content).toBe(LOG);
      expect(ownerLog?.bytesIncluded).toBe(true);
      expect(ownerLog?.contentHash).toBe(fx.logHash);
      expect(ownerLog?.sourceLabel.length).toBeGreaterThan(0);
      expect(briefPayloadA.hypotheses[0]?.status).toBe("supported");
      expect(briefPayloadA.hypotheses[0]?.supporting).toEqual([
        { kind: "artifact", id: fx.logId },
      ]);
      expect(briefPayloadA.actions).toHaveLength(1);
      expect(briefPayloadA.importedRuns).toHaveLength(1);
      expect(briefPayloadA.importedRuns[0]?.presentation).toBe("imported_response");
      expect(briefPayloadA.importedRuns[0]?.corroborationState).toBe("corroborated");
      expect(briefPayloadA.importedRuns.every((r) => r.presentation !== "finding")).toBe(true);
      expect(briefA.markdown).toMatch(/Imported external responses \(not findings\)/);
      expect(briefA.markdown).not.toMatch(/## Findings/);

      const shareBrief = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/brief`,
              headers: { cookie: fx.dave },
              payload: { variant: "share_safe" },
            })
          ).body,
        ),
      );
      const sharePayload = parseBrief(shareBrief.payload);
      const shareLog = sharePayload.evidence.find((e) => e.id === fx.logId);
      expect(shareLog?.content).toBeNull();
      expect(shareLog?.bytesIncluded).toBe(false);
      expect(shareLog?.contentHash).toBe(fx.logHash);
      expect(shareLog?.sourceLabel).toBe("contributor");
      expect(ownerLog?.sourceLabel.length).toBeGreaterThan(0);
      const shareEmail = sharePayload.evidence.find((e) => e.id === fx.emailId);
      expect(shareEmail?.content).toBe(EML);
      expect(shareEmail?.bytesIncluded).toBe(true);
      expect(sharePayload.attributions.length).toBeGreaterThan(0);
      expect(sharePayload.attributions.every((a) => a.actorLabel && a.action && a.targetKind)).toBe(
        true,
      );
      expect(sharePayload.attributions.some((a) => a.actorLabel === "contributor")).toBe(true);
      expect(canonicalJson(sharePayload)).not.toContain("uid=alice,ou=people,dc=example,dc=test");
      expect(canonicalJson(sharePayload)).not.toContain("alice");
      expect(canonicalJson(sharePayload)).not.toContain("uid=bob,ou=people,dc=example,dc=test");
      expect(canonicalJson(sharePayload)).not.toContain("bob");
      expect(canonicalJson(sharePayload)).not.toContain("identityRedactions");
      expect(canonicalJson(sharePayload)).not.toContain("redactionMap");
      expect(shareBrief.markdown).not.toContain("uid=alice,ou=people,dc=example,dc=test");
      expect(shareBrief.markdown).not.toContain("alice");
      expect(shareBrief.markdown).not.toContain("uid=bob,ou=people,dc=example,dc=test");
      expect(shareBrief.markdown).not.toContain("bob");

      const inventory = parseExportInventory(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${fx.caseId}/export/inventory`,
              headers: { cookie: fx.alice },
            })
          ).body,
        ),
      );
      expect(inventory.items.some((i) => i.id === fx.logId)).toBe(true);

      const selection = [
        { kind: "artifact" as const, id: fx.logId },
        { kind: "artifact" as const, id: fx.emailId },
        { kind: "contribution" as const, id: fx.noteId },
      ];
      const pkgA = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/package`,
              headers: { cookie: fx.alice },
              payload: { variant: "owner_only", selection, promptScaffold: "Summarize the evidence." },
            })
          ).body,
        ),
      );
      const pkgB = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/package`,
              headers: { cookie: fx.alice },
              payload: { variant: "owner_only", selection, promptScaffold: "Summarize the evidence." },
            })
          ).body,
        ),
      );
      const packageA = parsePromptPackage(pkgA.payload);
      const packageB = parsePromptPackage(pkgB.payload);
      expect(packageA.snapshotIdentity).toBe(packageB.snapshotIdentity);
      expect(canonicalJson(packageA)).toBe(canonicalJson(packageB));
      expect(pkgA.markdown).toBe(pkgB.markdown);
      expect(packageA.manifest.excludedByDefault).toEqual(["corroboration", "resolution"]);
      expect(canonicalJson(packageA)).not.toContain("corroborationState");
      expect(canonicalJson(packageA)).not.toContain("run_corroboration");
      expect(packageA.excerpts.some((e) => e.kind === "contribution" && e.id === fx.importedId)).toBe(
        false,
      );
      expect(pkgA.markdown).not.toMatch(/corroborationState|run_corroboration/);
      expect(pkgA.markdown).not.toMatch(/\bresolved\b/);

      const sharePkg = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/package`,
              headers: { cookie: fx.dave },
              payload: { variant: "share_safe", selection },
            })
          ).body,
        ),
      );
      const sharePackage = parsePromptPackage(sharePkg.payload);
      const sharePkgLog = sharePackage.excerpts.find((e) => e.id === fx.logId);
      expect(sharePkgLog?.content).toBeNull();
      expect(sharePkgLog?.bodyIncluded).toBe(false);
      expect(sharePkgLog?.contentHash).toBe(fx.logHash);
      expect(sharePkgLog?.sourceLabel.length).toBeGreaterThan(0);
      const sharePkgEmail = sharePackage.excerpts.find((e) => e.id === fx.emailId);
      expect(sharePkgEmail?.content).toBe(EML);

      const bound = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/imports`,
              headers: { cookie: fx.alice },
              payload: {
                outputText: "Bound to the exported package snapshot.",
                sourceId: fx.toolId,
                operatorId: "uid=operator,ou=people,dc=example,dc=test",
                operatorUsername: "operator",
                snapshotBinding: packageA.snapshotIdentity,
              },
            })
          ).body,
        ),
      );
      expect(bound.snapshotBinding).toBe(packageA.snapshotIdentity);

      await app.inject({
        method: "POST",
        url: `/api/cases/${fx.caseId}/contributions`,
        headers: { cookie: fx.alice },
        payload: { kind: "note", body: "Added after export; must not appear in the held package." },
      });

      expect(canonicalJson(packageA)).not.toContain("Added after export");
      expect(pkgA.markdown).not.toContain("Added after export");

      const pkgC = parseExportEnvelope(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${fx.caseId}/export/package`,
              headers: { cookie: fx.alice },
              payload: { variant: "owner_only", selection, promptScaffold: "Summarize the evidence." },
            })
          ).body,
        ),
      );
      expect(canonicalJson(parsePromptPackage(pkgC.payload))).toBe(canonicalJson(packageA));
      expect(parsePromptPackage(pkgC.payload).snapshotIdentity).toBe(packageA.snapshotIdentity);

      const laterBrief = parseBrief(
        parseExportEnvelope(
          JSON.parse(
            (
              await app.inject({
                method: "POST",
                url: `/api/cases/${fx.caseId}/export/brief`,
                headers: { cookie: fx.alice },
                payload: { variant: "owner_only" },
              })
            ).body,
          ),
        ).payload,
      );
      expect(laterBrief.importedRuns.some((r) => r.snapshotBinding === packageA.snapshotIdentity)).toBe(
        true,
      );
      expect(laterBrief.importedRuns.every((r) => r.presentation === "imported_response")).toBe(true);

      await app.inject({
        method: "POST",
        url: `/api/cases/${fx.caseId}/contributions`,
        headers: { cookie: fx.alice },
        payload: {
          kind: "action",
          body: `planted ${PLANTED_KEY} and host ${PLANTED_HOST}`,
          privacyClass: "share_safe",
        },
      });
      const scanned = await app.inject({
        method: "POST",
        url: `/api/cases/${fx.caseId}/export/brief`,
        headers: { cookie: fx.dave },
        payload: { variant: "share_safe" },
      });
      expect(scanned.statusCode).toBe(422);
      const report = JSON.parse(scanned.body) as {
        error: string;
        findings: { rule: string; excerpt: string }[];
      };
      expect(report.error).toBe("privacy_scan_failed");
      expect(report.findings.some((f) => f.rule === "credential" && f.excerpt.includes("AKIA"))).toBe(
        true,
      );
      expect(
        report.findings.some((f) => f.rule === "internal_hostname" && f.excerpt.includes(PLANTED_HOST)),
      ).toBe(true);

      const audits = await audit.list();
      expect(audits.some((a) => a.action === "export_brief" && a.identity?.includes("alice"))).toBe(
        true,
      );
      expect(audits.some((a) => a.action === "export_brief" && a.target?.includes(fx.caseId))).toBe(
        true,
      );
      expect(audits.some((a) => a.action === "export_brief" && a.target?.includes("owner_only"))).toBe(
        true,
      );
      expect(audits.some((a) => a.action === "export_brief" && a.target?.includes("share_safe"))).toBe(
        true,
      );
      expect(
        audits.some(
          (a) =>
            a.action === "export_package" &&
            a.target?.includes(fx.caseId) &&
            a.target?.includes("owner_only") &&
            a.target?.includes(packageA.snapshotIdentity),
        ),
      ).toBe(true);
      expect(audits.some((a) => a.action === "export_brief" && a.outcome === "denied")).toBe(true);
      expect(audits.some((a) => a.action === "export_brief" && a.outcome === "failure")).toBe(true);

      expect(briefPayloadA.header.caseId).toBe(fx.caseId);
      expect(sharePayload.attributions[0]?.actorLabel).toBeTruthy();
      expect(packageA.snapshotIdentity).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
