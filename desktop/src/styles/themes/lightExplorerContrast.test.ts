import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const lightCss = readFileSync(join(here, "light.css"), "utf8");
const tokensCss = readFileSync(join(here, "../tokens.css"), "utf8");

function tokenHex(name: string): string {
  const match = lightCss.match(
    new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`),
  );
  if (!match) throw new Error(`missing light token --${name}`);
  return match[1]!.toLowerCase();
}

function aliasTarget(name: string): string {
  const match = tokensCss.match(
    new RegExp(`--${name}:\\s*var\\(--([a-z-]+)\\)`),
  );
  if (!match) throw new Error(`missing semantic alias --${name}`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  );
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe("Log Explorer Light-theme contrast", () => {
  it("maps legacy Explorer text names to current semantic tokens", () => {
    expect(aliasTarget("fg")).toBe("text");
    expect(aliasTarget("fg-default")).toBe("text");
    expect(aliasTarget("fg-primary")).toBe("text");
    expect(aliasTarget("fg-muted")).toBe("text-muted");
    expect(aliasTarget("text-secondary")).toBe("text-muted");
    expect(aliasTarget("border-subtle")).toBe("border");
  });

  it("keeps primary and secondary Explorer text AA-readable", () => {
    const backgrounds = [tokenHex("bg-app"), tokenHex("bg-panel")];
    for (const textToken of ["text", "text-muted", "text-faint"]) {
      for (const background of backgrounds) {
        expect(
          contrast(tokenHex(textToken), background),
          `${textToken} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
