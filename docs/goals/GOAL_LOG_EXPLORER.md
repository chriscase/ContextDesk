# Goal: Log Investigation Workspace

**Epic:** https://github.com/chriscase/ContextDesk/issues/480  
**Design:** `docs/design/LOG_EXPLORER.md`  
**Repo:** chriscase/ContextDesk  
**Priority:** P1 · area-logs / area-ui / area-desktop / area-core · **ux-expert bar**

## Mission

Build a **multi-window Log Explorer** for heavy engineering troubleshooting with AI:

1. Deep, virtualized exploration of **DuckDB analysis corpora** (already ingested via Logs tab).
2. **Inline chat column** using **optimized** log contexts (tools, filters, selection — never dump paste).
3. Agent **awareness of what the engineer is looking at**, with opt-in **navigation links** into the viewer.
4. **Bookmarks** for lines and ranges.
5. **2–4 evidence lanes** with optional **timestamp-linked scroll** and **gap visualization** for multi-source reconstruction.
6. **Responsive** layouts that use full ultrawide real estate (resizable panes, density modes).

Logs **tab remains the library** (import folder/zip/package, stats, open explorer). Explorer is the deep workspace.

## Locked owner decisions

| # | Decision |
|---|----------|
| 1 | Chat **inline in v1**; smart/optimized corpus context; agent can propose **log_nav** links user may follow |
| 2 | Bookmarks for interesting **lines and ranges** |
| 3 | **2–4 lanes**, responsive at any size, full glass when available |
| 4 | **Any chat** may link via `linkedCorpusId`; explorer lists all |

## Child issues (implement roughly in order)

| Issue | Scope |
|-------|--------|
| #481 | Design wireframes + view-context + log_nav schema |
| #482 | DuckDB query API (paged events, facets, search, bookmarks) |
| #483 | Multi-window shell + single-lane grid + filters |
| #484 | Chat column + corpus-linked sessions + nav links |
| #485 | Bookmarks |
| #486 | Multi-lane + ts-link + gaps |
| #487 | Ultrawide UX polish + a11y gate |

**Usable milestone:** #481–#484  
**Flagship multi-source:** +#486  
**Bookmarks + search depth polish:** +#485, remaining #482 search, #487  

## Architecture constraints

- Reuse existing corpus layout: DuckDB `events` + templates + vectors (`LOG_ANALYSIS.md`).
- **Template-first semantic search** — do not embed every line in v1.
- Paged/keyset queries only; virtualize UI; hard IPC page caps.
- Honest **time quality** (wall vs order_only); never show synthetic seq as calendar time unlabeled.
- Redacted messages only; SoftWrite only where appropriate (bookmarks/session link).
- Large dumps stay on **corpus** path — not session-context 200-file pack.

## Chat / agent contract

- View context each turn when explorer-focused: corpusId, filters, time range, lane sources, selection (capped), bookmarks summary.
- Tools use host active corpus / explicit id; do not ask user for corpus id if linked.
- `log_nav` proposals render as chips; **opt-in** apply (sources, time window, highlight seq).

## UX bar

- Three breakpoints: narrow / normal / ultrawide.
- Ultrawide: filters | multi-lane | chat rail (+ optional timeline strip).
- Resizable splitters; density comfortable/compact.
- #487 blocks epic close: screenshots laptop + ultrawide, contrast, keyboard basics.

## Non-goals

Live tail, multi-corpus merge, SIEM, unredacted secrets, line-level embeddings, raising chat-pack limits as the dump path.

## Definition of done

- [ ] #480–#487 closed with tests + CLAIMS/Help as needed  
- [ ] Demo path: multi-file corpus → explorer window → filter/search → 2 linked lanes with gaps → chat answers with tools → nav link opens range → bookmarks persist  
- [ ] No fake wall-clock timestamps without labels  
- [ ] UX gate (#487) passed  

## Implementation notes

- Prefer worktrees for parallel children when independent.
- Verify: `cargo test -p cd-core --lib log_analysis`, desktop vitest, tauri check, multi-window smoke if environment allows.
- Inventory main: do not reimplement ingest; extend query APIs and UI.
EOF

gh issue comment 480 --repo chriscase/ContextDesk --body "$(cat <<'EOF'
## Child issues

| Issue | Scope |
|-------|--------|
| #481 | Design wireframes + view-context + `log_nav` schema |
| #482 | DuckDB query API (paged events, facets, search, bookmarks) |
| #483 | Multi-window shell + virtualized single-lane grid + filters |
| #484 | Inline chat column, corpus-linked sessions, agent nav links |
| #485 | Bookmarks (line + range) |
| #486 | 2–4 lanes + timestamp link + gap visualization |
| #487 | Responsive ultrawide UX polish + a11y gate |

**Design doc:** `docs/design/LOG_EXPLORER.md`  
**Goal prompt:** `docs/goals/GOAL_LOG_EXPLORER.md`

### Owner locks (2026-07-25)

- Chat **inline v1** + optimized contexts + agent **nav links** (opt-in)
- Bookmarks line/range
- **2–4** lanes, responsive ultrawide
- **Any chat** may set `linkedCorpusId`
EOF
)"

# Commit design + goal on a branch
cd /Users/chriscase/Documents/GitHub/ContextDesk && \
git checkout -b docs/log-explorer-design 2>&1 && \
git add docs/design/LOG_EXPLORER.md docs/goals/GOAL_LOG_EXPLORER.md && \
git commit -m "$(cat <<'EOF'
docs: Log Investigation Workspace design + goal (#480)

Owner-locked multi-window explorer: chat rail, 2–4 time-linked lanes,
bookmarks, agent nav links, ultrawide-responsive layout. Epic #480.
EOF
)" && git push -u origin HEAD 2>&1 && \
gh pr create --repo chriscase/ContextDesk --base main --head docs/log-explorer-design \
  --title "docs: Log Investigation Workspace design + goal (#480)" \
  --body "Design contract + goal prompt for epic #480 (Log Explorer multi-window, chat, lanes). No runtime code." 2>&1
<|tool_call_begin|>
run_terminal_command
command
cd /Users/chriscase/Documents/GitHub/ContextDesk && gh issue list --search "Log Explorer OR Log Investigation" --limit 10 2>&1
description
List filed Log Explorer issues