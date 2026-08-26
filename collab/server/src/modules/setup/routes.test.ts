import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLdapProbeReport } from "@cd-collab/contracts";
import {
  SETUP_CLAIM_REQUEST_SCHEMA_ID,
  SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
  SETUP_STATE_SCHEMA_ID,
  parsePersistedSetupState,
  type PersistedSetupStateV1,
} from "@cd-collab/contracts/setup";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import {
  createSyntheticLdapFactory,
  exampleSyntheticDirectory,
  loadLdapConfig,
  type LdapSessionFactory,
} from "../auth/index.js";
import { initializeSetupState } from "./claim.js";
import { SetupService, setupReferencePolicy } from "./service.js";
import {
  SetupStateStoreError,
  type SetupStateStore,
} from "./state-store.js";

const OWNER_TOKEN = "A".repeat(43);

function syntheticDeploymentPaths(profile: string) {
  const dataRoot = resolve("contextdesk-synthetic", profile);
  return {
    dataRoot,
    evidenceRoot: join(dataRoot, "evidence"),
    sqlitePath: join(dataRoot, "db", "contextdesk.sqlite"),
  };
}

class MemorySetupStore implements SetupStateStore {
  state: PersistedSetupStateV1 | null = null;

  async initialize(state: PersistedSetupStateV1): Promise<PersistedSetupStateV1> {
    if (this.state) throw new SetupStateStoreError("state_exists");
    this.state = parsePersistedSetupState(structuredClone(state));
    return structuredClone(this.state);
  }

  async load(): Promise<PersistedSetupStateV1> {
    if (!this.state) throw new SetupStateStoreError("state_missing");
    return structuredClone(this.state);
  }

  async compareAndSwap(
    expectedRevision: number,
    transform: (current: PersistedSetupStateV1) => PersistedSetupStateV1,
  ): Promise<PersistedSetupStateV1> {
    const current = await this.load();
    if (current.history.at(-1)?.revision !== expectedRevision) {
      throw new SetupStateStoreError("stale_revision");
    }
    this.state = parsePersistedSetupState(transform(current));
    return structuredClone(this.state);
  }
}

async function setupApp(options: { ldapSessions?: LdapSessionFactory } = {}) {
  const store = new MemorySetupStore();
  await initializeSetupState(store, OWNER_TOKEN, {
    nowUnixMs: () => 1_000,
    randomId: (() => {
      let id = 0;
      return () => `synthetic-${++id}`;
    })(),
  });
  const app = await buildApp({
    config: testConfig(),
    pool: null,
    store: { ping() {} },
    setup: new SetupService({
      store,
      referencePolicy: setupReferencePolicy(),
      ...(options.ldapSessions ? { ldapSessions: options.ldapSessions } : {}),
    }),
    serveStatic: false,
  });
  return { app, store };
}

async function claim(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: "POST",
    url: "/api/setup/claim",
    payload: {
      schemaId: SETUP_CLAIM_REQUEST_SCHEMA_ID,
      expectedRevision: 0,
      ownerToken: OWNER_TOKEN,
      claimantLabel: "Synthetic owner",
    },
  });
}

async function secret(
  app: Awaited<ReturnType<typeof buildApp>>,
  purpose: string,
  value: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/setup/secrets",
    headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
    payload: { purpose, value },
  });
  return { response, body: response.json<{ handle: string; purpose: string }>() };
}

describe("first-run setup HTTP boundary", () => {
  it("exposes only share-safe status before authentication and claims once", async () => {
    const { app } = await setupApp();
    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      schemaId: "cd-collab.setup_status.v1",
      revision: 0,
      phase: "awaiting_owner",
      claimed: false,
    });
    expect(status.body).not.toContain(OWNER_TOKEN);
    expect(status.body).not.toContain("Digest");

    const capabilities = await app.inject({ method: "GET", url: "/api/setup/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      directoryProbe: true,
      externalConnectivityVerification: false,
      commit: false,
      restart: false,
    });

    const claimed = await claim(app);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ revision: 1, phase: "claimed", claimed: true });
    expect((await claim(app)).statusCode).toBe(409);
    expect(claimed.body).not.toContain(OWNER_TOKEN);
    await app.close();
  });

  it("turns secret inputs into opaque host handles and never reflects values", async () => {
    const { app } = await setupApp();
    await claim(app);
    const value = "Synthetic-only password 123!";
    const issued = await secret(app, "initial_admin_password", value);
    expect(issued.response.statusCode).toBe(200);
    expect(issued.body).toMatchObject({ purpose: "initial_admin_password" });
    expect(issued.body.handle).toMatch(
      /^setup_secret:initial_admin_password:[a-f0-9]{64}$/,
    );
    expect(issued.response.body).not.toContain(value);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/setup/secrets",
      headers: { "x-contextdesk-setup-token": "B".repeat(43) },
      payload: { purpose: "gateway_api_key", value: "must-not-return" },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).not.toContain("must-not-return");
    await app.close();
  });

  it("stages a redacted SQLite/local draft and reports bounded verification honestly", async () => {
    const { app } = await setupApp();
    await claim(app);
    const paths = syntheticDeploymentPaths("single-node");
    const issued = await secret(
      app,
      "initial_admin_password",
      "Synthetic-only password 123!",
    );
    const draft = {
      schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
      basedOnRevision: 1,
      draftRevision: 2,
      deploymentProfile: "single_node",
      dataRoot: paths.dataRoot,
      evidenceRoot: paths.evidenceRoot,
      storage: {
        kind: "sqlite",
        sqlitePath: paths.sqlitePath,
        databaseUrlRef: null,
        migrateDatabaseUrlRef: null,
      },
      authentication: {
        kind: "local",
        local: {
          initialAdminUsername: "owner",
          initialAdminDisplayName: "Synthetic owner",
          initialAdminPasswordRef: {
            kind: "handle",
            purpose: "initial_admin_password",
            fileRef: null,
            handle: issued.body.handle,
          },
        },
        ldap: null,
      },
      gateway: null,
    };
    const staged = await app.inject({
      method: "PUT",
      url: "/api/setup/draft",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: { expectedRevision: 1, deploymentLabel: "Synthetic War Room", draft },
    });
    expect(staged.statusCode).toBe(200);
    expect(staged.json()).toMatchObject({
      deploymentLabel: "Synthetic War Room",
      configurationPrepared: true,
      installationComplete: false,
      status: { revision: 2, phase: "draft" },
      summary: {
        storage: "sqlite",
        authentication: "local",
        committed: false,
      },
    });
    for (const privateValue of [
      draft.dataRoot,
      draft.evidenceRoot,
      draft.storage.sqlitePath,
      issued.body.handle,
    ]) {
      expect(staged.body).not.toContain(privateValue);
    }

    const verified = await app.inject({
      method: "POST",
      url: "/api/setup/verify",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: { expectedRevision: 2 },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      outcome: "bounded_checks_passed",
      boundedConfigurationVerified: true,
      externalConnectivityVerified: false,
      installationComplete: false,
      commitAvailable: false,
      restartAvailable: false,
      unavailableReason: "atomic_commit_and_restart_unavailable",
    });
    expect(verified.body).not.toContain(issued.body.handle);
    await app.close();
  });

  it("stages PostgreSQL, LDAP, and gateway readiness without returning connection material", async () => {
    const { app } = await setupApp();
    await claim(app);
    const paths = syntheticDeploymentPaths("team-room");
    const values = {
      database_url: "postgres://app:synthetic@db.example.test/contextdesk",
      migrate_database_url: "postgres://migrator:synthetic@db.example.test/contextdesk",
      ldap_bind_password: "Synthetic LDAP bind value",
      gateway_api_key: "Synthetic gateway value",
    } as const;
    const handles = Object.fromEntries(
      await Promise.all(
        Object.entries(values).map(async ([purpose, value]) => {
          const issued = await secret(app, purpose, value);
          expect(issued.response.statusCode).toBe(200);
          return [purpose, issued.body.handle];
        }),
      ),
    );
    const ref = (purpose: keyof typeof values) => ({
      kind: "handle",
      purpose,
      fileRef: null,
      handle: handles[purpose],
    });
    const draft = {
      schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
      basedOnRevision: 1,
      draftRevision: 2,
      deploymentProfile: "postgres_ldap",
      dataRoot: paths.dataRoot,
      evidenceRoot: paths.evidenceRoot,
      storage: {
        kind: "postgres",
        sqlitePath: null,
        databaseUrlRef: ref("database_url"),
        migrateDatabaseUrlRef: ref("migrate_database_url"),
      },
      authentication: {
        kind: "ldap",
        local: null,
        ldap: {
          url: "ldaps://directory.example.test:636",
          starttls: false,
          caCertificateRef: null,
          userDnTemplate: "uid={username},ou=people,dc=example,dc=test",
          userSearchBase: null,
          userSearchFilter: "(uid={username})",
          groupSearchBase: "ou=groups,dc=example,dc=test",
          groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
          bindDn: "cn=contextdesk,ou=services,dc=example,dc=test",
          bindPasswordRef: ref("ldap_bind_password"),
          adminGroup: "cn=contextdesk-admins,ou=groups,dc=example,dc=test",
        },
      },
      gateway: {
        kind: "openai_compatible",
        profileId: "synthetic-gateway",
        label: "Synthetic gateway",
        baseUrl: "https://gateway.example.test/v1",
        modelId: "synthetic-model-v1",
        apiKeyRef: ref("gateway_api_key"),
      },
    };
    const staged = await app.inject({
      method: "PUT",
      url: "/api/setup/draft",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: { expectedRevision: 1, deploymentLabel: "Synthetic team room", draft },
    });
    expect(staged.statusCode).toBe(200);
    expect(staged.json()).toMatchObject({
      summary: {
        storage: "postgres",
        authentication: "ldap",
        gateway: "openai_compatible",
        committed: false,
      },
      installationComplete: false,
    });
    for (const privateValue of [
      ...Object.values(values),
      ...Object.values(handles),
      draft.dataRoot,
      draft.evidenceRoot,
      draft.authentication.ldap.url,
      draft.authentication.ldap.bindDn,
      draft.gateway.baseUrl,
    ]) {
      expect(staged.body).not.toContain(privateValue);
    }
    await app.close();
  });

  it("probes a staged directory draft through synthetic sessions without leaking secrets", async () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
      COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
      COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
      COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
      COLLAB_LDAP_MEMBER_ATTR: "memberOf",
    });
    const { app } = await setupApp({
      ldapSessions: createSyntheticLdapFactory(cfg, exampleSyntheticDirectory()),
    });
    await claim(app);
    const deploymentPaths = syntheticDeploymentPaths("ldap-probe");
    const values = {
      database_url: "postgres://app:synthetic@db.example.test/contextdesk",
      migrate_database_url: "postgres://migrator:synthetic@db.example.test/contextdesk",
      ldap_bind_password: "fixture-service-secret",
    } as const;
    const handles = Object.fromEntries(
      await Promise.all(
        Object.entries(values).map(async ([purpose, value]) => {
          const issued = await secret(app, purpose, value);
          expect(issued.response.statusCode).toBe(200);
          return [purpose, issued.body.handle];
        }),
      ),
    );
    const ref = (purpose: keyof typeof values) => ({
      kind: "handle",
      purpose,
      fileRef: null,
      handle: handles[purpose],
    });
    const draft = {
      schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
      basedOnRevision: 1,
      draftRevision: 2,
      deploymentProfile: "postgres_ldap",
      dataRoot: deploymentPaths.dataRoot,
      evidenceRoot: deploymentPaths.evidenceRoot,
      storage: {
        kind: "postgres",
        sqlitePath: null,
        databaseUrlRef: ref("database_url"),
        migrateDatabaseUrlRef: ref("migrate_database_url"),
      },
      authentication: {
        kind: "ldap",
        local: null,
        ldap: {
          url: "ldaps://directory.example.test:636",
          starttls: false,
          caCertificateRef: null,
          userDnTemplate: null,
          userSearchBase: "ou=people,dc=example,dc=test",
          userSearchFilter: "(uid={username})",
          groupSearchBase: "ou=groups,dc=example,dc=test",
          groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
          bindDn: "cn=svc,ou=services,dc=example,dc=test",
          bindPasswordRef: ref("ldap_bind_password"),
          adminGroup: "cn=contributors,ou=groups,dc=example,dc=test",
          userResolutionModes: ["service_bind_search"],
          memberAttribute: "memberOf",
        },
      },
      gateway: null,
    };
    const staged = await app.inject({
      method: "PUT",
      url: "/api/setup/draft",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: { expectedRevision: 1, deploymentLabel: "Synthetic team room", draft },
    });
    expect(staged.statusCode).toBe(200);
    const probe = await app.inject({
      method: "POST",
      url: "/api/setup/ldap-probe",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: {
        expectedRevision: 2,
        probeUsername: "alice",
        probePassword: "fixture-alice-secret",
      },
    });
    expect(probe.statusCode).toBe(200);
    const report = parseLdapProbeReport(JSON.parse(probe.body));
    expect(report.ready).toBe(true);
    expect(report.stages.map((stage) => stage.id)).toEqual([
      "transport",
      "service_bind",
      "user_search",
      "group_lookup",
      "role_map",
    ]);
    expect(probe.body).not.toContain("fixture-alice-secret");
    expect(probe.body).not.toContain("fixture-service-secret");
    await app.close();
  });

  it("fails closed on stale revisions, unknown handles, and configured state", async () => {
    const { app, store } = await setupApp();
    await claim(app);
    const paths = syntheticDeploymentPaths("missing-handle");
    const baseDraft = {
      schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
      basedOnRevision: 1,
      draftRevision: 2,
      deploymentProfile: "single_node",
      dataRoot: paths.dataRoot,
      evidenceRoot: paths.evidenceRoot,
      storage: {
        kind: "sqlite",
        sqlitePath: paths.sqlitePath,
        databaseUrlRef: null,
        migrateDatabaseUrlRef: null,
      },
      authentication: {
        kind: "local",
        local: {
          initialAdminUsername: "owner",
          initialAdminDisplayName: "Synthetic owner",
          initialAdminPasswordRef: {
            kind: "handle",
            purpose: "initial_admin_password",
            fileRef: null,
            handle: `setup_secret:initial_admin_password:${"a".repeat(64)}`,
          },
        },
        ldap: null,
      },
      gateway: null,
    };
    const missing = await app.inject({
      method: "PUT",
      url: "/api/setup/draft",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: { expectedRevision: 1, deploymentLabel: "Synthetic room", draft: baseDraft },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ error: "secret_reference_unavailable" });

    const stale = await app.inject({
      method: "POST",
      url: "/api/setup/verify",
      headers: { "x-contextdesk-setup-token": OWNER_TOKEN },
      payload: { expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);

    const lastTime = store.state?.history.at(-1)?.occurredAtUnixMs ?? 10_000;
    store.state = parsePersistedSetupState({
      schemaId: SETUP_STATE_SCHEMA_ID,
      deploymentId: store.state?.deploymentId,
      ownerTokenDigest: store.state?.ownerTokenDigest,
      history: [
        ...(store.state?.history ?? []),
        {
          stateId: "state:draft",
          revision: 2,
          phase: "draft",
          occurredAtUnixMs: lastTime + 1,
          claimId: store.state?.history.at(-1)?.claimId,
          claimantLabel: "Synthetic owner",
          failureCode: null,
        },
        {
          stateId: "state:verifying",
          revision: 3,
          phase: "verifying",
          occurredAtUnixMs: lastTime + 2,
          claimId: store.state?.history.at(-1)?.claimId,
          claimantLabel: "Synthetic owner",
          failureCode: null,
        },
        {
          stateId: "state:ready",
          revision: 4,
          phase: "ready_to_commit",
          occurredAtUnixMs: lastTime + 3,
          claimId: store.state?.history.at(-1)?.claimId,
          claimantLabel: "Synthetic owner",
          failureCode: null,
        },
        {
          stateId: "state:restart",
          revision: 5,
          phase: "restart_required",
          occurredAtUnixMs: lastTime + 4,
          claimId: store.state?.history.at(-1)?.claimId,
          claimantLabel: "Synthetic owner",
          failureCode: null,
        },
        {
          stateId: "state:configured",
          revision: 6,
          phase: "configured",
          occurredAtUnixMs: lastTime + 5,
          claimId: store.state?.history.at(-1)?.claimId,
          claimantLabel: "Synthetic owner",
          failureCode: null,
        },
      ],
    });
    const hidden = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: "setup_unavailable" });
    await app.close();
  });
});
