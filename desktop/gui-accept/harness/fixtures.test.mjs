import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  cpSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sevenDay25kImportDir,
  prepare25kZip,
  EXPECTED_25K_EVENTS,
  DEMO_IDENTITY,
} from "./fixtures.mjs";

describe("fixtures", () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "gui-accept-fix-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("locates checked-in 25k acceptance import tree", () => {
    const imp = sevenDay25kImportDir();
    assert.ok(existsSync(imp), `missing ${imp}`);
    assert.ok(existsSync(join(imp, "api", "app.jsonl")));
  });

  it("builds a deterministic ZIP of the 25k import tree", () => {
    const sourceCopy = join(dir, "source-copy");
    cpSync(sevenDay25kImportDir(), sourceCopy, { recursive: true });
    const zip = join(dir, "25k-a.zip");
    const meta = prepare25kZip(zip, sourceCopy);
    assert.ok(existsSync(zip));
    assert.equal(meta.expectedEvents, EXPECTED_25K_EVENTS);
    assert.ok(meta.bytes > 1000);
    assert.equal(meta.sha256.length, 64);

    // Mutation proof: source mtimes must not influence canonical ZIP bytes.
    const touched = join(sourceCopy, "api", "app.jsonl");
    utimesSync(touched, new Date("2026-01-01T01:01:00Z"), new Date("2026-01-01T01:01:00Z"));
    const zipB = join(dir, "25k-b.zip");
    const metaB = prepare25kZip(zipB, sourceCopy);
    assert.equal(metaB.sha256, meta.sha256);
    assert.deepEqual(readFileSync(zipB), readFileSync(zip));
    // zone-less unix ts present in golden API log (no timezone suffix)
    const sample = readFileSync(join(sevenDay25kImportDir(), "api", "app.jsonl"), "utf8")
      .split("\n")
      .find((l) => l.includes('"ts"'));
    assert.ok(sample);
    assert.match(sample, /"ts":\d+/);
    assert.ok(!/"ts":\s*".*[Zz]/.test(sample), "expect numeric epoch, not zoned string");
  });

  it("exports demo identity constant matching host", () => {
    assert.match(DEMO_IDENTITY, /seven-day-25k/);
  });
});
