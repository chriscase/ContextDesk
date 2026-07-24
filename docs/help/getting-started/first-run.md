---
id: first-run
title: First run and prelaunch
summary: Choose an allowlisted workspace, configure an AI provider, and use prelaunch health before chatting.
section: getting-started
tags:
  - setup
  - prelaunch
  - workspace
  - providers
  - process
order: 10
related:
  - product-overview
  - chat-citations-context
  - permission-tiers
---
# First run and prelaunch

The launch flow separates three decisions: which local folders ContextDesk may
read, which AI provider should answer, and whether the required checks are
ready. Normal setup happens in the app; editing configuration files is not the
happy path.

![First-run flow from workspace selection through AI setup and prelaunch health to chat](../assets/first-run-flow.svg)

## 1. Choose a workspace

Open the workspace step and select one or more roots. Those roots are the
filesystem allowlist for search and file-reading tools. Choosing a parent
directory grants access below that root; it does not grant access to the rest
of your home directory.

ContextDesk's index excludes known secret filenames and limits large or binary
files. An index status can report a file or resident-memory cap rather than
silently claiming that every file is searchable.

## 2. Configure AI

Choose the provider that matches your environment:

| Provider path | Egress | Credential behavior |
| --- | --- | --- |
| Ollama | Loopback/local by default | No product account or API key required |
| Grok Build session | xAI service after explicit opt-in | Existing local session is read by Rust; tokens never enter the webview |
| OpenAI-compatible | Configured endpoint | API key is stored in the OS keychain |
| Anthropic | Anthropic Messages endpoint | API key is stored in the OS keychain |

Select a chat model and save. The provider form validates and probes the
configuration without returning secrets to React.

## 3. Read prelaunch health

Prelaunch reports work-context categories such as files, memory, databases,
Confluence, and MCP. Blocking items prevent the ready state; warnings explain
partial capability without pretending it is healthy.

| State | Meaning | Next action |
| --- | --- | --- |
| Ready | Required local setup is available | Enter the main workspace |
| Warning | A non-blocking capability is unavailable or partial | Open the named Settings section if you need it |
| Blocking | Workspace or provider setup cannot support a chat | Correct the failing item and rerun the check |

News and X are optional research sources, not work-context requirements for
the Ready state.

## 4. Ask a grounded question

Try a question that names a subsystem in the selected folder. When retrieval
finds relevant material, the answer can include a search trail and citations.
An answer without a citation does not prove it came from your workspace; see
help://chat-citations-context.

> Tip:
> Use a small, known folder for the first question. It makes the allowlist and
> citations easy to verify before adding broader roots.
