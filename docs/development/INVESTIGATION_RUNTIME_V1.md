# Investigation Runtime V1

## Status

**Active integration** on `integrate/investigation-runtime-v1`, based on
`e37464de39ac5cfbae4d7abf106eb26d763f1a96`.

Runtime V1 is the shared browser-side boundary that lets ContextDesk ship more
than one investigation presentation without creating competing authorities for
case data, evidence, permissions, lifecycle, audit history, or navigation.
Investigation First is the first required consumer. War Room remains the
reference implementation while its older direct API access is migrated in
smaller, separately qualified slices.

## Authority boundary

The collaboration server remains authoritative for:

- authentication, authorization, case access, and capabilities;
- case, evidence, contribution, and lifecycle identity;
- validation, optimistic concurrency, audit history, and retention rules;
- archive/restore eligibility and every durable mutation.

The runtime owns browser-side orchestration only:

- parsing successful wire payloads into typed values;
- projecting capabilities into presentation-safe affordances;
- loading collection, detail, evidence, and lifecycle state;
- invoking create, upload, archive, and restore commands;
- cancelling or fencing requests whose route, case, or identity is stale;
- preserving canonical case, stage, focus, and URL state across strategies.

A strategy owns presentation choices only: hierarchy, layout, density,
progressive disclosure, help, labels, local drafts, filters, and case-scoped
selection. A strategy cannot grant authority, construct an investigation API
route, publish unparsed server data, invent a durable workflow state, or change
retention/deletion behavior.

## Module boundary

```text
collab/web/src/investigations/
  runtime/
    public.ts
    types.ts
    gateway.ts
    errors.ts
    capabilities.ts
    selectors.ts
    InvestigationRuntimeProvider.tsx
    controllers/
    testkit/
  strategies/
    contract.ts
    registry.ts
    StrategyRenderer.tsx
    war-room/
    investigation-first/
    testkit/
```

The dependency direction is one way:

```text
contracts -> gateway -> controllers/provider -> strategy contract -> strategy
```

The following rules are enforced by tests rather than convention alone:

1. New strategy modules import investigation behavior only from
   `investigations/runtime/public.ts` and the strategy contract.
2. Only `runtime/gateway.ts` may import `protected-api.ts` for endpoints covered
   by Runtime V1.
3. No raw `Response` or unchecked JSON value leaves the gateway.
4. Runtime modules do not import strategy modules, strategy CSS, or `App.tsx`.
5. Strategies do not import server modules, raw investigation route strings,
   other strategies, or the gateway implementation.
6. Strategy styles are scoped beneath their strategy root and use the shared
   design tokens.
7. The registry declares runtime and case-schema compatibility, maturity,
   status, and supported optional features.

### Incremental legacy allowlist

War Room and its existing specialist panels currently contain direct protected
API calls. Runtime V1 does not silently bless new calls in those files, nor does
it attempt a broad War Room rewrite. The dependency test records a narrow
legacy allowlist and fails if it grows. Each later panel migration removes an
entry. New strategies and Investigation First receive no allowlist.

## Mounted state and navigation

`InvestigationRuntimeProvider` mounts above the strategy renderer and remains
mounted when the user changes presentation. The web shell continues to own the
canonical location. Strategies receive the resolved location and typed
navigation callbacks; they never construct canonical URLs themselves.

Changing strategy must:

- issue no mutation request;
- preserve the active case identifier, stage, focus, and browser history;
- preserve the user's saved preference unless the action explicitly changes
  that preference;
- keep temporary technical-tool handoffs reversible through browser history;
- avoid publishing a result started for another authenticated identity.

## Request and publication rules

Every case-bound read uses an `AbortSignal` and a monotonically increasing
generation. A response may publish only when its identity, requested case, and
generation are still current. The guard applies before and after body parsing,
not merely around the initial fetch.

Mutation completion is fenced independently. A late upload, lifecycle action,
or refresh for case A cannot select, refresh, or reopen A after navigation to
case B. Create navigation uses only the identifier returned by the successful,
parsed server response.

The runtime classifies loading, empty, denied, not found, validation failure,
conflict, network failure, abort, protocol failure, and unexpected failure. It
does not bypass `protectedApiFetch`: a `401` or `403` still emits the global
authentication-loss event and invalidates the complete protected React tree.
Consequently, strategies do not promise a durable in-page case-level denied
surface after those responses. An inaccessible or missing case is expressed by
the server's `404` response without invalidating the session. A failed
collection or evidence request is never represented as an empty collection.

## Capabilities and read-only behavior

Capability projections can remove or disable an affordance; they cannot grant
one. The gateway still relies on the protected server route for final
authorization. Static read-only builds and capability-limited sessions expose
no callable mutation commands.

Lifecycle authority is shared across presentations. A strategy cannot use a
broader or narrower capability formula than another strategy for the same
operation. Archive and restore remain server-authoritative and audited.

## Runtime V1 operations

The first version covers the operations needed to preserve Investigation First
behavior:

- list visible investigations;
- load one investigation;
- create an investigation and return its authoritative identifier;
- list evidence and contribution annotations;
- upload bounded evidence through the existing protected route;
- inspect and invoke archive/restore through the shared lifecycle authority.

Specialist log exploration remains an explicit handoff to War Room. Permanent
deletion, recoverable trash implementation, storage-provider migration, plugin
execution, and server-side strategy governance are not Runtime V1 operations.

### Transport prerequisites

The gateway implementation starts only after the authoritative contracts can
parse every successful Runtime V1 response. In particular, the contracts layer
must provide:

- a parser for `InvestigationLifecycleV1`, including its allowed/refused
  verdicts, restore target, and deletion alternatives; and
- a versioned evidence-list envelope and parser, with the case service emitting
  that envelope from `GET /api/cases/:id/evidence`; and
- a versioned evidence-upload-success envelope and parser for the returned
  artifact and summary contribution, with the case service emitting it from
  `POST /api/cases/:id/evidence`.

The gateway must not compensate for any omission with a local cast or a
second hand-written wire parser.

## Conformance gate

Every strategy consumer must prove, using deterministic synthetic fixtures:

- sparse imported records render without invented facts;
- read-only and capability-limited users cannot reach writes;
- switching strategies preserves canonical location and sends no mutation;
- create opens the server-confirmed record identifier;
- a delayed case A response cannot overwrite active case B;
- late upload and lifecycle completion cannot resurrect case A;
- evidence and collection failures remain visible and retryable;
- selection is scoped to the active case and exposes no permanent deletion;
- lifecycle actions use the shared audited authority;
- specialist tools are optional and explicitly opened;
- keyboard, screen reader, zoom/reflow, contrast, reduced motion, and non-drag
  operation meet the shared accessibility baseline.

## Delivery and freeze

Runtime V1 is delivered in dependency order:

1. typed transport contracts and parsers, including lifecycle and the
   versioned evidence list/upload envelopes;
2. deterministic fixtures and the dependency-boundary guard;
3. gateway, bounded errors, capability projections, and pure selectors;
4. provider and race-safe controllers;
5. versioned strategy renderer contract;
6. Investigation First migration and behavioral-parity proof;
7. independent exact-head review and full collaboration CI.

The contract freezes only after Investigation First is fully migrated and the
conformance gate passes. New visual-strategy implementation begins against that
frozen public surface rather than importing unfinished internals.
