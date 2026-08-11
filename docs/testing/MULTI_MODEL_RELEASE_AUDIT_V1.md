# Multi-model release audit v1

**Audit date:** 2026-08-11  
**Feature branch:** `feat/multimodel-contribution-reconcile-v1`  
**Branch tip at this audit snapshot:** `59df68fadc0d51a9d8cc245959c5f9f410a06eaa`
**Production-code integration tip:** `59df68fadc0d51a9d8cc245959c5f9f410a06eaa`

This is a release-manager evidence map for the model-agnostic investigation
goal. It distinguishes what is proven in the repository from what still needs
an external gateway run. It makes no universal model-readiness claim.

## Requirement audit

| Requirement | Current evidence | Status |
|---|---|---|
| Typed provider-neutral roles and host-minted ids | `cd_core::multi_model::contributions`; exact packet/role/scope validation | Proven |
| Deterministic reconciliation and explicit states | `reconcile_contributions`, `ReconciliationReportV1`, root-cause ceiling | Proven |
| Useful no-model answer floor | `deterministic_baseline`, `reconciliation_answer`; host timeline/groups/relationships/citations | Proven |
| Bounded routing and dropout handling | `ContributionRoutingPlan`, one sequential call per selected slot, shared deadline/cancel/context limits, no hidden retry | Proven |
| Production CLI/desktop integration | `cd-workflow` resolver, `--mode contributions`, Tauri per-turn/default mode, shared activity/telemetry | Proven hermetically |
| Adversarial/mutation coverage | contribution contract/pipeline tests, triage-quality labs, gateway diagnostic contract audit, retrieval and wire labs | Proven hermetically |
| Replayable evaluation | `replay_reconciliation` compares deterministic-only, one contributor, and bounded multi-model outcomes | Proven provider-free |
| Live model evidence | Exact Vercel DeepSeek/GPT-OSS reports and retrieval reports under `docs/benchmarks/`; scoped to their exact route/model/release | Prior evidence only |
| New live capture on this branch | `gateway diagnose --raw --raw-i-understand` is implemented, but the configured protected credential file is absent in this worktree | Blocked on external state |
| Employer-gateway acceptance | Requires the owner’s source checkout, exact discovered ids, and owner-authorized gateway; no employer call is made by this audit | Pending acceptance |

## Integrated hardening

Optional reviewer, contributor, and fast-triage backends now use the resolved
turn’s transport timeout. An explicit patient deadline (for example, 600
seconds) reaches the HTTP client instead of being cut off by the standalone
120-second constructor default. The shared mapping is covered by a workflow
unit test, while cancellation and host deadline races remain authoritative.
The contribution runtime also enforces the smaller route-level
`max_rounds`/`max_context_chars` ceilings at execution time, with an adversarial
regression test proving those validated policy fields cannot be bypassed.
Its deterministic answer renderer now exposes bounded host relationships,
citations, symptoms, reconciliation state, and conflicts without rendering
untrusted model explanation text.

## Gate evidence

- `cargo fmt --all -- --check`: pass
- `cargo clippy -p cd-workflow --all-targets -- -D warnings`: pass
- `cargo test -p cd-workflow --lib --tests --no-fail-fast`: pass
- Desktop native `cargo check --locked`: pass
- Frontend typecheck: pass; lint: pass with nine pre-existing warnings and no
  errors; Vitest: 188 files / 1,861 tests; Node checks: 54; production build:
  pass
- Focused workflow suites: resolver, fast-triage, gateway diagnostic contract,
  credentials, qualification, retrieval production, and transport-oracle all
  pass
- Gateway-interaction fixture suite: `cargo test -p cd-core --test
  gateway_contract_fixtures -- --nocapture` — 15 passed. This is the durable
  regression ledger for earlier live Vercel observations: mixed catalog roles,
  exact observed role hints, chat qualification markers, fragmented streams,
  Vercel v4 embedding/rerank envelopes, malformed and role-mismatched payloads,
  and secret/metadata exclusion.
- `scripts/exact_head_full_gate.sh`: `FULL_GATE_PASS`
- Exact-head synthetic acceptance covered identity, stale-binary rejection,
  folder/zip import parity, timezone normalization, grounded two-turn chat,
  activity/trace, honest cancellation, and recovery
- Worktree is clean and the branch is pushed to origin

## Live evidence and promotion rule

Prior exact Vercel runs show DeepSeek V4 Flash producing a useful linked-log
answer, while GPT-OSS 120B completed the product path but failed the typed
symptom-separation scorer on the documented fixture. Vercel embedding and
reranking reports establish only the exact observed specialty-route contracts.
These are routing evidence, not readiness badges.

When a protected live run is available, retain the owner-only bounded exchange
capture locally. Promote only stable provider-neutral wire facts into the
smallest fixture or quality suite, after removing credentials, headers,
endpoints, private paths, incidental timestamps, and model prose that is not
needed for the contract. Never commit raw provider captures.

## Minimal next acceptance step

Restore the protected credential reference without using Keychain, then run one
exact-model `gateway diagnose --level basic --timeout 600` against the selected
gateway. Upload only its share-safe report/manifest. For the employer gateway,
repeat discovery and targeted qualification in the owner’s source checkout,
preserve the existing corpus/configuration/timezone, and run one selected-model
triage turn. Do not infer model ids, reuse Vercel evidence, or run a matrix.
