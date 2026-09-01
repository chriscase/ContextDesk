#!/usr/bin/env node
/**
 * Opt-in Garage v2.3.0 live qualification for ContextDesk S3 evidence.
 *
 * Fail closed unless CONTEXTDESK_RUN_S3_LIVE=1. Never consume AWS default
 * credentials, shared config, or instance metadata. Static harness credentials
 * only — either operator-supplied COLLAB_EVIDENCE_S3_* values or ephemeral
 * Garage bootstrap keys that are never printed.
 *
 * Usage:
 *   CONTEXTDESK_RUN_S3_LIVE=1 node collab/scripts/qualify-s3-evidence.mjs
 *   node collab/scripts/qualify-s3-evidence.mjs --self-check
 *   CONTEXTDESK_RUN_S3_LIVE=1 node collab/scripts/qualify-s3-evidence.mjs --skip-compose
 *   CONTEXTDESK_RUN_S3_LIVE=1 node collab/scripts/qualify-s3-evidence.mjs --keep
 *
 * --self-check validates compose/toml/gates without Docker and is not a live result.
 * --skip-compose uses an already-running loopback/private endpoint (static creds required).
 * --keep leaves the evaluation Compose project running after tests.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_OPT_IN_ENV = "CONTEXTDESK_RUN_S3_LIVE";
export const LIVE_OPT_IN_VALUE = "1";
export const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
export const DEFAULT_ENDPOINT = "http://127.0.0.1:3900";
export const DEFAULT_REGION = "garage";
export const COMPOSE_PROJECT = "cd-garage-evidence-eval";
export const RPC_SECRET_PLACEHOLDER = "replace-with-64-hex-characters";

export const AWS_DEFAULT_CHAIN_ENV_NAMES = Object.freeze([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ACCESS_KEY",
  "AWS_SECRET_KEY",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_METADATA_SERVICE_TIMEOUT",
  "AWS_METADATA_SERVICE_NUM_ATTEMPTS",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_CA_BUNDLE",
]);

const S3_SESSION_TOKEN_SOURCE_NAMES = Object.freeze([
  "COLLAB_EVIDENCE_S3_SESSION_TOKEN",
  "COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE",
  "COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const COLLAB_ROOT = resolve(scriptDir, "..");
export const DEPLOY_DIR = join(COLLAB_ROOT, "deploy");
export const COMPOSE_FILE = join(DEPLOY_DIR, "garage-evidence-evaluation.compose.yml");
export const GARAGE_TOML_TEMPLATE = join(
  DEPLOY_DIR,
  "garage-evidence-evaluation",
  "garage.toml",
);
const SERVER_DIR = join(COLLAB_ROOT, "server");
const LIVE_TESTS = Object.freeze([
  "src/evidence/s3-garage.integration.test.ts",
  "src/evidence/s3-http-garage.integration.test.ts",
]);

export function isLiveOptIn(env = process.env) {
  return env[LIVE_OPT_IN_ENV] === LIVE_OPT_IN_VALUE;
}

function hasC0Controls(value) {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function ipv4Parts(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return null;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => part < 0 || part > 255)) return null;
  return parts;
}

function stripIpv6Brackets(host) {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function isUniqueLocalIpv6(host) {
  const firstHextet = host.split(":", 1)[0];
  if (!/^[0-9a-f]{1,4}$/u.test(firstHextet)) return false;
  const value = Number.parseInt(firstHextet, 16);
  return value >= 0xfc00 && value <= 0xfdff;
}

/**
 * Classify an S3 endpoint URL. Live qualification allows loopback and RFC1918 /
 * unique-local addresses only. AWS-managed hostnames are always forbidden.
 */
export function classifyEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    return { class: "forbidden", reason: "endpoint missing" };
  }
  const value = endpoint.trim();
  if (hasC0Controls(value) || /\s/u.test(value) || value.includes("@")) {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  const host = stripIpv6Brackets(url.hostname).toLowerCase();
  if (
    host === "s3.amazonaws.com" ||
    host.endsWith(".amazonaws.com") ||
    host.endsWith(".amazonaws.com.cn")
  ) {
    return { class: "forbidden", reason: "aws-managed endpoint refused" };
  }
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return { class: "loopback", reason: "ok" };
  }
  const ipv4 = ipv4Parts(host);
  if (ipv4) {
    if (ipv4[0] === 127) return { class: "loopback", reason: "ok" };
    if (ipv4[0] === 10) return { class: "private", reason: "ok" };
    if (ipv4[0] === 192 && ipv4[1] === 168) return { class: "private", reason: "ok" };
    if (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) {
      return { class: "private", reason: "ok" };
    }
    return { class: "forbidden", reason: "endpoint is not loopback or private" };
  }
  if (host.includes(":")) {
    if (host === "::1") return { class: "loopback", reason: "ok" };
    if (isUniqueLocalIpv6(host)) {
      return { class: "private", reason: "ok" };
    }
    return { class: "forbidden", reason: "endpoint is not loopback or private" };
  }
  return { class: "forbidden", reason: "endpoint is not loopback or private" };
}

export function isLoopbackOrPrivateEndpoint(endpoint) {
  const classified = classifyEndpoint(endpoint);
  return classified.class === "loopback" || classified.class === "private";
}

function present(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "";
}

function collabStaticCredsPresent(env) {
  const access =
    present(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID") ||
    present(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE") ||
    present(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF");
  const secret =
    present(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY") ||
    present(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE") ||
    present(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF");
  return access && secret;
}

/**
 * Fail-closed live-safety decision. Never returns credential values.
 */
export function evaluateLiveSafety(env = process.env) {
  if (!isLiveOptIn(env)) {
    return { ok: false, reason: "opt-in required (CONTEXTDESK_RUN_S3_LIVE=1)" };
  }
  const mode = (env.COLLAB_EVIDENCE_S3_CREDENTIALS_MODE ?? "").trim();
  if (mode === "default_chain") {
    return { ok: false, reason: "default_chain credentials are refused" };
  }
  if (mode !== "static") {
    return { ok: false, reason: "credentials mode must be static" };
  }
  if (!collabStaticCredsPresent(env)) {
    if (
      present(env, "AWS_ACCESS_KEY_ID") ||
      present(env, "AWS_SECRET_ACCESS_KEY") ||
      present(env, "AWS_PROFILE")
    ) {
      return { ok: false, reason: "AWS default-chain credentials are refused" };
    }
    return { ok: false, reason: "static COLLAB_EVIDENCE_S3 credentials required" };
  }
  const endpoint = (env.COLLAB_EVIDENCE_S3_ENDPOINT ?? "").trim();
  const classified = classifyEndpoint(endpoint);
  if (classified.class === "forbidden") {
    return { ok: false, reason: classified.reason };
  }
  if (endpoint.toLowerCase().startsWith("http://") && env.COLLAB_EVIDENCE_S3_ALLOW_HTTP !== "1") {
    return { ok: false, reason: "HTTP endpoint requires COLLAB_EVIDENCE_S3_ALLOW_HTTP=1" };
  }
  if (!present(env, "COLLAB_EVIDENCE_S3_BUCKET")) {
    return { ok: false, reason: "bucket required" };
  }
  if (!present(env, "COLLAB_EVIDENCE_S3_REGION")) {
    return { ok: false, reason: "region required" };
  }
  return { ok: true, reason: "ok", endpointClass: classified.class };
}

export function isolateAwsDefaultChainEnv(source = process.env) {
  const env = { ...source };
  for (const name of AWS_DEFAULT_CHAIN_ENV_NAMES) {
    delete env[name];
  }
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_SDK_LOAD_CONFIG = "0";
  return env;
}

export function sanitizeText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  out = out.replace(/Credential=[^,\s]+/g, "Credential=[redacted]");
  out = out.replace(/Signature=[A-Za-z0-9/+=]+/g, "Signature=[redacted]");
  out = out.replace(/X-Amz-Security-Token:\s*\S+/gi, "X-Amz-Security-Token: [redacted]");
  out = out.replace(/GARAGE_DEFAULT_(ACCESS|SECRET)_KEY=\S+/g, "GARAGE_DEFAULT_$1_KEY=[redacted]");
  out = out.replace(/rpc_secret\s*=\s*"[0-9a-f]{64}"/g, 'rpc_secret = "[redacted]"');
  return out;
}

export function assertEvaluationFixtures() {
  const compose = readFileSync(COMPOSE_FILE, "utf8");
  const toml = readFileSync(GARAGE_TOML_TEMPLATE, "utf8");
  const problems = [];
  if (!/image:\s*dxflrs\/garage:v2\.3\.0\b/.test(compose)) {
    problems.push("compose must pin dxflrs/garage:v2.3.0");
  }
  if (/dxflrs\/garage:latest/.test(compose) || /image:.*:latest/.test(compose)) {
    problems.push("compose must not use latest");
  }
  if (!/127\.0\.0\.1:3900:3900/.test(compose)) {
    problems.push("compose must publish S3 on 127.0.0.1:3900");
  }
  if (/0\.0\.0\.0:3900/.test(compose) || /["']3900:3900["']/.test(compose)) {
    problems.push("compose must not publish S3 on all interfaces");
  }
  if (/3901:3901/.test(compose) || /3902:3902/.test(compose) || /3903:3903/.test(compose)) {
    problems.push("compose must not publish RPC, website, or admin ports");
  }
  if (!/garage-evidence-eval-meta/.test(compose) || !/garage-evidence-eval-data/.test(compose)) {
    problems.push("compose must declare persistent named volumes");
  }
  if (!/cd-garage-evidence-eval/.test(compose)) {
    problems.push("compose must use an isolated evaluation network/project");
  }
  if (!/healthcheck:/.test(compose)) {
    problems.push("compose must declare a readiness/health check");
  }
  if (
    /GARAGE_DEFAULT_ACCESS_KEY:\s*GK[A-Za-z0-9]+/.test(compose) ||
    /AWS_SECRET_ACCESS_KEY:/.test(compose) ||
    /AKIA[A-Z0-9]{16}/.test(compose)
  ) {
    problems.push("compose must not contain credentials");
  }
  if (!toml.includes(RPC_SECRET_PLACEHOLDER)) {
    problems.push("garage.toml must keep the rpc_secret placeholder");
  }
  if (/rpc_secret\s*=\s*"[0-9a-f]{64}"/.test(toml)) {
    problems.push("garage.toml must not commit a real rpc_secret");
  }
  if (/\[admin\]/.test(toml) || /\[s3_web\]/.test(toml)) {
    problems.push("garage.toml must omit admin and website listeners");
  }
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  return { compose, toml };
}

function hex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function generateEvaluationSecrets() {
  return {
    rpcSecret: hex(32),
    accessKeyId: `GK${hex(16)}`,
    secretAccessKey: hex(32),
    bucket: `cd-eval-${hex(4)}`,
    prefix: `eval${hex(6)}`,
    isolationPrefix: `iso${hex(6)}`,
  };
}

function materializeGarageConfig(template, rpcSecret) {
  if (!template.includes(RPC_SECRET_PLACEHOLDER)) {
    throw new Error("garage.toml template missing rpc_secret placeholder");
  }
  if (/rpc_secret\s*=\s*"[0-9a-f]{64}"/.test(template)) {
    throw new Error("garage.toml template must not contain a real rpc_secret");
  }
  const body = template.replaceAll(RPC_SECRET_PLACEHOLDER, rpcSecret);
  if (body.includes(RPC_SECRET_PLACEHOLDER)) {
    throw new Error("failed to materialize rpc_secret");
  }
  const dir = mkdtempSync(join(tmpdir(), "cd-garage-eval-"));
  chmodSync(dir, 0o700);
  const dest = join(dir, "garage.toml");
  writeFileSync(dest, body, { mode: 0o600 });
  return { dir, dest };
}

function parseArgs(argv) {
  const flags = new Set(argv);
  const known = new Set(["--help", "-h", "--self-check", "--skip-compose", "--keep"]);
  for (const flag of flags) {
    if (!known.has(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return {
    help: flags.has("--help") || flags.has("-h"),
    selfCheck: flags.has("--self-check"),
    skipCompose: flags.has("--skip-compose"),
    keep: flags.has("--keep"),
  };
}

function printHelp() {
  process.stdout.write(`ContextDesk S3 evidence live qualification (Garage v2.3.0)

Fail closed unless CONTEXTDESK_RUN_S3_LIVE=1. Endpoint must be loopback or
private. Static COLLAB_EVIDENCE_S3_* credentials only — AWS defaults, shared
config, and instance metadata are never used. This is not a retention,
migration, or permanent-delete claim.

  CONTEXTDESK_RUN_S3_LIVE=1 node collab/scripts/qualify-s3-evidence.mjs
  node collab/scripts/qualify-s3-evidence.mjs --self-check
  CONTEXTDESK_RUN_S3_LIVE=1 node collab/scripts/qualify-s3-evidence.mjs --skip-compose
  CONTEXTDESK_RUN_S3_LIVE=1 node collab/scripts/qualify-s3-evidence.mjs --keep

--self-check   validate compose/toml/gates without Docker (not a live result)
--skip-compose use an already-running loopback/private S3 endpoint; require static creds
--keep         leave the evaluation Compose project running
`);
}

function runCommand(command, args, options) {
  const {
    cwd,
    env,
    secrets = [],
    allowFailure = false,
    timeoutMs = 120_000,
  } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let hardKillTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const combined = sanitizeText(`${stdout}\n${stderr}`, secrets);
      if (code === 0) {
        resolvePromise({ code, stdout, stderr, combined });
        return;
      }
      if (allowFailure) {
        resolvePromise({ code, stdout, stderr, combined, signal });
        return;
      }
      const error = new Error(
        sanitizeText(
          `${command} exited ${code ?? signal ?? "unknown"}`,
          secrets,
        ),
      );
      error.combined = combined;
      reject(error);
    });
  });
}

async function compose(args, env, secrets, options = {}) {
  return runCommand(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "--project-directory", DEPLOY_DIR, "-p", COMPOSE_PROJECT, ...args],
    {
      cwd: DEPLOY_DIR,
      env,
      secrets,
      allowFailure: options.allowFailure === true,
      timeoutMs: options.timeoutMs ?? 180_000,
    },
  );
}

function operatorStaticCreds(env) {
  if (!collabStaticCredsPresent(env)) return null;
  const accessKeyId = env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY;
  if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string") {
    return "file-ref";
  }
  if (!accessKeyId.trim() || !secretAccessKey.trim()) return null;
  return { accessKeyId, secretAccessKey };
}

function buildLiveEnv(base, secrets, generated) {
  const env = isolateAwsDefaultChainEnv(base);
  env[LIVE_OPT_IN_ENV] = LIVE_OPT_IN_VALUE;
  env.COLLAB_EVIDENCE_PROVIDER = "s3";
  env.COLLAB_EVIDENCE_S3_ENDPOINT = env.COLLAB_EVIDENCE_S3_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  env.COLLAB_EVIDENCE_S3_REGION = env.COLLAB_EVIDENCE_S3_REGION?.trim() || DEFAULT_REGION;
  env.COLLAB_EVIDENCE_S3_BUCKET = generated.bucket;
  env.COLLAB_EVIDENCE_S3_PREFIX = generated.prefix;
  env.COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE = "1";
  env.COLLAB_EVIDENCE_S3_ALLOW_HTTP = env.COLLAB_EVIDENCE_S3_ENDPOINT.startsWith("https:")
    ? (env.COLLAB_EVIDENCE_S3_ALLOW_HTTP ?? "0")
    : "1";
  env.COLLAB_EVIDENCE_S3_CREDENTIALS_MODE = "static";
  env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID = generated.accessKeyId;
  env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY = generated.secretAccessKey;
  delete env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE;
  delete env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF;
  delete env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE;
  delete env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF;
  delete env.COLLAB_EVIDENCE_S3_SESSION_TOKEN;
  delete env.COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE;
  delete env.COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF;
  env.GARAGE_DEFAULT_ACCESS_KEY = generated.accessKeyId;
  env.GARAGE_DEFAULT_SECRET_KEY = generated.secretAccessKey;
  env.GARAGE_DEFAULT_BUCKET = generated.bucket;
  env.GARAGE_RPC_SECRET = generated.rpcSecret;
  env.CONTEXTDESK_S3_LIVE_ISOLATION_PREFIX = generated.isolationPrefix;
  env.CONTEXTDESK_S3_LIVE_COMPOSE_FILE = COMPOSE_FILE;
  env.CONTEXTDESK_S3_LIVE_COMPOSE_PROJECT = COMPOSE_PROJECT;
  env.CONTEXTDESK_S3_LIVE_COMPOSE_WORKDIR = DEPLOY_DIR;
  secrets.push(
    generated.accessKeyId,
    generated.secretAccessKey,
    generated.rpcSecret,
  );
  return env;
}

/**
 * Preserve an operator's explicitly selected temporary-credential source only
 * for --skip-compose. Harness-managed Garage always uses a generated long-lived
 * evaluation key pair and must not inherit these caller values.
 */
export function restoreSkipComposeSessionTokenSources(target, source) {
  for (const name of S3_SESSION_TOKEN_SOURCE_NAMES) {
    if (Object.hasOwn(source, name) && source[name] !== undefined) {
      target[name] = source[name];
    } else {
      delete target[name];
    }
  }
  return target;
}

function vitestBin() {
  const candidates = [
    join(SERVER_DIR, "node_modules", ".bin", "vitest"),
    join(COLLAB_ROOT, "node_modules", ".bin", "vitest"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("vitest is not installed; run npm ci in collab/");
}

async function runVitest(env, secrets, live) {
  const bin = vitestBin();
  const result = await runCommand(
    bin,
    ["run", ...LIVE_TESTS, "--reporter=dot", "--fileParallelism=false"],
    {
      cwd: SERVER_DIR,
      env: {
        ...env,
        [LIVE_OPT_IN_ENV]: live ? LIVE_OPT_IN_VALUE : "",
      },
      secrets,
      timeoutMs: 600_000,
    },
  );
  process.stdout.write(sanitizeText(result.stdout, secrets));
  if (result.stderr.trim()) {
    process.stderr.write(sanitizeText(result.stderr, secrets));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  assertEvaluationFixtures();

  if (args.selfCheck) {
    if (isLiveOptIn()) {
      throw new Error("--self-check refuses CONTEXTDESK_RUN_S3_LIVE=1 (not a live result)");
    }
    const gate = evaluateLiveSafety({ ...process.env, [LIVE_OPT_IN_ENV]: "0" });
    if (gate.ok) throw new Error("self-check expected opt-in refusal");
    await runVitest(isolateAwsDefaultChainEnv(process.env), [], false);
    process.stdout.write(
      "self-check passed: compose/toml/gates only (not a live Garage qualification)\n",
    );
    return;
  }

  if (!isLiveOptIn()) {
    throw new Error("refusing to run: set CONTEXTDESK_RUN_S3_LIVE=1 (fail closed)");
  }
  if (args.skipCompose && args.keep) {
    throw new Error("--keep requires harness-managed compose");
  }
  if (args.skipCompose) {
    if (!collabStaticCredsPresent(process.env)) {
      throw new Error("refusing to run: --skip-compose requires static COLLAB_EVIDENCE_S3 credentials");
    }
    if (!present(process.env, "COLLAB_EVIDENCE_S3_BUCKET")) {
      throw new Error("refusing to run: --skip-compose requires COLLAB_EVIDENCE_S3_BUCKET");
    }
  }

  const secrets = [];
  const generated = generateEvaluationSecrets();
  const operatorCreds = operatorStaticCreds(process.env);
  if (operatorCreds && operatorCreds !== "file-ref") {
    generated.accessKeyId = operatorCreds.accessKeyId;
    generated.secretAccessKey = operatorCreds.secretAccessKey;
  }
  if (args.skipCompose && present(process.env, "COLLAB_EVIDENCE_S3_BUCKET")) {
    generated.bucket = process.env.COLLAB_EVIDENCE_S3_BUCKET.trim();
  }

  let liveEnv = buildLiveEnv(process.env, secrets, generated);
  // Owner-only file references are useful for an already-running endpoint, but
  // Compose cannot consume them as Garage bootstrap environment values. A
  // harness-managed Garage therefore keeps its generated ephemeral key pair.
  if (args.skipCompose && operatorCreds === "file-ref") {
    liveEnv.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID = process.env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID;
    liveEnv.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE = process.env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE;
    liveEnv.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF = process.env.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF;
    liveEnv.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY = process.env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY;
    liveEnv.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE =
      process.env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE;
    liveEnv.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF =
      process.env.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF;
    if (!present(liveEnv, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID")) {
      delete liveEnv.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID;
    }
    if (!present(liveEnv, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY")) {
      delete liveEnv.COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY;
    }
  }
  if (args.skipCompose) {
    restoreSkipComposeSessionTokenSources(liveEnv, process.env);
    const sessionToken = liveEnv.COLLAB_EVIDENCE_S3_SESSION_TOKEN;
    if (typeof sessionToken === "string" && sessionToken.length >= 4) {
      secrets.push(sessionToken);
    }
  }

  const safety = evaluateLiveSafety(liveEnv);
  if (!safety.ok) {
    throw new Error(`refusing to run: ${safety.reason}`);
  }

  let configDir = null;
  let startedCompose = false;
  const teardown = async () => {
    if (startedCompose && !args.keep) {
      const down = await compose(["down", "--volumes", "--remove-orphans"], liveEnv, secrets, {
        allowFailure: true,
        timeoutMs: 120_000,
      });
      if (down.code !== 0) {
        throw new Error("docker compose evaluation teardown failed");
      }
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
      configDir = null;
    }
  };

  const onSignal = () => {
    teardown()
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (!args.skipCompose) {
      const template = readFileSync(GARAGE_TOML_TEMPLATE, "utf8");
      const materialized = materializeGarageConfig(template, generated.rpcSecret);
      configDir = materialized.dir;
      liveEnv.GARAGE_CONFIG_FILE = materialized.dest;
      process.stdout.write(
        `starting ${GARAGE_IMAGE} on loopback S3 127.0.0.1:3900 (evaluation only)\n`,
      );
      await compose(["down", "--volumes", "--remove-orphans"], liveEnv, secrets, {
        allowFailure: true,
        timeoutMs: 60_000,
      });
      const up = await compose(
        ["up", "-d", "--wait", "--wait-timeout", "90"],
        liveEnv,
        secrets,
        { allowFailure: true, timeoutMs: 180_000 },
      );
      startedCompose = true;
      if (up.code !== 0) {
        const fallback = await compose(["up", "-d"], liveEnv, secrets, {
          timeoutMs: 180_000,
        });
        if (fallback.code !== 0) {
          throw new Error("docker compose up failed");
        }
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const status = await compose(
            ["exec", "-T", "garage", "/garage", "status"],
            liveEnv,
            secrets,
            { allowFailure: true, timeoutMs: 15_000 },
          );
          if (status.code === 0) {
            ready = true;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
        }
        if (!ready) throw new Error("Garage did not become ready");
      }
    } else {
      delete liveEnv.CONTEXTDESK_S3_LIVE_COMPOSE_FILE;
      delete liveEnv.CONTEXTDESK_S3_LIVE_COMPOSE_PROJECT;
      delete liveEnv.CONTEXTDESK_S3_LIVE_COMPOSE_WORKDIR;
      process.stdout.write("skipping compose; using operator-supplied loopback/private endpoint\n");
    }

    await runVitest(liveEnv, secrets, true);
    process.stdout.write(
      "live Garage qualification passed (evaluation only; no retention/migration/delete claims)\n",
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await teardown();
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = sanitizeText(error instanceof Error ? error.message : String(error));
    process.stderr.write(`qualify-s3-evidence: ${message}\n`);
    if (error && typeof error === "object" && "combined" in error && error.combined) {
      process.stderr.write(sanitizeText(String(error.combined)));
      if (!String(error.combined).endsWith("\n")) process.stderr.write("\n");
    }
    process.exit(1);
  });
}
