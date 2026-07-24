# Goal: Seamless Confluence integration (epic #452)

Paste the **Goal prompt** (fenced block at the bottom) into Grok Build `/goal` or another agent after `git pull` on `main`.

Epic: [#452](https://github.com/chriscase/ContextDesk/issues/452)

## Already shipped (do not re-do)

| Item | Status |
|------|--------|
| RO tools (search, get_page, list_children, ancestors, attachments) | On main (#326 PR1) |
| Harvest SoftWrite + allowlist for harvest/write (#430) | On main |
| Tool-name sanitize for `<\|channel\|>…` leakage | #451 / PR #453 |
| Harvest browser / publish (with residuals) | #326 design PRs shipped |

## Related

- #326 Confluence harvest (mostly done; residuals in design gap doc)
- #430 harvest allowlist policy (by design — improve UX only)
- #451 tool name corruption (fixed)
- Help Center #434 — optional deep links from Settings/errors to Help when present

## Honesty

`docs/CLOSE_PROOF.md` · `docs/ISSUE_HONESTY.md` · prefer `integrate/seamless-confluence` then promote once CI green.

---

## Goal prompt (copy from here)

```
You are implementing ContextDesk epic #452: Seamless Confluence integration (RO browse, spaces, errors, UX) — in its entirety.

Workspace: ContextDesk — pull latest main. Follow AGENTS.md / Claude.md standing authorizations (branches, PRs, merge after green CI). Never log secrets; redact corp hostnames and PATs in issues/PRs/logs.

## Honesty / proof (non-negotiable)
- File child issues under #452 if none exist yet (design → settings → list_spaces → errors → agent guidance → rate limit → polish/CLAIMS). Link them on the epic.
- Close each child with CLOSE_PROOF: merge SHA or PR URL, pasted test/UI proof with names, issue-specific prose, Adversarial: CONFIRMED — … (docs/CLOSE_PROOF.md)
- docs/CLAIMS.md only Shipped when true on main with path:symbol
- Prefer integrate/seamless-confluence multi-step work; promote once with full CI (docs/AGENT_WORKFLOW.md)
- Tag closes with agent/model labels (scripts/tag-issue-agent.sh when available)
- If product fork not locked below, AskUserQuestion once with 2–4 options (batch decisions)
- Do not weaken SoftWrite/HardWrite or empty-space harvest allowlist policy (K6 / #430) — improve messaging and discovery only

## Already shipped — do NOT re-implement
- confluence_search / get_page / list_children / get_ancestors / list_attachments (confluence_ro.rs + tool_host)
- harvest_from_source, check/apply sync, Harvest pane, write tools gated by write_enabled
- Tool name normalize/resolve for model channel leakage (#451, tools.rs + ToolHost::execute)
- Space allowlist required for harvest/write; empty spaces OK for pure RO search (by design)

Design/context: docs/design/CONFLUENCE_GAP.md, docs/design/CONFLUENCE_HARVEST_MEMORY_TRANSFORM.md

## Locked product decisions
1. Local-first Settings path: base URL, PAT (keychain only), space keys, rest_path_mode / url_style, write_enabled
2. Space discovery is Read (or Settings-only host command) — never SoftWrite; adding keys to config is user-confirm Save (or SoftWrite if agent-driven later — default Settings Save)
3. RO browse must work with empty allowlist if PAT can access the space; harvest/write still require non-empty allowlist
4. Errors are actionable: map 401/403/404/timeout/CQL/HTML-error-pages to short user copy + Settings step (no secret echo)
5. Agent sees enabled Confluence tools + configured space keys in a bounded system/hint (no PAT)
6. Rate limit: keep throttle; add bounded backoff/retry on 429 with clear trail message
7. Help Center #434: feature-detect Learn more / help:// links; do not block on full Help epic
8. Offline hermetic tests (wiremock/stubs); no live corp Confluence required for CI. Optional #[ignore] live tests only if documented

## Children to file and implement (order; shippable PRs)

### A. Design SoT
Write docs/design/SEAMLESS_CONFLUENCE.md covering: Settings IA, space discovery API, error taxonomy, agent hint contract, retry policy, PR plan. Link from #452.

### B. Settings UX — connection health + spaces
- Test connection (base + PAT + path mode) with structured success/fail
- List spaces the PAT can see (host command + Settings UI)
- One-click / multi-select add space keys to allowlist, then Save
- Clear copy: empty allowlist = RO unrestricted by us; harvest/write need keys
- Desktop forms: calm chrome, a11y, no secrets in UI IPC beyond bools/refs

### C. Space browse tool (agent)
- confluence_list_spaces (Read) or equivalent — returns key + name, capped, SSRF-safe
- Wire into specs only when Confluence configured
- Offline wiremock tests

### D. Error surfacing (core + UI)
- Map Confluence HTTP/CQL failures to typed or stable message prefixes:
  unauthorized | forbidden | not_found | rate_limited | bad_cql | network | misconfigured
- User/agent text always includes next step (Settings path, check space key, retry later)
- Ensure harvest empty-allowlist error stays clear (Settings → Connectors → Confluence) — already improved; align all paths
- Unit tests for message mapping (no network)

### E. Agent guidance
- When Confluence enabled: inject short bounded hint (available tools + space allowlist keys + “use exact tool names”)
- Enrich tool descriptions for search/list_children with space examples
- Parse-time tool-name normalize optional if still gaps after #451 execute-path (only if product-path test shows need)
- Offline tests that hint appears when configured and is absent when not

### F. Rate limit / tree-walk resilience
- Existing throttle: keep
- On 429/5xx: bounded exponential backoff + max retries; surface in tool detail/trail
- Document non-cancellable mid-request honesty
- Tests with mock 429 then success

### G. Harvest / write seamlessness (UX only unless bug)
- Settings and Harvest empty states link to space allowlist when harvest fails policy
- Publish/write errors use same error taxonomy
- Do not change HardWrite type-to-confirm WRITE or write_enabled default off

### H. Polish + CLAIMS + demo
- CLAIMS rows only for true new capabilities (list_spaces, test_connection, error map, agent hint, retry)
- Short demo script: configure → test connection → list spaces → add ENG → search → list_children → get_page
- Close #452 children with proof; epic close only when DoD met
- dual Cargo.lock if cd-core deps change

## Definition of done (epic)
- User can configure Confluence, test connection, discover spaces, add keys, and agent can search + browse a tree without cryptic failures
- Misconfig yields Settings-pointing errors, not raw stack dumps or “unknown tool”
- 429/transient failures retry once or more with clear messaging
- Offline CI green; no secrets in logs
- CLAIMS honest

## Non-goals
- Replacing Atlassian Cloud OAuth with product account (PAT/basic remain)
- Full live corp Confluence suite in CI
- Jira epic work
- Weakening harvest allowlist SoftWrite policy
- Rebuilding entire harvest stack (#326 done)

## Execution tips
- Wiremock / local mock for Confluence REST shapes used by list spaces + CQL + children
- SSRF policy: private network allow only when matching existing Confluence host policy
- Redact base URLs in public issue text if corp-specific; fine in local logs if already redacted by product
- Coordinate with parallel Help (#434) / wizards only on shared Settings/App.tsx — rebase often
```
