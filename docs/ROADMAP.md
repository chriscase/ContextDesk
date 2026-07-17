# Roadmap (issue-driven)

GitHub issues and epics are the source of truth. High-level phases:

## Phase 0 — Foundation

Monorepo, `cd-core` skeleton, branding, AGENTS docs, CI, desktop shell,
**Settings + Preflight UI** (no config-file happy path), form validation primitives.

## Phase 1 — MVP research loop

Provider profiles + probe (SSRF-hardened), **Ollama + OpenAI-compatible only**, keychain secrets, local file KB + memory, tool host (read + memory soft-write), agent loop, citations, desktop chat UI (stream, compact tools, composer), permissions, path/secret denylist, injection labeling.

**Not in Phase 1:** Grok Build session reuse, multi-tenant server, MCP marketplace.

## Phase 2 — Discovery & skills

Local gateway detection polish, **optional Grok Build session** (opt-in, experimental), skills drop-in + agent-authored, multi-pane (doc + source preview), conversation compaction.

## Phase 3 — Connectors & MCP

MCP client, SQLite/Postgres RO, typed HTTP connectors, optional Confluence RO.

## Phase 4 — Server & embed

Headless `cd-server` team memory, `cd.v1` embed docs, host adapter examples.

## Phase 5 — Polish

Themes/skins, rich prompt markdown, type-to-confirm policies, performance, packaging.
