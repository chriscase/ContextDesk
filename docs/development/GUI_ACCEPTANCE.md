# Linux release-host GUI integration

## Purpose and limits

The `desktop/gui-accept` lane reduces repetitive renderer/host integration
checking on Linux. It drives a freshly built SPA-embedded release executable
through `tauri-driver` and WebKitWebDriver without adding production plugins or
capabilities.

This is not installed-bundle acceptance and not native-input acceptance.
macOS `.app` packaging, OS pointer/focus behavior, relaunch persistence, and
owner-visible native polish remain in the native automation/acceptance lane.
Windows is not claimed until known-folder isolation, driver discovery, and a
hosted Windows run exist.

## Proof contract

Hosted runs set `GUI_ACCEPT_EXACT_HEAD=1`, which forces a new build and records:

- checked-out source SHA (also matched against `GITHUB_SHA`);
- SHA-256 of the executable passed to `tauri-driver`;
- whether the executable was built during that run;
- explicit proof scope in `result.json`.

A locally reused executable is labelled non-exact and cannot close an issue or
support exact-head promotion by itself.

## Isolation and cleanup

The SUT receives a temporary home, config, workspace, and synthetic provider
stub. Provider endpoints and credential-shaped environment variables are
removed. A fresh loopback driver port is allocated per run; stale listeners are
rejected; readiness is tied to the spawned driver; and bounded teardown kills
the entire driver/application process tree.

The 25k ZIP is canonical pure-JavaScript output with sorted paths and fixed ZIP
timestamps. Checked-in synthetic bytes, not developer or company corpora, are
used. Artifact paths are not anonymized and must be reviewed before sharing.

## Scenario honesty

The suite has six executed scenario files: launch; 25k demo import and
cancellation; Explorer lifecycle; noise review; suppression preview/cancel; and
the #837 edge-menu renderer geometry check. Cancellation queries the trusted
host corpus list before retry and requires it to be byte-for-byte equivalent to
the pre-install identity snapshot.

The edge-menu scenario dispatches a renderer `contextmenu` event at edge
coordinates. It proves WebKit layout and readable labels, not a physical
right-click or native focus return. Suppression scenarios likewise include
synthetic DOM interaction and make only their explicit host/rule-count claims.

No 100k or 250k GUI scenario is implemented here.

## CI

Default PR CI runs the locked, WebDriver-free harness contracts. The heavy
Ubuntu 24.04 workflow is manual/weekly and optional. See
[`desktop/gui-accept/README.md`](../../desktop/gui-accept/README.md) for commands
and artifact layout.

## Handbook impact

None. This lane changes test infrastructure and developer documentation only;
it does not alter product evidence, permissions, or analysis contracts.
