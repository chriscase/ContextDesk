/**
 * Structural proof for #153: macOS overlay titlebar + drag region.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "../../..");

describe("overlay titlebar chrome (#153)", () => {
  it("tauri window uses Overlay + hiddenTitle + decorations", () => {
    const conf = JSON.parse(
      readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const win = conf.app.windows[0];
    expect(win.titleBarStyle).toBe("Overlay");
    expect(win.hiddenTitle).toBe(true);
    expect(win.decorations).toBe(true);
    expect(win.resizable).toBe(true);
  });

  it("Titlebar marks drag region and no-drag controls", () => {
    const src = readFileSync(join(here, "Titlebar.tsx"), "utf8");
    expect(src).toMatch(/data-tauri-drag-region/);
    expect(src).toMatch(/titlebar__no-drag/);
    expect(src).toMatch(/titlebar__drag/);
    expect(src).toMatch(/startDragging/);
  });

  it("layout CSS sets drag region and macOS traffic-light padding", () => {
    const css = readFileSync(join(desktop, "src/styles/layout.css"), "utf8");
    expect(css).toMatch(/-webkit-app-region:\s*drag/);
    expect(css).toMatch(/titlebar__no-drag/);
    expect(css).toMatch(/\.titlebar__drag/);
    expect(css).toMatch(/data-platform="macos"/);
    expect(css).toMatch(/padding-left:\s*78px/);
    expect(css).toMatch(/var\(--titlebar-h\)/);
  });

  it("workspace/pane-panel flex chain allows chat-scroll overflow", () => {
    // Without pane-panel flex+min-height:0, overflow:auto never forms a scrollport.
    const css = readFileSync(join(desktop, "src/styles/layout.css"), "utf8");
    expect(css).toMatch(/\.pane-panel\s*\{[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.pane-panel\s*\{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/\.chat-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.workspace\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("capabilities grant start-dragging for Magic Trackpad window move", () => {
    const cap = readFileSync(
      join(desktop, "src-tauri/capabilities/default.json"),
      "utf8",
    );
    expect(cap).toMatch(/core:window:allow-start-dragging/);
    // tauri dev serves http://localhost:* — ACL treats that as remote.
    expect(cap).toMatch(/"remote"/);
    expect(cap).toMatch(/localhost/);
  });

  it("tauri window is labeled main and registers default capability", () => {
    const conf = JSON.parse(
      readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(conf.app.windows[0].label).toBe("main");
    expect(conf.app.security.capabilities).toContain("default");
  });

  it("theme-init sets data-platform=macos on Mac UA", () => {
    const js = readFileSync(join(desktop, "public/theme-init.js"), "utf8");
    expect(js).toMatch(/data-platform/);
    expect(js).toMatch(/macos/);
  });

  it("capabilities stay thin — no shell/fs grants for chrome", () => {
    const cap = readFileSync(
      join(desktop, "src-tauri/capabilities/default.json"),
      "utf8",
    );
    expect(cap).not.toMatch(/shell:/);
    expect(cap).not.toMatch(/fs:allow/);
  });
});
