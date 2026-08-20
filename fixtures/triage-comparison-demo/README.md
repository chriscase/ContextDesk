# Synthetic triage comparison demo

Small public fixture for tomorrow's comparison demo. Fictional storefront
checkout only — no customers, credentials, network endpoints, or measured
usage/cost/timing.

Copy-paste runbook: [`docs/benchmarks/TRIAGE_COMPARISON_DEMO.md`](../../docs/benchmarks/TRIAGE_COMPARISON_DEMO.md).

| Path | Role |
| --- | --- |
| `case.json` | One `contextdesk.triage_bench.case.v1` |
| `snapshot.json` + `blobs/checkout.log` | One raw-log evidence snapshot |
| `task.json` | Answerable evaluation task (raw bytes, no summaries) |
| `tasks/abstention.json` | Insufficient-evidence task over the same snapshot |
| `tasks/contradiction.json` | Contradiction/decoy task over the same snapshot |
| `candidates/candidate-a.json` | Live `contextdesk bench-compare` candidate |
| `candidates/candidate-b.json` | Live `contextdesk bench-compare` candidate |
| `candidates/candidate-c.json` | Live `contextdesk bench-compare` candidate |
| `recorded/*.json` | Offline `cd-triage-bench import-run` documents |
| `replay/*.json` | Offline `cd-triage-bench-adapter record-replay` envelopes |
| `identities.json` | Helper listing the content-addressed ids |

`contextdesk bench-compare` is live provider execution only. There is no
offline `bench-compare` mode. Use `import-run` and `record-replay` when the
host has no credentials. The helper defaults to the exact employer chat ids
`qwen-3.6-27b`, `gpt-oss-120b`, and
`ministral-3-14b-instruct-2512`, but the host profile id must be supplied at
run time.

For a serious acceptance pass, run the same three lanes over multiple
answerable, abstention, and contradiction tasks with fixed budgets and at
least three repetitions. Grok Build or Luna may be added as a direct external
challenger when its output carries exact model and same-packet proof; pasted
text remains an imported, non-independent observation.
