import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("check-matrix script", () => {
  it("exits 0 and prints JSON", () => {
    const r = spawnSync(process.execPath, [join(here, "check-matrix.mjs")], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(j.os);
    assert.ok(j.releaseHostWebDriver);
  });
});
