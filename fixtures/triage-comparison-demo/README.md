# Synthetic triage comparison demo

Small public fixture for tomorrow's comparison demo. Fictional storefront
checkout only — no customers, credentials, network endpoints, or measured
usage/cost/timing.

Copy-paste runbook: [`docs/benchmarks/TRIAGE_COMPARISON_DEMO.md`](../../docs/benchmarks/TRIAGE_COMPARISON_DEMO.md).

| Path | Role |
| --- | --- |
| `case.json` | One `contextdesk.triage_bench.case.v1` |
| `snapshot.json` + `blobs/checkout.log` | One raw-log evidence snapshot |
| `task.json` | One evaluation task (raw bytes, no summaries) |
| `candidates/candidate-a.json` | Live `contextdesk bench-compare` candidate |
| `candidates/candidate-b.json` | Live `contextdesk bench-compare` candidate |
| `recorded/*.json` | Offline `cd-triage-bench import-run` documents |
| `replay/*.json` | Offline `cd-triage-bench-adapter record-replay` envelopes |
| `identities.json` | Helper listing the content-addressed ids |

`contextdesk bench-compare` is live provider execution only. There is no
offline `bench-compare` mode. Use `import-run` and `record-replay` when the
host has no credentials.
