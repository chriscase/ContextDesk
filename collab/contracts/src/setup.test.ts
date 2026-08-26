import { describe, expect, it } from "vitest";
import {
  MAX_SETUP_HISTORY_ENTRIES,
  SETUP_CLAIM_REQUEST_SCHEMA_ID,
  SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
  SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
  SETUP_PHASES,
  SETUP_STATE_SCHEMA_ID,
  SETUP_STATUS_SCHEMA_ID,
  SETUP_TRANSITION_REQUEST_SCHEMA_ID,
  isValidSetupTransition,
  parsePersistedSetupState,
  parseSetupClaimRequest,
  parseSetupDeploymentDraftRequest,
  parseSetupDeploymentSummary,
  parseSetupSecretReference,
  parseSetupStatus,
  parseSetupTrustedCertificateReference,
  parseSetupTransitionRequest,
  projectSetupStatus,
  type PersistedSetupStateV1,
  type SetupPhase,
  type SetupSecretPurpose,
  type SetupStateEntryV1,
} from "./setup.js";
import { ContractViolation } from "./parse.js";

const TOKEN = "A".repeat(43);

function entry(
  revision: number,
  phase: SetupPhase,
  overrides: Partial<SetupStateEntryV1> = {},
): SetupStateEntryV1 {
  const claimed = phase !== "awaiting_owner";
  const failed = phase === "failed" || phase === "recovery_required";
  return {
    stateId: `state:${revision}`,
    revision,
    phase,
    occurredAtUnixMs: 1_000 + revision,
    claimId: claimed ? "claim:one" : null,
    claimantLabel: claimed ? "Local operator" : null,
    failureCode: failed ? "verification_failed" : null,
    ...overrides,
  };
}

function persisted(phases: SetupPhase[]): PersistedSetupStateV1 {
  return {
    schemaId: SETUP_STATE_SCHEMA_ID,
    deploymentId: "deployment:one",
    ownerTokenDigest: "a".repeat(64),
    history: phases.map((phase, revision) => entry(revision, phase)),
  };
}

describe("first-run setup contracts", () => {
  it("parses bounded claim requests and rejects drift without reflecting the token", () => {
    const request = {
      schemaId: SETUP_CLAIM_REQUEST_SCHEMA_ID,
      expectedRevision: 0,
      ownerToken: TOKEN,
      claimantLabel: "Local operator",
    };
    expect(parseSetupClaimRequest(request)).toEqual(request);
    expect(() =>
      parseSetupClaimRequest({ ...request, unexpected: true }),
    ).toThrow(/unknown key/);

    let message = "";
    const invalidToken = `secret value/${TOKEN}`;
    try {
      parseSetupClaimRequest({ ...request, ownerToken: invalidToken });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(invalidToken);
    expect(message).toMatch(/high-entropy base64url token/);

    expect(() =>
      parseSetupClaimRequest({ ...request, claimantLabel: "x".repeat(129) }),
    ).toThrow(/bounded non-secret label/);
    expect(() =>
      parseSetupClaimRequest({ ...request, ownerToken: "A".repeat(5_000) }),
    ).toThrow(/body limit/);
  });

  it("requires bounded machine-readable failure codes only for failure states", () => {
    const request = {
      schemaId: SETUP_TRANSITION_REQUEST_SCHEMA_ID,
      expectedRevision: 3,
      targetPhase: "failed",
      failureCode: "database_unreachable",
    } as const;
    expect(parseSetupTransitionRequest(request)).toEqual(request);
    expect(() =>
      parseSetupTransitionRequest({ ...request, unexpected: true }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseSetupTransitionRequest({ ...request, failureCode: null }),
    ).toThrow(/required for a failure state/);
    expect(() =>
      parseSetupTransitionRequest({
        ...request,
        targetPhase: "draft",
      }),
    ).toThrow(/must be null outside a failure state/);
    expect(() =>
      parseSetupTransitionRequest({ ...request, failureCode: "Contains a secret" }),
    ).toThrow(/bounded failure code/);
  });

  it("defines every valid transition and rejects all other phase pairs", () => {
    const allowed = new Set([
      "awaiting_owner->claimed",
      "claimed->draft",
      "draft->draft",
      "draft->verifying",
      "verifying->failed",
      "verifying->ready_to_commit",
      "verifying->recovery_required",
      "failed->draft",
      "ready_to_commit->restart_required",
      "ready_to_commit->recovery_required",
      "restart_required->configured",
      "restart_required->recovery_required",
    ]);
    for (const from of SETUP_PHASES) {
      for (const to of SETUP_PHASES) {
        expect(isValidSetupTransition(from, to), `${from}->${to}`).toBe(
          allowed.has(`${from}->${to}`),
        );
      }
    }
  });

  it("accepts complete success, retry, and recovery histories", () => {
    const histories: SetupPhase[][] = [
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "draft",
        "verifying",
        "failed",
        "draft",
        "verifying",
        "ready_to_commit",
        "restart_required",
        "configured",
      ],
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "verifying",
        "recovery_required",
      ],
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "verifying",
        "ready_to_commit",
        "recovery_required",
      ],
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "verifying",
        "ready_to_commit",
        "restart_required",
        "recovery_required",
      ],
    ];
    for (const history of histories) {
      expect(parsePersistedSetupState(persisted(history)).history).toHaveLength(
        history.length,
      );
    }
  });

  it("rejects malformed, oversized, duplicate, and mutable persisted state", () => {
    const valid = persisted(["awaiting_owner", "claimed", "draft"]);
    expect(() =>
      parsePersistedSetupState({ ...valid, unexpected: true }),
    ).toThrow(/unknown key/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: [
          valid.history[0],
          { ...valid.history[1], unexpected: true },
        ],
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, stateId: "state:1" } : row,
        ),
      }),
    ).toThrow(/duplicate state id/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, revision: 9 } : row,
        ),
      }),
    ).toThrow(/contiguous/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, occurredAtUnixMs: 1 } : row,
        ),
      }),
    ).toThrow(/cannot move backwards/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, claimId: "claim:changed" } : row,
        ),
      }),
    ).toThrow(/claim metadata is immutable/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        ownerTokenDigest: TOKEN,
      }),
    ).toThrow(/SHA-256 digest/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: Array.from(
          { length: MAX_SETUP_HISTORY_ENTRIES + 1 },
          (_, index) => entry(index, index === 0 ? "awaiting_owner" : "claimed"),
        ),
      }),
    ).toThrow(/history length/);
    expect(() =>
      parsePersistedSetupState(
        persisted(["awaiting_owner", "claimed", "configured"]),
      ),
    ).toThrow(/invalid setup state transition/);
  });

  it("projects a strict public status with no private token, digest, or path", () => {
    const raw = persisted(["awaiting_owner", "claimed", "draft"]);
    raw.ownerTokenDigest = "b".repeat(64);
    const status = projectSetupStatus(raw);
    expect(status).toEqual({
      schemaId: SETUP_STATUS_SCHEMA_ID,
      stateId: "state:2",
      revision: 2,
      phase: "draft",
      claimed: true,
      failureCode: null,
    });
    expect(parseSetupStatus(status)).toEqual(status);
    expect(() => parseSetupStatus({ ...status, token: TOKEN })).toThrow(/unknown key/);

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(raw.ownerTokenDigest);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("/private/");
  });
});

const protectedFile = (path: string, purpose: SetupSecretPurpose) => ({
  kind: "file",
  purpose,
  fileRef: `file:${path}`,
  handle: null,
});

const secretHandle = (purpose: SetupSecretPurpose) => ({
  kind: "handle",
  purpose,
  fileRef: null,
  handle: `setup_secret:${purpose}:${"a".repeat(64)}`,
});

const trustedCertificate = (path: string) => ({
  kind: "trusted_certificate_file",
  purpose: "ldap_ca_certificate",
  fileRef: `file:${path}`,
});

function singleNodeDraft() {
  return {
    schemaId: SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID,
    basedOnRevision: 1,
    draftRevision: 2,
    deploymentProfile: "single_node",
    dataRoot: "/srv/contextdesk/data",
    evidenceRoot: "/srv/contextdesk/data/evidence",
    storage: {
      kind: "sqlite",
      sqlitePath: "/srv/contextdesk/data/contextdesk.sqlite",
      databaseUrlRef: null,
      migrateDatabaseUrlRef: null,
    },
    authentication: {
      kind: "local",
      local: {
        initialAdminUsername: "owner",
        initialAdminDisplayName: "ContextDesk owner",
        initialAdminPasswordRef: protectedFile(
          "/run/secrets/contextdesk-admin",
          "initial_admin_password",
        ),
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

function postgresLdapDraft() {
  return {
    ...singleNodeDraft(),
    deploymentProfile: "postgres_ldap",
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
        caCertificateRef: trustedCertificate("/etc/ssl/directory-ca.pem"),
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
  };
}

describe("first-run deployment configuration contracts", () => {
  it("accepts strict single-node and PostgreSQL/LDAP draft shapes", () => {
    expect(parseSetupDeploymentDraftRequest(singleNodeDraft())).toEqual(
      singleNodeDraft(),
    );
    expect(parseSetupDeploymentDraftRequest(postgresLdapDraft())).toEqual(
      postgresLdapDraft(),
    );
    expect(
      parseSetupSecretReference(
        secretHandle("gateway_api_key"),
        "gateway_api_key",
      ),
    ).toEqual(secretHandle("gateway_api_key"));
    const posixBackslashFile = protectedFile(
      "/run/secrets/gateway\\key",
      "gateway_api_key",
    );
    expect(
      parseSetupSecretReference(posixBackslashFile, "gateway_api_key"),
    ).toEqual(posixBackslashFile);
    expect(
      parseSetupTrustedCertificateReference(
        trustedCertificate("/etc/ssl/directory-ca.pem"),
      ),
    ).toEqual(trustedCertificate("/etc/ssl/directory-ca.pem"));

    const escaped = postgresLdapDraft();
    const ldap = escaped.authentication.ldap;
    if (ldap === null) throw new Error("fixture error");
    const escapedDirectoryValues = {
      ...escaped,
      authentication: {
        ...escaped.authentication,
        ldap: {
          ...ldap,
          bindDn: "cn=ContextDesk\\20Service,ou=services,dc=example,dc=test",
          adminGroup:
            "cn=ContextDesk\\, Admins,ou=groups,dc=example,dc=test",
          groupSearchFilter:
            "(&(description=ops\\2Ateam)(member={dn}))",
        },
      },
    };
    expect(parseSetupDeploymentDraftRequest(escapedDirectoryValues)).toEqual(
      escapedDirectoryValues,
    );
  });

  it("accepts AD-shaped search filters, {0} aliases, and explicit resolution modes", () => {
    const ldap = postgresLdapDraft();
    const ldapConfig = ldap.authentication.ldap;
    if (ldapConfig === null) throw new Error("fixture error");
    const adShaped = {
      ...ldap,
      authentication: {
        ...ldap.authentication,
        ldap: {
          ...ldapConfig,
          userDnTemplate: null,
          userSearchBase: "ou=people,dc=example,dc=test",
          userSearchFilter: "(&(objectClass=person)(uid={username}))",
          userResolutionModes: ["service_bind_search", "upn", "domain_backslash"],
          upnSuffix: "example.test",
          netbiosDomain: "EXAMPLE",
          memberAttribute: "memberOf",
          displayNameAttr: "cn",
          roleTitleAttr: "title",
          teamAttr: "departmentNumber",
          emailAttr: "mail",
        },
      },
    };
    expect(parseSetupDeploymentDraftRequest(adShaped)).toMatchObject({
      authentication: {
        ldap: {
          userSearchFilter: "(&(objectClass=person)(uid={username}))",
          upnSuffix: "example.test",
          netbiosDomain: "EXAMPLE",
        },
      },
    });
    const zeroAlias = {
      ...adShaped,
      authentication: {
        ...adShaped.authentication,
        ldap: {
          ...adShaped.authentication.ldap,
          userSearchFilter: "(sAMAccountName={0})",
        },
      },
    };
    expect(
      parseSetupDeploymentDraftRequest(zeroAlias).authentication.ldap?.userSearchFilter,
    ).toBe("(sAMAccountName={0})");
    const zeroDn = {
      ...zeroAlias,
      authentication: {
        ...zeroAlias.authentication,
        ldap: {
          ...zeroAlias.authentication.ldap,
          userDnTemplate: "uid={0},ou=people,dc=example,dc=test",
          userResolutionModes: ["dn_template", "service_bind_search", "upn", "domain_backslash"],
        },
      },
    };
    expect(parseSetupDeploymentDraftRequest(zeroDn).authentication.ldap?.userDnTemplate).toBe(
      "uid={0},ou=people,dc=example,dc=test",
    );
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...adShaped,
        authentication: {
          ...adShaped.authentication,
          ldap: { ...adShaped.authentication.ldap, userResolutionModes: [] },
        },
      }),
    ).toThrow(/at least one resolution mode/);
  });

  it("rejects unknown fields, inline secrets, and ambiguous secret references", () => {
    const draft = singleNodeDraft();
    expect(() =>
      parseSetupDeploymentDraftRequest({ ...draft, databasePassword: "secret" }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...draft,
        gateway: { ...draft.gateway, apiKey: "sk-inline-secret" },
      }),
    ).toThrow(/unknown key/);
    for (const handle of [
      "sk-inline-secret",
      "provider/sk-live-secret",
      "setup_secret:unknown_purpose:" + "a".repeat(64),
      "setup_secret:gateway_api_key:" + "A".repeat(64),
      "setup_secret:gateway_api_key:short",
    ]) {
      expect(() =>
        parseSetupSecretReference(
          {
            kind: "handle",
            purpose: "gateway_api_key",
            fileRef: null,
            handle,
          },
          "gateway_api_key",
        ),
      ).toThrow(/invalid secret reference/);
    }
    expect(() =>
      parseSetupSecretReference(
        secretHandle("database_url"),
        "gateway_api_key",
      ),
    ).toThrow(/invalid secret reference/);
    expect(() =>
      parseSetupSecretReference(
        {
          kind: "file",
          purpose: "gateway_api_key",
          fileRef: "file:/run/secrets/key",
          handle: "provider/key",
        },
        "gateway_api_key",
      ),
    ).toThrow(/invalid secret reference/);
    expect(() =>
      parseSetupTrustedCertificateReference({
        ...trustedCertificate("/etc/ssl/directory-ca.pem"),
        handle: "not-allowed",
      }),
    ).toThrow(/invalid trusted-certificate reference/);
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...draft,
        gateway: {
          ...draft.gateway,
          apiKeyRef: secretHandle("database_url"),
        },
      }),
    ).toThrow(/invalid secret reference/);
    expect(() =>
      parseSetupSecretReference(
        protectedFile("/run/secrets/shared", "database_url"),
        "gateway_api_key",
      ),
    ).toThrow(/invalid secret reference/);

    const syntaxOnly = secretHandle("gateway_api_key");
    expect(
      parseSetupSecretReference(syntaxOnly, "gateway_api_key"),
    ).toEqual(syntaxOnly);
    expect(syntaxOnly).not.toHaveProperty("issued");
    expect(syntaxOnly).not.toHaveProperty("resolved");
  });

  it("never reflects primitive credentials supplied in reference slots", () => {
    const single = singleNodeDraft();
    const ldapDraft = postgresLdapDraft();
    const cases: Array<{ sentinel: string; raw: unknown }> = [
      {
        sentinel: "INLINE-ADMIN-PASSWORD-SENTINEL",
        raw: {
          ...single,
          authentication: {
            ...single.authentication,
            local: {
              ...single.authentication.local,
              initialAdminPasswordRef: "INLINE-ADMIN-PASSWORD-SENTINEL",
            },
          },
        },
      },
      {
        sentinel: "INLINE-GATEWAY-API-KEY-SENTINEL",
        raw: {
          ...single,
          gateway: {
            ...single.gateway,
            apiKeyRef: "INLINE-GATEWAY-API-KEY-SENTINEL",
          },
        },
      },
      {
        sentinel: "INLINE-DATABASE-URL-SENTINEL",
        raw: {
          ...ldapDraft,
          storage: {
            ...ldapDraft.storage,
            databaseUrlRef: "INLINE-DATABASE-URL-SENTINEL",
          },
        },
      },
      {
        sentinel: "INLINE-MIGRATE-URL-SENTINEL",
        raw: {
          ...ldapDraft,
          storage: {
            ...ldapDraft.storage,
            migrateDatabaseUrlRef: "INLINE-MIGRATE-URL-SENTINEL",
          },
        },
      },
      {
        sentinel: "INLINE-LDAP-PASSWORD-SENTINEL",
        raw: {
          ...ldapDraft,
          authentication: {
            ...ldapDraft.authentication,
            ldap: {
              ...ldapDraft.authentication.ldap,
              bindPasswordRef: "INLINE-LDAP-PASSWORD-SENTINEL",
            },
          },
        },
      },
      {
        sentinel: "INLINE-CA-CERTIFICATE-SENTINEL",
        raw: {
          ...ldapDraft,
          authentication: {
            ...ldapDraft.authentication,
            ldap: {
              ...ldapDraft.authentication.ldap,
              caCertificateRef: "INLINE-CA-CERTIFICATE-SENTINEL",
            },
          },
        },
      },
    ];

    for (const { sentinel, raw } of cases) {
      let message = "";
      try {
        parseSetupDeploymentDraftRequest(raw);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("invalid");
      expect(message).not.toContain(sentinel);
    }

    for (const [sentinel, parse] of [
      [
        "DIRECT-API-KEY-SENTINEL",
        () =>
          parseSetupSecretReference(
            "DIRECT-API-KEY-SENTINEL",
            "gateway_api_key",
          ),
      ],
      [
        "DIRECT-CERTIFICATE-SENTINEL",
        () =>
          parseSetupTrustedCertificateReference(
            "DIRECT-CERTIFICATE-SENTINEL",
          ),
      ],
    ] as const) {
      let message = "";
      try {
        parse();
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("invalid");
      expect(message).not.toContain(sentinel);
    }
  });

  it("sanitizes every structured secret and CA reference violation", () => {
    const expectSanitized = (
      parse: () => unknown,
      sentinel: string,
      expectedPath: string,
    ) => {
      let error: unknown;
      try {
        parse();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ContractViolation);
      const violation = error as ContractViolation;
      expect(violation.path).toBe(expectedPath);
      expect(violation.path).not.toContain(sentinel);
      expect(String(violation)).not.toContain(sentinel);
    };

    const secretCases: Array<{ sentinel: string; raw: unknown }> = [
      {
        sentinel: "SECRET-KIND-SENTINEL",
        raw: {
          kind: "SECRET-KIND-SENTINEL",
          purpose: "gateway_api_key",
          fileRef: null,
          handle: null,
        },
      },
      {
        sentinel: "SECRET-PURPOSE-SENTINEL",
        raw: {
          kind: "handle",
          purpose: "SECRET-PURPOSE-SENTINEL",
          fileRef: null,
          handle: `setup_secret:gateway_api_key:${"a".repeat(64)}`,
        },
      },
      {
        sentinel: "SECRET-UNKNOWN-KEY-AND-VALUE-SENTINEL",
        raw: {
          ...secretHandle("gateway_api_key"),
          "SECRET-UNKNOWN-KEY-AND-VALUE-SENTINEL":
            "SECRET-UNKNOWN-KEY-AND-VALUE-SENTINEL",
        },
      },
      {
        sentinel: "SECRET-FILE-REF-SENTINEL",
        raw: {
          kind: "file",
          purpose: "gateway_api_key",
          fileRef: "SECRET-FILE-REF-SENTINEL",
          handle: null,
        },
      },
      {
        sentinel: "SECRET-HANDLE-SENTINEL",
        raw: {
          kind: "handle",
          purpose: "gateway_api_key",
          fileRef: null,
          handle: "SECRET-HANDLE-SENTINEL",
        },
      },
    ];
    for (const { sentinel, raw } of secretCases) {
      expectSanitized(
        () => parseSetupSecretReference(raw, "gateway_api_key"),
        sentinel,
        "$",
      );
    }

    const certificateCases: Array<{ sentinel: string; raw: unknown }> = [
      {
        sentinel: "CERTIFICATE-KIND-SENTINEL",
        raw: {
          kind: "CERTIFICATE-KIND-SENTINEL",
          purpose: "ldap_ca_certificate",
          fileRef: "file:/certificate.pem",
        },
      },
      {
        sentinel: "CERTIFICATE-PURPOSE-SENTINEL",
        raw: {
          kind: "trusted_certificate_file",
          purpose: "CERTIFICATE-PURPOSE-SENTINEL",
          fileRef: "file:/certificate.pem",
        },
      },
      {
        sentinel: "CERTIFICATE-UNKNOWN-KEY-AND-VALUE-SENTINEL",
        raw: {
          ...trustedCertificate("/certificate.pem"),
          "CERTIFICATE-UNKNOWN-KEY-AND-VALUE-SENTINEL":
            "CERTIFICATE-UNKNOWN-KEY-AND-VALUE-SENTINEL",
        },
      },
      {
        sentinel: "CERTIFICATE-FILE-REF-SENTINEL",
        raw: {
          kind: "trusted_certificate_file",
          purpose: "ldap_ca_certificate",
          fileRef: "CERTIFICATE-FILE-REF-SENTINEL",
        },
      },
    ];
    for (const { sentinel, raw } of certificateCases) {
      expectSanitized(
        () => parseSetupTrustedCertificateReference(raw),
        sentinel,
        "$",
      );
    }

    const single = singleNodeDraft();
    const draftSecretSentinel = "DRAFT-SECRET-KEY-SENTINEL";
    expectSanitized(
      () =>
        parseSetupDeploymentDraftRequest({
          ...single,
          gateway: {
            ...single.gateway,
            apiKeyRef: {
              ...secretHandle("gateway_api_key"),
              [draftSecretSentinel]: draftSecretSentinel,
            },
          },
        }),
      draftSecretSentinel,
      "$.gateway.apiKeyRef",
    );

    const ldapDraft = postgresLdapDraft();
    const draftCertificateSentinel = "DRAFT-CERTIFICATE-KEY-SENTINEL";
    expectSanitized(
      () =>
        parseSetupDeploymentDraftRequest({
          ...ldapDraft,
          authentication: {
            ...ldapDraft.authentication,
            ldap: {
              ...ldapDraft.authentication.ldap,
              caCertificateRef: {
                ...trustedCertificate("/certificate.pem"),
                [draftCertificateSentinel]: draftCertificateSentinel,
              },
            },
          },
        }),
      draftCertificateSentinel,
      "$.authentication.ldap.caCertificateRef",
    );
  });

  it("rejects malformed URLs, mismatched profiles, and missing variant fields", () => {
    const single = singleNodeDraft();
    expect(() =>
      parseSetupDeploymentDraftRequest({ ...single, draftRevision: 1 }),
    ).toThrow(/advance exactly one revision/);
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...single,
        gateway: { ...single.gateway, baseUrl: "not a URL" },
      }),
    ).toThrow(/valid URL/);
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...single,
        deploymentProfile: "postgres_ldap",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...single,
        storage: { ...single.storage, sqlitePath: null },
      }),
    ).toThrow(/invalid SQLite storage shape/);

    const ldap = postgresLdapDraft();
    expect(() =>
      parseSetupDeploymentDraftRequest({
        ...ldap,
        authentication: {
          ...ldap.authentication,
          ldap: { ...ldap.authentication.ldap, url: "://broken" },
        },
      }),
    ).toThrow(/valid URL/);

    const ldapConfig = ldap.authentication.ldap;
    if (ldapConfig === null) throw new Error("fixture error");
    for (const invalidLookup of [
      {
        ...ldapConfig,
        userSearchBase: "ou=people,dc=example,dc=test",
      },
      { ...ldapConfig, userDnTemplate: null, userSearchBase: null },
      { ...ldapConfig, bindPasswordRef: null },
    ]) {
      expect(() =>
        parseSetupDeploymentDraftRequest({
          ...ldap,
          authentication: {
            ...ldap.authentication,
            ldap: invalidLookup,
          },
        }),
      ).toThrow(/exactly one narrow lookup mode|supplied together/);
    }
    for (const invalidTemplate of [
      "uid={username}{username},ou=people,dc=example,dc=test",
      "uid={admin},ou=people,dc=example,dc=test",
      "{username}",
      "uid={username,ou=people,dc=example,dc=test",
      "uid=prefix-{username},ou=people,dc=example,dc=test",
      "uid={username},ou=people,dc=example,dc=test\\ZZ",
    ]) {
      expect(() =>
        parseSetupDeploymentDraftRequest({
          ...ldap,
          authentication: {
            ...ldap.authentication,
            ldap: { ...ldapConfig, userDnTemplate: invalidTemplate },
          },
        }),
      ).toThrow(/placeholder|malformed|exactly once|RFC4514|narrow/);
    }
    for (const invalidFilter of [
      "uid={username}",
      "(uid={username}{admin})",
      "(uid={username}*)",
      "(&(uid={username})",
      "(uid={dn})",
      "(|(uid={username})(mail={username}))",
      "(uid=prefix-{username})",
      "(uid=bad\\ZZ)",
    ]) {
      expect(() =>
        parseSetupDeploymentDraftRequest({
          ...ldap,
          authentication: {
            ...ldap.authentication,
            ldap: { ...ldapConfig, userSearchFilter: invalidFilter },
          },
        }),
      ).toThrow(/placeholder|malformed|exactly once|policy-broad|RFC4515|narrow/);
    }

    for (const [field, value] of [
      ["groupSearchBase", "ou=groups,dc=example,dc=test\\ZZ"],
      ["bindDn", "cn=service+uid=other,dc=example,dc=test"],
      ["adminGroup", "cn={dn},ou=groups,dc=example,dc=test"],
    ] as const) {
      expect(() =>
        parseSetupDeploymentDraftRequest({
          ...ldap,
          authentication: {
            ...ldap.authentication,
            ldap: { ...ldapConfig, [field]: value },
          },
        }),
      ).toThrow(/RFC4514|narrow|placeholder/);
    }
  });

  it("parses only an explicitly unverified, uncommitted redacted summary", () => {
    const summary = {
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
    } as const;
    expect(parseSetupDeploymentSummary(summary)).toEqual(summary);
    expect(() =>
      parseSetupDeploymentSummary({ ...summary, committed: true }),
    ).toThrow(/cannot claim commit/);
    expect(() =>
      parseSetupDeploymentSummary({ ...summary, draftRevision: 3 }),
    ).toThrow(/advance exactly one revision/);
    expect(() =>
      parseSetupDeploymentSummary({
        ...summary,
        gateway: "not_configured",
      }),
    ).toThrow(/does not match gateway/);
    expect(() =>
      parseSetupDeploymentSummary({ ...summary, storage: "postgres" }),
    ).toThrow(/does not match storage/);
    expect(() =>
      parseSetupDeploymentSummary({ ...summary, authentication: "ldap" }),
    ).toThrow(/does not match storage/);

    const serialized = JSON.stringify(summary);
    for (const forbidden of [
      "/srv/contextdesk",
      "/run/secrets",
      "gateway.example.test",
      "setup_secret:",
      "owner",
      "secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
