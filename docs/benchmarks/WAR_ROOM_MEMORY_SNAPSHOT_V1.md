# War-room memory snapshot v1

Status: isolated `cd-collab.snapshot.v1` contract on the current war-room
lander shape. Not a live-provider, gateway, gold-answer, or runtime-wiring
claim.

This slice fail-closed-parses a **frozen evidence snapshot** that names
exactly which evidence identities a later model or strategy lane could have
received. It does **not** add server freeze behavior, package-index export,
case-board derivation, or UI.

## Contract

Schema ID: `cd-collab.snapshot.v1`. Documents are `status: frozen`. The public
fields are the lander consumer API:

- `id`, `caseId`, `parentSnapshotId`
- `evidence[]` (`evidenceId`, `ordinal`, `contentHash` or honest `null`,
  `expectedHash` or honest `null`, `verificationStatus`, `privacyClass`)
- `visibility` (`owner_only` or `share_safe`)
- `protocolVersion`
- `fairnessClass` (`same_snapshot` or `unknown`)
- `fingerprint` (canonical SHA-256 hex of the evidence set)
- `createdAt`, `createdBy`

Identity is SHA-256 of canonical JSON over `parentSnapshotId`, evidence items
**sorted by `evidenceId`** (including ordinal), `visibility`, and
`protocolVersion`. Supplied `evidence[]` order is preserved on parse. Hashing
always sorts. Changing ordinals, visibility, parent, protocol, or hashes
changes the fingerprint.

A parent may be named; it must not be the snapshot itself. Empty evidence
sets are representable (the lander freeze path may emit them). Present
evidence IDs must be nonempty and unique. `share_safe` visibility may not
include `owner_only` items. Unknown fields, malformed hashes, invalid
timestamps, empty protocol values, duplicate ordinals, and mismatched
fingerprints fail closed.

`fairnessClass` `same_snapshot` is a document claim that inputs are
comparable. When an item has neither `contentHash` nor `expectedHash`,
`snapshotFairness` reports `unknown` — missing hashes stay unknown and are
not invented. The lander freeze path currently records `same_snapshot`; parse
accepts both enum values and does not rewrite stored documents.

## Honesty

- Unknown stays unknown. Missing hashes stay `null`.
- Equal snapshots establish **comparable evidence inputs**, not correct model
  outputs.
- Agreement is not correctness.
- A gold benchmark is a human reference, not truth.
- No provider calls, credentials, HTTP, persistence, or UI in this slice.

## Not in this slice

Package-index export, server freeze/persistence changes, case-board
derivation, and UI wiring remain future work. This document describes only
the isolated contract on the established lander shape.
