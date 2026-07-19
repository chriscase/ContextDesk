/**
 * Skin registry integrity (#300 / #54).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKIN,
  isSkinId,
  nextSkinId,
  parseSkinId,
  skinIdList,
  SKINS,
} from "./skins";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../..");

describe("skin registry (#300 / #54)", () => {
  it("has unique ids and includes dark/light/slate", () => {
    const ids = skinIdList();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("dark");
    expect(ids).toContain("light");
    expect(ids).toContain("slate");
    expect(DEFAULT_SKIN).toBe("dark");
  });

  it("parseSkinId falls back to dark for unknown", () => {
    expect(parseSkinId("light")).toBe("light");
    expect(parseSkinId("slate")).toBe("slate");
    expect(parseSkinId("nope")).toBe("dark");
    expect(parseSkinId(null)).toBe("dark");
    expect(isSkinId("slate")).toBe(true);
    expect(isSkinId("ember")).toBe(false);
  });

  it("nextSkinId cycles registry order", () => {
    const first = SKINS[0]!.id;
    let cur = first;
    const seen = new Set<string>();
    for (let i = 0; i < SKINS.length; i++) {
      seen.add(cur);
      cur = nextSkinId(cur);
    }
    expect(seen.size).toBe(SKINS.length);
    expect(cur).toBe(first);
  });

  it("each skin has a theme CSS file imported path exists", () => {
    for (const s of SKINS) {
      const path = join(desktopRoot, "src/styles/themes", `${s.id}.css`);
      expect(existsSync(path), path).toBe(true);
      const css = readFileSync(path, "utf8");
      expect(css).toMatch(
        new RegExp(`html\\[data-theme=["']${s.id}["']\\]`),
      );
      expect(css).toMatch(/color-scheme:\s*(dark|light)/);
      for (const token of [
        "bg-app",
        "bg-panel",
        "text",
        "text-faint",
        "accent",
        "accent-on",
        "link",
        "border",
        "focus-ring",
      ]) {
        expect(css, `${s.id} --${token}`).toMatch(
          new RegExp(`--${token}\\s*:`),
        );
      }
    }
  });

  it("theme-init.js allow-list includes every registered skin", () => {
    const js = readFileSync(join(desktopRoot, "public/theme-init.js"), "utf8");
    for (const id of skinIdList()) {
      expect(js, id).toMatch(new RegExp(`${id}\\s*:\\s*1`));
    }
    expect(js).toMatch(/localStorage\.getItem\("cd-theme"\)/);
  });

  it("main.tsx imports every theme CSS", () => {
    const main = readFileSync(join(desktopRoot, "src/main.tsx"), "utf8");
    for (const id of skinIdList()) {
      expect(main).toMatch(
        new RegExp(`styles/themes/${id}\\.css`),
      );
    }
  });
});
