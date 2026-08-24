import { describe, expect, it, vi } from "vitest";
import {
  SETUP_SECRET_PURPOSES,
  parseSetupSecretReference,
  type SetupSecretPurpose,
} from "@cd-collab/contracts/setup";
import {
  SetupSecretReferenceError,
  validateSetupSecretReference,
  validateSetupTrustedCertificateReference,
  withSetupSecretSnapshot,
  type SetupReferencePolicy,
} from "./secret-ref.js";

const policy = (
  purposeRoots: Partial<Record<SetupSecretPurpose, readonly string[]>> = {},
  certificateRoots: readonly string[] = [],
  handlePurposes: readonly SetupSecretPurpose[] = SETUP_SECRET_PURPOSES,
): SetupReferencePolicy => ({
  secretPurposes: Object.fromEntries(
    SETUP_SECRET_PURPOSES.map((purpose) => [
      purpose,
      {
        fileRoots: purposeRoots[purpose] ?? [],
        allowHandles: handlePurposes.includes(purpose),
      },
    ]),
  ) as unknown as SetupReferencePolicy["secretPurposes"],
  trustedCertificateRoots: certificateRoots,
});

const fileReference = (path: string, purpose: SetupSecretPurpose) => ({
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

const certificateReference = (path: string) => ({
  kind: "trusted_certificate_file",
  purpose: "ldap_ca_certificate",
  fileRef: `file:${path}`,
});

describe("setup file and handle references", () => {
  it("keeps purpose-bound handles portable but explicitly syntax-only", async () => {
    const referencePolicy = policy();
    for (const purpose of SETUP_SECRET_PURPOSES) {
      const reference = secretHandle(purpose);
      await expect(
        validateSetupSecretReference(reference, purpose, referencePolicy),
      ).resolves.toEqual(reference);
    }

    await expect(
      validateSetupSecretReference(
        secretHandle("database_url"),
        "gateway_api_key",
        referencePolicy,
      ),
    ).rejects.toMatchObject({ code: "invalid_reference" });
    await expect(
      validateSetupSecretReference(
        secretHandle("gateway_api_key"),
        "gateway_api_key",
        policy(
          {},
          [],
          SETUP_SECRET_PURPOSES.filter(
            (purpose) => purpose !== "gateway_api_key",
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_reference" });
  });

  it("rejects malformed host policy before accepting a handle", async () => {
    const malformed = {
      ...policy(),
      unexpected: true,
    } as unknown as SetupReferencePolicy;
    await expect(
      validateSetupSecretReference(
        secretHandle("gateway_api_key"),
        "gateway_api_key",
        malformed,
      ),
    ).rejects.toMatchObject({ code: "invalid_policy" });
  });

  it("rejects every syntax-valid secret file reference without path qualification", async () => {
    const paths = [
      "/run/secrets/initial-admin",
      "relative/database.url",
      "/srv/secrets/../migrate.url",
      "C:\\ContextDesk\\ldap-bind-password",
      "/srv/secrets/gateway\\key",
    ] as const;
    const referencePolicy = {
      ...policy(
        Object.fromEntries(
          SETUP_SECRET_PURPOSES.map((purpose) => [
            purpose,
            [`/host-policy/${purpose}`],
          ]),
        ),
      ),
      malformedPolicySentinel: true,
    } as unknown as SetupReferencePolicy;

    for (const [index, purpose] of SETUP_SECRET_PURPOSES.entries()) {
      const reference = fileReference(paths[index] ?? paths[0], purpose);
      expect(parseSetupSecretReference(reference, purpose)).toEqual(reference);
      await expect(
        validateSetupSecretReference(reference, purpose, referencePolicy),
      ).rejects.toMatchObject({ code: "filesystem_reference_unsupported" });
    }
  });

  it("rejects every syntax-valid CA file reference without path qualification", async () => {
    const referencePolicy = {
      ...policy({}, ["/host-policy/trusted-ca"]),
      malformedPolicySentinel: true,
    } as unknown as SetupReferencePolicy;
    for (const path of [
      "/etc/contextdesk/directory-ca.pem",
      "relative/directory-ca.pem",
      "C:\\ContextDesk\\directory-ca.pem",
      "/etc/contextdesk/trust\\directory-ca.pem",
    ]) {
      await expect(
        validateSetupTrustedCertificateReference(
          certificateReference(path),
          referencePolicy,
        ),
      ).rejects.toMatchObject({ code: "filesystem_reference_unsupported" });
    }
  });

  it("never invokes a snapshot consumer or performs path qualification", async () => {
    const operation = vi.fn(async () => "must-not-run");
    await expect(
      withSetupSecretSnapshot(
        fileReference(
          "/definitely-not-created/secret/../gateway.key",
          "gateway_api_key",
        ),
        "gateway_api_key",
        {
          ...policy({ gateway_api_key: ["/also-not-created"] }),
          malformedPolicySentinel: true,
        } as unknown as SetupReferencePolicy,
        operation,
      ),
    ).rejects.toMatchObject({ code: "filesystem_reference_unsupported" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps rejected paths and contents out of public errors", async () => {
    const rawSecret = "TOP-SECRET-CONTENT-MUST-NOT-LEAK";
    const path = `/private/${rawSecret}/gateway.key`;
    let error: unknown;
    try {
      await validateSetupSecretReference(
        fileReference(path, "gateway_api_key"),
        "gateway_api_key",
        policy({ gateway_api_key: ["/private"] }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SetupSecretReferenceError);
    expect(error).toMatchObject({ code: "filesystem_reference_unsupported" });
    expect(String(error)).not.toContain(path);
    expect(String(error)).not.toContain(rawSecret);
  });
});
