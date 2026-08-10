# Multi-gateway and multi-model routing

**Status:** Accepted direction and follow-up ledger. The gateway discovery and
model compatibility work is being integrated separately. The routing model in
this document is not yet shipped behavior.

This record condenses an independent read-only architecture audit performed
against committed `22ec05f2` plus the uncommitted model-readiness integration.
The audit made no live gateway, Keychain, or repository mutations.

Tracked follow-ups:

- [#864](https://github.com/chriscase/ContextDesk/issues/864) — gateway-scoped
  model references and per-mode defaults
- [#865](https://github.com/chriscase/ContextDesk/issues/865) — shared auth
  resolution and one-read-per-operation credential caching, including Grok
- [#866](https://github.com/chriscase/ContextDesk/issues/866) — product
  embedding and reranking protocol adapters (OpenAI embeddings and explicit
  TEI-style reranking are now the first typed production slice; Vercel v4
  score-preserving retrieval remains follow-up)
- [#867](https://github.com/chriscase/ContextDesk/issues/867) — hermetic model
  and retrieval quality evaluation

## Executive direction

ContextDesk already has most of the necessary primitives: provider profiles,
profile-scoped curation, exact model qualification, turn-scoped credential
caching, an optional reviewer with egress gates, and role-specific retrieval
configuration. The missing piece is a small composition model:

1. A **gateway profile** owns endpoint, provider kind, authentication reference,
   locality/privacy policy, and catalog identity.
2. A **model reference** is always the gateway profile ID plus the exact model
   ID.
3. A **mode default** chooses one model reference for a task mode.
4. A future **routing policy** may describe a bounded advanced pattern such as
   review or ordered fallback.
5. Compatibility, retrieval quality, answer quality, and orchestration quality
   remain separate evidence classes.

This deliberately extends the structs and workflows that already work. It does
not introduce a generic provider plugin framework or a matrix of capability
flags.

## Current state

Today, `ProviderConfig` can store several profiles but one profile is active for
chat. `ProviderProfile` carries a chat model and optional embedding model. The
retrieval embedding and reranking roles are separate configuration objects. The
multi-model path can assign one optional reviewer; the investigator remains the
synthesizer.

Grok Build correctly uses its own session-file/OIDC authentication and pinned
hosts, then reuses the OpenAI-compatible chat client. Its special behavior is an
authentication adapter concern, not a reason for a separate routing or evidence
system.

The current compatibility evidence already has the essential identity boundary:
profile, endpoint fingerprint, exact model, role, and probe schema. A matching
model name on another gateway does not share evidence.

## Product laws

These are requirements rather than recommendations:

1. A model is never selected or persisted as a bare model string once the new
   configuration is authoritative.
2. The same model ID on two gateways shares no compatibility, quality,
   orchestration, selection, or catalog-drift evidence.
3. The default experience is one gateway/model pair per task mode.
4. A missing or failed selection never silently switches gateways.
5. Cross-gateway review or fallback requires explicit, visible consent and must
   disclose privacy, egress, cost, and credential consequences.
6. Embedding and reranking verification never promotes a model to a chat
   default.
7. Explicit user defaults and pins remain ahead of recommendations.
8. Every member of a multi-model policy is independently qualified. A policy
   receives separate orchestration evidence keyed by its full membership and
   configuration.
9. Quality evidence never upgrades compatibility readiness.
10. Cached/offline status performs no credential or session-file reads.
11. Each explicit live operation resolves each credential source at most once
    and reuses it for all stages in that operation.

## Minimal domain model

The first additive configuration should be conceptually equivalent to:

```text
ModelRef {
  gateway_id,
  exact_model_id,
}

ModeDefaultsV1 {
  ordinary_chat?,
  triage?,
  text_attachments?,
}
```

Embedding and reranking remain explicitly typed specialty assignments while
their endpoint families stabilize. They may use the same gateway identity, but
must not be treated as chat defaults.

Legacy `default_chat_model` and profile `chat_model` fields are dual-read during
migration. New writes prefer gateway-scoped references. Removing the legacy
fields is a later migration, not part of the first slice.

## Simple and advanced surfaces

The daily mental model remains:

`Discover → Verify → Choose`

Settings should first show gateways as cards, each with its connection state,
catalog change state, selected defaults, and a single Verify action. Ordinary
users choose one model for each visible task mode. Specialty models appear in
the retrieval section rather than the main chat chooser.

Advanced configuration may later expose named policies:

- a candidate plus reviewer;
- ordered fallback, same-gateway-only by default;
- parallel peers;
- candidate, reviewer, and independently assigned synthesizer; or
- a bounded ensemble with a typed aggregation contract.

Only review exists today. Ordered fallback should not be added until the
gateway-scoped model reference and consent model are established. Parallel and
ensemble strategies are explicitly deferred.

## Adapter boundaries

Use a deliberate hybrid rather than one universal provider interface:

- exhaustive `ProviderKind` dispatch constructs chat backends;
- protocol strategies construct catalog, embedding, and reranking requests for
  OpenAI-compatible, Vercel v4, Ollama, and TEI endpoint families;
- an auth adapter resolves Keychain references, Grok sessions, and no-auth
  local connections into bounded operation-scoped wire authentication; and
- shared workflow resolution enforces selection, privacy, egress, cancellation,
  and evidence identity.

Unsupported role/protocol combinations fail before a remote call and return a
typed, actionable result.

## Credential and Keychain constraints

The keyring 3.6.3 macOS `get_password` path performs one
`find_generic_password` call. Multiple dialogs from unsigned development
binaries are not evidence that every investigation stage reloads the secret.

The credential architecture must therefore be evaluated by counted source
reads, not dialog count:

- cached status and clear: zero reads;
- one explicit discover or verify operation: one read per credential source;
- one chat turn, including multi-stage triage: one read per credential source;
- multiple roles sharing one source: one shared resolution;
- Grok session load and refresh: one operation-scoped resolution;
- dry-run and isolated CLI: zero Keychain and Grok-session reads.

## Evidence boundaries

The following evidence must never collapse into a universal badge:

| Evidence | Identity and meaning |
| --- | --- |
| Compatibility | Exact gateway, endpoint, model, role, and probe schema satisfied a synthetic contract |
| Retrieval quality | Exact corpus, query, embedding/rerank pipeline, and retrieval configuration ranked the expected evidence |
| Answer quality | Exact prompt, evidence packet, model, sampling, and answer schema produced a useful grounded answer |
| Orchestration quality | Exact ordered policy membership, roles, prompts, and routing strategy worked as a group |

See [QUALITY_EVAL_HARNESS.md](../benchmarks/QUALITY_EVAL_HARNESS.md) for
the planned hermetic evaluation lanes and judge policy.

## Staged implementation

1. Land model discovery and compatibility readiness without expanding routing.
2. Add gateway-scoped `ModelRef` and per-mode defaults through an additive,
   dual-read migration.
3. Unify auth resolution and generalize the turn cache so Grok session auth and
   Keychain-backed auth obey the same one-resolution contract.
4. Share embedding and reranking protocol strategies between qualification and
   product retrieval, while keeping query-time egress fail-closed.
5. Express the existing reviewer as the first named advanced routing policy,
   preserving its current degradation and remote-egress rules.
6. Add same-gateway ordered fallback only after policy identity and consent are
   proven.
7. Add orchestration-quality evidence independently of member compatibility.

Every slice must be independently reversible, serde-compatible, hermetically
tested, and usable through shared workflow code before thin GUI and CLI hosts.

## Required acceptance coverage

- Two gateways with the same model ID remain independent.
- A chat-only gateway and specialty-only gateway can coexist.
- Private aliases can be selected and measured without name-based proof.
- Missing gateways and removed catalog members produce recoverable errors.
- No selection failure silently calls another gateway.
- Cross-gateway review is blocked without explicit consent.
- Local-only investigator policy blocks remote review.
- Cached status reads no credential.
- One live operation resolves each credential source once.
- Cancellation preserves honest completed/partial evidence and stops new work.
- Corrupt evidence is never silently overwritten.
- Quality results cannot write compatibility readiness.
- Diagnostics contain no credentials, private endpoints, absolute paths, or raw
  employer data.

## Explicit deferrals

- automatic "best model" routing from quality scores;
- a full ensemble consensus engine;
- parallel candidate execution in the first routing release;
- per-token cost optimization inside core business logic;
- a provider plugin registry replacing enum exhaustiveness;
- hard-coded vendor pricing tables; and
- a universal verified badge.

## Product decisions to resolve with measured use

1. Whether an empty configuration should keep the implicit local Ollama fallback
   or require explicit first-run selection.
2. Whether a synthesizer should be independently assignable in the first policy
   release.
3. Whether quality rankings may ever reorder recommendations or remain
   report-only.
4. Whether cross-gateway review ships with explicit consent in V1 or remains
   disabled initially.
5. Whether specialty roles eventually become gateway members or remain separate
   retrieval settings.
6. Whether Vercel becomes a first-class product endpoint family for retrieval.
7. Whether ordinary chat inherits triage selection when no explicit default is
   present.
8. Whether usage justifies ordered fallback before any parallel-candidate work.

These decisions should not block the compatibility work. They are recorded to
prevent accidental defaults from becoming permanent architecture.
