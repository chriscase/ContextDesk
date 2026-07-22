# ADR 0002: Server-authoritative sync for shared workspace context

**Status:** Accepted; server half implemented, client worker pending
**Date:** 2026-07-18  
**Issue:** #277 (epic #276)  
**Implementation epic:** #287 (spawned)

## Context

Desktop is the primary brain; `cd-server` is a local fallback for research HTTP and already has per-workspace shared memory JSONL, roles, audit, and permission round-trip (#167/#168). Multiple installs need one shared context without peer CRDTs.

Memory Phase-1 reserved sync columns: `rev`, `updated_at`, `origin_node`, plus `MemoryStore::changes_since` (personal scope structurally excluded).

## Decision

**Server-authoritative sync with local SQLite cache and offline queue.**

- Workspace-scope durable memory and future shared KB metadata live on `cd-server` as source of truth.
- Clients open a local `SqliteMemoryStore` cache, pull via `changes_since(cursor)`, push accepted writes through the server API.
- Personal-scope memory **never** leaves the device (facade already bars it from `changes_since`).
- Conflict policy: LWW on `updated_at` with `rev` tie-break; supersession chains preserved (never delete content).
- Seam: existing `MemoryStore` trait + reserved columns — **confirmed correct**; do not invent a parallel sync protocol for v1.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| Full peer-sync / CRDT | High complexity; no product need for multi-writer offline merge yet |
| Desktop-authoritative + occasional dump | Breaks multi-client consistency; server already holds team memory |
| Postgres-only memory without SQLite cache | Violates embedded-first / offline default tests |

## Permission & privacy

- Server requires admin for workspace-visibility writes (reuse `Role`).
- Sync tokens in OS keychain only; never over webview IPC.
- Personal store path remains OS app-data, never uploaded.

## Effort estimate

**L** — ~3–5 PRs: sync API + cursor protocol, client pull/push, conflict tests, server MemoryNote upgrade. ~2–3 engineer-weeks.

## Implementation epic

See **#287** (children: protocol + cursor, client sync worker, server apply/reconcile, personal-bar tests).

The server half now uses one authoritative SQLite memory store per configured
workspace and exposes membership, cursor pull, and admin-only mutation apply under
`/v1/sync/*`. It also routes server research/session memory tools through that same
store, imports the older JSONL notes idempotently, and keeps the JSONL wire as a
compatibility mirror.

The remaining #287 work is intentionally client-side: keychain-backed server
credentials, a desktop local-cache pull/push worker, an offline mutation queue, and
client reconciliation/UI state. Until that worker lands, the desktop does not claim
automatic multi-install sync.
