# ContextDesk Linux release-host GUI integration

This harness drives a real, SPA-embedded ContextDesk **release executable** with
WebdriverIO, `tauri-driver`, and WebKitWebDriver on Linux.

It does **not** prove an installed `.app`, AppImage, or deb; macOS or Windows;
OS-native pointer/focus behavior; or a live provider. Those claims remain in
the native/package acceptance lanes.

## Trust boundary

- Production Tauri commands and the production WebView are exercised. Host IPC
  is not mocked.
- The SUT receives an isolated temporary home/config/workspace and a local
  Ollama reachability stub. Ambient provider endpoints and credentials are
  removed from the child environment.
- The 25k corpus and canonical ZIP come only from checked-in synthetic fixtures.
- JavaScript-dispatched pointer/context-menu events are renderer-path evidence,
  not OS-native input evidence.

## Exact-head mode

`GUI_ACCEPT_EXACT_HEAD=1` forces a fresh frontend + Rust release build. It never
reuses an existing executable. Every run records the checkout SHA and SHA-256
of the exact executable in `binary-identity.json`; hosted CI also verifies that
the checkout SHA equals `GITHUB_SHA`.

Without exact-head mode, an explicitly supplied/existing release executable may
be used for local diagnosis, but `result.json` labels that proof non-exact.

## Run

```bash
eval "$(scripts/local-build-cache.sh activate)"
cd desktop
npm ci
cd gui-accept
npm ci
npm test

# Linux GUI/display required; this builds the exact current checkout.
GUI_ACCEPT_EXACT_HEAD=1 GUI_ACCEPT_REQUIRE_RELEASE_HOST=1 \
  xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
  npm run run
```

On unsupported hosts, matrix/self-tests and fixture preparation still run; set
`GUI_ACCEPT_REQUIRE_RELEASE_HOST=1` to make unsupported execution fail closed.

## Automated scenarios

| Spec | Evidence |
|------|----------|
| `01-launch` | Release-host launch and main-window readiness |
| `02-import-25k` | Production demo install, progress, cancellation, trusted-host no-partial-publication check before retry |
| `03-explorer-lifecycle` | Explorer counts/facets and close/reopen lifecycle |
| `04-noise-review` | Renderer pointerdown/click route into noise review |
| `05-suppress-preview-cancel` | Preview/cancel host path and suppression rule-count integrity |
| `07-chat-context-menu-edge` | WebKit renderer geometry/readability at the viewport edge (#837) |

There is no 100k or 250k scenario in this suite. Generated-but-unused fixture
directories and skipped tests are intentionally not reported as smoke proof.

## Process and fixture determinism

The orchestrator allocates a fresh driver port, rejects an existing listener,
races driver readiness against driver exit, and terminates the whole
driver/application process tree on failure, completion, or timeout. ZIP paths
are sorted and metadata timestamps fixed, so source mtimes cannot change bytes.

## Artifacts

Each run creates `desktop/gui-accept/.runs/gui-accept-<stamp>/` containing:

- `result.json`, `binary.json`, and `binary-identity.json`
- support matrix, logs, screenshots, timings, and failure bundles
- canonical synthetic `fixtures/seven-day-25k.zip` plus its digest

Artifacts contain local absolute paths. Review them before external sharing.

## CI

- Default PR CI runs the dependency-locked, WebDriver-free harness contracts.
- `.github/workflows/gui-accept.yml` is optional/manual/nightly and runs the
  exact-head Linux release-host scenarios on Ubuntu 24.04.
- The heavy workflow is not a required status check and does not weaken any
  existing gate.

For a local Docker convenience run, use
`desktop/gui-accept/scripts/run-linux-docker.sh`. Its result remains local
release-host evidence unless its recorded identity satisfies an exact-head
promotion requirement.
