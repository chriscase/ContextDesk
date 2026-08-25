import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCAN_TARGETS, collectFiles, scanRepository, scanText } from "./check_war_room_fixtures.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function rules(findings) {
  return findings.map((finding) => finding.rule).sort();
}

test("the committed War Room corpus is clean", () => {
  assert.deepEqual(scanRepository(), []);
});

test("every declared scan target exists", () => {
  for (const target of SCAN_TARGETS) {
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `missing scan target ${target}`);
  }
  assert.ok(collectFiles().length >= SCAN_TARGETS.length);
});

test("reserved domains and documentation addresses are allowed", () => {
  const allowed = [
    "From: R. Okonkwo <r.okonkwo@example.test>",
    "peer=192.0.2.24 upstream timeout",
    "see https://docs.example.com/runbook",
    "relay 198.51.100.7 and 203.0.113.9",
    "bound to 127.0.0.1:8788",
    "release=syn-2026.03.14-a",
  ].join("\n");
  assert.deepEqual(scanText(allowed, "fixture.log"), []);
});

test("a real-looking mail domain is refused", () => {
  const findings = scanText("From: someone@acme-corp.io", "fixture.eml");
  assert.deepEqual(rules(findings), ["non_reserved_email_domain"]);
  assert.equal(findings[0].line, 1);
});

test("a routable address is refused", () => {
  assert.deepEqual(rules(scanText("peer=203.0.114.9", "fixture.log")), ["non_documentation_ip"]);
  assert.deepEqual(rules(scanText("peer=8.8.8.8", "fixture.log")), ["non_documentation_ip"]);
});

test("an external host in a URL is refused", () => {
  assert.deepEqual(
    rules(scanText("callback https://gateway.internal.acme/v1", "fixture.txt")),
    ["non_reserved_url_host"],
  );
});

test("credential shapes are refused", () => {
  const cases = [
    [["Rotate A", "KIA", "A".repeat(16), " now"].join(""), "aws_access_key"],
    [["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""), "private_key_block"],
    [["Authorization: Bea", "rer ", "a".repeat(24)].join(""), "bearer_token"],
    [["key s", "k-", "a".repeat(20)].join(""), "provider_api_key"],
    [["token g", "hp_", "a".repeat(24)].join(""), "github_token"],
    [["token xo", "xb-", "1".repeat(10), "-", "a".repeat(10)].join(""), "slack_token"],
    [["pass", 'word = "', "a".repeat(12), '"'].join(""), "password_assignment"],
  ];
  for (const [line, rule] of cases) {
    assert.ok(rules(scanText(line, "fixture.txt")).includes(rule), `${rule} not detected in: ${line}`);
  }
});

test("a JWT-shaped token is refused", () => {
  const jwt = [
    `eyJ${"a".repeat(12)}`,
    "b".repeat(14),
    "c".repeat(16),
  ].join(".");
  assert.ok(rules(scanText(`auth: ${jwt}`, "fixture.txt")).includes("jwt"));
});

test("an explicit allow mark exempts a line that documents the rule", () => {
  assert.deepEqual(
    scanText("counterexample: someone@acme-corp.io // war-room-fixture-scan:allow", "doc.md"),
    [],
  );
});

test("a missing scan target fails closed", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "war-room-scan-"));
  assert.throws(() => collectFiles(empty, ["collab/e2e/fixtures/war-room"]), /scan target is missing/);
});

test("a planted violation in the real corpus is caught", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "war-room-scan-"));
  const dir = path.join(scratch, "collab", "e2e", "fixtures", "war-room");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "leak.log"), "contact ops@realcompany.example-not-reserved.io\n");
  const findings = scanRepository(scratch, ["collab/e2e/fixtures/war-room"]);
  assert.deepEqual(rules(findings), ["non_reserved_email_domain"]);
  assert.equal(findings[0].file, "collab/e2e/fixtures/war-room/leak.log");
});
