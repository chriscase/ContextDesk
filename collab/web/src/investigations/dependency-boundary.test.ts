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
  | "GET evidence"
  | "POST evidence"
  | "GET lifecycle"
  | "POST lifecycle";

/**
 * Runtime V1 deliberately leaves these existing War Room calls for later
 * panel-by-panel migration. Exact multisets make the waiver shrink-only: a
 * duplicate or newly covered call added to one of these modules fails.
 */
const LEGACY_WAR_ROOM_RUNTIME_CALLS: Readonly<
  Record<string, readonly CoveredRuntimeOperation[]>
> = Object.freeze({
  "collab/web/src/CaseBoardPanel.tsx": ["GET evidence", "POST evidence"],
  "collab/web/src/CaseDiscussion.tsx": ["GET contributions"],
  "collab/web/src/Cases.tsx": ["GET cases", "POST cases", "GET contributions"],
  "collab/web/src/ExperimentLab.tsx": ["GET evidence"],
  "collab/web/src/LifecyclePanel.tsx": ["GET lifecycle"],
  "collab/web/src/TriageRunPanel.tsx": ["GET evidence"],
});

/**
 * Temporary pre-Runtime V1 debt, kept separate so Investigation First is not
 * mistaken for legacy War Room. DELETE this entire entry as part of moving
 * InvestigationFirst.tsx behind runtime/public.ts. No strategy-directory
 * module is allowed here, now or later.
 */
const INVESTIGATION_FIRST_MIGRATION_DEBT: Readonly<
  Record<string, readonly CoveredRuntimeOperation[]>
> = Object.freeze({
  "collab/web/src/InvestigationFirst.tsx": [
    "GET case",
    "GET cases",
    "POST cases",
    "GET contributions",
    "GET evidence",
    "POST evidence",
  ],
});

const EXPECTED_COVERED_OPERATION_DEBT: Readonly<
  Record<string, readonly CoveredRuntimeOperation[]>
> = Object.freeze({
  ...LEGACY_WAR_ROOM_RUNTIME_CALLS,
  ...INVESTIGATION_FIRST_MIGRATION_DEBT,
});

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
  if (/^\/api\/cases\/\$\{\}\/contributions$/.test(route) && method === "GET") {
    return "GET contributions";
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
  const observed: Record<string, CoveredRuntimeOperation[]> = {};

  for (const { path, source } of sources) {
    if (sameModule(path, gatewayModule)) continue;
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

function strategyRouteViolations(path: string, source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const fetchNames = protectedFetchNames(source);
  visit(source, (node) => {
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
    const runtimeRoot = resolve(INVESTIGATIONS_ROOT, "runtime");
    const strategiesRoot = resolve(INVESTIGATIONS_ROOT, "strategies");
    const publicModule = resolve(runtimeRoot, "public");
    const gatewayModule = resolve(runtimeRoot, "gateway");
    const contractModule = resolve(strategiesRoot, "contract");

    for (const path of sourceFiles(INVESTIGATIONS_ROOT).filter((file) => !isTestOnly(file))) {
      const source = parseSource(path);
      const relativeInvestigationPath = relative(INVESTIGATIONS_ROOT, path).split(sep).join("/");
      const inRuntime = relativeInvestigationPath.startsWith("runtime/");
      const strategyMatch = /^strategies\/([^/]+)\//.exec(relativeInvestigationPath);
      const strategyId = strategyMatch?.[1] ?? null;

      for (const imported of importsOf(source)) {
        const resolvedModule = modulePath(path, imported.module);
        const location = `${repositoryPath(path)}:${imported.line}`;
        const importsProtectedApi = /(?:^|\/)protected-api(?:\.js)?$/.test(imported.module);

        if (importsProtectedApi && !sameModule(path, gatewayModule)) {
          violations.push(`${location} imports protected-api outside runtime/gateway.ts`);
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

        if (relativeInvestigationPath.startsWith("strategies/")) {
          if (/collab\/server|(?:^|\/)server(?:\/|$)/.test(imported.module)) {
            violations.push(`${location} imports a server module from a strategy`);
          }
          if (
            resolvedModule &&
            sameModule(resolvedModule, gatewayModule)
          ) {
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

          if (!isOwnModule && !isPublicRuntime && !isStrategyContract) {
            violations.push(
              `${location} imports investigation behavior outside runtime/public.ts or strategies/contract.ts`,
            );
          }
        }
      }

      if (relativeInvestigationPath.startsWith("strategies/")) {
        violations.push(...strategyRouteViolations(path, source));
      }
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

    expect(
      Object.keys(INVESTIGATION_FIRST_MIGRATION_DEBT),
      "Delete the temporary Investigation First debt entry when its root module moves behind runtime/public.ts",
    ).toEqual(["collab/web/src/InvestigationFirst.tsx"]);
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
});
