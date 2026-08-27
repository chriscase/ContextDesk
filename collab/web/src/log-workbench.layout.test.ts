/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const workbenchCss = readFileSync(join(here, "styles/log-workbench.css"), "utf8");
const chronologyCss = readFileSync(join(here, "styles/log-chronology.css"), "utf8");
const triageCss = readFileSync(join(here, "styles/triage-workspace.css"), "utf8");

describe("Log workbench layout contracts", () => {
  it("does not force a dark color-scheme that would fight the light skin", () => {
    expect(workbenchCss.length).toBeGreaterThan(500);
    expect(workbenchCss).not.toMatch(/color-scheme:\s*dark/);
  });

  it("bounds the file picker and keeps match navigation from wrapping", () => {
    expect(workbenchCss).toMatch(/\.log-workbench__file-list \{[\s\S]*?max-height:\s*20rem/);
    expect(workbenchCss).toMatch(/\.log-workbench__file-list--virtual \{[\s\S]*?height:\s*20rem/);
    expect(workbenchCss).toMatch(/\.log-workbench__search-row \{[\s\S]*?flex-wrap:\s*nowrap/);
    expect(workbenchCss).toMatch(/\.log-workbench__match-nav \{[\s\S]*?flex-wrap:\s*nowrap/);
    expect(workbenchCss).toMatch(/\.log-workbench__match-nav \{[\s\S]*?white-space:\s*nowrap/);
    expect(workbenchCss).toMatch(/\.log-workbench__hits \{[\s\S]*?max-height:\s*18rem/);
  });

  it("covers laptop, phone, reduced motion, and forced colors", () => {
    expect(workbenchCss).toMatch(/@media \(max-width: 64rem\)/);
    expect(workbenchCss).toMatch(/@media \(max-width: 40rem\)/);
    expect(workbenchCss).toMatch(/@media \(max-width: 28rem\)/);
    expect(workbenchCss).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(workbenchCss).toMatch(/forced-colors:\s*active/);
  });

  it("styles search and file-filter fields from tokens, not browser chrome", () => {
    expect(workbenchCss).toMatch(/\.log-workbench__files-toolbar input/);
    expect(workbenchCss).toMatch(/background: var\(--surface-input\)/);
    expect(workbenchCss).toMatch(/\.log-workbench a \{[\s\S]*?color: var\(--accent\)/);
  });
});

describe("Timezone review and chronology dark surfaces", () => {
  it("styles the timezone file filter from tokens", () => {
    expect(triageCss).toMatch(/\.log-time__tools input \{[\s\S]*?background: var\(--surface-input\)/);
    expect(triageCss).toMatch(/\.log-time__tools input \{[\s\S]*?color: var\(--fg\)/);
  });

  it("bounds the chronology table viewport", () => {
    expect(chronologyCss).toMatch(/\.log-chronology__table-wrap \{[\s\S]*?max-height:\s*24rem/);
  });
});
