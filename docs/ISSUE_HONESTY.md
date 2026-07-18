# Issue honesty rules (binding for agents)

These rules exist because the backlog was once **batch-closed without true completion**.

## Close rules

1. **Never** close an issue unless its acceptance checklist is actually met in code on `main`.
2. **Never** close epics while P0/P1 children are open or only half-implemented.
3. **Never** mass-close from a script with a generic “implemented on main” comment.
   **Never** post byte-identical reopen/close comments across issues (tracker theater).
4. Closing requires the full **close-proof standard** in [`CLOSE_PROOF.md`](./CLOSE_PROOF.md):
   - **(a)** Correct merged commit/PR SHA (verifiable with `git show`) — not a related-but-wrong SHA
   - **(b)** Pasted verification output (real `test result: ok` lines / clippy / UI click-path)
   - **(c)** Issue-specific prose (no copy-paste mass comments)
   - Adversarial review outcome: CONFIRMED, or leave OPEN with Residual
5. Types-only, stubs, or “UI shell exists” are **not** completion for feature issues.

CI: `scripts/check_close_proof.sh` enforces (a) for recently closed `remediation` issues
and offline fixtures that prove the checker fails without a SHA (#254).

## Status truth

- **Open** = not done to AC.
- **Closed** = done to AC, tested on shipped path.
- Prefer reopen over lying “done.”

## Phase order

Still Phase 0 → 1 → 2 → 3 → 4 → 5. Leave later phases open rather than half-closing them.
