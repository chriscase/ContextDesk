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

When the product **normalize** branch is integrated and capabilities advertise
normalize surfaces, smoke will require normalized-output validation.
At base `ade184b1` that surface is **not** required; the smoke script residual-skips
with an explicit message rather than inventing green normalize checks.

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

## Local packaging dry-run

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

## Integration order (with other lanes)

1. Land this CLI release/protocol lane (low conflict: workflows, scripts, docs, clients).
2. Integrate normalize-grammar when ready → extend smoke for normalized-output validation.
3. Optional later: macOS notarization job, Windows Authenticode job (secrets + residual docs).
4. Desktop `release.yml` remains independent; do not merge draft semantics into auto-publish.
