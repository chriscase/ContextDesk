import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CORROBORATION_STATES as ROOT_CORROBORATION_STATES,
  REFERENCE_STATES as ROOT_REFERENCE_STATES,
  RESOLUTION_BASES as ROOT_RESOLUTION_BASES,
  parseExportEnvelope as parseRootExportEnvelope,
} from "./index.js";
import {
  EXPORT_ENVELOPE_SCHEMA_ID,
  parseExportEnvelope as parseBrowserExportEnvelope,
  parseExportInventory,
} from "./export-browser.js";
import { CORROBORATION_STATES } from "./corroboration.js";
import { CORROBORATION_STATES as RUN_CORROBORATION_STATES } from "./run.js";
import { REFERENCE_STATES } from "./investigation-reference-vocabulary.js";
import { REFERENCE_STATES as OWNER_REFERENCE_STATES } from "./investigation-reference.js";
import { RESOLUTION_BASES } from "./investigation-resolution-vocabulary.js";
import { RESOLUTION_BASES as OWNER_RESOLUTION_BASES } from "./investigation-resolution.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
}

function envelope(kind: "brief" | "package", payload: unknown): unknown {
  const privacyClass = (payload as { privacyClass?: unknown }).privacyClass;
  return {
    schemaId: EXPORT_ENVELOPE_SCHEMA_ID,
    kind,
    privacyClass,
    exportedAt: "2026-09-09T12:00:00.000Z",
    payload,
    markdown: kind === "brief" ? "# Triage brief\n" : "# Prompt package\n",
  };
}

interface SourceInspection {
  relativeSpecifiers: string[];
  violations: string[];
}

function inspectBrowserSource(source: string, filename: string): SourceInspection {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const relativeSpecifiers: string[] = [];
  const violations: string[] = [];

  const recordSpecifier = (specifier: string, typeOnly: boolean): void => {
    if (typeOnly) return;
    if (!specifier.startsWith(".")) {
      violations.push(`${filename}: runtime bare or alias import ${specifier}`);
      return;
    }
    relativeSpecifiers.push(specifier);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      recordSpecifier(node.moduleSpecifier.text, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      recordSpecifier(node.moduleSpecifier.text, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      violations.push(`${filename}: import-equals is not browser-safe`);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        violations.push(`${filename}: dynamic import is not allowed`);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        violations.push(`${filename}: require is not allowed`);
      }
    } else if (ts.isIdentifier(node) && (node.text === "Buffer" || node.text === "process")) {
      violations.push(`${filename}: Node global ${node.text} is not browser-safe`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { relativeSpecifiers, violations };
}

function browserImportGraph(entry: string): { visited: Set<string>; violations: string[] } {
  const srcRoot = normalize(resolve(here));
  const pending = [resolve(here, entry)];
  const visited = new Set<string>();
  const violations: string[] = [];

  while (pending.length > 0) {
    const file = normalize(pending.pop()!);
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const inspected = inspectBrowserSource(source, file);
    violations.push(...inspected.violations);
    for (const specifier of inspected.relativeSpecifiers) {
      const target = normalize(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      const withinRoot = relative(srcRoot, target);
      if (isAbsolute(withinRoot) || withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || !existsSync(target)) {
        violations.push(`${file}: unresolved or outside-root import ${specifier}`);
        continue;
      }
      if (target.split(sep).some((part) => /^(?:server|storage|admin)(?:[.-]|$)/i.test(part))) {
        violations.push(`${file}: server/storage/admin dependency ${specifier}`);
        continue;
      }
      pending.push(target);
    }
  }
  return { visited, violations };
}

describe("browser-safe export envelope contract", () => {
  it("uses the one authoritative parser from root and the export subpath", () => {
    expect(parseBrowserExportEnvelope).toBe(parseRootExportEnvelope);
    const brief = envelope("brief", fixture("brief.valid.json"));
    const promptPackage = envelope("package", fixture("prompt-package.valid.json"));
    expect(parseBrowserExportEnvelope(brief)).toEqual(parseRootExportEnvelope(brief));
    expect(parseBrowserExportEnvelope(promptPackage)).toEqual(
      parseRootExportEnvelope(promptPackage),
    );
    expect(() =>
      parseBrowserExportEnvelope({
        ...(brief as Record<string, unknown>),
        unexpected: true,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseBrowserExportEnvelope(envelope("brief", fixture("brief.unknown-field.json"))),
    ).toThrow(/unknown key/);
    expect(() =>
      parseBrowserExportEnvelope(
        envelope("package", fixture("prompt-package.unknown-field.json")),
      ),
    ).toThrow(/unknown key/);
  });

  it("keeps canonical vocabularies identical through their legacy owners and root barrel", () => {
    expect(RUN_CORROBORATION_STATES).toBe(CORROBORATION_STATES);
    expect(ROOT_CORROBORATION_STATES).toBe(CORROBORATION_STATES);
    expect(OWNER_REFERENCE_STATES).toBe(REFERENCE_STATES);
    expect(ROOT_REFERENCE_STATES).toBe(REFERENCE_STATES);
    expect(OWNER_RESOLUTION_BASES).toBe(RESOLUTION_BASES);
    expect(ROOT_RESOLUTION_BASES).toBe(RESOLUTION_BASES);
  });

  it("keeps the complete runtime graph free of Node, server, storage, alias, and dynamic edges", () => {
    const graph = browserImportGraph("export-browser.ts");
    expect(graph.violations).toEqual([]);
    const names = [...graph.visited].map((file) => relative(here, file).split(sep).join("/")).sort();
    expect(names).toContain("export-browser.ts");
    expect(names).toContain("export.ts");
    expect(names).toContain("brief.ts");
    expect(names).toContain("package.ts");
    expect(names).toContain("investigation-activity-browser.ts");
    expect(names).toContain("corroboration.ts");
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).not.toContain("investigation-activity.ts");
    expect(names).not.toContain("investigation-portable.ts");
    expect(names).not.toContain("run.ts");
    expect(names).not.toContain("snapshot.ts");
    expect(names).not.toContain("trace.ts");
  });

  it("fails closed when every prohibited dependency form is introduced", () => {
    const mutations = [
      'import { createHash } from "node:crypto";',
      'import secret from "@/server/secret";',
      'export { hidden } from "#internal/storage";',
      'const module = import("./dynamic.js");',
      'const module = require("./legacy.js");',
      'const bytes = Buffer.from("secret");',
      'const mode = process.env.NODE_ENV;',
      'import helper from "unapproved-package";',
    ];
    for (const source of mutations) {
      expect(inspectBrowserSource(source, "mutation.ts").violations.length).toBeGreaterThan(0);
    }
  });

  it("rejects nested brief, package identity/privacy, and malformed snapshot data", () => {
    const brief = envelope("brief", fixture("brief.valid.json")) as Record<string, unknown>;
    const badBrief = structuredClone(brief);
    (badBrief.payload as { timeline: unknown[] }).timeline = [{ unexpected: true }];
    expect(() => parseBrowserExportEnvelope(badBrief)).toThrow();

    const mutateBrief = (change: (value: Record<string, unknown>) => void, message: RegExp) => {
      const copy = structuredClone(brief);
      change(copy);
      expect(() => parseBrowserExportEnvelope(copy)).toThrow(message);
    };
    mutateBrief((copy) => { ((copy.payload as { evidence: { bytesIncluded: boolean }[] }).evidence)[0]!.bytesIncluded = false; }, /included evidence bytes/);
    mutateBrief((copy) => { ((copy.payload as { importedRuns: { outputIncluded: boolean }[] }).importedRuns)[0]!.outputIncluded = false; }, /included imported response/);
    mutateBrief((copy) => {
      copy.privacyClass = "share_safe";
      (copy.payload as { privacyClass: string }).privacyClass = "share_safe";
    }, /owner-only evidence content/);
    mutateBrief((copy) => {
      copy.privacyClass = "share_safe";
      const payload = copy.payload as { privacyClass: string; evidence: { content: string | null; bytesIncluded: boolean }[] };
      payload.privacyClass = "share_safe";
      payload.evidence[0]!.content = "synthetic owner-only content";
      payload.evidence[0]!.bytesIncluded = true;
    }, /owner-only evidence content/);
    mutateBrief((copy) => {
      const payload = copy.payload as { resolution?: unknown };
      payload.resolution = {
        basis: "human_only", provenance: "human", revision: 1, actorLabel: "fixture",
        rationale: null, rationaleIncluded: false, unknownCount: 1,
        unknowns: ["synthetic private unknown"], occurredAt: null,
        occurredAtPrecision: "unknown", occurredAtZone: "unspecified",
        recordedAt: "2026-09-09T12:00:00.000Z",
      };
    }, /withheld resolution reasoning/);

    const pkg = envelope("package", fixture("prompt-package.valid.json")) as Record<string, unknown>;
    const mutate = (change: (value: Record<string, unknown>) => void) => {
      const copy = structuredClone(pkg);
      change(copy);
      expect(() => parseBrowserExportEnvelope(copy)).toThrow();
    };
    mutate((copy) => { copy.privacyClass = "owner_only"; });
    mutate((copy) => { (copy.payload as Record<string, unknown>).snapshotIdentity = "bad"; });
    mutate((copy) => { ((copy.payload as { manifest: { caseId: string } }).manifest).caseId = "wrong"; });
    mutate((copy) => { ((copy.payload as { manifest: { variant: string } }).manifest).variant = "owner_only"; });
    mutate((copy) => { ((copy.payload as { manifest: { items: { id: string }[] } }).manifest.items)[0]!.id = "wrong"; });
    mutate((copy) => { ((copy.payload as { excerpts: { content: string | null; bodyIncluded: boolean }[] }).excerpts)[0]!.bodyIncluded = false; });
    mutate((copy) => { ((copy.payload as { excerpts: { extra?: string }[] }).excerpts)[0]!.extra = "drift"; });
  });

  it("rejects malformed, duplicated, and mismatched inventory data", () => {
    const item = { kind: "artifact", id: "a1", label: "synthetic.log", privacyClass: "share_safe", contentHash: "hash", excludedByDefault: false };
    const valid = { schemaId: "cd-collab.export_inventory.v1", caseId: "case-1", items: [item] };
    expect(parseExportInventory(valid)).toEqual(valid);
    expect(() => parseExportInventory({ ...valid, items: [item, item] })).toThrow(/duplicate/);
    expect(() => parseExportInventory({ ...valid, items: [{ ...item, excludedByDefault: "false" }] })).toThrow();
    expect(() => parseExportInventory({ ...valid, caseId: "" })).toThrow(/case identity/);
    expect(() => parseExportInventory({ ...valid, items: [{ ...item, extra: true }] })).toThrow();
  });

  it("accepts an omitted sparse artifact while refusing an unhashed body", () => {
    const raw = envelope("package", fixture("prompt-package.valid.json")) as Record<string, unknown>;
    const pkg = raw.payload as {
      manifest: { items: { contentHash: string }[] };
      excerpts: { contentHash: string; content: string | null; bodyIncluded: boolean }[];
    };
    pkg.manifest.items[0]!.contentHash = "";
    pkg.excerpts[0]!.contentHash = "";
    pkg.excerpts[0]!.content = null;
    pkg.excerpts[0]!.bodyIncluded = false;
    expect(parseBrowserExportEnvelope(raw)).toEqual(raw);
    pkg.excerpts[0]!.content = "unhashed synthetic body";
    pkg.excerpts[0]!.bodyIncluded = true;
    expect(() => parseBrowserExportEnvelope(raw)).toThrow(/manifest and excerpt identity/);
  });

  it("uses platform-native containment for the graph on Windows-style paths", () => {
    const root = "C:\\repo\\contracts\\src";
    const inside = win32.relative(root, "C:\\repo\\contracts\\src\\brief.ts");
    const outside = win32.relative(root, "C:\\repo\\contracts\\server\\private.ts");
    expect(inside).toBe("brief.ts");
    expect(outside.startsWith(`..${win32.sep}`)).toBe(true);
  });

  it("publishes only the browser-safe entry for the export subpath", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(pkg.exports["./export"]).toEqual({
      types: "./dist/export-browser.d.ts",
      import: "./dist/export-browser.js",
    });
  });
});
