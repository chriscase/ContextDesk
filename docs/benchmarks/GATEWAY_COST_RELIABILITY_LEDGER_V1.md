# Gateway cost/reliability ledger v1

**Status:** Hardened integration candidate on
`feat/cost-reliability-ledger-hardening-v1`, based on the Triage Policy V2
integration line. Offline ledger only — no live gateway calls and no
readiness claim.

## Purpose

Build a provider-neutral, share-safe ledger so operators can compare gateway
diagnostic runs over time: request counts, token/cost summaries when reported,
latency, deadline/cancellation, cleanup, failure categories, and typed verdicts.

This lane is **independent** of the tool-continuation hardening lane. It
does not change gateway diagnose execution, tool continuation, or credential
handling.

## Honesty rules

- Missing cost or token fields stay **unknown**, never zero-filled.
- Missing deadline/cancellation booleans stay **unknown**; an observed `false`
  remains distinct from missing evidence.
- Genuine reported `0` / `0.0` remains distinct from unknown.
- `inconclusive` stays separate from `fail` and `pass`; pass rates ignore
  inconclusive rather than treating it as failure.
- Aggregates never emit `verified` badges or readiness claims.
- Diagnostic observations retain only their supplied share-safe pseudonyms (or
  `unknown`). Owner-local exact model/gateway identities are never emitted.
- Exact public labels are limited to the explicit allowlist used by committed
  historical benchmark rows. They are not inferred from a model name.
- Diagnostic observations and documented historical rows are separate typed
  provenance cohorts and are never combined in one aggregate.
- Present-but-negative, non-numeric, non-finite, or out-of-range cost, token,
  request, deadline, timestamp, and latency evidence is rejected. It is never
  silently converted to `unknown`.

## Schemas

| Schema id | Version | Meaning |
| --- | ---: | --- |
| `contextdesk.gateway_cost_ledger.v1` | 1 | One ingested diagnostic run |
| `contextdesk.gateway_cost_ledger_aggregate.v1` | 1 | Per-model aggregate summary |
| `contextdesk.gateway_cost_ledger_comparison.v1` | 1 | Deterministic comparison report |
| `contextdesk.gateway_cost_ledger_historical_row.v1` | 1 | Documented historical row fixture |

## Inputs

1. Share-safe gateway diagnose bundle directories (`report.json` + required
   `manifest.json`) — run id, byte count, and SHA-256 are validated. A directly
   selected standalone report remains possible but carries no manifest proof.
2. Documented historical benchmark rows under
   `fixtures/gateway-cost-ledger/v1/historical/`, transcribed from
   `docs/benchmarks/VERCEL_GATEWAY_DIAGNOSTIC_*.md` and related write-ups.
3. Already-shaped ledger run JSON.

Forbidden fields or values (credentials, authorization headers, endpoint URLs,
absolute private paths, raw prompts/responses, provider bodies/headers, private
captures) cause ingest rejection before mapping. Surviving free text crosses
`ShareSafeRedactionPolicy`, and emitted JSON passes a second share-safe gate.

Untrusted inputs are bounded to 16 MiB per JSON file, 2,048 entries per
array/object, 16 KiB per string, and 10,000 aggregate runs. Numeric limits are
documented in `gateway_cost_ledger::schema` and deliberately exceed ordinary
diagnostic use.

## CLI

```bash
contextdesk gateway ledger \
  --input fixtures/gateway-cost-ledger/v1/deepseek \
  --input fixtures/gateway-cost-ledger/v1/gpt-oss \
  --input fixtures/gateway-cost-ledger/v1/mixed-role \
  --input fixtures/gateway-cost-ledger/v1/historical/row-01.json \
  --input fixtures/gateway-cost-ledger/v1/historical/row-02.json \
  --out /tmp/ledger-comparison.json
```

Text output is a deterministic provenance × gateway × model cohort table
(runs, pass rates by dimension, median latency, cost/token summaries, caveats).
Unknown identities never collapse unrelated runs into one cohort. JSON uses
the comparison schema above.

## Importing owner-local diagnostic reports later (without committing raw data)

Owner-local private diagnostic directories may contain raw provider
exchanges under a `private/` capture tree. Those must **never** be committed.

Recommended offline import path:

1. On the owner machine, keep the private capture directory out of git
   (local-only permissions as produced by `gateway diagnose --raw`).
2. Point the ledger only at the directory containing the share-safe pair
   `report.json` + `manifest.json`; it never recursively opens a `private/`
   subtree. A read-only copy outside the repository is optional, not required.
3. Confirm the report has no `private_capture` payload inline and that
   `private_capture_written` (if present) does not imply the private files are
   being ingested — the ledger reader never opens `private/`.
4. Run `contextdesk gateway ledger --input <scratch-dir> …` locally.
5. If a share-safe comparison JSON is useful for a future PR, export the
   **ledger record / comparison output** (already redacted) — not the raw
   capture, not Authorization headers, not endpoint URLs, not prompts.

Until that opt-in import is used, hermetic fixtures under
`fixtures/gateway-cost-ledger/v1/` are the only committed evidence for this
lane.

## Production anchors

- `crates/cd-core/src/gateway_cost_ledger/`
- `crates/cd-cli/src/commands/gateway_ledger.rs`
- `fixtures/gateway-cost-ledger/v1/`
- Handbook row: Gateway cost/reliability ledger in
  `docs/design/PROVEN_METHODS.md`

## Non-goals

- Live gateway or tool-continuation probing
- Readiness / verified badges derived from aggregates
- Committing owner-local raw captures or credentials
- Coupling to the tool-continuation hardening branch

## Hermetic mutation coverage

The focused tests reject or distinguish: unknown→false, unknown→zero,
negative/oversized numeric evidence, exact identity promotion from a diagnostic
record, historical/live cohort merging, secret/path/endpoint/raw-body input,
oversized strings/collections, and readiness-language emission.
