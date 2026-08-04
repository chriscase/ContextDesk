import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function cssImports(source: string): string[] {
  return [...source.matchAll(/^import\s+["']([^"']+\.css)["'];/gm)].map(
    ([, specifier]) =>
      specifier!
        .replace(/^\.\/|^\.\.\/\.\.\/src\//, "")
        .replaceAll("\\", "/"),
  );
}

describe("visual harness stylesheet parity", () => {
  it("loads the exact production CSS chain in production order", () => {
    const production = cssImports(
      readFileSync(join(desktopRoot, "src/main.tsx"), "utf8"),
    );
    const visual = cssImports(
      readFileSync(join(desktopRoot, "visual/support/styles.ts"), "utf8"),
    );

    expect(production.length).toBeGreaterThan(0);
    expect(new Set(production).size).toBe(production.length);
    expect(new Set(visual).size).toBe(visual.length);
    expect(visual).toEqual(production);
  });
});
