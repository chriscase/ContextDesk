/**
 * Boundary ratchet checker — pure logic, no filesystem access here.
 *
 * Contract (design handoff §7): components stop importing `lib/host` and
 * `@tauri-apps/*` directly; the engine adapter under `src/lib/engine/` is the
 * ONLY designated home for both. Existing importers are grandfathered by the
 * measured baseline (`hostImportBaseline.ts`); anything new fails the suite.
 *
 * The scanner is deliberately dependency-free and syntax-light: it matches
 * static `import`/`export … from` and dynamic `import("…")` specifiers with a
 * regex, then resolves relative specifiers against the importing file's
 * directory. That is exact for this codebase (no computed import specifiers
 * in production code) and errs on the strict side for new ones.
 */

/** Directory prefix that is the designated adapter/platform boundary. */
export const ENGINE_BOUNDARY_PREFIX = "src/lib/engine/";

/** The one production module allowed to wrap Tauri IPC today. */
export const HOST_MODULE = "src/lib/host";

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

/** Normalize a repo-relative posix path (no leading "./"). */
function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Extract every import/export/dynamic-import specifier from source text. */
export function extractSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER_RE)) out.push(m[1]);
  return out;
}

/** True when `file` (desktop-relative posix path) is a test file. */
export function isTestFile(file: string): boolean {
  return TEST_FILE_RE.test(file);
}

/** True when the specifier, imported from `file`, resolves to lib/host. */
export function specifierTargetsHost(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const dir = file.split("/").slice(0, -1).join("/");
  const resolved = normalizePosix(`${dir}/${specifier}`);
  return resolved === HOST_MODULE || resolved === `${HOST_MODULE}.ts`;
}

/** True when the specifier is a direct @tauri-apps API import. */
export function specifierTargetsTauri(specifier: string): boolean {
  return specifier === "@tauri-apps" || specifier.startsWith("@tauri-apps/");
}

export type BoundaryViolation = {
  file: string;
  specifier: string;
  surface: "host" | "tauri";
};

export type BoundaryReport = {
  violations: BoundaryViolation[];
  /** Baseline entries that no longer import the surface (ratchet-shrink candidates). */
  staleHostBaseline: string[];
  staleTauriBaseline: string[];
  /** Files actually importing each surface (production, non-engine). */
  hostImporters: string[];
  tauriImporters: string[];
};

/**
 * Evaluate the ratchet over a file map (desktop-relative posix path →
 * source text). Test files are exempt (they mock the host); files under the
 * engine boundary are the designated adapter home and are always allowed.
 */
export function checkBoundary(
  files: ReadonlyMap<string, string>,
  hostBaseline: readonly string[],
  tauriBaseline: readonly string[],
): BoundaryReport {
  const hostAllowed = new Set(hostBaseline);
  const tauriAllowed = new Set(tauriBaseline);
  const violations: BoundaryViolation[] = [];
  const hostImporters: string[] = [];
  const tauriImporters: string[] = [];

  for (const [file, source] of files) {
    if (isTestFile(file)) continue;
    if (file.startsWith(ENGINE_BOUNDARY_PREFIX)) continue;
    const specifiers = extractSpecifiers(source);
    const hostSpec = specifiers.find((s) => specifierTargetsHost(file, s));
    const tauriSpec = specifiers.find((s) => specifierTargetsTauri(s));
    if (hostSpec !== undefined) {
      hostImporters.push(file);
      if (!hostAllowed.has(file)) {
        violations.push({ file, specifier: hostSpec, surface: "host" });
      }
    }
    if (tauriSpec !== undefined) {
      tauriImporters.push(file);
      if (!tauriAllowed.has(file)) {
        violations.push({ file, specifier: tauriSpec, surface: "tauri" });
      }
    }
  }

  hostImporters.sort();
  tauriImporters.sort();
  const present = (list: string[]) => new Set(list);
  const hostPresent = present(hostImporters);
  const tauriPresent = present(tauriImporters);
  return {
    violations,
    staleHostBaseline: hostBaseline.filter((f) => !hostPresent.has(f)).sort(),
    staleTauriBaseline: tauriBaseline.filter((f) => !tauriPresent.has(f)).sort(),
    hostImporters,
    tauriImporters,
  };
}

/** Render violations for a failing assertion message. */
export function formatViolations(violations: BoundaryViolation[]): string {
  return violations
    .map(
      (v) =>
        `${v.file} imports ${v.surface === "host" ? "src/lib/host" : "a direct @tauri-apps API"} ` +
        `(\`${v.specifier}\`). New production importers are not allowed — route through the ` +
        `engine adapter (${ENGINE_BOUNDARY_PREFIX}) or migrate via @contextdesk/client.`,
    )
    .join("\n");
}
