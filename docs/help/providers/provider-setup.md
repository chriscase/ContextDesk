---
id: provider-setup
title: AI providers and model selection
summary: Configure Ollama, Grok Build, OpenAI-compatible, or Anthropic chat without exposing credentials to the webview.
section: providers
tags:
  - providers
  - ollama
  - grok
  - anthropic
  - models
  - troubleshooting
  - process
order: 10
related:
  - first-run
  - security-boundaries
  - common-problems
---
# AI providers and model selection

ContextDesk routes each chat to the provider and model selected for that
session. Provider setup and model discovery run in the trusted Rust host; React
receives model ids, status, and redacted diagnostics, never raw API keys.

![Provider choices joining one bounded chat path while credentials stay in the trusted host](../assets/provider-routing-flow.svg)

## Provider matrix

| Provider | Normal endpoint | Credential source | Notes |
| --- | --- | --- | --- |
| Ollama | Loopback Ollama API | None | Local-first default; choose a model already pulled |
| Grok Build session | Pinned xAI API host | Existing local `grok login` session after opt-in | Do not paste its session token into Settings |
| OpenAI-compatible | User-configured HTTP(S) base | OS keychain | Supports compatible gateways; exact behavior depends on the gateway |
| Anthropic | Anthropic Messages API or configured base | OS keychain | Uses Anthropic message and tool-call shapes |

A local-only profile refuses non-loopback bases. Remote bases are subject to
the host's URL and SSRF policy. Model-list discovery is a convenience: when a
compatible gateway cannot list models, Advanced setup can accept a known model
id.

## Tool calling and context

Provider tool support is detected and persisted. If a gateway rejects native
tools, ContextDesk can retry without advertising tools; that means workspace,
connector, and Help tool grounding is unavailable for that turn. The selected
model also supplies a declared or learned context budget. ContextDesk compacts
and hard-fits the model-facing turn before sending it; full stored chat history
is not deleted.

## What leaves the machine

Ollama is local when its endpoint is loopback. Any remote provider can receive
the user prompt plus the bounded history, skill, context pack, memory, or tool
evidence selected for the turn. Keychain storage protects the credential; it
does not make remote content processing local.

For a 429, authentication failure, or empty model list, see
help://common-problems.

