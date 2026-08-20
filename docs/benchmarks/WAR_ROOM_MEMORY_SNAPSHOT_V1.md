# War-room memory snapshot v1

Status: hermetic in-memory collab contract and service seam. Not a live-provider,
gateway, or gold-answer claim.

This slice freezes a **case evidence snapshot** (`cd-collab.snapshot.v1`) and
derives an owner-only **case board** (`cd-collab.case_board.v1`) from existing
collab artifacts, contributions, Experiment Lab review data, and imported runs
when those seams are present. It does not duplicate bench schemas, start jobs,
or add UI.

## Snapshot freeze

A snapshot is insert-only. Identity is the content fingerprint `snap-` plus the
SHA-256 of canonical JSON over:

- `caseId`
- `parentSnapshotId` (lineage; same items with a different parent are a different snapshot)
- evidence items **sorted by `evidenceId`**: identity, content hash or `null`, visibility, privacy class
- visibility policy (`includeSummaries`, `includeRawBytes`)
- protocol id/version when known

Selection order is preserved on `items[]`. Hashing always sorts. Held artifacts
use `contentHash`; hashed file-server refs use `expectedHash` so they can still
be `same_snapshot`. A visible item without a hash is `unknown_visibility`.
`extra_evidence` is a run fairness class and is not stored on snapshots.

v1 inserts are `frozen`. Do not mutate a parent; freeze a child with
`parentSnapshotId`. Repeating the same case+fingerprint is idempotent.

## Case board

The board is **derived**, not stored as truth. It is `owner_only` and must not
be share-safe exported as-is.

| Bucket | Meaning |
| --- | --- |
| `known` | Supported hypotheses and corroborated imports |
| `unknown` | Proposed hypotheses, incomplete evidence/traces, unverified imports |
| `agreed` | Shared experiment agreement only — not correctness |
| `disputed` | Contradicted hypotheses and role conflicts. Candidate-specific evidence is not disputed. |
| `newlyConcluded` | Accepted decisions that are not the current gold promotion |

Gold stays a separate `{ status, version, goldId }` field. Missing gold is
`unknown`. Do not invent gold text as known findings. Agreement is not proof of
correctness.

## Honesty

- Unknown stays unknown.
- Do not treat agreement as correctness.
- A gold reference is a human benchmark, not case truth.
- No provider calls or credentials.
- The Experiment Lab presenter demo is unchanged; this module is not wired into HTTP or `npm run demo`.
