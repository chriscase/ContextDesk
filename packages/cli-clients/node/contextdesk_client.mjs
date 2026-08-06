#!/usr/bin/env node
/**
 * Minimal Node/TypeScript-friendly thin client for contextdesk.
 * Uses child_process.spawn with argv array — never shell:true.
 * See docs/CLI_CLIENT_PROTOCOL.md.
 */
import { spawn } from "node:child_process";
import process from "node:process";

function resolveBin() {
  return process.env.CONTEXTDESK_BIN || "contextdesk";
}

const completedVerdicts = new Map([[8, "not_ready"], [9, "non_conforming"], [10, "partial"]]);
const MAX_ENVELOPE_BYTES = 1024 * 1024;

/**
 * @param {string[]} args command args after global flags
 * @param {{ dataDir?: string, env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 */
export function runJson(args, opts = {}) {
  const bin = resolveBin();
  const argv = [];
  if (opts.dataDir) argv.push("--data-dir", opts.dataDir);
  argv.push("--json", ...args);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      env: { ...process.env, ...(opts.env || {}) },
      cwd: opts.cwd,
      shell: false, // critical: no shell command construction
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim();
      if (Buffer.byteLength(line, "utf8") > MAX_ENVELOPE_BYTES) {
        reject(new Error(`oversized JSON envelope (exit=${code})`));
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (e) {
        reject(new Error(`invalid JSON (exit=${code}): ${stderr || line}`));
        return;
      }
      if (!envelope || Array.isArray(envelope) || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
        reject(new Error(`envelope requires top-level boolean ok (exit=${code})`));
        return;
      }
      if (envelope.ok === false) {
        const err = envelope.error || {};
        const e = new Error(err.message || "command failed");
        e.kind = err.kind || "internal";
        e.exitCode = code;
        reject(e);
        return;
      }
      if (code !== 0 && !completedVerdicts.has(code)) {
        reject(Object.assign(new Error(`ok envelope but exit ${code}`), { kind: "internal", exitCode: code }));
        return;
      }
      resolve({ envelope, exitCode: code, verdictKind: completedVerdicts.get(code) || null });
    });
  });
}

export function capabilities(opts) {
  return runJson(["capabilities"], opts);
}

const isMain = process.argv[1] && process.argv[1].endsWith("contextdesk_client.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  let dataDir;
  const cmd = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir") {
      dataDir = args[++i];
    } else {
      cmd.push(args[i]);
    }
  }
  if (cmd.length === 0) cmd.push("capabilities");
  runJson(cmd, { dataDir })
    .then((result) => {
      console.log(JSON.stringify(result.envelope, null, 2));
      process.exitCode = result.exitCode;
    })
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: { kind: e.kind || "internal", message: e.message } }));
      process.exit(e.exitCode || 70);
    });
}
