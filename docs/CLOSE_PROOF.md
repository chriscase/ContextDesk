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

### (d) Agent kind + model (attribution)

For later analysis of which automation completed the work:

- Apply labels: `agent:<kind>` and `model:<slug>` (see [`AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md)).
- Helper: `scripts/tag-issue-agent.sh -r ContextDesk -i N --kind grok-build --model grok-4.5 --comment`
- Include in the close comment:

```text
Agent: grok-build
Model: grok-4.5
```

Kinds: `grok-build` | `claude-code` | `copilot` | `cursor` | `codex` | `human` | `other`.
If the model slug is unknown, use `model:unknown` and `Model: unknown`.

## Adversarial review line

Include a one-line verdict:

```text
Adversarial: CONFIRMED — <what was tried to refute and failed>
```

or keep the issue **OPEN** with:

```text
Residual: <exact unmet acceptance criterion>
```

## Native packaged proof

Several issues require "native packaged proof" or "packaged native acceptance".
That phrase means all of the following. Component tests, `vitest`, and DOM-level
automation are necessary but **never** sufficient for it, because they cannot
observe the packaged shell, the real window manager, or OS-level input.

1. **Built from the cited merged SHA.** The build comes from the same
   current-`main` commit named in section (a). A build from a feature branch, a
   local dirty tree, or a dev server is not native proof. State the SHA the
   build came from.
2. **Exact artifact identified.** Name the package or binary actually launched
   (file name and platform). "The app" is not an artifact.
3. **Exercised natively.** Drive the packaged application through OS-level
   input — Computer Use, or a human at the keyboard. DOM-only automation,
   in-browser dev servers, and headless drivers do not qualify. Say which was
   used.
4. **Corpus and prior state identified.** Name the corpus or fixture, its size,
   and the relevant pre-existing state (existing rules, findings, attachments,
   or a clean profile). "A large corpus" is not identification.
5. **Observations recorded separately from automated tests.** Keep the native
   observation list distinct from pasted `cargo test` / `vitest` output. A
   reader must be able to tell what a machine asserted from what a person or
   agent saw.
6. **Mutations and non-mutations both verified.** State what changed *and* what
   was confirmed unchanged — the second half is usually the real claim (filters
   untouched, evidence preserved, counts identical, original files unmodified).
7. **Relaunch checked where persistence is claimed.** If the issue claims
   anything durable, quit and relaunch the packaged app, reopen the same
   corpus, and record what survived. Reopening a window is not a relaunch.
8. **Native defects block closure.** A defect visible only in the packaged app
   — a popover that will not dismiss, a click the shell swallows, a window that
   opens blank — keeps the issue **OPEN** with a `Residual:` line, even when
   every automated gate is green.
9. **Signing failures are reported honestly.** If packaging or launch fails for
   want of a signing key or notarization, say so plainly and leave the issue
   open. Do **not** request, create, borrow, export, paste, or fabricate a key,
   and do not present an unsigned or ad-hoc-signed run as a signed one. Record
   which platform could not be proven and why.

If any item cannot be satisfied, name it in the `Residual:` line rather than
weakening the claim. Partial native proof stated exactly is worth more than
complete native proof implied.

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
