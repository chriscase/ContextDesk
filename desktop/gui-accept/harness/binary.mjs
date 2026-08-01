/**
 * Locate or build the real SPA-embedded ContextDesk release host.
 * Never uses a mocked host or DOM-only stand-in for host behavior.
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  cpSync,
  rmSync,
  writeFileSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hostOs } from "./platform.mjs";

/**
 * SPA-embed markers grepped from a production `custom-protocol` binary.
 * cfg(dev) hosts that only load Vite localhost will not contain these.
 */
export const SPA_EMBED_MARKERS = [
  /critical-boot/,
  /ibm-plex/,
  /index-[A-Za-z0-9_-]{4,}\.(js|css)/,
];

const here = dirname(fileURLToPath(import.meta.url));
const GUI_ACCEPT_ROOT = join(here, "..");
const DESKTOP_ROOT = join(GUI_ACCEPT_ROOT, "..");
const REPO_ROOT = join(DESKTOP_ROOT, "..");
const TAURI_DIR = join(DESKTOP_ROOT, "src-tauri");

/**
 * @returns {string} absolute path to repo root
 */
export function repoRoot() {
  return process.env.GUI_ACCEPT_REPO_ROOT || REPO_ROOT;
}

/**
 * Candidate binary paths (release first).
 * @param {string} [root]
 * @returns {string[]}
 */
export function candidateBinaries(root = repoRoot()) {
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ||
    join(root, "desktop", "src-tauri", "target");
  const osName = hostOs();
  const names =
    osName === "windows"
      ? ["contextdesk.exe", "ContextDesk.exe"]
      : ["contextdesk", "ContextDesk"];

  const dirs = [
    join(cargoTarget, "release"),
    join(root, "desktop", "src-tauri", "target", "release"),
  ];

  /** @type {string[]} */
  const out = [];
  if (process.env.GUI_ACCEPT_APP_BINARY) {
    out.push(process.env.GUI_ACCEPT_APP_BINARY);
  }
  for (const d of dirs) {
    for (const n of names) {
      out.push(join(d, n));
    }
  }
  return [...new Set(out)];
}

/**
 * @param {string} [root]
 * @returns {string|null}
 */
export function findExistingBinary(root = repoRoot()) {
  for (const p of candidateBinaries(root)) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* continue */
    }
  }
  return null;
}

export function findBuiltReleaseBinary(root = repoRoot()) {
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ||
    join(root, "desktop", "src-tauri", "target");
  const names = hostOs() === "windows"
    ? ["contextdesk.exe", "ContextDesk.exe"]
    : ["contextdesk", "ContextDesk"];
  for (const name of names) {
    const candidate = join(cargoTarget, "release", name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Build the real release host with SPA embedded.
 *
 * Must pass `--features custom-protocol`. Without it, tauri-build emits
 * `cargo:rustc-cfg=dev` and the WebView loads `build.devUrl` (localhost Vite)
 * → blank window "Could not connect to localhost".
 *
 * This function always invokes the build; caller-side reuse is a separate,
 * explicitly non-exact resolution mode.
 *
 * @returns {{ ok: boolean, binary: string|null, log: string, ms: number }}
 */
export function buildHostBinary() {
  const started = Date.now();
  const root = repoRoot();
  const desktop = join(root, "desktop");
  const tauri = join(desktop, "src-tauri");

  // Frontend dist must exist before cargo embeds it
  const frontend = spawnSync("npm", ["run", "build"], {
    cwd: desktop,
    encoding: "utf8",
    env: process.env,
    timeout: 15 * 60 * 1000,
  });
  let log = `=== npm run build ===\n${frontend.stdout || ""}\n${frontend.stderr || ""}\n`;
  if (frontend.status !== 0) {
    return {
      ok: false,
      binary: null,
      log,
      ms: Date.now() - started,
    };
  }

  const args = [
    "build",
    "--manifest-path",
    join(tauri, "Cargo.toml"),
    "--features",
    "custom-protocol",
  ];
  args.push("--release");
  const r = spawnSync("cargo", args, {
    cwd: tauri,
    encoding: "utf8",
    env: process.env,
    timeout: 45 * 60 * 1000,
  });
  log += `=== cargo build --features custom-protocol ===\n${r.stdout || ""}\n${r.stderr || ""}\n`;
  // Never consult GUI_ACCEPT_APP_BINARY here: a successful forced build must
  // return only the release executable produced under this checkout's target.
  const binary = findBuiltReleaseBinary(root);
  return {
    ok: r.status === 0 && !!binary,
    binary,
    log,
    ms: Date.now() - started,
  };
}

/**
 * Stage demo-log-corpus beside the host binary for an unbundled Linux run.
 * Tauri resource_dir is the executable parent; install_demo_log_corpus expects
 * `demo-log-corpus/seven-day-25k` there (same layout as bundle.resources).
 *
 * Hermetic: only the checked-in fixtures/log-lab acceptance tree — never a
 * developer corpus cache under ~/.contextdesk or another worktree.
 *
 * @param {string} binaryPath
 * @param {string} [root]
 * @returns {{ ok: boolean, dest: string|null, log: string }}
 */
export function stageDemoLogResource(binaryPath, root = repoRoot()) {
  if (!binaryPath || !existsSync(binaryPath)) {
    return { ok: false, dest: null, log: "no binary for demo staging" };
  }
  const src = join(
    root,
    "fixtures",
    "log-lab",
    "acceptance",
    "seven-day-25k",
    "scenarios",
    "behavior-scale",
    "import",
  );
  if (!existsSync(src)) {
    return { ok: false, dest: null, log: `demo fixture missing: ${src}` };
  }
  // Reject accidental developer-cache sources
  if (/[/\\]\.contextdesk[/\\]|[/\\]cache[/\\]log_corpora[/\\]/.test(src)) {
    return {
      ok: false,
      dest: null,
      log: `refusing developer corpus cache path: ${src}`,
    };
  }
  const exeDir = dirname(binaryPath);
  const dest = join(exeDir, "demo-log-corpus", "seven-day-25k");
  try {
    // tauri-utils: Linux cargo-output resource_dir requires .cargo-lock beside exe
    writeFileSync(join(exeDir, ".cargo-lock"), "");
    rmSync(join(exeDir, "demo-log-corpus"), {
      recursive: true,
      force: true,
    });
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    return { ok: true, dest, log: `staged demo resource → ${dest} (+ .cargo-lock)` };
  } catch (e) {
    return { ok: false, dest, log: `demo stage failed: ${e}` };
  }
}

/** Combined pattern matching run-linux-docker.sh SPA embed check. */
const SPA_GREP_PATTERN =
  "critical-boot|ibm-plex|index-[A-Za-z0-9_-]{4,}\\.(js|css)";

/**
 * Probe whether a binary embeds the frontend SPA (custom-protocol / production).
 * Fail-closed: missing file → not embedded.
 *
 * Uses system `grep -a` for large ELF hosts (100MB+) so we scan the full binary
 * without loading it into JS heap; falls back to in-process scan when grep is absent.
 *
 * @param {string} binaryPath
 * @returns {{ ok: boolean, reason: string, size: number }}
 */
export function probeSpaEmbedded(binaryPath) {
  if (!binaryPath || !existsSync(binaryPath)) {
    return { ok: false, reason: "binary missing", size: 0 };
  }
  let st;
  try {
    st = statSync(binaryPath);
  } catch (e) {
    return { ok: false, reason: `stat failed: ${e}`, size: 0 };
  }
  if (!st.isFile() || st.size < 1024) {
    return { ok: false, reason: "not a usable file", size: st.size };
  }

  // Prefer full-file grep (same contract as Docker script)
  const grepped = spawnSync(
    "grep",
    ["-a", "-qE", SPA_GREP_PATTERN, binaryPath],
    { encoding: "utf8" },
  );
  if (grepped.error == null && grepped.status === 0) {
    return {
      ok: true,
      reason: "grep matched SPA embed markers",
      size: st.size,
    };
  }
  if (grepped.error == null && grepped.status === 1) {
    return {
      ok: false,
      reason:
        "SPA markers missing — binary likely built without --features custom-protocol (cfg(dev) / Vite localhost)",
      size: st.size,
    };
  }

  // Fallback: full read when small enough; otherwise multi-window scan
  /** @type {string} */
  let haystack;
  if (st.size <= 200 * 1024 * 1024) {
    haystack = readFileSync(binaryPath, "latin1");
  } else {
    const chunks = [];
    const fd = openSync(binaryPath, "r");
    try {
      const win = 8 * 1024 * 1024;
      const step = Math.max(win, Math.floor(st.size / 16));
      for (let off = 0; off < st.size; off += step) {
        const len = Math.min(win, st.size - off);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, off);
        chunks.push(buf);
      }
    } finally {
      closeSync(fd);
    }
    haystack = Buffer.concat(chunks).toString("latin1");
  }

  for (const re of SPA_EMBED_MARKERS) {
    if (re.test(haystack)) {
      return { ok: true, reason: `matched ${re}`, size: st.size };
    }
  }
  return {
    ok: false,
    reason:
      "SPA markers missing — binary likely built without --features custom-protocol (cfg(dev) / Vite localhost)",
    size: st.size,
  };
}

/**
 * Fail closed if the input is not a real SPA-embedded release host.
 * @param {string} binaryPath
 * @param {{ requireSpa?: boolean }} [opts]
 */
export function assertReleaseHostBinary(binaryPath, opts = {}) {
  const requireSpa = opts.requireSpa !== false;
  if (!binaryPath) throw new Error("assertReleaseHostBinary: empty path");
  if (!existsSync(binaryPath)) {
    throw new Error(`assertReleaseHostBinary: not found: ${binaryPath}`);
  }
  // Reject obvious Vite/dev server URLs mistaken for binary paths
  if (/^https?:\/\//i.test(binaryPath) || /localhost:\d+/.test(binaryPath)) {
    throw new Error(
      `assertReleaseHostBinary: path looks like a dev URL, not a host binary: ${binaryPath}`,
    );
  }
  if (/vite|webpack-dev|node_modules/i.test(binaryPath)) {
    throw new Error(
      `assertReleaseHostBinary: path looks like a frontend dev artifact: ${binaryPath}`,
    );
  }
  if (/(?:^|[/\\])debug(?:[/\\]|$)/i.test(binaryPath)) {
    throw new Error(
      `assertReleaseHostBinary: debug executable is outside release-host scope: ${binaryPath}`,
    );
  }
  if (requireSpa) {
    const probe = probeSpaEmbedded(binaryPath);
    if (!probe.ok) {
      throw new Error(`assertReleaseHostBinary: ${probe.reason} (${binaryPath})`);
    }
  }
  return true;
}

/**
 * Resolve a binary. An explicit build is authoritative and never reuses an
 * existing candidate, because an unlabelled release executable cannot prove
 * which source revision produced it.
 * @param {{ build?: boolean }} [opts]
 */
export function resolveBinary(opts = {}) {
  if (binaryResolutionMode(opts) === "build") {
    const result = buildHostBinary();
    const stage = result.binary
      ? stageDemoLogResource(result.binary)
      : { ok: false, dest: null, log: "no binary to stage demo" };
    return {
      binary: result.binary,
      built: true,
      log: `${result.log}\n${stage.log}`,
      ms: result.ms,
      ok: result.ok && stage.ok,
      demoResource: stage.dest,
      demoOk: stage.ok,
    };
  }

  const existing = findExistingBinary();
  if (!existing) {
    return { binary: null, built: false, log: "no binary found; build disabled" };
  }
  const stage = stageDemoLogResource(existing);
  return {
    binary: existing,
    built: false,
    log: `using existing binary (not exact-head proof)\n${stage.log}`,
    demoResource: stage.dest,
    demoOk: stage.ok,
  };
}

export function binaryResolutionMode(opts = {}) {
  return opts.build === false ? "existing-non-exact" : "build";
}

/** Return the checked-out source revision, or null outside a Git checkout. */
export function sourceRevision(root = repoRoot()) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Hash the exact executable bytes used by tauri-driver. */
export function binarySha256(binaryPath) {
  const hash = createHash("sha256");
  const fd = openSync(binaryPath, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export { GUI_ACCEPT_ROOT, DESKTOP_ROOT, TAURI_DIR };
