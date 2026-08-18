#!/usr/bin/env node
/**
 * Standalone fixture/runbook preflight for `fixtures/triage-comparison-demo`.
 *
 * Scope (exact):
 * - Reads the Grok comparison-demo package and its copy-paste runbook.
 * - Checks fixture identity, schema allowlist, path safety, privacy
 *   monotonicity, secret-shaped candidate content, and runbook honesty.
 * - Does not call a provider, read credentials, write model-qualifications,
 *   import a bench library, or execute `bench-compare`.
 * - Does not edit the Grok package, cd-core, cd-workflow, desktop, CI, or docs.
 *
 * This is fixture/runbook validation only. Unknown usage, cost, timing, and
 * quality stay unknown; a passing preflight is not a live comparison.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFLIGHT_SCHEMA_ID = "contextdesk.demo_fixture_preflight.v1";

export const REQUIRED_FILES = Object.freeze([
  "README.md",
  "blobs/checkout.log",
  "candidates/candidate-a.json",
  "candidates/candidate-b.json",
  "case.json",
  "identities.json",
  "recorded/human-run.json",
  "recorded/other-product-run.json",
  "replay/replay-completed.json",
  "replay/replay-failed.json",
  "snapshot.json",
  "task.json",
]);

export const ALLOWED_SCHEMA_IDS = Object.freeze([
  "contextdesk.triage_bench.case.v1",
  "contextdesk.triage_bench.evidence_snapshot.v1",
  "contextdesk.triage_bench.evaluation_task.v1",
  "contextdesk.triage_bench.run_import.v1",
  "contextdesk.triage.replay.v1",
  "contextdesk.triage.run_event.v2",
  "contextdesk.triage.result.v2",
  "contextdesk.investigation_answer.v1",
]);

const FORBIDDEN_SEGMENTS = Object.freeze(["truth", "metrics"]);

const TOP_LEVEL_KEYS = Object.freeze({
  "case.json": [
    "schema_id",
    "case_id",
    "privacy",
    "title",
    "reported_problem",
    "lifecycle",
    "timeline_notes",
    "created_at",
  ],
  "snapshot.json": [
    "schema_id",
    "snapshot_id",
    "privacy",
    "case_id",
    "captured_at",
    "captured_by",
    "items",
    "notes",
  ],
  "task.json": [
    "schema_id",
    "task_id",
    "privacy",
    "case_id",
    "snapshot_id",
    "question",
    "protocol",
    "protocol_version",
    "visibility",
    "created_at",
  ],
  "identities.json": [
    "case_id",
    "snapshot_id",
    "task_id",
    "evidence_item_id",
    "blob",
    "notes",
  ],
  recorded: [
    "schema_id",
    "task_id",
    "strategy",
    "source_kind",
    "prompt_workflow",
    "raw_output_utf8",
    "timing",
    "cost",
    "uncertainty",
    "fairness",
    "status",
    "operator",
    "privacy",
    "created_at",
  ],
  candidate: ["policy", "cancellation_id", "strategy", "overrides"],
  replay: ["schema_id", "run_id", "request_fingerprint", "events"],
});

const CANDIDATE_SECRET_KEYS = Object.freeze([
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "endpoint",
  "base_url",
  "password",
  "secret",
]);

const URL_RE = /https?:\/\//i;
const HOME_PATH_RE =
  /(?:^|[\s"'=])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/;
const RAW_EXCHANGE_RE =
  /provider_exchange|--raw-i-understand|private\/capture\.json/i;
const INVENTED_OFFLINE = Object.freeze([
  "bench-compare --offline",
  "contextdesk bench-compare --offline",
  "cd-cli bench-compare --offline",
]);
const HISTORICAL_VERCEL = Object.freeze([
  "ai-gateway.vercel.sh",
  "vercel_gateway_diagnostic",
  "vercel_deepseek",
  "deepseek/deepseek-v4-flash",
  "openai/gpt-oss-120b",
  "release_live_evidence",
  "gwdx-",
]);

function posixJoin(...parts) {
  return parts.join("/");
}

function posixRelative(fromDir, toPath) {
  const rel = path.relative(fromDir, toPath);
  return rel.split(path.sep).join("/");
}

export function parseArgs(argv) {
  const args = { package: null, runbook: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--package") {
      args.package = argv[i + 1];
      i += 1;
    } else if (token.startsWith("--package=")) {
      args.package = token.slice("--package=".length);
    } else if (token === "--runbook") {
      args.runbook = argv[i + 1];
      i += 1;
    } else if (token.startsWith("--runbook=")) {
      args.runbook = token.slice("--runbook=".length);
    } else if (token === "-h" || token === "--help") {
      args.help = true;
    } else {
      throw usageError(`unknown argument: ${token}`);
    }
  }
  if (!args.help && (args.package == null || args.package === "")) {
    throw usageError("--package <dir> is required");
  }
  if (!args.help && args.runbook === "") {
    throw usageError("--runbook requires a path");
  }
  return args;
}

function usageError(message) {
  const error = new Error(message);
  error.code = "usage";
  return error;
}

export function usageText() {
  return `Usage: node scripts/demo-fixture-preflight.mjs --package <dir> [--runbook <file>]

Validate the synthetic triage comparison demo fixture and runbook.
Does not contact a provider, read credentials, or run bench-compare.
`;
}

function hasDotDot(userPath) {
  return String(userPath)
    .split(/[\\/]/)
    .some((segment) => segment === "..");
}

function resolveUserPath(userPath, label) {
  if (userPath == null || userPath === "") {
    throw usageError(`${label} is required`);
  }
  if (hasDotDot(userPath)) {
    const error = new Error(`${label} must not contain '..' path segments`);
    error.code = "path_traversal";
    throw error;
  }
  return path.resolve(process.cwd(), userPath);
}

function defaultRunbookPath(packageRoot) {
  return path.resolve(
    packageRoot,
    "..",
    "..",
    "docs",
    "benchmarks",
    "TRIAGE_COMPARISON_DEMO.md",
  );
}

function addError(errors, code, filePath, message) {
  errors.push({ code, path: filePath, message });
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function loadJson(filePath, relative, errors) {
  try {
    return JSON.parse(readUtf8(filePath));
  } catch (error) {
    addError(
      errors,
      "shape",
      relative,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function walkPackageFiles(packageRoot, errors) {
  const found = [];
  const stack = [{ dir: packageRoot, prefix: "" }];
  while (stack.length > 0) {
    const { dir, prefix } = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relative = prefix ? posixJoin(prefix, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        addError(errors, "symlink", relative, "symlinks are rejected");
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ dir: full, prefix: relative });
        continue;
      }
      if (!entry.isFile()) {
        addError(errors, "shape", relative, "only regular files are allowed");
        continue;
      }
      found.push(relative);
    }
  }
  return found.sort();
}

function forbiddenSegmentIn(relative) {
  return relative
    .split("/")
    .some((segment) => FORBIDDEN_SEGMENTS.includes(segment.toLowerCase()));
}

function looksLikeForbiddenPath(value) {
  if (typeof value !== "string") return false;
  return /(^|\/)(truth|metrics)(\/|$)/i.test(value.replaceAll("\\", "/"));
}

function walkForbiddenPaths(value, relative, errors) {
  if (typeof value === "string") {
    if (looksLikeForbiddenPath(value)) {
      addError(
        errors,
        "forbidden_segment",
        relative,
        `referenced path contains a forbidden truth/metrics segment: ${value}`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForbiddenPaths(item, relative, errors);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      walkForbiddenPaths(nested, relative, errors);
    }
  }
}

function assertInsidePackage(packageRoot, relative, fileLabel, errors) {
  if (typeof relative !== "string" || relative === "") {
    addError(errors, "path_traversal", fileLabel, "referenced path is empty");
    return false;
  }
  if (path.isAbsolute(relative) || relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative)) {
    addError(
      errors,
      "path_traversal",
      fileLabel,
      `referenced path must be package-relative: ${relative}`,
    );
    return false;
  }
  if (hasDotDot(relative) || relative.includes("\0")) {
    addError(
      errors,
      "path_traversal",
      fileLabel,
      `referenced path must not traverse: ${relative}`,
    );
    return false;
  }
  if (forbiddenSegmentIn(relative)) {
    addError(
      errors,
      "forbidden_segment",
      fileLabel,
      `referenced path contains a forbidden truth/metrics segment: ${relative}`,
    );
    return false;
  }
  const resolved = path.resolve(packageRoot, ...relative.split("/"));
  const rel = posixRelative(packageRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    addError(
      errors,
      "path_traversal",
      fileLabel,
      `referenced path escapes the package: ${relative}`,
    );
    return false;
  }
  return true;
}

function collectSchemaIds(value, acc = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaIds(item, acc);
    return acc;
  }
  if (value && typeof value === "object") {
    if (typeof value.schema_id === "string") acc.push(value.schema_id);
    for (const nested of Object.values(value)) collectSchemaIds(nested, acc);
  }
  return acc;
}

function objectKeys(value) {
  return Object.keys(value).sort();
}

function expectKeys(relative, value, allowed, errors) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    addError(errors, "shape", relative, "expected a JSON object");
    return;
  }
  const allowedSet = new Set(allowed);
  const extra = objectKeys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extra.length > 0) {
    addError(
      errors,
      "shape",
      relative,
      `unknown JSON fields: ${extra.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    addError(
      errors,
      "shape",
      relative,
      `missing required JSON fields: ${missing.join(", ")}`,
    );
  }
}

function isUnknownObservation(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    value.status === "unknown"
  );
}

function walkClaims(value, relative, errors) {
  if (Array.isArray(value)) {
    for (const item of value) walkClaims(item, relative, errors);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower === "timing" || lower === "cost" || lower === "uncertainty") {
      if (!isUnknownObservation(nested)) {
        addError(
          errors,
          "secret",
          relative,
          `${key} must remain {"status":"unknown"}; known/cost/timing claims are rejected`,
        );
      }
    }
    if (
      lower === "token_usage" ||
      lower === "cost_usd" ||
      lower === "usage_usd" ||
      key === "usd"
    ) {
      addError(
        errors,
        "secret",
        relative,
        `forbidden cost/usage field ${key}`,
      );
    }
    if (
      nested &&
      typeof nested === "object" &&
      !Array.isArray(nested) &&
      nested.status === "known"
    ) {
      addError(
        errors,
        "secret",
        relative,
        `{"status":"known"} is rejected in ${key}`,
      );
    }
    walkClaims(nested, relative, errors);
  }
}

function walkPrivacy(node, relative, shareSafeAncestor, errors) {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkPrivacy(item, relative, shareSafeAncestor, errors);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  const label = node.privacy;
  if (label != null && label !== "owner_only" && label !== "share_safe") {
    addError(
      errors,
      "privacy",
      relative,
      `unrecognized privacy label: ${label}`,
    );
  }
  if (label === "owner_only" && shareSafeAncestor) {
    addError(
      errors,
      "privacy",
      relative,
      "owner-only record cannot be labeled or nested under share-safe",
    );
  }
  const nextAncestor = shareSafeAncestor || label === "share_safe";
  for (const nested of Object.values(node)) {
    walkPrivacy(nested, relative, nextAncestor, errors);
  }
}

function scanTextSecrets(relative, text, errors, { jsonLike }) {
  if (RAW_EXCHANGE_RE.test(text)) {
    addError(
      errors,
      "secret",
      relative,
      "raw exchange / private capture markers are rejected",
    );
  }
  if (!jsonLike) return;
  if (URL_RE.test(text)) {
    addError(errors, "secret", relative, "network URLs are rejected");
  }
  if (HOME_PATH_RE.test(text)) {
    addError(errors, "secret", relative, "absolute home paths are rejected");
  }
}

function scanObjectSecrets(relative, value, errors) {
  if (Array.isArray(value)) {
    for (const item of value) scanObjectSecrets(relative, item, errors);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (CANDIDATE_SECRET_KEYS.includes(key.toLowerCase())) {
      addError(
        errors,
        "secret",
        relative,
        `secret-shaped field ${key} is rejected`,
      );
    }
    scanObjectSecrets(relative, nested, errors);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validateBlob(packageRoot, snapshot, identities, errors) {
  const blobMeta = identities?.blob;
  if (!blobMeta || typeof blobMeta !== "object") {
    addError(errors, "shape", "identities.json", "missing blob identity");
    return;
  }
  const relative = blobMeta.path;
  if (!assertInsidePackage(packageRoot, relative, "identities.json", errors)) {
    return;
  }
  const full = path.resolve(packageRoot, ...relative.split("/"));
  if (!fs.existsSync(full)) {
    addError(errors, "missing_file", relative, "referenced blob is missing");
    return;
  }
  const bytes = fs.readFileSync(full);
  const digest = sha256(bytes);
  if (bytes.length !== blobMeta.byte_length) {
    addError(
      errors,
      "blob_mismatch",
      relative,
      `identities.json byte_length ${blobMeta.byte_length} does not match file ${bytes.length}`,
    );
  }
  if (digest !== blobMeta.hex) {
    addError(
      errors,
      "blob_mismatch",
      relative,
      `identities.json digest ${blobMeta.hex} does not match file ${digest}`,
    );
  }
  const items = snapshot?.items;
  if (!Array.isArray(items) || items.length !== 1) {
    addError(
      errors,
      "shape",
      "snapshot.json",
      "this package must declare exactly one evidence item",
    );
    return;
  }
  const item = items[0];
  const content = item?.content;
  const itemHex = content?.digest?.hex;
  const itemBytes = content?.byte_length;
  if (itemBytes !== bytes.length) {
    addError(
      errors,
      "blob_mismatch",
      "snapshot.json",
      `snapshot byte_length ${itemBytes} does not match file ${bytes.length}`,
    );
  }
  if (itemHex !== digest) {
    addError(
      errors,
      "blob_mismatch",
      "snapshot.json",
      `snapshot digest ${itemHex} does not match file ${digest}`,
    );
  }
  if (itemHex !== blobMeta.hex) {
    addError(
      errors,
      "blob_mismatch",
      "identities.json",
      "snapshot digest does not match identities.json",
    );
  }
  if (identities.evidence_item_id !== item.item_id) {
    addError(
      errors,
      "shape",
      "identities.json",
      "evidence_item_id does not match snapshot item_id",
    );
  }
}

function validateSchemaIds(relative, value, errors) {
  for (const schemaId of collectSchemaIds(value)) {
    if (!ALLOWED_SCHEMA_IDS.includes(schemaId)) {
      addError(
        errors,
        "schema",
        relative,
        `schema_id is not allowlisted for this package: ${schemaId}`,
      );
    }
  }
}

function validateCandidate(relative, value, errors, cancellationIds) {
  expectKeys(relative, value, TOP_LEVEL_KEYS.candidate, errors);
  if (!value || typeof value !== "object") return;
  const cancellationId = value.cancellation_id;
  if (typeof cancellationId !== "string" || cancellationId.trim() === "") {
    addError(errors, "cancellation_id", relative, "cancellation_id is required");
  } else if (cancellationIds.has(cancellationId)) {
    addError(
      errors,
      "cancellation_id",
      relative,
      `duplicate cancellation_id: ${cancellationId}`,
    );
  } else {
    cancellationIds.add(cancellationId);
  }
  if (value.strategy && typeof value.strategy === "object") {
    const allowed = ["name", "version", "build", "operator", "created_at"];
    const extra = objectKeys(value.strategy).filter((key) => !allowed.includes(key));
    if (extra.length > 0) {
      addError(
        errors,
        "shape",
        relative,
        `unknown strategy fields: ${extra.join(", ")}`,
      );
    }
    for (const key of ["name", "operator", "created_at"]) {
      if (typeof value.strategy[key] !== "string" || value.strategy[key] === "") {
        addError(errors, "shape", relative, `strategy.${key} is required`);
      }
    }
  }
  scanObjectSecrets(relative, value, errors);
}

function validateRunbook(runbookPath, readmeText, errors) {
  if (!fs.existsSync(runbookPath) || !fs.statSync(runbookPath).isFile()) {
    addError(
      errors,
      "missing_file",
      "runbook",
      `runbook is missing: ${runbookPath}`,
    );
    return;
  }
  const runbook = readUtf8(runbookPath);
  const texts = [
    { path: "runbook", text: runbook },
    { path: "README.md", text: readmeText },
  ];
  for (const { path: label, text } of texts) {
    const lowered = text.toLowerCase();
    for (const invented of INVENTED_OFFLINE) {
      if (lowered.includes(invented)) {
        addError(
          errors,
          "runbook",
          label,
          `invented offline flag is rejected: ${invented}`,
        );
      }
    }
    if (lowered.includes("models verify --all")) {
      addError(
        errors,
        "runbook",
        label,
        "runbook must not recommend models verify --all",
      );
    }
    for (const needle of HISTORICAL_VERCEL) {
      if (lowered.includes(needle)) {
        addError(
          errors,
          "runbook",
          label,
          `historical Vercel/live-evidence identifier must not be presented as current expected output: ${needle}`,
        );
      }
    }
  }
  const liveDistinct =
    /bench-compare/.test(runbook) &&
    /import-run/.test(runbook) &&
    /record-replay/.test(runbook);
  if (!liveDistinct) {
    addError(
      errors,
      "runbook",
      "runbook",
      "runbook must distinguish live bench-compare from offline import-run/record-replay",
    );
  }
  if (
    /bench-compare/.test(runbook) &&
    !/credential|keychain|file:/.test(runbook.toLowerCase())
  ) {
    addError(
      errors,
      "runbook",
      "runbook",
      "live bench-compare section must remain credential-gated (keychain or file: reference)",
    );
  }
}

function compareFileSets(found, errors) {
  const required = [...REQUIRED_FILES].sort();
  const onDisk = [...found].sort();
  const missing = required.filter((file) => !onDisk.includes(file));
  const extra = onDisk.filter((file) => !required.includes(file));
  for (const file of missing) {
    addError(errors, "missing_file", file, "required package file is missing");
  }
  for (const file of extra) {
    addError(
      errors,
      "extra_file",
      file,
      "package contains a file that is not in the exact Grok fixture set",
    );
  }
}

export function validateDemoFixturePackage({ packageRoot, runbookPath }) {
  const errors = [];
  if (!fs.existsSync(packageRoot)) {
    addError(errors, "missing_file", ".", `package directory is missing: ${packageRoot}`);
    return report(false, packageRoot, runbookPath, errors);
  }
  const stat = fs.lstatSync(packageRoot);
  if (stat.isSymbolicLink()) {
    addError(errors, "symlink", ".", "package root must not be a symlink");
    return report(false, packageRoot, runbookPath, errors);
  }
  if (!stat.isDirectory()) {
    addError(errors, "shape", ".", "package root must be a directory");
    return report(false, packageRoot, runbookPath, errors);
  }

  const found = walkPackageFiles(packageRoot, errors);
  for (const relative of found) {
    if (forbiddenSegmentIn(relative)) {
      addError(
        errors,
        "forbidden_segment",
        relative,
        "package path contains a forbidden truth/metrics segment",
      );
    }
  }
  compareFileSets(found, errors);

  const jsonByRelative = new Map();
  for (const relative of REQUIRED_FILES.filter((file) => file.endsWith(".json"))) {
    const full = path.join(packageRoot, ...relative.split("/"));
    if (!fs.existsSync(full)) continue;
    const value = loadJson(full, relative, errors);
    if (value == null) continue;
    jsonByRelative.set(relative, value);
    validateSchemaIds(relative, value, errors);
    walkPrivacy(value, relative, false, errors);
    walkClaims(value, relative, errors);
    walkForbiddenPaths(value, relative, errors);
    scanTextSecrets(relative, readUtf8(full), errors, { jsonLike: true });
  }

  const identities = jsonByRelative.get("identities.json");
  const snapshot = jsonByRelative.get("snapshot.json");
  const caseDoc = jsonByRelative.get("case.json");
  const task = jsonByRelative.get("task.json");
  if (identities) expectKeys("identities.json", identities, TOP_LEVEL_KEYS["identities.json"], errors);
  if (identities && Object.hasOwn(identities, "schema_id")) {
    addError(
      errors,
      "shape",
      "identities.json",
      "identities.json is a helper listing, not a stored bench record, and must not carry schema_id",
    );
  }
  if (snapshot) expectKeys("snapshot.json", snapshot, TOP_LEVEL_KEYS["snapshot.json"], errors);
  if (caseDoc) expectKeys("case.json", caseDoc, TOP_LEVEL_KEYS["case.json"], errors);
  if (task) expectKeys("task.json", task, TOP_LEVEL_KEYS["task.json"], errors);
  if (identities && snapshot) {
    validateBlob(packageRoot, snapshot, identities, errors);
  }
  if (identities && caseDoc && identities.case_id !== caseDoc.case_id) {
    addError(errors, "shape", "identities.json", "case_id does not match case.json");
  }
  if (identities && task && identities.task_id !== task.task_id) {
    addError(errors, "shape", "identities.json", "task_id does not match task.json");
  }
  if (identities && snapshot && identities.snapshot_id !== snapshot.snapshot_id) {
    addError(
      errors,
      "shape",
      "identities.json",
      "snapshot_id does not match snapshot.json",
    );
  }
  if (task && snapshot && task.snapshot_id !== snapshot.snapshot_id) {
    addError(errors, "shape", "task.json", "task snapshot_id does not match snapshot.json");
  }

  for (const relative of ["recorded/human-run.json", "recorded/other-product-run.json"]) {
    const value = jsonByRelative.get(relative);
    if (value) expectKeys(relative, value, TOP_LEVEL_KEYS.recorded, errors);
  }
  for (const relative of ["replay/replay-completed.json", "replay/replay-failed.json"]) {
    const value = jsonByRelative.get(relative);
    if (value) expectKeys(relative, value, TOP_LEVEL_KEYS.replay, errors);
  }

  const cancellationIds = new Set();
  for (const relative of ["candidates/candidate-a.json", "candidates/candidate-b.json"]) {
    const value = jsonByRelative.get(relative);
    if (value) validateCandidate(relative, value, errors, cancellationIds);
  }

  const blobPath = path.join(packageRoot, "blobs", "checkout.log");
  if (fs.existsSync(blobPath)) {
    scanTextSecrets("blobs/checkout.log", readUtf8(blobPath), errors, {
      jsonLike: true,
    });
  }

  const readmePath = path.join(packageRoot, "README.md");
  const readmeText = fs.existsSync(readmePath) ? readUtf8(readmePath) : "";
  validateRunbook(runbookPath, readmeText, errors);

  errors.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    const byCode = a.code.localeCompare(b.code);
    if (byCode !== 0) return byCode;
    return a.message.localeCompare(b.message);
  });
  return report(errors.length === 0, packageRoot, runbookPath, errors);
}

function displayPath(filePath) {
  const rel = posixRelative(process.cwd(), filePath);
  if (rel && !rel.startsWith("..")) return rel;
  return filePath;
}

function report(ok, packageRoot, runbookPath, errors) {
  return {
    ok,
    schema_id: PREFLIGHT_SCHEMA_ID,
    package: displayPath(packageRoot),
    runbook: displayPath(runbookPath),
    files: REQUIRED_FILES.length,
    errors,
  };
}

export function formatReport(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usageText());
    return 0;
  }
  const packageRoot = resolveUserPath(args.package, "--package");
  const runbookPath = args.runbook
    ? resolveUserPath(args.runbook, "--runbook")
    : defaultRunbookPath(packageRoot);
  const result = validateDemoFixturePackage({ packageRoot, runbookPath });
  process.stdout.write(formatReport(result));
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    const code = error && error.code === "usage" ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (error && error.code === "usage") {
      process.stderr.write(`${message}\n${usageText()}`);
    } else if (error && error.code === "path_traversal") {
      process.stdout.write(
        formatReport({
          ok: false,
          schema_id: PREFLIGHT_SCHEMA_ID,
          package: "",
          runbook: "",
          files: REQUIRED_FILES.length,
          errors: [{ code: "path_traversal", path: ".", message }],
        }),
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = code;
  }
}
