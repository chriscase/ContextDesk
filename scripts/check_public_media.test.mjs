import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDir, "check_public_media.mjs");
const { collectPublishedImageTargets } = await import(
  pathToFileURL(validator).href
);
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function run(root, manifest = "docs/media/public-assets.json") {
  return spawnSync(process.execPath, [validator, root, manifest], {
    encoding: "utf8",
  });
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function asset(pathname, gitBlob) {
  return {
    path: pathname,
    gitBlob,
    sourceSha: SOURCE_SHA,
    privacyReview: "publishable",
    modelInventoryVisible: false,
    fixture: "synthetic",
    theme: "dark",
    claim: "Synthetic product frame",
    altRequiredTerms: ["synthetic"],
    reviewedBy: "Test Agent",
  };
}

function writeManifest(root, assets) {
  fs.writeFileSync(
    path.join(root, "docs", "media", "public-assets.json"),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`,
  );
}

function withRepository(runTest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-media-"));
  try {
    git(root, ["init", "--quiet"]);
    fs.mkdirSync(path.join(root, "docs", "media", "gallery"), {
      recursive: true,
    });
    const pathname = "docs/media/gallery/frame.png";
    const absolute = path.join(root, ...pathname.split("/"));
    fs.writeFileSync(absolute, Buffer.from("synthetic-png-bytes"));
    const gitBlob = git(root, ["hash-object", "--", absolute]);
    fs.writeFileSync(
      path.join(root, "docs", "media", "README.md"),
      `# Public product media\n\nApp-source SHA \`${SOURCE_SHA}\`.\n`,
    );
    writeManifest(root, [asset(pathname, gitBlob)]);
    runTest({ root, pathname, absolute, gitBlob });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("valid manifest passes with concise output", () => {
  withRepository(({ root }) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "public media manifest valid: 1 assets, 0 published references, 1 recorded capture build(s)\n",
    );
    assert.equal(result.stderr, "");
  });
});

test("the checked-in public media ledger validates against the real repository", () => {
  const repoRoot = path.resolve(scriptDir, "..");
  const result = run(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^public media manifest valid: \d+ assets/);

  // Non-vacuous yield: cross-check the reported reference count against an
  // independent scan of the README, so an extractor that quietly matches
  // nothing cannot report success.
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const localRasters = collectPublishedImageTargets(readme, "README.md").filter(
    (entry) =>
      !/^(?:https?:)?\/\//i.test(entry.target) &&
      /\.(?:png|jpe?g|webp|gif)$/i.test(entry.target),
  );
  assert.equal(
    localRasters.length,
    4,
    "README local-raster publication count changed without updating the pinned privacy expectation",
  );
  assert.match(
    result.stdout,
    new RegExp(`${localRasters.length} published references`),
  );
});

test("a README raster outside the ledger fails closed", () => {
  withRepository(({ root, pathname }) => {
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n![CI](https://example.invalid/badge.svg)\n\n![Synthetic listed](${pathname})\n`,
    );
    const listed = run(root);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /1 published references/);

    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs", "images", "unreviewed.png"),
      "unreviewed",
    );
    fs.appendFileSync(
      path.join(root, "README.md"),
      "\n![Unreviewed](docs/images/unreviewed.png)\n",
    );
    const smuggled = run(root);
    assert.notEqual(smuggled.status, 0);
    assert.match(
      smuggled.stderr,
      /published raster 'docs\/images\/unreviewed\.png' \(inline\) is not in the public media ledger/,
    );
  });
});

test("modified image bytes fail exact Git blob identity", () => {
  withRepository(({ root, absolute }) => {
    fs.appendFileSync(absolute, "-modified");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git blob mismatch/);
  });
});

test("an unlisted raster image fails closed", () => {
  withRepository(({ root }) => {
    fs.writeFileSync(
      path.join(root, "docs", "media", "extra.webp"),
      "unlisted",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unlisted raster image.*extra\.webp/);
  });
});

test("unsafe privacy metadata fails closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    const unsafe = asset(pathname, gitBlob);
    unsafe.privacyReview = "pending";
    writeManifest(root, [unsafe]);
    const privacy = run(root);
    assert.notEqual(privacy.status, 0);
    assert.match(privacy.stderr, /privacyReview must be 'publishable'/);

    unsafe.privacyReview = "publishable";
    unsafe.modelInventoryVisible = true;
    writeManifest(root, [unsafe]);
    const inventory = run(root);
    assert.notEqual(inventory.status, 0);
    assert.match(inventory.stderr, /modelInventoryVisible must be false/);
  });
});

test("missing or malformed alt semantics fail closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    const missing = asset(pathname, gitBlob);
    delete missing.altRequiredTerms;
    writeManifest(root, [missing]);
    const absent = run(root);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /altRequiredTerms must be a non-empty array/);

    const malformed = asset(pathname, gitBlob);
    malformed.altRequiredTerms = ["synthetic", ""];
    writeManifest(root, [malformed]);
    const blank = run(root);
    assert.notEqual(blank.status, 0);
    assert.match(blank.stderr, /altRequiredTerms must be a non-empty array/);
  });
});

test("README alt semantics are enforced for every published image form", () => {
  withRepository(({ root, pathname }) => {
    const readme = path.join(root, "README.md");
    const cases = [
      `![Old description](${pathname})\n`,
      `![Old description][shot]\n\n[shot]: ${pathname}\n`,
      `<img src="${pathname}" alt="Old description">\n`,
      `<img src="${pathname}">\n`,
      `<img src="${pathname}" data-alt="Synthetic frame">\n`,
      `<img src="${pathname}" aria-alt="Synthetic frame">\n`,
      `<img src="${pathname}" data-note=" alt='Synthetic frame'">\n`,
      `<img src="${pathname}" data-\u00a0alt="Synthetic frame">\n`,
      `<img src="${pathname}" data-\u000balt="Synthetic frame">\n`,
      `<img src="${pathname}" data-\u2003alt="Synthetic frame">\n`,
      `![Old [frame](https://synthetic.invalid)](${pathname})\n`,
      `![Old <span title="synthetic">frame</span>](${pathname})\n`,
    ];

    for (const contents of cases) {
      fs.writeFileSync(readme, `# Fixture\n\n${contents}`);
      const result = run(root);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /alt text must include required term\(s\): synthetic/,
      );
    }

    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Synthetic frame](${pathname})\n`,
    );
    assert.equal(run(root).status, 0);

    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Old [synthetic frame](https://example.invalid)](${pathname})\n` +
        `![Old <span>synthetic frame</span>](${pathname})\n`,
    );
    const renderedAlt = run(root);
    assert.equal(renderedAlt.status, 0, renderedAlt.stderr);
    assert.match(renderedAlt.stdout, /2 published references/);

    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Synthetic \\] frame](<${pathname}>)\n\n` +
        `![Synthetic \\] reference][shot]\n\n[shot]: <${pathname}>\n`,
    );
    const escapedAndAngled = run(root);
    assert.equal(escapedAndAngled.status, 0, escapedAndAngled.stderr);
    assert.match(escapedAndAngled.stdout, /2 published references/);
  });
});

test("nested, balanced, suffixed, and entity-encoded raster targets fail closed", () => {
  withRepository(({ root, pathname }) => {
    const readme = path.join(root, "README.md");
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled(1).png"), "x");

    const cases = [
      `![Unreviewed [nested]](docs/images/smuggled.png)\n`,
      "![Unreviewed `code]` alt](docs/images/smuggled.png)\n",
      `![Unreviewed <span title="]"> alt](docs/images/smuggled.png)\n`,
      `![Unreviewed](docs/images/smuggled(1).png)\n`,
      `![Unreviewed](docs/images/smuggled\\(1\\).png)\n`,
      `![Unreviewed](<docs/images/smuggled.png>)\n`,
      `![Unreviewed](docs/images/smuggled.png "title with )")\n`,
      `![Unreviewed](docs/images/smuggled.png?raw=1)\n`,
      `![Unreviewed](docs/images/smuggled.png#preview)\n`,
      `<img src="docs/images/smuggled&#46;png" alt="Unreviewed">\n`,
      `<img src="docs/images/smuggled&#46png" alt="Unreviewed">\n`,
      `<img src=" docs/images/smuggled.png " alt="Unreviewed">\n`,
    ];

    for (const contents of cases) {
      fs.writeFileSync(readme, `# Fixture\n\n${contents}`);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /published raster '.*' \((?:inline|html)\) is not in the public media ledger/,
        contents,
      );
    }

    // Query/fragment syntax changes delivery, not the reviewed local bytes.
    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Synthetic listed](${pathname}?raw=1&label=a#preview)\n`,
    );
    const listedWithSuffix = run(root);
    assert.equal(listedWithSuffix.status, 0, listedWithSuffix.stderr);
    assert.match(listedWithSuffix.stdout, /1 published references/);
  });
});

test("non-ledgerable local and embedded images are rejected", () => {
  withRepository(({ root }) => {
    const readme = path.join(root, "README.md");
    const cases = [
      `![Embedded](data:image/png;base64,c3ludGhldGlj)\n`,
      `![Vector](docs/images/unreviewed.svg)\n`,
      `![Extensionless](docs/images/unreviewed)\n`,
      `![Encoded query](docs/images/unreviewed.png%3Fraw=1)\n`,
      `![Encoded fragment](docs/images/unreviewed.png%23preview)\n`,
      `![Encoded path separator](docs%2Fmedia%2Fgallery%2Fframe.png)\n`,
    ];
    for (const contents of cases) {
      fs.writeFileSync(readme, `# Fixture\n\n${contents}`);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /embedded data images are not privacy-ledgered|local SVG image .* is outside the raster privacy ledger|local image .* has no supported privacy-ledgered raster extension|encoded path separator or traversal segment/,
      );
    }
  });
});

test("multiline reference labels and continuation destinations fail closed", () => {
  withRepository(({ root }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    const cases = [
      `![Unreviewed][shot]\n\n[shot]:\n  docs/images/smuggled.png\n`,
      `![Unreviewed][shot]\n\n[shot]:\n     docs/images/smuggled.png\n`,
      `![Unreviewed][shot]\n\n[shot]:\n\t docs/images/smuggled.png\n`,
      "![Unreviewed][shot]\r\r[shot]:\r  docs/images/smuggled.png\r",
      `![Unreviewed][multi\n label]\n\n[multi\n label]: docs/images/smuggled.png\n`,
      `![Unreviewed\n multiline][shot]\n\n[shot]: docs/images/smuggled.png\n`,
    ];
    for (const contents of cases) {
      fs.writeFileSync(path.join(root, "README.md"), `# Fixture\n\n${contents}`);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /published raster 'docs\/images\/smuggled\.png' \(reference\) is not in the public media ledger/,
        contents,
      );
    }
  });
});

test("responsive HTML image candidates cannot bypass the ledger", () => {
  withRepository(({ root, pathname }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    const readme = path.join(root, "README.md");

    const cases = [
      `<img src="${pathname}" srcset="docs/images/smuggled.png 2x" alt="Synthetic">\n`,
      `<picture><source srcset="docs/images/smuggled.png 1x"><img src="${pathname}" alt="Synthetic"></picture>\n`,
    ];
    for (const contents of cases) {
      fs.writeFileSync(readme, `# Fixture\n\n${contents}`);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /published raster 'docs\/images\/smuggled\.png' \(html\) is not in the public media ledger/,
        contents,
      );
    }

    fs.writeFileSync(
      readme,
      `# Fixture\n\n<div>\n[shot]: docs/images/smuggled.png\n\n![Synthetic][shot]\n`,
    );
    const unclosedHtml = run(root);
    assert.notEqual(unclosedHtml.status, 0);
    assert.match(unclosedHtml.stderr, /unterminated raw HTML block/);

    fs.writeFileSync(
      readme,
      `# Fixture\n\n<picture><source srcset="${pathname} 2x"><img src="${pathname}" srcset="${pathname} 1x" alt="Synthetic"></picture>\n`,
    );
    const listed = run(root);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /3 published references/);

    fs.writeFileSync(
      readme,
      `# Fixture\n\n<picture><source srcset="${pathname} 2x"><img src="${pathname}" alt="Synthetic"><img src="${pathname}" alt="Synthetic"></picture>\n`,
    );
    const duplicateFallback = run(root);
    assert.notEqual(duplicateFallback.status, 0);
    assert.match(
      duplicateFallback.stderr,
      /<picture> must have exactly one quoted fallback <img>/,
    );
  });
});

test("the first duplicate reference definition controls the rendered image", () => {
  withRepository(({ root, pathname }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n![Synthetic][shot]\n\n` +
        `[shot]: docs/images/smuggled.png\n` +
        `[SHOT]: ${pathname}\n`,
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /published raster 'docs\/images\/smuggled\.png' \(reference\) is not in the public media ledger/,
    );
  });
});

test("reference definitions honor rendered block context and blockquote containers", () => {
  withRepository(({ root, pathname }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    const readme = path.join(root, "README.md");
    const cases = [
      `![Synthetic][shot]\n\n\`\`\`md\n[shot]: ${pathname}\n\`\`\`\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n> \`\`\`md\n> [shot]: ${pathname}\n> \`\`\`\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n- \`\`\`md\n  [shot]: ${pathname}\n  \`\`\`\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n100. ` +
        "```md\n     [shot]: " +
        pathname +
        "\n  [shot]: docs/images/smuggled.png\n",
      `![Synthetic][shot]\n\n<!--\n[shot]: ${pathname}\n-->\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n> [shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n> - outer\n>   - inner\n>\n>     [shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n> > - outer\n> >   - inner\n> >\n> >     [shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n<div>\n[shot]: ${pathname}\n</div>\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n> \`\`\`md\n> [shot]: ${pathname}\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n- \`\`\`md\n  [shot]: ${pathname}\n\n[shot]: docs/images/smuggled.png\n`,
      `![Synthetic][shot]\n\n${"> ".repeat(17)}[shot]: docs/images/smuggled.png\n\n[shot]: ${pathname}\n`,
    ];
    for (const contents of cases) {
      fs.writeFileSync(readme, `# Fixture\n\n${contents}`);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /published raster 'docs\/images\/smuggled\.png' \(reference\) is not in the public media ledger/,
        contents,
      );
    }

    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Synthetic][shot]\n\n[shot]: ${pathname}\n\n` +
        "```md\n[shot]: docs/images/smuggled.png\n```\n",
    );
    const inertLaterDefinition = run(root);
    assert.equal(inertLaterDefinition.status, 0, inertLaterDefinition.stderr);
    assert.match(inertLaterDefinition.stdout, /1 published references/);
  });
});

test("images inside fenced code and HTML comments are not published", () => {
  withRepository(({ root }) => {
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n\`\`\`md\n![Code](docs/images/unreviewed.png)\n- ![List code](docs/images/unreviewed.png)\n> <img src="docs/images/unreviewed.png" alt="Code">\n\`\`\`\n\n` +
      `> \`\`\`html\n> <img src="docs/images/unreviewed.png" alt="Code">\n> \`\`\`\n\n` +
        `<!-- ![Comment](docs/images/unreviewed.png) -->\n\n` +
        "`<img src=\"docs/images/unreviewed.png\" alt=\"Code\">`\n" +
        "`![Code](docs/images/unreviewed.png)`\n",
    );
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 published references/);
  });
});

test("escaped delimiters and Markdown containers cannot hide published images", () => {
  withRepository(({ root }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "unreviewed.png"), "x");
    const readme = path.join(root, "README.md");
    const cases = [
      "# Fixture\n\n\\`![Synthetic](docs/images/unreviewed.png)\\`\n",
      "# Fixture\n\n\\<!-- ![Synthetic](docs/images/unreviewed.png) -->\n",
      "# Fixture\r\r`code\r\r![Synthetic](docs/images/unreviewed.png)`\r",
      "# Fixture\r\r`code\r\r<img src=\"docs/images/unreviewed.png\" alt=\"Synthetic\">`\r",
      "# Fixture\n\n![Synthetic][shot]\n\n- outer\n  - inner\n\n    [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n> - item\n>\n>     [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n> \t[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n> >\t[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n> \t- item\n>\n>     [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n100. item\n\n     [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n-\t" +
        "```md\n    code\n  [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n100. <div>\n     code\n  [shot]: docs/images/unreviewed.png\n</div>\n",
      "# Fixture\n\n![Synthetic][shot]\n\n- outer\n  - inner\n    - third\n\n      [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n123456789. item\n\n           [shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n![Synthetic][shot]\n\n123456789. item\n\n\t\t   [shot]: docs/images/unreviewed.png\n",
    ];
    for (const contents of cases) {
      fs.writeFileSync(readme, contents);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /docs\/images\/unreviewed\.png|unsupported raw HTML declaration/,
      );
    }
  });
});

test("CommonMark HTML blocks keep definitions inert until their blank-line boundary", () => {
  withRepository(({ root, pathname }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "unreviewed.png"), "x");
    const readme = path.join(root, "README.md");
    const cases = [
      `# Fixture\n\n![Synthetic][shot]\n\n<div>\n</div>\n[shot]: ${pathname}\n\n[shot]: docs/images/unreviewed.png\n`,
      `# Fixture\n\n![Synthetic][shot]\n\n<x-test>\n[shot]: ${pathname}\n\n[shot]: docs/images/unreviewed.png\n`,
      "# Fixture\n\n<script>\nconst x = 1;\n</script>\n![Synthetic][shot]\n[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n<script></script>\n[shot]: docs/images/unreviewed.png\n\n![Synthetic][shot]\n",
      "# Fixture\n\n<style>\n.x { color: red; }\n</style>\n![Synthetic][shot]\n[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n<style></style>\n[shot]: docs/images/unreviewed.png\n\n![Synthetic][shot]\n",
      "# Fixture\n\n<pre>\ntext\n</pre>\n![Synthetic][shot]\n[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n<pre></pre>\n[shot]: docs/images/unreviewed.png\n\n![Synthetic][shot]\n",
      "# Fixture\n\n<textarea>\ntext\n</textarea>\n![Synthetic][shot]\n[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n<textarea></textarea>\n[shot]: docs/images/unreviewed.png\n\n![Synthetic][shot]\n",
      "# Fixture\n\n<?target\n[shot]: docs/media/gallery/frame.png\n?>\n\n[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n<!DOCTYPE html>\n[shot]: docs/media/gallery/frame.png\n>\n\n[shot]: docs/images/unreviewed.png\n",
      "# Fixture\n\n<![CDATA[\n[shot]: docs/media/gallery/frame.png\n]]>\n\n[shot]: docs/images/unreviewed.png\n",
    ];
    for (const contents of cases) {
      fs.writeFileSync(readme, contents);
      const result = run(root);
      assert.notEqual(result.status, 0, contents);
      assert.match(
        result.stderr,
        /docs\/images\/unreviewed\.png|unsupported raw HTML declaration/,
      );
    }
  });
});

test("CR-only blank lines do not hide the rendered reference definition", () => {
  withRepository(({ root }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "unreviewed.png"), "x");
    fs.writeFileSync(
      path.join(root, "README.md"),
      "# Fixture\r\r![Synthetic][shot]\r\r[shot\r\r]: docs/media/gallery/frame.png\r\r[shot]: docs/images/unreviewed.png\r",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /published raster 'docs\/images\/unreviewed\.png'/);
  });
});

test("ambiguous HTML character references in local targets fail closed", () => {
  withRepository(({ root }) => {
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n<img src="docs/images/smuggled&periodpng" alt="Synthetic">\n`,
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ambiguous HTML character reference/);
  });
});

test("ordinary ampersands in remote and local query strings remain valid", () => {
  withRepository(({ root, pathname }) => {
    const readme = path.join(root, "README.md");
    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Remote](https://example.invalid/badge.svg?a=1&b=2)\n` +
        `![Remote encoded](https://example.invalid/badge.svg?a=1&amp;b=2)\n` +
        `![Synthetic listed](${pathname}?label=a&b=c)\n`,
    );
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 published references/);
  });
});

test("malformed inline images still resolve their shortcut reference definition", () => {
  withRepository(({ root }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    fs.writeFileSync(
      path.join(root, "README.md"),
      "# Fixture\n\n![shot](docs/images/smuggled.png\n\n[shot]: docs/images/smuggled.png\n",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /published raster 'docs\/images\/smuggled\.png' \(reference\)/,
    );
  });
});

test("Markdown code spans cannot hide an image across a blank paragraph", () => {
  withRepository(({ root }) => {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");
    fs.writeFileSync(
      path.join(root, "README.md"),
      "# Fixture\n\n![Synthetic `code\n\n](docs/images/smuggled.png)`\n",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /published raster 'docs\/images\/smuggled\.png' \(inline\)/,
    );
  });
});

test("named character references and invalid numeric references are handled explicitly", () => {
  withRepository(({ root, pathname }) => {
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n<img src="${pathname}" alt="Synthetic &mdash; frame&nbsp;">\n`,
    );
    const named = run(root);
    assert.equal(named.status, 0, named.stderr);
    assert.match(named.stdout, /1 published references/);

    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Fixture\n\n<img src="${pathname}" alt="Synthetic &#x110000;">\n`,
    );
    const invalid = run(root);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid numeric character reference/);

    fs.writeFileSync(
      path.join(root, "README.md"),
      "# Fixture\n\n![Remote](https://example.invalid/badge.svg?x=&copy;)\n",
    );
    const remote = run(root);
    assert.equal(remote.status, 0, remote.stderr);
  });
});

test("duplicate and traversal paths fail closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    writeManifest(root, [
      asset(pathname, gitBlob),
      asset(pathname, gitBlob),
    ]);
    const duplicate = run(root);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate asset path/);

    writeManifest(root, [asset("docs/media/../outside.png", gitBlob)]);
    const traversal = run(root);
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /normalized and repo-relative/);
  });
});

test("a raster symlink escaping docs/media fails closed", () => {
  withRepository(({ root, pathname, absolute, gitBlob }) => {
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(absolute);
    fs.symlinkSync(outside, absolute);
    fs.writeFileSync(
      path.join(root, "docs", "media", "README.md"),
      `# Public product media\n\nApp-source SHA \`${SOURCE_SHA}\`.\n`,
    );
    writeManifest(root, [asset(pathname, gitBlob)]);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink escapes docs\/media/);
  });
});

test("malformed source SHA fails closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    const malformed = asset(pathname, gitBlob);
    malformed.sourceSha = "not-a-sha";
    writeManifest(root, [malformed]);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sourceSha.*40-hex/);
  });
});

test("a capture SHA missing from the provenance record fails closed", () => {
  withRepository(({ root, pathname, gitBlob }) => {
    // Exactly the drift that occurred on main: the ledger recorded a second
    // capture build while docs/media/README.md still claimed a single SHA.
    const second = asset(pathname.replace("frame.png", "second.png"), gitBlob);
    second.sourceSha = "fedcba9876543210fedcba9876543210fedcba98";
    const absolute = path.join(root, "docs", "media", "gallery", "second.png");
    fs.writeFileSync(absolute, Buffer.from("synthetic-png-bytes"));
    second.gitBlob = git(root, ["hash-object", "--", absolute]);
    writeManifest(root, [asset(pathname, gitBlob), second]);

    const drifted = run(root);
    assert.notEqual(drifted.status, 0);
    assert.match(
      drifted.stderr,
      /does not record capture provenance for source SHA fedcba98/,
    );

    fs.appendFileSync(
      path.join(root, "docs", "media", "README.md"),
      `\nAlso captured from \`${second.sourceSha}\`.\n`,
    );
    const recorded = run(root);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.match(recorded.stdout, /2 recorded capture build\(s\)/);
  });
});

test("reference-style and HTML images cannot bypass the ledger", () => {
  withRepository(({ root, pathname }) => {
    const readme = path.join(root, "README.md");
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "smuggled.png"), "x");

    fs.writeFileSync(readme, `# Fixture\n\n![Synthetic listed](${pathname})\n`);
    assert.match(run(root).stdout, /1 published references/);

    // 1. Full reference style.
    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Smuggled][shot]\n\n[shot]: docs/images/smuggled.png\n`,
    );
    const fullRef = run(root);
    assert.notEqual(fullRef.status, 0);
    assert.match(
      fullRef.stderr,
      /published raster 'docs\/images\/smuggled\.png' \(reference\)/,
    );

    // 2. Collapsed reference style.
    fs.writeFileSync(
      readme,
      `# Fixture\n\n![shot][]\n\n[shot]: docs/images/smuggled.png\n`,
    );
    assert.match(
      run(root).stderr,
      /\(reference\) is not in the public media ledger/,
    );

    // 3. Raw HTML img.
    fs.writeFileSync(
      readme,
      `# Fixture\n\n<img src="docs/images/smuggled.png" alt="Smuggled">\n`,
    );
    const html = run(root);
    assert.notEqual(html.status, 0);
    assert.match(
      html.stderr,
      /published raster 'docs\/images\/smuggled\.png' \(html\)/,
    );

    // 4. An <img> whose src is not a quoted literal is ambiguous, not ignored.
    fs.writeFileSync(readme, `# Fixture\n\n<img src={shot} alt="Dynamic">\n`);
    const dynamic = run(root);
    assert.notEqual(dynamic.status, 0);
    assert.match(dynamic.stderr, /without a quoted literal src cannot be checked/);

    // 5. Metadata attributes cannot impersonate the rendered src attribute.
    fs.writeFileSync(
      readme,
      `# Fixture\n\n<img data-src="${pathname}" alt="Synthetic frame">\n`,
    );
    const dataSrc = run(root);
    assert.notEqual(dataSrc.status, 0);
    assert.match(dataSrc.stderr, /without a quoted literal src cannot be checked/);

    fs.writeFileSync(
      readme,
      `# Fixture\n\n<img data-note=" src='${pathname}'" alt="Synthetic frame">\n`,
    );
    const embeddedSrc = run(root);
    assert.notEqual(embeddedSrc.status, 0);
    assert.match(embeddedSrc.stderr, /without a quoted literal src cannot be checked/);

    // 6. A reference image naming a raster with no definition is ambiguous.
    fs.writeFileSync(readme, `# Fixture\n\n![docs/images/smuggled.png]\n`);
    const dangling = run(root);
    assert.notEqual(dangling.status, 0);
    assert.match(dangling.stderr, /has no link definition/);

    // Ledger-listed assets still pass in every covered form.
    fs.writeFileSync(
      readme,
      `# Fixture\n\n![Synthetic inline](${pathname})\n\n![Synthetic ref][ok]\n\n` +
        `<img src="${pathname}" alt="Synthetic html">\n\n[ok]: ${pathname}\n`,
    );
    const allForms = run(root);
    assert.equal(allForms.status, 0, allForms.stderr);
    assert.match(allForms.stdout, /3 published references/);
  });
});

test("published image extraction covers every rendered form", () => {
  const found = collectPublishedImageTargets(
    `![a](docs/media/gallery/one.png)\n` +
      `![escaped \\] alt](<docs/media/gallery/angled.png>)\n` +
      `![b][two]\n` +
      `<img src="docs/media/gallery/three.png" alt="c">\n` +
      `![CI](https://example.invalid/badge.svg)\n\n` +
      `[two]: docs/media/gallery/two.png\n`,
  );
  assert.deepEqual(found.map((f) => f.form).sort(), [
    "html",
    "inline",
    "inline",
    "inline",
    "reference",
  ]);
  assert.ok(
    found.some((f) => f.target === "docs/media/gallery/two.png"),
    "reference definitions must resolve to their target",
  );
  assert.deepEqual(
    found
      .filter((f) => !/^https?:/i.test(f.target))
      .map((f) => [f.form, f.alt]),
    [
      ["inline", "a"],
      ["inline", "escaped ] alt"],
      ["reference", "b"],
      ["html", "c"],
    ],
  );
});
