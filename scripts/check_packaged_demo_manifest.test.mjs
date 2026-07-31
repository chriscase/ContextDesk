import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseDemoManifest,
  parseRustStr,
  parseRustU64,
  validatePackagedDemoManifest,
} from "./check_packaged_demo_manifest.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const FIXTURE_ROOT =
  "fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import";

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hostSource(entries, { expectedSources = entries.length } = {}) {
  const literals = entries
    .map(
      (entry) => `    DemoLogResourceEntry {
        path: "${entry.path}",
        bytes: ${entry.bytes},
        sha256: "${entry.sha256}",
    },`,
    )
    .join("\n");
  return `const DEMO_LOG_RESOURCE_DIR: &str = "demo-log-corpus/seven-day-25k";
const DEMO_LOG_EXPECTED_EVENTS: u64 = 25_000;
const DEMO_LOG_EXPECTED_SOURCES: u64 = ${expectedSources};

const DEMO_LOG_RESOURCE_MANIFEST: &[DemoLogResourceEntry] = &[
${literals}
];
`;
}

/**
 * A miniature repository whose demo fixture and host manifest agree, so each
 * test can introduce exactly one defect.
 */
function withRepository(run, { files } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contextdesk-demo-"));
  try {
    const contents =
      files ??
      new Map([
        ["api/app.jsonl", "alpha\n"],
        ["worker/worker.log", "beta\n"],
      ]);
    const entries = [];
    for (const [relative, text] of contents) {
      const full = path.join(root, ...FIXTURE_ROOT.split("/"), ...relative.split("/"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
      entries.push({
        path: relative,
        bytes: Buffer.byteLength(text),
        sha256: digest(text),
      });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));

    const hostPath = path.join(root, "desktop", "src-tauri", "src", "lib.rs");
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, hostSource(entries));

    const confPath = path.join(root, "desktop", "src-tauri", "tauri.conf.json");
    fs.writeFileSync(
      confPath,
      JSON.stringify({
        bundle: {
          resources: {
            "../../docs/help": "help",
            [`../../${FIXTURE_ROOT}`]: "demo-log-corpus/seven-day-25k",
          },
        },
      }),
    );

    run({ root, entries, hostPath, confPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fixtureFile(root, relative) {
  return path.join(root, ...FIXTURE_ROOT.split("/"), ...relative.split("/"));
}

test("the checked-in host manifest matches the checked-in fixture exactly", () => {
  const result = validatePackagedDemoManifest(repoRoot);
  assert.equal(result.entries, 10);
  assert.equal(result.totalBytes, 4_201_281);
  assert.equal(result.expectedEvents, 25_000);
  assert.equal(result.resourceDir, "demo-log-corpus/seven-day-25k");
});

test("a healthy synthetic repository passes", () => {
  withRepository(({ root }) => {
    assert.doesNotThrow(() => validatePackagedDemoManifest(root));
  });
});

test("a one-byte mutation is rejected", () => {
  withRepository(({ root }) => {
    const target = fixtureFile(root, "api/app.jsonl");
    fs.writeFileSync(target, "alphA\n"); // same length, different bytes
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /digest .* does not match/,
    );
  });
});

test("truncation is rejected", () => {
  withRepository(({ root }) => {
    fs.writeFileSync(fixtureFile(root, "api/app.jsonl"), "alph");
    assert.throws(() => validatePackagedDemoManifest(root), /bytes, fixture is/);
  });
});

test("same-name replacement with different content is rejected", () => {
  withRepository(({ root }) => {
    // Exactly the attack a filename allowlist cannot catch (#739).
    fs.writeFileSync(
      fixtureFile(root, "worker/worker.log"),
      "entirely different content\n",
    );
    assert.throws(() => validatePackagedDemoManifest(root), /worker\/worker\.log/);
  });
});

test("an extra packaged file is rejected", () => {
  withRepository(({ root }) => {
    fs.writeFileSync(fixtureFile(root, "api/extra.jsonl"), "surprise\n");
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /fixture contains files absent from the manifest: api\/extra\.jsonl/,
    );
  });
});

test("a missing packaged file is rejected", () => {
  withRepository(({ root }) => {
    fs.rmSync(fixtureFile(root, "api/app.jsonl"));
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /manifest lists files absent from the fixture: api\/app\.jsonl/,
    );
  });
});

test("a symlinked fixture entry is rejected", () => {
  withRepository(({ root }) => {
    const link = fixtureFile(root, "api/link.jsonl");
    fs.symlinkSync(fixtureFile(root, "api/app.jsonl"), link);
    assert.throws(() => validatePackagedDemoManifest(root), /symlinks must not ship/);
  });
});

test("manifest length drifting from DEMO_LOG_EXPECTED_SOURCES is rejected", () => {
  withRepository(({ root, entries, hostPath }) => {
    fs.writeFileSync(hostPath, hostSource(entries, { expectedSources: 9 }));
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /entries but DEMO_LOG_EXPECTED_SOURCES is 9/,
    );
  });
});

test("dropping the packaging resource is rejected", () => {
  withRepository(({ root, confPath }) => {
    fs.writeFileSync(
      confPath,
      JSON.stringify({ bundle: { resources: { "../../docs/help": "help" } } }),
    );
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /expected exactly one fixtures\/log-lab resource, found 0/,
    );
  });
});

test("packaging evaluator truth or metrics is rejected", () => {
  for (const leak of ["truth", "metrics"]) {
    withRepository(({ root, confPath }) => {
      fs.writeFileSync(
        confPath,
        JSON.stringify({
          bundle: {
            resources: {
              [`../../${FIXTURE_ROOT}`]: "demo-log-corpus/seven-day-25k",
              [`../../fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/${leak}`]:
                `demo-log-corpus/${leak}`,
            },
          },
        }),
      );
      assert.throws(
        () => validatePackagedDemoManifest(root),
        new RegExp(`would package evaluator ${leak} data`),
      );
    });
  }
});

test("a packaging target that the host cannot resolve is rejected", () => {
  withRepository(({ root, confPath }) => {
    fs.writeFileSync(
      confPath,
      JSON.stringify({
        bundle: {
          resources: { [`../../${FIXTURE_ROOT}`]: "demo-log-corpus/renamed" },
        },
      }),
    );
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /targets 'demo-log-corpus\/renamed' but the host resolves/,
    );
  });
});

test("an unparseable host manifest fails closed instead of passing vacuously", () => {
  // One entry the regex cannot read must not silently shrink the list.
  withRepository(({ root, hostPath }) => {
    fs.writeFileSync(
      hostPath,
      fs
        .readFileSync(hostPath, "utf8")
        .replace(/sha256: "[0-9a-f]{64}"/, 'sha256: SOME_CONST'),
    );
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /entries but only \d+ parsed/,
    );
  });
  withRepository(({ root, hostPath }) => {
    fs.writeFileSync(hostPath, "// manifest deleted\n");
    assert.throws(
      () => validatePackagedDemoManifest(root),
      /DEMO_LOG_RESOURCE_MANIFEST is missing/,
    );
  });
});

test("rust constant parsers read the real host source", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "desktop", "src-tauri", "src", "lib.rs"),
    "utf8",
  );
  assert.equal(parseRustU64(source, "DEMO_LOG_EXPECTED_EVENTS"), 25_000);
  assert.equal(parseRustU64(source, "DEMO_LOG_EXPECTED_SOURCES"), 10);
  assert.equal(
    parseRustStr(source, "DEMO_LOG_RESOURCE_DIR"),
    "demo-log-corpus/seven-day-25k",
  );
  assert.equal(parseDemoManifest(source).length, 10);
});
