# ADR 0006: S3-compatible object storage for workspace files

**Status:** Accepted; Phase A foundation and transport implemented
**Date:** 2026-07-18  
**Issue:** #281 (epic #276)  
**Implementation epic:** #292 (spawned)

## Context

No object storage today. Index abstracts chunks; owner may want cloud files as backup and/or indexed source.

## Decision

**Phase A: optional backup/export to S3-compatible storage. Phase B: optional index source connector.**

- Abstraction: ContextDesk's `ObjectStore` trait (put/get/head/list) with Apache
  `object_store` 0.14.1 behind the off-by-default `s3-object-store` feature.
- Credentials: keychain only; endpoint/bucket in AppConfig (no secrets).
- SSRF: custom endpoints are validated when saved and immediately before use,
  then DNS-pinned. Redirects, userinfo, link-local, and metadata destinations
  are rejected. Private-network endpoints require explicit opt-in; plain HTTP
  is limited to opted-in private/loopback destinations.
- Not a replacement for local workspace roots in v1.

### Dependency audit (Phase A)

Audit performed 2026-07-24 for `object_store` 0.14.1 and its `reqwest` 0.13
transport:

| Question | Result |
|---|---|
| Maintenance | Apache Software Foundation project; 0.14.1 is the current release and the project targets an approximately two-month release cycle. |
| Custom endpoints and path style | `AmazonS3Builder` supports explicit endpoints and virtual-hosted or path-style requests. ContextDesk tests the path-style request shape used by MinIO-compatible services. |
| TLS | `reqwest` uses Rustls with the platform certificate verifier. HTTPS is the normal policy; the client follows no redirects and disables ambient proxies. |
| Timeout and cancellation | Connect/request timeouts are bounded, ContextDesk operation deadlines and cancellation race every request, and cancelled multipart uploads are aborted with a bounded timeout. SDK retries are disabled so they cannot outlive the caller's operation policy. |
| Response bounds | Object downloads remain streaming. Buffered S3 control-plane XML is capped at 4 MiB. Non-success response bodies are discarded by the custom connector without being polled and replaced with a fixed scrubbed marker before the SDK sees them. |
| Credentials | Only explicit, short-lived runtime credentials are supplied to `AmazonS3Builder::new`. ContextDesk never calls `from_env` or enables an SDK default credential chain. Credential values are non-serializable and redacted from diagnostics. |
| Compile footprint and MSRV | The feature adds 20 normal dependency nodes to `cd-core` on the audited lockfile. It is absent from default builds. `object_store` 0.14.1 declares Rust 1.85; this is below the workspace toolchain. |
| Defaults | `object_store` default features are disabled (avoiding its local-filesystem backend). Only `aws-base`, `reqwest`, and `ring` are enabled. No request occurs at construction or in default tests. |

The hermetic fixture proves AWS Signature V4 headers, custom endpoint
path-style upload/get/head/list behavior, pagination, timeouts, cancellation,
typed authorization/not-found errors, and scrubbed server failures. It does
not establish compatibility with every AWS S3 API or every S3-compatible
vendor.

References: [Apache object_store project](https://github.com/apache/arrow-rs-object-store),
[object_store 0.14.1 documentation](https://docs.rs/object_store/0.14.1/object_store/),
and [`AmazonS3Builder` API](https://docs.rs/object_store/0.14.1/object_store/aws/struct.AmazonS3Builder.html).

Phase A remains explicitly user-triggered backup/export. Local workspace roots
remain authoritative. Restore, remote deletion, bidirectional sync, and the
Phase B S3 index source are out of scope and remain unimplemented.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| S3 as only workspace | Breaks offline-first / default cargo tests |
| Embed provider SDKs in desktop webview | Secrets/IPC risk |

## Effort estimate

**M** — backup path ~1 week; index source +1 week.

## Implementation epic

**#292**
