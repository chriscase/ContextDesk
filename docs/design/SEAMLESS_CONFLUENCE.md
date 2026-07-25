# Seamless Confluence integration — design

**Status:** implementation contract for epic [#452](https://github.com/chriscase/ContextDesk/issues/452)  
**Product:** ContextDesk — RO browse, space discovery, actionable errors, agent hints, retry  
**Related:** [#326](https://github.com/chriscase/ContextDesk/issues/326) harvest (shipped) · [#430](https://github.com/chriscase/ContextDesk/issues/430) allowlist policy · [#451](https://github.com/chriscase/ContextDesk/issues/451) tool-name sanitize  
**Goal prompt:** [`docs/goals/GOAL_SEAMLESS_CONFLUENCE.md`](../goals/GOAL_SEAMLESS_CONFLUENCE.md)

## 0. Goals

1. User can **test connection**, **list spaces the PAT can see**, and **add keys** to the allowlist without leaving Settings.
2. Agent can call **`confluence_list_spaces`** (Read) when Confluence is configured.
3. Failures use a **stable error taxonomy** with Settings-pointing next steps (no PAT/secret echo).
4. When enabled, agent gets a **bounded hint** (tools + space keys, no PAT).
5. **429/5xx** get bounded backoff/retry with clear trail messaging.
6. **Do not weaken** harvest/write non-empty space allowlist (K6 / #430) or HardWrite WRITE confirm.

## 1. Settings IA

| Control | Behavior |
|---------|----------|
| Enable | Existing toggle |
| Base URL | Existing; validate SSRF |
| PAT | Keychain only; UI sees hasToken bool |
| Space keys | Comma-separated allowlist (existing) |
| Discover spaces | Host lists remote spaces → multi-select → merge into draft spaces → user Save |
| Test configuration | Real probe (REST) when PAT+URL present; structured OK/fail |
| Write enabled | Unchanged; requires non-empty spaces |

**Copy:** Empty allowlist = product does not filter RO; harvest/write still need keys.

## 2. Space discovery API

- Core: `list_spaces(cfg, auth, policy, limit) -> Vec<{key, name}>`
- REST: `GET /rest/api/space?limit=N` (Standard); WikiPrefix uses `/wiki/rest/api/space`
- Cap default 50, max 100
- Parse pure offline; filter empty keys
- Agent tool: `confluence_list_spaces` Read, only when connector configured
- Settings host command reuses same core helper (no SoftWrite)

## 3. Error taxonomy

| Kind | When | User next step |
|------|------|----------------|
| `unauthorized` | HTTP 401 | Re-save PAT in Settings → Connectors → Confluence |
| `forbidden` | HTTP 403 | Check PAT scope / space access; add space key if using allowlist |
| `not_found` | HTTP 404 | Check base URL and rest path mode (Cloud may need /wiki) |
| `rate_limited` | HTTP 429 | Wait/retry; product may auto-retry once/bounded |
| `bad_cql` | 400 with CQL markers | Fix query; try free text or `space = "KEY"` |
| `network` | transport/timeout/TLS | VPN/DNS/corp CA |
| `misconfigured` | missing URL/PAT/connector off | Settings → Connectors → Confluence |
| `other` | fallback | Status/class only + Settings guidance; remote body is never surfaced |

Stable message prefix: `confluence:{kind}: …` for agents; human sentence after.
Remote response bodies may be inspected only to classify a failure (for example,
detecting bad CQL). They are not returned in UI, tool, audit, log, or snapshot
diagnostics because an upstream server or proxy can reflect credentials.

## 4. Agent hint contract

When Confluence cfg + PAT present, append to system policy (bounded, ≤800 chars):

```
Confluence enabled. Tools: confluence_search, confluence_get_page, confluence_list_children, confluence_list_spaces, … Use exact tool names. Space allowlist: ENG, DOCS (or: empty = no product filter; harvest needs keys).
```

No PAT, no base URL secrets. Absent when disabled/unconfigured.

## 5. Retry policy

- Keep existing min-interval throttle between Confluence calls.
- On GET HTTP 429 or 500–599: retry up to **2** additional attempts with
  deterministic backoff (200ms, then 400ms). Do not retry writes or
  400/401/403/404.
- Mid-request cancel: not cancellable once HTTP in flight; honest.
- Surface `confluence:rate_limited: …` for 429 and
  `confluence:transient_server: …` for 5xx, including retry, recovery, or
  bounded exhaustion, in every Confluence Read tool result.

## 6. Harvest / write UX

- Align empty-allowlist harvest error with Settings → Connectors → Confluence (already partially done).
- Harvest pane empty / policy fail: short link-style copy (no SoftWrite change).

## 7. PR plan (integrate/seamless-confluence)

1. Design + error taxonomy + retry + list_spaces + probe (core)  
2. Agent tool + hint  
3. Settings UI + host IPC  
4. Harvest copy + CLAIMS + demo + close  

## 8. Non-goals

OAuth product account · live corp CI · Jira · weakening allowlist policy · rewriting RO/harvest stack.
