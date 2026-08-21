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
