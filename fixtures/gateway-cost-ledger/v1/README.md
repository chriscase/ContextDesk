# Gateway cost/reliability ledger fixtures (v1)

Hermetic, share-safe inputs for `cd_core::gateway_cost_ledger` and
`contextdesk gateway ledger`.

These are **not** live observations. Report shapes mirror the production
`contextdesk.gateway_diagnostic.v1` share-safe artifact. Historical rows are
transcribed from committed docs under `docs/benchmarks/` (DeepSeek / GPT-OSS
diagnostic write-ups). Diagnostic exact labels in these source-shaped fixtures
are deliberately ignored by ledger ingest in favor of their pseudonyms.
Public exact labels survive only in typed historical rows on the explicit
allowlist.

| Path | Purpose |
| --- | --- |
| `deepseek/` | DeepSeek V4 Flash chat-role diagnostic bundle |
| `gpt-oss/` | GPT-OSS 120B chat-role diagnostic bundle |
| `mixed-role/` | Embedding-role / mixed catalog shape (voyage-4) |
| `mixed-role/with-usage/` | Pseudonym-only run **with** token/cost fields |
| `mixed-role/without-usage/` | Same shape **without** usage (unknown cost proof) |
| `historical/` | Documented benchmark rows (no invented live data) |
| `malformed/` | Credential / raw-prompt / endpoint-leak rejection cases |

Never commit owner-local Luna raw captures here. See
`docs/benchmarks/GATEWAY_COST_RELIABILITY_LEDGER_V1.md` for the offline import
path.
