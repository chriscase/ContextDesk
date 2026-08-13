# Multi-corpus demo harness v1

Status: **implemented on `integrate/demo-batch-v1`**. This is a thin CLI
acceptance/demo harness, not a second provider or agent implementation.

## Purpose

The harness makes it practical to demonstrate several corpora without turning
the demo into a provider matrix. It gives a developer a readable serial
progress view, preserves the raw local trace for follow-up work, and produces a
small aggregate report that can be shared after inspection.

## Production seams exercised

For source inputs, the harness invokes the shipped binary in this order:

1. `normalize --output ... --output-format jsonl --fail-on-partial` (offline preflight)
2. `import ...` (only with explicit `-Execute -AllowImport`)
3. `corpus list` (verify each exact imported or supplied id)
4. `chat ... --mode single --trace summary --activity summary` (one turn per
   corpus, only with `-Execute`)

The CLI therefore remains responsible for format detection, bounded
normalization, corpus persistence, retrieval, provider setup, tool policy,
deadline propagation, answer validation, trace/activity emission, and the
human-readable answer projection. The PowerShell layer never performs HTTP or
parses a model response as authority.

## Safety contract

- Preflight without `-Execute` makes zero provider calls and does not import.
- Source execution requires the separate `-AllowImport` acknowledgement.
- Cases run serially; there are no retries, concurrency, fallback model, or
  matrix behavior.
- The model id is an explicit user argument. The harness does not shorten or
  infer ids from names.
- `--trace summary` and `--activity summary` are used; full message traces are
  not requested by the harness.
- All generated material is placed below one fresh local-only `OutputRoot`.
  Raw JSONL/stdout/stderr are retained below `raw-local-only/`, normalized
  source material below `normalized-preflight/`, and answer projections beside
  each case. These may contain corpus/model output and must not be uploaded by
  default. The default output root is the operating system temporary directory;
  an explicitly supplied root is rejected if it contains (or is contained by)
  the data directory, the ContextDesk checkout, or any source tree.
- Each successful turn also gets a local `case-XX-answer.md` projection so a
  developer can review the actual answer without decoding JSONL. It is in the
  same non-share-safe class as the raw capture.
- `report.json` and `report.md` contain case ordinals, bounded status fields,
  typed-answer/validation-tier/grounding flags, timing, and sanitized error
  codes only. A `grounding=grounded` flag certifies host citation identity, not
  causal truth, completeness, or interpretation quality.
- The harness is fail-closed: malformed JSONL, missing or duplicate terminal
  events, an error event, a missing live trace, model/corpus mismatch, an
  ungrounded result, a partial import/normalization, or unresolved timezone
  records makes the required gate fail and exits nonzero. Preflight-only runs
  make no provider calls; `-Execute` still performs exactly one turn per
  eligible corpus.

## Provider-free contract checks

`python3 -m unittest scripts/tests/test_demo_corpus_batch_contract.py` checks
that the harness retains the production command seams, is serial, has no
second transport, rejects unsafe output placement, and separates raw artifacts
from the aggregate report. On a host with PowerShell, the same test also invokes PowerShell's parser. The
current macOS development host has no `pwsh`, so that parser check is skipped
here and must run on the Windows acceptance machine.

## Known limits

This harness does not decide whether a corpus is semantically useful and does
not replace human review. It also intentionally does not import a source unless
the operator opts in. For a first demonstration, use three to five deliberately
chosen corpora and one exact, previously selected model (Qwen was the fastest
useful employer result observed so far; use the actual catalog id returned by
the user's gateway).
