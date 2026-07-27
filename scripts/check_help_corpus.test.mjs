import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseHelpFrontmatter,
  validateHelpCorpus,
  validateSvgGeometry,
} from "./check_help_corpus.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function validPage({ id = "fixture-page", asset = "../assets/fixture.svg" } = {}) {
  return `---
id: ${id}
title: Fixture page
summary: A deterministic validator fixture.
section: overview
tags:
  - process
order: 10
related: []
---
# Fixture page

## Flow

![Fixture flow](${asset})

| Step | Result |
| --- | --- |
| One | Validated |
`;
}

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-help-"));
  try {
    fs.mkdirSync(path.join(root, "overview"));
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(
      path.join(root, "assets", "fixture.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Fixture</title><path d="M0 0h10v10z"/></svg>`,
    );
    fs.writeFileSync(path.join(root, "overview", "fixture.md"), validPage());
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("checked-in help corpus has valid frontmatter and asset links", () => {
  const result = validateHelpCorpus(path.join(repoRoot, "docs", "help"), {
    requiredIds: [
      "product-overview",
      "first-run",
      "chat-citations-context",
      "permission-tiers",
      "log-analysis-pipeline",
      "memory-overview",
      "skills-context-packs",
      "workspace-indexing",
      "provider-setup",
      "connectors-and-confluence",
      "s3-backup",
      "security-boundaries",
      "common-problems",
      "glossary",
    ],
  });
  assert.ok(result.pages >= 14);
  assert.ok(result.assets >= 12);
});

test("frontmatter parser rejects unknown fields", () => {
  assert.throws(
    () =>
      parseHelpFrontmatter(
        `---
id: page
title: Page
summary: Summary
section: overview
tags:
  - overview
order: 1
related: []
typo_field: surprise
---
# Page
`,
        "fixture.md",
      ),
    /unknown frontmatter field 'typo_field'/,
  );
});

test("validator rejects a broken relative SVG link", () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, "overview", "fixture.md"),
      validPage({ asset: "../assets/missing.svg" }),
    );
    assert.throws(() => validateHelpCorpus(root), /missing asset/);
  });
});

test("validator rejects traversal-shaped asset paths", () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, "overview", "fixture.md"),
      validPage({ asset: "../../../outside.svg" }),
    );
    assert.throws(() => validateHelpCorpus(root), /path escapes help root/);
  });
});

test("SVG geometry validator accepts separated padded labels", () => {
  assert.doesNotThrow(() =>
    validateSvgGeometry(
      `<svg viewBox="0 0 200 100">
        <title>Valid</title>
        <rect x="10" y="10" width="80" height="40"/>
        <text x="50" y="35" text-anchor="middle" font-size="12">Safe label</text>
        <text x="150" y="80" text-anchor="middle" font-size="12">Footer</text>
      </svg>`,
      "valid.svg",
    ),
  );
});

test("SVG geometry validator rejects text collisions", () => {
  assert.throws(
    () =>
      validateSvgGeometry(
        `<svg viewBox="0 0 200 100">
          <title>Collision</title>
          <text x="100" y="50" text-anchor="middle" font-size="16">First label</text>
          <text x="100" y="50" text-anchor="middle" font-size="16">Second label</text>
        </svg>`,
        "collision.svg",
      ),
    /text collision/,
  );
});

test("SVG geometry validator rejects clipping and box-border overlap", () => {
  assert.throws(
    () =>
      validateSvgGeometry(
        `<svg viewBox="0 0 100 100">
          <title>Clipped</title>
          <text x="99" y="50" font-size="16">outside</text>
        </svg>`,
        "clipped.svg",
      ),
    /clipped text/,
  );
  assert.throws(
    () =>
      validateSvgGeometry(
        `<svg viewBox="0 0 100 100">
          <title>Border</title>
          <rect x="10" y="10" width="80" height="40"/>
          <text x="11" y="35" font-size="14">touch</text>
        </svg>`,
        "border.svg",
      ),
    /box border/,
  );
});
