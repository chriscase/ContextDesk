/**
 * Focused GrokPtah skin tests: registration, token completeness, theme
 * initialization (pre-paint + runtime bridge), and persistence.
 *
 * Contrast/legibility for GrokPtah lives in
 * `../styles/themes/grokptahContrast.test.ts`; the generic per-skin
 * registration/contrast checks in `./skins.test.ts` and
 * `../styles/themes/skinContrast.test.ts` already cover every registered
 * skin including this one — these tests instead pin GrokPtah-specific
 * expectations so a future edit to this skin (or the registry) fails loudly
 * here first.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SKIN, isSkinId, parseSkinId, SKINS, skinMeta } from "./skins";
import { applyThemeToDocument, THEME_STORAGE_KEY } from "./themeBridge";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../..");

// The full required token contract from docs/SKINS.md, not just the reduced
// subset `skins.test.ts` checks for every skin generically.
const REQUIRED_TOKENS = [
  "bg-app",
  "bg-panel",
  "bg-elevated",
  "bg-input",
  "bg-hover",
  "border",
  "border-soft",
  "border-strong",
  "text",
  "text-muted",
  "text-faint",
  "accent",
  "accent-strong",
  "accent-soft",
  "accent-on",
  "link",
  "success",
  "warning",
  "danger",
  "tool-bg",
  "chat-user-bg",
  "chat-assistant-bg",
  "surface-deep",
  "surface-chrome",
  "surface-chip",
  "status-bar-bg",
  "overlay-scrim",
  "overlay-soft",
  "overlay-faint",
  "focus-ring",
  "shadow-sm",
  "shadow-md",
  "shadow-inset",
  "composer-shadow",
  "composer-shadow-focus",
  "btn-inset",
];

describe("GrokPtah skin registration", () => {
  it("is registered in SKINS with the expected metadata", () => {
    expect(isSkinId("grokptah")).toBe(true);
    const meta = skinMeta("grokptah");
    expect(meta.id).toBe("grokptah");
    expect(meta.label).toBe("GrokPtah");
    expect(meta.colorScheme).toBe("dark");
    expect(SKINS.some((s) => s.id === "grokptah")).toBe(true);
  });

  it("card-preview swatches mirror the theme CSS graphite/gold palette", () => {
    const { swatches } = skinMeta("grokptah");
    expect(swatches.app).toBe("#0b0c0e");
    expect(swatches.panel).toBe("#12141a");
    expect(swatches.elevated).toBe("#181b22");
    expect(swatches.accent).toBe("#f0b429");
  });

  it("does not change the existing default skin", () => {
    expect(DEFAULT_SKIN).toBe("dark");
    expect(parseSkinId(null)).toBe("dark");
    expect(parseSkinId(undefined)).toBe("dark");
  });
});

describe("GrokPtah token completeness", () => {
  const cssPath = join(desktopRoot, "src/styles/themes/grokptah.css");

  it("theme file exists and is scoped to html[data-theme=\"grokptah\"]", () => {
    expect(existsSync(cssPath)).toBe(true);
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/html\[data-theme=["']grokptah["']\]/);
    expect(css).toMatch(/color-scheme:\s*dark/);
  });

  it("defines every required semantic token from docs/SKINS.md", () => {
    const css = readFileSync(cssPath, "utf8");
    const missing = REQUIRED_TOKENS.filter(
      (token) => !new RegExp(`--${token}\\s*:`).test(css),
    );
    expect(missing).toEqual([]);
  });
});

describe("GrokPtah theme initialization", () => {
  it("is in the pre-paint allow-list (public/theme-init.js)", () => {
    const js = readFileSync(join(desktopRoot, "public/theme-init.js"), "utf8");
    expect(js).toMatch(/grokptah\s*:\s*1/);
    // Not in the LIGHT map — GrokPtah is a dark skin and must not force a
    // light background flash before the stylesheet loads.
    const lightMapMatch = js.match(/var LIGHT = \{([^}]*)\};/);
    expect(lightMapMatch).not.toBeNull();
    expect(lightMapMatch![1]).not.toMatch(/grokptah/);
  });

  it("is imported by main.tsx", () => {
    const main = readFileSync(join(desktopRoot, "src/main.tsx"), "utf8");
    expect(main).toMatch(/styles\/themes\/grokptah\.css/);
  });

  it("applyThemeToDocument accepts it and sets the data-theme attribute", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(applyThemeToDocument("grokptah")).toBe("grokptah");
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "grokptah",
    );
    vi.unstubAllGlobals();
  });
});

describe("GrokPtah persistence", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it("round-trips through localStorage the same way every skin does", () => {
    expect(applyThemeToDocument("grokptah")).toBe("grokptah");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("grokptah");

    // Simulate app restart: read the persisted value back the way
    // useShellState's loadTheme()/parseSkinId() does on mount.
    const persisted = localStorage.getItem(THEME_STORAGE_KEY);
    expect(parseSkinId(persisted)).toBe("grokptah");
  });

  it("a corrupted/unregistered stored value never resolves to grokptah by accident", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "grokptah-typo");
    expect(parseSkinId(localStorage.getItem(THEME_STORAGE_KEY))).toBe("dark");
  });
});
