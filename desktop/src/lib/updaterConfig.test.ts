/**
 * Structural proof for opt-in signed updater (#173).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = join(desktop, "..");

describe("opt-in signed updater (#173)", () => {
  it("tauri.conf has pubkey, HTTPS endpoints, createUpdaterArtifacts", () => {
    const conf = JSON.parse(
      readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
    const up = conf.plugins?.updater;
    expect(up).toBeTruthy();
    expect(typeof up.pubkey).toBe("string");
    expect(up.pubkey.length).toBeGreaterThan(40);
    // never a private key marker
    expect(up.pubkey).not.toMatch(/PRIVATE KEY|BEGIN/);
    expect(Array.isArray(up.endpoints)).toBe(true);
    for (const ep of up.endpoints) {
      expect(ep).toMatch(/^https:\/\//);
      expect(ep).not.toMatch(/\*/);
    }
  });

  it("capabilities grant updater:default with documented why", () => {
    const cap = readFileSync(
      join(desktop, "src-tauri/capabilities/default.json"),
      "utf8",
    );
    expect(cap).toMatch(/updater:default/);
    expect(cap).toMatch(/#173|opt-in|signed/);
    expect(cap).not.toMatch(/shell:/);
  });

  it("unified release delegates signed builds and assembles exact updater metadata", () => {
    const orchestrator = readFileSync(
      join(repo, ".github/workflows/release.yml"),
      "utf8",
    );
    const desktopBuilder = readFileSync(
      join(repo, ".github/workflows/release-desktop.yml"),
      "utf8",
    );
    expect(orchestrator).toMatch(/uses: \.\/\.github\/workflows\/release-desktop\.yml/);
    expect(orchestrator).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
    expect(orchestrator).toMatch(/signed_updater:/);
    expect(orchestrator).toMatch(/release_contract\.py assemble/);
    expect(orchestrator).toMatch(/--require-signed-updater/);
    expect(orchestrator).toMatch(/latest\.json/);
    expect(desktopBuilder).toMatch(/CONTEXTDESK_SIGNED_UPDATER/);
    expect(desktopBuilder).toMatch(/createUpdaterArtifacts=false/);
    // The unified assembler owns latest.json. Tauri action must not create a
    // second release/update object through its legacy mutation option.
    expect(orchestrator).not.toMatch(/includeUpdaterJson/);
    expect(desktopBuilder).not.toMatch(/includeUpdaterJson/);
    expect(`${orchestrator}\n${desktopBuilder}`).not.toMatch(/BEGIN.*PRIVATE/);
    expect(desktopBuilder).toMatch(/libayatana-appindicator3-dev/);
    expect(desktopBuilder).not.toMatch(/\blibappindicator3-dev\b/);
    expect(desktopBuilder).toMatch(/platform: ubuntu-24\.04/);
    expect(desktopBuilder).not.toMatch(/platform: ubuntu-22\.04/);
  });

  it("host check/install helpers exist and docs cover trust boundary", () => {
    const host = readFileSync(join(desktop, "src/lib/host.ts"), "utf8");
    expect(host).toMatch(/hostCheckForUpdates/);
    expect(host).toMatch(/hostInstallUpdate/);
    expect(host).toMatch(/downloadAndInstall/);
    const pack = readFileSync(join(repo, "docs/PACKAGING.md"), "utf8");
    expect(pack).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
    const threat = readFileSync(join(repo, "docs/THREAT_MODEL.md"), "utf8");
    expect(threat).toMatch(/updater trust boundary|#173/i);
  });
});
