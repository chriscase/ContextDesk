# ADR 0004: Watchers / triggers engine

**Status:** Accepted (design only)  
**Date:** 2026-07-18  
**Issue:** #279 (epic #276)  
**Implementation epic:** #290 (spawned)

## Context

No scheduler today; news/RSS is on-demand. Vision: periodic watches that notify or propose actions (e.g. Telegram notify, surface to user).

## Decision

**Run watchers on `cd-server` (always-on); desktop authors and lists them.**

- Model: `watch → condition → action` rows in server SQLite/Postgres later.
- Actions: notify (chat bridge), enqueue SoftWrite proposal, SearchTrail-style UI event — **never silent HardWrite**.
- Interval min 5m; jitter; per-workspace enable.
- Conditions are hermetic predicates + optional embed score; network fetch goes through SSRF gates.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| Desktop-only cron | Unreliable when app closed |
| Full workflow engine (Temporal-like) | Overkill for v1 |

## Effort estimate

**M** — ~1–1.5 weeks for MVP notify-only watchers.

## Implementation epic

**#290**