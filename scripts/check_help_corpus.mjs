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
  "war-room",
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
/** Canonical in-app Help locator, e.g. `help://log-explorer#counts`. */
const HELP_LOCATOR_RE = /\bhelp:\/\/([a-z0-9-]+)(?:#([a-z0-9-]+))?/g;

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

/**
 * Mirror of `heading_anchor` in crates/cd-core/src/help.rs so a locator that
 * resolves here also resolves in the shipped HelpPane table of contents.
 */
export function helpHeadingAnchor(title) {
  let out = "";
  let separator = false;
  for (const ch of title.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      if (separator && out) out += "-";
      out += ch;
      separator = false;
    } else {
      separator = true;
    }
  }
  return out;
}

/**
 * H2/H3 anchors for one page body, including the `-2` duplicate suffix used by
 * `parse_toc` in cd-core. HelpPane scrolls by `document.getElementById`, so an
 * anchor missing from this set is a silently dead deep link.
 */
export function helpPageAnchors(body) {
  const counts = new Map();
  const anchors = [];
  for (const match of body.matchAll(/^(#{2,3})\s+(.+?)\s*$/gm)) {
    const base = helpHeadingAnchor(match[2]);
    if (!base) continue;
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    anchors.push(next === 1 ? base : `${base}-${next}`);
  }
  return anchors;
}

function normalizedInside(root, candidate, source) {
  const resolved = path.resolve(root, candidate);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`${source}: path escapes help root: ${candidate}`);
  }
  return resolved;
}

function svgAttributes(raw) {
  const attributes = {};
  for (const match of raw.matchAll(
    /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*["']([^"']*)["']/g,
  )) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function finiteNumber(value, fallback = Number.NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boxesOverlap(a, b, tolerance = 1) {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance
  );
}

/**
 * Conservative deterministic geometry check for the deliberately simple Help
 * SVG authoring subset. It catches clipping, text/text collisions, and labels
 * touching their containing rectangle. Font-metric/arrow quality still
 * requires the documented rendered contact-sheet review.
 */
export function validateSvgGeometry(svg, source = "<svg>") {
  const root = svg.match(/<svg\b([^>]*)>/i);
  const viewBox = root && svgAttributes(root[1]).viewBox;
  const dimensions = viewBox
    ?.trim()
    .split(/\s+/)
    .map((value) => finiteNumber(value));
  if (
    !dimensions ||
    dimensions.length !== 4 ||
    dimensions.some((value) => !Number.isFinite(value)) ||
    dimensions[2] <= 0 ||
    dimensions[3] <= 0
  ) {
    throw new Error(`${source}: SVG requires a numeric positive viewBox`);
  }
  const [viewX, viewY, viewWidth, viewHeight] = dimensions;
  const viewport = {
    left: viewX,
    top: viewY,
    right: viewX + viewWidth,
    bottom: viewY + viewHeight,
  };

  const rectangles = [...svg.matchAll(/<rect\b([^>]*)\/?>/gi)]
    .map((match) => svgAttributes(match[1]))
    .map((attributes) => {
      const x = finiteNumber(attributes.x, 0);
      const y = finiteNumber(attributes.y, 0);
      const width = finiteNumber(attributes.width);
      const height = finiteNumber(attributes.height);
      return {
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
        area: width * height,
      };
    })
    .filter(
      (box) =>
        Number.isFinite(box.area) &&
        box.right > box.left &&
        box.bottom > box.top,
    );

  const hasMiddleTextGroup =
    /<g\b[^>]*\btext-anchor\s*=\s*["']middle["'][^>]*>/i.test(svg);
  const texts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gi)]
    .map((match, index) => {
      const attributes = svgAttributes(match[1]);
      const label = match[2].replace(/\s+/g, " ").trim();
      const x = finiteNumber(attributes.x);
      const y = finiteNumber(attributes.y);
      const fontSize = finiteNumber(attributes["font-size"]);
      if (
        !label ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(fontSize) ||
        fontSize <= 0
      ) {
        throw new Error(
          `${source}: text ${index + 1} requires plain content and numeric x/y/font-size`,
        );
      }
      // A conservative system-ui estimate. The small margin avoids pretending
      // this replaces a real font-metric render review.
      const width = [...label].length * fontSize * 0.57;
      const anchor =
        attributes["text-anchor"] ?? (hasMiddleTextGroup ? "middle" : "start");
      const left =
        anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
      return {
        label,
        left,
        right: left + width,
        top: y - fontSize * 0.82,
        bottom: y + fontSize * 0.22,
        centerX: x,
        centerY: y - fontSize * 0.3,
      };
    });

  for (const text of texts) {
    const pad = 1;
    if (
      text.left < viewport.left + pad ||
      text.right > viewport.right - pad ||
      text.top < viewport.top + pad ||
      text.bottom > viewport.bottom - pad
    ) {
      throw new Error(`${source}: clipped text '${text.label}'`);
    }

    const containing = rectangles
      .filter(
        (rect) =>
          text.centerX >= rect.left &&
          text.centerX <= rect.right &&
          text.centerY >= rect.top &&
          text.centerY <= rect.bottom,
      )
      .sort((a, b) => a.area - b.area)[0];
    if (
      containing &&
      (text.left < containing.left + 3 ||
        text.right > containing.right - 3 ||
        text.top < containing.top + 3 ||
        text.bottom > containing.bottom - 3)
    ) {
      throw new Error(
        `${source}: text '${text.label}' touches or crosses its box border ` +
          `(text=${text.left.toFixed(1)},${text.top.toFixed(1)}..${text.right.toFixed(1)},${text.bottom.toFixed(1)}; ` +
          `box=${containing.left},${containing.top}..${containing.right},${containing.bottom})`,
      );
    }
  }

  for (let left = 0; left < texts.length; left += 1) {
    for (let right = left + 1; right < texts.length; right += 1) {
      if (boxesOverlap(texts[left], texts[right])) {
        throw new Error(
          `${source}: text collision '${texts[left].label}' / '${texts[right].label}'`,
        );
      }
    }
  }
}

/**
 * Presentation rules the safety/geometry passes cannot express (#540).
 *
 * Help renders diagrams through `<img>`, so a diagram cannot inherit theme
 * colors: `currentColor` collapses to the UA default and the artwork becomes
 * unreadable in one theme. The same contract is already enforced for the
 * incident-evidence diagrams by scripts/check_incident_evidence_drift.mjs;
 * this generalizes it to every bundled Help asset, and adds the non-visual
 * access requirement (`role="img"` plus a resolvable `aria-labelledby`).
 */
export function validateSvgPresentation(svg, source = "<svg>") {
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, "");
  const root = withoutComments.match(/<svg\b([^>]*)>/i);
  if (!root) {
    throw new Error(`${source}: SVG requires a root <svg> element`);
  }
  const attributes = svgAttributes(root[1]);
  if (attributes.role !== "img") {
    throw new Error(`${source}: SVG requires role="img" for non-visual access`);
  }
  const labelledBy = attributes["aria-labelledby"];
  if (!labelledBy || !labelledBy.trim()) {
    throw new Error(`${source}: SVG requires aria-labelledby`);
  }
  for (const reference of labelledBy.trim().split(/\s+/)) {
    const idPattern = new RegExp(
      `\\bid\\s*=\\s*["']${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    );
    if (!idPattern.test(withoutComments)) {
      throw new Error(
        `${source}: aria-labelledby references missing id '${reference}'`,
      );
    }
  }
  if (/\bcurrentColor\b/i.test(withoutComments)) {
    throw new Error(
      `${source}: SVG uses currentColor, which cannot inherit the Help theme through <img>`,
    );
  }
  if (!/#[0-9a-fA-F]{3,8}\b/.test(withoutComments)) {
    throw new Error(
      `${source}: SVG requires explicit hex colors readable in every theme`,
    );
  }
}

function relativeLuminance(hex) {
  let value = hex.replace("#", "");
  if (value.length === 3) {
    value = [...value].map((c) => c + c).join("");
  }
  const channel = (pair) => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(value.slice(0, 2)) +
    0.7152 * channel(value.slice(2, 4)) +
    0.0722 * channel(value.slice(4, 6))
  );
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function opaqueShapes(svg) {
  const shapes = [];
  for (const match of svg.matchAll(/<rect\b([^>]*)>/gi)) {
    const attributes = svgAttributes(match[1]);
    const fill = attributes.fill;
    if (!fill || !HEX_RE.test(fill)) continue;
    const x = finiteNumber(attributes.x, 0);
    const y = finiteNumber(attributes.y, 0);
    const width = finiteNumber(attributes.width);
    const height = finiteNumber(attributes.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    shapes.push({ left: x, top: y, right: x + width, bottom: y + height, fill });
  }
  for (const match of svg.matchAll(/<polygon\b([^>]*)>/gi)) {
    const attributes = svgAttributes(match[1]);
    const fill = attributes.fill;
    if (!fill || !HEX_RE.test(fill)) continue;
    const points = (attributes.points ?? "")
      .split(/\s+/)
      .filter((pair) => pair.includes(","))
      .map((pair) => pair.split(",").map(Number))
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (points.length === 0) continue;
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    shapes.push({
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
      fill,
    });
  }
  return shapes;
}

/**
 * Theme-independent legibility (#540).
 *
 * Help renders diagrams through `<img src="data:image/svg+xml;base64,…">`
 * (crates side: desktop/src-tauri/src/lib.rs `get_help_asset`; React side:
 * HelpMarkdown's `.help-figure`), so a diagram cannot inherit the page theme.
 * The `.help-figure` surface resolves to near-white in the Light and Sand
 * skins, which are real user-selectable themes. Any text left on the bare
 * canvas therefore renders against near-white with whatever fill it declares —
 * the shipped `#e5e7eb` diagram title measured 1.22:1 and six `#9ca3af`
 * captions measured 2.50:1 before this rule existed.
 *
 * The invariant is precise: every label must sit on an opaque shape it can be
 * read against. It deliberately does not demand a full-bleed canvas on every
 * asset, because most diagrams already place all text on inset panels.
 *
 * Not covered: non-text contrast (WCAG 1.4.11) for connector strokes drawn on
 * bare canvas between panels. Recorded as a residual, not silently implied.
 */
export function validateSvgTextLegibility(svg, source = "<svg>", minimum = 4.5) {
  const shapes = opaqueShapes(svg);
  for (const match of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gi)) {
    const attributes = svgAttributes(match[1]);
    const label = match[2].replace(/\s+/g, " ").trim();
    if (!label) continue;
    const x = finiteNumber(attributes.x);
    const y = finiteNumber(attributes.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const covering = shapes.filter(
      (shape) =>
        x >= shape.left && x <= shape.right && y >= shape.top && y <= shape.bottom,
    );
    if (covering.length === 0) {
      throw new Error(
        `${source}: text '${label}' sits on the bare canvas — it renders against the ` +
          `near-white Help figure surface in the Light and Sand themes`,
      );
    }
    const backdrop = covering.sort(
      (a, b) =>
        (a.right - a.left) * (a.bottom - a.top) -
        (b.right - b.left) * (b.bottom - b.top),
    )[0];
    const fill = attributes.fill;
    if (!fill || !HEX_RE.test(fill)) {
      throw new Error(
        `${source}: text '${label}' needs an explicit hex fill to be contrast-checked`,
      );
    }
    const ratio = contrastRatio(fill, backdrop.fill);
    if (ratio < minimum) {
      throw new Error(
        `${source}: text '${label}' is ${ratio.toFixed(2)}:1 against ${backdrop.fill} ` +
          `(WCAG AA needs ${minimum}:1)`,
      );
    }
  }
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
  validateSvgPresentation(svg, source);
  validateSvgTextLegibility(svg, source);
  validateSvgGeometry(svg, source);
}

/**
 * Validate every checked-in asset, not only the ones a page happens to link
 * (#540). `docs/help` ships whole into the packaged app
 * (desktop/src-tauri/tauri.conf.json → resources), so an unreferenced or
 * unvalidated file is still shipped bytes.
 */
function validateAssetLibrary(root, assetsSeen, externalReferences) {
  const assetsRoot = path.join(root, "assets");
  if (!fs.existsSync(assetsRoot)) {
    return { validated: 0 };
  }
  let validated = 0;
  for (const entry of fs.readdirSync(assetsRoot, { withFileTypes: true })) {
    const source = path.join("assets", entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${source}: symlinked help assets are forbidden`);
    }
    if (!entry.isFile()) {
      throw new Error(`${source}: help assets must be regular files`);
    }
    if (entry.name === "README.md") continue;
    if (path.extname(entry.name).toLowerCase() !== ".svg") {
      throw new Error(`${source}: only SVG help assets are supported`);
    }
    const assetPath = path.join(assetsRoot, entry.name);
    validateSvg(assetPath, source);
    validated += 1;
    if (!assetsSeen.has(assetPath) && !externalReferences.has(entry.name)) {
      throw new Error(
        `${source}: unreferenced help asset — link it from a Help page or a docs chapter, or delete it`,
      );
    }
  }
  return { validated };
}

/**
 * Diagram references from documentation outside `docs/help` (the proven-methods
 * handbook embeds the incident-evidence diagrams from the same asset folder).
 */
export function collectExternalAssetReferences(repositoryRoot) {
  const references = new Set();
  const docsRoot = path.resolve(repositoryRoot, "docs");
  const helpRoot = path.resolve(docsRoot, "help");
  if (!fs.existsSync(docsRoot)) return references;
  const stack = [docsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (full !== helpRoot) stack.push(full);
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== ".md") continue;
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(/help\/assets\/([A-Za-z0-9._-]+\.svg)/g)) {
        references.add(match[1]);
      }
    }
  }
  return references;
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

  /*
   * HelpMarkdown only tokenizes inline links whose target is a `help://`
   * locator, so any other inline link is emitted to the reader as literal
   * Markdown source. Three shipped pages carried relative `.md` links that
   * users saw as raw "[text](page.md)" text. Reject the shape outright rather
   * than teaching the renderer a second link syntax (#540).
   */
  for (const match of body.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = match[2];
    if (target.startsWith("help://")) continue;
    if (/^(?:https?|mailto):/i.test(target)) continue;
    throw new Error(
      `${source}: inline link '${match[0]}' is not a help:// locator — HelpMarkdown ` +
        `renders it as literal Markdown text`,
    );
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
    externalAssetReferences = new Set(),
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

  const anchors = new Map(
    pages.map((page) => [page.meta.id, new Set(helpPageAnchors(page.body))]),
  );

  for (const page of pages) {
    for (const related of page.meta.related) {
      if (!ids.has(related)) {
        throw new Error(`${page.path}: unknown related page '${related}'`);
      }
    }
    for (const match of page.body.matchAll(HELP_LOCATOR_RE)) {
      assertLocatorResolves(
        { pageId: match[1], anchor: match[2], text: match[0] },
        { ids, anchors },
        page.path,
      );
    }
  }
  for (const id of requiredIds) {
    if (!ids.has(id)) {
      throw new Error(`required help page missing: ${id}`);
    }
  }
  const assetLibrary = validateAssetLibrary(
    absoluteRoot,
    assetsSeen,
    externalAssetReferences,
  );
  return {
    pages: pages.length,
    assets: assetsSeen.size,
    assetsValidated: assetLibrary.validated,
    ids: [...ids.keys()].sort(),
    anchors,
  };
}

function assertLocatorResolves({ pageId, anchor, text }, { ids, anchors }, source) {
  if (!ids.has(pageId)) {
    throw new Error(`${source}: unknown help link '${text}'`);
  }
  if (anchor && !anchors.get(pageId)?.has(anchor)) {
    throw new Error(
      `${source}: help link '${text}' points at a heading that does not exist ` +
        `(HelpPane scrolls by element id, so this deep link silently does nothing)`,
    );
  }
}

function sourceFiles(root, extensions) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          stack.push(full);
        }
        continue;
      }
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * The UI → corpus direction (#540/#541).
 *
 * `validateHelpCorpus` only proves the corpus is internally consistent. Rich
 * contextual Help (desktop/src/lib/helpContent.ts) and the Settings help router
 * (desktop/src/lib/help.ts) name pages and anchors from React, and nothing
 * previously checked that those targets exist — a renamed heading turned
 * "Open full Help" into a no-op without failing any gate.
 */
export function validateSourceHelpReferences(
  repositoryRoot,
  { ids: rawIds, anchors },
  { sourceRoot = path.join("desktop", "src") } = {},
) {
  const ids = rawIds instanceof Set ? rawIds : new Set(rawIds);
  const absoluteSourceRoot = path.resolve(repositoryRoot, sourceRoot);
  const files = sourceFiles(
    absoluteSourceRoot,
    new Set([".ts", ".tsx", ".js", ".jsx"]),
  );

  /*
   * Discover declarations first, then validate their values.
   *
   * Scanning for well-formed `help://…` strings only ever inspects locators
   * that are already valid: delete a `helpLocator`, misspell its scheme, or
   * compute it at runtime and the site simply vanishes from the scan while the
   * gate reports success. So find every `helpLocator:` property assignment,
   * require a literal canonical value, and reject anything else.
   *
   * Type members (`helpLocator?: string`) declare the field rather than name a
   * page; they are recognized narrowly and counted separately.
   */
  const declarationRe = /(?<![\w$.])helpLocator\s*(\?)?\s*:\s*([^\n]*)/g;
  const typeValueRe = /^(?:string|\s*string\b|readonly\s|\w+\s*\|)/;
  let locators = 0;
  let declarations = 0;
  let typeMembers = 0;

  for (const file of files) {
    const source = path.relative(repositoryRoot, file);
    const text = fs.readFileSync(file, "utf8");

    for (const match of text.matchAll(declarationRe)) {
      const optional = match[1] === "?";
      const raw = match[2].trim();
      if (optional || typeValueRe.test(raw)) {
        typeMembers += 1;
        continue;
      }
      declarations += 1;
      // A leading double-quoted literal followed only by punctuation that can
      // legally close the property. Anything else — concatenation, a template,
      // a call, an identifier — is not statically checkable and is rejected.
      const literal = raw.match(/^"([^"\\]*)"[\s,;})\]]*(?:\/\/.*)?$/);
      if (!literal) {
        throw new Error(
          `${source}: helpLocator must be a literal canonical string, found \`${raw}\` — ` +
            `a computed or non-literal value cannot be checked against the corpus`,
        );
      }
      const value = literal[1];
      if (!value) {
        throw new Error(`${source}: helpLocator must not be empty`);
      }
      const parsed = value.match(/^help:\/\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/);
      if (!parsed) {
        throw new Error(
          `${source}: helpLocator '${value}' is not a canonical help:// locator`,
        );
      }
      assertLocatorResolves(
        { pageId: parsed[1], anchor: parsed[2], text: value },
        { ids, anchors },
        source,
      );
      locators += 1;
    }

    // Canonical locators written anywhere else in governed source (comments,
    // helper calls) still have to resolve.
    for (const match of text.matchAll(HELP_LOCATOR_RE)) {
      assertLocatorResolves(
        { pageId: match[1], anchor: match[2], text: match[0] },
        { ids, anchors },
        source,
      );
    }
  }

  if (declarations === 0) {
    throw new Error(
      `${sourceRoot}: found no helpLocator declarations — the contextual Help ` +
        `inventory cannot be empty, so the scan is broken or the module moved`,
    );
  }
  if (locators !== declarations) {
    throw new Error(
      `${sourceRoot}: ${declarations} helpLocator declarations but ${locators} validated`,
    );
  }

  // The Settings help router returns bare page ids rather than locators.
  const routerPath = path.resolve(repositoryRoot, sourceRoot, "lib", "help.ts");
  let routes = 0;
  if (fs.existsSync(routerPath)) {
    const routerText = fs.readFileSync(routerPath, "utf8");
    const router = routerText.match(
      /export function helpPageForSettingsSection[\s\S]*?\n}/,
    );
    if (!router) {
      throw new Error(
        "desktop/src/lib/help.ts: helpPageForSettingsSection is no longer statically checkable",
      );
    }
    for (const match of router[0].matchAll(/return\s+"([a-z0-9-]+)"/g)) {
      if (!ids.has(match[1])) {
        throw new Error(
          `desktop/src/lib/help.ts: helpPageForSettingsSection routes to unknown help page '${match[1]}'`,
        );
      }
      routes += 1;
    }
    if (routes === 0) {
      throw new Error(
        "desktop/src/lib/help.ts: helpPageForSettingsSection returned no checkable page ids",
      );
    }
  }
  return { files: files.length, locators, declarations, typeMembers, routes };
}

/**
 * Packaging guard (#540): the bundled corpus is only offline-available because
 * the Tauri bundle copies `docs/help` into the app resources. Dropping that
 * mapping would ship an application whose Help pane is empty, with every other
 * check still green.
 */
export function validateHelpPackaging(repositoryRoot) {
  const configPath = path.resolve(
    repositoryRoot,
    "desktop",
    "src-tauri",
    "tauri.conf.json",
  );
  if (!fs.existsSync(configPath)) {
    throw new Error("desktop/src-tauri/tauri.conf.json is missing");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const resources = config?.bundle?.resources;
  if (!resources || typeof resources !== "object") {
    throw new Error(
      "desktop/src-tauri/tauri.conf.json: bundle.resources must map the Help corpus",
    );
  }
  const target = resources["../../docs/help"];
  if (target !== "help") {
    throw new Error(
      "desktop/src-tauri/tauri.conf.json: bundle.resources must map '../../docs/help' to 'help' " +
        "so bundled Help stays available offline",
    );
  }
  return { resource: target };
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDir, "..");
  const defaultRoot = path.resolve(repositoryRoot, "docs", "help");
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
    externalAssetReferences: collectExternalAssetReferences(repositoryRoot),
  });
  const references = validateSourceHelpReferences(repositoryRoot, result);
  validateHelpPackaging(repositoryRoot);
  process.stdout.write(
    `check_help_corpus: OK (${result.pages} pages, ${result.assets} referenced SVGs, ` +
      `${result.assetsValidated} validated assets, ${references.locators} UI locators, ` +
      `${references.routes} settings routes, packaged resource ok)\n`,
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
