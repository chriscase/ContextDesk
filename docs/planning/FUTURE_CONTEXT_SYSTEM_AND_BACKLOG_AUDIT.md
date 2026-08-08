# Future context system plan & backlog audit

> **Artifact status: planning/audit document — not shipped product behavior, not an
> approved GitHub action.** This file preserves the full output of a read-only
> planning and audit session (2026-08-08) against `main` @ `eee1e6d2`. Nothing in it
> has been executed: no issues were created, closed, merged, edited, or labeled; no
> code or fixtures changed; no branches other than the one carrying this document
> were touched. Issue states, branch topology, and line numbers are **as of the
> audit date** and must be re-verified before acting. Recommendations marked
> "manager decision" are unresolved. Close recommendations still require the full
> `docs/CLOSE_PROOF.md` ritual before any issue is actually closed.

Produced by a Claude Code planning session (agent kind `claude-code`, model
`claude-fable-5`) using three parallel research lanes (architecture/contracts audit,
docs+issues+backlog audit, adversarial design review) plus first-hand verification
of load-bearing claims. A verified-vs-relied-on disclosure closes the document.

---

## 0. Audited commit topology and scope

All measurements taken 2026-08-08, read-only (`git log` / `git show` / `git rev-list`;
no checkouts of audited branches).

| Fact | Value |
| --- | --- |
| Primary branch audited | `main` @ `eee1e6d2` ("test(desktop): await linked chat count hydration") |
| Frozen typed investigation-answer RC | `0bfc5fd0` ("test(investigation): pin the reported status and link spoof") — **not on main**; 28 commits ahead of main; also the tip of `integrate/claude-evidence-investigation-final` |
| Reviewer-first multi-model V1 | 10 further commits stacked on the RC: `446d70a7` (contracts + reviewer pipeline, pure/I-O-free) → `d01c5250` (hermetic adversarial gates) → `83221669` (additive `MultiModelSettings`, default single/no reviewer) → `98a0c7ce` (seam/workflow/CLI wiring) → `92f41853` (desktop host wiring + GUI mode/diagnostics) → tests/style → `11ddcd07` (round ceiling + degradation telemetry) |
| Branch carrying both | `feature/multi-model-v1`, tip `11ddcd07`, **38 commits ahead of main, 0 behind** |
| Parallel lineage noted | `feature/typed-investigation-answer-v1`, 37 ahead, tip `dd91a9d9` |
| Repo branch count | 298 branches at audit time |
| Open issues / open PRs | 127 open issues, 0 open PRs |
| Recent main activity | Triage-confinement correction stream (~10 fixes in the 48h before the audit): `aa979bf7` (confine model-authored incident identifiers), `28e78475` (separate incident ranking from likely noise), `e33f34d8` (sanitize corrected model citations), `d4167e91`, `f41d77e6`, `aa456785`, `0ec4a6b1`, `0398e3a2`, `04da87a2`, `ad7abb9c` |
| Process gap | Neither the 38-commit branch nor the correction stream references any issue number — the backlog under-represents in-flight reality |

Branch-only code audited via `git show feature/multi-model-v1:<path>`:
`crates/cd-core/src/investigation_answer.rs`, `crates/cd-core/src/multi_model/{mod,contracts,pipeline}.rs`,
`crates/cd-workflow/src/multi_model.rs`, `crates/cd-core/tests/multi_model_pipeline.rs`,
`crates/cd-core/tests/investigation_answer_security_gates.rs`, plus branch diffs to
`config.rs`, `agent.rs`, `events.rs`, `chat.rs`, `research.rs`, `tool_host.rs`.

---

## 1. Verdict

The existing roadmap, docs, and 127 open issues do **not** adequately cover the
evolution from today's log-specific grounded investigation and reviewer-first
multi-model V1 toward a typed, provenance-aware multi-source investigation context
system. The direction is *anticipated* in several places — #601 (cross-source
evidence plane), #694 (unified context selector), the #722–#727 multi-model ladder,
#532's customer-statement class, and the proven-methods handbook's Stage-0 doctrine
(`docs/design/PROVEN_METHODS.md`, "From-scratch staged implementation path") — but
the load-bearing core is uncovered:

- **no evidence-class taxonomy exists anywhere** (four partially-overlapping source
  vocabularies, none authoritative);
- **no "changes" class** (deploys/commits/config diffs) and **no "structure" class**
  (topology/dependencies/ownership) appear in any doc or issue;
- **no cross-class source identity/revision registry**;
- **no generalization plan for the evidence ledger** beyond logs;
- **no issue tracks the frozen RC's own integration** onto main, and **no dedicated
  issue tracks live target-model certification** (spread across #745/#649/#724
  residual notes).

Additionally, ~30 open issues are already satisfied or superseded on main (§8), and
the backlog materially under-represents in-flight reality (§0, last row).

### The verification asymmetry (frames the whole plan)

Every guarantee that makes linked-log answers trustworthy bottoms out in a
deterministic host oracle — an event with `seq`/`source`/`template_id` either exists
in the revision-pinned corpus or it does not. `crates/cd-core/src/triage_quality.rs:1-11`
states this precisely: citation-identity grounding "only verifies that cited
`seq`/`source` pairs exist in bounded evidence." Runbooks, tickets, commit messages,
and topology assertions have **no such oracle**: the host can verify a citation
*exists*, not that its *content is true*. Identity confinement is not content
confinement. The plan therefore makes per-class verification depth and
claim-strength ceilings a **foundation**, not an enhancement: classes without a
deterministic host role-oracle cap at `CausalCandidate` strength, and
`root_cause_established` stays gated on host-assigned `Cause`-role evidence
(the existing `EvidenceRole::Neutral` discipline, promoted from convention to typed
per-class rule).

---

## 2. Coverage matrix (A)

Verdicts: **Full** / **Partial** / **None**, judged against the target direction
(typed classes; host-owned identity, scope, revision, provenance, authority,
rendering; ordinary-chat equivalence; no vocabulary coupling).

| Future capability | Existing coverage (issues / docs) | Verdict |
| --- | --- | --- |
| (a) Typed evidence classes beyond logs | #601 (logs+files+memory+DB+skills fixture), #532 (customer statements ≠ verified evidence), #763/#667 + `docs/design/OPERATIONAL_METRIC_TRACKS.md` (metrics), Confluence harvest docs (knowledge precedent), `docs/design/ACTIVITY_INSPECTOR.md` `DataScopeKind` seam | **Partial** — observations strong, knowledge partial; **no taxonomy issue; zero coverage for changes and structure classes** |
| (b) Source identity / revision / scope registry | Corpus revision-triple pinning (shipped; `docs/design/proven-methods/DETERMINISTIC_CONTEXT_ASSEMBLY.md` §4–5); harvest identity quad `(source_system, source_instance, source_remote_id, transform_profile)`; #826 versioned contracts | **Partial** — per-source mechanisms exist; **no cross-class registry**; DCA notes "other source types have source-specific citation contracts" |
| (c) Provenance & evidence-authority ledger generalization | Log-only: `SearchEvidenceIdentity`, per-candidate ledgers, and (branch-only) `HostEvidenceLedger`; DCA §16 residual names per-connector provenance chapters | **None as tracked work** — the pattern exists; its generalization has no issue |
| (d) Temporal alignment of evidence windows | Deep for logs+metrics: #787–#791, #670, #813/#814, #668/#672, #729; metric tracks' fail-closed shared axis | **Partial** — **None for cross-source clocks** (deploy/CI/SaaS timestamps); the only cross-source clock code at audit time is a 60s token-expiry allowance (`grok_auth.rs:55`) |
| (e) Context planner generalization | `context_plan.rs` typed 9-family planner (generic, shipped); DCA matrix row "Ranked multi-source context planner — Partial"; #601, #694 | **Partial** — the planner generalizes cheaply; **the grounded-evidence path is the gap** (its currency is a `seq=`/`source=` text grammar and the log-only `ToolResult.log_evidence` channel) |
| (f) Multi-model beyond linked-log broad triage | #722–#727 ladder (roles, qualification, bindings, lab, routing-last) | **Partial** — direction covered, but the ladder predates the RC; **no issue tracks RC integration/desktop wiring**; eligibility is hard-wired to linked-log broad triage at four layers |
| (g) UI rendering of typed evidence/provenance | Cross-corpus citation chips shipped; typed-answer rendering exists **only on the branch** (`render_answer_markdown`, `literal_span`) | **Partial** — no issue for typed-answer/provenance rendering; no trust-cue differentiation by verification depth |
| (h) Follow-up/session scope over multi-source | Single-corpus session link + revision-validated retry checkpoint (shipped); #759 run identity | **None for multi-source** — every binding is arity-one (`Session.linked_corpus_id`, branch `AnswerBindingV1.corpus_id`) |
| (i) Injection/trust boundaries for new classes | `injection.rs` nonce envelopes, `docs/THREAT_MODEL.md` per-source rows, #712/#750/#763 | **Partial** — pattern proven per source; **no threat-model rows for changes/structure; MCP tool descriptions bypass the envelope today** (`crates/cd-core/src/mcp_client.rs:241-245`) |
| (j) Privacy/egress per source × provider | #694 egress disclosure, #722/#725 per-role egress, #727 privacy routing; the branch reviewer gate (`ReviewerRemoteForbiddenLocalOnly` / `ReviewerEgressNotAcknowledged` in `cd-workflow/src/multi_model.rs`) is the first per-role egress gate in the codebase | **Partial** — strong per-feature; **no per-class × destination matrix** |
| (k) Cost/latency controls | `TurnClock` ceiling + phase caps + round ceilings (shipped); #649 residual; #727 preference | **Partial** — turn-level strong; **no cross-source retrieval sub-budget** (each MCP request gets its own 30s wall clock, composing additively inside the turn ceiling) and no cost-accounting issue |
| (l) Certification/eval discipline for new classes | Excellent hermetic discipline: vocabulary-neutral structural gates, opaque-token bijection, truth-leak scanners, company-shaped fixture (`247ba418`); vocab-audit + mechanical-rename held-outs exist **branch-only, log-only** (`investigation_answer_vocab_audit.rs`) | **Partial** — **no dedicated live target-model certification issue**; anti-overfit harness not generalized |

**Docs stale for this direction:** `docs/ROADMAP.md` (no phase for the entire
log/investigation/multi-model wave; the `phase-6` label exists only in issues),
`docs/BACKLOG_AUDIT.md` (last audit 2026-07-17/24; covers nothing past ~#424),
`docs/PRODUCT.md` (positioning ignores log investigation), `docs/design/MEMORY.md`
§9 (contradicts #409's "Phase 2 complete on main").

---

## 3. Recommended epic (B)

**One epic, re-founded from #601** (consolidate rather than duplicate — #601 already
carries the north-star "evidence plane / synthesis plane" contract; retitle and
rewrite it, keeping the number). Re-founding vs a fresh epic is a manager decision
(§7.1); the epic content is the same either way.

> ### Epic: Typed, provenance-aware multi-source investigation context (Evidence Classes v2)
>
> **Outcome:** an investigation turn can be explicitly scoped to N sources of M
> declared evidence classes; every model-facing evidence item carries host-owned
> class, identity, revision, provenance, verification depth, and egress policy;
> typed answers cite across classes under the same host-authority discipline that
> governs linked-log answers today; ordinary chat and default single-model behavior
> remain byte-equivalent.
>
> **Scope:** the class taxonomy ADR; a host source registry with per-class revision
> descriptors; session ScopeSet (arity-N scope binding); evidence envelope/ledger v2
> with cross-class confinement; host-owned authority assignment with per-class
> claim-strength ceilings; per-class budgets + egress matrix; cross-class temporal
> joinability; generalized anti-overfit certification; and exactly **two proving
> classes** — operational metrics (strongest oracle, spec already shipped) and
> changes (first genuinely new class).
>
> **Non-goals:** knowledge/structure/assertions classes (deferred until ceilings are
> proven); multi-model review beyond linked-log broad triage; any auto-attachment or
> ambient inheritance of sources; model-owned identity or relationship authority
> (models propose, the host disposes); retiring the frozen v1 answer path;
> coding-agent features (per `docs/NON_GOALS.md`); "stuff everything into a prompt."
>
> **Architecture invariants (merge-blocking):**
> 1. Host owns source identity, scope, revision, provenance, authority, and
>    rendering; models only reference host-minted ids (`deny_unknown_fields`
>    proposals → `validate_*` against a digest-bound ledger → `literal_span`
>    rendering — instantiate the existing pattern per class, never reinvent it).
> 2. Per-class verification depth is typed; classes without a deterministic host
>    role-oracle cap at `CausalCandidate`; `root_cause_established` requires
>    host-assigned `Cause` provenance.
> 3. Class-A content can never satisfy class-B grounding (`WrongScope`
>    generalized).
> 4. Scope is explicit and versioned: adding a source is a visible scope revision
>    that invalidates checkpoints, exactly as a noise-lens change does today.
> 5. Model-derived artifacts never re-enter context under a first-party label
>    (provenance conservation).
> 6. Cross-class temporal precedence claims are withheld unless the host computes
>    joinability.
> 7. Byte-equivalence gates: ordinary chat, default single-model, and
>    single-log-corpus linked turns produce identical provider payloads
>    before/after each child lands.
> 8. Per-class fixture-vocabulary audits and mechanical-rename held-outs in CI; no
>    eligibility heuristic without typed reason codes.
>
> **Prerequisites:** the do-not-start gate in §5 (reviewer-first V1 merged,
> hermetically re-certified on main, live target-model certified).
>
> **Exit criteria (measurable):** (1) two classes (metrics, changes) fully
> end-to-end: attachable, citable, rendered, certifiable, under all eight
> invariants; (2) equivalence gates green across the whole epic; (3) a mixed-scope
> investigation answer validates and renders with per-class citations and an
> explicit ScopeSet; (4) hermetic certification suites for both classes pass the
> vocab-audit + mechanical-rename discipline; (5) `docs/THREAT_MODEL.md` rows and a
> handbook chapter exist for each shipped class; (6) zero regressions in the frozen
> v1 path (its certification suite still passes untouched).

---

## 4. Dependency-ordered, paste-ready issue drafts (C)

Four **gate issues** (pre-epic, independently valuable), then the **epic children**
E1–E10. Each is independently shippable. These are drafts for later human approval
and publication — none exist on GitHub.

---

### G1 — Promote and reconcile reviewer-first multi-model V1 onto main

**Rationale/user value:** the typed answer contract (`investigation_answer.rs`), the
reviewer pipeline (`multi_model/`), and their certification suites exist only on
`feature/multi-model-v1` (38 commits; frozen RC `0bfc5fd0` + 10 reviewer commits).
Meanwhile main accumulated ~10 triage-confinement fixes in 48 hours on the *prose*
path. Two divergent confinement systems (main's text heuristics vs the branch's
typed ledger) must merge with the typed system subsuming the weaker one, or the
text-heuristic path survives as the de facto contract for future classes.

**Scope:** rebase/merge the branch to main; reconcile every main-side triage fix
(`aa979bf7`, `28e78475`, `e33f34d8`, `d4167e91`, `f41d77e6`, `aa456785`, `0ec4a6b1`,
`0398e3a2`) into or against the typed path; land `MultiModelSettings` additive
config; both certification suites green on main.

**Non-goals:** any new capability; eligibility widening; retrieval-lane desktop
wiring (separate).

**Acceptance criteria:** branch content on main with CI green;
`multi_model_pipeline.rs` + `investigation_answer_security_gates.rs` pass on main; a
written reconciliation note stating, per main-side fix, whether the typed path
subsumes it (with test) or the fix remains load-bearing; byte-equivalence test for
ordinary chat and default-single config passes.

**Test strategy:** existing hermetic suites; new equivalence snapshot test;
`cargo test --workspace` + desktop suite per the `AGENTS.md` gate.

**Dependencies:** none (this is the head of the chain).

**Risks:** merge-order risk is the point — every week of main-side prose-path fixes
widens the reconciliation.

---

### G2 — Live target-model certification for typed answers + reviewer V1 (dedicated tracking)

**Rationale:** hermetic certification "proves plumbing and rejection behavior only —
never model reasoning quality" (`crates/cd-core/src/triage_quality.rs:1-11`). Live
acceptance currently exists only as residual notes inside #745/#649/#724 —
invisible as a gate.

**Scope:** one issue consolidating the live-provider acceptance matrix:
tools-enabled target model over the 250k corpus (#745 residual), cold/slow provider
lifecycle (#649 residual), packaged qualification proof (#724 residual), plus
reviewer-mode live runs (review executes, degrades honestly, never fabricates).

**Non-goals:** re-running hermetic suites; model-quality benchmarking beyond the
acceptance matrix.

**Acceptance criteria:** a written matrix (provider/model × scenario) with pasted
outputs per `docs/CLOSE_PROOF.md`; explicit `ExecutedMode` telemetry evidence for
Review and ReviewDegraded; failures filed as issues, not absorbed silently.

**Test strategy:** owner-environment runs (credentials cannot be fabricated by
agents — mark `owner-action` like #525).

**Dependencies:** G1.

**Risks:** environment-dependent; keep hermetic vs live claims separated exactly as
the handbook status legend requires.

---

### G3 — Stop provenance laundering in ambient memory recall (label + carry `MemorySource`)

**Rationale:** `crates/cd-core/src/memory/ambient.rs:249-251` injects recalled
memories under the label "first-party durable store" and the injected lines drop
`MemorySource` entirely — while the store faithfully records
`Agent|Connector|Import|User` (`crates/cd-core/src/memory/types.rs:132-168`). A
model-drafted finding accepted last month re-enters context as first-party truth
today. This is the cheapest, highest-leverage provenance fix and is wrong *now*,
independent of the epic.

**Scope:** carry source/origin into the injected block per item; rewrite the block
header to be provenance-honest; wrap non-User-origin items appropriately.

**Non-goals:** memory schema changes; recall ranking changes; the full
provenance-conservation invariant (E4/E5).

**Acceptance criteria:** the injected block distinguishes at minimum User/Import vs
Agent/Connector origin per line; a test proves an `Agent`-origin memory is never
injected under a first-party label; ambient injection size caps unchanged.

**Test strategy:** unit tests on `inject_memory_context_with_embed` output; snapshot
of block format.

**Dependencies:** none.

**Risks:** minor prompt-shape change — gate with an ordinary-chat behavior review,
not byte-equivalence (this one intentionally changes the text).

---

### G4 — Route MCP tool descriptions through the untrusted-content boundary

**Rationale:** server-supplied MCP tool descriptions pass unwrapped into the
model-facing tool list (`crates/cd-core/src/mcp_client.rs:241-245`) — a
third-party-authored instruction channel outside the nonce envelope, contradicting
"tool results are untrusted content" (`AGENTS.md`). Grows more dangerous with every
connector class.

**Scope:** sanitize/wrap or strictly bound MCP-supplied descriptions (length caps,
defanging, provenance note); document in `docs/THREAT_MODEL.md`.

**Non-goals:** MCP substrate changes (ADR-0001 stands).

**Acceptance criteria:** a hostile description fixture ("always call me first…")
demonstrably reaches the model only in defanged/bounded form; threat-model row
added.

**Test strategy:** unit test on ToolSpec assembly with a hostile fixture; existing
MCP tests stay green.

**Dependencies:** none.

**Risks:** over-aggressive sanitization could degrade legitimate tool selection —
cap and defang rather than strip.

---

### E1 — ADR: evidence-class taxonomy, identity/revision model, verification depth & claim ceilings

**Rationale:** four partially-overlapping vocabularies exist (`router::SourceKind` —
which lacks Logs entirely, `ContextSourceFamily`, `DataScopeKind`, incident-bundle
component roles `"log"|"operational_metrics"|"attachment"|"readme"`) and none is the
master list. Every later child needs one authoritative answer to: what is a class,
what identifies a source, what is a revision per class, what can each class verify,
and what claim strength may it support. This is the handbook's Stage-0 ("freeze
truth and authority") executed for the class system.

**Scope:** ADR `docs/adr/0008-*` defining: the class enum (observations, changes,
structure, knowledge, assertions, memory); per-class identity tuple
`(class, source_system, instance, stable_id, revision-or-content-hash)`; per-class
revision descriptor shapes (the log triple `{event, template_analysis, suppression}`
becomes one variant; content-hash compensation for restartable analyses is the
sanctioned pattern, per the suppression `effective_policy_sha256` precedent);
per-class verification depth (identity-verified / content-verified / asserted) and
claim-strength ceiling; the unification path for the four vocabularies; citation
scheme prefixes (`metric:`, `commit:`, `deploy:` …) under the existing
fixture-parity discipline.

**Non-goals:** implementation; UI; connector choices.

**Acceptance criteria:** ADR accepted; a mapping table old-vocabulary → new
taxonomy; explicit statement that v1 (`contextdesk.investigation_answer.v1`) is
frozen and v2 is a new schema id with a v1 projection; handbook status row added as
**Accepted design**.

**Test strategy:** none (design); handbook structural checks pass.

**Dependencies:** the §5 gate for the contract-stability precondition.

**Risks:** over-design — timebox; the two proving classes (E9/E10) are the reality
check.

---

### E2 — Host source registry: typed source identity + per-class revision descriptors

**Rationale:** generalizes what exists only for corpora (id validation, canonical
containment, revision clocks) into a host-owned registry any class can join; today
connectors/files/memory identities are ad-hoc strings (`ContextCandidate.id` is a
free-form convention: `memory:{uuid}`, `attach:{rel}`, …).

**Scope:** a cd-core registry of attachable sources: identity per E1,
availability/health, side-effect class, per-class revision descriptor, egress
class, workspace binding. Corpus binding becomes the first registrant (refactor, no
behavior change). Fold the Tauri-side open-coded corpus bind/unbind back onto the
shared cd-workflow helpers while touching this seam (at audit time,
`agent_turn` re-implements bind/unbind inline while the CLI uses
`cd-workflow/turn.rs` helpers, and the architecture test does not pin them).

**Non-goals:** new source types; ScopeSet (E3); UI.

**Acceptance criteria:** registry API with the corpus as sole registrant;
byte-equivalence gate green (single-corpus turns unchanged); architecture test
extended to pin hosts on the shared binding helpers.

**Test strategy:** unit tests on identity validation fail-closed; equivalence
snapshots; existing linked-turn integration suite untouched.

**Dependencies:** E1.

**Risks:** refactor churn in `agent_turn` — keep it mechanical.

---

### E3 — Session ScopeSet: explicit N-source scope binding

**Rationale:** every binding today is arity-one (`Session.linked_corpus_id`, the
checkpoint identity, branch `AnswerBindingV1.corpus_id`); multi-source follow-ups
would otherwise blend evidence bases invisibly across turns (the defining new
session problem: turn 1 concludes from logs, turn 2 adds a runbook, turn 3's "final
answer" rests on an unrecorded mixture).

**Scope:** a versioned per-session ScopeSet of
`(class, source_id, revision-descriptor)`; every turn stamps it; checkpoints and
answer bindings embed it; adding/removing a source is an explicit user action
producing a visible scope revision that invalidates checkpoints (mirroring today's
noise-lens invalidation); single-corpus sessions serialize as a ScopeSet of one with
full backward compatibility.

**Non-goals:** auto-scoping; scope inference from window focus (banned by DCA
invariant 1); multi-corpus UX polish (#693 remains the UI ladder).

**Acceptance criteria:** ScopeSet persisted/restored across reopen; a scope change
invalidates retry checkpoints with a visible reason; equivalence gate green for
scope-of-one; ordinary sessions have an empty ScopeSet and zero new prompt content.

**Test strategy:** session round-trip tests; checkpoint invalidation tests modeled
on `linked_synthesis_retry_stale`; host/session-layer tests per the DCA test
recipe.

**Dependencies:** E2.

**Risks:** interacts with #693/#694 — coordinate so the selector UI consumes
ScopeSet rather than growing a parallel notion.

---

### E4 — Evidence envelope & ledger v2: per-class typed evidence with cross-class confinement

**Rationale:** the branch ledger's shape (`evidence_id, candidate_id, source_label,
locator, corpus_id, revision, role, content`) is already source-neutral except for
`corpus_id` + the log revision triple; and the packing/validation currency on main
is a `seq=`/`source=` **text grammar** (`crates/cd-core/src/context_budgeting.rs:586-640`)
plus the log-only `ToolResult.log_evidence` channel — the only typed evidence
channel out of tools. v2 makes typed evidence the universal currency.

**Scope:** `contextdesk.investigation_answer.v2` (new schema id): ledger rows carry
`(class, source-ref, revision-descriptor, verification-depth)`; a generic typed
evidence channel on tool results; the evidence packer consumes typed units instead
of parsing lines; cross-class confinement (`WrongScope` generalized: class-A
evidence cannot ground class-B claims; class-mismatched citations fail closed); v1
remains the wire/persistence format for single-log-corpus turns until parity is
proven — v2 must project losslessly to v1 for that case.

**Non-goals:** retiring v1; new classes; renderer work beyond parity.

**Acceptance criteria:** a v2 validation suite covering all v1 gates (digest, scope,
revision, duplicate, empty-evidence, establishment) plus class-confinement; the v1
certification suite passes byte-identical; dual-path selection is explicit and
logged; DTOs ship through `dto_contract_fixtures.rs` ↔ `packages/contracts`
(`CD_WIRE_VERSION="cd.v1"`).

**Test strategy:** port the v1 security-gate suite to v2 and extend with
cross-class forgery cases (a knowledge chunk containing `seq=…` syntax must not
satisfy log grounding); permutation-stability and opaque-token bijection retained.

**Dependencies:** E1, E2.

**Risks:** the single highest-blast-radius child — keep the frozen v1 path
untouched and certifiable throughout; any v1 edit re-opens G2.

---

### E5 — Evidence authority: host-owned role assignment with per-class ceilings

**Rationale:** `root_cause_established` requires a host `Cause` row, but **every
production ledger row at audit time is `Neutral` with empty content** (branch
`pipeline.rs` `candidate_entries` and the branch `agent.rs` multi-stage ledger) —
authority assignment is a missing host capability even for logs; and for classes
without oracles it must be structurally impossible rather than merely
unimplemented.

**Scope:** define and implement the host processes that may assign `EvidenceRole`
per class (for logs: which deterministic analyses justify `Cause`/`Supporting`; for
metrics: threshold/window logic; for asserted classes: never above the ceiling);
enforce claim-strength ceilings at validation (an `InitiatingCause` claim citing
only asserted-class evidence is `Withheld`); "summaries are not evidence" —
model-derived artifacts get an identity type that cannot satisfy grounding
(promoting the existing host-appendix disclaimer from prose to type system).

**Non-goals:** ML-based role inference (vocabulary-coupling risk); changing what
models may propose.

**Acceptance criteria:** at least one production path can assign `Cause` for logs
(making establishment reachable, with adversarial tests that it is *only* reachable
via that path); ceiling enforcement tests per class; a laundering test: an accepted
model finding recalled from memory cannot ground establishment.

**Test strategy:** extend the security-gate suite; adversarial colluding-stage
tests (reviewer + investigator agreeing cannot exceed the ceiling).

**Dependencies:** E4 (plus G3 as the memory-side prerequisite).

**Risks:** this is the product's epistemology — expect design iteration; keep the
default `Neutral` (fail-closed) whenever in doubt.

---

### E6 — Assembly policy: per-class budget reservations + egress matrix

**Rationale:** budgets today are per-mechanism, so a verbose class can starve a
decisive one with every cap green (a 300-byte config diff loses to 40
keyword-matching runbook chunks without any bound violated); egress today is
profile-level only, and the branch's reviewer gate is the only per-role egress
control in the codebase.

**Scope:** per-class floors/caps inside the existing char budget with honest
omission disclosure *in the synthesis package and UI* (extending
`candidates_omitted_by_cap`, `context_plan.rs:213-247`); a per-class ×
per-destination egress matrix enforced at package assembly (local-only classes
never reach remote providers, including the reviewer role); `workspace_id`
mandatory on evidence items; a shared retrieval sub-budget so connector calls
cannot additively consume the turn ceiling.

**Non-goals:** smarter ranking; token-exact accounting (keep the character-cap
discipline per DCA §7); cost dashboards.

**Acceptance criteria:** a starvation test (a decisive small item survives a
verbose flood via its floor); an egress violation fails closed before the provider
call with a typed reason and an audit entry; a retrieval sub-budget test (three
slow connector fetches cannot exhaust synthesis time).

**Test strategy:** unit tests on the planner/packer; an adversarial keyword-flood
fixture; egress-matrix truth-table tests.

**Dependencies:** E2 (registry carries egress class), E4 (typed units to budget).

**Risks:** floor/cap defaults are product decisions — see §7.

---

### E7 — Cross-class temporal joinability

**Rationale:** time honesty is per-corpus today (Wall/Mixed/OrderOnly; "no
fabricated cross-domain duration"); there is no cross-source clock model, and a
90-second CI clock skew can exonerate the causal deploy or blame the hotfix —
precisely the fabricated-precedence class of bug that commit `c31ec089` taught (an
additive sidecar field let order-only events masquerade as wall-clock instants;
found by adversarial review, missed by self-referential fixtures).

**Scope:** per-class time-quality declaration in the registry; a host-computed
joinability verdict for any cross-class temporal comparison (same resolved domain +
declared skew bound); cross-class precedence claims are typed and **withheld** when
unjoinable; rendering marks joinability explicitly.

**Non-goals:** skew estimation/correction; uncertainty visualization
(enhancements).

**Acceptance criteria:** an order-only corpus + wall-clock deploy stream cannot
produce a "happened-before" claim; the joinability verdict surfaces in the evidence
package; the metric-track precedent (shared axis without value comparability) is
documented as the pattern.

**Test strategy:** fixtures with deliberate skew and mixed domains; an adversarial
test porting the `c31ec089` scenario across classes.

**Dependencies:** E1, E4.

**Risks:** temporal semantics are subtle — reuse the #787–#791 vocabulary rather
than inventing new terms.

---

### E8 — Generalized anti-overfit certification harness (per-class)

**Rationale:** the discipline that caught real bugs — fixture-vocab audits
(`investigation_answer_vocab_audit.rs` bans `capacity_guard`, `disk_almost_full`,
`pool_limit`, … from product runtime), mechanical-rename held-outs, truth-leak
scanners, company-shaped fixtures — exists branch-only and log-only. Meanwhile live
vocabulary coupling ships on main: the broad-triage classifier is an English
keyword list where **any word containing a digit forces the focused path**
(`crates/cd-core/src/agent.rs:1257` at audit time — "why did the v2 rollout break
everything?" silently skips the deterministic brief), and the code-like-identifier
confinement keys on token shape tuned against fixture-flavored identifiers.

**Scope:** a reusable per-class certification template: fixture-vocab audit in CI
(fixture tokens banned from product runtime), mechanical-rename held-out scenarios
(rename every domain token; behavior must be invariant), typed reason codes for
every eligibility/ranking heuristic with fail-toward-safer defaults; apply it
retroactively to the broad-triage classifier (emit reason codes; document the digit
rule or fix it).

**Non-goals:** replacing NL eligibility with UI affordances (worthy, but an
enhancement — noted in §7); model-quality scoring.

**Acceptance criteria:** a CI job runs the vocab audit for every class with
fixtures; a mechanical-rename suite exists for logs (ported from the branch) and is
mandatory in the definition-of-done for E9/E10; classifier reason codes are visible
in the trail.

**Test strategy:** the harness is the test strategy; prove it by breaking it (seed
a fixture token into product code in a scratch test and watch CI fail).

**Dependencies:** G1 (port from branch); E1 for class enumeration.

**Risks:** none material — pure downside protection.

---

### E9 — Second evidence class end-to-end: operational metrics as citable evidence

**Rationale:** the cheapest true proof of the framework: metrics already have a
normative schema (`operational-metrics.v1.json`, `schemaVersion: 1`), host
validation, fixtures, durable attachment, and fail-closed time alignment — but they
are UI tracks, not model-facing evidence. Strongest available oracle after logs.

**Scope:** metric sources join the registry (E2) and ScopeSet (E3); typed metric
evidence items (series/window/point locators) enter the v2 ledger; a `metric:`
citation scheme with Rust/TS fixture parity; bounded metric evidence in the
synthesis package; rendering with class-appropriate chips; incident-bundle import
(#763) is the ingestion on-ramp.

**Non-goals:** new metric math; anomaly detection; multiple-attachment UX (#667
continues independently).

**Acceptance criteria:** a linked investigation scoped to corpus+metrics produces a
v2 answer citing both classes, each validating against its own source/revision; a
cross-class confinement test (a metric citation cannot ground a log-only claim and
vice versa); the E8 harness green for the class; handbook chapter row +
threat-model row added.

**Test strategy:** hermetic fixtures (the seven-day behavior-scale fixture already
exists); the DCA test-recipe layers (contract/core/adversarial/host/UI).

**Dependencies:** E2–E8; coordinates with #763/#667.

**Risks:** temporal joinability (E7) must land first or metric-vs-log precedence
claims ship unguarded.

---

### E10 — Changes class v1: deploys, commits, config revisions (events vs descriptions split)

**Rationale:** the first genuinely new class, chosen because change *events* are
host-verifiable (a commit sha, a deploy marker, a config-revision hash exist or
don't — nearly log-grade oracle), while change *descriptions* (commit messages, PR
bodies) are attacker-writable assertions. The class design must encode that split.
Note `crates/cd-core/src/git_source.rs` is the app's own source-run self-update
helper (#340), not a reusable connector — this is new source work.

**Scope:** a read-only changes connector (start with local git + a declared
deploy-marker format in the incident-bundle family); identity = immutable
sha/marker-id + repo/instance; change-event facts (sha, author identity as
*recorded*, timestamps with declared clock class, diff stat, files) are
content-verified; messages/descriptions are asserted-class content under the
ceiling, rendered as "asserted by author X in commit Y"; `commit:`/`deploy:`
citation schemes; threat-model rows (attacker-writable messages; force-push
identity rules: sha-keyed, never branch-keyed).

**Non-goals:** CI/CD platform integrations; blame/ownership inference (structure
class — deferred); write actions of any kind.

**Acceptance criteria:** an investigation scoped to corpus+changes cites a commit
whose *existence and metadata* are host-verified while its *message* renders at
asserted depth and cannot ground establishment; a force-push test (a rewritten
branch does not alter sha-keyed evidence); a temporal joinability verdict is
required for any deploy-vs-log precedence claim; the E8 harness green
(commit-message vocabulary must not become an eligibility signal).

**Test strategy:** hermetic git fixtures including force-push, skewed clocks, and
hostile messages (injection + citation-syntax spoofing — ticket/commit text can
legitimately contain `seq=17 source=payments.log`-shaped strings); an adversarial
"attacker attributes blame in a commit message" scenario must render as assertion.

**Dependencies:** E2–E8 (E7 especially).

**Risks:** scope creep toward CI integrations — hold the line at local git +
declared markers for v1.

---

## 5. "Do not start until" gate (D)

No epic child (E1 onward) starts until **all** of:

1. **G1 merged:** `feature/multi-model-v1` content on main, both hermetic
   certification suites green on main, reconciliation note published (the typed
   path subsumes the prose-path fixes).
2. **Correction stream quiesced:** ≥2 consecutive weeks without a
   `fix(triage)`/`fix(multi-model)` confinement fix on main (the 48 hours before
   the audit produced ~10 — the contract is still discovering holes; generalizing
   now multiplies every future hole by the number of classes).
3. **G2 complete:** the live target-model certification matrix executed and
   published (the RC's hermetic certification by design cannot detect
   vocabulary-coupled failures on real data).
4. **Tracking debt paid:** G1/G2 exist as issues so the work is visible in the
   backlog (at audit time the entire branch and correction stream referenced no
   issue).

G3, G4, E1 (design-only ADR drafting), and all backlog-hygiene work in §8 are
explicitly **exempt** — they are valuable now and touch nothing the gate protects.

---

## 6. Milestones, critical path, parallel lanes, deferrals (E)

| Phase | Content | Exit |
| --- | --- | --- |
| **M0 — Stabilize & certify** (gate) | G1, G2; G3/G4 opportunistically; backlog stabilization window (§9) | §5 gate fully green |
| **M1 — Truth model** | E1 (ADR), E8 harness port begins (log surface) | ADR accepted; vocab-audit CI live for logs |
| **M2 — Foundations** | E2 → E3 → E4 → E5; E6 and E7 in parallel once E2/E4 interfaces settle | All equivalence gates green; v2 validation suite ≥ v1 coverage; establishment reachable for logs |
| **M3 — Proof classes** | E9 (metrics), then E10 (changes) | Epic exit criteria (§3) met |
| **Deferred** (post-epic, rough order) | Knowledge class (needs ceilings proven — highest injection surface, weakest oracle); conversation/assertions class (fold into #532's customer-statement work); multi-model over multi-source (widen the four-layer eligibility chain deliberately); UI trust-chrome by verification depth; cross-source contradiction surfacing; structure class (weakest oracle + fastest staleness — build only if the changes class proves demand); adaptive routing (#727 stays last, as its own text says) | — |

**Critical path:** G1 → G2 → E1 → E2 → E3/E4 → E5 → E9 → E10.

**Parallelizable lanes:** (1) backlog hygiene + doc refreshes (§8) — anytime, no
gate; (2) G3/G4 — anytime; (3) E6, E7, E8 — parallel to E3–E5 once interfaces
exist; (4) the existing UX/remediation backlog (~33 UI issues) and the log-model P0
family (#787–#791) proceed independently — the P0 time-model work actively *helps*
E7.

---

## 7. Decisions requiring product/manager judgment (F)

1. **Epic vehicle:** re-found #601 as the epic (recommendation — consolidation,
   history preserved) vs a fresh epic issue with #601 as child.
2. **Class order:** metrics → changes (recommendation: strongest oracles first,
   smallest new surface) vs changes-first (the adversarial lane's preference for
   the most decisive incident signal) vs knowledge-first (rejected: weakest oracle
   before ceilings exist).
3. **v1 retirement:** keep the frozen v1 path indefinitely for single-log-corpus
   turns vs retire after v2 parity + one full release cycle. (Recommendation:
   decide only after E9; retirement re-opens G2.)
4. **Egress defaults:** per-class default-deny to remote providers (safe, more
   friction) vs current permissive-with-disclosure. A real product-posture choice
   for a tool selling trustworthiness.
5. **Multi-model expansion scope:** whether reviewer mode ever runs on multi-source
   turns before the knowledge class ships, and whether eligibility stays
   host-conservative or gains a user affordance (an explicit "Broad triage" control
   would also retire the digit-rule classifier — E8's noted enhancement).
6. **Structure class:** build vs drop. Recommendation: drop from all current
   planning; reconsider with real demand evidence.
7. **Backlog actions:** approve the high-confidence close list (§8.1) as a batch;
   approve the cluster consolidations (§8.3); decide the milestone question
   (formally abandon milestones in favor of `Parent:` body links + labels — they
   are already dead at 126/127 unset).
8. **Stabilization numbers:** the net-reduction target and window length in §9 are
   proposals; set the actual numbers.

---

## 8. Backlog hygiene — action table (127 open issues, 0 open PRs, as of 2026-08-08)

Every recommendation carries verified evidence; closes still require the
`docs/CLOSE_PROOF.md` ritual (SHA + pasted output + prose + agent/model labels).
**High** = safe to act on after the ritual; **HR** = human review needed (typically
an unverifiable packaged/native AC). Line numbers are as of the audit date.

### 8.1 CLOSE AS COMPLETED — high confidence (11)

| # | Title (short) | Evidence |
| --- | --- | --- |
| #672 | `search_logs` time windows | `crates/cd-core/src/tool_host.rs:1088-1106` both-bounds `[from,to)`; 7-day cap (`:7390`) + boundary tests (`:7360-7392`) |
| #697 | duplicate citation title/label | `desktop/src/components/SourceCitations.test.tsx:6` pins the dedup behavior |
| #653 | docs screenshot privacy | `docs/media/public-assets.json` + machine-checked `docs/CLAIMS.md` row (via `scripts/check_claims.sh`) |
| #733 | stale host-test symbol | production `linked_log_preflight_at` (`desktop/src-tauri/src/lib.rs:967`) + behavioral test `stale_link_precedes_tools_capability_for_every_profile` (`:17103`) |
| #683 | handbook window | `desktop/src-tauri/src/handbook.rs` + `desktop/src/components/handbook/EngineeringHandbook.tsx` + tests |
| #686 | handbook HTML export | `HandbookExport.tsx` + `EngineeringHandbook.test.tsx:310`; design doc confirms shipped |
| #678 | model-picker curation | `ModelVisibilityPanel.tsx` + DCA matrix row **Shipped**; sibling-health test at `desktop/src-tauri/src/lib.rs:18435` |
| #117 | remove 5,000-file cap | `crates/cd-core/src/index.rs:16` `DEFAULT_MAX_FILES=100_000`, configurable (`:72`), non-silent truncation (`:96-99`) |
| #472 | Logs pane import/export | `desktop/src/components/panes/LogPane.tsx:1445/:983/:1489` import/export flows + persisted meta v2 |
| #695 | attach one governed corpus | `desktop/src/components/SessionContextBar.tsx:37` + atomic-attach host test (`lib.rs:17161`) + DCA row **Shipped** |
| #732 | first-run demo corpus | `desktop/src/components/launch/PreLaunchScreen.test.tsx:148-176` opt-in install flow (#739 exists to harden it) |

### 8.2 CLOSE AS COMPLETED — needs human review (19)

#679 (Stop control — packaged AC), #650 (per-model tool capability — packaged
proof), #543 (rail compactness), #691 (save_memory recovery ACs — dual checkpoints
at `tool_host.rs:3804/:4415`), #700 (cache containment — adversarial-test
presence), #701 (citation routing target — `desktop/src/lib/turn.ts:128`), #698
(provenance across detach/relink — DCA invariant 15), #673/#676 (Original
(redacted) — package round-trip/native), #682/#687 (handbook epic + sync contract —
close-vs-rescope call), #709 (Explorer new-chat path), #706 (metric-track spec —
close in favor of #667 residuals), #639/#688 (timeline ACs — visual), #638 (theme
gallery form factor), #675 (compact-row slice), #692 (sidebar+tabs — visual; zero
`Tab` matches in `desktop/src/App.tsx`), #542 (Log Lab profile dimensions), #486
(lanes demo AC, then evaluate parent #480).

### 8.3 MERGE / OBSOLETE — high confidence

| Action | Evidence |
| --- | --- |
| #55 → **MERGE INTO #172**, close | #172's body states verbatim it supersedes #55 |
| #699 → **MERGE INTO #767** | #767 includes the identical composer/context-shelf defect |
| #275 → close tracker in favor of #385/#409/#410 | #409: "Split from #275 (Phase 2 complete on main)"; `docs/memory-half-lives.md` confirms |
| #511 → fold into #363 | timeline shipped (`TimelineNavigator.tsx`); live tail already tracked by #290/#363 |
| Clusters → one survivor each | compact rows (#669 parent ← #675/#689/#652/#636); README (#734 ← #677); diagnostics (#853 core ← cross-link #713); metric tracks (#667/#763 ← #706/#707); timestamp policy (#670 becomes index over #787–#791/#813/#814/#796); context ladder (#695 closed → #693 → #694 → #601-as-epic); investigation ladder (#656 → #646 → #532 with #759 prerequisite) |

### 8.4 UPDATE — valid goal, stale text (assumption debt)

#91 (claims pre-incremental-index world), #99 (claims no updater/branding — both
shipped per `docs/CLAIMS.md`), #76 (pre-SessionStore), #353/#363 (Phase 2 shipped;
rescope to Phases 3/4), #359 (narrow to cloud-embed opt-in UI), #385 (narrow to
bulk-import UI), #467/#480/#496 (Explorer epics largely shipped; narrow to
residuals), #649/#745 (narrow to the native/packaged acceptance residuals only),
#668 (strike the #672 slice), #670 (restate as parent index), #671 (narrow to
lifecycle beyond slice 1; cross-link #819), #729 (narrow post-#810), #731 (narrow
to hosted-CI caching; local strategy shipped in
`docs/development/LOCAL_BUILD_CACHE.md`), **#722–#727 (add a reconciliation note:
the RC already contains retrieval lanes + an ablation lab the ladder text doesn't
know about)**.

### 8.5 KEEP (as written)

#601 (→ epic), #693, #694, #759, #646, #532, #826, #763, #667, #707, #690, #819,
#813, #814, #824, #853, #787–#791, #796, #750, #751, #753, #712, #713, #739, #680,
#723–#727, #722, #409, #410, #79, #290, #292, #420, #328, #525, #540, #541, #539,
#746, #735, #845, and the ~30 active UI-remediation issues (subject to §8.3
clustering).

### 8.6 Backlog shape stats (audit-time)

- 127 open, 0 open PRs; 2 unlabeled (#845, #853); 126/127 without milestone (only
  #55 has "Phase 5 — Polish") — milestones effectively dead; epic linkage lives in
  `Parent: #N` body text.
- Age: 3 issues ≤7d; 109 issues 8–14d; 15 issues 15–21d. Oldest ten: #55 #76 #79
  #91 #99 #117 #172 (2026-07-17), #275 #290 #292 (2026-07-18).
- Top labels: `agent:codex` 90, `model:gpt-5.6-sol` 90, `area-ui` 81, `area-logs`
  81, `remediation` 73, `P1` 62, `ux-expert` 62, `enhancement` 59, `area-core` 52,
  `P2` 29, `phase-6` 26, `area-desktop` 19, `bug` 17, `area-security` 15,
  `area-docs` 14, `area-tools` 12, `area-providers` 11, `epic` 10, `P0` 4
  (#787–#790), `P3` 3, `owner-action` 1 (#525).

**Net effect if approved:** 11 immediate closes + up to 19 verified closes + 4
merges + ~16 rescopes ⇒ roughly **95–100 open issues, all with current text**,
before the epic adds ~15 new ones — a genuine net reduction with no risk hidden
(everything uncertain stays open as UPDATE, not CLOSE).

---

## 9. Lean backlog operating model (proposal — builds on existing machinery)

The repo already has the *hard* parts: binding close rules
(`docs/ISSUE_HONESTY.md`), a close-proof standard with CI teeth
(`docs/CLOSE_PROOF.md`, `scripts/check_close_proof.sh`), a machine-checked claims
ledger (`docs/CLAIMS.md` + `scripts/check_claims.sh`), the honest-status audit
table (`docs/BACKLOG_AUDIT.md`), and agent attribution
(`scripts/tag-issue-agent.sh`). What's missing is **intake discipline and
reconciliation** — the backlog only ever grows because filing is cheap and
closing-in-passing is invisible (30 provably-done-but-open issues; a 38-commit
branch with zero issue references).

1. **What deserves what.** An **issue** = one independently shippable outcome with
   falsifiable ACs. An **epic** = >3 related issues with exit criteria and a
   `Parent:` tree. An **ADR/design note** = a decision, not work. An observation
   discovered while working issue #N defaults to an **acceptance criterion or
   Residual note on #N** — not a new issue. UI-polish observations batch into the
   existing per-surface cluster parents (the #669/#675/#689/#652/#636 pileup is the
   anti-pattern). Handbook **Residual notes** are the sanctioned home for "known,
   documented, not yet scheduled."
2. **Definition of Ready:** outcome sentence + falsifiable ACs + labels (P, area) +
   `Parent:` link or a standalone justification + size (S/M/L; an L must name its
   split line or become an epic). Unready issues get 14 days to be made ready or
   merged into their parent.
3. **Definition of Done:** unchanged — ISSUE_HONESTY + CLOSE_PROOF are already
   binding and good.
4. **Supersession rules:** "Supersedes #N" in the body; the superseded issue closes
   same-day with a pointer (the #172/#55 and goal-doc precedents). Duplicates close
   to the survivor within 48h of detection. Never close on suspicion — UPDATE with
   a staleness note instead (exactly the conservative split used in §8).
5. **PR/promote reconciliation (the key new rule):** every promote to main answers,
   in the PR body, "which open issues does this batch satisfy, advance, or
   obsolete?" — a `Reconciles:` line. An integration branch with no issue
   references is a process error (this rule alone would have kept the RC and the
   correction stream visible). Add the line item to the `docs/AGENT_WORKFLOW.md`
   promote checklist.
6. **Ownership & cadence:** a 30-minute backlog review each promote-or-fortnight,
   whichever first: refresh `docs/BACKLOG_AUDIT.md`'s date, sweep for
   close-in-passing, re-verify one HR item. Epic owners audit children at every
   promote.
7. **Health measures (reported in the audit doc, not a dashboard):** open count;
   actionable-vs-tracker split; no-issue-commit rate on main (target ~0 for
   feat/fix); issues idle >21 days without edit; unlabeled count; HR-queue depth.
   Formally abandon milestones (126/127 unset) in favor of `Parent:` + labels — one
   convention, not two half-dead ones.
8. **Stabilization period (proposal; numbers are the manager's call):** a 2-week
   window before E1 starts, targeting **net −35 to −40 actionable issues** via §8
   (closes + merges), **zero new non-P0/P1 issues** filed during the window
   (observations go to parents/Residuals), and every surviving issue Ready per
   rule 2. Success = the epic launches into a backlog of ~95 current-text issues
   where open genuinely means "not done," which is what makes ISSUE_HONESTY cheap
   to uphold.
9. **WIP:** one integration branch per goal (existing rule), and — given 298 live
   branches at audit time — fold a branch sweep into the same fortnightly review:
   delete merged, name owners for the rest.

---

## 10. Storage recommendation (G)

**Both GitHub and repo docs, with a strict division of labor** — matching the
repo's own convention (`docs/ROADMAP.md`: "GitHub issues and epics are the source
of truth"):

- **GitHub (execution truth):** the epic (re-founded #601) + gate issues + children
  E1–E10, using the existing `Parent: #N` body convention and `epic`/`P1`/
  `area-core` labels (a `phase-7` label would match the existing `phase-6` idiom).
  The §3 epic text becomes the epic body; each §4 draft becomes one issue.
- **Repo docs (design truth):** the taxonomy decision as `docs/adr/0008-…` (E1's
  deliverable); one goal doc `docs/goals/GOAL_TYPED_EVIDENCE_CONTEXT.md` with the
  goal prompt + issue map (the established goal-doc pattern, including the
  supersession discipline `docs/goals/GOAL_UPDATES_AND_CHAT_CONTEXT.md` already
  demonstrates); a handbook chapter only when status reaches Accepted design, per
  the handbook maintenance contract.
- **Refresh in the same motion (staleness debt):** `docs/ROADMAP.md` gains the
  missing phase describing the log-investigation/multi-model wave + this epic;
  `docs/BACKLOG_AUDIT.md` gets re-dated with §8's results.
- **Not recommended:** storing the plan only in an issue (docs rot slower, and the
  handbook contract requires claim sync), or only in docs (invisible to
  execution). The full hygiene table (§8) belongs in `docs/BACKLOG_AUDIT.md` + one
  one-time hygiene tracking issue, not in the epic body.

This document itself is the durable session artifact preceding those steps; none of
the above has been executed.

---

## 11. Verified vs. relied-on disclosure

**Personally verified during the session (first-hand commands/reads):** the branch
topology and RC ancestry (28 + 10 = 38 commits; tips; `main..0bfc5fd0` = 28;
`feature/multi-model-v1` 38 ahead / 0 behind; 298 branches); the
`InvestigationAnswerV1` and `multi_model` contract shapes (via `git show`); the
ambient-memory first-party label (`crates/cd-core/src/memory/ambient.rs:249-251`)
and the digit-rule classifier (`crates/cd-core/src/agent.rs:1257`); the core docs
(`docs/ROADMAP.md`, `docs/BACKLOG_AUDIT.md`, `docs/ISSUE_HONESTY.md`,
`docs/design/PROVEN_METHODS.md`, `docs/design/proven-methods/DETERMINISTIC_CONTEXT_ASSEMBLY.md`,
`docs/design/proven-methods/BOUNDED_MULTI_STAGE_BROAD_TRIAGE.md`, spec headers,
`docs/goals/` supersession, `crates/cd-core/src/git_source.rs` purpose).

**Relied on three research lanes** (each instructed read-only, each citing
file:line evidence): the issue-by-issue hygiene evidence in §8 (every row carries a
concrete anchor recorded by the docs/issues lane); the architecture seam inventory
and host-boundary findings (architecture lane); the risk register and
verification-asymmetry analysis (adversarial lane — its two most consequential
claims were then re-verified first-hand, as noted above). Where lanes disagreed
(commit counts), the discrepancy was re-measured and reconciled first-hand.

**Not verified (and therefore flagged, not asserted):** packaged/native acceptance
criteria on HR-tier issues (§8.2); live-provider behavior of any kind; GitHub issue
bodies beyond what the lanes quoted. Nothing was modified anywhere during the
audit session: no files, branches, issues, or PRs.
