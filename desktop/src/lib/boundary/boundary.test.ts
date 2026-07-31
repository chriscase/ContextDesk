import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_WIRE_VERSION } from "../engine/platform";
import {
  checkBoundary,
  ENGINE_BOUNDARY_PREFIX,
  extractSpecifiers,
  formatViolations,
  isTestFile,
  specifierTargetsHost,
  specifierTargetsTauri,
} from "./boundaryCheck";
import {
  HOST_IMPORT_BASELINE,
  TAURI_IMPORT_BASELINE,
} from "./hostImportBaseline";

/** Load every production-relevant TS/TSX file under desktop/src. */
function loadRepoFiles(): Map<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = join(here, "..", "..", "..");
  const srcRoot = join(desktopRoot, "src");
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const rel = relative(desktopRoot, full).split(sep).join("/");
        files.set(rel, readFileSync(full, "utf8"));
      }
    }
  };
  walk(srcRoot);
  return files;
}

describe("boundary ratchet — real tree", () => {
  const report = checkBoundary(
    loadRepoFiles(),
    HOST_IMPORT_BASELINE,
    TAURI_IMPORT_BASELINE,
  );

  it("no production file outside the baseline imports lib/host or @tauri-apps", () => {
    expect(
      report.violations,
      formatViolations(report.violations),
    ).toEqual([]);
  });

  it("the scan is non-vacuous: it sees the measured baseline importers", () => {
    // If the matcher ever silently breaks, importer counts collapse and this
    // guard — not the empty-violations assertion — is what fails.
    expect(report.hostImporters.length).toBeGreaterThanOrEqual(40);
    expect(report.tauriImporters).toContain("src/lib/host.ts");
  });

  it("reports (but does not fail on) baseline entries that migrated away", () => {
    // Ratchet-shrink candidates: remove these from the baseline when seen.
    // Intentionally non-failing so active lanes can migrate files without
    // tripping this suite; the report keeps the shrink honest and visible.
    expect(Array.isArray(report.staleHostBaseline)).toBe(true);
    expect(Array.isArray(report.staleTauriBaseline)).toBe(true);
  });
});

describe("boundary ratchet — enforcement semantics", () => {
  const baselineHost = ["src/components/Old.tsx"];
  const baselineTauri = ["src/lib/host.ts"];

  it("fails a synthetic NEW production importer of lib/host", () => {
    const files = new Map([
      [
        "src/components/Evil.tsx",
        'import { hostReadFile } from "../lib/host";\n',
      ],
    ]);
    const report = checkBoundary(files, baselineHost, baselineTauri);
    expect(report.violations).toEqual([
      {
        file: "src/components/Evil.tsx",
        specifier: "../lib/host",
        surface: "host",
      },
    ]);
  });

  it("fails a synthetic NEW direct @tauri-apps importer", () => {
    const files = new Map([
      [
        "src/components/Sneaky.tsx",
        'import { invoke } from "@tauri-apps/api/core";\n',
      ],
    ]);
    const report = checkBoundary(files, baselineHost, baselineTauri);
    expect(report.violations).toEqual([
      {
        file: "src/components/Sneaky.tsx",
        specifier: "@tauri-apps/api/core",
        surface: "tauri",
      },
    ]);
  });

  it("allows the designated engine adapter boundary", () => {
    const files = new Map([
      [
        `${ENGINE_BOUNDARY_PREFIX}tauriAdapter.ts`,
        'import { invoke } from "@tauri-apps/api/core";\nimport { agentTurn } from "../host";\n',
      ],
    ]);
    const report = checkBoundary(files, [], []);
    expect(report.violations).toEqual([]);
  });

  it("allows grandfathered baseline importers", () => {
    const files = new Map([
      ["src/components/Old.tsx", 'import { x } from "../lib/host";\n'],
    ]);
    const report = checkBoundary(files, baselineHost, baselineTauri);
    expect(report.violations).toEqual([]);
  });

  it("exempts test files (they mock the host)", () => {
    const files = new Map([
      ["src/components/Thing.test.tsx", 'import * as host from "../lib/host";\n'],
    ]);
    const report = checkBoundary(files, [], []);
    expect(report.violations).toEqual([]);
  });

  it("matcher primitives behave", () => {
    expect(specifierTargetsHost("src/components/A.tsx", "../lib/host")).toBe(true);
    expect(specifierTargetsHost("src/lib/turn.ts", "./host")).toBe(true);
    expect(specifierTargetsHost("src/lib/turn.ts", "./hostel")).toBe(false);
    expect(specifierTargetsHost("src/a.ts", "some-package/lib/host")).toBe(false);
    expect(specifierTargetsTauri("@tauri-apps/api/core")).toBe(true);
    expect(specifierTargetsTauri("@tauri-apps-fake/api")).toBe(false);
    expect(isTestFile("src/x.test.ts")).toBe(true);
    expect(isTestFile("src/x.ts")).toBe(false);
    expect(
      extractSpecifiers(
        'import a from "x";\nexport { b } from "./y";\nconst c = import("z");',
      ),
    ).toEqual(["x", "./y", "z"]);
  });
});

describe("package alias resolution through the desktop graph", () => {
  it("resolves @contextdesk/contracts from production code", () => {
    expect(ENGINE_WIRE_VERSION).toBe("cd.v1");
  });
});
