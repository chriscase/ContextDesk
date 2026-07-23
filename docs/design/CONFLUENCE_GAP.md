# Confluence epic #326 — gap audit vs main

**Date:** 2026-07-23  
**Main tip at audit:** post-#398 launch surface  
**Contract:** [`CONFLUENCE_HARVEST_MEMORY_TRANSFORM.md`](./CONFLUENCE_HARVEST_MEMORY_TRANSFORM.md)

## Summary

| Design PR | Intent | Status | Anchors | Tests | Residual |
|-----------|--------|--------|---------|-------|----------|
| **1** RO maneuver | tree/children/ancestors/attachments | **Shipped** | `confluence_ro.rs`; tools `confluence_*`; `tool_host` | host Confluence tool tests (offline stubs where present) | Live corp optional |
| **2** SourceRef + harvest schema | provenance SoT | **Shipped** | `harvest/types.rs` SourceRef, SyncStatus, HarvestRecord; `store.rs` | store + types unit tests | — |
| **3** SoftWrite harvest → memory | dual-write memory+harvest | **Shipped** | `harvest/apply.rs` `harvest_page_to_memory`; tool `harvest_from_source` | apply unit tests | UI-originated harvest path |
| **4** file destination + converters | harvest → workspace markdown | **Shipped** (this goal) | `harvest_page_to_file`; destination=file | apply file unit test | richer markdown converter polish residual |
| **5** check/apply sync + supersede hooks | re-sync tools | **Shipped** (this goal) | `harvest/sync.rs`; tools; supersede/retract hooks in tool_host | sync offline tests | live check still needs network |
| **6** Harvest Browser + conflict + citation | desktop | **Shipped** (this goal) | `HarvestPane.tsx`; `list_harvests` | tsc | Check/Apply via agent tools not one-click in-pane SoftWrite (document residual) |
| **7** Confluence write core | HardWrite create/update | **Shipped** (this goal) | `create_page`/`update_page`; tools gated by write_enabled | write tools gated unit test | live HTTP #[ignore] not added |
| **8** Desktop Publish | type-to-confirm WRITE UI | **Partial** | write_enabled Settings toggle; Harvest pane docs | — | Dedicated Publish modal residual — use agent tools after enable |
| **9** Polish + CLAIMS | honesty | **Shipped** (this goal) | CLAIMS + README | check_claims | epic #326 may stay open for PR8 residual |

## Already solid (do not rewrite)

- RO tool suite + throttle + space policy  
- Harvest store co-located with memory DB  
- SoftWrite harvest AllowOnce path + allowlist required for harvest  
- Pure `classify_sync` offline  

## Implementation order (this goal)

1. PR4 residual — `harvest_page_to_file` + parse destination=file  
2. PR5 — wire `check_source_sync` (Read) + `apply_source_sync` (SoftWrite); call harvest hooks on memory supersede/retract when store path known  
3. PR6 — Harvest Browser pane (list harvest rows, check/apply, open URL)  
4. PR7 — create/update page HardWrite + WRITE confirm + write_enabled gate  
5. PR8 — minimal Publish from memory harvest  
6. PR9 — CLAIMS/README  

## Non-goals

- JIRA (#280)  
- Auto background sync  
- SoftWrite remote mutations  
