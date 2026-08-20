# ContextDesk comparison demo runbook

This runbook has two jobs: make the synthetic demonstration dependable, and keep any later employer-data rehearsal local and deliberately separate from the repository.

## Five-minute synthetic story

From `collab/` run:

```bash
npm run demo
```

Open `http://127.0.0.1:8787` and sign in with `demo` / `demo`. Set `COLLAB_DEMO_PORT` to another local port if 8787 is occupied. The launcher is a separate entry point: it does not change the production PostgreSQL or LDAP startup path, it binds only to loopback, and its temporary evidence is removed when it stops.

Use the Presenter controls skin selector if you want the web surface to match a ContextDesk desktop skin (`Dark`, `Slate`, `Light`, `Sand`, `Forest`, or `GrokPtah`). The selected skin is a local browser preference.

Present the seeded case in this order:

1. Start with `pkg-synth-three-model-checkout-v1`. Point out the three candidates, shared evidence, candidate-specific clues, and a role conflict. Agreement is useful, but is not treated as proof.
2. Show the three human helpfulness observations. They score evidence support, actionability, and uncertainty calibration independently of model agreement.
3. Show the accepted human decision and gold v1. Explain that gold is a versioned human benchmark, not an infallible truth claim.
4. Select `pkg-synth-strategy-paths-v1`. Compare the structured programmatic path with the pasted-chat path. They ask different questions but can still be compared by evidence discovery, unknowns, efficiency, helpfulness, and convergence on the benchmark.
5. Export only the synthetic Experiment Lab review. The final privacy gate must stay enabled; never substitute an owner-only capture for a share-safe artifact.
6. The export presents a readable share-safe summary first. Open `View raw export` only when demonstrating the optional technical JSON; it is deliberately hidden from the presenter surface by default.

The seeded model labels are synthetic fixtures: `qwen-3.6-27b`, `gpt-oss-120b`, and `ministral-14b`. There are no provider calls, credentials, private endpoints, or live employer outputs in this path.

## Fast, read-only fallback

If a local port, database, or directory service is unavailable:

```bash
npm run demo:static
```

Open `collab/.demo/contextdesk-synthetic-demo.html` in a normal browser. This single file contains the same synthetic, pre-adjudicated story and no server dependency. It is intentionally read-only; use the normal demo server to demonstrate edits.

## Preflight

Before presenting, run the fast hermetic checks:

```bash
cd collab
npm run demo:check

# Optional Rust/offline bench check from the repository root:
cd ..
CD_TRIAGE_BENCH=/path/to/cd-triage-bench \
CD_TRIAGE_BENCH_ADAPTER=/path/to/cd-triage-bench-adapter \
./scripts/triage-comparison-demo.sh self-check
```

Use `/health` for a server smoke check. `/ready` intentionally reports that the synthetic in-memory launcher has no production database; do not weaken that production readiness contract.

## Local-only external-chat comparison rehearsal

Create an owner-only working directory outside the checkout:

```bash
./scripts/prepare-private-triage-comparison.sh
```

The command creates a random directory under `/private/tmp`, permissions it to the current user, and copies three matching strategy templates plus one gold-contract structure reference. The gold reference belongs to a different synthetic fixture; do not import it as though it belonged to the private comparison. Promote the locally reviewed accepted decision through Experiment Lab instead. Keep the completed files there. Do not put real chat text, employer names, internal model labels, hostnames, paths, request identifiers, or evidence into Git, issue comments, pull requests, or the synthetic fallback HTML.

Use opaque local labels throughout:

- candidates: `candidate-a`, `candidate-b`
- evidence: `ev-01`, `ev-02`
- people: `reviewer-a`, `operator-a`
- systems/models: `external-chat`, `contextdesk-run`

Redact the chat before import. The plain transcript contract may contain different questions from the ContextDesk run; that is expected. If turn structure, tool use, timing, cost, or evidence cannot be proved, leave it unknown. Do not infer missing structure.

The current programmatic trace template is manually adapted from an owner-only ContextDesk run. There is not yet an automatic run-to-trace converter, so verify each event, parent link, and evidence alias rather than inventing provenance. Declare any evidence needed for gold alignment in the experiment package as well as the trace until trace-derived alignment is implemented.

Import in this order through Experiment Lab:

1. the two-candidate experiment package;
2. the redacted external chat transcript;
3. the verified ContextDesk programmatic trace;
4. human annotations for evidence links the raw transcript cannot prove;
5. helpfulness scores and a proposed/accepted decision;
6. optionally promote the reviewed accepted decision to a local gold reference.

Keep the real-data experiment local. This build emits only `cd-collab.experiment_lab_export.v2` from Experiment Lab: candidate, participant, evidence, role, event, decision, trace, and gold identities are replaced with opaque aliases; model labels and free text are omitted; and a recursive fail-closed gate rejects paths, URLs, internal hosts, credential-shaped values, request IDs, prompts, endpoints, and raw-capture fields. Do not substitute the legacy v1 shape or an owner-only API response.

The v2 projection also withholds task/snapshot fingerprints, transcript and excerpt hashes, exact timestamps, and observed latency. Counts, statuses, rubric scores, revisions, and gold-alignment structure remain because they make the comparison useful; those facts can still be sensitive in a distinctive case. Treat v2 as a minimized comparison artifact, not an anonymity guarantee: inspect it locally before sharing and omit it entirely when that residual risk is unacceptable.

Stopping the in-memory demo removes its runtime state; remove the `/private/tmp` workspace manually only after you no longer need the rehearsal data.

## Presenter fallback language

If a live provider or employer-gateway run is unavailable, say: “This is a hermetic synthetic case exercising the same contracts, comparison logic, human review, accepted-decision, and backtest path. Live captures are deliberately optional and are never required to demonstrate the evaluation workflow.”
