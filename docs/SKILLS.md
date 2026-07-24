# Skills — playbooks for agent turns

Skills are markdown playbooks injected into the agent context. They **never** grant SoftWrite/HardWrite or expand allowlists ([`AGENTS.md`](../AGENTS.md)).

## Install / discover

1. Put a folder with `SKILL.md` under:
   - App config `skills/` directory, or
   - Workspace root `skills/`, or
   - Copy from [`examples/skills/`](../examples/skills/) (e.g. `log-triage`)
2. Enable write-claiming skills in **Settings → Skills** (they start disabled).
3. Pin a skill on a chat from the chat chrome (session pin) **or** type `/skill <id> …` for one turn.

## Frontmatter

```yaml
---
id: my-triage
name: My triage
description: Short catalog line
disabled: false
allows_write: false
---
```

- `allows_write: true` only documents that the playbook *talks about* writes; the host still requires SoftWrite Accept for tools.
- `disabled: true` hides the skill from the agent catalog until enabled in Settings.

## Pin vs slash

| Mode | Behavior |
|------|----------|
| **Session pin** | Every turn in that chat injects the skill playbook until unpinned (#343). |
| **`/skill <id> rest`** | One-shot inject for that turn; overrides pin for injection order. |

## Example: log triage

See [`examples/skills/log-triage/SKILL.md`](../examples/skills/log-triage/SKILL.md). Pair with **session context packs** (drop logs/zips onto the chat) for incident RCA.

## Writing a custom triage skill

1. Copy `examples/skills/log-triage/`.
2. Change `id` / `name` / method steps for your domain.
3. Keep `allows_write: false` unless the playbook is purely instructional about writes.
4. Drop under workspace `skills/` and pin on the chat.
