---
id: capability-qualification
title: Qualify model capabilities
summary: Run synthetic, user-triggered probes so measured results never come from a model name alone.
section: providers
tags:
  - providers
  - models
  - privacy
  - process
order: 20
related:
  - provider-setup
  - security-boundaries
  - common-problems
---
# Qualify model capabilities

ContextDesk can **measure** a few host-observable contracts for the exact
provider profile, endpoint, and model you selected. Behavioral measurement is
always **explicit**: startup/pre-flight may refresh the lightweight model
catalog, but it never silently runs token-spending qualification.

![Synthetic probes contact only the configured provider and never send workspace or company data](../assets/provider-routing-flow.svg)

## When to use it

Use **Settings → AI / Models → Qualify selected model…** after you choose a
chat or specialty model id. Qualification answers “does this deployment accept
the synthetic contracts ContextDesk cares about?” — not “is this model good?”

## Probe lifecycle

| Stage | What happens | Privacy |
| --- | --- | --- |
| Offer | Role **name hints** (#723) only select which probes to offer | No network |
| Start | You click **Qualify selected model…** | Contacts configured provider only |
| Run | Synthetic prompts and inert tool `cd_qualify_echo` only | No logs, memory, workspace paths, or secrets in probe text |
| Save | Result keyed by profile + endpoint fingerprint + model + schema | Secret-free local evidence shared by GUI and CLI; siblings never overwrite each other |
| Cancel | Stops further probes; remaining checks stay `untested` | Truthful status |
| Clear / Retry | Drop one exact model result, then re-run | Same isolation rules |

## Status values

Each check is `pass`, `degraded`, `fail`, or `untested`, with elapsed time and a
secret-free reason. Profile-level disabled tools or streaming remain
**authoritative** over any probe.

Model pickers summarize those checks as **verified**, **limited**, **failed**,
**stale**, or **unverified** for the measured role. A triage model is verified
only when basic generation, native **auto** tool calls, tool-result
continuation, and **prompted** structured output pass. Those are the production
triage contracts. Native `json_object` (`response_format`) and forced
`tool_choice` are measured separately: an HTTP 400 for those modes is a real
provider limitation of that exact contract, but it does not by itself make a
production-valid auto-tool model **limited**. Tool-result continuation passes
when the model produces a next assistant turn after a host-validated tool
result (the synthetic `QUALIFY_OK_V1` marker when present, otherwise non-empty
content or a native next tool call). Empty continuation or a transport error
stays fail-closed. Basic generation with a failed investigation contract is
limited, not verified. Embedding and reranking results stay role-specific and
are never promoted as preferred chat models.

Pinned models and the explicit default remain first. Current verified chat
models are preferred only among the remaining ordinary choices; ContextDesk
does not silently replace the user's selection or default.

`contextdesk models` reads the same saved evidence entirely offline.
`contextdesk models discover` refreshes the gateway catalog, and
`contextdesk models verify <ids...>` verifies a selected handful (or a
confirmed filtered `--all`). Merely viewing cached status or clearing one
result does not resolve a credential; only explicit live actions do.
All-model runs are serial and paced, stop on an observed rate limit, and save
each completed result. An empty discovery response leaves the previous catalog
and its evidence untouched.

On large catalogs such as Vercel, use exact ids or filter by suggested role and
id text. Name-based role classification is only a selection aid. Vercel
embedding and reranking checks use its native v4 contracts; generic gateways
use their OpenAI-compatible embedding or standard `/rerank` contracts.

Startup/pre-flight compares the successful catalog with the last saved
snapshot. Newly added models are unverified, removed models become stale, and
unchanged models keep their exact evidence. A catalog change appears as a
separate preflight warning with an **Open AI settings** action. The app offers
re-verification but does not change the user's default or spend model tokens
automatically.

## What never happens

- Name hints alone never mark a capability `pass`.
- A stale or cancelled result never receives a verified badge.
- Saved catalogs remain local; ordinary exported diagnostics do not include
  the full private inventory.
- One probe does not claim quality, context length, or permanent reliability.
- Triage verification does not claim ordinary-chat, attachment, or multimodal
  compatibility.
- Probe tools cannot read files, corpora, memory, connectors, or arbitrary URLs.

## Residuals

Packaged proof against a real tools-enabled and tools-disabled profile depends
on your environment and credentials. ContextDesk ships the path; live packaged
evidence is owner-side.
