# ADR 0003: Chat bridges + permission-authority pattern

**Status:** Accepted; Telegram server bridge implemented by #289
**Date:** 2026-07-18  
**Issue:** #278 (epic #276)  
**Implementation epic:** #289 (spawned)

## Context

`cd-server` already streams `cd.v1` SSE events and has a permission round-trip (#168). Chat channels (Slack/Telegram/Teams) are untrusted input surfaces. AGENTS.md: SoftWrite/HardWrite require **UI-originated** human confirmation — a chat "yes" is model-adjacent text, not a grant.

Memory tools write through `ToolHost::execute` + `PermissionRequest`; HardWrite `mem://` never session-auto (#270).

## Decision

**Chat is an input/notification surface; the desktop (or a trusted paired approver) remains HardWrite approval authority.**

1. Chat adapter → `cd-server` turn → tools may **propose** SoftWrite/HardWrite.
2. Server parks the pending `PermissionRequest` and notifies the paired desktop (or admin approver channel with type-to-confirm for SoftWrite only when explicitly configured).
3. **HardWrite never completes from chat alone** — desktop UI AllowOnce (and type-to-confirm phrase) is required.
4. SoftWrite may optionally be approved on a **paired** trusted device session, never from an arbitrary chat message string.
5. Read tools may run under server policy without desktop if the workspace policy allows.

### Seam confirmation

- `MemoryStore` + reserved sync columns remain the data seam.
- Permission authority reuses `permissions.rs` + #168 round-trip; chat adapters must not call `complete_permission` with forged request IDs from channel text.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| Chat message "approve" as grant | Breaks UI-originated invariant; spoofable |
| All writes blocked on chat | Too weak for product; SoftWrite can still be useful with paired device |
| Server auto-AllowSession for chat users | Elevates untrusted surface to session path grants |

## Effort estimate

**M–L** — one bridge (Telegram recommended first): adapter, pair desktop, permission notify, E2E tests. ~1.5–2 weeks for first bridge; +1 week each additional.

## Implementation epic

**#289** — children: pairing protocol, Telegram adapter, permission notify path, SoftWrite policy flag.
