# War Room software impact v1

**Status: Local integration.** Contract, memory/SQLite service, HTTP routes, and
Situation panel exist in this tree. PostgreSQL persistence, portable-archive
inclusion, activity-kind projection, investigation tags/facets, and Help copy
are named residuals, not implied behavior.

## The question

A triage engineer often needs to say, in the investigation record, which named
software identities are in play: product, version, build, component, and
environment, each as observed, suspected, confirmed, or ruled out. Two failure
modes follow, and both are common:

1. **Invented lineage.** A tool sorts `4.2` after `4.1`, treats a date-shaped
   build id as later, or infers that confirming one build rules out another.
   Downstream conclusions then look like a release timeline that nobody
   recorded.
2. **One blob for two jobs.** A single product/version/build field on the
   investigation (situation context) cannot hold several concurrent judgments,
   and cannot say that 4.1 is ruled out while 4.2 is confirmed.

This slice records **many epistemic rows per investigation**, lists them in
**recording order only**, and treats version/build strings as **display text**.

## What this slice does

- Contract `cd-collab.software_impact.v1` with statuses
  `observed | suspected | confirmed | ruled_out`, states `active | released`,
  and list `ordering: "recorded_at"` only.
- HTTP routes under `/api/cases/:caseId/software-impact` plus
  `/api/software-impact/suggestions?field=`, gated by `investigation:read` and
  `investigation:write`.
- Suggestions drawn only from investigations the reader can already list.
- Situation-stage panel with accessible combo-boxes, free-form values, and
  status as text (not color rank).
- Memory + SQLite durability. PostgreSQL omits the store, so the panel hides
  on 404 rather than pretending the rows exist.

## What this slice does not do

- It does not compare versions or builds, and it rejects unknown fields such as
  `laterThan`.
- It does not store logs, email, chat, or notes. Those stay in Capture/Analyze.
- It does not replace entities (who/what the case is about) or sources (where
  evidence came from).
- It does not replace the one-row situation-context blob in open PR #1093.
- It does not add investigation tags, server search facets, or affected-build
  filters on the case list.

## Proof

| Claim | Evidence |
| ----- | -------- |
| Fixture parses; `laterThan` is refused | `collab/contracts/src/investigation-software-impact.test.ts` |
| Recording order; duplicate identity; suggestion isolation | `collab/server/src/modules/software-impact/service.test.ts` |
| HTTP gates, 409 duplicate, 404 other-case | `collab/server/src/investigation-record.test.ts`, `investigation-record.adversarial.test.ts` |
| SQLite reopen keeps recording order | `collab/server/src/db/sqlite-investigation-record.test.ts` |
| Combo-box + free-form; viewers read-only; 404 hides panel | `collab/web/src/SoftwareImpact.test.tsx` |

## Residuals

- No PostgreSQL table or migration 021 (avoids racing #1093/#1088 for 020).
- Timeline kinds `software_impact_recorded|updated|released` are stored, but
  the activity projection does not yet name them, so Overview will not show a
  dedicated software-impact row.
- Portable investigation archives do not yet include impact records.
- Help Center has no article for this panel (`HelpCenter.tsx` is contended by
  other open lanes).
