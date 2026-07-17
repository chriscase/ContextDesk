# Issue honesty rules (binding for agents)

These rules exist because the backlog was once **batch-closed without true completion**.

## Close rules

1. **Never** close an issue unless its acceptance checklist is actually met in code on `main`.
2. **Never** close epics while P0/P1 children are open or only half-implemented.
3. **Never** mass-close from a script with a generic “implemented on main” comment.
4. Closing requires, in the close comment:
   - Commit SHA(s)
   - What was verified (test names or manual steps)
   - Adversarial review outcome (approve / residual with issue #)
5. Types-only, stubs, or “UI shell exists” are **not** completion for feature issues.

## Status truth

- **Open** = not done to AC.
- **Closed** = done to AC, tested on shipped path.
- Prefer reopen over lying “done.”

## Phase order

Still Phase 0 → 1 → 2 → 3 → 4 → 5. Leave later phases open rather than half-closing them.
