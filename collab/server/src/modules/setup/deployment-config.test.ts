import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETUP_SECRET_PURPOSES,
  SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
  SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
  SETUP_STATE_SCHEMA_ID,
  type PersistedSetupStateV1,
  type SetupDeploymentDraftRequestV1,
  type SetupPhase,
  type SetupSecretPurpose,
} from "@cd-collab/contracts/setup";
import { afterEach, describe, expect, it } from "vitest";
import {
  SetupDeploymentConfigError,
  prepareSetupDeploymentDraft,
} from "./deployment-config.js";
import type { SetupReferencePolicy } from "./secret-ref.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contextdesk-deployment-config-"),
  );
  roots.push(root);
  return root;
}

const fileReference = (path: string, purpose: SetupSecretPurpose) => ({
  kind: "file" as const,
  purpose,
  fileRef: `file:${path}`,
  handle: null,
});

const secretHandle = (purpose: SetupSecretPurpose) => ({
  kind: "handle" as const,
  purpose,
  fileRef: null,
  handle: `setup_secret:${purpose}:${"a".repeat(64)}`,
});

const referencePolicy = (root: string): SetupReferencePolicy => ({
  secretPurposes: Object.fromEntries(
    SETUP_SECRET_PURPOSES.map((purpose) => [
      purpose,
      {
        fileRoots: purpose === "initial_admin_password" ? [root] : [],
        allowHandles: true,
      },
    ]),
  ) as unknown as SetupReferencePolicy["secretPurposes"],
  trustedCertificateRoots: [],
});

const prepareDraft = (
  root: string,
  state: unknown,
  request: unknown,
) => prepareSetupDeploymentDraft(state, request, referencePolicy(root));

function setupState(phase: SetupPhase = "claimed"): PersistedSetupStateV1 {
  const claimed = {
    stateId: "state:claimed",
    revision: 1,
    phase: "claimed" as const,
    occurredAtUnixMs: 1_001,
    claimId: "claim:owner",
    claimantLabel: "Local owner",
    failureCode: null,
  };
  const history: PersistedSetupStateV1["history"] = [
    {
      stateId: "state:awaiting",
      revision: 0,
      phase: "awaiting_owner",
      occurredAtUnixMs: 1_000,
      claimId: null,
      claimantLabel: null,
      failureCode: null,
    },
  ];
  if (phase !== "awaiting_owner") history.push(claimed);
  if (phase === "draft") {
    history.push({
      ...claimed,
      stateId: "state:draft",
      revision: 2,
      phase: "draft",
      occurredAtUnixMs: 1_002,
    });
  }
  if (phase === "failed") {
    for (const [offset, nextPhase] of ["draft", "verifying", "failed"].entries()) {
      history.push({
        ...claimed,
        stateId: `state:${nextPhase}`,
        revision: offset + 2,
        phase: nextPhase as "draft" | "verifying" | "failed",
        occurredAtUnixMs: 1_002 + offset,
        failureCode: nextPhase === "failed" ? "verification_failed" : null,
      });
    }
  }
  if (phase === "configured") {
    const phases = [
      "draft",
      "verifying",
      "ready_to_commit",
      "restart_required",
      "configured",
    ] as const;
    for (const [offset, nextPhase] of phases.entries()) {
      history.push({
        ...claimed,
        stateId: `state:${nextPhase}`,
        revision: offset + 2,
        phase: nextPhase,
        occurredAtUnixMs: 1_002 + offset,
      });
    }
  }
  return {
    schemaId: SETUP_STATE_SCHEMA_ID,
    deploymentId: "deployment:one",
    ownerTokenDigest: "a".repeat(64),
    history,
  };
}

async function singleNodeDraft(
  root: string,
): Promise<SetupDeploymentDraftRequestV1> {
  return {
    schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
    basedOnRevision: 1,
    draftRevision: 2,
    deploymentProfile: "single_node",
    dataRoot: join(root, "data"),
    evidenceRoot: join(root, "data", "evidence"),
    storage: {
      kind: "sqlite",
      sqlitePath: join(root, "data", "contextdesk.sqlite"),
      databaseUrlRef: null,
      migrateDatabaseUrlRef: null,
    },
    authentication: {
      kind: "local",
      local: {
        initialAdminUsername: "owner",
        initialAdminDisplayName: "ContextDesk owner",
        initialAdminPasswordRef: secretHandle("initial_admin_password"),
      },
      ldap: null,
    },
    gateway: {
      kind: "openai_compatible",
      profileId: "employer-gateway",
      label: "Employer gateway",
      baseUrl: "https://gateway.example.test/v1",
      modelId: "qwen-3.6-27b",
      apiKeyRef: secretHandle("gateway_api_key"),
    },
  };
}

async function postgresLdapDraft(
  root: string,
): Promise<SetupDeploymentDraftRequestV1> {
  return {
    schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
    basedOnRevision: 1,
    draftRevision: 2,
    deploymentProfile: "postgres_ldap",
    dataRoot: join(root, "data"),
    evidenceRoot: join(root, "data", "evidence"),
    storage: {
      kind: "postgres",
      sqlitePath: null,
      databaseUrlRef: secretHandle("database_url"),
      migrateDatabaseUrlRef: secretHandle("migrate_database_url"),
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
        bindPasswordRef: secretHandle("ldap_bind_password"),
        adminGroup: "cn=contextdesk-admins,ou=groups,dc=example,dc=test",
      },
    },
    gateway: null,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("first-run deployment configuration", () => {
  it("prepares an honest single-node draft without committing or exposing secrets", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    const state = setupState();
    const beforeState = structuredClone(state);
    const beforeRequest = structuredClone(request);

    const prepared = await prepareDraft(root, state, request);

    expect(prepared.draft).toEqual(request);
    expect(prepared.publicSummary).toEqual({
      schemaId: SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
      basedOnRevision: 1,
      draftRevision: 2,
      deploymentProfile: "single_node",
      storage: "sqlite",
      authentication: "local",
      gateway: "openai_compatible",
      storageVerification: "not_run",
      authenticationVerification: "not_run",
      gatewayVerification: "not_run",
      committed: false,
    });
    expect(state).toEqual(beforeState);
    expect(request).toEqual(beforeRequest);

    const publicJson = JSON.stringify(prepared.publicSummary);
    for (const forbidden of [
      root,
      "gateway.example.test",
      "gateway.key",
      "owner",
      "qwen-3.6-27b",
      "ownerTokenDigest",
    ]) {
      expect(publicJson).not.toContain(forbidden);
    }
  });

  it("represents PostgreSQL and LDAP inputs as unverified references", async () => {
    const root = await temporaryRoot();
    const request = await postgresLdapDraft(root);
    const first = await prepareDraft(root, setupState(), request);
    const second = await prepareDraft(root, setupState(), request);

    expect(first).toEqual(second);
    expect(first.draft).toEqual(request);
    expect(first.publicSummary).toEqual({
      schemaId: SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
      basedOnRevision: 1,
      draftRevision: 2,
      deploymentProfile: "postgres_ldap",
      storage: "postgres",
      authentication: "ldap",
      gateway: "not_configured",
      storageVerification: "not_run",
      authenticationVerification: "not_run",
      gatewayVerification: "not_configured",
      committed: false,
    });
    expect(JSON.stringify(first.publicSummary)).not.toContain(root);
    expect(JSON.stringify(first.publicSummary)).not.toContain("database/");
    expect(JSON.stringify(first.publicSummary)).not.toContain("directory");
  });

  it("enforces revisions and permits an explicit failed-state replacement", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    await expect(
      prepareDraft(root, setupState(), {
        ...request,
        basedOnRevision: 0,
        draftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    await expect(
      prepareDraft(root, setupState("awaiting_owner"), {
        ...request,
        basedOnRevision: 0,
        draftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "phase_unavailable" });
    await expect(
      prepareDraft(root, setupState("configured"), {
        ...request,
        basedOnRevision: 6,
        draftRevision: 7,
      }),
    ).rejects.toMatchObject({ code: "phase_unavailable" });

    await expect(
      prepareDraft(root, setupState("draft"), {
        ...request,
        basedOnRevision: 2,
        draftRevision: 3,
      }),
    ).resolves.toMatchObject({
      publicSummary: {
        basedOnRevision: 2,
        draftRevision: 3,
        committed: false,
      },
    });
    await expect(
      prepareDraft(root, setupState("failed"), {
        ...request,
        basedOnRevision: 4,
        draftRevision: 5,
      }),
    ).resolves.toMatchObject({
      publicSummary: {
        basedOnRevision: 4,
        draftRevision: 5,
        storageVerification: "not_run",
        committed: false,
      },
    });
    await expect(
      prepareDraft(root, setupState("failed"), {
        ...request,
        basedOnRevision: 3,
        draftRevision: 4,
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    await expect(
      prepareDraft(root, setupState("failed"), {
        ...request,
        basedOnRevision: 4,
        draftRevision: 4,
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("keeps every mutable deployment path lexically inside dataRoot", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    const cases = [
      { ...request, dataRoot: "relative/data" },
      { ...request, evidenceRoot: `${root}/data/evidence/../other` },
      { ...request, evidenceRoot: request.dataRoot },
      { ...request, evidenceRoot: join(root, "data-sibling", "evidence") },
      {
        ...request,
        storage: {
          ...request.storage,
          sqlitePath: join(root, "data-sibling", "contextdesk.sqlite"),
        },
      },
      {
        ...request,
        storage: {
          ...request.storage,
          sqlitePath: request.dataRoot,
        },
      },
      {
        ...request,
        storage: { ...request.storage, sqlitePath: "/" },
      },
    ];
    for (const candidate of cases) {
      await expect(
        prepareDraft(root, setupState(), candidate),
      ).rejects.toBeInstanceOf(SetupDeploymentConfigError);
    }

    const lexicalOnly = {
      ...request,
      evidenceRoot: join(root, "data", "not-created", "evidence"),
      storage: {
        ...request.storage,
        sqlitePath: join(root, "data", "not-created", "contextdesk.sqlite"),
      },
    };
    await expect(
      prepareDraft(root, setupState(), lexicalOnly),
    ).resolves.toMatchObject({ draft: lexicalOnly });
  });

  it("requires sqlitePath and evidenceRoot to be lexically disjoint", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    const evidenceRoot = request.evidenceRoot;
    const cases = [
      {
        ...request,
        storage: { ...request.storage, sqlitePath: evidenceRoot },
      },
      {
        ...request,
        storage: {
          ...request.storage,
          sqlitePath: join(evidenceRoot, "contextdesk.sqlite"),
        },
      },
      {
        ...request,
        evidenceRoot: join(root, "data", "storage", "evidence"),
        storage: {
          ...request.storage,
          sqlitePath: join(root, "data", "storage"),
        },
      },
    ];

    for (const candidate of cases) {
      let error: unknown;
      try {
        await prepareDraft(root, setupState(), candidate);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "path_overlap" });
      expect(String(error)).not.toContain(candidate.evidenceRoot);
      expect(String(error)).not.toContain(candidate.storage.sqlitePath);
    }
  });

  it("rejects unsafe gateway URLs without reflecting their contents", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    await expect(
      prepareDraft(root, setupState(), {
        ...request,
        gateway: request.gateway && {
          ...request.gateway,
          baseUrl: "not-a-url",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });

    const unsafe = [
      "http://gateway.example.test/v1",
      "https://operator:password@gateway.example.test/v1",
      "https://gateway.example.test/v1?api_key=secret",
      "https://gateway.example.test/v1#secret",
    ];
    for (const baseUrl of unsafe) {
      let error: unknown;
      try {
        await prepareDraft(root, setupState(), {
          ...request,
          gateway: request.gateway && { ...request.gateway, baseUrl },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "invalid_gateway_url" });
      expect(String(error)).not.toContain(baseUrl);
    }

    await expect(
      prepareDraft(root, setupState(), {
        ...request,
        gateway: request.gateway && {
          ...request.gateway,
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      }),
    ).resolves.toMatchObject({
      draft: { gateway: { baseUrl: "http://127.0.0.1:11434/v1" } },
    });
  });

  it("rejects unsafe LDAP transport and ambiguous directory semantics", async () => {
    const root = await temporaryRoot();
    const request = await postgresLdapDraft(root);
    if (request.authentication.ldap === null) throw new Error("fixture error");
    const ldap = request.authentication.ldap;
    const invalid = [
      { ...ldap, url: "ldap://directory.example.test:389", starttls: false },
      { ...ldap, url: "ldaps://directory.example.test:636", starttls: true },
      { ...ldap, url: "ldaps://user:password@directory.example.test:636" },
      { ...ldap, userSearchBase: "ou=people,dc=example,dc=test" },
      { ...ldap, userDnTemplate: null, userSearchBase: null },
      { ...ldap, bindPasswordRef: null },
      { ...ldap, userDnTemplate: "uid=user,ou=people,dc=example,dc=test" },
      {
        ...ldap,
        userDnTemplate:
          "uid={username}{admin},ou=people,dc=example,dc=test",
      },
      {
        ...ldap,
        userDnTemplate:
          "uid=prefix-{username},ou=people,dc=example,dc=test",
      },
      {
        ...ldap,
        userDnTemplate:
          "uid={username},ou=people,dc=example,dc=test\\ZZ",
      },
      { ...ldap, userSearchFilter: "(uid={username}*)" },
      { ...ldap, userSearchFilter: "(uid={dn})" },
      { ...ldap, userSearchFilter: "(|(uid={username})(mail={username}))" },
      {
        ...ldap,
        userSearchFilter: "(&(objectClass=person)(uid={username}))",
      },
      { ...ldap, userSearchFilter: "(uid=prefix-{username})" },
      { ...ldap, userSearchFilter: "(uid=bad\\ZZ)" },
      { ...ldap, groupSearchFilter: "(objectClass=groupOfNames)" },
      {
        ...ldap,
        groupSearchFilter:
          "(|(objectClass=groupOfNames)(member={dn}))",
      },
      { ...ldap, groupSearchBase: "ou=groups,dc=example,dc=test\\ZZ" },
      { ...ldap, bindDn: "cn=service+uid=other,dc=example,dc=test" },
      { ...ldap, adminGroup: "cn={dn},ou=groups,dc=example,dc=test" },
    ];
    for (const candidate of invalid) {
      await expect(
        prepareDraft(root, setupState(), {
          ...request,
          authentication: {
            kind: "ldap",
            local: null,
            ldap: candidate,
          },
        }),
      ).rejects.toBeInstanceOf(SetupDeploymentConfigError);
    }
  });

  it("requires every file reference to carry its use-site purpose", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    const local = request.authentication.local;
    if (local === null) throw new Error("fixture error");
    await expect(
      prepareDraft(root, setupState(), {
        ...request,
        authentication: {
          kind: "local",
          ldap: null,
          local: {
            ...local,
            initialAdminPasswordRef: {
              ...local.initialAdminPasswordRef,
              purpose: "gateway_api_key",
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "secret_reference_invalid" });
  });

  it("maps malformed secret and CA slots to redacted reference errors", async () => {
    const root = await temporaryRoot();
    const single = await singleNodeDraft(root);
    const apiKeySentinel = "INLINE-API-KEY-MUST-NOT-LEAK";
    let secretError: unknown;
    try {
      await prepareDraft(root, setupState(), {
        ...single,
        gateway: single.gateway && {
          ...single.gateway,
          apiKeyRef: apiKeySentinel,
        },
      });
    } catch (error) {
      secretError = error;
    }
    expect(secretError).toMatchObject({ code: "secret_reference_invalid" });
    expect(String(secretError)).not.toContain(apiKeySentinel);

    const ldapRequest = await postgresLdapDraft(root);
    const ldap = ldapRequest.authentication.ldap;
    if (ldap === null) throw new Error("fixture error");
    const certificateSentinel = "INLINE-CERTIFICATE-MUST-NOT-LEAK";
    let certificateError: unknown;
    try {
      await prepareDraft(root, setupState(), {
        ...ldapRequest,
        authentication: {
          ...ldapRequest.authentication,
          ldap: {
            ...ldap,
            caCertificateRef: certificateSentinel,
          },
        },
      });
    } catch (error) {
      certificateError = error;
    }
    expect(certificateError).toMatchObject({
      code: "trusted_certificate_reference_invalid",
    });
    expect(String(certificateError)).not.toContain(certificateSentinel);
  });

  it("keeps generic reference and invalid-policy failures redacted", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    const hostPolicy = referencePolicy(root);
    const handleDeniedPolicy: SetupReferencePolicy = {
      ...hostPolicy,
      secretPurposes: {
        ...hostPolicy.secretPurposes,
        initial_admin_password: {
          ...hostPolicy.secretPurposes.initial_admin_password,
          allowHandles: false,
        },
      },
    };
    await expect(
      prepareSetupDeploymentDraft(
        setupState(),
        request,
        handleDeniedPolicy,
      ),
    ).rejects.toMatchObject({ code: "secret_reference_invalid" });

    const malformedPolicy = {
      ...hostPolicy,
      unexpected: true,
    } as unknown as SetupReferencePolicy;
    await expect(
      prepareSetupDeploymentDraft(setupState(), request, malformedPolicy),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("fails closed on every filesystem-backed secret and redacts the error", async () => {
    const root = await temporaryRoot();
    const request = await singleNodeDraft(root);
    const local = request.authentication.local;
    if (local === null) throw new Error("fixture error");
    const passwordPath = join(root, "initial-admin-password");
    request.authentication.local = {
      ...local,
      initialAdminPasswordRef: fileReference(
        passwordPath,
        "initial_admin_password",
      ),
    };

    let error: unknown;
    try {
      await prepareDraft(root, setupState(), request);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "filesystem_reference_unsupported" });
    expect(String(error)).not.toContain(passwordPath);

    const malformedPolicy = {
      ...referencePolicy(root),
      malformedPolicySentinel: true,
    } as unknown as SetupReferencePolicy;
    await expect(
      prepareSetupDeploymentDraft(setupState(), request, malformedPolicy),
    ).rejects.toMatchObject({ code: "filesystem_reference_unsupported" });
  });

  it("fails closed on every filesystem-backed CA reference", async () => {
    const root = await temporaryRoot();
    const request = await postgresLdapDraft(root);
    const ldap = request.authentication.ldap;
    if (ldap === null) throw new Error("fixture error");
    const certificatePath = join(root, "directory-ca.pem");
    request.authentication.ldap = {
      ...ldap,
      caCertificateRef: {
        kind: "trusted_certificate_file",
        purpose: "ldap_ca_certificate",
        fileRef: `file:${certificatePath}`,
      },
    };

    await expect(
      prepareDraft(root, setupState(), request),
    ).rejects.toMatchObject({ code: "filesystem_reference_unsupported" });

    const malformedPolicy = {
      ...referencePolicy(root),
      malformedPolicySentinel: true,
    } as unknown as SetupReferencePolicy;
    await expect(
      prepareSetupDeploymentDraft(setupState(), request, malformedPolicy),
    ).rejects.toMatchObject({ code: "filesystem_reference_unsupported" });
  });
});
