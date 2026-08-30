# Investigation First strategy

## Status

**Shipped on `main`** in
[#1108](https://github.com/chriscase/ContextDesk/pull/1108), merge commit
`e37464de39ac5cfbae4d7abf106eb26d763f1a96`. This slice is not a replacement
for the War Room and does not make Investigation First the instance default.

## Boundary

The UI strategy is a presentation adapter selected by the web shell. Its
registry owns only the strategy name, description, preview token, maturity,
status, and compatibility metadata. The resolver is pure and fail-closed:
unknown preferences, defaults, and policy values can only resolve to a known
strategy, with War Room as the safe fallback.

Investigation First uses the same protected case, evidence, contribution, and
lifecycle endpoints as War Room. It does not own authentication, capability
checks, case access, audit history, revisions, evidence identity, retention, or
deletion. Strategy changes preserve the canonical investigation URL and case
identifier. The explicit technical-tools action opens the reference War Room
for specialist log exploration; it does not duplicate or weaken that tool.
That presentation-only handoff is stored in browser history, so Back and
Forward—and a reload of that history entry—restore the expected strategy
without changing the user's saved preference. Both presentations expose
lifecycle mutations from the same server-authoritative `run:strategies`
capability.
Browser-local preferences are namespaced by authenticated username so a shared
browser does not hand one user's selected presentation to another user. The
browser title follows the active presentation, while Investigation First omits
War Room-only stage wording from its title.

## First slice

- one-page create flow with required title, severity, observed problem, impact,
  and affected parties above the fold;
- advanced disclosure for product/version/build/component/environment,
  organization, occurrence time, scope, and open questions;
- controlled datalist suggestions derived from existing recorded values;
- compact browse/search/status view with completeness cues and an honest,
  retryable list-load failure state;
- view-first detail that renders sparse imported records as “Not recorded”;
- evidence inventory with annotations from the shared contribution records,
  verification/privacy/hash/size metadata, safe selection, and a disabled
  trash placeholder until an audited recoverable-trash contract exists;
- bounded file upload through the existing protected evidence route;
- recoverable archive/restore through strategy-local controls backed solely by
  the shared Runtime V1 lifecycle resource and action command.

## Original #1108 proof

The focused `InvestigationFirst.test.tsx` and shell strategy suites cover the
fast form, shared create payload, sparse detail, evidence annotation/inventory,
explicit War Room technical-tool handoff, viewer restrictions, safe selection,
stale-detail suppression, truthful list/detail failures, shared lifecycle
authority, honest static read-only lifecycle copy, reversible non-persistent
technical handoff, strategy switching, and strategy-aware titles. The full web
suite passes 673 tests across 43 files;
collaboration typecheck, lint, and the production build are green. The three
loopback-dependent LDAP transport tests also pass outside the filesystem/network
sandbox that prevents binding a local test port.

A hands-on synthetic-demo acceptance pass also verified the rendered strategy
selector, username preference persistence across reload, single-page create,
explicit existing/new combo-field feedback, reuse of newly recorded product
and build values, sparse-safe detail, evidence annotations and selection, the
permanently disabled trash placeholder, and the canonical handoff to the same
investigation's War Room Analyze/log workbench route. Synthetic state was
discarded when the demo server stopped.

## Follow-up

Investigation First is the first presentation-only Shared Investigation Runtime
V1 consumer frozen on `main` through
[#1109](https://github.com/chriscase/ContextDesk/pull/1109), merge commit
`e3dc3a5676c9234bcae2314d64fcf06d037c8934`. The accepted candidate
`6cabdc7b293959e808681bbbd2030c81faee8819` also closes the no-read detail case:
a user without investigation-read authority receives a truthful, non-busy
denied view, no investigation request is issued, Back remains available, and
arrival focus is not stolen on a same-record rerender. Instance/role
governance, server-persisted user preferences, a first-class trash/deletion
workflow, canonical product/build catalogs, and additional UI strategies remain
separate milestones. Storage-provider migration, plugins, branding, and LDAP
administration are intentionally outside this slice.
