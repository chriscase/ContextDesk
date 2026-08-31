---
id: war-room-deployment
title: Run War Room locally or as a shared service
summary: Understand the browser-service boundary, local and shared storage shapes, optional model bridge, and explicit desktop or CLI handoff.
section: war-room
tags:
  - war-room
  - deployment
  - local-first
  - collaboration
  - desktop
  - cli
order: 30
related:
  - war-room-workflow
  - war-room-evidence-review
  - war-room-ldap-directory
  - war-room-s3-evidence-store
  - security-boundaries
---

# Run War Room locally or as a shared service

War Room is a browser application served by the separate ContextDesk
collaboration service. The service remains authoritative for identity,
permissions, provenance, audit, and accepted investigation state whether it
runs on one workstation or behind shared infrastructure.

![Authorized browsers use the War Room service, while desktop and CLI evidence enter through explicit handoff and model calls use an optional host-owned bridge](../assets/war-room-product-topology.svg)

## Deployment shapes

| Shape | Shipped configuration | Important boundary |
| --- | --- | --- |
| Private local | Loopback service, SQLite, local authentication, and filesystem evidence storage | Single node; no PostgreSQL role separation or multi-worker high availability |
| Shared | Operator-deployed service with PostgreSQL, filesystem or S3-compatible evidence storage, and encrypted LDAP-capable sign-in | The operator must configure and qualify database, byte storage, TLS, directory access, ingress, and backups |
| Synthetic demo | Loopback-only fixture with temporary evidence and no PostgreSQL, LDAP, or provider call | Demonstration behavior is not production qualification |

The browser is a client in every shape. Local deployment does not remove the
browser/service trust boundary, and shared deployment does not make every link
public; authorization still applies.

Filesystem remains the default evidence-byte backend. A deployment may select
the shipped S3-compatible backend with the exact server-only contract in
help://war-room-s3-evidence-store. `COLLAB_EVIDENCE_ROOT` remains local
server-owned control state in either mode. Selecting S3 does not migrate bytes
already stored on the filesystem.

## Optional model bridge

A deployment can configure a host-owned bridge for gateway-backed analysis
lanes. The bridge owns provider endpoints and credentials and accepts bounded
snapshot work from the War Room service. Without it, gateway execution is
unavailable and the interface should say so; synthetic offline demonstration
lanes remain a separate path.

The bridge is not a general desktop remote-control channel. It does not expose
provider secrets to browser code.

## Desktop and CLI handoff

| Surface | Use it for | Handoff boundary |
| --- | --- | --- |
| ContextDesk desktop | Local Log Explorer work, governed chat, durable findings, and report assembly | Export or select authorized evidence explicitly; no automatic War Room synchronization |
| ContextDesk CLI | Offline import, normalization, exploration, validation, and reproducible automation output | Produce a reviewable artifact or selected material; the CLI is not a live browser participant |
| War Room | Shared intake, provenance, frozen snapshots, lane comparison, discussion, decisions, and case exports | Imported material keeps its source and verification state |

Automatic transfer of desktop corpora, chats, memory, or CLI state is not a
shipped claim. Review privacy and provenance before moving evidence between
surfaces.

## Current limits

- SQLite mode is single-node and has no PostgreSQL-to-SQLite migration tool.
- The service does not terminate TLS. Behind an ingress that does, declare it
  with `COLLAB_TRUST_PROXY`, or every request is attributed to the proxy: one
  user's failed sign-ins would rate-limit everyone, and audit records could
  not name an origin. Leave it unset for a loopback or directly exposed
  deployment.
- Directory-backed identity is deployment-specific and requires encrypted,
  qualified LDAP configuration. If no service bind is available, login-time
  group membership remains stable for the session; a configured service bind
  enables live membership refresh. See help://war-room-ldap-directory for the
  operator translation table. Live company-directory compatibility is not a
  shipped claim until an owner runs that directory.
- Discussion uses bounded polling, not WebSocket presence or typing signals.
- Portable investigation export, fail-closed dry-run preflight, and exact
  restore of supported fields ship. Restore refuses archives with required
  private, omitted, blocked, redacted, or metadata-only content; archive
  signatures are recorded as metadata but are not verified.
- Automatic desktop embedding and automatic desktop/CLI synchronization are
  not shipped.
- Filesystem is the default byte backend; S3-compatible storage is opt-in and
  must pass configuration preflight, startup/readiness, provider permission,
  and application write/read checks separately. A PostgreSQL-backed process
  uses a database advisory lease for evidence writes; SQLite plus S3 is a
  single-process evaluation shape and doctor warns about it. Doctor preflight
  does not contact the bucket. An S3 custom CA file replaces the default
  trust store for the S3 connection only; combine public roots and an
  internal CA in one PEM. There is no filesystem-to-S3 migration,
  retention, lifecycle, or multi-provider failover automation.

For the operating sequence, open help://war-room-workflow. For provenance,
lane, and human-decision checks, open help://war-room-evidence-review. For the
S3-compatible evidence-byte contract and qualification workflow, open
help://war-room-s3-evidence-store. Security boundaries for the desktop product
are described in help://security-boundaries.
