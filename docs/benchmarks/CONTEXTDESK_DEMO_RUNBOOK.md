# ContextDesk War Room demo runbook

This runbook has two jobs: make the synthetic demonstration dependable, and keep any later employer-data rehearsal local and deliberately separate from the repository.

## Five-minute synthetic story

From `collab/` run:

```bash
npm run demo
```

Open `http://127.0.0.1:8787` and sign in with `demo` / `demo`. Set `COLLAB_DEMO_PORT` to another local port if 8787 is occupied. The launcher is a separate entry point: it does not change the production PostgreSQL or LDAP startup path, it binds only to loopback, and its temporary evidence is removed when it stops.

Use **Interface theme** if you want to change the presentation (`Command`,
`Dark`, `Slate`, `Light`, `Sand`, or `Forest`). `Command` is the default. The
selected theme is a local browser preference.

Present the seeded investigation in this order:

1. On **Overview**, point out the persistent navigation, signed-in identity,
   recorded status counts, bounded **Latest activity** feed, and
   **High-impact investigations**. Open one activity to demonstrate that it
   routes to the exact investigation stage, then use **Investigations** for the
   searchable inventory and **Start investigation**. Search for `checkout`,
   then open **Checkout timeouts — model and strategy comparison**.
2. Use the breadcrumbs and five stage controls to orient the audience. On
   **Situation**, show the recorded status, severity, participants, activity,
   and work areas. These are recorded facts, not an inferred verdict.
3. On **Capture**, show the human-authored note, uploaded evidence, and the
   external AI paste labeled **imported · unverified**. Explain that imported
   output is not silently treated as human-authored or corroborated evidence.
4. Open **Discussion**. Explain that messages are durable case records while
   presence is ephemeral; refresh is bounded polling, not realtime chat. Post
   one clearly synthetic message if desired.
5. On **Analyze**, show the evidence board, snapshot lineage, run history, and
   the synthetic/offline launcher. Do not switch to a live gateway during the
   five-minute story. Unknown usage and cost must remain unknown.
6. On **Compare**, start with `pkg-synth-three-model-checkout-v1`. Point out the
   three candidates, shared evidence, candidate-specific clues, and role
   conflict. Agreement is useful, but the UI explicitly says it is not proof.
   Show human helpfulness observations as separate evidence-support,
   actionability, and uncertainty-calibration judgments.
7. Select `pkg-synth-strategy-paths-v1` to compare the structured programmatic
   path with the pasted-chat path. They may ask different questions; missing
   comparability stays visible instead of being invented.
8. On **Decide**, show the accepted human decision and gold v1. Gold is a
   versioned human benchmark, not infallible truth. Export only the synthetic
   Experiment Lab review with the final privacy gate enabled. The readable
   share-safe summary comes first; open **View raw export** only when the
   audience needs the technical JSON.
9. Reload once. The session remains signed in and returns to Overview.
   Reopen the investigation to show that recorded artifacts persist while this
   demo process remains running.

The seeded model labels are synthetic fixtures: `qwen-3.6-27b`, `gpt-oss-120b`, and `ministral-14b`. There are no provider calls, credentials, private endpoints, or live employer outputs in this path.

## Connected ContextDesk comparison rehearsal

After the synthetic story is understood, the same War-Room can launch a real
ContextDesk comparison from a frozen case snapshot. This is deliberately a
separate rehearsal from the seeded demo:

1. Upload or create the case evidence in the Evidence board, then freeze a snapshot. Browser uploads are limited to 1 MB and still pass through the server's media/privacy policy; contributors may upload, while a case lead freezes the selected evidence.
2. In `Start a snapshot-bound comparison`, choose `Configured gateway`.
3. Select at least two configured host profiles, one per model lane. The UI sends
   only profile identifiers; endpoints and credentials remain on the host bridge.
4. Choose lane concurrency. The default is two lanes, with a published ceiling of
   four; use one for a rate-limited gateway.
5. Watch the run history: lanes remain `queued` until admitted, become `running`
   independently, and settle as each host result is durably accepted. The final
   same-snapshot proof is shown only after the host returns its complete envelope.
6. Choose `Review in Experiment Lab` and optionally select a previously imported
   chat run. Different questions and missing transcript structure remain explicit
   unknowns; the comparison does not pretend that chat and programmatic runs had
   identical paths.

The host bridge emits only bounded, identity-safe lifecycle progress. It never
streams prompts, raw provider output, credentials, endpoints, request IDs, or
unvalidated summaries to the web UI. If a gateway is not configured, use the
synthetic path or the read-only fallback above; do not paste gateway secrets into
the browser or repository.

## Limited read-only fallback

If a local port, database, or directory service is unavailable:

```bash
npm run demo:static
```

Open `collab/.demo/contextdesk-synthetic-demo.html` in a normal browser. This
single file has no server dependency and is useful only for a limited,
read-only comparison view. It does **not** reproduce the complete War Room
journey: Discussion, evidence and snapshots, run history, routing, and durable
edits require the normal loopback demo. Do not present the static fallback as
equivalent to the primary demo.

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

The programmatic ContextDesk path can be produced automatically from a hermetic
`cd-collab.bench_run_artifact.v1` (or a `contextdesk.cli.bench_compare.v1`
payload with labeled lanes): Experiment Lab and TriageRunPanel convert
share-safe lane projections into `interaction_trace.v1` / `strategy_package.v1`
without inventing gold, cost, usage, prompts, or provider calls. Ambiguous
structure stays unknown. DeepSeek lane labels are rejected. Keep real-data
artifacts owner-local; only synthetic fixtures belong in git.

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
