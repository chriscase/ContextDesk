# Community & repository settings

Code-managed community health files live in the repo. Some GitHub **repo
settings** require a human operator with admin access and cannot be applied by
an automated agent.

## In-repo (shipped on main)

| Artifact | Purpose |
|----------|---------|
| `.github/ISSUE_TEMPLATE/*` | Bug / feature forms; security contact → `SECURITY.md` |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist + honesty / gate reminders |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `CONTRIBUTING.md` | How to build, test, and open PRs |
| `SECURITY.md` | Private vulnerability reporting |

Issue and PR templates incorporate community contributions (including PR #199)
so first-time reporters get structured forms and secret-redaction warnings
without having to discover AGENTS.md first.

## Operator checklist (residual — not automated)

These steps need a repo admin in GitHub **Settings**. Per
[ISSUE_HONESTY.md](ISSUE_HONESTY.md), they stay residual until an owner confirms
each is toggled on — a PR cannot complete them.

1. **Private vulnerability reporting** — Security → Private vulnerability reporting → Enable  
   (documented in `SECURITY.md`; required for Advisories intake.)
2. **Discussions** (optional) — Features → Discussions → Enable if you want Q&A outside issues.  
   The issue-template “Ask a question” link points here; until enabled it may 404 — use a short
   `[question]` issue as fallback (see `.github/ISSUE_TEMPLATE/config.yml`).
3. **Topics** — Suggested: `rust`, `tauri`, `llm`, `rag`, `knowledge-base`, `local-first`,
   `ai-assistant`, `mcp`.
4. **Homepage URL** — set to the public docs or project site when one exists.
5. **Issue labels** — ensure `bug`, `enhancement`, and labels matching the feature-request
   form exist (create if missing).

## Contact

- Security: see [SECURITY.md](../SECURITY.md)
- Conduct: same private maintainer channel as security / repository owner
  ([@chriscase](https://github.com/chriscase) via GitHub)
