# War Room portable investigation contract v1

Status: **contract only**. This document specifies a fail-closed JSON contract for
exporting and reconstructing **one** complete investigation on another
ContextDesk installation. It does **not** claim persistence, UI, storage,
network transport, or import apply wiring. No live provider calls. No invented
gold, cost, or usage.

Shipped module: `collab/contracts/src/investigation-portable.ts`
Schema: `collab/contracts/schemas/investigation-portable.v1.json`

The package barrel (`collab/contracts/src/index.ts`) re-exports this module.
Consumers import `@cd-collab/contracts`.

Apply-readiness hardening lives in `collab/contracts/src/investigation-portable-archive.ts`
(schema `investigation-portable-archive.v1.json`). That layer is still **contract +
dry-run only**: no archive I/O, signing implementation, persistence apply,
authorization route, or UI.

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
- deterministic ID remapping: `${sourceInstallationId}::${namespace}::${rawId}`
  or `remap-<digest>` when the collision policy remaps
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

## What this does not prove

- A running importer, database apply, archive I/O, or War Room UI
- Ed25519 verification or source trust (signature metadata is recorded, not verified)
- That gold is truth, or that agreement is correctness
- Destination capability probes, live gateways, or LDAP
- Persistence of remapped ids after a real apply (apply is not shipped)
- That a client-supplied destination catalog grants authority
