import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDir, "check_public_media.mjs");
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function run(root, manifest = "docs/media/public-assets.json") {
  return spawnSync(process.execPath, [validator, root, manifest], {
    encoding: "utf8",
  });
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function asset(pathname, gitBlob) {
  return {
    path: pathname,
    gitBlob,
    sourceSha: SOURCE_SHA,
    privacyReview: "publishable",
    modelInventoryVisible: false,
    fixture: "synthetic",
    theme: "dark",
    claim: "Synthetic product frame",
    reviewedBy: "Test Agent",
  };
}

function writeManifest(root, assets) {
  fs.writeFileSync(
    path.join(root, "docs", "media", "public-assets.json"),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`,
  );
}

function withRepository(runTest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-media-"));
  try {
    git(root, ["init", "--quiet"]);
    fs.mkdirSync(path.join(root, "docs", "media", "gallery"), {
      recursive: true,
    });
    const pathname = "docs/media/gallery/frame.png";
    const absolute = path.join(root, ...pathname.split("/"));
    fs.writeFileSync(absolute, Buffer.from("synthetic-png-bytes"));
    const gitBlob = git(root, ["hash-object", "--", absolute]);
    writeManifest(root, [asset(pathname, gitBlob)]);
    runTest({ root, pathname, absolute, gitBlob });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("valid manifest passes with concise output", () => {
  withRepository(({ root }) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "public media manifest valid: 1 assets, 0 published references\n",
    );
    assert.equal(result.stderr, "");
  });
});

test("the checked-in public media ledger validates against the real repository", () => {
  const result = run(path.resolve(scriptDir, ".."));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^public media manifest valid: \d+ assets/);
});

test("a README raster outside the ledger fails closed", () => {
  withRepository(({ root, pathname }) => {
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n![CI](https://example.invalid/badge.svg)\n\n![Listed](${pathname})\n`,
    );
    const listed = run(root);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /1 published references/);

    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs", "images", "unreviewed.png"),
      "unreviewed",
    );
    fs.appendFileSync(
      path.join(root, "README.md"),
      "\n![Unreviewed](docs/images/unreviewed.png)\n",
    );
    const smuggled = run(root);
    assert.notEqual(smuggled.status, 0);
    assert.match(
      smuggled.stderr,
      /published raster 'docs\/images\/unreviewed\.png' is not in the public media ledger/,
    );
  });
});

test("modified image bytes fail exact Git blob identity", () => {
  withRepository(({ root, absolute }) => {
    fs.appendFileSync(absolute, "-modified");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git blob mismatch/);
  });
});

test("an unlisted raster image fails closed", () => {
  withRepository(({ root }) => {
    fs.writeFileSync(
      path.join(root, "docs", "media", "extra.webp"),
      "unlisted",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unlisted raster image.*extra\.webp/);
  });
});

test("unsafe privacy metadata fails closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    const unsafe = asset(pathname, gitBlob);
    unsafe.privacyReview = "pending";
    writeManifest(root, [unsafe]);
    const privacy = run(root);
    assert.notEqual(privacy.status, 0);
    assert.match(privacy.stderr, /privacyReview must be 'publishable'/);

    unsafe.privacyReview = "publishable";
    unsafe.modelInventoryVisible = true;
    writeManifest(root, [unsafe]);
    const inventory = run(root);
    assert.notEqual(inventory.status, 0);
    assert.match(inventory.stderr, /modelInventoryVisible must be false/);
  });
});

test("duplicate and traversal paths fail closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    writeManifest(root, [
      asset(pathname, gitBlob),
      asset(pathname, gitBlob),
    ]);
    const duplicate = run(root);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate asset path/);

    writeManifest(root, [asset("docs/media/../outside.png", gitBlob)]);
    const traversal = run(root);
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /normalized and repo-relative/);
  });
});

test("a raster symlink escaping docs/media fails closed", () => {
  withRepository(({ root, pathname, absolute, gitBlob }) => {
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(absolute);
    fs.symlinkSync(outside, absolute);
    writeManifest(root, [asset(pathname, gitBlob)]);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink escapes docs\/media/);
  });
});

test("malformed source SHA fails closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    const malformed = asset(pathname, gitBlob);
    malformed.sourceSha = "not-a-sha";
    writeManifest(root, [malformed]);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sourceSha.*40-hex/);
  });
});
