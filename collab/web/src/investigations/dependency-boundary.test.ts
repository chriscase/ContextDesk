import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const INVESTIGATIONS_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(INVESTIGATIONS_ROOT, "..");
const REPOSITORY_ROOT = resolve(WEB_SRC, "../../..");

type CoveredRuntimeOperation =
  | "GET case"
  | "GET cases"
  | "POST cases"
  | "GET contributions"
  | "POST contributions"
  | "GET evidence"
  | "POST evidence"
  | "GET lifecycle"
  | "POST lifecycle"
  | "PATCH situation";

/**
 * Runtime V1 deliberately leaves these existing War Room calls for later
 * panel-by-panel migration. Exact multisets make the waiver shrink-only: a
 * duplicate or newly covered call added to one of these modules fails.
 */
const LEGACY_WAR_ROOM_RUNTIME_CALLS: Readonly<
  Record<string, readonly CoveredRuntimeOperation[]>
> = Object.freeze({
  "collab/web/src/CaseBoardPanel.tsx": ["GET evidence"],
  "collab/web/src/CaseDiscussion.tsx": ["GET contributions", "POST contributions"],
  "collab/web/src/Cases.tsx": [
    "GET cases",
    "POST cases",
    "GET contributions",
    "POST contributions",
    "PATCH situation",
  ],
  "collab/web/src/ExperimentLab.tsx": ["GET evidence"],
  "collab/web/src/TriageRunPanel.tsx": ["GET evidence"],
});

const EXPECTED_COVERED_OPERATION_DEBT: Readonly<
  Record<string, readonly CoveredRuntimeOperation[]>
> = LEGACY_WAR_ROOM_RUNTIME_CALLS;

interface SourceUnderReview {
  readonly path: string;
  readonly source: ts.SourceFile;
}

function repositoryPath(path: string): string {
  return relative(REPOSITORY_ROOT, path).split(sep).join("/");
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

function isTestOnly(path: string): boolean {
  const normalized = path.split(sep).join("/");
  return /\.(?:test|spec)\.tsx?$/.test(normalized) || normalized.includes("/testkit/");
}

function parseSourceText(path: string, sourceText: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
}

function parseSource(path: string): ts.SourceFile {
  return parseSourceText(path, readFileSync(path, "utf8"));
}

function visit(node: ts.Node, callback: (candidate: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function normalizedRoute(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isTemplateExpression(expression)) return null;
  return expression.templateSpans.reduce(
    (route, span) => `${route}\${}${span.literal.text}`,
    expression.head.text,
  );
}

function requestMethod(call: ts.CallExpression): string {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return "GET";
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText().replaceAll(/["']/g, "") === "method" &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer.text.toUpperCase();
    }
  }
  return "GET";
}

function protectedFetchNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !/(?:^|\/)protected-api(?:\.js)?$/.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if ((binding.propertyName?.text ?? binding.name.text) === "protectedApiFetch") {
        names.add(binding.name.text);
      }
    }
  }
  return names;
}

function coveredOperation(
  call: ts.CallExpression,
  fetchNames: ReadonlySet<string> = new Set(["protectedApiFetch"]),
): CoveredRuntimeOperation | null {
  if (!ts.isIdentifier(call.expression) || !fetchNames.has(call.expression.text)) {
    return null;
  }
  const routeArgument = call.arguments[0];
  if (!routeArgument) return null;
  const route = normalizedRoute(routeArgument);
  if (route === null) return null;
  const method = requestMethod(call);

  if (route === "/api/cases" && (method === "GET" || method === "POST")) {
    return `${method} cases`;
  }
  if (/^\/api\/cases\/\$\{\}$/.test(route) && method === "GET") return "GET case";
  if (/^\/api\/cases\/\$\{\}\/evidence$/.test(route)) {
    if (method === "GET" || method === "POST") return `${method} evidence`;
  }
  if (/^\/api\/cases\/\$\{\}\/contributions$/.test(route)) {
    if (method === "GET" || method === "POST") return `${method} contributions`;
  }
  if (/^\/api\/cases\/\$\{\}\/situation$/.test(route) && method === "PATCH") {
    return "PATCH situation";
  }
  if (/^\/api\/cases\/\$\{\}\/lifecycle$/.test(route)) {
    if (method === "GET" || method === "POST") return `${method} lifecycle`;
  }
  return null;
}

function coveredOperationDebt(sources: readonly SourceUnderReview[]): Record<
  string,
  CoveredRuntimeOperation[]
> {
  const gatewayModule = resolve(INVESTIGATIONS_ROOT, "runtime/gateway");
  // Overview is a shell-owned product surface, not an investigation strategy.
  // Its reviewed gateway is the only other transport boundary allowed to read
  // the collection; keeping the exemption to this exact module prevents a
  // presentation component from becoming another data-access path.
  const overviewGatewayModule = resolve(WEB_SRC, "overview/gateway");
  const observed: Record<string, CoveredRuntimeOperation[]> = {};

  for (const { path, source } of sources) {
    if (sameModule(path, gatewayModule) || sameModule(path, overviewGatewayModule)) continue;
    const fetchNames = protectedFetchNames(source);
    const calls: CoveredRuntimeOperation[] = [];
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const operation = coveredOperation(node, fetchNames);
      if (operation) calls.push(operation);
    });
    if (calls.length > 0) observed[repositoryPath(path)] = calls.sort();
  }
  return observed;
}

function debtDrift(
  observed: Readonly<Record<string, readonly CoveredRuntimeOperation[]>>,
  expected: Readonly<Record<string, readonly CoveredRuntimeOperation[]>>,
): string[] {
  const paths = [...new Set([...Object.keys(observed), ...Object.keys(expected)])].sort();
  const violations: string[] = [];
  for (const path of paths) {
    const actualCalls = [...(observed[path] ?? [])].sort();
    const expectedCalls = [...(expected[path] ?? [])].sort();
    if (JSON.stringify(actualCalls) !== JSON.stringify(expectedCalls)) {
      violations.push(
        `${path}: expected [${expectedCalls.join(", ")}], observed [${actualCalls.join(", ")}]`,
      );
    }
  }
  return violations;
}

function importsOf(source: ts.SourceFile): { module: string; line: number }[] {
  const imports: { module: string; line: number }[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      imports.push({
        module: statement.moduleSpecifier.text,
        line: source.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
      });
    }
  }
  return imports;
}

function modulePath(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const absolute = resolve(dirname(importer), specifier);
  if (absolute.endsWith(".js")) return absolute.slice(0, -3);
  if (absolute.endsWith(".jsx")) return absolute.slice(0, -4);
  return absolute;
}

function sameModule(path: string, expectedWithoutExtension: string): boolean {
  const withoutExtension = path.replace(/\.(?:ts|tsx)$/, "");
  return withoutExtension === expectedWithoutExtension;
}

const RESERVED_BROWSER_TRANSPORT_NAMES = new Set(["fetch", "XMLHttpRequest"]);

function reservedBrowserTransportReference(node: ts.Node): string | null {
  // Strategies have zero direct browser-transport authority. Reserve the exact
  // identifier and string-literal names anywhere in strategy source, even when
  // they are merely referenced or extracted, so aliases and indirect property
  // access cannot hide a later call. This deliberately also rejects an unrelated
  // local identifier, property, or exact string named `fetch` or
  // `XMLHttpRequest`; use a non-reserved name for local behavior and copy.
  if (ts.isIdentifier(node) && RESERVED_BROWSER_TRANSPORT_NAMES.has(node.text)) {
    return node.text;
  }
  if (
    ts.isStringLiteralLike(node)
    && RESERVED_BROWSER_TRANSPORT_NAMES.has(node.text)
  ) {
    return node.text;
  }
  return null;
}

/**
 * Bare specifiers each investigation layer may name.
 *
 * A relative import is checked by resolving it; a bare or aliased one is not
 * resolvable here, so it would otherwise pass unexamined. React is the
 * rendering substrate for both layers. Contract DTOs stay a runtime concern:
 * a strategy receives them through `runtime/public.ts`, so a presentation
 * layer never pins itself to a wire contract the runtime is free to reshape,
 * and never reaches a package the boundary has not reviewed.
 */
const APPROVED_BARE_IMPORTS: Readonly<Record<InvestigationLayer, readonly string[]>> =
  Object.freeze({
    runtime: ["react", "@cd-collab/contracts"],
    strategy: ["react"],
  });

type InvestigationLayer = "runtime" | "strategy";

function approvedBareImport(specifier: string, layer: InvestigationLayer): boolean {
  return APPROVED_BARE_IMPORTS[layer].some(
    (approved) => specifier === approved || specifier.startsWith(`${approved}/`),
  );
}

/**
 * Every module reference this boundary cannot resolve statically.
 *
 * The one-way dependency path above is a static property of the import graph.
 * A dynamic `import()`, a `require()`, an `import()` type, or an
 * `import.meta.resolve` names a module the graph never shows, so each is
 * rejected outright rather than analysed. No investigation module needs one.
 */
function dynamicModuleReferences(
  source: ts.SourceFile,
): { form: string; line: number }[] {
  const found: { form: string; line: number }[] = [];
  visit(source, (node) => {
    const at = () => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push({ form: "a dynamic import()", line: at() });
      return;
    }
    if (ts.isImportTypeNode(node)) {
      found.push({ form: "an import() type", line: at() });
      return;
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
    ) {
      found.push({ form: "a require()", line: at() });
      return;
    }
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isMetaProperty(node.expression)
      && node.name.text === "resolve"
    ) {
      found.push({ form: "an import.meta.resolve", line: at() });
    }
  });
  return found;
}

const TESTKIT_SEGMENT = /(?:^|\/)testkit(?:\/|$)/;

/**
 * A testkit mounts transport doubles and imports a test runner. Production
 * source must never reach one, in this package or any other, so the check
 * covers the resolved path and the written specifier alike.
 */
function testkitImportViolations(path: string, source: ts.SourceFile): string[] {
  const roots = [
    resolve(INVESTIGATIONS_ROOT, "runtime/testkit"),
    resolve(INVESTIGATIONS_ROOT, "strategies/testkit"),
  ];
  const violations: string[] = [];
  for (const imported of importsOf(source)) {
    const resolvedModule = modulePath(path, imported.module);
    const insideTestkit = resolvedModule !== null
      && roots.some(
        (root) => resolvedModule === root || resolvedModule.startsWith(`${root}${sep}`),
      );
    if (insideTestkit || TESTKIT_SEGMENT.test(imported.module)) {
      violations.push(
        `${repositoryPath(path)}:${imported.line} imports the test-only testkit ${imported.module} from production source`,
      );
    }
  }
  return violations;
}

/**
 * Every import rule that applies to one investigation module, in source order,
 * with dynamic references reported last.
 */
function investigationImportViolations(path: string, source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const runtimeRoot = resolve(INVESTIGATIONS_ROOT, "runtime");
  const strategiesRoot = resolve(INVESTIGATIONS_ROOT, "strategies");
  const publicModule = resolve(runtimeRoot, "public");
  const gatewayModule = resolve(runtimeRoot, "gateway");
  const contractModule = resolve(strategiesRoot, "contract");
  const sharedRoot = resolve(strategiesRoot, "shared");
  const sharedIndexModule = resolve(sharedRoot, "index");
  const runtimeHandoffModule = resolve(strategiesRoot, "runtime-handoff");
  const collectionQueryAdapterModule = resolve(strategiesRoot, "collection-query");

  const relativeInvestigationPath = relative(INVESTIGATIONS_ROOT, path).split(sep).join("/");
  const inRuntime = relativeInvestigationPath.startsWith("runtime/");
  const inStrategies = relativeInvestigationPath.startsWith("strategies/");
  const layer: InvestigationLayer = inStrategies ? "strategy" : "runtime";
  const strategyMatch = /^strategies\/([^/]+)\//.exec(relativeInvestigationPath);
  const strategyId = strategyMatch?.[1] ?? null;

  for (const imported of importsOf(source)) {
    const resolvedModule = modulePath(path, imported.module);
    const location = `${repositoryPath(path)}:${imported.line}`;
    const importsProtectedApi = /(?:^|\/)protected-api(?:\.js)?$/.test(imported.module);

    if (importsProtectedApi && !sameModule(path, gatewayModule)) {
      violations.push(`${location} imports protected-api outside runtime/gateway.ts`);
    }

    if (
      !imported.module.startsWith(".")
      && !approvedBareImport(imported.module, layer)
    ) {
      violations.push(
        `${location} imports ${imported.module}, which is not an approved ${layer} dependency`,
      );
    }

    if (inRuntime) {
      if (imported.module.endsWith(".css")) {
        violations.push(`${location} imports CSS from runtime`);
      }
      if (resolvedModule && sameModule(resolvedModule, resolve(WEB_SRC, "App"))) {
        violations.push(`${location} imports App.tsx from runtime`);
      }
      if (
        resolvedModule &&
        (resolvedModule === strategiesRoot || resolvedModule.startsWith(`${strategiesRoot}${sep}`))
      ) {
        violations.push(`${location} imports a strategy from runtime`);
      }
    }

    if (inStrategies) {
      if (/collab\/server|(?:^|\/)server(?:\/|$)/.test(imported.module)) {
        violations.push(`${location} imports a server module from a strategy`);
      }
      if (resolvedModule && sameModule(resolvedModule, gatewayModule)) {
        violations.push(`${location} imports runtime/gateway directly from a strategy`);
      }
    }

    if (strategyId && strategyId !== "testkit" && resolvedModule) {
      const ownStrategyRoot = resolve(strategiesRoot, strategyId);
      const isOwnModule =
        resolvedModule === ownStrategyRoot ||
        resolvedModule.startsWith(`${ownStrategyRoot}${sep}`);
      const isPublicRuntime = sameModule(resolvedModule, publicModule);
      const isStrategyContract = sameModule(resolvedModule, contractModule);
      const isSharedIndex = sameModule(resolvedModule, sharedIndexModule);
      const isRuntimeHandoffAdapter = sameModule(resolvedModule, runtimeHandoffModule);
      const isCollectionQueryAdapter = sameModule(resolvedModule, collectionQueryAdapterModule);

      if (
        strategyId === "shared"
        && !isOwnModule
      ) {
        violations.push(
          `${location} imports authority or strategy behavior into the presentation-only shared kit`,
        );
        continue;
      }

      if (
        !isOwnModule
        && !isPublicRuntime
        && !isStrategyContract
        && !isSharedIndex
        && !isRuntimeHandoffAdapter
        && !isCollectionQueryAdapter
      ) {
        violations.push(
          `${location} imports investigation behavior outside runtime/public.ts, strategies/contract.ts, the exact shared/index.ts presentation surface, or the reviewed runtime-handoff adapter`,
        );
      }
    }
  }

  for (const reference of dynamicModuleReferences(source)) {
    violations.push(
      `${repositoryPath(path)}:${reference.line} resolves a module through ${reference.form}, which the static investigation boundary cannot review`,
    );
  }

  return violations;
}

function strategyRouteViolations(path: string, source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const fetchNames = protectedFetchNames(source);
  visit(source, (node) => {
    const reservedTransport = reservedBrowserTransportReference(node);
    if (reservedTransport) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      violations.push(
        `${repositoryPath(path)}:${line} references reserved browser transport ${reservedTransport} from a strategy`,
      );
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (fetchNames.has(node.expression.text)) {
        const routeArgument = node.arguments[0];
        const route = routeArgument ? normalizedRoute(routeArgument) : null;
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (route === null) {
          violations.push(
            `${repositoryPath(path)}:${line} uses a dynamic protectedApiFetch route in a strategy`,
          );
        } else if (coveredOperation(node, fetchNames) === null) {
          violations.push(
            `${repositoryPath(path)}:${line} uses an unrecognized protectedApiFetch route in a strategy`,
          );
        }
      }
    }

    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      normalizedRoute(node) !== null &&
      /\/api\/(?:cases|investigation)/.test(normalizedRoute(node) ?? "")
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      violations.push(`${repositoryPath(path)}:${line} contains a raw investigation API route`);
    }
  });
  return violations;
}

describe("Investigation Runtime V1 dependency boundary", () => {
  it("keeps runtime and strategies on the public one-way dependency path", () => {
    const violations: string[] = [];

    for (const path of sourceFiles(INVESTIGATIONS_ROOT).filter((file) => !isTestOnly(file))) {
      const source = parseSource(path);
      const relativeInvestigationPath = relative(INVESTIGATIONS_ROOT, path).split(sep).join("/");

      violations.push(...investigationImportViolations(path, source));
      if (relativeInvestigationPath.startsWith("strategies/")) {
        violations.push(...strategyRouteViolations(path, source));
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("keeps every testkit out of production source across the web package", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(WEB_SRC).filter((file) => !isTestOnly(file))) {
      violations.push(...testkitImportViolations(path, parseSource(path)));
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("holds every covered endpoint outside the gateway to its exact migration debt", () => {
    const sources = sourceFiles(WEB_SRC)
      .filter((path) => !isTestOnly(path))
      .map((path) => ({ path, source: parseSource(path) }));
    const drift = debtDrift(
      coveredOperationDebt(sources),
      EXPECTED_COVERED_OPERATION_DEBT,
    );

    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("rejects a synthetic covered-route bypass and opaque strategy routes", () => {
    const unexpectedPath = resolve(WEB_SRC, "UnexpectedRuntimeBypass.ts");
    const unexpectedSource = parseSourceText(
      unexpectedPath,
      'import { protectedApiFetch as fetchProtected } from "./protected-api.js";\nexport const bypass = () => fetchProtected("/api/cases");',
    );
    const drift = debtDrift(
      coveredOperationDebt([{ path: unexpectedPath, source: unexpectedSource }]),
      {},
    );
    expect(drift).toEqual([
      "collab/web/src/UnexpectedRuntimeBypass.ts: expected [], observed [GET cases]",
    ]);

    const strategyPath = resolve(INVESTIGATIONS_ROOT, "strategies/example/Example.tsx");
    const dynamicStrategy = parseSourceText(
      strategyPath,
      [
        'import { protectedApiFetch as fetchProtected } from "../../../protected-api.js";',
        "export const load = (route: string) => fetchProtected(route);",
        'export const loadSession = () => fetchProtected("/api/session");',
      ].join("\n"),
    );
    expect(strategyRouteViolations(strategyPath, dynamicStrategy)).toEqual([
      "collab/web/src/investigations/strategies/example/Example.tsx:2 uses a dynamic protectedApiFetch route in a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:3 uses an unrecognized protectedApiFetch route in a strategy",
    ]);
  });

  it("rejects direct browser transports and aliases at their source", () => {
    const strategyPath = resolve(INVESTIGATIONS_ROOT, "strategies/example/Example.tsx");
    const source = parseSourceText(
      strategyPath,
      [
        "export const direct = (route: string) => fetch(route);",
        "const send = globalThis.fetch;",
        "const { fetch: destructuredSend } = globalThis;",
        "export const memberCall = (route: string) => globalThis.fetch.call(globalThis, route);",
        'const parenthesized = (window["fetch"]);',
        "const XhrAlias = globalThis.XMLHttpRequest;",
        'const ComputedXhrAlias = window["XMLHttpRequest"];',
        'const key = "fetch";',
        "const variableKeyAlias = globalThis[key];",
        'const reflectedXhr = Reflect.get(globalThis, "XMLHttpRequest");',
        'const quotedObject = { "fetch": send };',
        'const computedObject = { ["fetch"]: send };',
        'const { "XMLHttpRequest": quotedXhr } = globalThis;',
        "export const aliases = [send, destructuredSend, parenthesized, XhrAlias, ComputedXhrAlias, variableKeyAlias, reflectedXhr, quotedObject, computedObject, quotedXhr];",
      ].join("\n"),
    );

    expect(strategyRouteViolations(strategyPath, source)).toEqual([
      "collab/web/src/investigations/strategies/example/Example.tsx:1 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:2 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:3 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:4 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:5 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:6 references reserved browser transport XMLHttpRequest from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:7 references reserved browser transport XMLHttpRequest from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:8 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:10 references reserved browser transport XMLHttpRequest from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:11 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:12 references reserved browser transport fetch from a strategy",
      "collab/web/src/investigations/strategies/example/Example.tsx:13 references reserved browser transport XMLHttpRequest from a strategy",
    ]);
  });

  it("allows protected runtime transport names and ordinary words containing fetch", () => {
    const strategyPath = resolve(INVESTIGATIONS_ROOT, "strategies/example/Example.tsx");
    const source = parseSourceText(
      strategyPath,
      [
        'import { useInvestigationRuntime } from "../../runtime/public.js";',
        "const protectedApiFetch = useInvestigationRuntime;",
        "const prefetchLabel = \"Prefetch investigation\";",
        "const fetchingLabel = \"fetch later\";",
        "const xhrLabel = \"XMLHttpRequest wrapper\";",
        "export const clean = [protectedApiFetch, prefetchLabel, fetchingLabel, xhrLabel];",
      ].join("\n"),
    );

    expect(strategyRouteViolations(strategyPath, source)).toEqual([]);
  });

  it("deliberately reserves exact transport names even for unrelated local declarations", () => {
    const strategyPath = resolve(INVESTIGATIONS_ROOT, "strategies/example/Example.tsx");
    const source = parseSourceText(
      strategyPath,
      "export const fetch = () => 'local-only';",
    );

    expect(strategyRouteViolations(strategyPath, source)).toEqual([
      "collab/web/src/investigations/strategies/example/Example.tsx:1 references reserved browser transport fetch from a strategy",
    ]);
  });

  it("rejects dynamic module resolution and unapproved bare or alias imports", () => {
    const strategyPath = resolve(INVESTIGATIONS_ROOT, "strategies/example/Example.tsx");
    const source = parseSourceText(
      strategyPath,
      [
        'import { useInvestigationRuntime } from "../../runtime/public.js";',
        'import type { InvestigationStrategyShellProps } from "../contract.js";',
        'import { useState } from "react";',
        'import { parseCase } from "@cd-collab/contracts/investigation-runtime";',
        'import secret from "@/secret";',
        'import helper from "#internal/helper";',
        'import legacy from "src/legacy.js";',
        'export * from "node:fs";',
        'export const lazy = () => import("./Lazy.js");',
        'export const legacyLoad = () => require("./Legacy.js");',
        'export const resolved = () => import.meta.resolve("./Late.js");',
        "export type Late = import(\"./Late.js\").Late;",
        "export const used = [useInvestigationRuntime, useState, parseCase, secret, helper, legacy];",
        "export type Props = InvestigationStrategyShellProps;",
      ].join("\n"),
    );

    const prefix = "collab/web/src/investigations/strategies/example/Example.tsx";
    expect(investigationImportViolations(strategyPath, source)).toEqual([
      `${prefix}:4 imports @cd-collab/contracts/investigation-runtime, which is not an approved strategy dependency`,
      `${prefix}:5 imports @/secret, which is not an approved strategy dependency`,
      `${prefix}:6 imports #internal/helper, which is not an approved strategy dependency`,
      `${prefix}:7 imports src/legacy.js, which is not an approved strategy dependency`,
      `${prefix}:8 imports node:fs, which is not an approved strategy dependency`,
      `${prefix}:9 resolves a module through a dynamic import(), which the static investigation boundary cannot review`,
      `${prefix}:10 resolves a module through a require(), which the static investigation boundary cannot review`,
      `${prefix}:11 resolves a module through an import.meta.resolve, which the static investigation boundary cannot review`,
      `${prefix}:12 resolves a module through an import() type, which the static investigation boundary cannot review`,
    ]);
  });

  it("allows the approved public imports each investigation layer actually needs", () => {
    const strategyPath = resolve(INVESTIGATIONS_ROOT, "strategies/example/Example.tsx");
    const strategy = parseSourceText(
      strategyPath,
      [
        'import { useEffect, type FormEvent } from "react";',
        'import { selectResourceView, useInvestigationRuntime } from "../../runtime/public.js";',
        'import type { InvestigationStrategyShellProps } from "../contract.js";',
        'import { helper } from "./helper.js";',
        "export const used = [useEffect, selectResourceView, useInvestigationRuntime, helper];",
        "export type Props = InvestigationStrategyShellProps & { submit: FormEvent };",
      ].join("\n"),
    );
    expect(investigationImportViolations(strategyPath, strategy)).toEqual([]);

    const runtimePath = resolve(INVESTIGATIONS_ROOT, "runtime/example.ts");
    const runtime = parseSourceText(
      runtimePath,
      [
        'import { useMemo } from "react";',
        'import { parseCase } from "@cd-collab/contracts/investigation-runtime";',
        'export { selectResourceView } from "./selectors.js";',
        "export const used = [useMemo, parseCase];",
      ].join("\n"),
    );
    expect(investigationImportViolations(runtimePath, runtime)).toEqual([]);
  });

  it("allows only the exact shared presentation surface and keeps the kit authority-free", () => {
    const keystonePath = resolve(
      INVESTIGATIONS_ROOT,
      "strategies/keystone/KeystoneStrategy.tsx",
    );
    const approvedStrategy = parseSourceText(
      keystonePath,
      [
        'import { useInvestigationRuntime } from "../../runtime/public.js";',
        'import type { InvestigationStrategyShellProps } from "../contract.js";',
        'import { StrategyPanel } from "../shared/index.js";',
        'import { RuntimeHandoffPanel } from "../runtime-handoff.js";',
        'import { localModel } from "./model.js";',
        "export const used = [useInvestigationRuntime, StrategyPanel, RuntimeHandoffPanel, localModel];",
        "export type Props = InvestigationStrategyShellProps;",
      ].join("\n"),
    );
    expect(investigationImportViolations(keystonePath, approvedStrategy)).toEqual([]);

    const privateSharedImport = parseSourceText(
      keystonePath,
      'import { StrategyPanel } from "../shared/presentation.js";\nexport { StrategyPanel };',
    );
    expect(investigationImportViolations(keystonePath, privateSharedImport)).toEqual([
      "collab/web/src/investigations/strategies/keystone/KeystoneStrategy.tsx:1 imports investigation behavior outside runtime/public.ts, strategies/contract.ts, the exact shared/index.ts presentation surface, or the reviewed runtime-handoff adapter",
    ]);

    const sharedPath = resolve(
      INVESTIGATIONS_ROOT,
      "strategies/shared/presentation.tsx",
    );
    const authorityImports = parseSourceText(
      sharedPath,
      [
        'import { useInvestigationRuntime } from "../../runtime/public.js";',
        'import type { InvestigationStrategyShellProps } from "../contract.js";',
        'import { KeystoneStrategy } from "../keystone/KeystoneStrategy.js";',
        "export const used = [useInvestigationRuntime, KeystoneStrategy];",
        "export type Props = InvestigationStrategyShellProps;",
      ].join("\n"),
    );
    expect(investigationImportViolations(sharedPath, authorityImports)).toEqual([
      "collab/web/src/investigations/strategies/shared/presentation.tsx:1 imports authority or strategy behavior into the presentation-only shared kit",
      "collab/web/src/investigations/strategies/shared/presentation.tsx:2 imports authority or strategy behavior into the presentation-only shared kit",
      "collab/web/src/investigations/strategies/shared/presentation.tsx:3 imports authority or strategy behavior into the presentation-only shared kit",
    ]);
  });

  it("rejects a production import of either testkit and allows test-only use", () => {
    const productionPath = resolve(WEB_SRC, "App.tsx");
    const production = parseSourceText(
      productionPath,
      [
        'import { createInvestigationGatewayDouble } from "./investigations/runtime/testkit/index.js";',
        'import { runComponentConformance } from "./investigations/strategies/testkit/conformance.js";',
        'import { makeCaseList } from "@cd-collab/contracts/testkit";',
        'import { App } from "./AppShell.js";',
        "export const used = [createInvestigationGatewayDouble, runComponentConformance, makeCaseList, App];",
      ].join("\n"),
    );

    expect(testkitImportViolations(productionPath, production)).toEqual([
      "collab/web/src/App.tsx:1 imports the test-only testkit ./investigations/runtime/testkit/index.js from production source",
      "collab/web/src/App.tsx:2 imports the test-only testkit ./investigations/strategies/testkit/conformance.js from production source",
      "collab/web/src/App.tsx:3 imports the test-only testkit @cd-collab/contracts/testkit from production source",
    ]);

    // The shipped conformance kit lives inside a testkit directory, so the
    // production scan never reaches it and its own imports stay legal.
    expect(
      isTestOnly(resolve(INVESTIGATIONS_ROOT, "strategies/testkit/conformance.tsx")),
      "the strategies testkit must be classified test-only",
    ).toBe(true);
    expect(
      sourceFiles(WEB_SRC).filter((file) => !isTestOnly(file)).some(
        (file) => file.split(sep).join("/").includes("/testkit/"),
      ),
      "a testkit module was scanned as production source",
    ).toBe(false);
  });
});
