# Investigation Runtime V1

## Status

**Frozen on `main`** through
[#1109](https://github.com/chriscase/ContextDesk/pull/1109), squash merge
`e3dc3a5676c9234bcae2314d64fcf06d037c8934`. The accepted candidate was
`6cabdc7b293959e808681bbbd2030c81faee8819`, tree
`d9aeafce731f7de6fbe9962d1953bc532ddcb5e9`, based on
`e37464de39ac5cfbae4d7abf106eb26d763f1a96`. The merge commit has that exact
accepted tree; Runtime V1 additions now require additive, versioned evolution
of the public surface rather than imports from implementation modules.

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
    StrategyRenderer.tsx
    investigation-first/
```

The selectable strategy registry lives in `collab/web/src/ui-strategy.ts`.
`App.tsx` composes the registered adapters, including the War Room reference;
replaceable strategy components stay below `strategies/`. Browser consumers
import transport contracts through the browser-safe
`@cd-collab/contracts/investigation-runtime` subpath, backed by
`collab/contracts/src/investigation-runtime-browser.ts`, rather than the
Node-capable package root.

The dependency direction is one way:

```text
contracts -> gateway -> controllers/provider -> strategy contract -> strategy
```

The following rules are enforced by tests rather than convention alone:

1. New strategy modules import investigation behavior only from
   `investigations/runtime/public.ts` and the strategy contract.
2. For Runtime V1-covered endpoints, only `runtime/gateway.ts` may add protected
   API access. Existing War Room calls are limited to the exact, shrink-only
   legacy allowlist enforced by `investigations/dependency-boundary.test.ts`.
3. No raw `Response` or unchecked JSON value leaves the gateway.
4. Runtime modules do not import strategy modules, strategy CSS, or `App.tsx`.
5. Strategies do not import server modules, raw investigation route strings,
   other strategies, or the gateway implementation.
6. Strategy styles are scoped beneath their strategy root and use the shared
   design tokens.
7. The registry declares exact shared-runtime compatibility, case-schema
   compatibility, maturity, status, and a closed list of supported optional
   features. The strategy renderer rejects descriptor-shaped values with an
   unknown runtime version, feature identifier, or duplicate feature claim.

The dependency guard also reserves direct browser transport names and exact
transport string keys (`fetch` and `XMLHttpRequest`) inside strategy source, so
direct calls, aliases, computed access, and reflected access fail the build.
This is a strong repository boundary, not a JavaScript sandbox; the protected
server routes remain the final authorization authority.

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
parsed server response. A retained create callback rechecks the latest identity,
authority, read-only state, capability, and canonical location before it may
issue a request, and it runs only at the null-case investigations origin. A
create already in flight may merge its authoritative result after navigation,
but it may navigate only while the user remains at that origin.

Successful parsed gateway values, structured lifecycle-conflict state, and the
provider's assembled Runtime V1 graph are frozen before publication. Arrays and
plain DTO objects are recursively protected, and strategy-facing callbacks are
shallow-frozen. One strategy therefore cannot mutate shared browser state that
a later strategy receives; class instances and browser host objects remain
outside this DTO-specific guarantee.

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

### Transport contracts

The gateway consumes authoritative parsers for every successful Runtime V1
response. The delivered contracts layer provides:

- a parser for `InvestigationLifecycleV1`, including its allowed/refused
  verdicts, restore target, and deletion alternatives; and
- a versioned evidence-list envelope and parser, with the case service emitting
  that envelope from `GET /api/cases/:id/evidence`; and
- a versioned evidence-upload-success envelope and parser for the returned
  artifact and summary contribution, with the case service emitting it from
  `POST /api/cases/:id/evidence`; and
- versioned lifecycle-action request, success, and changed-state conflict
  envelopes and parsers for `POST /api/cases/:id/lifecycle`.

The case service emits those versioned envelopes, and Runtime V1 accepts only
their parsed values.

The gateway must not compensate for any omission with a local cast or a
second hand-written wire parser.

### Lifecycle command integrity

The lifecycle read is a preview, not a mutation token by itself. A Runtime V1
consumer must never post the preview's `targetStatus` to the generic status
route: legal hold, status history, or the current status may change between the
read and the write, and the caller-selected target can then describe an action
the server would no longer authorize.

The lifecycle action request carries the action and the expected lifecycle
state from the parsed preview; it does not carry a caller-selected target
status. The case service executes the action inside one atomic case lock. It
reloads status, legal hold, and status history; compares them with the expected
state; re-evaluates the requested action; and writes only the allowed verdict's
server-derived target. Changed state returns a bounded, versioned conflict with
the current parsed lifecycle view and writes no case, timeline, or audit row.

Restore ordering uses the greatest valid monotonic sequence in that case's
timeline, never the recording clock or array order. Unknown statuses and
malformed clocks or sequences are skipped. Equal server timestamps therefore
cannot cause an older working status to win.

The existing `run:strategies` capability, case-access concealment, audit shape,
and `401`/`403` authentication-loss behavior remain unchanged. Ordinary working
status changes may continue through the generic status route, but the Runtime
V1 archive and restore commands use only the action-specific lifecycle route.

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
- keyboard operation, screen-reader-facing names/landmarks/order,
  zoom-equivalent reflow, forced-colors/high-contrast operability, reduced
  motion, and non-drag operation meet the shared accessibility baseline.

## Delivery and freeze

At accepted candidate `6cabdc7b`, delivery steps 1–6 are implemented: typed
transport contracts, deterministic fixtures and dependency guard, gateway and
bounded errors, race-safe controllers and provider, versioned strategy
renderer, and the Investigation First migration. War Room lifecycle also uses
Runtime V1; its remaining direct calls are held to a non-growing legacy
allowlist.

Local acceptance evidence at that exact candidate:

- contracts: 52 files and 672 tests passed;
- web: 63 files and 856 tests passed;
- contracts, server, web, and browser typechecks passed; contracts, server, and
  web lint passed;
- the production web build passed;
- the complete collaboration test command passed: contracts 672 tests, server
  806 tests with 81 environment-backed cases intentionally skipped, and web
  856 tests; and
- hands-on synthetic-demo acceptance passed for fast create, reusable context
  values, sparse detail, evidence selection and metadata, reversible technical
  handoff, focus, strategy-aware titles, and 390-pixel reflow without
  horizontal overflow or console warnings; and
- exact-head hosted browser automation passed 91 scenarios, with eight documented
  environment-specific scenarios intentionally skipped. The Investigation
  First conformance suite covers semantic names and landmarks, keyboard-only
  create/browse/evidence/lifecycle work, 200%-equivalent reflow across list and
  detail, forced-colors focus and control boundaries, reduced motion, and
  non-drag operation.

The exact candidate passed all 53 hosted PR checks: 51 succeeded and two were
intentionally skipped. The full CI workflow completed successfully, including
the required `rust tests (ubuntu aggregate)` check, in
[run 33307838835](https://github.com/chriscase/ContextDesk/actions/runs/33307838835).
Fresh exact-head Claude, Grok Build, and Cursor reviews each reported no P0 or
P1 blocker. Their remaining findings were non-blocking test-depth, wording, and
checkpoint-documentation observations; none identified an authority, data,
permission, lifecycle, transport, or accessibility-boundary defect. Those
reviews did not independently rerun every suite, so the command and browser
claims above rely on the recorded local and hosted evidence rather than model
review alone.

Known non-blockers are the existing production chunk-size warning and the
intentional, non-growing War Room legacy allowlist. Runtime V1 is now the
frozen public surface for later strategies. Extensions must remain additive and
versioned; a strategy must not import candidate or private runtime internals.
