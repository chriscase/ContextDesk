/**
 * Every design token referenced without a fallback must actually resolve.
 *
 * An undefined custom property makes the whole declaration invalid at
 * computed-value time, so the property silently falls back to its inherited or
 * initial value. That is how Handbook `h2` came to render smaller than `h3`
 * and how the theme gallery popover lost its elevation shadow entirely (#767).
 * Nothing warns; the CSS just quietly does something else.
 *
 * This resolves each reference through a real stylesheet rather than matching
 * source text, so it fails the moment a token is referenced but never defined.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(stylesDir);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(entry))) out.push(full);
  }
  return out;
}

const cssFiles = walk(stylesDir, [".css"]);
const scriptFiles = walk(srcDir, [".ts", ".tsx"]);

/** `var(--x)` with no comma, i.e. no fallback to fall back to. */
const NO_FALLBACK = /var\(\s*(--[a-z0-9-]+)\s*\)/gi;
const DECLARATION = /(--[a-z0-9-]+)\s*:/gi;
/** Tokens written from JS, e.g. el.style.setProperty("--metric-cursor", …). */
const JS_DECLARATION = /setProperty\(\s*["'](--[a-z0-9-]+)["']/gi;

function matchAll(sources: string[], re: RegExp): Set<string> {
  const found = new Set<string>();
  for (const text of sources) {
    for (const m of text.matchAll(re)) found.add(m[1]!.toLowerCase());
  }
  return found;
}

const cssText = cssFiles.map((f) => readFileSync(f, "utf8"));
const scriptText = scriptFiles.map((f) => readFileSync(f, "utf8"));

const declared = new Set([
  ...matchAll(cssText, DECLARATION),
  ...matchAll(scriptText, JS_DECLARATION),
]);
const referenced = matchAll(cssText, NO_FALLBACK);

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
});

/**
 * Load the global token layer plus one theme, then resolve `token`.
 * Theme files are scoped to `html[data-theme="…"]`, so the attribute has to be
 * set or every theme-owned token would resolve empty and the test would be
 * measuring its own harness instead of the stylesheets.
 */
function resolveToken(token: string, theme: string): string {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync(join(stylesDir, "tokens.css"), "utf8"),
    readFileSync(join(stylesDir, "themes", theme), "utf8"),
  ].join("\n");
  document.head.appendChild(style);
  document.documentElement.dataset.theme = theme.replace(/\.css$/, "");

  const probe = document.createElement("div");
  probe.style.setProperty("--probe", `var(${token})`);
  document.body.appendChild(probe);
  return getComputedStyle(probe).getPropertyValue("--probe").trim();
}

describe("design token resolution", () => {
  it("declares every custom property the stylesheets reference without a fallback", () => {
    const missing = [...referenced].filter((t) => !declared.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it.each(["dark.css", "light.css", "slate.css", "sand.css", "forest.css"])(
    "resolves the display and elevation tokens in %s",
    (theme) => {
      for (const token of ["--text-xl", "--shadow-lg", "--surface-raised"]) {
        const value = resolveToken(token, theme);
        expect(value, `${token} in ${theme}`).not.toBe("");
      }
    },
  );

  it("paints an elevation shadow on the theme gallery popover", () => {
    const style = document.createElement("style");
    style.textContent = [
      readFileSync(join(stylesDir, "tokens.css"), "utf8"),
      readFileSync(join(stylesDir, "themes", "dark.css"), "utf8"),
      readFileSync(join(stylesDir, "components", "theme-picker.css"), "utf8"),
    ].join("\n");
    document.head.appendChild(style);

    const popover = document.createElement("div");
    popover.className = "theme-picker__popover";
    document.body.appendChild(popover);

    const shadow = getComputedStyle(popover).boxShadow;
    expect(shadow).not.toBe("");
    expect(shadow).not.toBe("none");
  });

  it("gives Handbook headings a monotonic scale instead of inheriting body size", () => {
    const style = document.createElement("style");
    style.textContent = [
      readFileSync(join(stylesDir, "tokens.css"), "utf8"),
      readFileSync(join(stylesDir, "themes", "dark.css"), "utf8"),
    ].join("\n");
    document.head.appendChild(style);

    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const px = (token: string) => {
      probe.style.fontSize = `var(${token})`;
      return Number.parseFloat(getComputedStyle(probe).fontSize);
    };

    // h2 resolves --text-xl as its clamp floor, h3 --text-lg, h4 --text-md.
    // While --text-xl was undefined the h2 declaration was dropped entirely and
    // h2 inherited body size, landing *below* h3.
    const xl = px("--text-xl");
    const lg = px("--text-lg");
    const md = px("--text-md");
    expect(xl).toBeGreaterThan(lg);
    expect(lg).toBeGreaterThan(md);
  });
});
