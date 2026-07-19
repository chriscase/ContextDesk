# ADR 0007: Composition preview pane

**Status:** Accepted — implemented (Compose tab, 2026-07-19)  
**Date:** 2026-07-18  
**Issue:** #282 (epic #276)  
**Implementation epic:** #293

## Context

`SourcePreviewPane` and editable `MemoryPane` exist. Vision: first-class composition workspace — draft with agent, iterate, hand-edit.

## Decision

**Extend MemoryPane + a Composition tab that binds to a durable memory id or workspace file path.**

- Targets: memory record (primary, #264 store), workspace file, scratch buffer; outgoing chat message later (ADR 0003).
- Agent proposes via SoftWrite tools; Accept applies; user can edit freely in the pane (local draft) without tool rounds.
- Redaction preview on Accept for memory saves (#274).
- No separate document DB — reuse `MemoryStore` / files.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| New collaborative OT/CRDT editor | Out of scope; Complexity high |
| Agent-only drafting without hand edit | Fails the stated UX |

## Effort estimate

**S–M** — ~1 week reusing MemoryPane + SoftWrite modal.

## Implementation epic

**#293**