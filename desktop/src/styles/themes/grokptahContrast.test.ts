/**
 * GrokPtah theme AA contrast — pure math on CSS token hex values.
 * Mirrors the #150 dark/light floor: body-text colors ≥ 4.5:1 on app/panel.
 * Also asserts the gold accent and the warning status color are perceptibly
 * distinct hues, per the "clear success/warn/error/tool states" requirement —
 * a graphite-and-gold palette makes it easy to let warning drift back toward
 * the accent gold, which would make interactive and status color read as the
 * same signal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const grokptahCss = readFileSync(join(here, "grokptah.css"), "utf8");

function tokenHex(name: string): string {
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`);
  const m = grokptahCss.match(re);
  if (!m) throw new Error(`missing token --${name}`);
  return m[1]!.toLowerCase();
}

function hexToRgb(h: string): [number, number, number] {
  const x = h.replace("#", "");
  return [
    parseInt(x.slice(0, 2), 16) / 255,
    parseInt(x.slice(2, 4), 16) / 255,
    parseInt(x.slice(4, 6), 16) / 255,
  ];
}

function lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function lum(rgb: [number, number, number]): number {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = lum(hexToRgb(fg));
  const L2 = lum(hexToRgb(bg));
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Hue in degrees [0, 360) from an sRGB hex color. */
function hue(h: string): number {
  const [r, g, b] = hexToRgb(h);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let deg: number;
  if (max === r) deg = ((g - b) / d) % 6;
  else if (max === g) deg = (b - r) / d + 2;
  else deg = (r - g) / d + 4;
  deg *= 60;
  return deg < 0 ? deg + 360 : deg;
}

describe("GrokPtah theme AA", () => {
  it("--text-faint >= 4.5:1 on --bg-app and --bg-panel", () => {
    const faint = tokenHex("text-faint");
    const app = tokenHex("bg-app");
    const panel = tokenHex("bg-panel");
    const onApp = contrastRatio(faint, app);
    const onPanel = contrastRatio(faint, panel);
    // Paste-friendly ratios for close-proof
    console.log(
      `grokptah --text-faint ${faint} on app ${app} = ${onApp.toFixed(2)}:1; on panel ${panel} = ${onPanel.toFixed(2)}:1`,
    );
    expect(onApp).toBeGreaterThanOrEqual(4.5);
    expect(onPanel).toBeGreaterThanOrEqual(4.5);
  });

  it("--text >= 4.5:1 on --bg-app and --bg-panel", () => {
    const text = tokenHex("text");
    expect(contrastRatio(text, tokenHex("bg-app"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(text, tokenHex("bg-panel"))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("status and accent colors used as text >= 4.5:1 on app", () => {
    const app = tokenHex("bg-app");
    for (const name of ["success", "warning", "danger", "accent"] as const) {
      const fg = tokenHex(name);
      const r = contrastRatio(fg, app);
      console.log(`grokptah --${name} ${fg} on app = ${r.toFixed(2)}:1`);
      expect(r, name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--accent-on >= 4.5:1 on solid --accent (button label legibility)", () => {
    const accentOn = tokenHex("accent-on");
    const accent = tokenHex("accent");
    expect(contrastRatio(accentOn, accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("--warning is a perceptibly different hue from --accent, not a restated gold", () => {
    const accentHue = hue(tokenHex("accent"));
    const warningHue = hue(tokenHex("warning"));
    const diff = Math.abs(accentHue - warningHue);
    const wrapped = Math.min(diff, 360 - diff);
    expect(wrapped).toBeGreaterThanOrEqual(10);
  });

  it("success, warning, danger, and accent are four distinct colors", () => {
    const values = new Set(
      (["success", "warning", "danger", "accent"] as const).map(tokenHex),
    );
    expect(values.size).toBe(4);
  });

  it("no msg__meta opacity compounding on faint text in chat.css", () => {
    // #150 style audit: .msg__meta must not lower faint below AA via opacity.
    const chat = readFileSync(join(here, "../components/chat.css"), "utf8");
    const metaBlock = chat.match(/\.msg__meta\s*\{[^}]+\}/);
    if (metaBlock) {
      expect(metaBlock[0]).not.toMatch(/opacity\s*:/);
    }
  });
});
