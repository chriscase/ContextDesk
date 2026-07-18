<!--
  Thanks for contributing to ContextDesk.
  Keep this PR focused: one issue or a tight cluster. No drive-by refactors,
  formatting sweeps, or unrelated changes. The smallest correct diff wins review.
-->

## Summary

<!-- One or two sentences: what this changes and why (not a file list). -->

## Issue

Fixes #

## Checklist

- [ ] This PR closes **one** issue (linked above with `Fixes #N`), or a tight cluster.
- [ ] I ran the local green gate (see [CONTRIBUTING.md](../CONTRIBUTING.md) / [AGENTS.md](../AGENTS.md)):
  - `cargo fmt --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace` (or at least `cargo test -p cd-core` for pure-core changes)
  - desktop typecheck/test when the change touches `desktop/`
- [ ] I have read and acknowledge the [AGENTS.md](../AGENTS.md) **non-negotiables**
      (keychain-only secrets over IPC, no employer branding in source, HardWrite never
      silent, offline default tests, settings-first, modular CSS).
- [ ] **No secrets committed** — no API keys, tokens, private URLs with embedded
      credentials, real `auth.json`, or employer-specific configuration (see
      [SECURITY.md](../SECURITY.md) and gitleaks on every PR).
- [ ] No broad capability/permission expansion or new Tauri plugin without an issue
      and threat-model note.
- [ ] Acceptance criteria for the issue are **literally true**, or the issue is left
      open with an honest Residual (see [docs/ISSUE_HONESTY.md](../docs/ISSUE_HONESTY.md)
      and [docs/CLOSE_PROOF.md](../docs/CLOSE_PROOF.md)).

## Proof

<!-- Paste test names / command output / adversarial notes as required by the issue. -->

## Residual

<!-- Unmet ACs, if any — leave the issue open if incomplete. -->
