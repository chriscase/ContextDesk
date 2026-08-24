# Overview operational signals v1

Status: **local integration** on an isolated child of the Investigation Team
operational branch. This is a server/contract slice only. It does not claim a
frontend consumer, a ranking, model quality, progress, completeness, or a live
corpus.

Schema ID: `cd-collab.overview.v1`. Route: `GET /api/overview`. Authorization
matches `GET /api/cases`: an authenticated reader receives only cases they can
already list (`listCases` membership, or admin).

## What the snapshot records

The document is a bounded orientation snapshot, not an inventory and not a
health badge.

- `generatedAt` and the viewer's recorded identity/roles
- recorded status counts and current-severity counts over visible cases
- at most 12 open or monitoring cases
- at most 20 recent activity rows: `caseId`, `title`, `kind`, `actor`,
  `serverTime`, `seq` — never a timeline payload, contribution body, artifact
  bytes, internal endpoint, or model output
- at most 20 queued/running jobs and 20 recent terminal jobs, with recorded
  status, case, strategy id, strategy version only when stored, timestamps, and
  the job's own `sameSnapshot` value
- presence with explicit `available`, `reason`, and `ttlSeconds`; at most 20
  members, only for visible cases, ordered by last-seen time then identity
- at most 20 attention items from two recorded predicates:
  1. a still-open proposed decision the current lead or admin can accept and
     did not author
  2. the current actor's own still-open proposal

Empty attention is not health. Viewer attention is empty. Blocked, stale, and
assigned-to-me states are not invented.

## Honesty

- Recorded counts are not progress or completeness.
- Overview is not the full investigation inventory.
- Presence is ephemeral and is not evidence. The static synthetic fallback
  snapshots this exact GET and, because frozen members would be dishonest,
  returns `available: false` with `reason: static_snapshot`.
- Agreement is not proof of correctness. Cost and usage stay absent unless a
  later recorded observation exists; this slice never invents an amount.
- `sameSnapshot` keeps its existing meaning. A child job on new evidence is
  not labeled the same as its parent.
- The server does not load the complete case/participant inventory or pass an
  unbounded visible-id list. Counts and open cases are aggregated/fetched with
  membership inside the query. Downstream joins (timeline, jobs, proposals,
  presence) enforce actor/admin visibility themselves and apply `LIMIT`.

## Not in this slice

Collab web, desktop, Rust, README, existing screenshots, and a UI that consumes
`GET /api/overview` remain later work. Fixtures and demo data are fully
synthetic.
