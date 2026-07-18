# ADR 0005: JIRA integration approach

**Status:** Accepted (design only)  
**Date:** 2026-07-18  
**Issue:** #280 (epic #276)  
**Implementation epic:** #291 (spawned)

## Context

Connectors already support MCP stdio, HTTP presets, and permission tiers. JIRA: read assigned issues (Read); create/edit stories (HardWrite + confirm).

## Decision

**Prefer an existing JIRA MCP server attached via the module substrate (ADR 0001), with host-classified side effects.**

- Reads: `Read` tools after first-use MCP grant.
- Writes: `HardWrite` + UI type-to-confirm; never from chat alone (ADR 0003).
- Secrets: JIRA token in OS keychain only; `api_key_ref` in connector config.
- Fallback: `http_preset` OpenAPI if no suitable MCP server — second choice.

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| Native first-class JIRA crate in cd-core | Couples product to one vendor; MCP already isolates |
| Always-on write without confirm | Violates AGENTS #4 |

## Effort estimate

**S–M** — ~3–5 days with a known-good MCP server; longer if HTTP-preset only.

## Implementation epic

**#291**