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

## CI enforcement

`scripts/check_close_proof.sh` (see CI job **close-proof**) validates recently
closed `remediation` issues for a hex SHA in the close/timeline comments, and
runs offline fixtures that must fail when SHA is missing.
