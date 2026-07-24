import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseHelpFrontmatter,
  validateHelpCorpus,
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
    ],
  });
  assert.equal(result.pages, 7);
  assert.equal(result.assets, 7);
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
