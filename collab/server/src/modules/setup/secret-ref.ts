import {
  SETUP_SECRET_PURPOSES,
  parseSetupSecretReference,
  parseSetupTrustedCertificateReference,
  type SetupSecretPurpose,
  type SetupSecretReferenceV1,
  type SetupTrustedCertificateReferenceV1,
} from "@cd-collab/contracts/setup";

export const MAX_SETUP_SECRET_FILE_BYTES = 64 * 1024;
export const MAX_SETUP_TRUSTED_CERTIFICATE_FILE_BYTES = 1024 * 1024;

export interface SetupSecretPurposePolicy {
  /** Reserved host policy; this JavaScript boundary never dereferences it. */
  readonly fileRoots: readonly string[];
  readonly allowHandles: boolean;
}

/** Every reference requires an explicit, host-owned purpose policy. */
export interface SetupReferencePolicy {
  readonly secretPurposes: Readonly<
    Record<SetupSecretPurpose, SetupSecretPurposePolicy>
  >;
  /** Reserved host policy; this JavaScript boundary never dereferences it. */
  readonly trustedCertificateRoots: readonly string[];
}

/** Immutable bytes supplied only by a future trusted-host resolver. */
export interface SetupFileSnapshot {
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type SetupSecretReferenceErrorCode =
  | "invalid_reference"
  | "invalid_policy"
  | "filesystem_reference_unsupported";

export class SetupSecretReferenceError extends Error {
  constructor(readonly code: SetupSecretReferenceErrorCode) {
    super(code);
    this.name = "SetupSecretReferenceError";
  }
}

function assertPolicy(policy: SetupReferencePolicy): void {
  const purposeKeys = new Set<string>(SETUP_SECRET_PURPOSES);
  if (
    typeof policy !== "object" ||
    policy === null ||
    typeof policy.secretPurposes !== "object" ||
    policy.secretPurposes === null ||
    Object.keys(policy).some(
      (key) => key !== "secretPurposes" && key !== "trustedCertificateRoots",
    ) ||
    !Array.isArray(policy.trustedCertificateRoots) ||
    policy.trustedCertificateRoots.some((root) => typeof root !== "string") ||
    Object.keys(policy.secretPurposes).some((key) => !purposeKeys.has(key)) ||
    SETUP_SECRET_PURPOSES.some((purpose) => {
      const purposePolicy = policy.secretPurposes[purpose];
      return (
        typeof purposePolicy !== "object" ||
        purposePolicy === null ||
        !Array.isArray(purposePolicy.fileRoots) ||
        purposePolicy.fileRoots.some((root) => typeof root !== "string") ||
        typeof purposePolicy.allowHandles !== "boolean" ||
        Object.keys(purposePolicy).some(
          (key) => key !== "fileRoots" && key !== "allowHandles",
        )
      );
    })
  ) {
    throw new SetupSecretReferenceError("invalid_policy");
  }
}

/**
 * Node's filesystem API does not expose an openat2-style operation with
 * RESOLVE_BENEATH and RESOLVE_NO_SYMLINKS. It also cannot prove that roots on
 * separate mount paths do not alias the same underlying object. Consequently,
 * Slice B never opens a filesystem-backed reference. Slice C may replace this
 * refusal only through a trusted-host resolver. Race, ACL, filesystem-identity,
 * descriptor-lifetime, traversal, and bounded-read qualification belong only
 * to Slice C.
 */
function rejectFilesystemReference(): never {
  throw new SetupSecretReferenceError("filesystem_reference_unsupported");
}

/**
 * Filesystem snapshots are unavailable at this JavaScript boundary. The
 * operation is never invoked, and no path or descriptor is opened.
 */
export async function withSetupSecretSnapshot<T>(
  raw: unknown,
  expectedPurpose: SetupSecretPurpose,
  _policy: SetupReferencePolicy,
  _operation: (snapshot: SetupFileSnapshot) => Promise<T>,
): Promise<T> {
  let reference: SetupSecretReferenceV1;
  try {
    reference = parseSetupSecretReference(raw, expectedPurpose);
  } catch {
    throw new SetupSecretReferenceError("invalid_reference");
  }
  if (reference.kind !== "file" || reference.fileRef === null) {
    throw new SetupSecretReferenceError("invalid_reference");
  }
  return rejectFilesystemReference();
}

/**
 * Handles receive syntax and host-policy validation only. They are not proven
 * issued, resolvable, purpose-bound by a provider, or secret-free here.
 * Filesystem-backed references always fail closed.
 */
export async function validateSetupSecretReference(
  raw: unknown,
  expectedPurpose: SetupSecretPurpose,
  policy: SetupReferencePolicy,
): Promise<SetupSecretReferenceV1> {
  let reference: SetupSecretReferenceV1;
  try {
    reference = parseSetupSecretReference(raw, expectedPurpose);
  } catch {
    throw new SetupSecretReferenceError("invalid_reference");
  }
  if (reference.kind === "file") {
    return rejectFilesystemReference();
  }
  assertPolicy(policy);
  if (!policy.secretPurposes[expectedPurpose].allowHandles) {
    throw new SetupSecretReferenceError("invalid_reference");
  }
  return structuredClone(reference);
}

/**
 * Trusted-CA file references are syntactically distinct from secrets, but this
 * boundary cannot prove race-free traversal or physical root separation and
 * therefore never dereferences or accepts them.
 */
export async function validateSetupTrustedCertificateReference(
  raw: unknown,
  _policy: SetupReferencePolicy,
): Promise<SetupTrustedCertificateReferenceV1> {
  try {
    parseSetupTrustedCertificateReference(raw);
  } catch {
    throw new SetupSecretReferenceError("invalid_reference");
  }
  return rejectFilesystemReference();
}
