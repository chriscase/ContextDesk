/**
 * Fail closed if optional gui-accept workflow becomes a required-gate bypass
 * or starts claiming native/installed-bundle acceptance.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const wf = join(repoRoot, ".github", "workflows", "gui-accept.yml");
const defaultCi = join(repoRoot, ".github", "workflows", "ci.yml");

describe("gui-accept workflow contract", () => {
  it("exists and is workflow_dispatch / schedule only (not PR required gate)", () => {
    assert.ok(existsSync(wf), "gui-accept.yml should exist");
    const y = readFileSync(wf, "utf8");
    assert.match(y, /workflow_dispatch/);
    assert.match(
      y,
      /cron:\s*["']0 6 \* \* \*["']/,
      "gui-accept must remain a nightly scheduled validation",
    );
    // Must not attach to pull_request or push as a required path
    assert.ok(
      !/^\s*pull_request\s*:/m.test(y),
      "gui-accept must not run on pull_request (would become gate noise / bypass confusion)",
    );
    assert.ok(
      !/^\s*push\s*:/m.test(y),
      "gui-accept must not run on every push",
    );
    assert.match(
      y,
      /NOT a required status check|optional/i,
      "workflow must document non-required status",
    );
  });

  it("claims Linux release-host integration only", () => {
    const y = readFileSync(wf, "utf8");
    assert.match(y, /release-host/i);
    assert.match(y, /ubuntu-24\.04/);
    assert.doesNotMatch(y, /macos|windows/i);
    assert.doesNotMatch(y, /GUI_ACCEPT_REQUIRE_PACKAGED/);
  });

  it("runs lightweight locked contracts in default PR CI without WebDriver", () => {
    const y = readFileSync(defaultCi, "utf8");
    const start = y.indexOf("gui-accept-contracts:");
    assert.ok(start > 0, "default CI must contain gui-accept-contracts job");
    const rest = y.slice(start + "gui-accept-contracts:".length);
    const next = rest.search(/\n {2}[A-Za-z0-9_-]+:/);
    assert.ok(next > 0, "gui-accept-contracts job must remain bounded");
    const end = start + "gui-accept-contracts:".length + next;
    const job = y.slice(start, end);
    assert.match(job, /desktop\/gui-accept\/package-lock\.json/);
    assert.match(job, /npm ci/);
    assert.match(job, /npm test/);
    assert.doesNotMatch(job, /wdio|tauri-driver|xvfb/i);
  });

  it("uploads the hidden run directory as retained evidence", () => {
    const y = readFileSync(wf, "utf8");
    const start = y.indexOf("- name: Upload artifacts");
    assert.ok(start > 0, "workflow must retain GUI acceptance artifacts");
    const upload = y.slice(start);
    assert.match(upload, /path:\s*desktop\/gui-accept\/\.runs\//);
    assert.match(upload, /include-hidden-files:\s*true/);
    assert.match(upload, /if-no-files-found:\s*error/);
  });
});
