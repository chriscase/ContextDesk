## Summary

<!-- What changed and why (not a file list). -->

## Issue

Fixes #

## Checklist

- [ ] I ran the local green gate (see [CONTRIBUTING.md](../CONTRIBUTING.md) / [AGENTS.md](../AGENTS.md)):
  - `cargo fmt --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace` (or at least `cargo test -p cd-core` for pure-core changes)
- [ ] No secrets, tokens, private URLs, or employer-specific config committed
- [ ] AGENTS.md non-negotiables respected (keychain-only secrets over IPC, HardWrite never silent, offline default tests)
- [ ] Acceptance criteria for the issue are **literally true** or the issue is left open with an honest Residual (see [docs/ISSUE_HONESTY.md](../docs/ISSUE_HONESTY.md))

## Proof

<!-- Paste test names / command output / adversarial notes as required by the issue. -->

## Residual

<!-- Unmet ACs, if any — leave the issue open if incomplete. -->
