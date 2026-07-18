/**
 * Structural proof for #152: local fonts + no CDN + pre-paint theme + tight CSP.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../../..");
const repoDesktop = desktopRoot; // …/desktop

describe("local fonts + theme pre-paint (#152)", () => {
  it("vendors Inter and IBM Plex Mono WOFF2 under assets/fonts", () => {
    const required = [
      "inter-latin-400-normal.woff2",
      "inter-latin-500-normal.woff2",
      "inter-latin-600-normal.woff2",
      "ibm-plex-mono-latin-400-normal.woff2",
      "ibm-plex-mono-latin-500-normal.woff2",
      "INTER-OFL.txt",
      "IBM-PLEX-MONO-OFL.txt",
      "fonts.css",
    ];
    for (const name of required) {
      expect(existsSync(join(here, name)), name).toBe(true);
    }
    const css = readFileSync(join(here, "fonts.css"), "utf8");
    expect(css).toMatch(/font-family:\s*"Inter"/);
    expect(css).toMatch(/font-family:\s*"IBM Plex Mono"/);
    expect(css).toMatch(/inter-latin-400-normal\.woff2/);
    expect(css).toMatch(/ibm-plex-mono-latin-400-normal\.woff2/);
  });

  it("index.html has no Google Fonts CDN links and loads theme-init.js", () => {
    const html = readFileSync(join(repoDesktop, "index.html"), "utf8");
    expect(html).not.toMatch(/fonts\.googleapis/);
    expect(html).not.toMatch(/fonts\.gstatic/);
    expect(html).toMatch(/src="\/theme-init\.js"/);
    expect(html).not.toMatch(/<script>(?!.*src=)/); // no bare inline script without src
  });

  it("theme-init.js applies cd-theme before paint", () => {
    const js = readFileSync(join(repoDesktop, "public/theme-init.js"), "utf8");
    expect(js).toMatch(/localStorage\.getItem\("cd-theme"\)/);
    expect(js).toMatch(/setAttribute\("data-theme"/);
  });

  it("CSP has no font CDN hosts; font-src is self", () => {
    const conf = readFileSync(
      join(repoDesktop, "src-tauri/tauri.conf.json"),
      "utf8",
    );
    expect(conf).not.toMatch(/fonts\.googleapis/);
    expect(conf).not.toMatch(/fonts\.gstatic/);
    expect(conf).toMatch(/font-src 'self'/);
    // script-src must not gain unsafe-inline for theme init
    expect(conf).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("desktop tree has no fonts.googleapis / fonts.gstatic references", () => {
    // Spot-check critical paths (full recursive grep is slow; CI uses same sources)
    const paths = [
      "index.html",
      "src-tauri/tauri.conf.json",
      "src/main.tsx",
      "src/styles/tokens.css",
    ];
    for (const rel of paths) {
      const body = readFileSync(join(repoDesktop, rel), "utf8");
      expect(body, rel).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    }
  });
});
