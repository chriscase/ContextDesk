/**
 * Binary identity / SPA-embed / fixture staging contracts.
 * Does not build the host — uses temp files and path shape assertions.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  candidateBinaries,
  probeSpaEmbedded,
  assertReleaseHostBinary,
  binaryResolutionMode,
  binarySha256,
  sourceRevision,
  findBuiltReleaseBinary,
  stageDemoLogResource,
  SPA_EMBED_MARKERS,
  repoRoot,
} from "./binary.mjs";

describe("binary identity", () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "gui-accept-bin-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("candidateBinaries prefers release paths and includes ContextDesk names", () => {
    const c = candidateBinaries(repoRoot());
    assert.ok(c.length >= 2);
    assert.ok(c.some((p) => /release/.test(p)));
    assert.ok(c.every((p) => !/(?:^|[/\\])debug(?:[/\\]|$)/.test(p)));
    assert.ok(c.some((p) => /contextdesk|ContextDesk/i.test(p)));
  });

  it("records the exact checked-out source revision", () => {
    assert.match(sourceRevision(repoRoot()) || "", /^[0-9a-f]{40}$/);
  });

  it("SPA_EMBED_MARKERS match known dist fingerprint shapes", () => {
    assert.ok(SPA_EMBED_MARKERS.length >= 2);
    const sample = "critical-boot ibm-plex index-Ab12cd.js other";
    assert.ok(SPA_EMBED_MARKERS.some((re) => re.test(sample)));
  });

  it("probeSpaEmbedded fails closed on missing and non-SPA files", () => {
    assert.equal(probeSpaEmbedded(join(dir, "nope")).ok, false);
    const plain = join(dir, "plain.bin");
    // >1k so size check passes, no markers
    writeFileSync(plain, Buffer.alloc(2048, 0x41));
    const p = probeSpaEmbedded(plain);
    assert.equal(p.ok, false);
    assert.match(p.reason, /SPA markers missing|custom-protocol/i);
  });

  it("probeSpaEmbedded accepts a file containing SPA markers", () => {
    const good = join(dir, "good.bin");
    const payload =
      "padding-".repeat(200) +
      "critical-boot" +
      "-and-ibm-plex-" +
      "index-AbCd12.js" +
      "more";
    writeFileSync(good, payload);
    const p = probeSpaEmbedded(good);
    assert.equal(p.ok, true, p.reason);
  });

  it("assertReleaseHostBinary rejects dev URLs and vite paths without requiring SPA", () => {
    assert.throws(
      () => assertReleaseHostBinary("http://localhost:1450", { requireSpa: false }),
      /dev URL|localhost/i,
    );
    assert.throws(
      () =>
        assertReleaseHostBinary("/tmp/node_modules/vite/bin/vite.js", {
          requireSpa: false,
        }),
      /frontend dev|vite/i,
    );
    const debug = join(dir, "target", "debug", "contextdesk");
    mkdirSync(join(dir, "target", "debug"), { recursive: true });
    writeFileSync(debug, "x".repeat(1500) + "critical-boot");
    assert.throws(
      () => assertReleaseHostBinary(debug, { requireSpa: false }),
      /debug executable/i,
    );
  });

  it("assertReleaseHostBinary fails closed when SPA markers missing", () => {
    const plain = join(dir, "host-no-spa");
    writeFileSync(plain, Buffer.alloc(4096, 0x42));
    assert.throws(() => assertReleaseHostBinary(plain), /SPA markers missing/i);
  });

  it("assertReleaseHostBinary accepts SPA-embedded stand-in", () => {
    const good = join(dir, "contextdesk");
    writeFileSync(
      good,
      "x".repeat(1500) + "critical-boot index-Z9y8x7.css ibm-plex",
    );
    assert.equal(assertReleaseHostBinary(good), true);
    assert.equal(
      binarySha256(good),
      "5a01af2e2434ab17dbaf20235ceb293a863270c61199f34279d60f7dadcc3092",
    );
  });

  it("an explicit build can never select an existing stale binary", () => {
    assert.equal(binaryResolutionMode({ build: true }), "build");
    assert.equal(binaryResolutionMode({}), "build");
    assert.equal(binaryResolutionMode({ build: false }), "existing-non-exact");

    const target = join(dir, "exact-target");
    const release = join(target, "release");
    mkdirSync(release, { recursive: true });
    const fresh = join(release, "contextdesk");
    const stale = join(dir, "stale-contextdesk");
    writeFileSync(fresh, "fresh");
    writeFileSync(stale, "stale");
    const previousTarget = process.env.CARGO_TARGET_DIR;
    const previousOverride = process.env.GUI_ACCEPT_APP_BINARY;
    process.env.CARGO_TARGET_DIR = target;
    process.env.GUI_ACCEPT_APP_BINARY = stale;
    try {
      assert.equal(findBuiltReleaseBinary(repoRoot()), fresh);
    } finally {
      if (previousTarget === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = previousTarget;
      if (previousOverride === undefined) delete process.env.GUI_ACCEPT_APP_BINARY;
      else process.env.GUI_ACCEPT_APP_BINARY = previousOverride;
    }
  });

  it("stageDemoLogResource uses checked-in fixtures only and fails without binary", () => {
    const noBin = stageDemoLogResource(join(dir, "missing"));
    assert.equal(noBin.ok, false);

    const fakeBin = join(dir, "exe", "contextdesk");
    mkdirSync(join(dir, "exe"), { recursive: true });
    writeFileSync(fakeBin, "x".repeat(1500) + "critical-boot");
    const staged = stageDemoLogResource(fakeBin);
    // May fail if fixtures not present in weird GUI_ACCEPT_REPO_ROOT — expect ok in worktree
    if (existsSync(join(repoRoot(), "fixtures/log-lab/acceptance/seven-day-25k"))) {
      assert.equal(staged.ok, true, staged.log);
      assert.ok(staged.dest && staged.dest.includes("demo-log-corpus"));
      assert.ok(
        !/[\\/]\.contextdesk[\\/]cache[\\/]/.test(staged.dest || ""),
        "must not stage into developer cache",
      );
      assert.ok(existsSync(join(dir, "exe", ".cargo-lock")));
    }
  });
});
