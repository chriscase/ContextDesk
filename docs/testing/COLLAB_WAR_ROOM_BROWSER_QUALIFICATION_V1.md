# Collab war-room browser qualification v1

Status: **qualification of the current local integration branch**
`codex/merge-consolidation-demo`. This is a Playwright
smoke/regression suite for the shipped collab web shell and its test bridge,
not a provider-quality claim.

## What was actually on the branch

The current branch includes the case board, content-addressed evidence and
snapshot freeze, bounded synthetic/configured-gateway comparison lanes,
progress and terminal states, external chat import, Experiment Lab comparison,
helpfulness/gold/accepted-decision flow, and share-safe export. Production boot
uses LDAP; the fixture uses the test-only `MapAuthAdapter` and in-memory stores.

The browser suite has two intentionally separate paths:

- the default job runs the provider-free synthetic fixture;
- the bridge job sets `COLLAB_E2E_BRIDGE=1` and runs
  `specs/10-bridge-comparison.spec.ts`, which verifies the UI-selected profiles,
  concurrency bound, same-snapshot result, progress, and Experiment Lab handoff
  through the bridge process.

Neither path contacts a real model provider or requires credentials.

Wait on **`GET /health`**, not `/ready`. The fixture server uses in-memory
stores and `pool: null`, so `/ready` stays `503` (`database: down`). That is
honest, not a product bug in this harness.

## Commands

Default path (no LDAP, no Postgres, no real credentials):

```bash
cd collab
npm ci
npx playwright install --with-deps chromium   # once per machine
npm run e2e
```

Equivalent pieces:

```bash
npm run build -w @cd-collab/contracts
npm run build -w @cd-collab/web
npm run typecheck -w @cd-collab/e2e
npm run test -w @cd-collab/e2e
```

The Playwright config starts `collab/e2e/src/serve-fixture.ts`, which wires the
**existing** `MapAuthAdapter` + memory case/catalog/import/export stores and
serves `collab/web/dist`. Fixture passwords are the same `fixture-*-secret`
values already used by collab HTTP tests.

| Identity | Role | Notes |
| --- | --- | --- |
| `alice` | contributor | Create case, owner_only export |
| `carol` | viewer | Read; mutation controls are hidden |
| `dave` | admin | Catalog, share_safe export, status |
| `erin` | case-lead | Mapped; unused by the default specs |
| `bob` | unmapped | Login denied |

## Coverage vs requested demo

| Requested | Suite behavior |
| --- | --- |
| Local-auth demo login | Adapted: fixture `MapAuthAdapter` through the real login form. Production remains LDAP-backed; invented `/api/auth/local` returns 404. |
| Create/open a case | Automated. |
| Upload and freeze evidence | Automated through the Case Board panel; spec 03 drives the file picker, summary, privacy class, upload POST, and snapshot freeze into a same-snapshot run input. |
| Two or more comparison lanes | Automated in the bridge job with three selected fixture profiles and concurrency 2. The default job covers synthetic/offline mode. |
| running / partial / failed / cancelled / completed | Automated through run history and lane cards; the fixture proves completed progress and the server tests cover partial/failure/cancellation/deadline retention. |
| Import plain-text chat | Automated with `fixtures/chats/*.txt`. |
| Shared/unique, similarities, disagreements, question paths | Automated through Experiment Lab and the case board, including the explicit agreement-is-not-proof caveat. |
| Helpfulness / accepted decision | Automated through Experiment Lab component coverage and server/contract tests. |
| Share-safe export | Automated, including planted-credential fail-closed; timeline composer exposes private/share-safe contribution visibility with a private default. |
| Reload / restart persistence | Reload automated. Process restart remains opt-in and requires a Postgres-backed deployment. |
| Responsive / basic a11y | Automated at 375px; case composer controls have accessible names and keyboard-visible focus states; login controls are labeled. |

Source of truth: `collab/e2e/src/surface-map.ts`.

## Manual checkpoints (not claimed green by default)

1. **Process restart** — `npm start` against Postgres + LDAP (or a durable
   session store), create a case, kill the process, start again, confirm the
   case and cookie policy. Set `COLLAB_E2E_RESTART_BASE_URL` to automate health
   only; full UI restart still needs a durable backend.
2. **Live LDAP login** — copy `collab/e2e/fixtures/live-profile.example.json`
   **outside git**, set `COLLAB_E2E_LIVE_PROFILE` and `COLLAB_E2E_LIVE_PASSWORD`,
   then `COLLAB_E2E_START_FIXTURE=0 COLLAB_E2E_BASE_URL=… npm run test -w @cd-collab/e2e -- specs/09-live-profile.spec.ts`.
   Review screenshots before sharing; the suite redacts password/username from
   captured console text only.
3. **Live provider matrix** — create a private share-safe catalog containing
   every requested alias, including Vercel only after fresh model discovery.
   Use per-profile protected-file or keychain references; never use one global
   provider key for a mixed employer/Vercel run. Run the live qualification CLI
   only with explicit `--live --yes` authorization.
4. **PostgreSQL + LDAP browser run** — the fixture proves the UI/bridge seam;
   the hosted collab job proves database/auth integration separately. A durable
   restart requires a real deployment rather than the fixture.

Composer `importRun` / `addNote` / catalog `createSource` capture
`event.currentTarget` before `await fetch` (same pattern as `LoginForm`). React
nulls `currentTarget` after the handler yields, which previously swallowed a
successful POST and skipped `loadTimeline` / `reset`.

## Remaining product work

- Timeline rows now show the current non-tombstoned contribution body and target
  identifier; historical revision-specific body rendering remains a future
  refinement.
- The case import dropdown refreshes after catalog add/retire events, and stale
  catalog writes surface a bounded generic permission alert.
- Create case / Import / Add to timeline are now hidden for viewers. If a stale
  client still attempts a case write, the UI now surfaces a bounded generic
  permission alert rather than silently ignoring the response.
- Add incremental per-lane progress to the durable Postgres-backed UI path.
- Add a first-class live profile/catalog setup flow so operators do not need to
  prepare a private file by hand.
- Add live-provider result review with explicit cost/usage fields when a host
  can observe them; unknown must remain the default.

## Opt-in live profile

Default CI does **not** set `COLLAB_E2E_LIVE_PROFILE`. The example JSON contains
no secrets. Passwords stay in the environment. Do not commit filled profiles.

## Handbook impact

The bridge browser job and strict request-shape fixture are provider-free. The
live qualification completion gate now fails when a requested alias is skipped
or same-snapshot proof is absent. No engine, permission, credential, or
provider-lifecycle change is made by the browser harness.
