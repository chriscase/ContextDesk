# CLI multi-platform packaging & release

This document covers the **headless `contextdesk` binary** release path.
Desktop installers remain under [PACKAGING.md](./PACKAGING.md) and
`.github/workflows/release.yml`. The two workflows coexist; neither auto-publishes.

## Workflow

| Item | Value |
|------|--------|
| Workflow file | `.github/workflows/cli-release.yml` |
| Triggers | tag `v*`, `workflow_dispatch` (tag input required) |
| Platforms | **macos-arm64**, **macos-x64**, **linux-x64**, **windows-x64** |
| Build | `cargo build -p cd-cli --release --locked` with target triple |
| Identity env | `CD_GIT_SHA`, `CD_GIT_DESCRIBE`, `CD_CHANNEL` |
| Release attach | **draft only** (`draft: true`); operators publish manually |

## Embedded binary identity

At build time the workflow sets:

```text
CD_GIT_SHA=<full git rev-parse HEAD>
CD_GIT_DESCRIBE=<git describe --always --dirty --tags>
CD_CHANNEL=installed   # or workflow_dispatch input
```

Surfaces:

- `contextdesk --version` / long version (`CD_CLI_LONG_VERSION` from `cd-cli/build.rs`)
- `contextdesk capabilities --json` → `git_sha`, `git_describe`, `build_channel`, `cli_version`

Empty or placeholder identity fails the workflow and packaging scripts (fail-closed).

## Per-platform smoke (mandatory)

`scripts/cli-release/smoke_cli_artifact.sh` runs on each matrix runner:

1. `--version`
2. `capabilities --json` (identity checks when `EXPECT_*` set)
3. Isolated `--data-dir` synthetic import (`fixtures/cli-release-demo`)
4. `corpus list`
5. `explore "error" --corpus <id>`

`CLI_SMOKE_SKIP` is **rejected** when `CLI_SMOKE_REQUIRED=1` (CI default).
Structural tests fail if the workflow drops the smoke step.

### Normalized output

The smoke gate runs the shipped `normalize` command and validates its manifest,
report, per-source JSONL files, event-count parity, and contiguous `sourceSeq`
values. A release candidate cannot pass with a placeholder normalize check.

## Archive layout

Name: `contextdesk-<version>-<platform>.tar.gz` (Windows: `.zip`)

Contents:

| Entry | Purpose |
|-------|---------|
| `contextdesk` / `contextdesk.exe` | Binary |
| `QUICKSTART.md` | Operator quick start |
| `CLI.md` | CLI reference |
| `LICENSE` | Apache-2.0 |
| `THIRD_PARTY_NOTICES.md` | Third-party notice pointer |
| `build-info.json` | Version, platform, git, channel, unsigned status |
| `demo/` | Synthetic public demo logs |

Aggregate attachables:

- `SHA256SUMS`
- `sbom.cdx.json` (CycloneDX 1.5 JSON)
- `release-manifest.json` (`draft: true`, `published: false`, `auto_publish: false`)

Packaging implementation: `scripts/cli-release/package_cli_release.py` (offline-testable).

## Provenance / attestation

The draft-release job requests `id-token: write` and runs
`actions/attest-build-provenance` with `continue-on-error: true` so runners
that lack attestation support do not block the draft attach. Operators should
confirm attestation artifacts on GitHub when the action succeeds.

## Unsigned RC vs future signing

| Platform | This workflow | Future residual |
|----------|---------------|-----------------|
| macOS | **Unsigned** RC; Gatekeeper may warn | Developer ID sign + **notarization** + staple |
| Windows | **Unsigned** RC; SmartScreen may warn | **Authenticode** (EV/OV cert) |
| Linux | Unsigned ELF (normal for many distros) | Optional packaging signatures (distro-specific) |

**Honesty:** do not claim notarized or Authenticode-signed CLI builds from this
workflow. Code signing secrets must never be committed; wire them only via
GitHub Actions secrets when a future signing job is added.

## Draft-only policy

- `softprops/action-gh-release` is configured with `draft: true`.
- `release-manifest.json` records `published: false` / `auto_publish: false`.
- `package_cli_release.py assert-draft-only` fails if a manifest claims published.
- Mutation tests fail if the workflow YAML sets `draft: false` or drops draft.

Publishing is always a **manual** operator step in the GitHub UI.

## One-command local build

From the repository root:

```powershell
# Windows PowerShell 5.1+ or PowerShell 7
.\scripts\cli-release\build_cli_release.ps1
```

```bash
# macOS or Linux
./scripts/cli-release/build_cli_release.sh
```

Both scripts embed the exact Git identity, build the release binary, exercise
offline import/explore/normalize, and create an unsigned teammate-ready archive
under `dist/cli-local/`. Windows produces a ZIP; macOS/Linux produce a
`tar.gz`. Use PowerShell `-NoPackage` to build and smoke without requiring
Python, or `-SkipSmoke` only for local iteration (never release acceptance).

Prerequisites: Git, the stable Rust toolchain, and platform C/C++ build tools.
Archive creation also needs Python 3. On Windows, install Visual Studio Build
Tools with **Desktop development with C++**, then run the PowerShell script from
a Developer PowerShell or a shell where `cargo`, `git`, and `python` are on PATH.

## Manual local packaging dry-run

```bash
export CD_GIT_SHA=$(git rev-parse HEAD)
export CD_GIT_DESCRIBE=$(git describe --always --dirty --tags)
export CD_CHANNEL=installed
cargo build -p cd-cli --release --locked
export CONTEXTDESK_BIN=target/release/contextdesk
export EXPECT_GIT_SHA=$CD_GIT_SHA EXPECT_CHANNEL=$CD_CHANNEL
bash scripts/cli-release/smoke_cli_artifact.sh
export CLI_VERSION=0.1.0-local CLI_PLATFORM=macos-arm64 \
  CLI_GIT_SHA=$CD_GIT_SHA CLI_GIT_DESCRIBE=$CD_GIT_DESCRIBE \
  CLI_CHANNEL=$CD_CHANNEL CLI_TRIPLE=$(rustc -vV | awk '/host:/{print $2}') \
  CLI_OUT_DIR=/tmp/cd-cli-dist
python3 scripts/cli-release/package_cli_release.py package
```

## Structural / mutation tests

```bash
python3 scripts/cli-release/check_cli_release_contract.py
```

These fail closed on: missing platform, empty identity, skipped smoke,
missing checksums, or claiming a published release pass from draft-only CI.

## Remaining release work

1. Optional later: macOS notarization and Windows Authenticode jobs.
2. Desktop `release.yml` remains independent; do not merge draft semantics into auto-publish.
