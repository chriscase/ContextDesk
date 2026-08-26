#!/usr/bin/env node
/**
 * Fail closed on non-synthetic material in the War Room scenario corpus.
 *
 * The scenario journeys ship fixtures that *look* like real incident traffic —
 * support bundles, correspondence, chat transcripts. That is the point, and it
 * is also the risk: a contributor reaching for a realistic example is one paste
 * away from committing a customer's address or a live host. This validator is
 * the thing that stops that being a silent mistake.
 *
 * It allows only documentation-reserved identifiers:
 *
 * - Addresses and hostnames under `example.test`, `example.com`, `example.org`,
 *   `example.net`, and `.invalid` (RFC 2606 / RFC 6761).
 * - IP literals in RFC 5737 documentation ranges, plus loopback.
 *
 * and refuses anything shaped like a credential outright.
 *
 * No dependencies and no network: it must run in the same offline conditions
 * as the journeys it guards.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

/** Paths scanned. Directories are walked; files are scanned directly. */
export const SCAN_TARGETS = [
  "collab/e2e/fixtures/war-room",
  "collab/e2e/src/war-room",
  "collab/e2e/specs/19-war-room-intake.spec.ts",
  "collab/e2e/specs/20-war-room-collaboration.spec.ts",
  "collab/e2e/specs/21-war-room-lanes-and-deployment.spec.ts",
  "collab/e2e/specs/22-war-room-a11y-responsive.spec.ts",
  "collab/e2e/specs/26-log-workbench.spec.ts",
  "collab/e2e/fixtures/war-room/workbench",
  "collab/e2e/fixtures/triage-bridge-degraded-runner.mjs",
  "docs/WAR_ROOM_SCENARIO_MATRIX.md",
];

const RESERVED_DOMAINS = ["example.test", "example.com", "example.org", "example.net", "invalid"];

/** RFC 5737 documentation ranges, plus loopback and the unspecified address. */
function isDocumentationIp(literal) {
  const parts = literal.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // not a real dotted quad; the version-number rule below catches those
  }
  const [a, b, c] = parts;
  if (a === 127 || a === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

function isReservedHost(host) {
  const lower = host.toLowerCase().replace(/\.$/, "");
  return RESERVED_DOMAINS.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

const CREDENTIAL_RULES = [
  { rule: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "private_key_block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { rule: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/g },
  { rule: "provider_api_key", pattern: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { rule: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { rule: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { rule: "password_assignment", pattern: /\b(?:password|passwd|secret)\s*[=:]\s*["'][^"'\s]{8,}["']/gi },
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9.-]+)/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Lines a scan may skip: a fixture's own explanation of what it forbids. */
const ALLOW_MARK = "war-room-fixture-scan:allow";

export function scanText(text, relativePath) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARK)) return;
    const at = (rule, excerpt) =>
      findings.push({ file: relativePath, line: index + 1, rule, excerpt: excerpt.slice(0, 120) });

    for (const { rule, pattern } of CREDENTIAL_RULES) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) at(rule, match[0]);
    }
    EMAIL.lastIndex = 0;
    for (let match = EMAIL.exec(line); match; match = EMAIL.exec(line)) {
      if (!isReservedHost(match[1])) at("non_reserved_email_domain", match[0]);
    }
    URL_HOST.lastIndex = 0;
    for (let match = URL_HOST.exec(line); match; match = URL_HOST.exec(line)) {
      const host = match[1];
      if (isReservedHost(host)) continue;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isDocumentationIp(host)) continue;
      if (host === "localhost") continue;
      at("non_reserved_url_host", match[0]);
    }
    IPV4.lastIndex = 0;
    for (let match = IPV4.exec(line); match; match = IPV4.exec(line)) {
      // A dotted quad inside a version string is not an address.
      const before = line.slice(Math.max(0, match.index - 12), match.index);
      if (/\b(?:v|version|release|schema)\S*$/i.test(before)) continue;
      if (!isDocumentationIp(match[0])) at("non_documentation_ip", match[0]);
    }
  });
  return findings;
}

function walk(absolute, relative, out) {
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute).sort()) {
      walk(path.join(absolute, entry), path.posix.join(relative, entry), out);
    }
    return;
  }
  out.push({ absolute, relative });
}

export function collectFiles(root = repoRoot, targets = SCAN_TARGETS) {
  const files = [];
  for (const target of targets) {
    const absolute = path.join(root, target);
    if (!fs.existsSync(absolute)) {
      throw new Error(`war-room scan target is missing: ${target}`);
    }
    walk(absolute, target, files);
  }
  return files;
}

export function scanRepository(root = repoRoot, targets = SCAN_TARGETS) {
  const findings = [];
  for (const file of collectFiles(root, targets)) {
    const text = fs.readFileSync(file.absolute, "utf8");
    findings.push(...scanText(text, file.relative));
  }
  return findings;
}

function main() {
  let findings;
  try {
    findings = scanRepository();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (findings.length > 0) {
    process.stderr.write("War Room fixture privacy scan failed:\n");
    for (const finding of findings) {
      process.stderr.write(`  ${finding.file}:${finding.line} ${finding.rule} — ${finding.excerpt}\n`);
    }
    process.stderr.write(
      "\nFixtures must use RFC 2606 reserved domains and RFC 5737 documentation IPs, and must carry no credentials.\n",
    );
    process.exitCode = 1;
    return;
  }
  const count = collectFiles().length;
  process.stdout.write(`War Room fixture privacy scan clean (${count} files).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
