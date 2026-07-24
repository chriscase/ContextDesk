# Goal: In-app Help & Documentation Center

Paste the **Goal prompt** (fenced block at the bottom) into Grok Build `/goal` or another agent after `git pull` on `main`.

Epic: [#434](https://github.com/chriscase/ContextDesk/issues/434)

## Issue map

| Order | Issue | Focus |
|------:|-------|--------|
| 1 | [#435](https://github.com/chriscase/ContextDesk/issues/435) | Design `docs/design/HELP_CENTER.md` |
| 2 | [#436](https://github.com/chriscase/ContextDesk/issues/436) | Corpus + SVG seed topics |
| 3 | [#437](https://github.com/chriscase/ContextDesk/issues/437) | `HelpIndex` + hybrid search |
| 4 | [#438](https://github.com/chriscase/ContextDesk/issues/438) | Help pane UI |
| 5 | [#439](https://github.com/chriscase/ContextDesk/issues/439) | Agent tools + citations |
| 6 | [#440](https://github.com/chriscase/ContextDesk/issues/440) | Discovery / deep links |
| 7 | [#441](https://github.com/chriscase/ContextDesk/issues/441) | Full content + CLAIMS |

## Honesty

Follow `docs/CLOSE_PROOF.md` and `docs/ISSUE_HONESTY.md`. Never claim unshipped product features as current capability in Help content. Prefer `integrate/help-center` multi-step work then one promote PR.

---

## Goal prompt (copy from here)

```
You are implementing ContextDesk epic #434: In-app Help & Documentation Center (searchable, visual, agent-grounded).

Workspace: ContextDesk — pull latest main. Follow AGENTS.md / Claude.md standing authorizations (branches, PRs, merge after green CI). Never log secrets; redact corp hosts in issues/PRs.

## Honesty / proof (non-negotiable)
- Close each child only with CLOSE_PROOF: merge SHA or PR URL, pasted test/UI proof with names, issue-specific prose, Adversarial: CONFIRMED — … (docs/CLOSE_PROOF.md)
- docs/CLAIMS.md: only Shipped when true on main with path:symbol
- Help content must not claim unshipped features (cross-check docs/CLAIMS.md + README honesty)
- Prefer integrate/help-center batch; promote once to main with full CI (docs/AGENT_WORKFLOW.md)
- Tag closes with agent/model labels (scripts/tag-issue-agent.sh)
- If blocked on a product fork not locked below, AskUserQuestion once with 2–4 options

## Locked product decisions
1. Curated bundled corpus (default path docs/help/) — NOT a dump of all repo docs/
2. Keyword search always; hybrid semantic scoring when EmbedBackend available; hermetic tests without model download
3. New PaneId "help" — professional docs browser (nav + reader + scored search + SVG diagrams)
4. Agent: Read-tier search_help + read_help with help:// citations; NO SoftWrite help authoring; NO ambient full-help inject by default (budget)
5. Visual bar: every non-trivial process page includes ≥1 SVG flowchart/architecture diagram and/or decision tables
6. Reuse VectorIndex / hybrid patterns; do not mix help into durable memory SQLite or require workspace allowlist for product help

## Children (implement in order; shippable PRs)

### #435 Design (first)
Write docs/design/HELP_CENTER.md: IA, frontmatter, chunking, search fusion, citation scheme, UI bar, packaging into Tauri, phased PR plan. Merge design before large UI if possible (or same stack PR1).

### #436 Corpus foundation
docs/help/ tree + author README + frontmatter validation + SVG conventions under assets/.
Seed pages MINIMUM:
- Product overview
- First-run (workspace, AI, prelaunch)
- Chat / citations / context budget
- Permissions (read/soft/hard)
- Log analysis full pipeline with SVG + tool table (ingest→parse→redact→Drain→DuckDB→template embed→cluster/timeline/why)
- Memory honest overview
- Skills + session context packs
Align with shipped CLAIMS only.

### #437 HelpIndex (cd-core)
Load corpus; keyword ranked search + hybrid when embed present; read by id; fixture tests; public API for Tauri + ToolHost.

### #438 Help pane (desktop)
Professional HelpPane: section nav, reader typography, sticky TOC, search with score affordance, trusted local SVG, deep links, dark theme, a11y. Wire PaneTabs.

### #439 Agent grounding
search_help + read_help Read tools; trail + citations; click opens Help pane; bounded snippets; offline tool tests.

### #440 Discovery
Command palette Open/Search Help; safe keyboard shortcut; ≥3 contextual Learn more entry points (Logs empty, Memory empty, Settings/AI or permissions).

### #441 Completeness + CLAIMS
Expand topics (connectors, Confluence harvest, S3 backup honesty, security, troubleshooting, glossary, architecture). SVG/tables on process pages. CLAIMS rows. Close #434 only when children proven.

## Execution tips
- Dual Cargo.lock if cd-core deps change (root + desktop/src-tauri)
- Desktop packaging: bundle help corpus as app resource; keyword path works offline
- Reference design docs for accuracy (docs/design/LOG_ANALYSIS.md, MEMORY.md, etc.) but write user-facing prose
- UX: match existing CSS variables / calm chrome; Help should feel like a polished product docs site, not a file browser
- Tests: hermetic cargo test + vitest for pane search/nav smoke

## Done when
- #435–#439 closed with proof (minimum bar for demo)
- Help search “log analysis” shows pipeline page with diagram
- Chat can answer how log triage works with help:// citations
- #440–#441 done or residual explicitly documented on epic
```
