---
id: glossary
title: Glossary
summary: Decode the product terms used across Help, Settings, chats, permissions, memory, logs, and connectors.
section: reference
tags:
  - glossary
  - reference
  - terminology
order: 10
related:
  - product-overview
  - permission-tiers
  - chat-citations-context
---
# Glossary

| Term | Meaning in ContextDesk |
| --- | --- |
| Allowlisted root | A folder boundary inside which canonical file reads and writes may be considered |
| Ambient recall | A small, bounded selection of approved durable memories added without an explicit recall tool call |
| Citation | A stable locator for evidence returned by a tool, such as a workspace path, memory id, or `help://` page |
| Connector | Optional host configuration that registers a data source or tool set |
| Context budget | The hard model-facing character allowance used to compact and fit a turn |
| Corpus | A named disposable log-analysis dataset stored separately from durable memory |
| HardWrite | A remote, destructive, or otherwise high-risk action that blocks for explicit confirmation |
| Harvest | A provenance-bearing Confluence capture into memory or a workspace file |
| HelpIndex | The offline index over the curated bundled Help corpus |
| Hybrid search | Keyword ranking combined with an optional semantic vector score |
| MCP | Model Context Protocol; ContextDesk uses local stdio subprocesses for MCP tools and modules |
| Memory candidate | A review-inbox proposal that is not durable or recallable until approved |
| Prelaunch | The health/setup surface that checks required and optional work-context categories |
| Search trail | A visible sequence of sources or Help tools consulted during retrieval |
| Session context pack | Bounded files copied into one chat's temporary context scope |
| Skill | A Markdown playbook that guides a turn but cannot grant permissions |
| SoftWrite | A local materializing change that pauses for a preview and user decision |
| SSRF | Server-side request forgery; endpoint policy prevents user URLs from reaching forbidden local/metadata destinations |
| Trusted host | The Rust process that owns secrets, policy validation, tools, and writes |
| Webview | The React display process; it receives redacted DTOs rather than raw credentials |

