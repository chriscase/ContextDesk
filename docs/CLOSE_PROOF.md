# Close-proof standard (remediation and feature issues)

Binding supplement to [`ISSUE_HONESTY.md`](./ISSUE_HONESTY.md). A closed issue
without this standard is **not** trustworthy, even if the code is correct.

## Required in every close comment

A close (or “closed with proof”) comment on a `remediation`-labeled issue **MUST**
include all three:

### (a) Correct merged commit or PR SHA

- Paste the **full** or unambiguous short SHA of the merge commit (or the PR
  number **and** its merge commit) that contains the work.
- A reviewer must be able to run `git show <sha>` and see the relevant code.
- **Wrong attribution is worse than no attribution.** Desktop/UI work must not
  cite an unrelated core commit (e.g. never cite the #101 UTF-8 fix for
  dialog/Stop host work).

```text
Merged: ee8c2f236ac97a0e1976df46189d517abce07ceb
PR: https://github.com/chriscase/ContextDesk/pull/NNN
```

### (b) Pasted verification output

- Paste **real** command output: `test result: ok. N passed…` with **test
  names**, and `clippy` / gate lines when applicable.
- For UI: click-path + screenshot or computed values (contrast ratios, etc.).
- **Not enough:** “tests pass”, “gate green”, “verified” without paste.

```text
$ cargo test -p cd-core skills -- --nocapture
test skills::tests::enable_round_trip… ok
test result: ok. 7 passed; 0 failed; …
```

### (c) Issue-specific prose

- Name the issue number and what was fixed in **this** issue’s words.
- **No** byte-identical comments copied across issues (mass-script reopens or
  closes). Close-rule 3 in ISSUE_HONESTY.md.

## Adversarial review line

Include a one-line verdict:

```text
Adversarial: CONFIRMED — <what was tried to refute and failed>
```

or keep the issue **OPEN** with:

```text
Residual: <exact unmet acceptance criterion>
```

## CI enforcement (what the guard actually checks)

`scripts/check_close_proof.sh` (CI job **close-proof**) is now blocking and
enforces the standard on the **closing comment specifically** — not merely on
"a hex SHA appears somewhere in the thread". For each remediation issue it
requires all three of:

1. **A plausible commit SHA** — a standalone **7–40 hex token containing at
   least one `a–f` letter**. Pure-decimal runs (PR numbers, dates like
   `20260718`, test counts) are **not** accepted as SHAs, and a bare `PR #NNN`
   link is not a commit reference.
2. **Pasted verification** — a line matching any of: `test result`,
   `<N> passed`, `cargo test`, `cargo clippy`, a standalone uppercase `PASS`,
   a fenced ```` ``` ```` code block, or a screenshot / image link
   (`.png/.jpg/.gif/.svg/.webp`). Bare prose — `tests pass`, `gate green`,
   `verified` — does **not** satisfy this.
3. **No duplicate closing body** — two *different* issues sharing a
   byte-identical closing comment are flagged as the scripted #180 anti-pattern.

### Cutoff (no retroactive breakage)

The live check hard-fails **only** issues closed **strictly after**
`CLOSE_PROOF_CUTOFF` (default **2026-07-18**). All remediation history to date
was closed on or before that date, so turning the guard on does not
retroactively break already-closed issues; enforcement applies to closes made
**2026-07-19 onward**. Override the boundary with the `CLOSE_PROOF_CUTOFF`
environment variable.

### How to run it

```text
sh scripts/check_close_proof.sh --offline          # self-tests: matchers + dup detection
sh scripts/check_close_proof.sh --fixture scripts/fixtures/close_proof_sample.json
sh scripts/check_close_proof.sh --fixture scripts/fixtures/close_proof_dupes.json
sh scripts/check_close_proof.sh                    # + live sample (needs gh + token)
```

The offline fixtures include a SHA-**without**-pasted-proof case (must be
rejected) and a duplicate-body case (must be flagged). Dependencies are kept
light: POSIX `sh` + `gh` + `jq`.
