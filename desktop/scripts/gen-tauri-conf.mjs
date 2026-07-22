#!/usr/bin/env node
/**
 * Generate Tauri productName / identifier / window title from repo branding.toml (#174).
 *
 * Usage (from desktop/): node scripts/gen-tauri-conf.mjs
 * Invoked by beforeDevCommand / beforeBuildCommand so renames need only branding.toml + rebuild.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const brandingPath = path.join(repoRoot, "branding.toml");
const confPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");

/** Minimal TOML extract for [product] name/slug (no external dep). */
function parseBranding(raw) {
  let name = null;
  let slug = null;
  let inProduct = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inProduct = t === "[product]";
      continue;
    }
    if (!inProduct || t.startsWith("#") || !t) continue;
    const m = t.match(/^(\w+)\s*=\s*"(.*)"\s*$/);
    if (!m) continue;
    if (m[1] === "name") name = m[2];
    if (m[1] === "slug") slug = m[2];
  }
  if (!name || !slug) {
    throw new Error(
      `branding.toml missing product.name or product.slug (parsed name=${name} slug=${slug})`,
    );
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error(`product.slug must be lowercase slug-like, got: ${slug}`);
  }
  return { name, slug };
}

function main() {
  const raw = fs.readFileSync(brandingPath, "utf8");
  const { name, slug } = parseBranding(raw);
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  conf.productName = name;
  conf.identifier = `cc.chriscase.${slug}`;
  if (!conf.app) conf.app = {};
  if (!Array.isArray(conf.app.windows) || conf.app.windows.length === 0) {
    conf.app.windows = [{ title: name, width: 1100, height: 760, resizable: true }];
  } else {
    conf.app.windows[0].title = name;
    // Keep capability window match stable (#drag / ACL).
    if (!conf.app.windows[0].label) conf.app.windows[0].label = "main";
  }
  if (!conf.app.security) conf.app.security = {};
  if (!Array.isArray(conf.app.security.capabilities)) {
    conf.app.security.capabilities = ["default"];
  }
  const out = JSON.stringify(conf, null, 2) + "\n";
  // Avoid dirtying the worktree on every tauri dev when conf already matches.
  let prev = "";
  try {
    prev = fs.readFileSync(confPath, "utf8");
  } catch {
    /* missing → write */
  }
  if (prev === out) {
    console.log(
      `[gen-tauri-conf] unchanged productName=${name} identifier=${conf.identifier}`,
    );
    return;
  }
  fs.writeFileSync(confPath, out, "utf8");
  console.log(
    `[gen-tauri-conf] productName=${name} identifier=${conf.identifier} window.title=${name}`,
  );
}

main();
