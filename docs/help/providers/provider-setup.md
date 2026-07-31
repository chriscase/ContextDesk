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

## Model role hints (not standards)

Discovered model **ids** are gateway-specific labels. ContextDesk may show a
short **“Suggested for …”** line (investigation chat, embedding retrieval,
reranking, or unqualified) based on the **name** alone.

- Role names are **hints**, not a cross-gateway standard or capability proof.
- A familiar id does **not** prove tool support, quality, context length,
  structured output, embeddings, or reranking.
- Exact behavior requires a separate **capability qualification** path (user-
  triggered probes under Settings → AI / Models → **Qualify selected model…**),
  not automatic inference from the name. See help://capability-qualification.
- Embedding and reranker-looking ids are sorted away from ordinary chat
  defaults but remain **selectable**; private aliases stay selectable and are
  labeled unqualified until you confirm them.
- Suggestions never silently change an existing default or role binding; you
  confirm every change.
- The name classifier accepts one already-visible id and does not enumerate a
  provider inventory. Model visibility preferences are separate display state;
  they do not turn a name hint into capability evidence.
- Model inventories and private aliases do not belong in shareable diagnostics
  or public screenshots.

## Curate model visibility

Open **Settings → AI → Model visibility → Manage…** to choose which discovered
models ordinary pickers offer. The inventory loads only after you open Manage.
For a large gateway, the panel and chat pickers keep a hard row limit instead
of mounting the entire inventory. Use **Search models** to reach an omitted
model; pinned choices are prioritized within the same limit.

- **Pin** moves a visible model into the Pinned band. **Unpin** returns it to
  the normal provider band.
- **Hide** removes one model from ordinary pickers. **Hide provider** curates
  every model in that provider profile. Neither action deletes a profile,
  credential, local model, or remote model.
- Turn on **Show hidden** to find **Restore** and **Restore provider** actions.
  The underlying configuration is retained, so the preference is reversible
  and persists across restarts.
- If a hide would replace the default for new chats, ContextDesk names the exact
  replacement and waits for confirmation. It refuses a change that would leave
  no visible choice. An existing chat still shows its selected model even if
  that model is later hidden.

Curation is scoped to the provider profile, normalized endpoint, and model
identity. Renaming a profile label preserves its preferences; repointing that
profile to a different endpoint creates a distinct inventory and preference
scope. Another profile does not inherit those choices.

Hiding is a display preference, **not** a privacy, access-control, health, or
capability decision. A hidden model remains configured and reachable by its
existing selection, and an available model can still be unhealthy or have
tools unavailable. Provider health and qualification results remain the source
of truth for those properties.

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
