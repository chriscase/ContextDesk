/**
 * Focus visibility and target size for the populated main window (#767).
 *
 * The shared focus affordance is a `box-shadow`, which forced-colors mode does
 * not paint and which never matched the tabbable scroll regions. Separately,
 * `--focus-ring` is a *shadow list*, so anywhere it was passed to `outline` the
 * whole declaration was invalid and the element had no focus indicator at all.
 *
 * happy-dom cannot evaluate a `:focus-visible` match, so these assert through
 * the CSSOM (real parsed rules and their resolved declarations) plus a colour
 * validity oracle — not by matching stylesheet source text.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const stylesDir = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(entry) === ".css") out.push(full);
  }
  return out;
}

function mount(...sheets: string[]): CSSStyleSheet {
  const style = document.createElement("style");
  style.textContent = sheets
    .map((f) => readFileSync(join(stylesDir, f), "utf8"))
    .join("\n");
  document.head.appendChild(style);
  document.documentElement.dataset.theme = "dark";
  return document.styleSheets[0]!;
}

/** Flatten style rules, including those nested in media queries. */
function styleRules(sheet: CSSStyleSheet): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) out.push(rule);
      else if (rule instanceof CSSMediaRule) visit(rule.cssRules);
    }
  };
  visit(sheet.cssRules);
  return out;
}

/** Resolve a custom property against the mounted token layer. */
function resolve(token: string): string {
  const probe = document.createElement("div");
  probe.style.setProperty("--probe", `var(${token})`);
  document.body.appendChild(probe);
  return getComputedStyle(probe).getPropertyValue("--probe").trim();
}

/** A value is a usable colour only if the CSS parser accepts it as one. */
function isColour(value: string): boolean {
  const probe = document.createElement("div");
  probe.style.color = value;
  return probe.style.color !== "";
}

/**
 * CSS system colours, which are exactly what a forced-colors rule must use.
 * happy-dom's parser does not know them, so they are swapped for a literal
 * before the shorthand is parsed; the keyword itself is asserted separately.
 */
const SYSTEM_COLOURS = /\b(Highlight|HighlightText|CanvasText|Canvas|LinkText|ButtonText|ButtonBorder|AccentColor)\b/;

/**
 * Read a rule's outline as the longhands production declares them, resolving
 * the colour through the mounted token layer.
 */
function outlineOf(rule: CSSStyleRule): {
  style: string;
  width: number;
  colour: string;
  systemColour: boolean;
} {
  const declared = rule.style.outlineColor;
  const colour = declared.replace(
    /var\(\s*(--[a-z0-9-]+)\s*\)/gi,
    (_all, token: string) => resolve(token),
  );
  return {
    style: rule.style.outlineStyle,
    width: Number.parseFloat(rule.style.outlineWidth || "0"),
    colour,
    systemColour: SYSTEM_COLOURS.test(colour),
  };
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
});

describe("focus visibility", () => {
  it("never paints an outline with a token that is not a colour", () => {
    const all = walk(stylesDir);
    const offenders: string[] = [];
    const OUTLINE_TOKEN =
      /outline(?:-color)?\s*:[^;}]*?var\(\s*(--[a-z0-9-]+)\s*\)/gi;

    mount("tokens.css", "themes/dark.css");
    for (const file of all) {
      // Strip comments first — prose describing a past defect is not a
      // declaration, and matching it would make this test unfixable.
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(OUTLINE_TOKEN)) {
        const token = m[1]!;
        const value = resolve(token);
        if (!isColour(value)) {
          offenders.push(`${file.replace(stylesDir, "")} → ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares a real outline for each tabbable scroll region", () => {
    const sheet = mount(
      "tokens.css",
      "themes/dark.css",
      "base.css",
      "layout.css",
      "components/panes.css",
    );
    const rules = styleRules(sheet);

    for (const className of [
      "chat-scroll",
      "banner__tech",
      "source-view__code",
    ]) {
      const rule = rules.find((r) =>
        r.selectorText
          .split(",")
          .some((s) => s.trim() === `.${className}:focus-visible`),
      );
      expect(rule, `${className} has no :focus-visible rule`).toBeDefined();
      const outline = outlineOf(rule!);
      expect(outline.style, className).toBe("solid");
      expect(outline.width, className).toBeGreaterThan(0);
      expect(isColour(outline.colour), `${className} colour`).toBe(true);
    }
  });

  /**
   * Coverage note: happy-dom does not implement CSS system colours, so it
   * drops `outline-color: Highlight` at parse time. The selector set, outline
   * style, and width below are asserted from the parsed rule; that the colour
   * is a *system* colour is only verifiable in a real engine under Windows
   * High Contrast, and is recorded as an owner residual.
   */
  it("declares a forced-colors outline covering the shared controls", () => {
    // Mount the full cascade, not base.css alone: component rules set
    // `outline: none` beside their box-shadow ring, so a fallback that is not
    // author-important loses to the very rules forced-colors has stripped.
    const sheet = mount(
      "tokens.css",
      "themes/dark.css",
      "base.css",
      "layout.css",
      "components/composer.css",
    );
    const forced: string[] = [];
    for (const rule of Array.from(sheet.cssRules)) {
      if (
        rule instanceof CSSMediaRule &&
        rule.conditionText.includes("forced-colors")
      ) {
        for (const inner of Array.from(rule.cssRules)) {
          if (inner instanceof CSSStyleRule) {
            const outline = outlineOf(inner);
            // A real outline, not the box-shadow ring forced-colors discards.
            expect(outline.style).toBe("solid");
            expect(outline.width).toBeGreaterThan(0);
            // Must out-rank the component `outline: none` rules it competes
            // with, which are more specific than these element selectors.
            // (outline-color is not asserted here: happy-dom discards the
            // system colour, so the property never reaches the CSSOM.)
            expect(inner.style.getPropertyPriority("outline-style")).toBe(
              "important",
            );
            expect(inner.style.getPropertyPriority("outline-width")).toBe(
              "important",
            );
            forced.push(inner.selectorText);
          }
        }
      }
    }

    const selectors = forced.join(" ");
    expect(selectors).not.toBe("");
    for (const control of ["button", "textarea", "input", "select"]) {
      expect(selectors, control).toContain(`${control}:focus-visible`);
    }
    // Anything given an explicit tabindex — pane tabs at -1, the transcript,
    // the sidebar separator — is covered too.
    expect(selectors).toContain("[tabindex]:focus-visible");
  });
});

describe("target size", () => {
  /**
   * Mount in main.tsx import order. A bare body-level button is not enough:
   * `.banner .btn` and `.todo-row__remove` each re-imposed a 22px floor that
   * out-specified `.btn--sm`, and layout.css carried a stale duplicate
   * `.btn--sm` whose 22px won or lost purely on import order.
   */
  function mountCascade() {
    return mount(
      "tokens.css",
      "themes/dark.css",
      "base.css",
      "layout.css",
      "components/panes.css",
      "components/composer.css",
    );
  }

  function probe(html: string, selector: string): CSSStyleDeclaration {
    document.body.innerHTML = html;
    return getComputedStyle(document.querySelector<HTMLElement>(selector)!);
  }

  it.each([
    [
      "bare shared small button",
      `<button class="btn btn--ghost btn--sm">Show all</button>`,
      ".btn--sm",
    ],
    [
      "small button inside an error banner",
      `<div class="banner"><div class="banner__actions"><button class="btn btn--ghost btn--sm">Dismiss</button></div></div>`,
      ".banner .btn",
    ],
    [
      "todo row remove control",
      `<div class="todo-row"><button class="todo-row__remove">×</button></div>`,
      ".todo-row__remove",
    ],
  ])("keeps the %s at or above a 24px minimum box", (_label, html, selector) => {
    mountCascade();
    const style = probe(html, selector);
    expect(Number.parseFloat(style.minHeight)).toBeGreaterThanOrEqual(24);
  });

  it("leaves exactly one .btn--sm floor in the cascade", () => {
    const sheet = mountCascade();
    const floors = styleRules(sheet)
      .filter((r) =>
        r.selectorText.split(",").some((s) => s.trim() === ".btn--sm"),
      )
      .map((r) => r.style.minHeight)
      .filter(Boolean);

    // A duplicate block is how the floor silently regressed before.
    expect(floors).toEqual(["24px"]);
  });
});
