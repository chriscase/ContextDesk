# Whole-turn deadline controls

**Status:** product controls on branch `feat/deadline-controls-v1` (not a claim
of `main` until merged). Adaptive *latency learning* is **out of scope**.

## What users control

The **whole-turn deadline** is the maximum wall-clock time for one chat turn.
ContextDesk may finish sooner. Multi-stage phase caps and synthesis reserves
still draw down this one monotonic clock; this work does not retune those
internals.

## Precedence

```
per-turn CLI override  (--deadline on chat / direct question)
        >
saved explicit policy  (Settings Custom/Standard/Patient, or `config deadline set`)
        >
adaptive policy        (`config deadline auto` / Settings Auto)
```

- A per-turn override never writes `AppConfig`.
- The next turn without an override reloads the saved policy.
- Auto must not be silently converted into an explicit numeric ceiling.

## Shared module

`cd_core::deadline_controls` owns:

- duration parse/format (`500ms` / `90s` / `3m` / `10m`);
- reject (no silent clamp) outside 500ms–600_000ms;
- Auto / Standard (180s) / Patient (300s) / Custom conversion into
  `RouterBudget::{deadline_ms, deadline_is_explicit}`;
- safe `DeadlineStatus` JSON (`contextdesk.deadline.v1`) with no profiles,
  endpoints, models, paths, or secrets.

CLI and desktop both call this module (desktop also mirrors the parse grammar
in TypeScript for inline validation; the Rust host remains authoritative on
save).

## Surfaces

| Surface | Behavior |
| --- | --- |
| Settings → General | Auto / Standard / Patient / Custom; custom uses friendly durations |
| `config deadline show\|auto\|set` | Read/write only the two router deadline fields |
| `chat --deadline` / direct `--deadline` | One-turn explicit override |

## Non-goals

- Automatic learning of latency preferences
- Per-phase timer flags in the product UI
- Provider transport / retry / chat.rs changes
- Expert-only timer matrices
