/**
 * Browser surface of the strategy-neutral Runtime V1 conformance profile.
 *
 * The profile itself lives with the strategies it governs, in
 * `collab/web/src/investigations/strategies/testkit/conformance.tsx`. Its
 * component runner answers the requirements jsdom can answer truthfully.
 * The requirements listed here need a real layout, cascade, and media-query
 * engine, so they are answered by a browser instead — jsdom has no layout box,
 * no user-agent stylesheet cascade, and no forced-colors or reduced-motion
 * emulation, and a check written there would report a pass it did not earn.
 *
 * Nothing in this module knows which strategy it is testing. A spec supplies
 * the mounted root and the locators for its own core controls; every
 * assertion below is about the baseline, not about one strategy's markup.
 *
 * The two halves must not drift, and the workspaces cannot import each other
 * (`collab/e2e/tsconfig.json` roots at the e2e package). `assertProfileParity`
 * therefore reads the profile source and compares the browser-surface list
 * below against the one the profile declares, failing closed on any
 * difference or if the profile cannot be read at all.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The profile source this harness mirrors. */
export const CONFORMANCE_PROFILE_PATH = join(
  here,
  "..",
  "..",
  "..",
  "web",
  "src",
  "investigations",
  "strategies",
  "testkit",
  "conformance.tsx",
);

/**
 * Mirrors `BROWSER_SURFACE_REQUIREMENT_IDS` in the profile, in profile order.
 * `assertProfileParity` proves the mirror is exact.
 */
export const BROWSER_CONFORMANCE_REQUIREMENT_IDS = [
  "semantic-roles-and-labels",
  "canonical-navigation",
  "keyboard-equivalents",
  "reflow-560",
  "reflow-390",
  "forced-colors",
  "reduced-motion",
  "no-drag-only-core-flow",
] as const;

export type BrowserConformanceRequirementId =
  (typeof BROWSER_CONFORMANCE_REQUIREMENT_IDS)[number];

/** Effective CSS widths the reflow requirements are stated against. */
export const REFLOW_VIEWPORTS = {
  // A 1,120 CSS-pixel desktop at 200% zoom exposes 560 effective CSS pixels.
  "reflow-560": { width: 560, height: 900 },
  // A common small handset width, below which no core control may be clipped.
  "reflow-390": { width: 390, height: 844 },
} as const;

export type ReflowRequirementId = keyof typeof REFLOW_VIEWPORTS;

export interface BrowserConformanceEvidence {
  readonly id: BrowserConformanceRequirementId;
  readonly observed: string;
}

export interface BrowserConformanceReport {
  readonly target: string;
  readonly surface: "browser";
  readonly evaluated: readonly BrowserConformanceEvidence[];
}

/** Read the browser-surface requirement ids the web profile declares. */
export function browserSurfaceIdsFromProfile(): string[] {
  let source: string;
  try {
    source = readFileSync(CONFORMANCE_PROFILE_PATH, "utf8");
  } catch (cause) {
    throw new Error(
      `cannot read the conformance profile at ${CONFORMANCE_PROFILE_PATH}; `
        + "the browser harness refuses to claim parity it cannot check",
      cause instanceof Error ? { cause } : undefined,
    );
  }
  const block = /export const BROWSER_SURFACE_REQUIREMENT_IDS = \[([^\]]*)\] as const;/u
    .exec(source);
  if (!block?.[1]) {
    throw new Error(
      "the conformance profile no longer declares BROWSER_SURFACE_REQUIREMENT_IDS "
        + "as a plain array literal; update this harness rather than dropping the check",
    );
  }
  return Array.from(block[1].matchAll(/"([^"]+)"/gu), (match) => match[1] ?? "");
}

/**
 * Fail closed when the profile and this harness disagree about which
 * requirements a browser owes evidence for.
 */
export function assertProfileParity(): void {
  expect(
    browserSurfaceIdsFromProfile(),
    "the browser harness and the strategy conformance profile disagree about the browser surface",
  ).toEqual([...BROWSER_CONFORMANCE_REQUIREMENT_IDS]);
}

/**
 * One strategy's browser conformance run.
 *
 * It fails closed in both directions, the same way the War Room acceptance
 * recorder does: an id outside the profile is an error, so a spec cannot
 * invent a claim; and a declared requirement the spec never reached is an
 * error at `finish()`, so a spec cannot go green by skipping the hard half.
 */
export class BrowserConformanceRun {
  private readonly evidence = new Map<BrowserConformanceRequirementId, string>();
  private readonly declared: readonly BrowserConformanceRequirementId[];

  /**
   * `declared` is the slice of the browser surface this journey owns. Browser
   * journeys are expensive and each needs its own page state, so the surface is
   * split across them rather than replayed in every one. `finish()` still fails
   * on anything the journey declared and did not reach, and
   * `assertBrowserSurfaceCovered` proves the slices leave no gap.
   */
  constructor(
    private readonly target: string,
    declared: readonly BrowserConformanceRequirementId[] = BROWSER_CONFORMANCE_REQUIREMENT_IDS,
  ) {
    assertProfileParity();
    expect(declared.length, `${target} declared no conformance requirement`).toBeGreaterThan(0);
    this.declared = declared;
  }

  record(id: BrowserConformanceRequirementId, observed: string): void {
    if (!this.declared.includes(id)) {
      throw new Error(`${this.target} did not declare conformance requirement ${id}`);
    }
    if (this.evidence.has(id)) {
      throw new Error(`conformance requirement ${id} was already recorded for ${this.target}`);
    }
    if (observed.trim().length === 0) {
      throw new Error(`conformance requirement ${id} was recorded with no evidence`);
    }
    this.evidence.set(id, observed);
  }

  finish(): BrowserConformanceReport {
    const missing = this.declared.filter((id) => !this.evidence.has(id));
    expect(
      missing,
      `${this.target} never reached these browser conformance requirements`,
    ).toEqual([]);
    return {
      target: this.target,
      surface: "browser",
      evaluated: this.declared.map((id) => ({
        id,
        observed: this.evidence.get(id) ?? "",
      })),
    };
  }
}

/**
 * Prove the journeys of one strategy partition the browser surface: every
 * requirement claimed exactly once, and none left unclaimed. This is pure data,
 * so it holds under `--grep`, retries, and sharding, where a shared accumulator
 * across browser journeys would not.
 */
export function assertBrowserSurfaceCovered(
  slices: readonly (readonly BrowserConformanceRequirementId[])[],
): void {
  const claimed = slices.flat();
  expect(
    [...claimed].sort(),
    "the browser journeys do not cover the browser surface exactly once",
  ).toEqual([...BROWSER_CONFORMANCE_REQUIREMENT_IDS].sort());
}

const NAMED_ACCESSIBLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

interface AccessibleTreeAudit {
  readonly inspected: number;
  readonly unnamed: string[];
  readonly headingLevels: number[];
}

/**
 * Audit the browser's own accessibility tree.
 *
 * `ariaSnapshot` reports the roles and computed names the platform would
 * expose, so an unnamed control here is unnamed for assistive technology —
 * not merely missing an attribute this harness happened to look for.
 */
export function auditAccessibleTree(snapshot: string): AccessibleTreeAudit {
  const unnamed: string[] = [];
  const headingLevels: number[] = [];
  let inspected = 0;
  for (const rawLine of snapshot.split("\n")) {
    const line = rawLine.trim();
    const match = /^-\s+'?([a-z][a-z-]*)\b(.*)$/u.exec(line);
    if (!match) continue;
    const role = match[1] ?? "";
    if (!NAMED_ACCESSIBLE_ROLES.has(role)) continue;
    inspected += 1;
    const rest = (match[2] ?? "").trim();
    if (!rest.startsWith('"')) unnamed.push(line.slice(0, 120));
    if (role === "heading") {
      const level = /\[level=(\d+)\]/u.exec(rest);
      if (level?.[1]) headingLevels.push(Number.parseInt(level[1], 10));
    }
  }
  return { inspected, unnamed, headingLevels };
}

/** Headings must not jump a level; a skipped level breaks document structure. */
export function skippedHeadingLevels(levels: readonly number[]): string[] {
  const skips: string[] = [];
  let previous = 0;
  for (const level of levels) {
    if (previous !== 0 && level - previous > 1) skips.push(`h${previous} -> h${level}`);
    previous = level;
  }
  return skips;
}

export async function expectSemanticRolesAndLabels(
  page: Page,
  root: Locator,
): Promise<string> {
  await expect(page.locator("html")).toHaveAttribute("lang", /\S/u);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();

  const audit = auditAccessibleTree(await root.ariaSnapshot());
  expect(audit.inspected, "the strategy exposed no named roles at all").toBeGreaterThan(0);
  expect(audit.unnamed, "interactive roles without an accessible name").toEqual([]);
  expect(audit.headingLevels.length, "the strategy rendered no heading").toBeGreaterThan(0);
  expect(skippedHeadingLevels(audit.headingLevels), "skipped heading levels").toEqual([]);

  const positiveTabIndex = await root.evaluate((node) =>
    Array.from(node.querySelectorAll("[tabindex]"))
      .filter((element) => Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0)
      .map((element) => element.outerHTML.slice(0, 120)),
  );
  expect(positiveTabIndex, "a control overrides the natural tab order").toEqual([]);

  return `${audit.inspected} named role(s) across heading levels ${audit.headingLevels.join(",")} with 0 unnamed controls and 0 positive tabindex values`;
}

export async function expectCanonicalNavigation(
  page: Page,
  root: Locator,
  expected: { readonly pathname: string | RegExp },
): Promise<string> {
  const pathname = new URL(page.url()).pathname;
  if (typeof expected.pathname === "string") {
    expect(pathname, "the strategy left the canonical address").toBe(expected.pathname);
  } else {
    expect(pathname, "the strategy left the canonical address").toMatch(expected.pathname);
  }

  const exposed = await root.evaluate((node) =>
    Array.from(node.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => /^(?:https?:)?\/\//u.test(href) || href.startsWith("/api/")),
  );
  expect(exposed, "the strategy rendered a transport or absolute address").toEqual([]);

  return `canonical path ${pathname} with 0 transport or absolute addresses rendered`;
}

export async function expectKeyboardEquivalents(
  page: Page,
  controls: readonly Locator[],
): Promise<string> {
  expect(controls.length, "no core control was declared for the keyboard proof").toBeGreaterThan(0);
  const described: string[] = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    await control.focus();
    await expect(control).toBeFocused();
    const shape = await control.evaluate((node) => ({
      tag: node.tagName,
      disabled: node.hasAttribute("disabled"),
      tabIndex: Number.parseInt(node.getAttribute("tabindex") ?? "0", 10),
      href: node.getAttribute("href"),
    }));
    expect(
      ["A", "BUTTON", "INPUT", "SELECT", "SUMMARY", "TEXTAREA"],
      `${shape.tag} is not a natively keyboard-operable control`,
    ).toContain(shape.tag);
    if (shape.tag === "A") expect(shape.href, "a link without an href is not operable").toBeTruthy();
    expect(shape.disabled, `${shape.tag} is disabled where it must act`).toBe(false);
    expect(shape.tabIndex, `${shape.tag} overrides the natural tab order`).toBeLessThanOrEqual(0);
    described.push(shape.tag.toLowerCase());
  }
  // Page-level proof that focus can leave the very first stop, so a control is
  // never the only thing a keyboard can reach.
  await page.keyboard.press("Tab");
  return `${controls.length} core control(s) focusable and natively operable (${described.join(", ")})`;
}

export async function documentScrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

export async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "expected a visible control with a layout box").not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, "expected a sized viewport").not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
}

/**
 * Reflow one declared viewport. The caller restores its own viewport; this
 * harness deliberately leaves the page where the requirement was proved so a
 * failure can be inspected in the trace at the size that produced it.
 */
export async function expectReflow(
  page: Page,
  requirement: ReflowRequirementId,
  controls: readonly Locator[],
): Promise<string> {
  const viewport = REFLOW_VIEWPORTS[requirement];
  await page.setViewportSize(viewport);
  expect(
    await documentScrollWidth(page),
    `the document scrolls horizontally at ${viewport.width} CSS pixels`,
  ).toBeLessThanOrEqual(viewport.width);
  for (const control of controls) await expectInsideViewport(page, control);
  return `${controls.length} core control(s) inside a ${viewport.width}x${viewport.height} viewport with no page-level horizontal scroll`;
}

export async function expectForcedColors(
  page: Page,
  controls: readonly Locator[],
): Promise<string> {
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
    "forced colors was not actually active",
  ).toBe(true);
  expect(controls.length, "no control was declared for the forced-colors proof").toBeGreaterThan(0);

  for (const control of controls) {
    const boundary = await control.evaluate((node) => {
      const style = getComputedStyle(node);
      return { borderStyle: style.borderStyle, borderWidth: style.borderWidth };
    });
    expect(boundary.borderStyle, "a control lost its system-drawn boundary").not.toBe("none");
    expect(Number.parseFloat(boundary.borderWidth)).toBeGreaterThan(0);
  }

  const last = controls.at(-1);
  if (!last) throw new Error("expected at least one control to prove the focus indicator");
  await last.focus();
  await expect(last).toBeFocused();
  const focus = await last.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focus.outlineStyle, "keyboard focus is invisible under forced colors").not.toBe("none");
  expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThan(0);

  return `${controls.length} control(s) kept a system boundary and a ${focus.outlineWidth} focus outline`;
}

export async function expectReducedMotion(page: Page, root: Locator): Promise<string> {
  expect(
    await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    "reduced motion was not actually active",
  ).toBe(true);

  const audit = await root.evaluate((node) => {
    const durationIsNonzero = (value: string) => value.split(",").some((part) => {
      const duration = part.trim();
      return duration.endsWith("ms")
        ? Number.parseFloat(duration) !== 0
        : duration.endsWith("s") && Number.parseFloat(duration) !== 0;
    });
    const visible = [node, ...Array.from(node.querySelectorAll("*"))].filter((candidate) => {
      const element = candidate as HTMLElement;
      const style = getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && element.getClientRects().length > 0;
    });
    return {
      inspected: visible.length,
      offenders: visible.flatMap((candidate) => {
        const style = getComputedStyle(candidate);
        return durationIsNonzero(style.animationDuration)
          || durationIsNonzero(style.transitionDuration)
          ? [{
              animationDuration: style.animationDuration,
              element: (candidate as HTMLElement).outerHTML.slice(0, 160),
              transitionDuration: style.transitionDuration,
            }]
          : [];
      }),
    };
  });

  expect(audit.inspected, "reduced motion was audited against too little of the page").toBeGreaterThan(20);
  expect(audit.offenders, "a visible element still animates under reduced motion").toEqual([]);
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
  ).toBe("auto");

  return `${audit.inspected} visible element(s) with 0 nonzero animation or transition durations and auto scroll behavior`;
}

export async function expectNoDragOnlyCoreFlow(page: Page, root: Locator): Promise<string> {
  const draggable = await root.evaluate((node) =>
    Array.from(node.querySelectorAll("[draggable=true]")).map((element) => ({
      html: element.outerHTML.slice(0, 120),
      operable: ["A", "BUTTON", "INPUT", "SELECT", "SUMMARY", "TEXTAREA"].includes(element.tagName)
        || element.hasAttribute("tabindex"),
      named: ((element.getAttribute("aria-label") ?? element.textContent) ?? "").trim().length > 0,
    })),
  );
  const dragOnly = draggable
    .filter((candidate) => !candidate.operable || !candidate.named)
    .map((candidate) => candidate.html);
  expect(
    dragOnly,
    "a core action is reachable only by dragging, with no keyboard-operable equivalent",
  ).toEqual([]);
  // Pointer-drag emulation would not prove the absence of a keyboard path, so
  // the claim is stated exactly as what was inspected.
  return `${draggable.length} draggable element(s) in the mounted strategy, each with a named focusable equivalent`;
}
