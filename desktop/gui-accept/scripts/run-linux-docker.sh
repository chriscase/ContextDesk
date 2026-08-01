#!/usr/bin/env bash
# Run local Linux release-host GUI integration with xvfb + tauri-driver.
# Captures orchestrator artifacts under desktop/gui-accept/.runs/ (bind-mounted).
#
# Usage (from repo root or this dir):
#   bash desktop/gui-accept/scripts/run-linux-docker.sh
#
# Env:
#   GUI_ACCEPT_DOCKER_IMAGE  default: ubuntu:24.04
#   GUI_ACCEPT_DOCKER_SKIP_BUILD=1  reuse existing linux binary if present in container target

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$GUI_ROOT/../.." && pwd)"
# 24.04: ort-sys prebuilts need glibc ≥2.38 (__isoc23_strtoull); 22.04 fails at link.
IMAGE="${GUI_ACCEPT_DOCKER_IMAGE:-ubuntu:24.04}"
CARGO_HOME_VOL="contextdesk-gui-accept-cargo-home-linux"
RUSTUP_VOL="contextdesk-gui-accept-rustup-linux"
CARGO_TARGET_VOL="contextdesk-gui-accept-cargo-target-linux"
NPM_VOL="contextdesk-gui-accept-npm-linux"

echo "repo=$REPO_ROOT image=$IMAGE"

docker volume create "$CARGO_HOME_VOL" >/dev/null
docker volume create "$RUSTUP_VOL" >/dev/null
docker volume create "$CARGO_TARGET_VOL" >/dev/null
docker volume create "$NPM_VOL" >/dev/null

# Shell script executed inside the container
docker run --rm \
  --name "contextdesk-gui-accept-linux-$$" \
  -v "$REPO_ROOT:/work:rw" \
  -v "$CARGO_HOME_VOL:/cargo-home" \
  -v "$RUSTUP_VOL:/rustup" \
  -v "$CARGO_TARGET_VOL:/cargo-target" \
  -v "$NPM_VOL:/npm-cache" \
  -e CARGO_HOME=/cargo-home \
  -e RUSTUP_HOME=/rustup \
  -e CARGO_TARGET_DIR=/cargo-target \
  -e npm_config_cache=/npm-cache \
  -e GUI_ACCEPT_REQUIRE_RELEASE_HOST=1 \
  -e GUI_ACCEPT_FORCE_BUILD="${GUI_ACCEPT_FORCE_BUILD:-0}" \
  -e TAURI_DRIVER_PATH=/cargo-home/bin/tauri-driver \
  -e CARGO_HOME=/cargo-home \
  -e WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  -e DEBIAN_FRONTEND=noninteractive \
  -w /work \
  "$IMAGE" \
  bash -lc '
set -euo pipefail
export PATH="/usr/local/cargo/bin:/root/.cargo/bin:$PATH"

echo "=== [linux-docker] apt deps ==="
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates build-essential pkg-config \
  g++ clang cmake ninja-build \
  libwebkit2gtk-4.1-dev webkit2gtk-driver \
  libayatana-appindicator3-dev librsvg2-dev patchelf \
  libgtk-3-dev libssl-dev libsoup-3.0-dev \
  xvfb xauth \
  libasound2-dev \
  git \
  > /tmp/apt.log 2>&1 || { tail -50 /tmp/apt.log; exit 1; }
c++ --version | head -1

# Node 20
if ! command -v node >/dev/null 2>&1; then
  echo "=== [linux-docker] install node 20 ==="
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node -v
npm -v

# Rust + rustup on persistent volumes
export CARGO_HOME="${CARGO_HOME:-/cargo-home}"
export RUSTUP_HOME="${RUSTUP_HOME:-/rustup}"
export PATH="$CARGO_HOME/bin:$PATH"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  echo "=== [linux-docker] install rustup ==="
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
fi
export PATH="$CARGO_HOME/bin:$PATH"
rustup default stable
rustup show
rustc --version
cargo --version

echo "=== [linux-docker] tauri-driver ==="
cargo install tauri-driver --locked 2>&1 | tail -5
which tauri-driver
tauri-driver --help 2>&1 | head -5 || true
which WebKitWebDriver || ls /usr/bin/*WebKit* 2>/dev/null || true

echo "=== [linux-docker] desktop frontend + production host binary ==="
# CRITICAL: cargo build without --features custom-protocol emits cargo:rustc-cfg=dev
# so the WebView loads build.devUrl (http://localhost:1450) → blank
# "Could not connect to localhost". custom-protocol embeds frontendDist.
cd /work/desktop
npm ci
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/cargo-target}"
BUILT=""
# Reuse SPA-embedded production binary unless GUI_ACCEPT_FORCE_BUILD=1
if [ "${GUI_ACCEPT_FORCE_BUILD:-0}" != "1" ]; then
  for c in \
    /cargo-target/release/contextdesk \
    /work/desktop/src-tauri/target/release/contextdesk; do
    if [ -x "$c" ] && grep -a -qE "critical-boot|ibm-plex|index-[A-Za-z0-9_-]{4,}\\.(js|css)" "$c"; then
      BUILT="$c"
      echo "Reusing SPA-embedded binary: $BUILT (set GUI_ACCEPT_FORCE_BUILD=1 to rebuild)"
      break
    fi
  done
fi
if [ -z "$BUILT" ]; then
  npm run build
  # Drop any prior cfg(dev) binary so we never reuse a blank-window artifact.
  rm -f "$CARGO_TARGET_DIR/release/contextdesk" \
    "$CARGO_TARGET_DIR/release/ContextDesk" \
    /work/desktop/src-tauri/target/release/contextdesk \
    /work/desktop/src-tauri/target/release/ContextDesk 2>/dev/null || true
  cd /work/desktop/src-tauri
  set +e
  cargo build --release --features custom-protocol 2>&1 | tee /tmp/cargo-release.log
  CARGO_RC=${PIPESTATUS[0]}
  set -e
  if [ "$CARGO_RC" -ne 0 ]; then
    echo "=== cargo release FAILED (exit $CARGO_RC); last 80 lines ==="
    tail -80 /tmp/cargo-release.log
    dmesg 2>/dev/null | tail -20 || true
    exit "$CARGO_RC"
  fi
  for c in \
    /cargo-target/release/contextdesk \
    /work/desktop/src-tauri/target/release/contextdesk \
    /cargo-target/release/ContextDesk; do
    if [ -x "$c" ]; then BUILT="$c"; break; fi
  done
fi
if [ -z "$BUILT" ]; then
  echo "ERROR: host binary not found after production cargo build"
  find /cargo-target/release -maxdepth 2 -type f -perm -111 2>/dev/null | head -20
  exit 3
fi
# tauri-utils resource_dir: Linux cargo-output detection requires a path segment
# named "target" (.../target/<profile>/exe) PLUS .cargo-lock beside the binary.
# CARGO_TARGET_DIR=/cargo-target alone does NOT match, so copy into a real
# .../target/release/ layout the app will resolve as resource_dir.
HOST_DIR="/work/desktop/src-tauri/target/release"
mkdir -p "$HOST_DIR"
BIN="$HOST_DIR/contextdesk"
# When reusing a binary already at HOST_DIR/contextdesk, skip same-file cp.
if [ "$(readlink -f "$BUILT" 2>/dev/null || echo "$BUILT")" != "$(readlink -f "$BIN" 2>/dev/null || echo "$BIN")" ]; then
  cp -a "$BUILT" "$BIN"
fi
chmod +x "$BIN"
touch "$HOST_DIR/.cargo-lock"
echo "BINARY=$BIN (from $BUILT)"
ls -la "$BIN" "$HOST_DIR/.cargo-lock"
if command -v file >/dev/null 2>&1; then file "$BIN"; fi
# Fail closed if SPA not embedded (cfg(dev) binary loads localhost Vite).
# Double-quotes only: this block sits inside bash -lc single-quoted string.
if ! grep -a -qE "critical-boot|ibm-plex|index-[A-Za-z0-9_-]{4,}\\.(js|css)" "$BIN"; then
  echo "ERROR: SPA markers missing in binary — missing --features custom-protocol?"
  echo "Rebuild with: cargo build --release --features custom-protocol"
  exit 4
fi
echo "SPA embed check: ok"

# Stage demo-log-corpus under resource_dir (exe parent).
DEMO_SRC="/work/fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import"
DEMO_DST="$HOST_DIR/demo-log-corpus/seven-day-25k"
if [ ! -d "$DEMO_SRC" ]; then
  echo "ERROR: demo corpus fixture missing at $DEMO_SRC"
  exit 5
fi
rm -rf "$HOST_DIR/demo-log-corpus"
mkdir -p "$DEMO_DST"
cp -a "$DEMO_SRC"/. "$DEMO_DST"/
echo "DEMO_RESOURCE=$DEMO_DST"
ls "$DEMO_DST" | head -20

echo "=== [linux-docker] gui-accept npm + self-test ==="
cd /work/desktop/gui-accept
npm ci
npm test

echo "=== [linux-docker] release-host scenarios under xvfb ==="
export GUI_ACCEPT_APP_BINARY="$BIN"
export GUI_ACCEPT_REQUIRE_RELEASE_HOST=1
export GUI_ACCEPT_RUN_ROOT=/work/desktop/gui-accept/.runs
export TAURI_DRIVER_PATH="${TAURI_DRIVER_PATH:-/cargo-home/bin/tauri-driver}"
export CARGO_HOME="${CARGO_HOME:-/cargo-home}"
export PATH="$CARGO_HOME/bin:$PATH"
# Do not rebuild again — binary is already $BIN
export GUI_ACCEPT_APP_BINARY="$BIN"
mkdir -p "$GUI_ACCEPT_RUN_ROOT"
# 90m wall for full suite including import
set +e
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
  env \
    GUI_ACCEPT_APP_BINARY="$BIN" \
    TAURI_DRIVER_PATH="$TAURI_DRIVER_PATH" \
    CARGO_HOME="$CARGO_HOME" \
    GUI_ACCEPT_REQUIRE_RELEASE_HOST=1 \
    GUI_ACCEPT_RUN_ROOT="$GUI_ACCEPT_RUN_ROOT" \
    PATH="$PATH" \
    node harness/run.mjs 2>&1 | tee /work/desktop/gui-accept/.runs/linux-docker-orchestrator.log
RC=${PIPESTATUS[0]}
set -e
echo "LINUX_DOCKER_HARNESS_EXIT=$RC"
# Copy summary
ls -la /work/desktop/gui-accept/.runs/ | tail -20
# Print latest result.json if any
LATEST=$(ls -td /work/desktop/gui-accept/.runs/gui-accept-* 2>/dev/null | head -1 || true)
if [ -n "$LATEST" ] && [ -f "$LATEST/result.json" ]; then
  echo "=== result.json ==="
  cat "$LATEST/result.json"
fi
exit "$RC"
'
echo "docker run finished exit=$?"
