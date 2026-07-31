/**
 * AA contrast for the first-chat product home (#539).
 *
 * `skinContrast.test.ts` covers text on --bg-app and --bg-panel. The first-chat
 * action cards sit on --bg-elevated, which is a different surface and was not
 * covered: the card description used --text-faint (4.13-4.40:1 in slate, dark,
 * and light) and the card kind label resolved through an --accent-text token
 * that no theme defined, silently falling back to --accent (3.99:1 in light).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skinIdList } from "../../lib/skins";

const here = dirname(fileURLToPath(import.meta.url));
const chatCss = readFileSync(
  join(here, "..", "components", "chat.css"),
  "utf8",
);

function tokenHex(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`missing token --${name}`);
  return match[1]!.toLowerCase();
}

function lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function lum(hex: string): number {
  const x = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
  return 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
}

function contrastRatio(fg: string, bg: string): number {
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("first-chat home AA contrast (#539)", () => {
  for (const id of skinIdList()) {
    describe(id, () => {
      const css = readFileSync(join(here, `${id}.css`), "utf8");

      it("defines --accent-text rather than relying on a silent fallback", () => {
        // The card kind label reads var(--accent-text, var(--accent)). An
        // undefined token means every theme silently used --accent.
        expect(() => tokenHex(css, "accent-text")).not.toThrow();
      });

      it("card kind label ≥ 4.5:1 on --bg-elevated", () => {
        const elevated = tokenHex(css, "bg-elevated");
        const accentText = tokenHex(css, "accent-text");
        expect(contrastRatio(accentText, elevated)).toBeGreaterThanOrEqual(4.5);
      });

      it("card description colour ≥ 4.5:1 on --bg-elevated", () => {
        const elevated = tokenHex(css, "bg-elevated");
        const muted = tokenHex(css, "text-muted");
        expect(contrastRatio(muted, elevated)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("card description uses the token the contrast check verifies", () => {
    // Guards the pairing: raising --text-muted contrast is meaningless if the
    // rule quietly goes back to --text-faint.
    // Whitespace-insensitive: Prettier may wrap the selector across lines.
    const rule = chatCss.match(
      /\.chat-action-card\s*>\s*span:not\(\.chat-action-card__kind\):not\(\.chat-starter__label\)\s*\{[^}]*\}/,
    );
    expect(rule, "first-chat card description rule not found").toBeTruthy();
    expect(rule![0]).toContain("var(--text-muted)");
    expect(rule![0]).not.toContain("var(--text-faint)");
  });

  it("card kind label still resolves through --accent-text", () => {
    const rule = chatCss.match(/\.chat-action-card__kind\s*\{[^}]*\}/);
    expect(rule, "first-chat card kind rule not found").toBeTruthy();
    expect(rule![0]).toContain("--accent-text");
  });
});
