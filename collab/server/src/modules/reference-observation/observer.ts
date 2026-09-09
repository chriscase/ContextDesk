import {
  FILE_SERVER_REF_SCHEMA_ID,
  REFERENCE_RECHECK_LIMITS,
  REFERENCE_RECHECK_OUTCOMES,
  hasDangerousUnicode,
  type FileServerReferenceV1,
  type ReferenceIdentityV1,
  type ReferenceRecheckOutcome,
} from "@cd-collab/contracts";

declare const SERVER_OWNED_REFERENCE: unique symbol;

/**
 * A detached public identity copied from an authorized record loaded by the
 * server. The private brand prevents request identities and raw URI strings
 * from being passed to an observer by accident.
 */
export type ServerOwnedFileServerReferenceIdentity = Readonly<ReferenceIdentityV1> & {
  readonly [SERVER_OWNED_REFERENCE]: true;
};

export interface ReferenceObservationV1 {
  readonly outcome: ReferenceRecheckOutcome;
  readonly reference: ServerOwnedFileServerReferenceIdentity;
}

export interface ReferenceObserver {
  observe(
    reference: ServerOwnedFileServerReferenceIdentity,
  ): Promise<ReferenceObservationV1>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const mintedReferences = new WeakSet<object>();

function invalidIdentity(): never {
  throw new TypeError("invalid server-owned file reference identity");
}

function assertIdentityFields(
  uri: unknown,
  expectedHash: unknown,
): asserts expectedHash is string | null {
  if (
    typeof uri !== "string"
    || uri.length === 0
    || uri.length > REFERENCE_RECHECK_LIMITS.uriMaxChars
    || uri.normalize("NFKC").trim() !== uri
    || uri.includes("\n")
    || uri.includes("\r")
    || hasDangerousUnicode(uri)
  ) {
    invalidIdentity();
  }
  if (expectedHash !== null && (
    typeof expectedHash !== "string" || !SHA256_RE.test(expectedHash)
  )) {
    invalidIdentity();
  }
}

function mintIdentity(
  uri: string,
  expectedHash: string | null,
): ServerOwnedFileServerReferenceIdentity {
  assertIdentityFields(uri, expectedHash);
  const identity = Object.freeze({
    kind: "file_server_ref" as const,
    uri,
    expectedHash,
  }) as ServerOwnedFileServerReferenceIdentity;
  mintedReferences.add(identity);
  return identity;
}

function assertMinted(
  reference: ServerOwnedFileServerReferenceIdentity,
): void {
  if (!mintedReferences.has(reference)) invalidIdentity();
}

function detachedIdentity(
  reference: ServerOwnedFileServerReferenceIdentity,
): ServerOwnedFileServerReferenceIdentity {
  assertMinted(reference);
  return mintIdentity(reference.uri, reference.expectedHash);
}

/**
 * Mint an observation target only after the caller has loaded and authorized
 * the authoritative stored reference. This function intentionally ignores
 * the storage id, schema id, and mutable legacy verification status.
 */
export function asServerOwnedFileServerReferenceIdentity(
  reference: FileServerReferenceV1,
): ServerOwnedFileServerReferenceIdentity {
  if (reference.schemaId !== FILE_SERVER_REF_SCHEMA_ID) invalidIdentity();
  return mintIdentity(reference.uri, reference.expectedHash);
}

function scriptedKey(reference: ServerOwnedFileServerReferenceIdentity): string {
  return JSON.stringify([reference.uri, reference.expectedHash]);
}

function assertOutcome(outcome: unknown): asserts outcome is ReferenceRecheckOutcome {
  if (!(REFERENCE_RECHECK_OUTCOMES as readonly unknown[]).includes(outcome)) {
    throw new TypeError("invalid reference observation outcome");
  }
}

/**
 * Deterministic injected observer for qualification and future connector
 * adapters. It performs no I/O and has no fallback outcome: an unscripted
 * identity fails closed instead of being mislabeled unreachable.
 */
export class ScriptedReferenceObserver implements ReferenceObserver {
  readonly #outcomes: ReadonlyMap<string, ReferenceRecheckOutcome>;

  constructor(
    entries: readonly (readonly [
      ServerOwnedFileServerReferenceIdentity,
      ReferenceRecheckOutcome,
    ])[],
  ) {
    const outcomes = new Map<string, ReferenceRecheckOutcome>();
    for (const [reference, outcome] of entries) {
      assertMinted(reference);
      assertOutcome(outcome);
      const key = scriptedKey(reference);
      if (outcomes.has(key)) {
        throw new TypeError("duplicate scripted reference observation identity");
      }
      outcomes.set(key, outcome);
    }
    this.#outcomes = outcomes;
  }

  async observe(
    reference: ServerOwnedFileServerReferenceIdentity,
  ): Promise<ReferenceObservationV1> {
    assertMinted(reference);
    const outcome = this.#outcomes.get(scriptedKey(reference));
    if (outcome === undefined) {
      throw new Error("reference observation unavailable");
    }
    return Object.freeze({
      outcome,
      reference: detachedIdentity(reference),
    });
  }
}
