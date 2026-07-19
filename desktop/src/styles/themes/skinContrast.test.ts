/**
 * AA contrast for every registered skin (#300 / #253).
 * --text-faint and status/accent used as text ≥ 4.5:1 on --bg-app / --bg-panel.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skinIdList, skinMeta } from "../../lib/skins";

const here = dirname(fileURLToPath(import.meta.url));

function tokenHex(css: string, name: string): string {
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`);
  const m = css.match(re);
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

describe("skin AA contrast (#300)", () => {
  for (const id of skinIdList()) {
    describe(id, () => {
      const css = readFileSync(join(here, `${id}.css`), "utf8");

      it("--text-faint ≥ 4.5:1 on --bg-app and --bg-panel", () => {
        const faint = tokenHex(css, "text-faint");
        const app = tokenHex(css, "bg-app");
        const panel = tokenHex(css, "bg-panel");
        expect(contrastRatio(faint, app), "on app").toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(faint, panel), "on panel").toBeGreaterThanOrEqual(
          4.5,
        );
      });

      it("status and link/accent as text ≥ 4.5:1 on app", () => {
        const app = tokenHex(css, "bg-app");
        // Light skins may keep a softer --accent for buttons; body links use --link (#150).
        const accentish =
          skinMeta(id).colorScheme === "light" ? "link" : "accent";
        for (const name of ["success", "warning", "danger", accentish] as const) {
          const fg = tokenHex(css, name);
          expect(contrastRatio(fg, app), name).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }
});
