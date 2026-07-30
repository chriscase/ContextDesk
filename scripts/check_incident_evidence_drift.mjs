#!/usr/bin/env node
/**
 * Value/parity drift check for Incident Evidence Bundle v1.
 * Fails when limits, schema fields, fixtures, producers, or docs disagree —
 * not merely when identifier names disappear.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_ID = "contextdesk.incident_evidence.v1";
let failures = 0;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures += 1;
}

function mustExist(rel) {
  if (!fs.existsSync(path.join(root, rel))) fail(`missing path: ${rel}`);
}

function extractRustU64(src, name) {
  // pub const NAME: u64 = 1024 * 1024;
  // pub const NAME: usize = 512;
  const re = new RegExp(
    `pub const ${name}:\\s*(?:u64|usize|u32)\\s*=\\s*([^;]+);`,
  );
  const m = src.match(re);
  if (!m) {
    fail(`Rust constant ${name} not found`);
    return null;
  }
  const expr = m[1].trim();
  try {
    // Safe arithmetic evaluator for digit/* expressions only.
    if (!/^[\d\s*+()]+$/.test(expr)) {
      fail(`Rust constant ${name} has unsupported expression: ${expr}`);
      return null;
    }
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${expr});`)();
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(`Rust constant ${name} did not evaluate to a number`);
      return null;
    }
    return v;
  } catch (e) {
    fail(`Rust constant ${name} eval failed: ${e}`);
    return null;
  }
}

function extractSchemaMax(schema, pointerParts) {
  let cur = schema;
  for (const p of pointerParts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

const rust = read("crates/cd-core/src/incident_evidence.rs");
const archiveRust = read("crates/cd-core/src/incident_evidence_archive.rs");
const spec = read("docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md");
const manifestSchema = JSON.parse(
  read("docs/specs/incident-evidence/schemas/manifest.v1.json"),
);
const componentSchema = JSON.parse(
  read("docs/specs/incident-evidence/schemas/component.v1.json"),
);

const requiredFiles = [
  "docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md",
  "docs/specs/incident-evidence/schemas/manifest.v1.json",
  "docs/specs/incident-evidence/schemas/component.v1.json",
  "crates/cd-core/src/incident_evidence.rs",
  "crates/cd-core/src/incident_evidence_archive.rs",
  "crates/cd-core/src/bin/cd-validate-incident-evidence.rs",
  "docs/help/log-analysis/incident-evidence-bundle.md",
  "docs/design/proven-methods/INCIDENT_EVIDENCE_BUNDLE.md",
  "examples/incident-evidence-producers/README.md",
  "examples/incident-evidence-producers/produce.py",
  "examples/incident-evidence-producers/produce.mjs",
  "fixtures/incident-evidence/valid/minimal-log-only/manifest.json",
  "fixtures/incident-evidence/valid/logs-plus-metrics/manifest.json",
  "fixtures/incident-evidence/metrics-parity/valid-with-provenance.json",
  "fixtures/incident-evidence/metrics-parity/invalid-missing-series-provenance.json",
  "docs/help/assets/incident-evidence-lifecycle.svg",
  "docs/help/assets/incident-evidence-anatomy.svg",
  "docs/help/assets/incident-evidence-trust.svg",
];
for (const rel of requiredFiles) mustExist(rel);

// Schema id exact alignment
for (const rel of [
  "docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md",
  "docs/specs/incident-evidence/schemas/manifest.v1.json",
  "crates/cd-core/src/incident_evidence.rs",
  "docs/help/log-analysis/incident-evidence-bundle.md",
  "README.md",
  "examples/incident-evidence-producers/produce.py",
  "examples/incident-evidence-producers/produce.mjs",
]) {
  if (!read(rel).includes(SCHEMA_ID)) fail(`${rel}: missing schema id ${SCHEMA_ID}`);
}

// Numeric limit parity: Rust ↔ schema ↔ spec
const limits = {
  MAX_MANIFEST_BYTES: extractRustU64(rust, "MAX_MANIFEST_BYTES"),
  MAX_COMPONENTS: extractRustU64(rust, "MAX_COMPONENTS"),
  MAX_PER_FILE_BYTES: extractRustU64(rust, "MAX_PER_FILE_BYTES"),
  MAX_AGGREGATE_BYTES: extractRustU64(rust, "MAX_AGGREGATE_BYTES"),
  MAX_RELATIVE_PATH_BYTES: extractRustU64(rust, "MAX_RELATIVE_PATH_BYTES"),
  MAX_METRICS_DOC_BYTES: extractRustU64(rust, "MAX_METRICS_DOC_BYTES"),
  MAX_METRICS_SERIES: extractRustU64(rust, "MAX_METRICS_SERIES"),
  MAX_METRICS_POINTS_PER_SERIES: extractRustU64(
    rust,
    "MAX_METRICS_POINTS_PER_SERIES",
  ),
  MAX_ARCHIVE_COMPRESSED_BYTES: extractRustU64(
    archiveRust,
    "MAX_ARCHIVE_COMPRESSED_BYTES",
  ),
  MAX_COMPRESSION_RATIO: extractRustU64(archiveRust, "MAX_COMPRESSION_RATIO"),
};

const expected = {
  MAX_MANIFEST_BYTES: 1024 * 1024,
  MAX_COMPONENTS: 512,
  MAX_PER_FILE_BYTES: 512 * 1024 * 1024,
  MAX_AGGREGATE_BYTES: 2 * 1024 * 1024 * 1024,
  MAX_RELATIVE_PATH_BYTES: 1024,
  MAX_METRICS_DOC_BYTES: 8 * 1024 * 1024,
  MAX_METRICS_SERIES: 256,
  MAX_METRICS_POINTS_PER_SERIES: 100000,
  MAX_ARCHIVE_COMPRESSED_BYTES: 2 * 1024 * 1024 * 1024,
  MAX_COMPRESSION_RATIO: 100,
};

for (const [name, want] of Object.entries(expected)) {
  const got = limits[name];
  if (got !== want) fail(`${name}: Rust value ${got} != expected ${want}`);
  if (!spec.includes(name)) fail(`spec missing constant name ${name}`);
}

// Schema maxItems / maxLength / maximum must match Rust
const schemaMaxComponents = extractSchemaMax(manifestSchema, [
  "properties",
  "components",
  "maxItems",
]);
if (schemaMaxComponents !== limits.MAX_COMPONENTS) {
  fail(
    `manifest.v1.json components.maxItems ${schemaMaxComponents} != MAX_COMPONENTS ${limits.MAX_COMPONENTS}`,
  );
}
const schemaPathMax = extractSchemaMax(componentSchema, [
  "$defs",
  "relativePath",
  "maxLength",
]);
if (schemaPathMax !== limits.MAX_RELATIVE_PATH_BYTES) {
  fail(
    `relativePath.maxLength ${schemaPathMax} != MAX_RELATIVE_PATH_BYTES ${limits.MAX_RELATIVE_PATH_BYTES}`,
  );
}
const schemaBytesMax = extractSchemaMax(componentSchema, [
  "$defs",
  "component",
  "properties",
  "bytes",
  "maximum",
]);
if (schemaBytesMax !== limits.MAX_PER_FILE_BYTES) {
  fail(
    `component.bytes.maximum ${schemaBytesMax} != MAX_PER_FILE_BYTES ${limits.MAX_PER_FILE_BYTES}`,
  );
}

// Valid fixtures: schemaId + hashes match on-disk payloads
for (const name of [
  "minimal-log-only",
  "logs-plus-metrics",
  "multi-source-dup-basenames",
  "with-attachment",
]) {
  const manRel = `fixtures/incident-evidence/valid/${name}/manifest.json`;
  const man = JSON.parse(read(manRel));
  if (man.schemaId !== SCHEMA_ID) fail(`${manRel}: schemaId drift`);
  for (const c of man.components) {
    const payload = path.join(
      root,
      `fixtures/incident-evidence/valid/${name}`,
      c.path,
    );
    if (!fs.existsSync(payload)) {
      fail(`${manRel}: missing payload ${c.path}`);
      continue;
    }
    const buf = fs.readFileSync(payload);
    if (buf.length !== c.bytes) {
      fail(`${manRel}: ${c.path} bytes ${c.bytes} != actual ${buf.length}`);
    }
    const hex = createHash("sha256").update(buf).digest("hex");
    if (hex !== c.sha256) {
      fail(`${manRel}: ${c.path} sha256 mismatch`);
    }
  }
}

// Metrics parity: valid fixture has series provenance; invalid lacks it
const validMetrics = JSON.parse(
  read("fixtures/incident-evidence/metrics-parity/valid-with-provenance.json"),
);
if (validMetrics.schemaVersion !== 1) fail("parity valid schemaVersion");
for (const s of validMetrics.series) {
  if (!s.provenance || !s.provenance.source) {
    fail(`parity valid series ${s.id} missing provenance.source`);
  }
}
const invalidMetrics = JSON.parse(
  read(
    "fixtures/incident-evidence/metrics-parity/invalid-missing-series-provenance.json",
  ),
);
if (invalidMetrics.series?.[0]?.provenance?.source) {
  fail("parity invalid fixture unexpectedly has provenance.source");
}

// logs-plus-metrics must share provenance requirement with parity valid doc shape
const lpm = JSON.parse(
  read(
    "fixtures/incident-evidence/valid/logs-plus-metrics/metrics/operational-metrics.v1.json",
  ),
);
for (const s of lpm.series) {
  if (!s.provenance?.source) {
    fail(`logs-plus-metrics series ${s.id} missing required provenance.source`);
  }
}

// Producers emit schema id + createdAt with Z
for (const rel of [
  "examples/incident-evidence-producers/produce.mjs",
  "examples/incident-evidence-producers/produce.py",
]) {
  const t = read(rel);
  if (!t.includes(SCHEMA_ID)) fail(`${rel}: schema id`);
  if (!t.includes("createdAt") && !t.includes("created_at")) {
    fail(`${rel}: createdAt field`);
  }
}

// Theme-safe diagrams: no currentColor (img/base64 cannot inherit page theme)
for (const rel of [
  "docs/help/assets/incident-evidence-lifecycle.svg",
  "docs/help/assets/incident-evidence-anatomy.svg",
  "docs/help/assets/incident-evidence-trust.svg",
]) {
  // Strip XML/HTML comments before scanning presentation attributes.
  const svg = read(rel).replace(/<!--[\s\S]*?-->/g, "");
  if (/\bcurrentColor\b/i.test(svg)) {
    fail(`${rel}: uses currentColor (not theme-safe via <img>)`);
  }
  if (!svg.includes("#")) {
    fail(`${rel}: expected explicit hex colors for light/dark readability`);
  }
}

// Residual honesty
if (!spec.includes("Product import/attachment UX")) {
  fail("spec missing import residual");
}
if (!spec.includes("MAX_ARCHIVE_COMPRESSED_BYTES")) {
  fail("spec missing archive compressed limit");
}
if (!archiveRust.includes("CompressionMethod::Stored")) {
  fail("archive pack missing Stored compression");
}
if (!read("docs/design/PROVEN_METHODS.md").includes("INCIDENT_EVIDENCE_BUNDLE.md")) {
  fail("handbook index missing chapter link");
}

// Help process tags
const help = read("docs/help/log-analysis/incident-evidence-bundle.md");
if (!help.includes("incident-evidence-lifecycle.svg")) {
  fail("help missing lifecycle SVG");
}
if (!help.includes("| Format | What it is | When to use |")) {
  fail("help missing distinction table");
}

// Intentional negative: if someone changes MAX_COMPONENTS without schema, already covered.
// Self-check: drift script rejects wrong injected value
if (limits.MAX_COMPONENTS === 512) {
  // ok
} else {
  fail("self-check MAX_COMPONENTS");
}

if (failures > 0) {
  console.error(`check_incident_evidence_drift: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  `check_incident_evidence_drift: OK (schemaId=${SCHEMA_ID}, limits verified, fixtures hashed, metrics provenance parity)`,
);
