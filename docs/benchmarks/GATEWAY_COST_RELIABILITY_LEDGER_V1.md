# Gateway cost/reliability ledger v1

**Status:** Local integration on branch `cursor/cost-reliability-ledger-7914`
(base `c09357153e0c8953f2862c3cf3d8377ec9bc6bc7`). Offline ledger only — no live
gateway calls.

## Purpose

Build a provider-neutral, share-safe ledger so operators can compare gateway
diagnostic runs over time: request counts, token/cost summaries when reported,
latency, deadline/cancellation, cleanup, failure categories, and typed verdicts.

This lane is **independent** of the Luna tool-continuation hardening lane. It
does not change gateway diagnose execution, tool continuation, or credential
handling.

## Honesty rules

- Missing cost or token fields stay **unknown**, never zero-filled.
- Genuine reported `0` / `0.0` remains distinct from unknown.
- `inconclusive` stays separate from `fail` and `pass`; pass rates ignore
  inconclusive rather than treating it as failure.
- Aggregates never emit `verified` badges or readiness claims.
- Exact model/gateway labels are retained only when already present in
  committed share-safe data (catalog fixtures / documented benchmarks);
  otherwise the ledger records a pseudonym or `unknown`.

## Schemas

| Schema id | Version | Meaning |
| --- | ---: | --- |
| `contextdesk.gateway_cost_ledger.v1` | 1 | One ingested diagnostic run |
| `contextdesk.gateway_cost_ledger_aggregate.v1` | 1 | Per-model aggregate summary |
| `contextdesk.gateway_cost_ledger_comparison.v1` | 1 | Deterministic comparison report |
| `contextdesk.gateway_cost_ledger_historical_row.v1` | 1 | Documented historical row fixture |

## Inputs

1. Share-safe gateway diagnose bundles (`report.json` + optional
   `manifest.json`) — checksum-validated when a manifest is present.
2. Documented historical benchmark rows under
   `fixtures/gateway-cost-ledger/v1/historical/`, transcribed from
   `docs/benchmarks/VERCEL_GATEWAY_DIAGNOSTIC_*.md` and related write-ups.
3. Already-shaped ledger run JSON.

Forbidden fields (credentials, authorization headers, raw prompts/responses,
provider bodies, private captures) cause ingest rejection. Surviving free text
crosses `ShareSafeRedactionPolicy`.

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

Text output is a deterministic per-model table (runs, pass rates by dimension,
median latency, cost/token summaries, caveats). JSON uses the comparison
schema above.

## Importing owner-local Luna reports later (without committing raw data)

Owner-local Luna / private diagnostic directories may contain raw provider
exchanges under a `private/` capture tree. Those must **never** be committed.

Recommended offline import path:

1. On the owner machine, keep the private capture directory out of git
   (local-only permissions as produced by `gateway diagnose --raw`).
2. Copy **only** the share-safe pair `report.json` + `manifest.json` into a
   scratch directory outside the repository (or a gitignored workspace path).
3. Confirm the report has no `private_capture` payload inline and that
   `private_capture_written` (if present) does not imply the private files are
   being ingested — the ledger reader never opens `private/`.
4. Run `contextdesk gateway ledger --input <scratch-dir> …` locally.
5. If a share-safe ledger run JSON is useful for a future PR, export the
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

- Live gateway or Luna continuation probing
- Readiness / verified badges derived from aggregates
- Committing owner-local raw captures or credentials
- Coupling to the Luna tool-continuation hardening branch
