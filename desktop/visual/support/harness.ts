/**
 * Shared helpers for the renderer-level visual acceptance suite.
 *
 * Scope honesty: everything here observes a real Chromium page driven by
 * Vitest browser mode. That is renderer-level proof — real CSS, layout,
 * focus, and ARIA — and never native packaged acceptance
 * (docs/CLOSE_PROOF.md § Native packaged proof).
 */
import { page } from "vitest/browser";
import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { SkinId } from "../../src/lib/skins";
import { applyThemeToDocument } from "../../src/lib/themeBridge";
import "./stage.css";

/**
 * Named viewport geometries. Chosen against the app's real breakpoints:
 * - narrow 640×800: Log Explorer narrow (<900, src/lib/logExplorer/types.ts),
 *   app sidebar collapse (≤760, layout.css), Help drawer (≤650, help.css).
 * - normal 1280×800: default desktop window, no breakpoint active.
 * - wide 1720×950: Log Explorer ultrawide (≥1600) with multi-lane controls.
 */
export const VIEWPORTS = {
  narrow: { width: 640, height: 800 },
  normal: { width: 1280, height: 800 },
  wide: { width: 1720, height: 950 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

export async function setViewport(name: ViewportName): Promise<void> {
  const { width, height } = VIEWPORTS[name];
  await page.viewport(width, height);
}

/**
 * Apply a registered skin exactly the way the app does: the production
 * validator sets html[data-theme] (fails closed on unknown ids), and the
 * storage key matches what useShellState persists.
 *
 * Waits for a painted frame before returning: the tester page returns stale
 * computed styles for var()-dependent declarations when read synchronously
 * after the attribute flip (verified empirically — the custom property
 * updates, its dependents do not until the next recalc). A rendered frame
 * guarantees fresh substitution for computed reads and screenshots alike.
 */
export async function applyTheme(skin: SkinId): Promise<void> {
  window.localStorage.setItem("cd-theme", skin);
  applyThemeToDocument(skin);
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}

/**
 * Reset renderer state between tests. Real Chromium persists localStorage,
 * sessionStorage, and the URL across tests in a file — all three change which
 * surface renders (cd-theme, cd-pane, cd-setup, dismissal ledgers, ?skip
 * flags), so every visual test file should call this in beforeEach.
 */
export async function resetVisualState(): Promise<void> {
  cleanup();
  document.querySelector("[data-visual-stage]")?.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  await applyTheme("dark");
  await setViewport("normal");
  // Force-load the bundled faces (they are declared font-display: swap and
  // load lazily on first use): a screenshot taken before a face finishes
  // loading would bake fallback glyphs into the baseline.
  await Promise.all([
    document.fonts.load('16px "Inter"'),
    document.fonts.load('500 16px "Inter"'),
    document.fonts.load('600 16px "Inter"'),
    document.fonts.load('16px "IBM Plex Mono"'),
    document.fonts.load('500 16px "IBM Plex Mono"'),
  ]);
  await document.fonts.ready;
}

/**
 * The paint root every visual test renders into.
 *
 * The app paints body with --bg-app (base.css:48), but Vitest's tester
 * injects a user-agent-origin stylesheet controlling the page background —
 * UA-origin !important outranks every author style, inline included, so body
 * can never be painted here (verified empirically: a literal inline
 * `background: #123456 !important` still computes to transparent). Production
 * surfaces never sit on bare body anyway; this stage supplies the same
 * painted ancestor the app shell would, using the same tokens, so axe
 * contrast and screenshots measure the real skin backdrop.
 */
export function visualStage(): HTMLElement {
  let stage = document.querySelector<HTMLElement>("[data-visual-stage]");
  if (!stage) {
    stage = document.createElement("div");
    stage.setAttribute("data-visual-stage", "");
    document.body.appendChild(stage);
  }
  return stage;
}

/**
 * Render a component inside the painted stage. Each call gets a fresh mount
 * node (Testing Library binds one React root per container, so re-rendering
 * into a previously unmounted container would throw), and unmount removes the
 * node so a later render in the same test starts from a clean stage.
 */
export function renderVisual(ui: ReactElement) {
  const stage = visualStage();
  const mount = document.createElement("div");
  mount.setAttribute("data-visual-root", "");
  stage.appendChild(mount);
  const result = render(ui, { container: mount });
  const unmountReact = result.unmount;
  return {
    ...result,
    unmount() {
      unmountReact();
      mount.remove();
    },
  };
}

export type AxeOptions = {
  /** axe rule ids to disable for this scope, each with a reason at the call site. */
  disableRules?: string[];
};

/**
 * Run axe-core against a scope and fail with a readable report. axe runs
 * in-page (browser mode executes test code inside Chromium), so color-contrast
 * checks measure real rendered pixels — no injection bridge involved.
 */
export async function expectNoAxeViolations(
  scope: Element,
  options: AxeOptions = {},
): Promise<void> {
  const results = await axe.run(scope, {
    rules: Object.fromEntries(
      (options.disableRules ?? []).map((id) => [id, { enabled: false }]),
    ),
  });
  const violations = results.violations;
  if (violations.length === 0) return;
  const report = violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(" ")}\n      ${n.failureSummary ?? ""}`)
        .join("\n");
      return `  [${v.impact ?? "unknown"}] ${v.id}: ${v.help}\n${nodes}`;
    })
    .join("\n");
  throw new Error(
    `axe-core found ${violations.length} violation(s):\n${report}`,
  );
}

/**
 * Assert an element creates no horizontal overflow against the page viewport.
 * The app must never scroll horizontally at any supported width; wide content
 * scrolls inside its own container.
 */
export function expectNoHorizontalPageOverflow(): void {
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) {
    throw new Error(
      `page overflows horizontally: scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}`,
    );
  }
}

/** Rect helper: element fully inside the current viewport. */
export function expectWithinViewport(el: Element): void {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh) {
    throw new Error(
      `element escapes viewport: rect ${JSON.stringify({
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      })} vs viewport ${vw}×${vh}`,
    );
  }
}
