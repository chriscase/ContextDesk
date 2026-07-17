# Backlog audit (honest status vs code on main)

Legend: **DONE** = AC met + tests | **PARTIAL** = real code, AC incomplete | **TODO** = missing or stub

Last audit: 2026-07-17 (after reopen). Update when closing.

## Phase 0 — Foundation

| # | Title | Status | Notes |
|---|--------|--------|-------|
| 1 | Epic Foundation | PARTIAL | Docs/CI/core exist; epic open until children honest |
| 11 | CI fmt/clippy/test | DONE | Closed honestly; CI green a444fdb |
| 12 | Tauri shell + theming | PARTIAL | Tauri host + CSS themes; not full packaging |
| 13 | RENAME.md | DONE | `docs/RENAME.md` |
| 57 | Threat model | DONE | `docs/THREAT_MODEL.md` living doc |
| 59 | Workspace roots UX | PARTIAL | Settings form; native picker incomplete |
| 60 | Keychain secrets | PARTIAL | Keychain store + Tauri cmds; more IPC scrubbing |
| 66 | gitleaks CI | PARTIAL | Job in workflow; needs green run confirmation |
| 67 | Tauri capability lockdown | PARTIAL | capabilities/default.json; CSP set |
| 68 | Epic Settings/preflight | PARTIAL | Shell exists |
| 69 | Settings shell | PARTIAL | Sections incl. Connectors |
| 70 | Preflight screen | PARTIAL | UI + cd-core + host probe |
| 71 | Form system | PARTIAL | Field components |
| 73 | Workspace settings form | PARTIAL | Path prompt not native dialog |
| 74 | First-run guided setup | PARTIAL | Opens preflight if blocking |

## Phase 1 — MVP

| # | Title | Status | Notes |
|---|--------|--------|-------|
| 2 | Epic providers | PARTIAL | |
| 3 | Epic tools | PARTIAL | |
| 4 | Epic KB/agent | PARTIAL | |
| 5 | Epic desktop UI | PARTIAL | |
| 14 | Profile model | PARTIAL | ProviderProfile + AppConfig |
| 15 | Gateway probe | PARTIAL | expand + SSRF; live model list incomplete |
| 16 | OpenAI chat+tools | PARTIAL | Client + parse tests; stream incomplete |
| 17 | Ollama | PARTIAL | Client + health |
| 18 | Local discovery | PARTIAL | discover_local |
| 19 | Grok session | PARTIAL | Module + host pin; full wire incomplete |
| 20 | AI settings UI | PARTIAL | Form exists |
| 21 | Tool host | PARTIAL | Real tools + grants |
| 22 | Permission grants | PARTIAL | request-bound |
| 23 | Permission modal UI | PARTIAL | Mounted + wired |
| 24 | Audit log | PARTIAL | JSONL |
| 25 | MVP tools | PARTIAL | search/read/save |
| 26 | Indexer | PARTIAL | keyword |
| 27 | Agent loop | PARTIAL | research_local + scripted |
| 28 | Citations UI | PARTIAL | chips + hostReadFile |
| 29 | Router budgets | PARTIAL | module |
| 30 | Streaming markdown | PARTIAL | basic; not full md render |
| 31 | Compact tools UI | PARTIAL | |
| 32 | Composer | PARTIAL | expand works |
| 33 | Compaction | PARTIAL | sessions module; UI thin |
| 34 | Multi-session tabs | TODO/PARTIAL | single session mostly |
| 35 | SVG icons | PARTIAL | icons.tsx |
| 58 | Golden harness | PARTIAL | fixtures + tests |
| 61 | SSRF | PARTIAL | strong unit tests |
| 62 | Injection | PARTIAL | wrap_untrusted |
| 63 | Path policy | PARTIAL | |
| 64 | Egress/local-only | PARTIAL | profile flag; UI badge weak |
| 65 | Phase 1 DoD | TODO | not honestly closable yet |
| 72 | AI form live probe | PARTIAL | |

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
