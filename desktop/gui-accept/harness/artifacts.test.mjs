import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRunDir,
  writeJson,
  recordTiming,
  buildFailureBundle,
  listScreenshots,
} from "./artifacts.mjs";

describe("artifacts", () => {
  /** @type {string} */
  let base;
  before(() => {
    base = mkdtempSync(join(tmpdir(), "gui-accept-art-"));
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("creates run dir with subfolders and records timings", () => {
    const run = createRunDir(base, "test");
    assert.ok(existsSync(join(run, "screenshots")));
    assert.ok(existsSync(join(run, "logs")));
    writeJson(run, "sample.json", { ok: true });
    assert.equal(JSON.parse(readFileSync(join(run, "sample.json"), "utf8")).ok, true);
    recordTiming(run, "demo", 12, "ok");
    assert.ok(existsSync(join(run, "timings", "scenarios.jsonl")));
    const bundle = buildFailureBundle(run, { reason: "unit-test" });
    assert.ok(existsSync(join(bundle, "failure.json")));
    assert.deepEqual(listScreenshots(run), []);
  });

  it("failure bundle does not invent secret-bearing fields", () => {
    const run = createRunDir(base, "sec");
    writeJson(run, "meta.json", {
      startedAt: new Date().toISOString(),
      note: "no api keys",
    });
    const bundle = buildFailureBundle(run, { reason: "security-shape" });
    const fail = JSON.parse(readFileSync(join(bundle, "failure.json"), "utf8"));
    const blob = JSON.stringify(fail);
    assert.ok(!/api[_-]?key|authorization|password|Bearer\s/i.test(blob));
    assert.equal(fail.reason, "security-shape");
  });
});
