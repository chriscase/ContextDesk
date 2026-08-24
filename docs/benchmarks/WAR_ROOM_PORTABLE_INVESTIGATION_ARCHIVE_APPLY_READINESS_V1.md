# Portable investigation archive apply-readiness v1

Status: **exact-reconstruction apply shipped**. This note records the versioned
archive projection in `collab/contracts/src/investigation-portable-archive.ts`
(schema `collab/contracts/schemas/investigation-portable-archive.v1.json`)
and the fail-closed apply contract in
`collab/contracts/src/investigation-portable-apply.ts`.

Shipped: complete archive download, parse/integrity, host destination-catalog
preflight, server-minted confirmation tokens, lead/admin apply, one atomic
persist with rollback, attribution-only historical people, and a War Room
confirmation screen. It does **not** ship Ed25519 signing or verification.

V1 portable parse/preflight remain in `investigation-portable.ts`. The package
barrel (`collab/contracts/src/index.ts`) re-exports both modules.

## Why this layer exists

The V1 bundle contract is green and fail-closed, but it is not a safe
persistence apply contract by itself:

- `exportedAt` and inline `payloadBase64` participate in the V1 transport
  fingerprint (`portableBundleFingerprint` / `bundleFingerprint`).
- Evidence bytes were easy to treat as semantically identifying if a later
  host hashed the whole envelope.
- Parent V1 deterministic remaps were namespaced strings (`inst-*::kind::id` /
  `remap-<hex>`), which are not RFC 4122 UUIDs for PostgreSQL UUID columns.
  This child maps **both** V1 preflight and archive remaps through
  `portableDestinationUuid`.
- Parent V1 preflight returned `exactReconstruction: true` unconditionally.

## Semantic vs transport identity

`portableSemanticFingerprint` hashes the investigation graph after stripping
`exportedAt`, `bundleFingerprint`, `objectHashes`, per-object `objectHash`, and
`payloadBase64`. Two exports of the same logical investigation at different
`exportedAt` values share a semantic fingerprint.

Archive `transportHash` covers envelope time, blob inventory (including inline
bytes when present), optional signature metadata, and the V1 bundle fingerprint.
It **changes** when bytes, export time, or the signature envelope change.
SHA-256 here is integrity, not authenticity.

## Blob inventory

`projectBlobInventory` / archive `blobInventory` commit each content object by
digest, byte length, and content type. Presence is `inline` | `detached` |
`omitted` | `private` | `redacted`. Detached `present` bytes are digest-committed
and are **not** claimed to be streaming or authenticated. Default V1 parse still
requires inline payload for `inclusion: present`; archive parse passes
`requireInlinePresentPayload: false`.

## RFC 4122 destination remaps

`preflightPortableArchive` replaces V1 string remaps with
`portableDestinationUuid(sourceInstallationId, namespace, sourceId, collisionCounter)`
UUID v5 values. Destination ids are:

- valid RFC 4122 UUID strings
- stable for the same source installation / object / collision counter
- namespace-separated and distinct across installations
- distinct from preserved source ids

V1 `preflightPortableInvestigation` now emits the same RFC 4122 UUID mapping
as archive preflight. Adversarial collision/exhaustion rows occupy UUID
candidates, not `remap-*` strings.

## Reconstruction status

`evaluatePortableReconstruction` returns `exact` | `metadata_only` | `blocked`
with deterministic `reconstructionReasons`. `exactReconstruction` is derived
(`status === "exact"`), never an unconditional true.

- `exact` — every required blob is present and digest/length-matched, and no
  blocking unresolved requirement remains.
- `metadata_only` — omitted, private, or redacted content (honest absence).
- `blocked` — declared-present bytes missing/malformed, missing mapped user,
  id collision under `fail`, or other blocking identity action.

## Destination catalogs are not authorization

`destinationCatalogDigest` is bound into V1 and archive preflight reports.
`destinationCatalogIsAuthorization` is always false;
`destinationCatalogMustRevalidate` is always true. A later server must load and
revalidate host catalogs. Client-supplied catalogs cannot grant authority.

## Historical participants

`historicalParticipantsAreAttributionOnly` is always true.
`destinationMembershipGranted`, `destinationRoleGranted`, and
`destinationCapabilityGranted` are always false. Permission and history caveats
remain mandatory on the envelope.

## Signature metadata

Archive signature metadata records algorithm `Ed25519`, a signing-key
fingerprint, `signedManifestHash`, and a hash inventory.
`verificationStatus` is `unverified` (or the archive is `unsigned`).
`authenticityClaim` is `none`. This slice does not verify signatures or assert
source trust.

## Remaining residuals

Not claimed by this apply V1:

- Ed25519 key management, signing, or verification (`authenticityClaim` stays
  `none`; signature metadata remains `unverified` or `unsigned`)
- applying metadata-only, blocked, omitted, private, or redacted required
  content
- interaction traces, experiment agreement, live discussion presence, and
  file-reference location verification
- deleting content-addressed evidence bytes after a rolled-back metadata write
- treating a client-supplied destination catalog as authorization
  (`destinationCatalogMustRevalidate` remains true; apply recomputes the host
  catalog)
