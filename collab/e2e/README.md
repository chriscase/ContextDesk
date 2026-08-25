# @cd-collab/e2e

Browser qualification for the collab case-memory shell. See
[`docs/testing/COLLAB_WAR_ROOM_BROWSER_QUALIFICATION_V1.md`](../../docs/testing/COLLAB_WAR_ROOM_BROWSER_QUALIFICATION_V1.md).

```bash
cd collab
npx playwright install --with-deps chromium
npm run e2e
```

The provider-free bridge vertical can be exercised separately with:

```bash
COLLAB_E2E_BRIDGE=1 npm run e2e
```

That mode invokes the real `RustBridgeTriageExecutor` against a checked-in
fixture command. It proves request construction, bounded progress, result
identity, snapshot binding, and the browser handoff to Experiment Lab; it does
not contact a provider or use credentials.

## War Room scenario and acceptance harness

Ten deterministic, offline journeys for repeated Computer Use acceptance of the
War Room. The catalog in [`src/war-room/scenarios.ts`](src/war-room/scenarios.ts)
is the single source of truth for three consumers — the journeys under
`specs/19..22-war-room-*.spec.ts`, the acceptance reports, and the reviewed
matrix at [`docs/WAR_ROOM_SCENARIO_MATRIX.md`](../../docs/WAR_ROOM_SCENARIO_MATRIX.md).

Each scenario declares, in the words a responder would use:

| Field | Meaning |
| --- | --- |
| `triageQuestion` | The one question the responder opened the War Room to answer |
| `expectedEvidence` | What a human must be able to read on screen |
| `expectedProvenance` | Where each visible fact came from, as the surface states it |
| `expectedUnknowns` | What must stay explicitly unknown — never a backlog item |
| `usefulNextActions` | What the surface should make obvious as the next move |
| `deepLinks` | Addresses the journey must be able to land on directly |
| `assertions` | Pass/fail usability claims, each with its own `failsWhen` |

```bash
cd collab
npm run build -w @cd-collab/contracts && npm run build -w @cd-collab/web
npm run test -w @cd-collab/e2e -- specs/19-war-room-intake.spec.ts \
  specs/20-war-room-collaboration.spec.ts \
  specs/21-war-room-lanes-and-deployment.spec.ts \
  specs/22-war-room-a11y-responsive.spec.ts
```

Journey 9 (partial and failed model lanes) needs the degraded bridge fixture,
which reports one completed, one partial, and one failed lane over the real host
wire contract. It is skipped otherwise:

```bash
COLLAB_E2E_BRIDGE=degraded npm run test -w @cd-collab/e2e -- \
  specs/21-war-room-lanes-and-deployment.spec.ts
```

### Acceptance reports

Every journey writes `test-results/war-room-acceptance/<scenario>.json`
recording the declared expectations, each assertion's outcome and what the run
actually observed, and the deep links it opened. The recorder fails closed in
both directions: a spec cannot assert a claim the catalog never made, and a
journey that never reaches one of its own declared assertions — or never opens
one of its declared deep links — fails instead of passing quietly.

### Regenerating the matrix

```bash
npm run scenarios:matrix -w @cd-collab/e2e   # write docs/WAR_ROOM_SCENARIO_MATRIX.md
npm run scenarios:check  -w @cd-collab/e2e   # fail if the committed matrix is stale
```

### Fixtures

Every byte under [`fixtures/war-room/`](fixtures/war-room) is authored for these
tests: synthetic logs, a forwarded correspondence chain, and a pasted external
chat transcript, all using RFC 2606 reserved domains and RFC 5737 documentation
addresses. `scripts/check_war_room_fixtures.mjs` fails the build on a
non-reserved domain or address, or on anything shaped like a credential.

No journey asserts that a model was correct, fast, or better than another, and
none asserts a provider usage or cost figure: the product reports those as
`unknown`, and the journeys keep them unknown.
