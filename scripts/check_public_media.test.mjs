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
  assert.ok(localRasters.length > 0, "README publishes no local rasters");
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
      `![Unreviewed](docs/images/smuggled(1).png)\n`,
      `![Unreviewed](docs/images/smuggled\\(1\\).png)\n`,
      `![Unreviewed](<docs/images/smuggled.png>)\n`,
      `![Unreviewed](docs/images/smuggled.png "title with )")\n`,
      `![Unreviewed](docs/images/smuggled.png?raw=1)\n`,
      `![Unreviewed](docs/images/smuggled.png#preview)\n`,
      `<img src="docs/images/smuggled&#46;png" alt="Unreviewed">\n`,
      `<img src="docs/images/smuggled&#46png" alt="Unreviewed">\n`,
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
      `# Fixture\n\n![Synthetic listed](${pathname}?raw=1#preview)\n`,
    );
    const listedWithSuffix = run(root);
    assert.equal(listedWithSuffix.status, 0, listedWithSuffix.stderr);
    assert.match(listedWithSuffix.stdout, /1 published references/);
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
      ["inline", "escaped \\] alt"],
      ["reference", "b"],
      ["html", "c"],
    ],
  );
});
