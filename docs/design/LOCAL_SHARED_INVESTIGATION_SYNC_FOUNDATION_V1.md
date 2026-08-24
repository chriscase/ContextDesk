# Local/shared investigation synchronization foundation V1

Status: contract and dry-run planning foundation only. This design does not implement networking, persistence, authorization, background synchronization, or automatic conflict resolution.

## Purpose

ContextDesk can run a local War Room with SQLite or a shared War Room with PostgreSQL. A future synchronization feature needs a deterministic, auditable way to describe changes without turning portable restore into a permissive merge protocol. V1 therefore defines an append-only operation batch and a fail-closed dry-run planner. Exact portable restore remains a separate contract and is not weakened.

## Contract boundary

`collab/contracts/src/investigation-sync.ts` provides:

- `attachInvestigationSyncIntegrity` to build a hash-chained batch from host-authored operations;
- `parseInvestigationSyncBatch` to reject unknown fields, broken chains, noncanonical payloads, invalid revisions, and forbidden authority or credential material;
- `canonicalizeInvestigationSyncBatch` plus operation and batch SHA-256 fingerprints;
- `parseInvestigationSyncDestinationState` for a host-supplied destination projection; and
- `planInvestigationSync` for deterministic, atomic, dry-run conflict reporting.

The JSON schema describes the transport batch. The TypeScript parser is authoritative for cross-field rules that JSON Schema cannot express.

## Append-only identity and cursor

Every operation carries (with sequence scoped to one source installation and one investigation stream):

- an opaque `syncop-*` operation id;
- an opaque `inst-*` source installation id;
- a contiguous source sequence;
- the previous operation fingerprint;
- a timestamp and investigation id;
- attribution to an opaque source actor plus display label and actor kind; and
- its own fingerprint over canonical operation bytes.

`fromCursor` identifies the chain position before the batch. `toCursor` must identify the exact final operation. A destination checkpoint tracks one source installation. A mismatched cursor blocks the batch. An exact replay of already recorded operation ids and fingerprints is an idempotent no-op.

## Object CAS and tombstones

Each mutation names a portable object kind and object id and records:

- `baseRevision` and `baseHash` expected at the destination;
- `resultRevision`, which must equal `baseRevision + 1`;
- `resultHash` over the complete canonical object envelope, including source installation, investigation, object kind/id, revision, privacy class, tombstone state, and payload or tombstone-reason digest;
- privacy class; and
- either canonical object `payloadJson` or a tombstone reason.

The planner namespaces source object identity by source installation and simulates the whole ordered batch. Missing objects, pre-existing creates, revision mismatches, base-hash mismatches, owner-only to share-safe widening, and resurrection of tombstoned objects block the entire plan. V1 never performs a partial apply and never chooses a winner. A future persistence layer must retain a stable source-object to destination-object mapping; V1 does not invent destination ids.

## Deterministic conflict report

Conflicts are sorted by source sequence, code, object kind, and object id. Codes cover source loops, cursor mismatch, operation-id or source-sequence collisions, partial replay, object existence, revision/hash disagreement, destination privacy policy, privacy widening, and forbidden resurrection. On any conflict, `checkpointAfter` equals `checkpointBefore` and every operation is marked blocked. The report fingerprints both the canonical destination projection and the complete dry-run plan.

## Authority and privacy boundary

The payload scanner rejects credential material and fields representing authentication, membership, roles, capabilities, permissions, or grants. Actor attribution is historical context only. It does not create a destination account or authority.

Every plan states:

- `applyAuthorized: false`;
- no networking or automatic sync;
- no credential transfer;
- no membership, role, or capability grants; and
- the exact required exclusions.

The destination projection is host-authored state for conflict analysis, not proof of authorization. Its checkpoint must bind the exact operation id and fingerprint at the recorded source sequence, and it explicitly lists the privacy classes the destination accepts.

## Relationship to portable restore

Portable investigation restore reconstructs a supported archive exactly or blocks. Sync V1 does not reinterpret an incomplete archive, fill missing bytes, remap authority, or relax restore validation. Future persistence code may use portable object semantics, but it must independently authorize the caller and transact operation recording, object CAS, evidence bytes, audit, and checkpoint advancement.

## Validation and adversarial coverage

The synthetic tests cover canonical fingerprints, append-only chaining, two-step object updates, exact replay, tombstones, unknown fields, authority and credential payloads, noncanonical JSON, chain and batch tampering, stale cursors, operation and sequence collisions, revision/hash conflicts, privacy widening, and source-loop refusal.

All test identities and observations are fictional. No provider, credential, network, database, filesystem corpus, or production data is used.

## Residual work

V1 intentionally leaves out:

- transport, peer discovery, retries, scheduling, and background sync;
- SQLite/PostgreSQL operation journals and transactional apply;
- destination authorization and policy evaluation;
- evidence-blob transfer and retention policy;
- destination-id mapping, explicit tombstone restoration, or conflict resolution workflows;
- multi-source vector checkpoints and compaction; and
- UI for review, conflict resolution, status, or administration.

Those slices must preserve this contract's append-only identity, deterministic conflicts, privacy boundary, and fail-closed CAS behavior.
