import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseStableHandbookWording } from "./check_design_handbook.mjs";

test("rejects issue-merge wording that expires immediately after promotion", () => {
  assert.throws(
    () =>
      assertReleaseStableHandbookWording(
        "docs/design/example.md",
        "Local integration until issue #720 is merged.",
      ),
    /temporary promotion wording/,
  );
});

test("rejects acceptance-branch wording from permanent handbook prose", () => {
  assert.throws(
    () =>
      assertReleaseStableHandbookWording(
        "docs/design/example.md",
        "This is available on the current acceptance branch.",
      ),
    /temporary promotion wording/,
  );
});

test("allows the durable status definition for feature-branch evidence", () => {
  assert.doesNotThrow(() =>
    assertReleaseStableHandbookWording(
      "docs/design/example.md",
      "Local integration means evidence exists on an unmerged feature branch.",
    ),
  );
});
