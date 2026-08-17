import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_KINDS, parseSource, parseSourceList } from "@cd-collab/contracts";
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
import { CaseService } from "../cases/index.js";
import { CatalogService } from "./service.js";

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

function users() {
  return new Map([
    [
      "alice",
      {
        password: "fixture-alice-secret",
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
  ]);
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    catalog: CatalogService;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-catalog-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
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
    await fn({ app, catalog });
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

describe("source catalog", () => {
  it("covers all five kinds, refuses kind mutation, and preserves retired attributions", async () => {
    await withApp(async ({ app }) => {
      const dave = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "dave", password: "fixture-dave-secret" },
        }),
      );
      const createdIds: string[] = [];
      for (const kind of SOURCE_KINDS) {
        const res = await app.inject({
          method: "POST",
          url: "/api/catalog/sources",
          headers: { cookie: dave },
          payload: { name: `src-${kind}`, kind, description: `fixture ${kind}` },
        });
        expect(res.statusCode).toBe(200);
        const source = parseSource(JSON.parse(res.body));
        expect(source.kind).toBe(kind);
        expect(source.lifecycle).toBe("active");
        createdIds.push(source.id);
      }
      const listed = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: dave } }))
            .body,
        ),
      );
      const kinds = new Set(listed.sources.map((s) => s.kind));
      for (const kind of SOURCE_KINDS) expect(kinds.has(kind)).toBe(true);

      const unknown = listed.sources.find((s) => s.name === "src-unknown");
      expect(unknown?.kind).toBe("unknown");
      const mutateKind = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${unknown?.id}`,
        headers: { cookie: dave },
        payload: { name: "still-unknown", kind: "human" },
      });
      expect(mutateKind.statusCode).toBe(200);
      const after = parseSource(JSON.parse(mutateKind.body));
      expect(after.kind).toBe("unknown");
      expect(after.name).toBe("still-unknown");

      const alice = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "alice", password: "fixture-alice-secret" },
        }),
      );
      const forbidden = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: alice },
        payload: { name: "nope", kind: "human" },
      });
      expect(forbidden.statusCode).toBe(403);

      const caseRes = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Catalog fixture" },
      });
      const caseId = (JSON.parse(caseRes.body) as { id: string }).id;
      const note = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/contributions`,
            headers: { cookie: alice },
            payload: { kind: "note", body: "attributed note", sourceId: createdIds[0] },
          })
        ).body,
      ) as { sourceId: string };
      expect(note.sourceId).toBe(createdIds[0]);
      const retired = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${createdIds[0]}/retire`,
              headers: { cookie: dave },
            })
          ).body,
        ),
      );
      expect(retired.lifecycle).toBe("retired");
      const sourcesAfter = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: alice } }))
            .body,
        ),
      );
      expect(sourcesAfter.sources.find((s) => s.id === note.sourceId)?.lifecycle).toBe("retired");
      expect(note.sourceId).toBe(createdIds[0]);
    });
  });

  it("hides raw directory identities from unauthorized catalog readers", async () => {
    await withApp(async ({ app }) => {
      const dave = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "dave", password: "fixture-dave-secret" },
        }),
      );
      const alice = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "alice", password: "fixture-alice-secret" },
        }),
      );
      const carol = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "carol", password: "fixture-carol-secret" },
        }),
      );
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Catalog identity fixture" },
      });
      expect(created.statusCode).toBe(200);
      const caseId = (JSON.parse(created.body) as { id: string }).id;
      const note = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "note", body: "binds alice as a human source" },
      });
      expect(note.statusCode).toBe(200);

      const adminList = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: dave } }))
            .body,
        ),
      );
      const human = adminList.sources.find((s) => s.kind === "human" && s.identityId);
      expect(human).toBeDefined();
      expect(human?.identityId).toBe("uid=alice,ou=people,dc=example,dc=test");
      expect(human?.createdBy).toBe("uid=alice,ou=people,dc=example,dc=test");
      expect(human?.name).toBe("alice");
      const assistant = parseSource(
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

      const viewerBody = (
        await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: carol } })
      ).body;
      expect(viewerBody).not.toContain("uid=alice,ou=people,dc=example,dc=test");
      expect(viewerBody).not.toContain("uid=dave,ou=people,dc=example,dc=test");
      const viewerList = parseSourceList(JSON.parse(viewerBody));
      const projected = viewerList.sources.find((s) => s.id === human?.id);
      expect(projected?.id).toBe(human?.id);
      expect(projected?.kind).toBe("human");
      expect(projected?.identityId).toBeNull();
      expect(projected?.name).toBe(human?.id);
      expect(projected?.createdBy).toMatch(/^attr:[0-9a-f]{64}$/);
      expect(projected?.createdBy).not.toContain("uid=");
      const viewerAssistant = viewerList.sources.find((s) => s.id === assistant.id);
      expect(viewerAssistant?.name).toBe("Web assistant");
      expect(viewerAssistant?.kind).toBe("external-tool");
      expect(viewerAssistant?.createdBy).toMatch(/^attr:[0-9a-f]{64}$/);
    });
  });
});
