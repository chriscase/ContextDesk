# Multi-corpus demo harness — Windows portability & privacy audit v1

**Branch:** `test/demo-corpus-batch-windows-privacy-audit-v1`  
**Base SHA:** `70f8875c722cb50d69cfb64c2c0cf348d615254b` (`integrate/demo-batch-v1`)  
**Attestation:** provider-free; disposable fake CLI only; no credentials, Keychain,
private corpora, gateways, or live provider calls. No PR opened.

Tip SHA and full command transcripts live under the audit SCRATCH workspace
(`identity.log`, `audit-run.log`, `tests.log`, `privacy-scan.log`,
`splitpath-proof.log`) and must match `git rev-parse HEAD` at delivery.

## Scope

| Artifact | Role |
| --- | --- |
| `scripts/demo-corpus-batch.ps1` | Serial multi-corpus acceptance harness |
| `scripts/tests/test_demo_corpus_batch_contract.py` | Provider-free contract checks |
| `docs/testing/DEMO_CORPUS_BATCH_V1.md` | Harness contract |
| `docs/DEMO_RUNBOOK.md` | Operator runbook (section C1) |

## Known residual (other lane — not fixed here)

**PowerShell 7** rejects `Split-Path -LiteralPath … -Parent` (invalid parameter
set) inside `Test-ReparsePointInExistingPath` (line ~115) and the file-source
parent branch (line ~273). Proven on PS 7.6.4:

```text
Parameter set cannot be resolved using the specified named parameters.
```

Positional `Split-Path -Parent` and `[IO.Path]::GetDirectoryName` work.
Production script still fails closed on PS7 at the OutputRoot reparse walk
until that lane lands. This audit did **not** reimplement that function.

## Findings

### P0 — fixed on this branch: bare `-or` between Mandatory function calls

**Evidence:** `scripts/demo-corpus-batch.ps1` previously had:

```powershell
if (Test-PathSameOrWithin $a $b -or Test-PathSameOrWithin $c $d) { ... }
```

at the OutputRoot↔DataDir and OutputRoot↔source containment checks.

With `[Parameter(Mandatory=$true)]` on `Test-PathSameOrWithin`, PowerShell 5.1/7
parse `-or` as a **named parameter**, yielding:

```text
A parameter cannot be found that matches parameter name 'or'.
```

**Counterexample (PS 7.6.4):** unparenthesized form throws; parenthesized form
returns correctly.

**Fix:** parenthesize each call:

```powershell
if ((Test-PathSameOrWithin $a $b) -or (Test-PathSameOrWithin $c $d)) { ... }
```

**Regression:** `test_path_containment_or_operators_are_parenthesized` plus
hermetic PS proof in `tests.log`.

### P1 — fixed on this branch: source parent reparse not walked

**Evidence:** base tip only checked the source leaf `Attributes` for
`ReparsePoint`. Docs claimed alias bypass prevention for containment, but an
intermediate junction on a source path was never rejected (OutputRoot alone
used the parent walk).

**Fix:** call `Test-ReparsePointInExistingPath $sourceFull` for each source
(same helper as OutputRoot). Still depends on the known Split-Path fix to
actually run the walk on PS7.

### P2 / residuals (not blockers beyond known Split-Path)

| Item | Notes |
| --- | --- |
| Progress denominator uses `$CorpusId.Count` not pending count | Cosmetic when some corpora are timezone-blocked |
| `$args` automatic-variable shadowing for CLI arg lists | Works here; style risk only |
| Runbook C1 omits listing every chat flag (`--deadline`, `--new`, `--jsonl`) | Contract doc lists production seams; mild drift |
| “employer result” wording in contract doc | Non-functional docs tone |
| Host limit | No Windows PS 5.1 binary on this macOS implementer; PS 7.6.4 + static 5.1 review |

## Fail-closed / identity (fake CLI matrix)

With a disposable fake CLI and a local-only Split-Path workaround copy (scratch
only, not shipped):

| Scenario | Exit | Gate |
| --- | --- | --- |
| Preflight two sources | 0 | `all_required_passed=true` |
| Execute two sources | 0 | 2 triage pass; **2** chat lines (`mode=single`) |
| Duplicate `done` JSONL | 1 | triage fail |
| Wrong `chat_model` | 1 | triage fail |
| Malformed JSONL | 1 | triage fail |
| Error event | 1 | triage fail |
| Import timezone ambiguous | 1 | `needs-timezone`, no chat |
| Existing OutputRoot | 1 | throw before work |
| Serial / no retry / no auto-approve | — | contract + argv log |

## Privacy assessment

Aggregate `report.json` / `report.md` from the execute happy path (answer text
deliberately contained `password=`, `CUSTOMER LOG`, absolute private path
hints; trace contained `prof-should-not-leak`, `https://evil.example` in error
paths):

- **No** credentials, headers, endpoint URLs, prompts, raw provider bodies,
  absolute/private paths, or customer log text in aggregate reports
  (`privacy-scan.log`).
- Model id and deadline appear when `-Execute` (intentional identity binding).
- Full answer text remains under `raw-local-only/**/case-*-answer.md` only
  (documented non-share-safe).

## Mutations / counterexamples

| ID | Claim | Result |
| --- | --- | --- |
| M-or | Unparenthesized Mandatory `-or` | **Killed** (parameter name `or`) |
| M-or-fix | Parenthesized form | **Pass** |
| M-split | `Split-Path -LiteralPath -Parent` | **Killed** on PS7 (known residual) |
| M-privacy | Secrets in answer/trace | Aggregate clean; local answer retains text |
| M-failclosed | Dup done / wrong model / malformed / error / TZ | Exit 1, no false pass |

## Commands & counts

```bash
python3 -m unittest scripts.tests.test_demo_corpus_batch_contract -v
# 8 passed (incl. parser when pwsh present)

# PS 7.6.4: parser OK; -or hermetic proof; fake-CLI scenario matrix (see SCRATCH)
```

No full Rust cold-build; no live providers.

## Production diff (this branch)

1. Parenthesize containment `-or` expressions (P0).
2. Walk source parents via `Test-ReparsePointInExistingPath` (P1).
3. Contract test + doc notes for both and the known Split-Path residual.

## Blocker statement

**After the known `Split-Path -LiteralPath … -Parent` defect, no additional
release blocker was found in the harness control plane on this tip once the
P0 `-or` binding fix and P1 source parent walk are applied.** PS7 still cannot
complete a real reparse walk until the other lane lands the Split-Path fix;
that remains the sole acknowledged execution blocker for PS7 reparse checks.
