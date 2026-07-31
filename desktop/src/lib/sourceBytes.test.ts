/**
 * TypeScript source must stay text.
 *
 * A literal NUL (or other forbidden control byte) in a .ts/.tsx file makes Git
 * classify the whole file as binary: `git diff` prints "Binary files ...
 * differ", `--numstat` reports a dash, and blame and three-way merges stop
 * working. That happened to lib/modelCuration.ts, whose search separator was
 * written as a raw NUL rather than a `\u0000` escape.
 *
 * It is invisible in an editor and in review, so it needs a test. Escapes are
 * fine; raw bytes are not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Tab, LF and CR are the only control bytes legitimate in source. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if ([".ts", ".tsx"].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function controlBytesIn(file: string): number[] {
  const found = new Set<number>();
  for (const byte of readFileSync(file)) {
    if (byte < 0x20 && !ALLOWED.has(byte)) found.add(byte);
  }
  return [...found].sort((a, b) => a - b);
}

describe("source files contain no raw control bytes", () => {
  const files = sourceFiles(srcDir);

  it("finds source to scan", () => {
    // Guards the guard: a broken walk would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no literal NUL or other forbidden control byte in any .ts/.tsx", () => {
    const offenders = files
      .filter((f) => controlBytesIn(f).length > 0)
      .map(
        (f) =>
          relative(srcDir, f) +
          " contains " +
          controlBytesIn(f)
            .map((c) => "0x" + c.toString(16).padStart(2, "0"))
            .join(", "),
      );
    // Write separators and other non-printables as escapes, so Git can still
    // diff, blame and merge the file.
    expect(offenders).toEqual([]);
  });

  it("still detects a raw control byte when one is present", () => {
    // Proves the scan is not vacuous. The byte is built at runtime so this
    // file never has to contain the thing it tests for.
    const nul = String.fromCharCode(0);
    const sample = Buffer.from("a" + nul + "b", "utf8");
    const found = [...sample].filter((b) => b < 0x20 && !ALLOWED.has(b));
    expect(found).toEqual([0x00]);
  });
});
