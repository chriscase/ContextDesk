# Backlog audit (honest status vs code on main)

Legend: **DONE** = AC met + tests | **PARTIAL** = real code, AC incomplete | **TODO** = missing or stub

Last audit: 2026-07-17 (Phase 0–5 pass). Update when closing.

## Phase 0 — Foundation

| # | Title | Status | Notes |
|---|--------|--------|-------|
| 1 | Epic Foundation | DONE | CI green; branding; AGENTS/docs; Phase 0 children closed |
| 11 | CI fmt/clippy/test | DONE | Closed honestly; CI green a444fdb |
| 12 | Tauri shell + theming | DONE | tokens/themes; theme toggle; branding host; no inline style soup |
| 13 | RENAME.md | DONE | `docs/RENAME.md` |
| 57 | Threat model | DONE | `docs/THREAT_MODEL.md` living doc |
| 59 | Workspace roots UX | DONE | chip + picker + block send; refuse whole-home |
| 60 | Keychain secrets | DONE | Keychain store + save_active_provider; refs only; DEV.md service names |
| 66 | gitleaks CI | DONE | Workflow + FP process in DEV.md; .gitleaks.toml |
| 67 | Tauri capability lockdown | DONE | default.json minimal; AGENTS checklist; no secret-return IPC |
| 68 | Epic Settings/preflight | DONE | Children #69–#74 honestly closed (when marked DONE below) |
| 69 | Settings shell | DONE | Nav, unsaved guard, Escape, no secrets in full |
| 70 | Preflight screen | DONE | Host run_preflight; embed/grok presence; recheck; no secrets |
| 71 | Form system | DONE | forms/* + forms.css + debounce + a11y |
| 73 | Workspace settings form | DONE | Tauri folder dialog + validate_workspace_path |
| 74 | First-run guided setup | DONE | Auto-open preflight; progress; continue-anyway banner |

## Phase 1 — MVP

| # | Title | Status | Notes |
|---|--------|--------|-------|
| 2 | Epic providers | DONE | Phase1 children closed; #19 deferred Phase2 |
| 3 | Epic tools | DONE | host+grants+audit closed |
| 4 | Epic KB/agent | DONE | tools+agent+citations+router+golden |
| 5 | Epic desktop UI | DONE | stream+tools+composer+sessions |
| 14 | Profile model | DONE | ProviderProfile + AppConfig save/load + tests |
| 15 | Gateway probe | DONE | URL expand + host probe_url; model list residual thin |
| 16 | OpenAI chat+tools | DONE | non-stream + SSE parse/fixtures; research uses stream w/ fallback |
| 17 | Ollama | DONE | tags + chat + health; embed optional |
| 18 | Local discovery | DONE | discover_local + Settings candidates list |
| 19 | Grok session | PARTIAL | Phase2 deferred; presence-only in Phase1 |
| 20 | AI settings UI | DONE | discover candidates + probe; no secrets full |
| 21 | Tool host | DONE | Read auto; Soft/Hard grant; hard_write_blocked test |
| 22 | Permission grants | DONE | PermissionRequired + grant matrix tests |
| 23 | Permission modal UI | DONE | Blocking modal; preview; allow once/session; type-confirm |
| 24 | Audit log | DONE | JSONL + scrub |
| 25 | MVP tools | DONE | search/read/save + allowlist + line caps |
| 26 | Indexer | DONE | reindex; secret skip; size/depth caps |
| 27 | Agent loop | DONE | profile + events + cancel + mock/scripted tests |
| 28 | Citations UI | DONE | chips + trail + markdown #cite links |
| 29 | Router budgets | DONE | rank + trail + tests |
| 30 | Streaming markdown | DONE | progressive text_delta + MarkdownBody + materialize |
| 31 | Compact tools UI | DONE | status icons; collapse threshold 4 |
| 32 | Composer | DONE | expand; Enter/Shift+Enter; stop SVG; list/code assist |
| 33 | Compaction | DONE | core + UI compact; history retained |
| 34 | Multi-session tabs | DONE | session tabs + per-session state |
| 35 | SVG icons | DONE | icons.tsx used across UI |
| 58 | Golden harness | DONE | golden_research offline |
| 61 | SSRF | DONE | Unit tests + probe_url policy + DEV.md override |
| 62 | Injection | DONE | wrap_untrusted + gate test; write skills disabled |
| 63 | Path policy | DONE | symlink escape; .env deny; no root session grant |
| 64 | Egress/local-only | DONE | titlebar badge + refuse remote when local-only |
| 65 | Phase 1 DoD | DONE | fixtures+grants+CI offline; README/ROADMAP linked |
| 72 | AI form live probe | DONE | validation; test connection; keychain save; local-only |

## Phase 2+

| # | Status |
|---|--------|
| 6–7, 36–43 | PARTIAL / TODO |
| 8, 44–48 | PARTIAL (SQL real; MCP/HTTP/Confluence lib + settings; product loops incomplete) |
| 9–10, 49–53 | PARTIAL |
| 54–56 | TODO / PARTIAL |
| 75 | PARTIAL | Confluence settings UI shipped; end-to-end search in agent incomplete |

## Close policy

Only move DONE → closed after re-verification + adversarial note. Do not bulk-update this table to DONE without proof.


## Phase 2–5 (post DoD)

Skills/panes/connectors/server/embed/packaging closed with residual notes on issues. #19 Grok opt-in library closed with residual live refresh.
