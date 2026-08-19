import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PREFLIGHT_SCHEMA_ID,
  REQUIRED_FILES,
  main,
  parseArgs,
  validateDemoFixturePackage,
} from "./demo-fixture-preflight.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packageRel = "fixtures/triage-comparison-demo";
const runbookRel = "docs/benchmarks/TRIAGE_COMPARISON_DEMO.md";
const scriptPath = path.join(scriptDir, "demo-fixture-preflight.mjs");

function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function withCopiedPackage(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cd-demo-preflight-"));
  try {
    const packageRoot = path.join(root, "fixtures", "triage-comparison-demo");
    const runbookPath = path.join(root, "docs", "benchmarks", "TRIAGE_COMPARISON_DEMO.md");
    copyTree(path.join(repoRoot, packageRel), packageRoot);
    fs.mkdirSync(path.dirname(runbookPath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, runbookRel), runbookPath);
    run({ root, packageRoot, runbookPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test("the checked-in Grok package and runbook pass", () => {
  const result = validateDemoFixturePackage({
    packageRoot: path.join(repoRoot, packageRel),
    runbookPath: path.join(repoRoot, runbookRel),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.schema_id, PREFLIGHT_SCHEMA_ID);
  assert.equal(result.files, REQUIRED_FILES.length);
  assert.deepEqual(result.errors, []);
});

test("CLI writes machine-readable success JSON and exits 0", () => {
  const child = spawnSync(
    process.execPath,
    [scriptPath, "--package", packageRel],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.schema_id, PREFLIGHT_SCHEMA_ID);
  assert.deepEqual(report.errors, []);
});

test("a mutated blob is rejected", () => {
  withCopiedPackage(({ packageRoot, runbookPath }) => {
    const blob = path.join(packageRoot, "blobs", "checkout.log");
    const original = fs.readFileSync(blob);
    original[0] = original[0] === 50 ? 51 : 50;
    fs.writeFileSync(blob, original);
    const result = validateDemoFixturePackage({ packageRoot, runbookPath });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("blob_mismatch"));
    assert.ok(
      result.errors.some((error) => /digest/.test(error.message)),
      JSON.stringify(result.errors, null, 2),
    );
  });
});

test("an extra package file is rejected", () => {
  withCopiedPackage(({ packageRoot, runbookPath }) => {
    fs.writeFileSync(path.join(packageRoot, "extra.json"), "{}\n");
    const result = validateDemoFixturePackage({ packageRoot, runbookPath });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("extra_file"));
    assert.ok(result.errors.some((error) => error.path === "extra.json"));
  });
});

test("a forbidden truth path is rejected", () => {
  withCopiedPackage(({ packageRoot, runbookPath }) => {
    const identitiesPath = path.join(packageRoot, "identities.json");
    const identities = readJson(identitiesPath);
    identities.blob.path = "truth/checkout.log";
    writeJson(identitiesPath, identities);
    fs.mkdirSync(path.join(packageRoot, "truth"), { recursive: true });
    fs.copyFileSync(
      path.join(packageRoot, "blobs", "checkout.log"),
      path.join(packageRoot, "truth", "checkout.log"),
    );
    const result = validateDemoFixturePackage({ packageRoot, runbookPath });
    assert.equal(result.ok, false);
    assert.ok(
      codes(result).includes("forbidden_segment"),
      JSON.stringify(result.errors, null, 2),
    );
  });
});

test("owner-only nested under share-safe is rejected", () => {
  withCopiedPackage(({ packageRoot, runbookPath }) => {
    const snapshotPath = path.join(packageRoot, "snapshot.json");
    const snapshot = readJson(snapshotPath);
    snapshot.privacy = "share_safe";
    snapshot.items[0].privacy = "owner_only";
    writeJson(snapshotPath, snapshot);
    const result = validateDemoFixturePackage({ packageRoot, runbookPath });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("privacy"));
    assert.ok(
      result.errors.some((error) =>
        /owner-only record cannot be labeled or nested under share-safe/.test(
          error.message,
        ),
      ),
    );
  });
});

test("secret-shaped candidate content is rejected", () => {
  withCopiedPackage(({ packageRoot, runbookPath }) => {
    const candidatePath = path.join(packageRoot, "candidates", "candidate-a.json");
    const candidate = readJson(candidatePath);
    candidate.api_key = "sk-test-not-a-real-key";
    candidate.endpoint = "https://example.invalid/v1";
    writeJson(candidatePath, candidate);
    const result = validateDemoFixturePackage({ packageRoot, runbookPath });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("secret"), JSON.stringify(result.errors, null, 2));
    assert.ok(result.errors.some((error) => error.path === "candidates/candidate-a.json"));
  });
});

test("--package is required and rejects path traversal", () => {
  assert.throws(() => parseArgs([]), /--package <dir> is required/);
  const missing = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  const traversal = spawnSync(
    process.execPath,
    [scriptPath, "--package", "../secret"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(traversal.status, 1);
  const report = JSON.parse(traversal.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === "path_traversal"));
});

test("CLI exits 1 with machine-readable errors for a mutated package", () => {
  withCopiedPackage(({ packageRoot, runbookPath }) => {
    fs.writeFileSync(path.join(packageRoot, "extra.json"), "{}\n");
    const child = spawnSync(
      process.execPath,
      [scriptPath, "--package", packageRoot, "--runbook", runbookPath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.errors.length > 0);
  });
});

test("main() returns 0 for the checked-in package", () => {
  const previous = process.exitCode;
  const stdout = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  try {
    const code = main(["--package", packageRel]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout.join(""));
    assert.equal(report.ok, true);
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = previous;
  }
});
