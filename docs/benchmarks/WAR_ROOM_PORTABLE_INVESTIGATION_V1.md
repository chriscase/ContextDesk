# War Room portable investigation contract v1

Status: **contract only**. This document specifies a fail-closed JSON contract for
exporting and reconstructing **one** supported investigation record on another
ContextDesk installation. It does **not** claim persistence, UI, storage,
network transport, or import apply wiring. No live provider calls. No invented
gold, cost, or usage.

Shipped module: `collab/contracts/src/investigation-portable.ts`
Schema: `collab/contracts/schemas/investigation-portable.v1.json`

The package barrel (`collab/contracts/src/index.ts`) re-exports this module.
Consumers import `@cd-collab/contracts`.

Apply-readiness hardening lives in `collab/contracts/src/investigation-portable-archive.ts`
(schema `investigation-portable-archive.v1.json`). Exact-reconstruction apply is
documented in `docs/benchmarks/WAR_ROOM_PORTABLE_INVESTIGATION_ARCHIVE_APPLY_READINESS_V1.md`.
Ed25519 verification is still not implemented.

## Scope

A portable bundle is provider-neutral, deterministic, and **deny-unknown**.
`checkObject` rejects contract drift. JSON Schema uses `additionalProperties:
false` except for `opaquePayloadJson`, which is a **canonical JSON object
string** — the only place unknown-but-valid opaque keys may survive, and only
after a credential/endpoint scan.

The bundle covers:

- Manifest: schema id `cd-collab.investigation_portable.v1`, protocol `cd.v1`,
  opaque `sourceInstallationId` (`inst-*`, not a hostname), `exportedAt`,
  canonical `bundleFingerprint`, and per-object SHA-256 hashes
- Case metadata, status, severity, retention, legal hold
- Participants and immutable historical actor snapshots
- Contributions with revisions, attribution, privacy, provenance, tombstones
- Evidence metadata plus content objects by digest, with explicit
  `present` / `omitted` / `private` / `redacted` inclusion
- Source catalog and imported AI runs (usage and cost are **unknown**)
- Frozen snapshots with exact lineage, fingerprints, and fairness
- Triage jobs, runs, strategies, and model records (usage and cost **unknown**)
- Experiments, helpfulness observations, accepted decision revisions, gold
  versions, and automated alignments
- Discussions, timeline, audit references, and attachments

The bundle contains **no** credentials, tokens, gateway secrets, live endpoints,
LDAP credentials, or destination capabilities. Destination permissions are not
imported: they must be newly authorized and audited (`permissionCaveat`).

The current server intentionally exports empty source-membership, discussion,
alignment, and audit-reference collections and omits opaque imported-run state.
An incoming archive that represents those unsupported fields is not eligible
for exact apply.
Imported history is immutable and never auto-merged by display name or email
(`historyCaveat`).

## Destination identity

Identity handling is an explicit map supplied to **preflight**, not inferred
from the bundle:

| Action | Meaning |
| --- | --- |
| `map_existing` | Bind `sourceActorId` to a destination actor id that already exists |
| `provision_invite` | Destination may later invite/provision; not performed here |
| `preserve_historical_external` | Keep the actor as an immutable external historical snapshot |
| `leave_unresolved` | Do not bind; references stay namespaced |

Every source actor must appear exactly once. Display name and email are never
equality keys. Two source actors mapping to one destination, a missing map row,
or `map_existing` without a cataloged destination id is **identity-map
ambiguity** and fails closed.

## Import preflight

`preflightPortableInvestigation` is a dry-run report over parsed JSON. `mode`
must be `dry_run`. Apply is **out of scope** and is not implemented; any other
mode fails closed (`dry-run is required before apply`). `applyAuthorized` is
always `false`.

The report includes:

- `counts.create` / `update` / `conflict` / `blocked` (`update` is always 0:
  history is not overwritten)
- `collisionPolicy`: `fail` or `remap_deterministic`
- missing profile / omitted-content **warnings**
- referential-integrity failures (missing destination users, raw-id collisions
  under `fail`)
- deterministic ID remapping: RFC 4122 UUID v5 values from
  `portableDestinationUuid(sourceInstallationId, namespace, rawId, collisionCounter)`.
  Dry-run/preflight never emits `sourceInstallationId::namespace::sourceId` or
  `remap-*` as executable destination IDs. Mapping is collision-safe (occupied
  destination UUIDs increment the counter; bounded exhaustion fails closed).
- typed `reconstructionStatus`: `exact` | `metadata_only` | `blocked` (no longer
  unconditional `exactReconstruction: true`)
- `semanticFingerprint` independent of `exportedAt` and inline payload layout
- `destinationCatalogDigest` bound into the report; catalogs are host-authored
  inputs and **never authorization**. A later server must load and revalidate them.
- historical participants/roles remain attribution snapshots only (`historicalParticipantsAreAttributionOnly`)

Same raw ids in different namespaces remap independently.

## Fail-closed

Parse or preflight refuses:

- unknown fields
- duplicate ids
- hash or fingerprint mismatch
- dangling references
- illegal privacy claims (share-safe surfaces carrying private/owner-only
  evidence; tombstoned owner-only bodies left in place)
- dishonest withholding metadata (evidence/attachments marked private, omitted,
  or redacted while the referenced content object is present or carries
  payloadBase64)
- snapshot items whose privacyClass or contentHash do not match the exported
  evidence record before same_snapshot / fingerprint derivation
- crossed experiment/candidate/decision/gold graphs (experiment candidateIds
  must be triage-job members; helpfulness/alignment candidateIds must belong
  to that experiment; gold may reference only the accepted decision for the
  same experiment)
- missing required content (`inclusion: present` without payload) in the default
  V1 self-contained parse; archive parse may accept digest-committed detached bytes
- self or cyclic snapshot lineage
- corrupt contribution / decision / gold version chains
- identity-map ambiguity
- credential, token, secret, LDAP, or live-endpoint keys/values

## Semantic vs transport identity

`portableSemanticFingerprint` hashes the investigation graph after stripping
`exportedAt`, `bundleFingerprint`, `objectHashes`, per-object `objectHash`, and
`payloadBase64`. Two exports of the same logical investigation at different
`exportedAt` values share a semantic fingerprint. Evidence bytes are committed by
digest, byte length, and content type; inline payload is transport, not identity.

`portableBundleFingerprint` remains the V1 transport/integrity hash and **does**
change when export time or inline bytes change. SHA-256 here is integrity, not
authenticity.

## Residuals (persistence / apply / UI)

The contract slice still does **not** itself persist. Server apply V1 ships
exact reconstruction only. Remaining residuals:

- Ed25519 key management, signing, or verification (metadata is recorded, not verified)
- metadata-only / blocked apply
- interaction traces, live discussion presence, and some imported-run details
- treating a client-supplied destination catalog as authorization
  (`destinationCatalogMustRevalidate` remains true)

## What this does not prove

- Ed25519 verification or source trust (signature metadata is recorded, not verified)
- That gold is truth, or that agreement is correctness
- Destination capability probes, live gateways, or LDAP
- That a client-supplied destination catalog grants authority
