#!/usr/bin/env node
/**
 * Packaged first-run demo corpus: manifest ↔ fixture ↔ packaging drift guard
 * (#732 / #739).
 *
 * Why this exists as a Node checker rather than a Rust test.
 *
 * `desktop/src-tauri` is a nested workspace, deliberately excluded from the
 * root members list (Cargo.toml). The `tauri-host` CI job runs `cargo fmt`,
 * `cargo clippy`, and `cargo check` only — never `cargo test`, and bare clippy
 * does not compile `#[cfg(test)]`. The host's own thorough demo tests therefore
 * do not execute in CI. The consequence is specific and silent: if the Log Lab
 * fixture is ever regenerated, `cd-core`'s fixture test still passes while the
 * hardcoded DEMO_LOG_RESOURCE_MANIFEST in the host rots, and the shipped demo
 * degrades to "Unavailable" for every user with no CI signal at all.
 *
 * This checker re-derives the same three facts from the repository, offline and
 * deterministically, in a job that does run.
 *
 * It proves fixture identity and packaging shape. It does not prove ingest
 * behavior, performance, or that the packaged application installs correctly —
 * those remain the host tests and the packaged native proof.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_SOURCE = "desktop/src-tauri/src/lib.rs";
const TAURI_CONF = "desktop/src-tauri/tauri.conf.json";
const FIXTURE_ROOT =
  "fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import";
/** Evaluator truth and generated metrics are siblings that must never ship. */
const FORBIDDEN_RESOURCE_SEGMENTS = ["truth", "metrics"];

function read(repositoryRoot, relativePath) {
  const full = path.resolve(repositoryRoot, relativePath);
  if (!fs.existsSync(full)) {
    throw new Error(`missing required file: ${relativePath}`);
  }
  return fs.readFileSync(full, "utf8");
}

/** Parse a `const NAME: u64 = 1_234;` style literal out of the host source. */
export function parseRustU64(source, name) {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*:\\s*u64\\s*=\\s*([0-9_]+)\\s*;`),
  );
  if (!match) {
    throw new Error(`${HOST_SOURCE}: could not read constant ${name}`);
  }
  return Number(match[1].replaceAll("_", ""));
}

/** Parse a `const NAME: &str = "value";` literal out of the host source. */
export function parseRustStr(source, name) {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)"\\s*;`),
  );
  if (!match) {
    throw new Error(`${HOST_SOURCE}: could not read constant ${name}`);
  }
  return match[1];
}

/**
 * Parse DEMO_LOG_RESOURCE_MANIFEST. Fails closed rather than silently
 * returning a short list, because an empty parse would make every downstream
 * comparison vacuously true.
 */
export function parseDemoManifest(source) {
  const start = source.indexOf("const DEMO_LOG_RESOURCE_MANIFEST");
  if (start < 0) {
    throw new Error(`${HOST_SOURCE}: DEMO_LOG_RESOURCE_MANIFEST is missing`);
  }
  const end = source.indexOf("\n];", start);
  if (end < 0) {
    throw new Error(`${HOST_SOURCE}: DEMO_LOG_RESOURCE_MANIFEST is unterminated`);
  }
  const block = source.slice(start, end);
  const entries = [];
  const entryRe =
    /DemoLogResourceEntry\s*\{\s*path:\s*"([^"]+)"\s*,\s*bytes:\s*([0-9_]+)\s*,\s*sha256:\s*"([0-9a-f]{64})"\s*,\s*\}/g;
  for (const match of block.matchAll(entryRe)) {
    entries.push({
      path: match[1],
      bytes: Number(match[2].replaceAll("_", "")),
      sha256: match[3],
    });
  }
  if (entries.length === 0) {
    throw new Error(
      `${HOST_SOURCE}: DEMO_LOG_RESOURCE_MANIFEST parsed to zero entries — the checker cannot be trusted, fix the parser`,
    );
  }
  // A struct literal the regex could not read would silently shrink the list.
  const literalCount = (block.match(/DemoLogResourceEntry\s*\{/g) ?? []).length;
  if (literalCount !== entries.length) {
    throw new Error(
      `${HOST_SOURCE}: DEMO_LOG_RESOURCE_MANIFEST has ${literalCount} entries but only ${entries.length} parsed`,
    );
  }
  return entries;
}

function walkFixture(root) {
  const found = [];
  const stack = [{ dir: root, prefix: "" }];
  while (stack.length > 0) {
    const { dir, prefix } = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${FIXTURE_ROOT}/${relative}: symlinks must not ship`);
      }
      if (entry.isDirectory()) {
        stack.push({ dir: full, prefix: relative });
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `${FIXTURE_ROOT}/${relative}: only regular files may ship`,
        );
      }
      found.push(relative);
    }
  }
  return found.sort();
}

export function validatePackagedDemoManifest(repositoryRoot) {
  const source = read(repositoryRoot, HOST_SOURCE);
  const manifest = parseDemoManifest(source);
  const expectedSources = parseRustU64(source, "DEMO_LOG_EXPECTED_SOURCES");
  const expectedEvents = parseRustU64(source, "DEMO_LOG_EXPECTED_EVENTS");
  const resourceDir = parseRustStr(source, "DEMO_LOG_RESOURCE_DIR");

  if (manifest.length !== expectedSources) {
    throw new Error(
      `manifest has ${manifest.length} entries but DEMO_LOG_EXPECTED_SOURCES is ${expectedSources}`,
    );
  }
  const duplicates = manifest
    .map((entry) => entry.path)
    .filter((value, index, all) => all.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new Error(`manifest has duplicate paths: ${duplicates.join(", ")}`);
  }

  const fixtureRoot = path.resolve(repositoryRoot, FIXTURE_ROOT);
  if (!fs.existsSync(fixtureRoot)) {
    throw new Error(`missing packaged demo fixture: ${FIXTURE_ROOT}`);
  }
  const onDisk = walkFixture(fixtureRoot);
  const listed = manifest.map((entry) => entry.path).sort();
  const missing = listed.filter((p) => !onDisk.includes(p));
  const extra = onDisk.filter((p) => !listed.includes(p));
  if (missing.length > 0) {
    throw new Error(`manifest lists files absent from the fixture: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(
      `fixture contains files absent from the manifest: ${extra.join(", ")}`,
    );
  }

  let totalBytes = 0;
  for (const entry of manifest) {
    const full = path.resolve(fixtureRoot, ...entry.path.split("/"));
    const bytes = fs.statSync(full).size;
    if (bytes !== entry.bytes) {
      throw new Error(
        `${entry.path}: manifest says ${entry.bytes} bytes, fixture is ${bytes}`,
      );
    }
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(full))
      .digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(
        `${entry.path}: manifest digest ${entry.sha256} does not match fixture digest ${digest}`,
      );
    }
    totalBytes += bytes;
  }

  const resources =
    JSON.parse(read(repositoryRoot, TAURI_CONF))?.bundle?.resources ?? null;
  if (!resources || typeof resources !== "object") {
    throw new Error(`${TAURI_CONF}: bundle.resources is missing`);
  }
  // Scan for evaluator leakage before the lane-count check so a truth/metrics
  // mapping reports the specific reason rather than a generic count mismatch.
  for (const [source_, target] of Object.entries(resources)) {
    if (!source_.includes("seven-day-25k")) continue;
    for (const segment of FORBIDDEN_RESOURCE_SEGMENTS) {
      const pattern = new RegExp(`(^|/)${segment}(/|$)`);
      if (pattern.test(source_) || pattern.test(target)) {
        throw new Error(
          `${TAURI_CONF}: '${source_}' would package evaluator ${segment} data`,
        );
      }
    }
  }

  const labLanes = Object.entries(resources).filter(([from]) =>
    from.includes("fixtures/log-lab"),
  );
  if (labLanes.length !== 1) {
    throw new Error(
      `${TAURI_CONF}: expected exactly one fixtures/log-lab resource, found ${labLanes.length}`,
    );
  }
  const [from, to] = labLanes[0];
  if (!from.endsWith(FIXTURE_ROOT)) {
    throw new Error(
      `${TAURI_CONF}: the log-lab resource must package ${FIXTURE_ROOT}, not '${from}'`,
    );
  }
  if (to !== resourceDir) {
    throw new Error(
      `${TAURI_CONF}: log-lab resource targets '${to}' but the host resolves DEMO_LOG_RESOURCE_DIR '${resourceDir}'`,
    );
  }
  return {
    entries: manifest.length,
    totalBytes,
    expectedEvents,
    resourceDir,
  };
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(process.argv[2] ?? path.join(scriptDir, ".."));
  const result = validatePackagedDemoManifest(repositoryRoot);
  process.stdout.write(
    `check_packaged_demo_manifest: OK (${result.entries} sources, ${result.totalBytes} bytes, ` +
      `${result.expectedEvents} expected events, packaged as ${result.resourceDir})\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check_packaged_demo_manifest: FAILED — ${message}\n`);
    process.exitCode = 1;
  }
}
