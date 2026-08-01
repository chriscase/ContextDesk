import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createIsolatedHomes,
  startOllamaStub,
  setConfigOllamaBaseUrl,
  sutEnv,
  scrubSensitiveEnv,
} from "./env.mjs";

describe("env isolation", () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "gui-accept-env-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates isolated home + config without mutating process.env.HOME", async () => {
    const beforeHome = process.env.HOME;
    const homes = createIsolatedHomes(dir);
    assert.ok(existsSync(homes.configPath));
    assert.equal(process.env.HOME, beforeHome);

    const stub = await startOllamaStub();
    setConfigOllamaBaseUrl(homes.configPath, stub.url);
    const cfg = JSON.parse(readFileSync(homes.configPath, "utf8"));
    assert.equal(cfg.providers.profiles[0].base_url, stub.url);
    // PreLaunch (demo install) must remain reachable
    assert.equal(cfg.setup_completed, false);

    const res = await fetch(`${stub.url}/api/tags`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.models?.length >= 1);

    const env = sutEnv({ home: homes.home, runDir: dir });
    assert.equal(env.HOME, homes.home);
    assert.notEqual(env.HOME, beforeHome);

    await stub.close();
  });

  it("removes ambient provider endpoints and credentials from the SUT", () => {
    const clean = scrubSensitiveEnv({
      PATH: "/usr/bin",
      DISPLAY: ":99",
      OPENAI_API_KEY: "do-not-forward",
      ANTHROPIC_BASE_URL: "https://provider.invalid",
      GITHUB_TOKEN: "do-not-forward",
      SAFE_SETTING: "kept",
    });
    assert.equal(clean.PATH, "/usr/bin");
    assert.equal(clean.DISPLAY, ":99");
    assert.equal(clean.SAFE_SETTING, "kept");
    assert.equal(clean.OPENAI_API_KEY, undefined);
    assert.equal(clean.ANTHROPIC_BASE_URL, undefined);
    assert.equal(clean.GITHUB_TOKEN, undefined);
  });
});
