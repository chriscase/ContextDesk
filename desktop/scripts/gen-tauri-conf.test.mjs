/**
 * Offline smoke test for gen-tauri-conf.mjs (#174).
 * Run: node --test scripts/gen-tauri-conf.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const brandingPath = path.join(repoRoot, "branding.toml");
const confPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");

test("gen-tauri-conf writes productName/identifier/title from branding.toml", () => {
  const brandingBak = fs.readFileSync(brandingPath, "utf8");
  const confBak = fs.readFileSync(confPath, "utf8");
  try {
    fs.writeFileSync(
      brandingPath,
      brandingBak
        .replace(/name = ".*"/, 'name = "Testbench"')
        .replace(/slug = ".*"/, 'slug = "testbench"'),
      "utf8",
    );
    const r = spawnSync(process.execPath, ["scripts/gen-tauri-conf.mjs"], {
      cwd: desktopRoot,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
    assert.equal(conf.productName, "Testbench");
    assert.equal(conf.identifier, "cc.chriscase.testbench");
    assert.equal(conf.app.windows[0].title, "Testbench");
    assert.equal(conf.app.windows[0].minWidth, 720);
    assert.equal(conf.app.windows[0].minHeight, 600);
  } finally {
    fs.writeFileSync(brandingPath, brandingBak, "utf8");
    // Restore through the same atomic generator path. A direct truncate/write
    // races the other node:test files that validate the checked-in config.
    const restore = spawnSync(process.execPath, ["scripts/gen-tauri-conf.mjs"], {
      cwd: desktopRoot,
      encoding: "utf8",
    });
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    assert.equal(fs.readFileSync(confPath, "utf8"), confBak);
  }
});
