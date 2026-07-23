# Agent workflow — integration branches + attribution

Binding companion to [`AGENTS.md`](../AGENTS.md), global `~/Documents/GitHub/Claude.md`,
[`ISSUE_HONESTY.md`](./ISSUE_HONESTY.md), and [`CLOSE_PROOF.md`](./CLOSE_PROOF.md).

Applies to **all** agent kinds that touch this repo: Grok Build, Claude Code,
GitHub Copilot, Cursor, Codex, and humans.

## Why integration branches

Opening a PR to `main` after every micro-fix:

- Burns a full CI matrix each time
- Lands half-states on `main` when a goal is multi-PR by accident
- Makes skeptic “follow-up fix” PRs common (extra CI)

**Default for multi-step goals:** land work on `integrate/<slug>`, promote once.

## Branch layout

```text
main
 └── integrate/<slug>          # batch for one goal / epic slice
      ├── commits from any agent
      └── optional wip/<agent>/<topic> folded in
           ↓  integrate-promote (one PR, full CI)
         main
```

Examples:

| Slug | Branch |
|------|--------|
| Confluence epic finish | `integrate/confluence-326` |
| Launch surface | `integrate/launch-surface` |
| Hotfix alone | skip integrate — direct `fix/…` → `main` |

**Do not** use one eternal shared `dev` for all goals — parallel goals collide.
Use a **new slug per batch**.

## Commands (from `~/Documents/GitHub/scripts`)

```bash
# Start batch (optional worktree keeps main checkout free)
scripts/integrate-setup.sh contextdesk confluence-326 --worktree

# … agents commit on integrate/confluence-326; local gate …

# Promote once when batch is coherent
scripts/integrate-promote.sh contextdesk confluence-326 --merge --cleanup

# Attribute completing agent + model (required on close)
scripts/tag-issue-agent.sh -r ContextDesk -i 403 \
  --kind grok-build --model grok-4.5 --comment
```

Env defaults: `AGENT_KIND`, `AGENT_MODEL`.

## Agent kinds → labels

| Kind | Label |
|------|--------|
| Grok Build | `agent:grok-build` |
| Claude Code | `agent:claude-code` |
| GitHub Copilot | `agent:copilot` |
| Cursor | `agent:cursor` |
| OpenAI Codex | `agent:codex` |
| Human | `agent:human` |
| Other automation | `agent:other` |

Model: `model:<slug>` (e.g. `model:grok-4.5`). Use `model:unknown` if slug not known.

Create the standard set on a fork/clone:

```bash
scripts/tag-issue-agent.sh -r ContextDesk --ensure-labels
```

## Close-proof still required

Integration workflow does **not** relax honesty:

1. Issue stays open until AC is true **on `main`** (after promote), not merely on `integrate/*`.
2. Close comment includes SHA + pasted verification + issue-specific prose ([`CLOSE_PROOF.md`](./CLOSE_PROOF.md)).
3. Close comment also includes **Agent** and **Model** lines; labels applied via `tag-issue-agent.sh`.

## Coordination

- Parallel agents on the **same** `integrate/<slug>`: use `scripts/agent-lock.sh`.
- Parallel **goals**: different slugs (`integrate/foo` vs `integrate/bar`).
- Prefer not drive-by unrelated crates (e.g. cd-server/telegram) unless the goal requires it.

## CI policy (intent)

| Target | CI |
|--------|-----|
| PR → `main` | Full gate (required) |
| Work on `integrate/*` | Local gate required; GitHub CI optional/light |
| Direct hotfix PR → `main` | Full gate (same as today) |

Workflow YAML may later skip heavy jobs for non-`main` bases; until then, **avoid opening PRs** to `main` until promote time.
