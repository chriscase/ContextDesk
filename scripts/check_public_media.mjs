#!/usr/bin/env node
/**
 * Deterministically validate the public-media review ledger (#653).
 *
 * This checks manifest metadata, repository-relative paths, raster inventory,
 * and exact Git blob identities. It does not perform OCR, secret detection, or
 * any semantic review of image contents.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RASTER_EXTENSION_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;
const REQUIRED_TEXT_FIELDS = [
  "fixture",
  "theme",
  "claim",
  "reviewedBy",
];

function toRepoPath(value) {
  return value.split(path.sep).join("/");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertNonEmptyText(value, field, source) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: '${field}' must be a non-empty string`);
  }
}

function normalizeAssetPath(value, source) {
  assertNonEmptyText(value, "path", source);
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value ||
    value.startsWith("../") ||
    value === ".."
  ) {
    throw new Error(`${source}: asset path must be normalized and repo-relative`);
  }
  if (!value.startsWith("docs/media/")) {
    throw new Error(`${source}: asset path must be under docs/media/`);
  }
  if (!RASTER_EXTENSION_RE.test(value)) {
    throw new Error(`${source}: asset path must have a supported raster extension`);
  }
  return value;
}

function readRasterInventory(mediaRoot, repositoryRoot) {
  const inventory = [];

  function visit(directory) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toRepoPath(path.relative(repositoryRoot, absolute));
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(absolute);
        if (!isInside(mediaRoot, resolved)) {
          throw new Error(`${relative}: symlink escapes docs/media/`);
        }
        if (fs.statSync(absolute).isDirectory()) {
          throw new Error(`${relative}: symlinked directories are not supported`);
        }
        if (RASTER_EXTENSION_RE.test(entry.name)) inventory.push(relative);
      } else if (entry.isFile() && RASTER_EXTENSION_RE.test(entry.name)) {
        inventory.push(relative);
      }
    }
  }

  visit(mediaRoot);
  return inventory.sort();
}

function gitBlob(repositoryRoot, absolutePath, source) {
  const result = spawnSync("git", ["hash-object", "--", absolutePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `git exited ${result.status}`;
    throw new Error(`${source}: git hash-object failed: ${detail}`);
  }
  const hash = result.stdout.trim();
  if (!SHA_RE.test(hash)) {
    throw new Error(`${source}: git hash-object returned an invalid blob identity`);
  }
  return hash.toLowerCase();
}

export function validatePublicMedia(
  repositoryRoot,
  manifestPath = path.join(repositoryRoot, "docs/media/public-assets.json"),
) {
  const requestedRoot = path.resolve(repositoryRoot);
  const manifest = path.resolve(manifestPath);

  if (!fs.statSync(requestedRoot).isDirectory()) {
    throw new Error(`repository root is not a directory: ${requestedRoot}`);
  }
  const root = fs.realpathSync(requestedRoot);
  const requestedMediaRoot = path.join(root, "docs", "media");
  if (!fs.statSync(requestedMediaRoot).isDirectory()) {
    throw new Error(`public media directory is missing: ${requestedMediaRoot}`);
  }
  const mediaRoot = fs.realpathSync(requestedMediaRoot);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch (error) {
    throw new Error(`manifest cannot be parsed: ${error.message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error("manifest requires schemaVersion 1 and an assets array");
  }

  const seen = new Set();
  const altTermsByPath = new Map();
  for (const [index, asset] of parsed.assets.entries()) {
    const source = `assets[${index}]`;
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error(`${source}: asset must be an object`);
    }
    const assetPath = normalizeAssetPath(asset.path, source);
    if (seen.has(assetPath)) {
      throw new Error(`${source}: duplicate asset path '${assetPath}'`);
    }
    seen.add(assetPath);

    if (!SHA_RE.test(asset.gitBlob ?? "")) {
      throw new Error(`${source}: 'gitBlob' must be a 40-hex Git blob identity`);
    }
    if (!SHA_RE.test(asset.sourceSha ?? "")) {
      throw new Error(`${source}: 'sourceSha' must be a 40-hex commit identity`);
    }
    if (asset.privacyReview !== "publishable") {
      throw new Error(`${source}: privacyReview must be 'publishable'`);
    }
    if (asset.modelInventoryVisible !== false) {
      throw new Error(`${source}: modelInventoryVisible must be false`);
    }
    for (const field of REQUIRED_TEXT_FIELDS) {
      assertNonEmptyText(asset[field], field, source);
    }
    if (
      !Array.isArray(asset.altRequiredTerms) ||
      asset.altRequiredTerms.length === 0 ||
      asset.altRequiredTerms.some((term) => typeof term !== "string" || term.trim() === "")
    ) {
      throw new Error(`${source}: altRequiredTerms must be a non-empty array of non-empty strings`);
    }
    altTermsByPath.set(
      assetPath,
      asset.altRequiredTerms.map((term) => term.trim()),
    );

    const absolute = path.resolve(root, ...assetPath.split("/"));
    if (!isInside(mediaRoot, absolute)) {
      throw new Error(`${source}: asset path escapes docs/media/`);
    }
    if (!fs.existsSync(absolute)) {
      throw new Error(`${source}: asset file is missing: ${assetPath}`);
    }
    const resolved = fs.realpathSync(absolute);
    if (!isInside(mediaRoot, resolved)) {
      throw new Error(`${source}: asset symlink escapes docs/media/: ${assetPath}`);
    }
    if (!fs.statSync(absolute).isFile()) {
      throw new Error(`${source}: asset is not a file: ${assetPath}`);
    }
    const actualBlob = gitBlob(root, absolute, source);
    if (actualBlob !== asset.gitBlob.toLowerCase()) {
      throw new Error(
        `${source}: Git blob mismatch for ${assetPath}; expected ${asset.gitBlob.toLowerCase()}, got ${actualBlob}`,
      );
    }
  }

  const inventory = readRasterInventory(mediaRoot, root);
  const unlisted = inventory.filter((assetPath) => !seen.has(assetPath));
  const outsideInventory = [...seen].filter(
    (assetPath) => !inventory.includes(assetPath),
  );
  if (unlisted.length > 0) {
    throw new Error(`unlisted raster image(s): ${unlisted.join(", ")}`);
  }
  if (outsideInventory.length > 0) {
    throw new Error(
      `manifest asset(s) outside raster inventory: ${outsideInventory.sort().join(", ")}`,
    );
  }

  const published = validatePublishedReferences(root, altTermsByPath);
  const provenance = validateProvenanceRecord(root, parsed.assets);

  return { assets: inventory.length, published, provenance };
}

/**
 * The ledger records the app-source SHA per frame; `docs/media/README.md` is
 * where a human reads it. Those two drifted apart once already — the prose
 * claimed all three frames came from one build while the ledger recorded two —
 * which is exactly the "one exact packaged-app SHA" claim #734 asks for. Require
 * every recorded SHA to appear in the provenance record so a recapture cannot
 * leave stale prose behind.
 */
export function validateProvenanceRecord(
  root,
  assets,
  document = "docs/media/README.md",
) {
  const documentPath = path.join(root, document);
  if (!fs.existsSync(documentPath)) {
    throw new Error(`${document}: capture provenance record is missing`);
  }
  const text = fs.readFileSync(documentPath, "utf8");
  const shas = [...new Set(assets.map((asset) => asset.sourceSha.toLowerCase()))];
  for (const sha of shas) {
    if (!text.toLowerCase().includes(sha)) {
      throw new Error(
        `${document}: does not record capture provenance for source SHA ${sha}`,
      );
    }
  }
  return shas.length;
}

/**
 * README is the published product-communication surface (#677/#734). The
 * manifest is only a privacy gate if every raster the README actually shows is
 * a ledger entry: a raster committed outside `docs/media/` would otherwise be
 * published with no blob identity, source SHA, or privacy review.
 */
export function validatePublishedReferences(
  root,
  altTermsByPath,
  documents = ["README.md"],
) {
  let references = 0;
  for (const document of documents) {
    const documentPath = path.join(root, document);
    if (!fs.existsSync(documentPath)) continue;
    const text = fs.readFileSync(documentPath, "utf8");
    for (const { target, form, alt } of collectPublishedImageTargets(text, document)) {
      const localTarget = normalizePublishedLocalTarget(target, document);
      // Remote badges are not repository media and carry no local bytes.
      if (localTarget === null) continue;
      if (/\.svg$/i.test(localTarget)) {
        throw new Error(
          `${document}: local SVG image '${target}' is outside the raster privacy ledger`,
        );
      }
      if (!RASTER_EXTENSION_RE.test(localTarget)) {
        throw new Error(
          `${document}: local image '${target}' has no supported privacy-ledgered raster extension`,
        );
      }
      const normalized = localTarget.replace(/^\.\//, "");
      if (!altTermsByPath.has(normalized)) {
        throw new Error(
          `${document}: published raster '${target}' (${form}) is not in the public media ledger`,
        );
      }
      const normalizedAlt = alt.trim().toLocaleLowerCase("en-US");
      const missingTerms = altTermsByPath
        .get(normalized)
        .filter(
          (term) =>
            !normalizedAlt.includes(term.toLocaleLowerCase("en-US")),
        );
      if (missingTerms.length > 0) {
        throw new Error(
          `${document}: published raster '${target}' (${form}) alt text must include required term(s): ${missingTerms.join(", ")}`,
        );
      }
      references += 1;
    }
  }
  return references;
}

export function normalizePublishedLocalTarget(target, document = "<memory>") {
  const rawTrimmed = target.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "");
  // Remote targets carry no repository bytes. Short-circuit their literal
  // scheme before applying the intentionally conservative local-entity gate,
  // so an ordinary badge query cannot break the privacy lane.
  if (/^(?:https?:)?\/\//i.test(rawTrimmed)) return null;
  const decoded = decodeHtmlCharacterReferences(rawTrimmed, document).replace(
    /^[ \t\n\f\r]+|[ \t\n\f\r]+$/g,
    "",
  );
  if (/^(?:https?:)?\/\//i.test(decoded)) {
    return null;
  }
  if (/^data:/i.test(decoded)) {
    throw new Error(`${document}: embedded data images are not privacy-ledgered`);
  }
  const withoutSuffix = decoded.split(/[?#]/, 1)[0];
  // HTML accepts numeric character references without a semicolon and has a
  // much larger named-reference table than this dependency-free validator.
  // Anything that still looks entity-shaped is therefore ambiguous: letting
  // it fall through could make the browser see `.png` while the gate sees no
  // raster extension. Fail closed instead of maintaining a partial allowlist.
  if (/&(?:#|[a-z])/i.test(withoutSuffix)) {
    throw new Error(
      `${document}: published image target uses an ambiguous HTML character reference: ${target}`,
    );
  }
  if (/%(?:2e|2f|5c)/i.test(withoutSuffix)) {
    throw new Error(
      `${document}: published image target uses an encoded path separator or traversal segment: ${target}`,
    );
  }
  try {
    return decodeURIComponent(withoutSuffix);
  } catch {
    throw new Error(`${document}: published image target has invalid percent encoding: ${target}`);
  }
}

/**
 * Every syntax GitHub actually renders as an image, not just the inline one.
 *
 * The first version of this check matched `![alt](path)` only, so
 * reference-style images and raw `<img>` tags — both of which GitHub renders in
 * a README — could publish a raster with no ledger entry at all. Ambiguous
 * local raster syntax is rejected rather than skipped, because silently
 * ignoring a form is exactly the hole this closes.
 */
export function collectPublishedImageTargets(text, document = "<memory>") {
  const targets = [];
  const renderedText = maskMarkdownHtmlComments(maskMarkdownFencedCode(text));
  // Inline code is literal text, not an image or HTML node. Keep a separate
  // masked view for syntax scans while retaining the original rendered text
  // for accessible Markdown alt extraction below.
  const markdownRenderedText = maskMarkdownInlineCode(renderedText);
  const htmlRenderedText = markdownRenderedText;

  const definitions = collectMarkdownDefinitions(text, document);
  let cursor = 0;
  while (cursor < renderedText.length) {
    const imageStart = markdownRenderedText.indexOf("![", cursor);
    if (imageStart < 0) break;
    const alt = parseBracketedMarkdown(markdownRenderedText, imageStart + 1);
    if (alt === null) {
      cursor = imageStart + 2;
      continue;
    }

    if (markdownRenderedText[alt.end] === "(") {
      const inline = parseInlineMarkdownDestination(markdownRenderedText, alt.end);
      if (inline !== null) {
        targets.push({
          target: inline.target,
          form: "inline",
          alt: renderMarkdownAltText(alt.value, document),
        });
        cursor = inline.end;
        continue;
      }
    }

    // If an apparent inline or full-reference suffix is malformed, CommonMark
    // backtracks and may still render the preceding `![alt]` as a shortcut
    // reference. Resolve that form instead of silently skipping the image.
    let label = alt.value;
    let end = alt.end;
    if (markdownRenderedText[alt.end] === "[") {
      const explicitLabel = parseBracketedMarkdown(markdownRenderedText, alt.end);
      if (explicitLabel !== null) {
        label = explicitLabel.value.trim() || alt.value;
        end = explicitLabel.end;
      }
    }
    const normalizedLabel = normalizeMarkdownLabel(label);
    const target = definitions.get(normalizedLabel);
    if (target !== undefined) {
      targets.push({
        target,
        form: "reference",
        alt: renderMarkdownAltText(alt.value, document),
      });
      cursor = end;
      continue;
    }
    // A reference image with no definition renders as literal text, but an
    // unresolvable local raster-shaped label is ambiguous and fails closed.
    if (RASTER_EXTENSION_RE.test(unescapeMarkdown(label))) {
      throw new Error(
        `${document}: reference image '${markdownRenderedText.slice(imageStart, end)}' has no link definition`,
      );
    }
    cursor = Math.max(alt.end, imageStart + 2);
  }

  // Raw HTML: govern both the fallback source and every responsive candidate.
  // A reviewed `src` is not sufficient when the browser can choose an
  // unreviewed `srcset` or `<picture><source>` payload at another viewport or
  // pixel density.
  const pictureRanges = [];
  for (const picture of htmlRenderedText.matchAll(/<picture\b[\s\S]*?<\/picture\s*>/gi)) {
    pictureRanges.push({ start: picture.index, end: picture.index + picture[0].length });
    const imageTags = collectHtmlTags(picture[0], "img", document);
    if (imageTags.length !== 1) {
      throw new Error(
        `${document}: <picture> must have exactly one quoted fallback <img> to supply alt text`,
      );
    }
    const fallback = imageTags[0];
    const fallbackAttributes = parseHtmlAttributes(
      fallback.attributes,
      document,
      fallback.tag,
    );
    const fallbackAlt = decodeHtmlCharacterReferences(
      fallbackAttributes.get("alt") ?? "",
      document,
      fallback.tag,
    );
    for (const source of collectHtmlTags(picture[0], "source", document)) {
      const attributes = parseHtmlAttributes(source.attributes, document, source.tag);
      const srcset = attributes.get("srcset");
      if (srcset === undefined || srcset === null) {
        throw new Error(
          `${document}: <picture> source without a quoted literal srcset cannot be checked: ${source.tag}`,
        );
      }
      for (const target of parseHtmlSrcset(srcset, document, source.tag)) {
        targets.push({ target, form: "html", alt: fallbackAlt });
      }
    }
  }

  for (const match of collectHtmlTags(htmlRenderedText, "img", document)) {
    const attributes = parseHtmlAttributes(match.attributes, document, match.tag);
    const src = attributes.get("src");
    if (src === undefined || src === null) {
      throw new Error(
        `${document}: <img> tag without a quoted literal src cannot be checked: ${match.tag}`,
      );
    }
    const alt = decodeHtmlCharacterReferences(
      attributes.get("alt") ?? "",
      document,
      match.tag,
    );
    targets.push({
      target: src,
      form: "html",
      alt,
    });
    if (attributes.has("srcset")) {
      const srcset = attributes.get("srcset");
      if (srcset === null) {
        throw new Error(
          `${document}: <img> tag without a quoted literal srcset cannot be checked: ${match.tag}`,
        );
      }
      for (const target of parseHtmlSrcset(srcset, document, match.tag)) {
        targets.push({ target, form: "html", alt });
      }
    }
  }

  // A source tag outside a picture does not inherit an image alt contract and
  // may belong to audio/video. If it nevertheless carries srcset, browsers can
  // treat it as responsive image syntax in malformed markup; reject rather
  // than silently guessing its accessibility or privacy scope.
  for (const source of collectHtmlTags(htmlRenderedText, "source", document)) {
    if (pictureRanges.some((range) => source.start >= range.start && source.end <= range.end)) {
      continue;
    }
    const attributes = parseHtmlAttributes(source.attributes, document, source.tag);
    if (attributes.has("srcset")) {
      throw new Error(
        `${document}: <source srcset> outside a complete <picture> cannot be checked: ${source.tag}`,
      );
    }
  }

  return targets;
}

function unescapeMarkdown(value) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function normalizeMarkdownLabel(value) {
  return unescapeMarkdown(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function maskMarkdownInlineCode(value) {
  // `value` is indexed in UTF-16 code units throughout the parser. Keep the
  // same indexing here so an emoji before a code span cannot shift the mask.
  const masked = value.split("");
  let index = 0;
  while (index < value.length) {
    if (value[index] === "<") {
      const htmlEnd = inlineHtmlTagEnd(value, index);
      if (htmlEnd !== null) {
        index = htmlEnd;
        continue;
      }
    }
    if (value[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (value[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - index;
    let close = runEnd;
    let matched = false;
    while (close < value.length) {
      close = value.indexOf("`".repeat(runLength), close);
      if (close < 0) break;
      if (
        !/\r?\n[ \t]*\r?\n/.test(value.slice(runEnd, close)) &&
        value[close - 1] !== "`" &&
        value[close + runLength] !== "`"
      ) {
        for (let cursor = index; cursor < close + runLength; cursor += 1) {
          if (masked[cursor] !== "\n" && masked[cursor] !== "\r") masked[cursor] = " ";
        }
        index = close + runLength;
        matched = true;
        break;
      }
      close += runLength;
    }
    if (!matched) index = runEnd;
  }
  return masked.join("");
}

/**
 * Image alt text is the rendered inline content, not the Markdown source.
 * Link destinations and raw-HTML attributes are invisible to assistive
 * technology, so they must never satisfy a manifest-required alt term.
 */
function renderMarkdownAltText(value, document) {
  let rendered = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === "\\" && index + 1 < value.length) {
      rendered += value[index + 1];
      index += 2;
      continue;
    }
    if (value[index] === "`") {
      let runEnd = index + 1;
      while (value[runEnd] === "`") runEnd += 1;
      const delimiter = "`".repeat(runEnd - index);
      const close = value.indexOf(delimiter, runEnd);
      if (close >= 0 && !/\r?\n[ \t]*\r?\n/.test(value.slice(runEnd, close))) {
        rendered += value.slice(runEnd, close).replace(/[\r\n]+/g, " ");
        index = close + delimiter.length;
        continue;
      }
    }
    if (value[index] === "<") {
      const htmlEnd = inlineHtmlTagEnd(value, index);
      if (htmlEnd !== null) {
        index = htmlEnd;
        continue;
      }
    }
    const bracketStart = value[index] === "["
      ? index
      : value[index] === "!" && value[index + 1] === "["
        ? index + 1
        : null;
    if (bracketStart !== null) {
      const label = parseBracketedMarkdown(value, bracketStart);
      if (label !== null) {
        rendered += renderMarkdownAltText(label.value, document);
        if (value[label.end] === "(") {
          const inline = parseInlineMarkdownDestination(value, label.end);
          if (inline !== null) {
            index = inline.end;
            continue;
          }
        }
        if (value[label.end] === "[") {
          const reference = parseBracketedMarkdown(value, label.end);
          if (reference !== null) {
            index = reference.end;
            continue;
          }
        }
        index = label.end;
        continue;
      }
    }
    rendered += value[index];
    index += 1;
  }
  return decodeHtmlCharacterReferences(rendered, document, value);
}

function parseBracketedMarkdown(source, openIndex) {
  if (source[openIndex] !== "[") return null;
  let depth = 1;
  let index = openIndex + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      value += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "`") {
      const runStart = index;
      let runEnd = index + 1;
      while (source[runEnd] === "`") runEnd += 1;
      const runLength = runEnd - index;
      let close = runEnd;
      let matched = false;
      while (close < source.length) {
        close = source.indexOf("`".repeat(runLength), close);
        if (close < 0) break;
        if (/\r?\n[ \t]*\r?\n/.test(source.slice(runEnd, close))) break;
        if (source[close - 1] !== "`" && source[close + runLength] !== "`") {
          value += source.slice(index, close + runLength);
          index = close + runLength;
          matched = true;
          break;
        }
        close += runLength;
      }
      if (matched) continue;
      index = runStart;
    }
    if (character === "<") {
      const htmlEnd = inlineHtmlTagEnd(source, index);
      if (htmlEnd !== null) {
        value += source.slice(index, htmlEnd);
        index = htmlEnd;
        continue;
      }
    }
    if (character === "[") {
      depth += 1;
      value += character;
      index += 1;
      continue;
    }
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return { value, end: index + 1 };
      value += character;
      index += 1;
      continue;
    }
    value += character;
    index += 1;
  }
  return null;
}

function inlineHtmlTagEnd(source, start) {
  if (!/[A-Za-z!/?]/.test(source[start + 1] ?? "")) return null;
  let index = start + 1;
  let quote = null;
  while (index < source.length) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === `"` || character === `'`) {
      quote = character;
      index += 1;
      continue;
    }
    if (character === ">") return index + 1;
    if (character === "\n" || character === "\r") return null;
    index += 1;
  }
  return null;
}

function parseInlineMarkdownDestination(source, openParenIndex) {
  let index = openParenIndex + 1;
  while (/[ \t\r\n]/.test(source[index] ?? "")) index += 1;
  let target = "";

  if (source[index] === "<") {
    index += 1;
    while (index < source.length && source[index] !== ">") {
      if (source[index] === "\\" && index + 1 < source.length) {
        target += source[index + 1];
        index += 2;
      } else {
        target += source[index];
        index += 1;
      }
    }
    if (source[index] !== ">") return null;
    index += 1;
  } else {
    let nestedParens = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\" && index + 1 < source.length) {
        target += source[index + 1];
        index += 2;
        continue;
      }
      if (character === "(") {
        nestedParens += 1;
        target += character;
        index += 1;
        continue;
      }
      if (character === ")") {
        if (nestedParens === 0) break;
        nestedParens -= 1;
        target += character;
        index += 1;
        continue;
      }
      if (/[ \t\r\n]/.test(character) && nestedParens === 0) break;
      target += character;
      index += 1;
    }
    if (nestedParens !== 0) return null;
  }
  if (!target) return null;

  // Skip an optional title without treating a parenthesis inside quotes as
  // the end of the rendered image.
  let quote = null;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      index += 2;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === `"` || character === `'`) {
      quote = character;
      index += 1;
      continue;
    }
    if (character === ")") return { target, end: index + 1 };
    index += 1;
  }
  return null;
}

function parseMarkdownDefinitionDestination(source, start) {
  let index = start;
  while (/[ \t]/.test(source[index] ?? "")) index += 1;
  if (source[index] === "\r" && source[index + 1] === "\n") index += 2;
  else if (source[index] === "\n") index += 1;
  if (index > start) {
    let continuationIndent = 0;
    while (/[ \t]/.test(source[index] ?? "") && continuationIndent < 4) {
      index += 1;
      continuationIndent += 1;
    }
  }
  if (source[index] === "<") {
    const close = source.indexOf(">", index + 1);
    if (close < 0) return null;
    if (/[\r\n]/.test(source.slice(index + 1, close))) return null;
    return unescapeMarkdown(source.slice(index + 1, close));
  }
  const destinationStart = index;
  let depth = 0;
  while (index < source.length && !/[ \t\r\n]/.test(source[index])) {
    if (source[index] === "\\" && index + 1 < source.length) {
      index += 2;
      continue;
    }
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
  }
  if (depth !== 0) return null;
  return destinationStart === index
    ? null
    : unescapeMarkdown(source.slice(destinationStart, index));
}

function markdownContainerInfo(line) {
  let remainder = line;
  const containers = [];
  while (true) {
    const quote = remainder.match(/^[ \t]{0,3}>[ \t]?/);
    if (quote !== null) {
      containers.push({ type: "blockquote" });
      remainder = remainder.slice(quote[0].length);
      continue;
    }
    const list = remainder.match(/^[ \t]{0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/);
    if (list !== null) {
      containers.push({ type: "list", indent: list[0].length });
      remainder = remainder.slice(list[0].length);
      continue;
    }
    break;
  }
  return {
    content: remainder,
    containers,
    blockquoteDepth: containers.filter((container) => container.type === "blockquote").length,
    listDepth: containers.filter((container) => container.type === "list").length,
    listIndents: containers
      .filter((container) => container.type === "list")
      .map((container) => container.indent),
  };
}

function markdownContainerContent(line) {
  return markdownContainerInfo(line).content;
}

function stripMarkdownContainerPrefixes(text) {
  return text.replace(/^[^\r\n]*/gm, markdownContainerContent);
}

function maskMarkdownFencedCode(text) {
  const parts = text.split(/(\r\n|\n|\r)/);
  let fence = null;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const info = markdownContainerInfo(line);
    const content = info.content;
    if (fence === null) {
      const opener = content.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (opener !== null && !(opener[1][0] === "`" && opener[2].includes("`"))) {
        fence = {
          character: opener[1][0],
          length: opener[1].length,
          blockquoteDepth: info.blockquoteDepth,
          listDepth: info.listDepth,
          listContinuationIndent: info.listIndents.reduce(
            (total, indent) => total + indent,
            0,
          ),
        };
        parts[index] = " ".repeat(line.length);
      }
      continue;
    }

    // A fence belongs to the blockquote/list containers that opened it. A
    // global fence state would otherwise hide top-level definitions after an
    // unclosed quoted/list item fence, even though CommonMark has already
    // returned to the outer document. Terminate the fence before a line that
    // has escaped its owner container.
    if (!lineBelongsToContainer(fence, info, line)) {
      fence = null;
      // Process this line again as ordinary Markdown. It may itself open a
      // new fence, and it must remain visible when it is a real definition.
      const nextOpener = content.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (
        nextOpener !== null &&
        !(nextOpener[1][0] === "`" && nextOpener[2].includes("`"))
      ) {
        fence = {
          character: nextOpener[1][0],
          length: nextOpener[1].length,
          blockquoteDepth: info.blockquoteDepth,
          listDepth: info.listDepth,
          listContinuationIndent: info.listIndents.reduce(
            (total, indent) => total + indent,
            0,
          ),
        };
        parts[index] = " ".repeat(line.length);
      }
      continue;
    }
    const escaped = fence.character === "`" ? "`" : "~";
    const closing = new RegExp(`^[ \\t]{0,3}${escaped}{${fence.length},}[ \\t]*$`);
    parts[index] = " ".repeat(line.length);
    if (closing.test(content)) fence = null;
  }
  return parts.join("");
}

function maskMarkdownHtmlComments(text) {
  return text.replace(
    /<!--(?!>|->)(?:(?!--)[\s\S])*?-->/g,
    (comment) => comment.replace(/[^\r\n]/g, " "),
  );
}

const RAW_HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html",
  "iframe", "legend", "li", "link", "main", "menu", "menuitem", "nav", "ol",
  "p", "pre", "script", "section", "style", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "title", "tr", "track", "ul",
]);

function htmlTagTokens(value) {
  const tokens = [];
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("<", index);
    if (start < 0) break;
    let cursor = start + 1;
    let closing = false;
    if (value[cursor] === "/") {
      closing = true;
      cursor += 1;
    }
    while (/[ \t\r\n]/.test(value[cursor] ?? "")) cursor += 1;
    const name = value.slice(cursor).match(/^[A-Za-z][A-Za-z0-9:-]*/)?.[0];
    if (!name) {
      index = start + 1;
      continue;
    }
    cursor += name.length;
    let quote = null;
    while (cursor < value.length) {
      const character = value[cursor];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === `"` || character === `'`) {
        quote = character;
      } else if (character === ">") {
        tokens.push({
          name: name.toLocaleLowerCase("en-US"),
          closing,
          selfClosing: /\/\s*$/.test(value.slice(start, cursor)),
        });
        index = cursor + 1;
        break;
      }
      cursor += 1;
    }
    if (cursor >= value.length) break;
  }
  return tokens;
}

function maskMarkdownHtmlBlocks(text, document = "<memory>") {
  const parts = text.split(/(\r\n|\n|\r)/);
  let openTags = [];
  let owner = null;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const content = markdownContainerContent(line);
    const tokens = htmlTagTokens(content);
    const startsWithBlockTag = /^\s*</.test(content) && tokens.length > 0;

    if (openTags.length > 0) {
      const info = markdownContainerInfo(line);
      if (!lineBelongsToContainer(owner, info, line)) {
        openTags = [];
        owner = null;
      } else {
        parts[index] = " ".repeat(line.length);
        for (const token of tokens) {
          if (!token.closing && RAW_HTML_BLOCK_TAGS.has(token.name) && !token.selfClosing) {
            openTags.push(token.name);
          } else if (token.closing && token.name === openTags.at(-1)) {
            openTags.pop();
          }
        }
        continue;
      }
    }

    if (!startsWithBlockTag) continue;
    const first = tokens[0];
    if (!RAW_HTML_BLOCK_TAGS.has(first.name)) continue;
    parts[index] = " ".repeat(line.length);
    if (!first.closing && !first.selfClosing) {
      owner = markdownContainerInfo(line);
      openTags = [first.name];
      for (const token of tokens.slice(1)) {
        if (!token.closing && RAW_HTML_BLOCK_TAGS.has(token.name) && !token.selfClosing) {
          openTags.push(token.name);
        } else if (token.closing && token.name === openTags.at(-1)) {
          openTags.pop();
        }
      }
    }
  }
  if (openTags.length > 0) {
    throw new Error(
      `${document}: unterminated raw HTML block <${openTags.at(-1)}> cannot be checked safely`,
    );
  }
  return parts.join("");
}

/*
 * Keep this helper's ownership rule in one place for future block-level
 * scanners. A container-aware parser is intentionally not pulled in as a
 * runtime dependency: this validator runs before npm install in release jobs.
 */
function lineBelongsToContainer(owner, info, line) {
  // A root-level fence/raw block owns every line, including lines that begin
  // with `>` or a list marker: those markers are literal content until the
  // matching fence/tag closes. Container transitions only matter when the
  // block itself was opened inside a container.
  if (owner.blockquoteDepth === 0 && owner.listDepth === 0) return true;
  const sameBlockquote = info.blockquoteDepth === owner.blockquoteDepth;
  const sameOrNestedList = owner.listDepth > 0
    ? info.listDepth >= owner.listDepth
    : info.listDepth === 0;
  const listContinuation =
    owner.listDepth > 0 &&
    info.listDepth < owner.listDepth &&
    leadingIndentAfterBlockquotes(line, owner.blockquoteDepth) >=
      (owner.listContinuationIndent ?? 2) &&
    info.blockquoteDepth === owner.blockquoteDepth &&
    line.trim() !== "";
  return sameBlockquote && (sameOrNestedList || listContinuation);
}

function leadingIndentAfterBlockquotes(line, blockquoteDepth) {
  let remainder = line;
  for (let index = 0; index < blockquoteDepth; index += 1) {
    const quote = remainder.match(/^[ \t]{0,3}>[ \t]?/);
    if (quote === null) return -1;
    remainder = remainder.slice(quote[0].length);
  }
  return (remainder.match(/^[ \t]*/) ?? [""])[0].length;
}

function collectMarkdownDefinitions(text, document = "<memory>") {
  const definitions = new Map();
  const visibleBlocks = stripMarkdownContainerPrefixes(
    maskMarkdownHtmlBlocks(
      maskMarkdownHtmlComments(maskMarkdownFencedCode(text)),
      document,
    ),
  );
  const lineStart = /^(?:[ \t]{0,3})\[/gm;
  for (const match of visibleBlocks.matchAll(lineStart)) {
    const open = match.index + match[0].lastIndexOf("[");
    const label = parseBracketedMarkdown(visibleBlocks, open);
    if (label === null || visibleBlocks[label.end] !== ":") continue;
    if (/\n[ \t]*\n/.test(visibleBlocks.slice(open, label.end))) continue;
    const target = parseMarkdownDefinitionDestination(visibleBlocks, label.end + 1);
    // CommonMark resolves the first definition for a normalized label. Using
    // the last one would let a later ledger-listed target hide an earlier
    // unreviewed target that GitHub actually renders.
    const normalizedLabel = normalizeMarkdownLabel(label.value);
    if (target !== null && !definitions.has(normalizedLabel)) {
      definitions.set(normalizedLabel, target);
    }
  }
  return definitions;
}

function decodeHtmlCharacterReferences(value, document, context = value) {
  const named = {
    amp: "&",
    apos: `'`,
    gt: ">",
    hellip: "…",
    lt: "<",
    mdash: "—",
    nbsp: "\u00a0",
    ndash: "–",
    quot: `"`,
  };
  const decoded = value.replace(
    /&(?:#(\d+);?|#x([0-9a-f]+);?|([a-z][a-z0-9]+);)/gi,
    (entity, decimal, hexadecimal, name) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = decimal !== undefined
          ? Number(decimal)
          : Number.parseInt(hexadecimal, 16);
        if (
          !Number.isInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          throw new Error(
            `${document}: image syntax uses an invalid numeric character reference: ${context}`,
          );
        }
        return String.fromCodePoint(codePoint);
      }
      return named[name.toLocaleLowerCase("en-US")] ?? entity;
    },
  );
  if (/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(decoded)) {
    throw new Error(
      `${document}: image syntax uses an unsupported HTML character reference: ${context}`,
    );
  }
  return decoded;
}

function isHtmlSpace(character) {
  return character !== undefined && /[ \t\n\f\r]/.test(character);
}

function collectHtmlTags(text, tagName, document) {
  const tags = [];
  const opener = new RegExp(`<${tagName}\\b`, "gi");
  for (const match of text.matchAll(opener)) {
    let index = match.index + match[0].length;
    let quote = null;
    while (index < text.length) {
      const character = text[index];
      if (quote !== null) {
        if (character === quote) quote = null;
        index += 1;
        continue;
      }
      if (character === `"` || character === `'`) {
        quote = character;
        index += 1;
        continue;
      }
      if (character === ">") break;
      index += 1;
    }
    if (index >= text.length || quote !== null) {
      throw new Error(`${document}: <${tagName}> tag is not terminated and cannot be checked`);
    }
    tags.push({
      tag: text.slice(match.index, index + 1),
      attributes: text.slice(match.index + match[0].length, index),
      start: match.index,
      end: index + 1,
    });
  }
  return tags;
}

function parseHtmlSrcset(value, document, tag) {
  const decoded = decodeHtmlCharacterReferences(value, document, tag).trim();
  if (!decoded) {
    throw new Error(`${document}: image srcset must not be empty: ${tag}`);
  }
  if (/\bdata:/i.test(decoded)) {
    throw new Error(`${document}: embedded data image in srcset is not privacy-ledgered: ${tag}`);
  }
  const targets = [];
  for (const candidate of decoded.split(",")) {
    const parts = candidate.trim().split(/[ \t\n\f\r]+/);
    const target = parts.shift() ?? "";
    if (!target || parts.length > 1) {
      throw new Error(`${document}: image srcset candidate is malformed: ${tag}`);
    }
    if (parts.length === 1 && !/^(?:[1-9][0-9]*w|(?:[0-9]*\.)?[0-9]+x)$/.test(parts[0])) {
      throw new Error(`${document}: image srcset descriptor is malformed: ${tag}`);
    }
    targets.push(target);
  }
  return targets;
}

/**
 * Read an HTML tag's attributes from left to right. Regex searching cannot do
 * this safely: text such as `data-note=" alt='false'"` is one attribute value,
 * not a second attribute. Only exact, quoted src/alt attributes are useful to
 * the publication gate; duplicate exact names are rejected as ambiguous.
 */
function parseHtmlAttributes(source, document, tag) {
  const attributes = new Map();
  let index = 0;
  while (index < source.length) {
    while (isHtmlSpace(source[index])) index += 1;
    if (index >= source.length) break;
    if (source[index] === "/") {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (
      index < source.length &&
      !isHtmlSpace(source[index]) &&
      !/[=/>]/.test(source[index])
    ) {
      index += 1;
    }
    if (nameStart === index) {
      throw new Error(`${document}: <img> tag has malformed attributes: ${tag}`);
    }
    const name = source.slice(nameStart, index).toLocaleLowerCase("en-US");
    while (isHtmlSpace(source[index])) index += 1;

    let value = null;
    if (source[index] === "=") {
      index += 1;
      while (isHtmlSpace(source[index])) index += 1;
      const quote = source[index];
      if (quote === `"` || quote === `'`) {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        if (index >= source.length) {
          throw new Error(
            `${document}: <img> tag has an unterminated quoted attribute: ${tag}`,
          );
        }
        value = source.slice(valueStart, index);
        index += 1;
      } else {
        // Consume an unquoted value as one attribute so its contents cannot be
        // reinterpreted. src/alt remain null and therefore fail closed.
        while (index < source.length && !isHtmlSpace(source[index])) index += 1;
      }
    }

    if (attributes.has(name)) {
      throw new Error(
        `${document}: <img> tag has duplicate '${name}' attributes: ${tag}`,
      );
    }
    attributes.set(name, value);
  }
  return attributes;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 2) {
    throw new Error(
      "usage: node scripts/check_public_media.mjs [repository-root] [manifest-path]",
    );
  }
  const scriptRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const repositoryRoot = path.resolve(args[0] ?? scriptRoot);
  const manifestPath = args[1]
    ? path.resolve(repositoryRoot, args[1])
    : path.join(repositoryRoot, "docs/media/public-assets.json");
  const result = validatePublicMedia(repositoryRoot, manifestPath);
  process.stdout.write(
    `public media manifest valid: ${result.assets} assets, ${result.published} published references, ` +
      `${result.provenance} recorded capture build(s)\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`public media manifest invalid: ${error.message}\n`);
    process.exitCode = 1;
  }
}
