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
      // Remote badges are not repository media and carry no local bytes.
      if (/^(?:https?:)?\/\//i.test(target) || target.startsWith("data:")) {
        continue;
      }
      if (!RASTER_EXTENSION_RE.test(target)) continue;
      const normalized = target.replace(/^\.\//, "");
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

  // Link reference definitions: `[label]: target "optional title"`.
  const definitions = new Map();
  for (const match of text.matchAll(
    /^[ \t]{0,3}\[((?:\\.|[^\]\\])+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+["'(].*)?[ \t]*$/gm,
  )) {
    definitions.set(
      match[1].trim().toLowerCase(),
      match[2] ?? match[3],
    );
  }

  // Inline: ![alt](target "title")
  for (const match of text.matchAll(
    /!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))[^)]*\)/g,
  )) {
    targets.push({
      target: match[2] ?? match[3],
      form: "inline",
      alt: match[1],
    });
  }

  // Full reference ![alt][label], collapsed ![label][], shortcut ![label].
  for (const match of text.matchAll(
    /!\[((?:\\.|[^\]\\])*)\](?:\[((?:\\.|[^\]\\])*)\])?/g,
  )) {
    const end = match.index + match[0].length;
    // Skip the inline form, already collected above.
    if (match[2] === undefined && text.slice(end, end + 1) === "(") continue;
    const label = (match[2] && match[2].trim()) || match[1].trim();
    if (!label) continue;
    const target = definitions.get(label.toLowerCase());
    if (target === undefined) {
      // A reference image with no definition renders as literal text, but an
      // unresolvable *local raster* reference is the ambiguous case this must
      // not wave through.
      if (RASTER_EXTENSION_RE.test(label)) {
        throw new Error(
          `${document}: reference image '${match[0]}' has no link definition`,
        );
      }
      continue;
    }
    targets.push({ target, form: "reference", alt: match[1] });
  }

  // Raw HTML: <img src="target" alt="description">
  for (const match of text.matchAll(/<img\b([^>]*)>/gi)) {
    const attributes = parseHtmlAttributes(match[1], document, match[0]);
    const src = attributes.get("src");
    if (src === undefined || src === null) {
      throw new Error(
        `${document}: <img> tag without a quoted literal src cannot be checked: ${match[0]}`,
      );
    }
    targets.push({
      target: src,
      form: "html",
      alt: attributes.get("alt") ?? "",
    });
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
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    if (source[index] === "/") {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) {
      index += 1;
    }
    if (nameStart === index) {
      throw new Error(`${document}: <img> tag has malformed attributes: ${tag}`);
    }
    const name = source.slice(nameStart, index).toLocaleLowerCase("en-US");
    while (/\s/.test(source[index] ?? "")) index += 1;

    let value = null;
    if (source[index] === "=") {
      index += 1;
      while (/\s/.test(source[index] ?? "")) index += 1;
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
        while (index < source.length && !/\s/.test(source[index])) index += 1;
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
