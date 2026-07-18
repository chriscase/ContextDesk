# ADR 0006: S3-compatible object storage for workspace files

**Status:** Accepted (design only)  
**Date:** 2026-07-18  
**Issue:** #281 (epic #276)  
**Implementation epic:** #292 (spawned)

## Context

No object storage today. Index abstracts chunks; owner may want cloud files as backup and/or indexed source.

## Decision

**Phase A: optional backup/export to S3-compatible storage. Phase B: optional index source connector.**

- Abstraction: `ObjectStore` trait (put/get/list) with AWS SDK or `rust-s3` behind feature flag.
- Credentials: keychain only; endpoint/bucket in AppConfig (no secrets).
- SSRF: custom endpoints validated (no link-local metadata).
- Not a replacement for local workspace roots in v1.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| S3 as only workspace | Breaks offline-first / default cargo tests |
| Embed provider SDKs in desktop webview | Secrets/IPC risk |

## Effort estimate

**M** — backup path ~1 week; index source +1 week.

## Implementation epic

**#292**