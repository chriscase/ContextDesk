# Sanitized evidence: trusted investigation discovery

Historical note. The pagination step below is route-injected: the fixture
slices a real response and supplies an opaque cursor. It is not a second
server page. The later built-server browser script is a separate real Runtime
journey and is recorded in `GOAL_1_TRUSTED_DISCOVERY_RECEIPT.md`. This file
is not the G1-01..G1-10 ledger.

Rerun against `7d56c2c0eafab5c70b1ffae50c02d2087904a305` after the collection controls moved onto the collection-query adapter. An earlier gate log recorded a dependency-boundary failure from before that move. That log was replaced. The results below are the replacement.

No passwords, database files, or private corpora are included.

## Gates

| Command | Exit |
| --- | --- |
| web lint | 0 |
| web typecheck | 0 |
| web test | 0 (101 files) |
| web build | 0 |
| server lint | 0 |
| server typecheck | 0 |
| server test | 0 (138 files passed, 11 skipped) |
| e2e typecheck | 0 |

The dependency-boundary test passed in this web suite.

## Browser journeys

`collab/e2e/specs/37-trusted-investigation-discovery.spec.ts` on the built web assets:

- Run 1: 4 passed
- Run 2: 4 passed

Each run covered War Room, Investigation First, Keystone, and Beacon: filter, inspect the synthetic row, reload the canonical URL with no cursor, switch presentation, load the next page, and open the investigation id.

## Mutation

Each inversion failed the shipped test. Restoring the tree made the same test pass. The published branch contains no mutants.

| Guarantee | Inverted result | Restored result |
| --- | --- | --- |
| First-occurrence dedup | fail | pass |
| Stale-callback drop | fail | pass |
| Denied-reader silence | fail | pass |
| Cursor absent from the shell URL | fail | pass |
| Stale-cursor restart | fail | pass |

## Disposable production server

Built entry `collab/server/dist/index.js`, new sqlite file, synthetic records only. Each process queried the same impact, contributor, and recorded-at filter twice.

| Run | Items | Open facet count | Impact facet count | Hidden archived | Repeated bodies equal | Denied reader |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2 | 1 | 0 | yes | 403, no items |
| 2 | 1 | 2 | 1 | 0 | yes | 403, no items |

The open facet count is the authorized collection, not a recount of the one filtered row.
