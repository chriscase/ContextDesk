/**
 * Deterministic fixtures for GUI acceptance.
 * Primary 25k path: production demo corpus (install_demo_log_corpus) — real host.
 * Also prepares a ZIP of the acceptance import tree for file-import scenarios.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { repoRoot } from "./binary.mjs";

/**
 * Checked-in 25k acceptance import root (also bundled as demo-log-corpus).
 * @param {string} [root]
 */
export function sevenDay25kImportDir(root = repoRoot()) {
  return join(
    root,
    "fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import",
  );
}

/**
 * @param {string} [root]
 */
export function sevenDay25kTruth(root = repoRoot()) {
  const p = join(
    root,
    "fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/truth/manifest.json",
  );
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * Walk files under dir.
 * @param {string} dir
 * @returns {string[]}
 */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, "en"))) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

/**
 * Create a deterministic store-only ZIP of the 25k import tree. Paths are
 * sorted and ZIP timestamps are fixed to zero, so source mtimes and installed
 * system tools cannot change the bytes.
 * @param {string} outZip
 * @param {string} [importDir]
 */
export function prepare25kZip(outZip, importDir = sevenDay25kImportDir()) {
  if (!existsSync(importDir)) {
    throw new Error(`25k import dir missing: ${importDir}`);
  }
  mkdirSync(join(outZip, ".."), { recursive: true });
  if (existsSync(outZip)) {
    // idempotent: leave existing if same source mtime marker present
  }

  writeStoreZip(importDir, outZip);

  const bytes = readFileSync(outZip);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const meta = {
    path: outZip,
    bytes: bytes.length,
    sha256,
    source: importDir,
    expectedEvents: 25_000,
    note: "Canonical ZIP of golden acceptance import; primary GUI path uses production demo install.",
  };
  writeFileSync(`${outZip}.meta.json`, JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Minimal ZIP (store only) without external deps.
 * @param {string} rootDir
 * @param {string} outZip
 */
function writeStoreZip(rootDir, outZip) {
  const files = walkFiles(rootDir);
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {{ name: string, offset: number, size: number, crc: number }[]} */
  const central = [];
  let offset = 0;

  for (const abs of files) {
    const name = relative(rootDir, abs).split("\\").join("/");
    const data = readFileSync(abs);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    parts.push(local, data);
    central.push({ name, offset, size: data.length, crc });
    offset += local.length + data.length;
  }

  /** @type {Buffer[]} */
  const centralParts = [];
  let centralSize = 0;
  for (const e of central) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const hdr = Buffer.alloc(46 + nameBuf.length);
    hdr.writeUInt32LE(0x02014b50, 0);
    hdr.writeUInt16LE(20, 4);
    hdr.writeUInt16LE(20, 6);
    hdr.writeUInt16LE(0, 8);
    hdr.writeUInt16LE(0, 10);
    hdr.writeUInt16LE(0, 12);
    hdr.writeUInt16LE(0, 14);
    hdr.writeUInt32LE(e.crc >>> 0, 16);
    hdr.writeUInt32LE(e.size, 20);
    hdr.writeUInt32LE(e.size, 24);
    hdr.writeUInt16LE(nameBuf.length, 28);
    hdr.writeUInt16LE(0, 30);
    hdr.writeUInt16LE(0, 32);
    hdr.writeUInt16LE(0, 34);
    hdr.writeUInt16LE(0, 36);
    hdr.writeUInt32LE(0, 38);
    hdr.writeUInt32LE(e.offset, 42);
    nameBuf.copy(hdr, 46);
    centralParts.push(hdr);
    centralSize += hdr.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(outZip, Buffer.concat([...parts, ...centralParts, end]));
}

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

export const EXPECTED_25K_EVENTS = 25_000;
export const DEMO_IDENTITY =
  "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1";
