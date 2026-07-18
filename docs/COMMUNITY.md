# Community & repository settings

Code-managed community health files live in the repo. Some GitHub **repo
settings** require a human operator with admin access and cannot be applied by
an automated agent.

## In-repo (this PR / main)

| Artifact | Purpose |
|----------|---------|
| `.github/ISSUE_TEMPLATE/*` | Bug / feature forms; security contact → `SECURITY.md` |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist + honesty / gate reminders |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `CONTRIBUTING.md` | How to build, test, and open PRs |
| `SECURITY.md` | Private vulnerability reporting |

## Operator checklist (residual — not automated)

These steps need a repo admin in GitHub **Settings**:

1. **Private vulnerability reporting** — Security → Private vulnerability reporting → Enable  
   (documentated in `SECURITY.md`; required for Advisories intake.)
2. **Discussions** (optional) — Features → Discussions → Enable if you want Q&A outside issues.
3. **Topics** — Suggested: `rust`, `tauri`, `llm`, `rag`, `knowledge-base`, `local-first`, `ai-assistant`, `mcp`.
4. **Homepage URL** — set to the public docs or project site when one exists.
5. **Issue labels** — ensure `bug`, `enhancement`, and any `area-*` labels used by templates exist (create if missing).

## Contact

- Security: see [SECURITY.md](../SECURITY.md)
- Conduct: same private maintainer channel as security / repo owner
