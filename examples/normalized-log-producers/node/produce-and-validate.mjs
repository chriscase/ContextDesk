#!/usr/bin/env node
/**
 * Reference producer + conformance validator for
 * `contextdesk.normalized_log_events.v1`.
 *
 * Zero dependencies, Node built-ins only, so it can be dropped into any
 * producer's build. Two modes:
 *
 *   node produce-and-validate.mjs --emit
 *   node produce-and-validate.mjs --check ../../../fixtures/normalized-log-events
 *
 * `--check` runs the SAME frozen fixtures the Rust validator uses. Three
 * implementations agreeing on one corpus is what makes this contract portable
 * under #826, instead of three separate readings of prose. When this file and
 * the Rust validator disagree about a fixture, one of them is wrong — that is
 * the point of keeping them on the same bytes.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_ID = "contextdesk.normalized_log_events.v1";
const READER_VERSION = 1;

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_ID_CHARS = 128;
const MAX_SEVERITY_NUMBER = 24;
const MAX_CORRELATIONS = 32;
const MAX_MESSAGE_CHARS = 64 * 1024;

/**
 * Top-level keys an older ContextDesk reader treats as authoritative
 * wall-clock time. A conforming event must never carry them: it could declare
 * order_only while a sidecar `ts` epoch silently put the corpus on a wall clock.
 */
const RESERVED_EVENT_KEYS = ["ts", "timestamp", "@timestamp"];

/**
 * The eleven typed correlation classes (#789). Trace and span are deliberately
 * absent: they are their own event fields, so a span id cannot be routed into a
 * trace slot through this mechanism.
 */
const CORRELATION_CLASSES = new Set([
  "request",
  "session",
  "transaction",
  "activity",
  "audit",
  "flow",
  "boot",
  "container",
  "pod",
  "event",
  "query",
]);

/** RFC3339 with an EXPLICIT offset. A bare local time is a guessed instant. */
const INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-](0\d|1\d|2[0-3]):[0-5]\d)$/;
const TRACE_RE = /^[0-9a-f]{32}$/;
const SPAN_RE = /^[0-9a-f]{16}$/;

/** Mirrors cd_core::incident_evidence::FORBIDDEN_MANIFEST_SENTINELS. */
const FORBIDDEN_SENTINELS = [
  "evaluator_truth",
  "evaluator-truth",
  "answer_key",
  "answer-key",
  "expected_diagnosis",
  "truth_inventory",
  "company-data",
];

/** resolution -> [instant, localText, resolvedTimezone]; req | opt | no. */
const LEGALITY = {
  source_explicit: ["req", "opt", "no"],
  producer_resolved: ["req", "req", "req"],
  unresolved: ["no", "req", "no"],
  order_only: ["no", "no", "no"],
};
const WALL_RESOLUTIONS = new Set(["source_explicit", "producer_resolved"]);

const hasSentinel = (text) =>
  typeof text === "string" &&
  FORBIDDEN_SENTINELS.some((sentinel) => text.toLowerCase().includes(sentinel));

const isInstant = (value) =>
  typeof value === "string" &&
  INSTANT_RE.test(value) &&
  // RFC3339 reserves -00:00 for "offset unknown" — the same as not having one.
  !value.endsWith("-00:00");

/** A real IANA zone, not merely a plausible-looking string. */
const isIanaZone = (value) => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const isIdentifier = (value) => {
  if (typeof value !== "string" || value.trim() === "") return false;
  // Count CODE POINTS, matching Rust's chars().count() and Python's len();
  // `value.length` counts UTF-16 units and would disagree on astral chars.
  if ([...value].length > MAX_ID_CHARS) return false;
  // Rust's char::is_control covers C0 AND C1 (U+0080-U+009F).
  return ![...value].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
};

const isInteger = (value) => Number.isInteger(value) && typeof value === "number";

function validateTime(time, errors, line) {
  if (typeof time !== "object" || time === null) {
    errors.push([line, "event_malformed", "time"]);
    return;
  }
  const { resolution, basis } = time;
  if (!(resolution in LEGALITY)) {
    errors.push([line, "time_basis_inconsistent", "time.resolution"]);
    return;
  }
  if (!["wall", "relative", "order"].includes(basis)) {
    errors.push([line, "time_basis_inconsistent", "time.basis"]);
    return;
  }

  const [wantInstant, wantLocal, wantZone] = LEGALITY[resolution];
  const haveInstant = time.instant !== undefined && time.instant !== null;
  const haveLocal = time.localText !== undefined && time.localText !== null;
  const haveZone =
    time.resolvedTimezone !== undefined && time.resolvedTimezone !== null;

  if (wantInstant === "req" && !haveInstant) {
    errors.push([line, "instant_required", "time.instant"]);
  }
  if (wantInstant === "no" && haveInstant) {
    // The guessed-instant guard.
    errors.push([line, "instant_not_permitted", "time.instant"]);
  }
  if (haveInstant && !isInstant(time.instant)) {
    errors.push([line, "instant_malformed", "time.instant"]);
  }

  if (wantLocal === "req" && !haveLocal) {
    errors.push([line, "local_text_required", "time.localText"]);
  }
  if (wantLocal === "no" && haveLocal) {
    errors.push([line, "time_basis_inconsistent", "time.localText"]);
  }

  if (wantZone === "req" && !haveZone) {
    errors.push([line, "resolved_timezone_invalid", "time.resolvedTimezone"]);
  }
  if (wantZone === "no" && haveZone) {
    errors.push([line, "resolved_timezone_invalid", "time.resolvedTimezone"]);
  }
  if (haveZone && !isIanaZone(time.resolvedTimezone)) {
    errors.push([line, "resolved_timezone_invalid", "time.resolvedTimezone"]);
  }

  const wallExpected = WALL_RESOLUTIONS.has(resolution);
  if (wallExpected && basis !== "wall") {
    errors.push([line, "time_basis_inconsistent", "time.basis"]);
  }
  if (!wallExpected && basis === "wall") {
    errors.push([line, "time_basis_inconsistent", "time.basis"]);
  }

  if (time.observed !== undefined && !isInstant(time.observed)) {
    errors.push([line, "instant_malformed", "time.observed"]);
  }
}

function validateEvent(event, expectedSeq, errors, line) {
  for (const reserved of RESERVED_EVENT_KEYS) {
    if (Object.hasOwn(event, reserved)) {
      errors.push([line, "reserved_key_present", reserved]);
    }
  }

  if (!isInteger(event.sourceSeq) || event.sourceSeq !== expectedSeq) {
    errors.push([line, "sequence_not_contiguous", "sourceSeq"]);
  }

  if (typeof event.message !== "string") {
    errors.push([line, "event_malformed", "message"]);
  } else if ([...event.message].length > MAX_MESSAGE_CHARS) {
    errors.push([line, "bounds_exceeded", "message"]);
  }

  if (typeof event.time !== "object" || event.time === null) {
    errors.push([line, "event_malformed", "time"]);
  }

  validateTime(event.time, errors, line);

  const severity = event.severity;
  const CONFIDENCES = ["high", "medium", "low"];
  const PROVENANCES = [
    "source_declared",
    "schema_mapped",
    "text_inferred",
    "absent",
  ];
  if (
    typeof severity !== "object" ||
    severity === null ||
    !CONFIDENCES.includes(severity.confidence) ||
    !PROVENANCES.includes(severity.provenance)
  ) {
    errors.push([line, "event_malformed", "severity"]);
  } else {
    if (severity.canonical !== undefined && severity.canonical !== null) {
      if (
        !isInteger(severity.canonical) ||
        severity.canonical < 0 ||
        severity.canonical > MAX_SEVERITY_NUMBER
      ) {
        errors.push([line, "severity_number_out_of_range", "severity.canonical"]);
      }
    }
    // confidence and provenance must agree.
    const { provenance: prov, confidence: conf } = severity;
    const coherent =
      (prov === "source_declared" && conf === "high") ||
      (prov === "schema_mapped" && (conf === "high" || conf === "medium")) ||
      (prov === "text_inferred" && conf === "low") ||
      prov === "absent";
    if (!coherent) {
      errors.push([line, "severity_provenance_inconsistent", "severity"]);
    }
    if (prov === "absent" && severity.raw !== undefined) {
      errors.push([line, "severity_provenance_inconsistent", "severity.raw"]);
    }
  }

  if (event.traceId !== undefined) {
    if (
      typeof event.traceId !== "string" ||
      !TRACE_RE.test(event.traceId) ||
      /^0+$/.test(event.traceId)
    ) {
      errors.push([line, "trace_identifier_malformed", "traceId"]);
    }
  }
  if (event.spanId !== undefined) {
    if (
      typeof event.spanId !== "string" ||
      !SPAN_RE.test(event.spanId) ||
      /^0+$/.test(event.spanId)
    ) {
      errors.push([line, "trace_identifier_malformed", "spanId"]);
    }
  }

  const correlations = Array.isArray(event.correlations)
    ? event.correlations
    : (event.correlations === undefined ? [] : null);
  if (correlations === null) {
    errors.push([line, "event_malformed", "correlations"]);
  }
  if (correlations && correlations.length > MAX_CORRELATIONS) {
    errors.push([line, "bounds_exceeded", "correlations"]);
  }
  const seen = new Set();
  for (const correlation of correlations ?? []) {
    if (typeof correlation !== "object" || correlation === null) {
      errors.push([line, "event_malformed", "correlations"]);
      continue;
    }
    if (!CORRELATION_CLASSES.has(correlation.class)) {
      errors.push([line, "event_malformed", "correlations"]);
      continue;
    }
    if (seen.has(correlation.class)) {
      errors.push([line, "duplicate_correlation_class", "correlations"]);
    }
    seen.add(correlation.class);
    if (!isIdentifier(correlation.value)) {
      errors.push([line, "identifier_invalid", "correlations"]);
    }
  }

  for (const field of ["message", "canonical"]) {
    if (hasSentinel(event[field])) {
      errors.push([line, "forbidden_sentinel", field]);
    }
  }

  if (typeof event.canonical !== "string" || event.canonical === "") {
    errors.push([line, "canonical_invalid", "canonical"]);
  } else if (Buffer.byteLength(event.canonical, "utf8") > MAX_CANONICAL_BYTES) {
    errors.push([line, "canonical_invalid", "canonical"]);
  }
}

/** Returns an array of `[line, code, location]`. Empty means conforming. */
export function validateFile(text) {
  const errors = [];
  if (text.trim() === "") {
    return [[0, "missing_header", null]];
  }
  const lines = text.split("\n");

  const headerLine = lines[0];
  if (Buffer.byteLength(headerLine, "utf8") > MAX_LINE_BYTES) {
    errors.push([1, "line_too_long", null]);
  }
  let header = null;
  try {
    header = JSON.parse(headerLine);
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      throw new Error("not an object");
    }
  } catch {
    errors.push([1, "header_malformed", null]);
    header = null;
  }

  if (header) {
    if (header.schemaId !== SCHEMA_ID) {
      errors.push([1, "schema_id_invalid", "schemaId"]);
    }
    if (!isInteger(header.minReaderVersion) || header.minReaderVersion < 1) {
      errors.push([1, "min_reader_version_invalid", "minReaderVersion"]);
    } else if (header.minReaderVersion > READER_VERSION) {
      errors.push([1, "reader_too_old", "minReaderVersion"]);
    }
    for (const field of ["sourceId", "sourceLabel"]) {
      if (hasSentinel(header[field])) {
        errors.push([1, "forbidden_sentinel", field]);
      }
    }
    if (hasSentinel(header.redaction?.note)) {
      errors.push([1, "forbidden_sentinel", "redaction.note"]);
    }
    if (!isIdentifier(header.sourceId)) {
      errors.push([1, "identifier_invalid", "sourceId"]);
    }
    if (
      !isIdentifier(header.producer?.name) ||
      !isIdentifier(header.producer?.version)
    ) {
      errors.push([1, "identifier_invalid", "producer"]);
    }
  }

  let expectedSeq = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "") continue;
    const lineNumber = index + 1;
    if (Buffer.byteLength(raw, "utf8") > MAX_LINE_BYTES) {
      errors.push([lineNumber, "line_too_long", null]);
      continue;
    }
    let event;
    try {
      event = JSON.parse(raw);
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        throw new Error("not an object");
      }
    } catch {
      errors.push([lineNumber, "event_malformed", null]);
      expectedSeq += 1;
      continue;
    }
    validateEvent(event, expectedSeq, errors, lineNumber);
    expectedSeq = isInteger(event.sourceSeq) ? event.sourceSeq + 1 : expectedSeq + 1;
  }

  return errors;
}

/** A minimal conforming file showing all four time resolutions. */
export function emitExample() {
  const severity = {
    raw: 6,
    canonical: 9,
    confidence: "high",
    provenance: "source_declared",
  };
  const event = (sourceSeq, time, message, canonical) => ({
    sourceSeq,
    time,
    severity,
    message,
    canonical,
  });

  const rows = [
    {
      schemaId: SCHEMA_ID,
      minReaderVersion: 1,
      sourceId: "checkout-api",
      producer: { name: "node-reference-producer", version: "1.0.0" },
      // Advisory only. ContextDesk re-redacts regardless of what we claim.
      redaction: { credentialsRemoved: true, personalDataRemoved: false },
    },
    event(
      0,
      { basis: "wall", resolution: "source_explicit", instant: "2026-01-01T00:00:00Z" },
      "explicit offset in the source",
      "2026-01-01T00:00:00Z INFO explicit offset in the source",
    ),
    event(
      1,
      {
        basis: "wall",
        resolution: "producer_resolved",
        instant: "2026-01-01T00:00:00-06:00",
        localText: "2026-01-01 00:00:00",
        resolvedTimezone: "America/Chicago",
      },
      "producer resolved a zone-less local time",
      "2026-01-01 00:00:00 INFO producer resolved a zone-less local time",
    ),
    event(
      2,
      { basis: "order", resolution: "unresolved", localText: "2026-01-01 00:00:00" },
      "local time we could not resolve, so no instant is emitted",
      "2026-01-01 00:00:00 INFO local time we could not resolve",
    ),
    event(
      3,
      { basis: "order", resolution: "order_only" },
      "no usable time at all",
      "INFO no usable time at all",
    ),
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function main(argv) {
  if (argv.includes("--emit")) {
    const text = emitExample();
    const errors = validateFile(text);
    if (errors.length > 0) {
      console.error(`BUG: emitted file does not validate: ${JSON.stringify(errors)}`);
      return 2;
    }
    process.stdout.write(text);
    return 0;
  }

  const checkIndex = argv.indexOf("--check");
  if (checkIndex !== -1 && argv[checkIndex + 1]) {
    const root = argv[checkIndex + 1];
    let failures = 0;
    let checked = 0;
    for (const expectation of ["valid", "invalid"]) {
      const dir = join(root, expectation);
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".jsonl")) continue;
        checked += 1;
        const errors = validateFile(readFileSync(join(dir, name), "utf8"));
        const ok = errors.length === 0;
        const wantOk = expectation === "valid";
        if (ok !== wantOk) {
          failures += 1;
          console.error(
            `FAIL ${expectation}/${name}: expected ${wantOk ? "valid" : "invalid"}, got ${JSON.stringify(errors)}`,
          );
        }
      }
    }
    console.log(`node conformance: ${checked} fixtures checked, ${failures} disagreement(s)`);
    return failures > 0 ? 1 : 0;
  }

  console.log("usage: produce-and-validate.mjs --emit | --check <fixtureDir>");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
