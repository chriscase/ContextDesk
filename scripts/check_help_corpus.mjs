#!/usr/bin/env node
/**
 * Validate the curated, bundled Help corpus (#436).
 *
 * This intentionally supports only the frontmatter subset documented in
 * docs/design/HELP_CENTER.md. Keeping the parser narrow makes author mistakes
 * fail closed without adding a runtime/package dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HELP_SECTIONS = new Set([
  "overview",
  "getting-started",
  "providers",
  "chat-context",
  "workspace-indexing",
  "permissions",
  "memory",
  "log-analysis",
  "connectors",
  "backup",
  "skills",
  "settings",
  "security",
  "troubleshooting",
  "reference",
]);

const REQUIRED_FIELDS = new Set([
  "id",
  "title",
  "summary",
  "section",
  "tags",
  "order",
  "related",
]);
const ARRAY_FIELDS = new Set(["tags", "related"]);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024;

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseHelpFrontmatter(raw, source = "<memory>") {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${source}: frontmatter must start on the first line`);
  }
  const close = lines.indexOf("---", 1);
  if (close < 0) {
    throw new Error(`${source}: unterminated frontmatter`);
  }

  const meta = {};
  let arrayKey = null;
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s{2}-\s+(.+?)\s*$/);
    if (item) {
      if (!arrayKey) {
        throw new Error(`${source}:${i + 1}: array item without an array field`);
      }
      meta[arrayKey].push(unquote(item[1]));
      continue;
    }
    const entry = line.match(/^([a-z][a-z0-9_-]*):(?:\s*(.*))?$/);
    if (!entry) {
      throw new Error(`${source}:${i + 1}: unsupported frontmatter syntax`);
    }
    const [, key, rawValue = ""] = entry;
    if (!REQUIRED_FIELDS.has(key)) {
      throw new Error(`${source}:${i + 1}: unknown frontmatter field '${key}'`);
    }
    if (Object.hasOwn(meta, key)) {
      throw new Error(`${source}:${i + 1}: duplicate frontmatter field '${key}'`);
    }
    if (ARRAY_FIELDS.has(key)) {
      if (rawValue === "[]") {
        meta[key] = [];
        arrayKey = null;
      } else if (rawValue === "") {
        meta[key] = [];
        arrayKey = key;
      } else {
        throw new Error(
          `${source}:${i + 1}: '${key}' must use an indented list or []`,
        );
      }
    } else {
      if (!rawValue.trim()) {
        throw new Error(`${source}:${i + 1}: '${key}' must not be empty`);
      }
      meta[key] = key === "order" ? Number(rawValue) : unquote(rawValue);
      arrayKey = null;
    }
  }

  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(meta, key)) {
      throw new Error(`${source}: missing frontmatter field '${key}'`);
    }
  }
  return { meta, body: lines.slice(close + 1).join("\n") };
}

function assertPlainText(value, field, max, source) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > max ||
    /[\r\n<>]/.test(value)
  ) {
    throw new Error(`${source}: invalid ${field}`);
  }
}

function validateMetadata(meta, source) {
  if (!ID_RE.test(meta.id)) {
    throw new Error(`${source}: invalid id '${meta.id}'`);
  }
  assertPlainText(meta.title, "title", 120, source);
  assertPlainText(meta.summary, "summary", 240, source);
  if (!HELP_SECTIONS.has(meta.section)) {
    throw new Error(`${source}: unknown section '${meta.section}'`);
  }
  if (!Number.isSafeInteger(meta.order) || meta.order < 0) {
    throw new Error(`${source}: order must be a non-negative integer`);
  }
  if (
    !Array.isArray(meta.tags) ||
    meta.tags.length === 0 ||
    meta.tags.length > 20
  ) {
    throw new Error(`${source}: tags must contain 1-20 values`);
  }
  for (const [field, values] of [
    ["tags", meta.tags],
    ["related", meta.related],
  ]) {
    if (!Array.isArray(values) || new Set(values).size !== values.length) {
      throw new Error(`${source}: ${field} must contain unique values`);
    }
    for (const value of values) {
      if (!ID_RE.test(value)) {
        throw new Error(`${source}: invalid ${field} value '${value}'`);
      }
    }
  }
}

function validateHeadingStructure(body, meta, source) {
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const h1 = headings.filter((match) => match[1].length === 1);
  if (h1.length !== 1 || h1[0][2] !== meta.title) {
    throw new Error(`${source}: body must contain exactly one H1 equal to title`);
  }
  let previous = 1;
  for (const heading of headings.slice(1)) {
    const level = heading[1].length;
    if (level === 1) {
      throw new Error(`${source}: H1 may only appear once`);
    }
    if (level > previous + 1) {
      throw new Error(`${source}: heading levels must not skip`);
    }
    previous = level;
  }
}

function normalizedInside(root, candidate, source) {
  const resolved = path.resolve(root, candidate);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`${source}: path escapes help root: ${candidate}`);
  }
  return resolved;
}

function validateSvg(assetPath, source) {
  const stat = fs.lstatSync(assetPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${source}: SVG must be a regular bundled file`);
  }
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error(`${source}: SVG exceeds ${MAX_ASSET_BYTES} bytes`);
  }
  const svg = fs.readFileSync(assetPath, "utf8");
  if (!/<svg\b[^>]*\bviewBox\s*=\s*["'][^"']+["']/i.test(svg)) {
    throw new Error(`${source}: SVG requires a viewBox`);
  }
  if (!/<title(?:\s[^>]*)?>[^<]+<\/title>/i.test(svg)) {
    throw new Error(`${source}: SVG requires a non-empty title`);
  }
  if (/<(?:script|foreignObject|image|animate|set)\b/i.test(svg)) {
    throw new Error(`${source}: SVG contains a forbidden element`);
  }
  if (
    /\son[a-z]+\s*=/i.test(svg) ||
    /\b(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(svg) ||
    /url\(\s*["']?(?:https?:|\/\/|data:)/i.test(svg)
  ) {
    throw new Error(`${source}: SVG contains executable or remote content`);
  }
}

function validateBody(body, meta, pagePath, root, assetsSeen) {
  const source = path.relative(root, pagePath);
  validateHeadingStructure(body, meta, source);
  if (/<(?:script|iframe|object|embed|style)\b/i.test(body)) {
    throw new Error(`${source}: raw executable/style HTML is not allowed`);
  }

  let svgCount = 0;
  for (const match of body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const [, alt, target] = match;
    if (!alt.trim()) {
      throw new Error(`${source}: image alt text must not be empty`);
    }
    if (/^(?:https?:|data:|\/|\\\\)/i.test(target) || target.includes("\\")) {
      throw new Error(`${source}: image must be a relative bundled asset`);
    }
    const assetPath = normalizedInside(
      root,
      path.join(path.dirname(source), target),
      source,
    );
    const assetsRoot = path.resolve(root, "assets");
    if (
      assetPath !== assetsRoot &&
      !assetPath.startsWith(`${assetsRoot}${path.sep}`)
    ) {
      throw new Error(`${source}: image must resolve below docs/help/assets`);
    }
    if (path.extname(assetPath).toLowerCase() !== ".svg") {
      throw new Error(`${source}: only SVG help assets are supported`);
    }
    if (!fs.existsSync(assetPath)) {
      throw new Error(`${source}: missing asset ${target}`);
    }
    validateSvg(assetPath, path.relative(root, assetPath));
    assetsSeen.add(assetPath);
    svgCount += 1;
  }

  const hasTable = /^\s*\|.+\|\s*$\n^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/m.test(body);
  if (meta.tags.includes("process") && (svgCount === 0 || !hasTable)) {
    throw new Error(`${source}: process pages require an SVG and a table`);
  }
}

function walkMarkdown(root) {
  const files = [];
  for (const section of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      section.name === "assets" ||
      section.name.startsWith(".") ||
      section.name === "README.md"
    ) {
      continue;
    }
    if (section.isSymbolicLink()) {
      throw new Error(`${section.name}: symlinked help sections are forbidden`);
    }
    if (!section.isDirectory()) {
      throw new Error(`${section.name}: help pages must live in section directories`);
    }
    const sectionPath = path.join(root, section.name);
    for (const entry of fs.readdirSync(sectionPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`${section.name}/${entry.name}: symlinks are forbidden`);
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        throw new Error(
          `${section.name}/${entry.name}: section entries must be Markdown files`,
        );
      }
      files.push(path.join(sectionPath, entry.name));
    }
  }
  return files.sort();
}

export function validateHelpCorpus(
  root,
  {
    requiredIds = [],
    maxPages = 1000,
  } = {},
) {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`help root does not exist: ${absoluteRoot}`);
  }
  const pages = [];
  const ids = new Map();
  const assetsSeen = new Set();
  for (const pagePath of walkMarkdown(absoluteRoot)) {
    const stat = fs.lstatSync(pagePath);
    const source = path.relative(absoluteRoot, pagePath);
    if (stat.size > MAX_PAGE_BYTES) {
      throw new Error(`${source}: page exceeds ${MAX_PAGE_BYTES} bytes`);
    }
    const parsed = parseHelpFrontmatter(
      fs.readFileSync(pagePath, "utf8"),
      source,
    );
    validateMetadata(parsed.meta, source);
    if (parsed.meta.section !== path.dirname(source).split(path.sep)[0]) {
      throw new Error(`${source}: section must match its directory`);
    }
    if (ids.has(parsed.meta.id)) {
      throw new Error(
        `${source}: duplicate id '${parsed.meta.id}' also used by ${ids.get(parsed.meta.id)}`,
      );
    }
    ids.set(parsed.meta.id, source);
    validateBody(
      parsed.body,
      parsed.meta,
      pagePath,
      absoluteRoot,
      assetsSeen,
    );
    pages.push({ path: source, ...parsed });
  }
  if (pages.length > maxPages) {
    throw new Error(`help corpus exceeds ${maxPages} pages`);
  }

  for (const page of pages) {
    for (const related of page.meta.related) {
      if (!ids.has(related)) {
        throw new Error(`${page.path}: unknown related page '${related}'`);
      }
    }
    for (const match of page.body.matchAll(/\bhelp:\/\/([a-z0-9-]+)(?:#[a-z0-9-]+)?/g)) {
      if (!ids.has(match[1])) {
        throw new Error(`${page.path}: unknown help link '${match[0]}'`);
      }
    }
  }
  for (const id of requiredIds) {
    if (!ids.has(id)) {
      throw new Error(`required help page missing: ${id}`);
    }
  }
  return {
    pages: pages.length,
    assets: assetsSeen.size,
    ids: [...ids.keys()].sort(),
  };
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultRoot = path.resolve(scriptDir, "..", "docs", "help");
  const root = process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot;
  const result = validateHelpCorpus(root, {
    requiredIds: [
      "product-overview",
      "first-run",
      "chat-citations-context",
      "permission-tiers",
      "log-analysis-pipeline",
      "memory-overview",
      "skills-context-packs",
    ],
  });
  process.stdout.write(
    `check_help_corpus: OK (${result.pages} pages, ${result.assets} referenced SVGs)\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check_help_corpus: FAILED — ${message}\n`);
    process.exitCode = 1;
  }
}
