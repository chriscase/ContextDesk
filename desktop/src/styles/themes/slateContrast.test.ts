/**
 * Slate theme AA contrast (#253) — pure math on CSS token hex values.
 * Mirrors the #150 dark/light floor: body-text colors ≥ 4.5:1 on app/panel.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const slateCss = readFileSync(join(here, "slate.css"), "utf8");

function tokenHex(name: string): string {
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`);
  const m = slateCss.match(re);
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

/** WCAG 2 contrast ratio. */
export function contrastRatio(fg: string, bg: string): number {
  const L1 = lum(hexToRgb(fg));
  const L2 = lum(hexToRgb(bg));
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("slate theme AA (#253)", () => {
  it("--text-faint ≥ 4.5:1 on --bg-app and --bg-panel", () => {
    const faint = tokenHex("text-faint");
    const app = tokenHex("bg-app");
    const panel = tokenHex("bg-panel");
    const onApp = contrastRatio(faint, app);
    const onPanel = contrastRatio(faint, panel);
    // Paste-friendly ratios for close-proof
    // eslint-disable-next-line no-console
    console.log(
      `slate --text-faint ${faint} on app ${app} = ${onApp.toFixed(2)}:1; on panel ${panel} = ${onPanel.toFixed(2)}:1`,
    );
    expect(onApp).toBeGreaterThanOrEqual(4.5);
    expect(onPanel).toBeGreaterThanOrEqual(4.5);
  });

  it("status and accent colors used as text ≥ 4.5:1 on app", () => {
    const app = tokenHex("bg-app");
    for (const name of ["success", "warning", "danger", "accent"] as const) {
      const fg = tokenHex(name);
      const r = contrastRatio(fg, app);
      // eslint-disable-next-line no-console
      console.log(`slate --${name} ${fg} on app = ${r.toFixed(2)}:1`);
      expect(r, name).toBeGreaterThanOrEqual(4.5);
    }
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
