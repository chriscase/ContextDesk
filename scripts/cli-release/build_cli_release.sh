#!/usr/bin/env bash
# One-command local CLI build, smoke, and archive for macOS/Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
GIT_SHA="$(git rev-parse HEAD)"
GIT_DESCRIBE="$(git describe --always --dirty --tags)"
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
case "$TRIPLE" in
  aarch64-apple-darwin) PLATFORM=macos-arm64 ;;
  x86_64-apple-darwin) PLATFORM=macos-x64 ;;
  x86_64-unknown-linux-gnu) PLATFORM=linux-x64 ;;
  *) echo "Unsupported local release target: $TRIPLE" >&2; exit 2 ;;
esac

export CD_GIT_SHA="$GIT_SHA"
export CD_GIT_DESCRIBE="$GIT_DESCRIBE"
export CD_CHANNEL="${CLI_CHANNEL:-dev}"
export CLI_VERSION="${CLI_VERSION:-0.1.0-local}"
export CLI_PLATFORM="$PLATFORM"
export CLI_GIT_SHA="$GIT_SHA"
export CLI_GIT_DESCRIBE="$GIT_DESCRIBE"
export CLI_CHANNEL="$CD_CHANNEL"
export CLI_TRIPLE="$TRIPLE"
export CLI_OUT_DIR="${CLI_OUT_DIR:-$ROOT/dist/cli-local}"

echo "Building ContextDesk CLI $CLI_VERSION for $PLATFORM at $GIT_DESCRIBE"
cargo build -p cd-cli --release --locked
export CONTEXTDESK_BIN="$ROOT/target/release/contextdesk"
export EXPECT_GIT_SHA="$GIT_SHA"
export EXPECT_CHANNEL="$CD_CHANNEL"
export CLI_SMOKE_REQUIRED=1
"$ROOT/scripts/cli-release/smoke_cli_artifact.sh"
python3 "$ROOT/scripts/cli-release/package_cli_release.py" package
echo "Release archive written under $CLI_OUT_DIR"
