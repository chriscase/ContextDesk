---
id: common-problems
title: Troubleshooting common problems
summary: Diagnose provider, workspace, Confluence, connector, offline, and context-limit problems without exposing secrets.
section: troubleshooting
tags:
  - troubleshooting
  - 429
  - confluence
  - offline
  - providers
  - indexing
order: 10
related:
  - provider-setup
  - workspace-indexing
  - connectors-and-confluence
---
# Troubleshooting common problems

Start with **Settings → Health** and the expandable diagnostic for the failing
category. Prefer the redacted report action over copying a raw response or
configuration file.

## Symptom guide

| Symptom | Likely cause | Safe next step |
| --- | --- | --- |
| Model list returns HTTP 429 | Gateway throttled URL-shape probes | Wait 30–60 seconds, retry once, or enter a known model id in Advanced |
| Authentication fails | Missing/expired keychain item or Grok session | Re-save the key, or run `grok login` and opt in again; do not paste tokens into chat |
| Ollama unavailable | Service stopped, wrong loopback URL, or model not pulled | Start Ollama, pull/select a model, then Test connection |
| Chat answers without workspace citations | No relevant indexed evidence or provider tools unavailable | Check the workspace root/index status and whether tools are enabled |
| File absent from search | Excluded type/name, unreadable file, or visible file/byte cap | Inspect index status and narrow the query; do not bypass the root policy |
| Confluence search is empty | Wrong base/token, restrictive spaces, or no visible matching page | Test the connection and confirm exact space keys and token access |
| Confluence harvest is blocked | Space allowlist is empty | Add at least one approved space key; harvest never treats empty as permission |
| MCP tools are absent | Connector disabled, command not absolute, child failed, or discovery timed out | Review connector status and use an absolute executable path |
| Context too long | Recent turns and tool results cannot fit the active model budget | Start a new chat or remove oversized session context; stored history remains |
| Logs overview warns “Legacy corpus” or “Different ingest pipeline” | Corpus predates current parsing/framing semantics (or came from another pipeline version) | Optional: reimport the same sources into a new corpus to pick up improvements. The warning is advisory — ContextDesk never auto-reimports or deletes |
| S3 dry run works but backup fails | Missing keychain credential, endpoint policy, authorization, or transport error | Recheck the redacted destination and key presence; never put credentials in the URL |

## Offline behavior

Bundled Help, local file search, durable local data, and a reachable local
Ollama setup can work without public internet access. Remote providers,
Confluence, web/X research, remote databases, HTTP/MCP services, update checks,
and S3 export need their configured dependency. An optional remote source being
offline should appear as a warning or unavailable tool, not proof that local
workspace data was deleted.

## Before filing an issue

Record the build identity, the exact failing surface, whether the dependency is
local or remote, and the redacted diagnostic. Include a minimal reproduction
and what you expected. Never attach `.env`, provider auth files, keychain
exports, private log dumps, or database files.

