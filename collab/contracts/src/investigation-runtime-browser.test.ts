import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "./investigation-runtime-browser.js";
import * as root from "./index.js";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(SRC_ROOT, "investigation-runtime-browser.ts");
const MODULE_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;

function moduleSpecifiers(source: string): string[] {
  if (/\bimport\s*\(/.test(source)) {
    throw new Error("browser graph contains a dynamic import");
  }
  if (/\brequire\s*\(/.test(source)) {
    throw new Error("browser graph contains require");
  }
  return Array.from(source.matchAll(MODULE_SPECIFIER_RE), (match) => match[1] ?? "");
}

function typescriptTarget(importer: string, specifier: string): string {
  const resolved = resolve(dirname(importer), specifier);
  return resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
}

function browserGraph(
  entry: string,
  sourceOverrides: ReadonlyMap<string, string> = new Map(),
): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (!current.startsWith(`${SRC_ROOT}/`)) {
      throw new Error(`browser graph escaped contract source root: ${current}`);
    }
    visited.add(current);
    const source = sourceOverrides.get(current) ?? readFileSync(current, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith("node:")) {
        throw new Error(`browser graph imports Node builtin ${specifier} from ${current}`);
      }
      if (!specifier.startsWith(".")) {
        throw new Error(`browser graph imports bare module ${specifier} from ${current}`);
      }
      pending.push(typescriptTarget(current, specifier));
    }
  }
  return visited;
}

describe("investigation Runtime browser contract boundary", () => {
  it("exports the exact root reference-recheck constants and parsers", () => {
    expect(browser.REFERENCE_RECHECK_REQUEST_SCHEMA_ID).toBe(
      root.REFERENCE_RECHECK_REQUEST_SCHEMA_ID,
    );
    expect(browser.REFERENCE_RECHECK_SCHEMA_ID).toBe(root.REFERENCE_RECHECK_SCHEMA_ID);
    expect(browser.REFERENCE_RECHECK_SUCCESS_SCHEMA_ID).toBe(
      root.REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
    );
    expect(browser.REFERENCE_RECHECK_PAGE_SCHEMA_ID).toBe(
      root.REFERENCE_RECHECK_PAGE_SCHEMA_ID,
    );
    expect(browser.REFERENCE_RECHECK_CHANGED_SCHEMA_ID).toBe(
      root.REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
    );
    expect(browser.REFERENCE_RECHECK_REFUSED_SCHEMA_ID).toBe(
      root.REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
    );
    expect(browser.REFERENCE_RECHECK_OUTCOMES).toBe(root.REFERENCE_RECHECK_OUTCOMES);
    expect(browser.REFERENCE_RECHECK_CHANGE_REASONS).toBe(
      root.REFERENCE_RECHECK_CHANGE_REASONS,
    );
    expect(browser.REFERENCE_RECHECK_REFUSALS).toBe(root.REFERENCE_RECHECK_REFUSALS);
    expect(browser.REFERENCE_RECHECK_LIMITS).toBe(root.REFERENCE_RECHECK_LIMITS);
    expect(browser.REFERENCE_RECHECK_RESPONSE_CONTEXT).toBe(
      root.REFERENCE_RECHECK_RESPONSE_CONTEXT,
    );
    expect(browser.REFERENCE_RECHECK_IDEMPOTENCY).toBe(
      root.REFERENCE_RECHECK_IDEMPOTENCY,
    );
    expect(browser.parseReferenceRecheckRequest).toBe(root.parseReferenceRecheckRequest);
    expect(browser.parseReferenceRecheck).toBe(root.parseReferenceRecheck);
    expect(browser.parseReferenceRecheckSuccess).toBe(root.parseReferenceRecheckSuccess);
    expect(browser.parseReferenceRecheckPage).toBe(root.parseReferenceRecheckPage);
    expect(browser.parseReferenceRecheckChanged).toBe(root.parseReferenceRecheckChanged);
    expect(browser.parseReferenceRecheckRefused).toBe(root.parseReferenceRecheckRefused);
  });

  it("exports the exact root provider-bound reference contract", () => {
    expect(browser.PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID).toBe(
      root.PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
    );
    expect(browser.PROVIDER_BOUND_REFERENCE_LIMITS).toBe(root.PROVIDER_BOUND_REFERENCE_LIMITS);
    expect(browser.PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS).toBe(
      root.PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS,
    );
    expect(browser.PROVIDER_BOUND_REFERENCE_CONTEXT).toBe(root.PROVIDER_BOUND_REFERENCE_CONTEXT);
    expect(browser.PROVIDER_BOUND_REFERENCE_IDEMPOTENCY).toBe(
      root.PROVIDER_BOUND_REFERENCE_IDEMPOTENCY,
    );
    expect(browser.parseProviderBoundReferenceCreate).toBe(
      root.parseProviderBoundReferenceCreate,
    );
  });

  it("recursively keeps the real browser entry free of Node and bare modules", () => {
    const graph = browserGraph(ENTRY);
    expect(graph.size).toBeGreaterThan(5);
    expect(graph).toContain(resolve(SRC_ROOT, "reference-recheck.ts"));
    expect(graph).toContain(resolve(SRC_ROOT, "provider-reference.ts"));
    expect(graph).toContain(resolve(SRC_ROOT, "parse.ts"));
    expect(graph).toContain(resolve(SRC_ROOT, "temporal.ts"));
    expect(graph).toContain(resolve(SRC_ROOT, "user-profile.ts"));
  });

  it("fails closed when a reachable source is mutated to import a Node builtin", () => {
    const source = readFileSync(ENTRY, "utf8");
    expect(() =>
      browserGraph(
        ENTRY,
        new Map([[ENTRY, `${source}\nimport "node:crypto";\n`]]),
      ),
    ).toThrow(/Node builtin node:crypto/);
  });

  it("fails closed when a reachable source is mutated to escape the contract graph", () => {
    const referenceContract = resolve(SRC_ROOT, "reference-recheck.ts");
    const source = readFileSync(referenceContract, "utf8");
    expect(() =>
      browserGraph(
        ENTRY,
        new Map([
          [
            referenceContract,
            `${source}\nimport "../../../server/src/modules/cases/service.js";\n`,
          ],
        ]),
      ),
    ).toThrow(/escaped contract source root/);
  });

  it("fails closed when a reachable source is mutated to hide a dynamic dependency", () => {
    const source = readFileSync(ENTRY, "utf8");
    expect(() =>
      browserGraph(
        ENTRY,
        new Map([[ENTRY, `${source}\nvoid import("node:crypto");\n`]]),
      ),
    ).toThrow(/dynamic import/);
  });
});
