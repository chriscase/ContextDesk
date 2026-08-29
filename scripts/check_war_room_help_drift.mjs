#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function fail(errors, message) {
  errors.push(message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngDimensions(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function validateWarRoomHelpDrift(repositoryRoot = ownRoot) {
  const root = resolve(repositoryRoot);
  const errors = [];
  const markdownRoots = [
    join(root, "docs", "war-room"),
    join(root, "docs", "help", "war-room"),
    join(root, "docs", "help", "log-analysis"),
  ];
  for (const markdown of markdownRoots.flatMap(walk).filter((path) => extname(path) === ".md")) {
    const text = readFileSync(markdown, "utf8");
    for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const alt = match[1].trim();
      const target = match[2].trim().split("#", 1)[0];
      if (!alt) fail(errors, `${relative(root, markdown)} has an image with empty alt text`);
      if (!target || /^(?:https?:|data:)/.test(target)) continue;
      const asset = resolve(dirname(markdown), target);
      if (!asset.startsWith(`${root}/`) || !existsSync(asset) || !statSync(asset).isFile()) {
        fail(errors, `${relative(root, markdown)} references missing image ${target}`);
      }
    }
  }

  const pngs = [
    ...walk(join(root, "docs", "assets", "war-room")),
    ...walk(join(root, "collab", "web", "public", "help", "war-room")),
    ...walk(join(root, "docs", "media", "gallery")).filter((path) =>
      /(?:war-room|log-explorer).*\.png$/i.test(path),
    ),
  ].filter((path) => extname(path).toLowerCase() === ".png");
  for (const png of pngs) {
    if (!pngDimensions(png)) fail(errors, `${relative(root, png)} is named .png but is not PNG data`);
  }

  const docsAssets = join(root, "docs", "assets", "war-room");
  const publicAssets = join(root, "collab", "web", "public", "help", "war-room");
  for (const publicPath of walk(publicAssets).filter((path) => extname(path) === ".png")) {
    const docsPath = join(docsAssets, relative(publicAssets, publicPath));
    if (!existsSync(docsPath)) {
      fail(errors, `${relative(root, publicPath)} has no docs/assets/war-room counterpart`);
    } else if (sha256(publicPath) !== sha256(docsPath)) {
      fail(errors, `${relative(root, publicPath)} differs from ${relative(root, docsPath)}`);
    }
  }

  const helpPath = join(root, "collab", "web", "src", "HelpCenter.tsx");
  const help = readFileSync(helpPath, "utf8");
  for (const match of help.matchAll(/src:\s*"(\/help\/war-room\/[^"\n]+\.png)"/g)) {
    const block = help.slice(match.index, help.indexOf("}", match.index) + 1);
    for (const field of ["alt", "caption"]) {
      if (!new RegExp(`${field}:\\s*"[^"\\n]+"`).test(block)) {
        fail(errors, `HelpCenter illustration is missing a non-empty ${field}`);
      }
    }
    const publicPath = join(root, "collab", "web", "public", match[1].replace(/^\/help\//, "help/"));
    if (!existsSync(publicPath)) {
      fail(errors, `HelpCenter illustration references missing ${match[1]}`);
    }
  }

  const demoStatic = readFileSync(join(root, "collab", "server", "src", "demo-static.ts"), "utf8");
  if (!/readdir\(illustrationDir\)/.test(demoStatic) || !/endsWith\("\.png"\)/.test(demoStatic)) {
    fail(errors, "static demo must discover every public War Room PNG instead of maintaining a hand list");
  }

  const shippedUi = [
    join(root, "collab", "web", "src", "TriageWorkspace.tsx"),
    join(root, "collab", "web", "src", "Cases.tsx"),
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  const canonicalTimezoneIds = shippedUi.match(/id="triage-log-time"/g) ?? [];
  if (canonicalTimezoneIds.length !== 1) {
    fail(errors, `shipped UI must contain exactly one canonical triage-log-time id (found ${canonicalTimezoneIds.length})`);
  }

  const truth = [
    readFileSync(join(root, "docs", "war-room", "README.md"), "utf8"),
    readFileSync(join(root, "docs", "war-room", "END_TO_END.md"), "utf8"),
    readFileSync(join(root, "docs", "benchmarks", "CONTEXTDESK_DEMO_RUNBOOK.md"), "utf8"),
    readFileSync(join(root, "docs", "assets", "war-room", "war-room-portable-archive.svg"), "utf8"),
  ].join("\n");
  for (const stale of ["Restore/apply is intentionally unavailable", "No restore/apply"]) {
    if (truth.includes(stale)) fail(errors, `stale portable-archive claim remains: ${stale}`);
  }
  for (const required of ["trusted timezone host", "stack vertically", "RESTORE"]) {
    if (!truth.includes(required)) fail(errors, `War Room truth corpus is missing required boundary: ${required}`);
  }

  return { errors, markdownPages: markdownRoots.flatMap(walk).filter((path) => extname(path) === ".md").length, pngs: pngs.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = validateWarRoomHelpDrift(process.argv[2] ?? ownRoot);
  if (result.errors.length) {
    process.stderr.write(`${result.errors.map((error) => `FAIL: ${error}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`check_war_room_help_drift: OK (${result.markdownPages} pages, ${result.pngs} PNGs)\n`);
  }
}
