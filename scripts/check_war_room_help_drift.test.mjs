import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateWarRoomHelpDrift } from "./check_war_room_help_drift.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "contextdesk-war-room-help-"));
  for (const path of [
    "docs/war-room",
    "docs/help",
    "docs/assets/war-room",
    "docs/media/gallery",
    "docs/media/public-assets.json",
    "docs/benchmarks",
    "collab/web/public/help/war-room",
    "collab/web/src/HelpCenter.tsx",
    "collab/web/src/TriageWorkspace.tsx",
    "collab/web/src/Cases.tsx",
    "collab/server/src/demo-static.ts",
  ]) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, path), destination, { recursive: true });
  }
  return root;
}

test("the checked-in War Room and Help media stay synchronized", () => {
  assert.deepEqual(validateWarRoomHelpDrift(repositoryRoot).errors, []);
});

test("a mislabeled PNG and duplicate canonical anchor fail closed", () => {
  const root = fixture();
  const image = join(root, "docs", "assets", "war-room", "war-room-investigations.png");
  writeFileSync(image, Buffer.from("not a png"));
  const workspace = join(root, "collab", "web", "src", "TriageWorkspace.tsx");
  writeFileSync(
    workspace,
    readFileSync(workspace, "utf8").replace('id="triage-log-time-capture"', 'id="triage-log-time"'),
  );
  const ledger = join(root, "docs", "war-room", "help-media.json");
  writeFileSync(
    ledger,
    readFileSync(ledger, "utf8").replace(
      "87f1f29f82d6b404369e55cdaeeadcd0fc441897",
      "1017ae9c800a22208fe53db337ea6bf81921afce",
    ),
  );
  const errors = validateWarRoomHelpDrift(root).errors.join("\n");
  assert.match(errors, /not PNG data/);
  assert.match(errors, /exactly one canonical triage-log-time id/);
  assert.match(errors, /Administration media must prove the current Entities and Attribution navigation/);
});

test("a stale Markdown description of public media fails closed", () => {
  const root = fixture();
  const guide = join(root, "docs", "war-room", "CLI_AND_GUI_TRIAGE.md");
  writeFileSync(
    guide,
    readFileSync(guide, "utf8").replace(
      "Synthetic human decision journal with recorded comparison context and a share-safe export boundary",
      "Synthetic portable archive download and dry-run controls with an exact-restore warning",
    ),
  );
  const errors = validateWarRoomHelpDrift(root).errors.join("\n");
  assert.match(errors, /alt for docs\/media\/gallery\/war-room-decide-export\.png must include 'decision'/);
  assert.match(errors, /alt for docs\/media\/gallery\/war-room-decide-export\.png must include 'share-safe'/);
});
