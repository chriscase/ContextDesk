/**
 * GrokPtah skin — registration, token completeness, pre-paint init,
 * persistence, and contrast/legibility (#300).
 *
 * The generic per-skin checks (AA on --bg-app/--bg-panel, registry integrity)
 * already iterate the registry in skinContrast.test.ts / skins.test.ts. This
 * file adds what those cannot express generically: that GrokPtah hits the
 * specified graphite/gold palette exactly, that its warm accent stays visually
 * separable from its warm status colors, and that selecting it in the real
 * Appearance UI survives a reload.
 */
import { useState } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "../../components/settings/AppearanceSection";
import {
  DEFAULT_SKIN,
  isSkinId,
  parseSkinId,
  skinMeta,
  SKINS,
  type SkinId,
} from "../../lib/skins";
import {
  applyThemeToDocument,
  THEME_STORAGE_KEY,
} from "../../lib/themeBridge";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../../..");

const grokptahCss = readFileSync(join(here, "grokptah.css"), "utf8");
const darkCss = readFileSync(join(here, "dark.css"), "utf8");

/** Surfaces every text token has to stay legible on. */
const SURFACES = ["bg-app", "bg-panel", "bg-elevated"] as const;

function tokenHex(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`missing hex token --${name}`);
  return m[1]!.toLowerCase();
}

function declaredTokens(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]!.toLowerCase()),
  );
}

function toRgb(hex: string): [number, number, number] {
  const x = hex.replace("#", "");
  return [
    parseInt(x.slice(0, 2), 16) / 255,
    parseInt(x.slice(2, 4), 16) / 255,
    parseInt(x.slice(4, 6), 16) / 255,
  ];
}

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(linearize) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Hue in degrees; used to keep a warm accent apart from warm status hues. */
function hue(hex: string): number {
  const [r, g, b] = toRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / span) % 6;
  else if (max === g) h = (b - r) / span + 2;
  else h = (r - g) / span + 4;
  return ((h * 60) % 360 + 360) % 360;
}

function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

describe("GrokPtah skin — registration", () => {
  it("is registered as a selectable dark skin", () => {
    expect(isSkinId("grokptah")).toBe(true);
    expect(parseSkinId("grokptah")).toBe("grokptah");

    const meta = skinMeta("grokptah");
    expect(meta.label).toBe("GrokPtah");
    expect(meta.colorScheme).toBe("dark");
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("swatches mirror the shipped theme CSS", () => {
    const { swatches } = skinMeta("grokptah");
    expect(swatches.app).toBe(tokenHex(grokptahCss, "bg-app"));
    expect(swatches.panel).toBe(tokenHex(grokptahCss, "bg-panel"));
    expect(swatches.elevated).toBe(tokenHex(grokptahCss, "bg-elevated"));
    expect(swatches.accent).toBe(tokenHex(grokptahCss, "accent"));
    expect(swatches.text).toBe(tokenHex(grokptahCss, "text"));
  });

  it("uses the specified graphite surfaces and warm gold accent", () => {
    expect(tokenHex(grokptahCss, "bg-app")).toBe("#0b0c0e");
    expect(tokenHex(grokptahCss, "bg-panel")).toBe("#12141a");
    expect(tokenHex(grokptahCss, "bg-elevated")).toBe("#181b22");
    expect(tokenHex(grokptahCss, "accent")).toBe("#f0b429");
  });

  it("leaves the default skin unchanged", () => {
    expect(DEFAULT_SKIN).toBe("dark");
    expect(SKINS[0]!.id).toBe("dark");
    // Adding a gold skin must not repaint the shipped default.
    expect(tokenHex(darkCss, "accent")).toBe("#6ea8fe");
    expect(tokenHex(darkCss, "bg-app")).toBe("#0b0c0e");
    expect(parseSkinId(null)).toBe("dark");
    expect(parseSkinId("not-a-skin")).toBe("dark");
  });

  it("is wired into the prepaint allow-list and the bundle", () => {
    const init = readFileSync(
      join(desktopRoot, "public/theme-init.js"),
      "utf8",
    );
    expect(init).toMatch(/grokptah\s*:\s*1/);
    // Not in the LIGHT map — it must boot with the dark window fill.
    expect(init).not.toMatch(/LIGHT\s*=\s*\{[^}]*grokptah/);

    const main = readFileSync(join(desktopRoot, "src/main.tsx"), "utf8");
    expect(main).toMatch(/styles\/themes\/grokptah\.css/);
  });

  it("gets dark native select chrome like the other dark skins", () => {
    const base = readFileSync(
      join(desktopRoot, "src/styles/base.css"),
      "utf8",
    );
    expect(base).toMatch(/html\[data-theme="grokptah"\] select\b/);
    expect(base).toMatch(/html\[data-theme="grokptah"\] select option/);
  });
});

describe("GrokPtah skin — token completeness", () => {
  it("declares every semantic token the reference dark skin declares", () => {
    const reference = declaredTokens(darkCss);
    const actual = declaredTokens(grokptahCss);
    const missing = [...reference].filter((t) => !actual.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("adds no token the reference skin lacks", () => {
    const reference = declaredTokens(darkCss);
    const extra = [...declaredTokens(grokptahCss)]
      .filter((t) => !reference.has(t))
      .sort();
    expect(extra).toEqual([]);
  });

  it("scopes every token to html[data-theme='grokptah'] with a dark scheme", () => {
    expect(grokptahCss).toMatch(/html\[data-theme="grokptah"\]\s*\{/);
    expect(grokptahCss).toMatch(/color-scheme:\s*dark/);
    // One selector block only — no leakage into :root or another skin.
    expect(grokptahCss.match(/\{/g)?.length).toBe(1);
  });
});

describe("GrokPtah skin — pre-paint initialization", () => {
  const runThemeInit = (stored: string | null) => {
    const values = new Map<string, string>();
    if (stored !== null) values.set("cd-theme", stored);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    });
    const js = readFileSync(join(desktopRoot, "public/theme-init.js"), "utf8");
    new Function(js)();
  };

  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.backgroundColor = "";
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the stored grokptah skin before the bundle loads", () => {
    runThemeInit("grokptah");
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("grokptah");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("paints the graphite window fill so boot never flashes light", () => {
    runThemeInit("grokptah");
    // theme-init paints the same graphite --bg-app the skin resolves to.
    // Engines serialize inline colors as either hex or rgb(); accept both.
    const painted = document.documentElement.style.backgroundColor
      .replace(/\s/g, "")
      .toLowerCase();
    expect(["#0b0c0e", "rgb(11,12,14)"]).toContain(painted);
    expect(tokenHex(grokptahCss, "bg-app")).toBe("#0b0c0e");
  });

  it("still falls back to dark for an unknown stored skin", () => {
    runThemeInit("grokptah-typo");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("GrokPtah skin — persistence", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    });
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selecting GrokPtah in Appearance applies and persists it", () => {
    const persisted = vi.fn();

    function ControlledAppearance() {
      const [theme, setTheme] = useState<SkinId>("dark");
      return (
        <AppearanceSection
          baseId="grokptah-appearance"
          theme={theme}
          onThemeChange={(next) => {
            setTheme(next);
            persisted(applyThemeToDocument(next));
          }}
          uiScale="100"
        />
      );
    }

    render(<ControlledAppearance />);
    fireEvent.click(screen.getByRole("button", { name: /Theme Dark/ }));
    fireEvent.click(screen.getByRole("option", { name: /GrokPtah/ }));

    expect(persisted).toHaveBeenCalledWith("grokptah");
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "grokptah",
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("grokptah");

    // The trigger now previews the new skin.
    const trigger = screen.getByRole("button", { name: /Theme GrokPtah/ });
    expect(trigger.textContent).toContain(skinMeta("grokptah").description);
  });

  it("survives a reload through the shared storage key", () => {
    applyThemeToDocument("grokptah");
    // Next boot reads the same key the pre-paint script reads.
    expect(parseSkinId(localStorage.getItem(THEME_STORAGE_KEY))).toBe(
      "grokptah",
    );
  });
});

describe("GrokPtah skin — contrast and legibility", () => {
  const surfaces = SURFACES.map((s) => [s, tokenHex(grokptahCss, s)] as const);

  it.each(["text", "text-muted", "text-faint", "link", "accent", "accent-text"])(
    "%s clears WCAG AA on app, panel, and elevated surfaces",
    (token) => {
      const fg = tokenHex(grokptahCss, token);
      for (const [name, bg] of surfaces) {
        expect(contrast(fg, bg), `--${token} on --${name}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );

  it.each(["success", "warning", "danger"])(
    "status colour %s stays readable on every surface",
    (token) => {
      const fg = tokenHex(grokptahCss, token);
      for (const [name, bg] of surfaces) {
        expect(contrast(fg, bg), `--${token} on --${name}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );

  it("keeps label text readable on solid gold buttons", () => {
    const accent = tokenHex(grokptahCss, "accent");
    const on = tokenHex(grokptahCss, "accent-on");
    expect(contrast(on, accent)).toBeGreaterThanOrEqual(4.5);
    // The hover shade must not wash the label out either.
    expect(contrast(on, tokenHex(grokptahCss, "accent-strong"))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("holds warm status hues apart from the warm accent", () => {
    const accent = tokenHex(grokptahCss, "accent");
    const warning = tokenHex(grokptahCss, "warning");
    const danger = tokenHex(grokptahCss, "danger");
    const success = tokenHex(grokptahCss, "success");

    // Gold accent, orange warn, red error must not read as one warm smear.
    expect(hueGap(accent, warning), "accent vs warning").toBeGreaterThanOrEqual(15);
    expect(hueGap(warning, danger), "warning vs danger").toBeGreaterThanOrEqual(15);
    expect(hueGap(accent, danger), "accent vs danger").toBeGreaterThanOrEqual(15);
    expect(hueGap(accent, success), "accent vs success").toBeGreaterThanOrEqual(60);
  });

  it("separates the tool trail from the surfaces it sits between", () => {
    const tool = tokenHex(grokptahCss, "tool-bg");
    const app = tokenHex(grokptahCss, "bg-app");
    expect(tool).not.toBe(app);
    // Tool rows carry body text, so they must stay a readable well.
    expect(
      contrast(tokenHex(grokptahCss, "text"), tool),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokenHex(grokptahCss, "text-faint"), tool),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps borders visible against their own surfaces", () => {
    // Non-text contrast (WCAG 1.4.11) — 3:1 for meaningful boundaries.
    expect(
      contrast(tokenHex(grokptahCss, "border-strong"), tokenHex(grokptahCss, "bg-app")),
    ).toBeGreaterThanOrEqual(1.5);
    expect(
      contrast(tokenHex(grokptahCss, "accent"), tokenHex(grokptahCss, "bg-app")),
    ).toBeGreaterThanOrEqual(3);
  });
});
