/**
 * Relational stacking contracts for demo-critical floating UI.
 * These are not pixel baselines — they pin the z-index / isolation planes that
 * keep header menus and portaled panels above body rails and the composer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readCss(name: string): string {
  return readFileSync(join(here, name), "utf8");
}

describe("explorer titlebar stacking plane", () => {
  it("isolates the explorer and lifts the titlebar above the body", () => {
    const css = readCss("log-explorer.css");
    expect(css).toMatch(/\.log-explorer\s*\{[^}]*isolation:\s*isolate/s);
    expect(css).toMatch(
      /\.log-explorer__titlebar\s*\{[^}]*position:\s*relative[^}]*z-index:\s*10/s,
    );
    expect(css).toMatch(
      /\.log-explorer__body\s*\{[^}]*z-index:\s*0/s,
    );
  });
});

describe("session context add panel portal plane", () => {
  it("pins the portaled panel above the composer dock (z-index ≥ 80)", () => {
    const css = readCss("composer.css");
    expect(css).toMatch(
      /\.session-context-add__panel--portal\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*80/s,
    );
  });
});
