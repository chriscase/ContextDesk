/**
 * Hermetic run directories, timings, screenshots, failure bundles.
 * Run roots live under the worktree (or GUI_ACCEPT_RUN_ROOT), never under goal scratch
 * as persistent app state; scratch is only for captured proof copies.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  createWriteStream,
  createReadStream,
} from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

/**
 * @param {string} baseDir
 * @param {string} [label]
 */
export function createRunDir(baseDir, label = "run") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(baseDir, `${label}-${stamp}`);
  for (const sub of ["screenshots", "logs", "timings", "bundle"]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  writeFileSync(join(root, "meta.json"), JSON.stringify({ startedAt: new Date().toISOString(), label }, null, 2));
  return root;
}

/**
 * @param {string} runDir
 * @param {string} name
 * @param {Record<string, unknown>} data
 */
export function writeJson(runDir, name, data) {
  writeFileSync(join(runDir, name), JSON.stringify(data, null, 2) + "\n");
}

/**
 * @param {string} runDir
 * @param {string} name
 * @param {string} text
 */
export function appendLog(runDir, name, text) {
  appendFileSync(join(runDir, "logs", name), text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * @param {string} runDir
 * @param {string} scenario
 * @param {number} ms
 * @param {'ok'|'fail'|'skip'} status
 * @param {string} [detail]
 */
export function recordTiming(runDir, scenario, ms, status, detail = "") {
  const line = JSON.stringify({
    scenario,
    ms,
    status,
    detail,
    at: new Date().toISOString(),
  });
  appendFileSync(join(runDir, "timings", "scenarios.jsonl"), `${line}\n`);
}

/**
 * Build a failure bundle directory (and optional gzip of key logs).
 * @param {string} runDir
 * @param {{ reason: string, scenario?: string }} info
 */
export function buildFailureBundle(runDir, info) {
  const dest = join(runDir, "bundle", `failure-${Date.now()}`);
  mkdirSync(dest, { recursive: true });
  writeJson(dest, "failure.json", { ...info, builtAt: new Date().toISOString() });
  for (const sub of ["screenshots", "logs", "timings"]) {
    const src = join(runDir, sub);
    if (existsSync(src)) {
      cpSync(src, join(dest, sub), { recursive: true });
    }
  }
  if (existsSync(join(runDir, "meta.json"))) {
    copyFileSync(join(runDir, "meta.json"), join(dest, "meta.json"));
  }
  return dest;
}

/**
 * @param {string} runDir
 * @returns {string[]}
 */
export function listScreenshots(runDir) {
  const dir = join(runDir, "screenshots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
}

/**
 * gzip a single log file into the bundle for transfer.
 * @param {string} filePath
 * @param {string} outPath
 */
export async function gzipFile(filePath, outPath) {
  await pipeline(createReadStream(filePath), createGzip(), createWriteStream(outPath));
  return outPath;
}

export function defaultRunRoot(repoRoot) {
  return (
    process.env.GUI_ACCEPT_RUN_ROOT ||
    join(repoRoot, "desktop", "gui-accept", ".runs")
  );
}
