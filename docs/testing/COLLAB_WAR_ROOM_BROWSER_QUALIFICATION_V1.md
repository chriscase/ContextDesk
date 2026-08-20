# Collab war-room browser qualification v1

Status: **adapted to the shipped collab web shell on
`codex/merge-consolidation-v2`**. This is a Playwright smoke/regression suite,
not a new product surface.

## What was actually on the branch

The collaborative “war-room demo” on this integration branch is the separately
deployable `collab/` case-memory shell (`cd-collab`): LDAP (production) or
`MapAuthAdapter` (tests), cases/timeline, catalog, manual external-run import,
and share-safe export. Probed at HEAD `b63eb515` before this suite was added.

The following were **not** present and are **not** assumed:

- Commit `37a1579b` (not on GitHub; called out as local-only). No local-auth
  HTTP route was added to production boot.
- Open PR #935 war-room snapshot / case-board contracts (`cd-collab.snapshot.v1`,
  `cd-collab.case_board.v1`). Those files are not on this branch; freeze/board
  HTTP and UI are residual.
- Comparison lanes, SDK attempt states (running / partial / failed / cancelled /
  completed), helpfulness, accepted decision, and question-path controls.

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
| `carol` | viewer | Read; create is shown but server-denied |
| `dave` | admin | Catalog, share_safe export, status |
| `erin` | case-lead | Mapped; unused by the default specs |
| `bob` | unmapped | Login denied |

## Coverage vs requested demo

| Requested | Suite behavior |
| --- | --- |
| Local-auth demo login | Adapted: fixture `MapAuthAdapter` through the real login form. Invented `/api/auth/local` returns 404. |
| Create/open a case | Automated. |
| Upload and freeze evidence | Adapted: `POST /api/cases/:id/evidence` (no upload widget). Content-addressed hash is the freeze analog. `/api/snapshots` 404. |
| Two or more comparison lanes | Absent: 404 on `/api/lanes` / `/api/comparisons`; no launcher. Two imported chats are the closest analog. |
| running / partial / failed / cancelled / completed | Adapted: case statuses + imported-run corroboration + failed login. No SDK lane badges. |
| Import plain-text chat | Automated with `fixtures/chats/*.txt`. |
| Shared/unique, similarities, disagreements, question paths | Absent as a board. Two logs + corroborate/contradict cover the analog. |
| Helpfulness / accepted decision | Absent. Analog: Record human judgment. |
| Share-safe export | Automated, including planted-credential fail-closed. |
| Reload / restart persistence | Reload automated. Process restart skipped unless `COLLAB_E2E_RESTART_BASE_URL` points at a Postgres-backed `/ready` server. |
| Responsive / basic a11y | Automated at 375px and labeled login controls. |

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
3. **Evidence upload UX** — there is no file input. Confirm operators still
   cannot attach logs without an API client until a UI exists.
4. **Timeline bodies** — contribution text is not rendered; only payload JSON
   (kind/hash). Confirm whether that is acceptable for a demo.
5. **Corroboration IDs** — `targetId` is on the timeline API but omitted from
   the React row. Operators must learn IDs out of band.

## Recommended UI fixes (out of scope here)

- Add an evidence upload control (and show content hashes) instead of API-only.
- Show contribution body and `targetId` on timeline rows so corroboration works
  without a second client.
- Refresh `/api/catalog/sources` after writes; contributors currently see a
  stale empty import dropdown until reload (the fixture server pre-seeds
  sources to make import testable).
- Hide or disable Create case / Import / Add to timeline for viewers; surface
  `403` instead of silent no-ops.
- Add a privacy-class control on contributions if share_safe scan fixtures are
  meant to be UI-driven.
- `:focus-visible` styles and labels on placeholder-only composer fields.
- Do not ship comparison lanes, freeze snapshot, or helpfulness controls as if
  they already exist on this branch.

## Opt-in live profile

Default CI does **not** set `COLLAB_E2E_LIVE_PROFILE`. The example JSON contains
no secrets. Passwords stay in the environment. Do not commit filled profiles.

## Handbook impact

none — browser tests, fixtures, and qualification docs for the existing collab
shell; no engine, permission, or provider-lifecycle change.
