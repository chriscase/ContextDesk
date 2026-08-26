import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectExternalAssetReferences,
  helpPageAnchors,
  parseHelpFrontmatter,
  validateHelpCorpus,
  validateHelpPackaging,
  validateSourceHelpReferences,
  validateSvgGeometry,
  validateSvgPresentation,
  validateSvgTextLegibility,
} from "./check_help_corpus.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">Fixture</title><path d="M0 0h10v10z" fill="#38bdf8"/></svg>`;

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
    fs.writeFileSync(path.join(root, "assets", "fixture.svg"), FIXTURE_SVG);
    fs.writeFileSync(path.join(root, "overview", "fixture.md"), validPage());
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function pageWithLocator(locator) {
  return `---
id: fixture-page
title: Fixture page
summary: A deterministic validator fixture.
section: overview
tags:
  - overview
order: 10
related: []
---
# Fixture page

## Flow

![Fixture flow](../assets/fixture.svg)

See [more](${locator}).
`;
}

test("checked-in help corpus has valid frontmatter and asset links", () => {
  const result = validateHelpCorpus(path.join(repoRoot, "docs", "help"), {
    externalAssetReferences: collectExternalAssetReferences(repoRoot),
    requiredIds: [
      "product-overview",
      "first-run",
      "chat-citations-context",
      "context-selection-model-boundary",
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
  assert.ok(result.pages >= 15);
  assert.ok(result.assets >= 15);
  // Every checked-in asset is validated, not only the linked ones (#540).
  assert.ok(result.assetsValidated >= result.assets);
});

test("shipped UI help locators and settings routes resolve in the corpus", () => {
  const corpus = validateHelpCorpus(path.join(repoRoot, "docs", "help"), {
    externalAssetReferences: collectExternalAssetReferences(repoRoot),
  });
  const references = validateSourceHelpReferences(repoRoot, corpus);

  // Non-vacuous yield: cross-check the validator's count against an independent
  // inventory of the governed content module, so a scan that silently stops
  // matching cannot report success. A ">= N" floor let locators disappear one
  // at a time.
  const contentModule = fs.readFileSync(
    path.join(repoRoot, "desktop", "src", "lib", "helpContent.ts"),
    "utf8",
  );
  const declared = (contentModule.match(/^\s*helpLocator:\s*"/gm) ?? []).length;
  assert.ok(declared > 0, "governed help content module declares no locators");
  assert.equal(
    references.declarations,
    declared,
    "validator must discover exactly the declared helpLocator call sites",
  );
  assert.equal(
    references.locators,
    declared,
    "every declaration must be validated, not only the well-formed ones",
  );
  assert.ok(references.routes >= 7);
  assert.deepEqual(validateHelpPackaging(repoRoot), { resource: "help" });
});

test("helpLocator declarations are discovered before they are validated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-loc-"));
  try {
    const libDir = path.join(root, "desktop", "src", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const corpus = {
      ids: ["fixture-page"],
      anchors: new Map([["fixture-page", new Set(["flow"])]]),
    };
    const contentPath = path.join(libDir, "helpContent.ts");
    const write = (body) => fs.writeFileSync(contentPath, body);
    const check = () => validateSourceHelpReferences(root, corpus);

    write(`export const tip = { helpLocator: "help://fixture-page#flow" };\n`);
    const ok = check();
    assert.equal(ok.declarations, 1);
    assert.equal(ok.locators, 1);

    // 1. Deleted entirely — the previous scan reported success with nothing to find.
    write(`export const tip = { title: "No locator" };\n`);
    assert.throws(check, /found no helpLocator declarations/);

    // 2. Malformed scheme — invisible to a help:// string scan.
    write(`export const tip = { helpLocator: "htp://fixture-page#flow" };\n`);
    assert.throws(check, /is not a canonical help:\/\/ locator/);

    // 3. Missing page.
    write(`export const tip = { helpLocator: "help://deleted-page#flow" };\n`);
    assert.throws(check, /unknown help link/);

    // 4. Missing anchor.
    write(`export const tip = { helpLocator: "help://fixture-page#gone" };\n`);
    assert.throws(check, /points at a heading that does not exist/);

    // 5. Dynamic values cannot be checked, so they must not pass.
    write(
      `const page = "fixture-page";\nexport const tip = { helpLocator: \`help://\${page}\` };\n`,
    );
    assert.throws(check, /must be a literal canonical string/);
    write(`export const tip = { helpLocator: locatorFor(page) };\n`);
    assert.throws(check, /must be a literal canonical string/);

    // 6. Empty literal.
    write(`export const tip = { helpLocator: "" };\n`);
    assert.throws(check, /must not be empty/);

    // A type member declares the field; it is not a call site.
    write(
      `export type Content = { helpLocator?: string };\n` +
        `export const tip = { helpLocator: "help://fixture-page" };\n`,
    );
    const typed = check();
    assert.equal(typed.declarations, 1);
    assert.equal(typed.typeMembers, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("page anchors mirror the cd-core heading anchor rules", () => {
  assert.deepEqual(
    helpPageAnchors("# Title\n\n## Find vs Filter\n\n### Counts\n\n## Counts\n"),
    ["find-vs-filter", "counts", "counts-2"],
  );
});

test("a help link to a missing heading fails closed", () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, "overview", "fixture.md"),
      pageWithLocator("help://fixture-page#no-such-heading"),
    );
    assert.throws(
      () => validateHelpCorpus(root),
      /points at a heading that does not exist/,
    );
  });
});

test("an existing heading anchor is accepted", () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, "overview", "fixture.md"),
      pageWithLocator("help://fixture-page#flow"),
    );
    assert.doesNotThrow(() => validateHelpCorpus(root));
  });
});

test("an unreferenced bundled asset fails closed", () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, "assets", "orphan.svg"), FIXTURE_SVG);
    assert.throws(() => validateHelpCorpus(root), /unreferenced help asset/);
    // A documentation chapter outside docs/help may legitimately own it.
    assert.doesNotThrow(() =>
      validateHelpCorpus(root, {
        externalAssetReferences: new Set(["orphan.svg"]),
      }),
    );
  });
});

test("an unreferenced asset is still validated for safety", () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, "assets", "orphan.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">Orphan</title><script>alert(1)</script></svg>`,
    );
    assert.throws(
      () =>
        validateHelpCorpus(root, {
          externalAssetReferences: new Set(["orphan.svg"]),
        }),
      /forbidden element/,
    );
  });
});

test("theme-unsafe and inaccessible SVGs fail closed", () => {
  assert.throws(
    () =>
      validateSvgPresentation(
        `<svg viewBox="0 0 10 10" aria-labelledby="t"><title id="t">No role</title><path fill="#fff"/></svg>`,
        "no-role.svg",
      ),
    /role="img"/,
  );
  assert.throws(
    () =>
      validateSvgPresentation(
        `<svg viewBox="0 0 10 10" role="img"><title id="t">No label</title><path fill="#fff"/></svg>`,
        "no-label.svg",
      ),
    /aria-labelledby/,
  );
  assert.throws(
    () =>
      validateSvgPresentation(
        `<svg viewBox="0 0 10 10" role="img" aria-labelledby="missing"><title id="t">Dangling</title><path fill="#fff"/></svg>`,
        "dangling.svg",
      ),
    /missing id 'missing'/,
  );
  assert.throws(
    () =>
      validateSvgPresentation(
        `<svg viewBox="0 0 10 10" role="img" aria-labelledby="t"><title id="t">Theme</title><path fill="currentColor"/></svg>`,
        "theme.svg",
      ),
    /currentColor/,
  );
  assert.throws(
    () =>
      validateSvgPresentation(
        `<svg viewBox="0 0 10 10" role="img" aria-labelledby="t"><title id="t">Named</title><path fill="black"/></svg>`,
        "named.svg",
      ),
    /explicit hex colors/,
  );
  assert.doesNotThrow(() =>
    validateSvgPresentation(FIXTURE_SVG, "fixture.svg"),
  );
});

test("a dropped Help bundle resource fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-pkg-"));
  try {
    const configDir = path.join(root, "desktop", "src-tauri");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "tauri.conf.json");
    fs.writeFileSync(configPath, JSON.stringify({ bundle: { resources: {} } }));
    assert.throws(() => validateHelpPackaging(root), /bundle\.resources/);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ bundle: { resources: { "../../docs/help": "help" } } }),
    );
    assert.doesNotThrow(() => validateHelpPackaging(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a UI locator pointing at a missing page or heading fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-src-"));
  try {
    const libDir = path.join(root, "desktop", "src", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const corpus = {
      ids: ["fixture-page"],
      anchors: new Map([["fixture-page", new Set(["flow"])]]),
    };
    const contentPath = path.join(libDir, "helpContent.ts");

    fs.writeFileSync(
      contentPath,
      `export const tip = { helpLocator: "help://fixture-page#flow" };\n`,
    );
    assert.equal(
      validateSourceHelpReferences(root, corpus).locators,
      1,
      "a resolvable locator is accepted and counted",
    );

    fs.writeFileSync(
      contentPath,
      `export const tip = { helpLocator: "help://fixture-page#renamed-heading" };\n`,
    );
    assert.throws(
      () => validateSourceHelpReferences(root, corpus),
      /points at a heading that does not exist/,
    );

    fs.writeFileSync(
      contentPath,
      `export const tip = { helpLocator: "help://deleted-page" };\n`,
    );
    assert.throws(
      () => validateSourceHelpReferences(root, corpus),
      /unknown help link/,
    );

    // Test files are excluded so parser fixtures cannot break the gate — but
    // the governed module must still carry a real declaration, since an empty
    // inventory is itself a failure now.
    fs.writeFileSync(
      contentPath,
      `export const tip = { helpLocator: "help://fixture-page#flow" };\n`,
    );
    fs.writeFileSync(
      path.join(libDir, "help.test.ts"),
      `expect(parse("help://not-a-real-page?query"));\n` +
        `const bogus = { helpLocator: someRuntimeValue };\n`,
    );
    assert.doesNotThrow(() => validateSourceHelpReferences(root, corpus));

    // The Settings router must not point at a page that no longer exists.
    fs.writeFileSync(
      path.join(libDir, "help.ts"),
      `export function helpPageForSettingsSection(section: string): string {\n` +
        `  if (section === "ai") {\n    return "removed-page";\n  }\n` +
        `  return "fixture-page";\n}\n`,
    );
    assert.throws(
      () => validateSourceHelpReferences(root, corpus),
      /routes to unknown help page 'removed-page'/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("a relative Markdown link in a Help page fails closed", () => {
  withFixture((root) => {
    // HelpMarkdown only tokenizes help:// targets; anything else reached the
    // reader as literal "[text](page.md)" source (#540).
    fs.writeFileSync(
      path.join(root, "overview", "fixture.md"),
      pageWithLocator("other-page.md"),
    );
    assert.throws(
      () => validateHelpCorpus(root),
      /is not a help:\/\/ locator/,
    );
  });
});

test("external and mail links stay allowed", () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, "overview", "fixture.md"),
      pageWithLocator("https://example.invalid/docs"),
    );
    assert.doesNotThrow(() => validateHelpCorpus(root));
  });
});

test("diagram text on the bare canvas fails closed", () => {
  // The exact shipped defect: a light label above every filled shape renders
  // against the near-white Help figure surface in the Light and Sand themes.
  assert.throws(
    () =>
      validateSvgTextLegibility(
        `<svg viewBox="0 0 200 100">
           <text x="100" y="20" fill="#e5e7eb" font-size="14">Stranded title</text>
           <rect x="10" y="40" width="180" height="50" fill="#111827"/>
         </svg>`,
        "stranded.svg",
      ),
    /sits on the bare canvas/,
  );
});

test("diagram text below AA against its own backdrop fails closed", () => {
  assert.throws(
    () =>
      validateSvgTextLegibility(
        `<svg viewBox="0 0 200 100">
           <rect x="10" y="10" width="180" height="80" fill="#064e3b"/>
           <text x="100" y="50" fill="#9ca3af" font-size="13">Low contrast</text>
         </svg>`,
        "low.svg",
      ),
    /is 3\.83:1 against #064e3b/,
  );
});

test("diagram text on an opaque backdrop above AA passes", () => {
  assert.doesNotThrow(() =>
    validateSvgTextLegibility(
      `<svg viewBox="0 0 200 100">
         <rect width="200" height="100" fill="#0f172a"/>
         <rect x="10" y="10" width="180" height="80" fill="#111827"/>
         <text x="100" y="50" fill="#e5e7eb" font-size="13">Readable</text>
       </svg>`,
      "ok.svg",
    ),
  );
});

test("the smallest covering shape is the one text is measured against", () => {
  // A dark full-bleed canvas must not mask a label placed on a light panel.
  assert.throws(
    () =>
      validateSvgTextLegibility(
        `<svg viewBox="0 0 200 100">
           <rect width="200" height="100" fill="#0f172a"/>
           <rect x="10" y="10" width="180" height="80" fill="#f8fafc"/>
           <text x="100" y="50" fill="#e5e7eb" font-size="13">Washed out</text>
         </svg>`,
        "masked.svg",
      ),
    /against #f8fafc/,
  );
});

test("every checked-in Help diagram keeps its labels legible in every theme", () => {
  const assetsRoot = path.join(repoRoot, "docs", "help", "assets");
  const assets = fs
    .readdirSync(assetsRoot)
    .filter((name) => name.toLowerCase().endsWith(".svg"));
  assert.ok(assets.length >= 18);
  for (const name of assets) {
    assert.doesNotThrow(
      () =>
        validateSvgTextLegibility(
          fs.readFileSync(path.join(assetsRoot, name), "utf8"),
          name,
        ),
      `${name} has unreadable labels`,
    );
  }
});

test("the war-room stage diagram tells the Capture → Decide story in reading order", () => {
  // The shipped stage graphic is the one picture many operators meet first.
  // Beyond the generic safety/geometry/legibility gates, pin its story: the
  // four stages read left to right, Situation is stated before them, work can
  // flow backward, and the review rail stays visible — so a future redraw
  // cannot quietly drop the parts the workflow docs describe.
  const source = path.join(
    repoRoot,
    "docs",
    "help",
    "assets",
    "war-room-stage-flow.svg",
  );
  const svg = fs.readFileSync(source, "utf8");
  assert.doesNotThrow(() => validateSvgPresentation(svg, "war-room-stage-flow.svg"));
  assert.doesNotThrow(() => validateSvgGeometry(svg, "war-room-stage-flow.svg"));
  assert.doesNotThrow(() => validateSvgTextLegibility(svg, "war-room-stage-flow.svg"));

  const labels = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gi)].map((match) => {
    const x = Number(/\bx\s*=\s*["']([^"']+)["']/.exec(match[1])?.[1]);
    const y = Number(/\by\s*=\s*["']([^"']+)["']/.exec(match[1])?.[1]);
    return { x, y, text: match[2].trim() };
  });
  const stageNames = labels
    .filter((label) => ["CAPTURE", "ANALYZE", "COMPARE", "DECIDE"].includes(label.text))
    .sort((a, b) => a.x - b.x)
    .map((label) => label.text);
  assert.deepEqual(stageNames, ["CAPTURE", "ANALYZE", "COMPARE", "DECIDE"]);

  const situation = labels.find((label) => /SITUATION/i.test(label.text));
  assert.ok(situation, "the diagram names Situation");
  const firstStage = labels.find((label) => label.text === "CAPTURE");
  assert.ok(
    situation.y < firstStage.y,
    "Situation is stated before the four working stages",
  );

  assert.ok(
    labels.some((label) => /backward/i.test(label.text)),
    "the backward path is named, not implied",
  );
  assert.ok(
    labels.some((label) => /review rail/i.test(label.text)),
    "the review rail stays visible",
  );
  assert.match(svg, /marker-end/i, "stage progression is drawn with arrows");

  // Both war-room workflow docs keep embedding this exact asset.
  for (const page of ["war-room-workflow.md", "war-room-evidence-review.md"]) {
    const doc = fs.readFileSync(
      path.join(repoRoot, "docs", "help", "war-room", page),
      "utf8",
    );
    assert.match(doc, /\.\.\/assets\/war-room-stage-flow\.svg/, `${page} embeds the diagram`);
  }
});
