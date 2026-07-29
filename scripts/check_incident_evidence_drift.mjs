#!/usr/bin/env node
/**
 * Drift check for Incident Evidence Bundle v1 (#764).
 * Ensures schema id, limits, fixtures, validator, README, Help, and Handbook
 * stay aligned.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_ID = "contextdesk.incident_evidence.v1";

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function mustContain(rel, needle, label = needle) {
  const text = read(rel);
  if (!text.includes(needle)) {
    throw new Error(`${rel}: missing ${label}`);
  }
}

function mustExist(rel) {
  if (!fs.existsSync(path.join(root, rel))) {
    throw new Error(`missing path: ${rel}`);
  }
}

const requiredFiles = [
  "docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md",
  "docs/specs/incident-evidence/schemas/manifest.v1.json",
  "docs/specs/incident-evidence/schemas/component.v1.json",
  "crates/cd-core/src/incident_evidence.rs",
  "crates/cd-core/src/bin/cd-validate-incident-evidence.rs",
  "docs/help/log-analysis/incident-evidence-bundle.md",
  "docs/design/proven-methods/INCIDENT_EVIDENCE_BUNDLE.md",
  "examples/incident-evidence-producers/README.md",
  "examples/incident-evidence-producers/produce.py",
  "examples/incident-evidence-producers/produce.mjs",
  "examples/incident-evidence-producers/produce.sh",
  "examples/incident-evidence-producers/Produce.java",
  "examples/incident-evidence-producers/produce.rs",
  "fixtures/incident-evidence/valid/minimal-log-only/manifest.json",
  "fixtures/incident-evidence/valid/logs-plus-metrics/manifest.json",
  "fixtures/incident-evidence/valid/multi-source-dup-basenames/manifest.json",
  "fixtures/incident-evidence/valid/with-attachment/manifest.json",
  "fixtures/incident-evidence/invalid/unsupported-version/manifest.json",
  "fixtures/incident-evidence/invalid/hash-mismatch/manifest.json",
  "fixtures/incident-evidence/invalid/traversal-path/manifest.json",
  "fixtures/incident-evidence/invalid/absolute-path/manifest.json",
  "fixtures/incident-evidence/invalid/duplicate-manifest-paths/manifest.json",
  "fixtures/incident-evidence/invalid/missing-payload/manifest.json",
  "fixtures/incident-evidence/invalid/invalid-metric-ref/manifest.json",
  "fixtures/incident-evidence/invalid/unresolved-timezone-dishonest/manifest.json",
  "fixtures/incident-evidence/invalid/forbidden-evaluator-truth/manifest.json",
];

for (const rel of requiredFiles) {
  mustExist(rel);
}

// Schema id alignment
for (const rel of [
  "docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md",
  "docs/specs/incident-evidence/schemas/manifest.v1.json",
  "crates/cd-core/src/incident_evidence.rs",
  "docs/help/log-analysis/incident-evidence-bundle.md",
  "docs/design/proven-methods/INCIDENT_EVIDENCE_BUNDLE.md",
  "README.md",
  "examples/incident-evidence-producers/produce.py",
]) {
  mustContain(rel, SCHEMA_ID, `schema id ${SCHEMA_ID}`);
}

// Limits appear in spec and Rust constants
const limits = [
  ["MAX_MANIFEST_BYTES", "1024 * 1024"],
  ["MAX_COMPONENTS", "512"],
  ["MAX_PER_FILE_BYTES", "512 * 1024 * 1024"],
  ["MAX_AGGREGATE_BYTES", "2 * 1024 * 1024 * 1024"],
];
const rust = read("crates/cd-core/src/incident_evidence.rs");
const spec = read("docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md");
for (const [name] of limits) {
  if (!rust.includes(name)) throw new Error(`incident_evidence.rs missing ${name}`);
  if (!spec.includes(name)) throw new Error(`spec missing ${name}`);
}

// Valid fixtures use schema id
for (const rel of [
  "fixtures/incident-evidence/valid/minimal-log-only/manifest.json",
  "fixtures/incident-evidence/valid/logs-plus-metrics/manifest.json",
]) {
  const j = JSON.parse(read(rel));
  if (j.schemaId !== SCHEMA_ID) {
    throw new Error(`${rel}: schemaId drift`);
  }
}

// Residual honesty
mustContain(
  "docs/specs/INCIDENT_EVIDENCE_BUNDLE_V1.md",
  "Product import/attachment UX",
  "import residual",
);
mustContain(
  "crates/cd-core/src/incident_evidence.rs",
  "archive_validation_residual",
  "archive residual",
);

// Handbook index links chapter
mustContain(
  "docs/design/PROVEN_METHODS.md",
  "INCIDENT_EVIDENCE_BUNDLE.md",
  "handbook index link",
);

// Help process tag requires SVG + table (corpus validator also checks)
mustContain(
  "docs/help/log-analysis/incident-evidence-bundle.md",
  "incident-evidence-lifecycle.svg",
  "help lifecycle SVG",
);
mustContain(
  "docs/help/log-analysis/incident-evidence-bundle.md",
  "| Format | What it is | When to use |",
  "help distinction table",
);

console.log(
  `check_incident_evidence_drift: OK (schemaId=${SCHEMA_ID}, files=${requiredFiles.length})`,
);
