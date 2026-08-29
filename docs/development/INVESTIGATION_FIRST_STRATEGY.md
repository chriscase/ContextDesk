# Investigation First strategy

## Status

**Local integration** on `codex/investigation-first-strategy-v1`. This slice is
not a replacement for the War Room and is not yet a claim about the default
experience on `main`.

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

## First slice

- one-page create flow with required title, severity, observed problem, impact,
  and affected parties above the fold;
- advanced disclosure for product/version/build/component/environment,
  organization, occurrence time, scope, and open questions;
- controlled datalist suggestions derived from existing recorded values;
- compact browse/search/status view with completeness cues;
- view-first detail that renders sparse imported records as “Not recorded”;
- evidence inventory with annotations from the shared contribution records,
  verification/privacy/hash/size metadata, safe selection, and a disabled
  trash placeholder until an audited recoverable-trash contract exists;
- bounded file upload through the existing protected evidence route;
- recoverable archive/restore through the existing explained lifecycle panel.

## Proof

The focused `InvestigationFirst.test.tsx` suite covers the fast form, shared
create payload, sparse detail, evidence annotation/inventory, explicit War
Room technical-tool handoff, and viewer restrictions. The full web suite and
production build must remain green before promotion.

## Follow-up

Instance/role governance, server-persisted user preferences, a first-class
trash/deletion workflow, canonical product/build catalogs, and additional UI
strategies remain separate milestones. Storage-provider migration, plugins,
branding, and LDAP administration are intentionally outside this slice.

