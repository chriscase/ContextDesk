import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_CATALOG_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(SOURCE_CATALOG_ROOT, "..");
const REPOSITORY_ROOT = resolve(WEB_SRC, "../../..");
const GATEWAY = resolve(SOURCE_CATALOG_ROOT, "gateway.ts");
const CONTROLLER = resolve(SOURCE_CATALOG_ROOT, "use-source-catalog.ts");
const CATALOG = resolve(WEB_SRC, "Catalog.tsx");

const PRODUCTION_MODULES = Object.freeze([GATEWAY, CONTROLLER, CATALOG]);
const APPROVED_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [GATEWAY]: Object.freeze([
    "@cd-collab/contracts/source-catalog",
    "../protected-api.js",
  ]),
  [CONTROLLER]: Object.freeze([
    "@cd-collab/contracts/source-catalog",
    "react",
    "./gateway.js",
  ]),
  [CATALOG]: Object.freeze([
    "@cd-collab/contracts/source-catalog",
    "react",
    "./source-catalog/gateway.js",
    "./source-catalog/use-source-catalog.js",
  ]),
});

interface ImportReference {
  readonly specifier: string;
  readonly line: number;
}

function repoPath(path: string): string {
  return relative(REPOSITORY_ROOT, path).split(sep).join("/");
}

function parse(path: string, sourceText = readFileSync(path, "utf8")): ts.SourceFile {
  return ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, callback: (candidate: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function importsOf(source: ts.SourceFile): ImportReference[] {
  const imports: ImportReference[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      imports.push({
        specifier: statement.moduleSpecifier.text,
        line: source.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
      });
    }
  }
  return imports;
}

function normalizedRoute(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return node.templateSpans.reduce(
    (route, span) => `${route}\${}${span.literal.text}`,
    node.head.text,
  );
}

function dynamicReference(node: ts.Node): string | null {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return "dynamic import()";
  }
  if (ts.isImportTypeNode(node)) return "import() type";
  if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "require"
  ) {
    return "require()";
  }
  if (
    ts.isPropertyAccessExpression(node)
    && ts.isMetaProperty(node.expression)
    && node.name.text === "resolve"
  ) {
    return "import.meta.resolve";
  }
  return null;
}

function violationsFor(path: string, source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const approved = APPROVED_IMPORTS[path] ?? [];
  const location = (node: ts.Node) =>
    `${repoPath(path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  for (const imported of importsOf(source)) {
    if (!approved.includes(imported.specifier)) {
      violations.push(
        `${repoPath(path)}:${imported.line} imports unapproved Source Catalog dependency ${imported.specifier}`,
      );
    }
    if (
      /(?:^|\/)(?:server|storage|admin|investigations\/runtime|investigations\/strategies)(?:\/|$)/u
        .test(imported.specifier)
    ) {
      violations.push(
        `${repoPath(path)}:${imported.line} crosses a server, storage, admin, runtime, or strategy boundary`,
      );
    }
    if (
      /(?:^|\/)protected-api(?:\.js)?$/u.test(imported.specifier)
      && path !== GATEWAY
    ) {
      violations.push(`${repoPath(path)}:${imported.line} imports protected-api outside gateway.ts`);
    }
  }

  visit(source, (node) => {
    const dynamic = dynamicReference(node);
    if (dynamic) {
      violations.push(`${location(node)} uses ${dynamic}, which the static boundary cannot review`);
    }

    if (
      ts.isIdentifier(node)
      && (node.text === "fetch" || node.text === "XMLHttpRequest")
    ) {
      violations.push(`${location(node)} references raw browser transport ${node.text}`);
    }

    const route = normalizedRoute(node);
    if (route === null || !route.startsWith("/api/")) return;
    if (path !== GATEWAY) {
      violations.push(`${location(node)} owns a raw API route outside gateway.ts`);
      return;
    }
    if (!/^\/api\/catalog\/sources(?:\/\$\{\}\/\$\{\})?$/u.test(route)) {
      violations.push(`${location(node)} owns an unrecognized Source Catalog API route ${route}`);
    }
  });

  return violations;
}

describe("Source Catalog Console dependency boundary", () => {
  it("keeps presentation, controller, and transport on one narrow dependency path", () => {
    expect(PRODUCTION_MODULES.map(repoPath)).toEqual([
      "collab/web/src/source-catalog/gateway.ts",
      "collab/web/src/source-catalog/use-source-catalog.ts",
      "collab/web/src/Catalog.tsx",
    ]);
    for (const path of PRODUCTION_MODULES) {
      expect(readFileSync(path, "utf8").length, repoPath(path)).toBeGreaterThan(0);
    }

    const violations = PRODUCTION_MODULES.flatMap((path) => violationsFor(path, parse(path)));
    expect(violations, violations.join("\n")).toEqual([]);

    const gatewaySource = parse(GATEWAY);
    const protectedImports = importsOf(gatewaySource).filter(({ specifier }) =>
      /(?:^|\/)protected-api(?:\.js)?$/u.test(specifier)
    );
    expect(protectedImports).toHaveLength(1);
    expect(readFileSync(GATEWAY, "utf8")).toContain("protectedApiFetch(");
    expect(readFileSync(CONTROLLER, "utf8")).not.toContain("/api/");
    expect(readFileSync(CATALOG, "utf8")).not.toContain("/api/");
  });

  it("fails closed for transport, private-layer, dynamic, and bare-alias bypasses", () => {
    const path = resolve(SOURCE_CATALOG_ROOT, "SyntheticBypass.tsx");
    const source = parse(path, [
      'import React from "react";',
      'import { protectedApiFetch } from "../protected-api.js";',
      'import { useInvestigationRuntime } from "../investigations/runtime/InvestigationRuntimeProvider.js";',
      'import { CaseService } from "@cd-collab/server/modules/cases";',
      'import { sourceCatalogGateway } from "@/source-catalog/gateway";',
      'import "../styles/admin.css";',
      'export const direct = () => fetch("/api/catalog/sources");',
      'export const lazy = () => import("./gateway.js");',
      'export const required = () => require("../storage/private.js");',
      'export const resolved = import.meta.resolve("../investigations/strategies/private.js");',
      'export const used = [React, protectedApiFetch, useInvestigationRuntime, CaseService, sourceCatalogGateway];',
    ].join("\n"));
    const violations = violationsFor(path, source).join("\n");

    for (const evidence of [
      "imports protected-api outside gateway.ts",
      "investigations/runtime/InvestigationRuntimeProvider.js",
      "@cd-collab/server/modules/cases",
      "@/source-catalog/gateway",
      "styles/admin.css",
      "raw browser transport fetch",
      "raw API route outside gateway.ts",
      "dynamic import()",
      "require()",
      "import.meta.resolve",
    ]) {
      expect(violations).toContain(evidence);
    }
  });

  it("rejects route ownership and protected transport from Catalog or its hook", () => {
    const catalogBypass = parse(CATALOG, [
      'import { protectedApiFetch } from "./protected-api.js";',
      'export const load = () => protectedApiFetch("/api/catalog/sources");',
    ].join("\n"));
    const hookBypass = parse(CONTROLLER, [
      'import { sourceCatalogGateway } from "./gateway.js";',
      'export const load = () => fetch("/api/catalog/sources");',
      'export const used = sourceCatalogGateway;',
    ].join("\n"));

    const violations = [
      ...violationsFor(CATALOG, catalogBypass),
      ...violationsFor(CONTROLLER, hookBypass),
    ].join("\n");
    expect(violations).toContain("imports protected-api outside gateway.ts");
    expect(violations).toContain("owns a raw API route outside gateway.ts");
    expect(violations).toContain("references raw browser transport fetch");
  });
});
