/**
 * Structural contract: harness selector strings exist in shipped product sources.
 * Prevents drift like "Use OS default" vs "Use default folder".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SEL, WIZARD_ADVANCE_LABELS } from "../harness/selectors.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopSrc = join(here, "..", "..", "src");

function read(rel) {
  const p = join(desktopSrc, rel);
  assert.ok(existsSync(p), `missing product file ${rel}`);
  return readFileSync(p, "utf8");
}

describe("selector contract vs production UI", () => {
  it("wizard CTAs match PreLaunchScreen button labels", () => {
    const src = read("components/launch/PreLaunchScreen.tsx");
    for (const label of WIZARD_ADVANCE_LABELS) {
      assert.ok(
        src.includes(label),
        `PreLaunchScreen must contain wizard label: ${JSON.stringify(label)}`,
      );
    }
    // Explicitly reject known-wrong historical labels
    assert.ok(!src.includes("Use OS default"), "stale label Use OS default must not be in product");
    assert.ok(
      src.includes(SEL.useDefaultFolder),
      "Use default folder",
    );
    assert.ok(src.includes(SEL.continueToAi));
    assert.ok(src.includes(SEL.continueToReady));
    assert.ok(src.includes(SEL.demoCheckboxName));
    assert.ok(src.includes(SEL.installDemo));
    assert.ok(src.includes(SEL.demoProgress));
    assert.ok(src.includes(SEL.retryInstall));
    assert.ok(src.includes(SEL.enterAppLogs) || src.includes("Enter app · Open Logs"));
  });

  it("Logs library Open Explorer label includes ellipsis", () => {
    // Product uses "Open Explorer…" (unicode ellipsis)
    assert.ok(
      SEL.openExplorer.includes("…") || SEL.openExplorer.includes("..."),
      "SEL.openExplorer must include ellipsis matching product button",
    );
    const pane = join(desktopSrc, "components/panes/LogPane.tsx");
    assert.ok(existsSync(pane), "LogPane.tsx present");
    const src = readFileSync(pane, "utf8");
    assert.ok(
      src.includes("Open Explorer…") || src.includes('Open Explorer...'),
      "LogPane must render Open Explorer…",
    );
  });

  it("demo checkbox is sibling of label (not nested input)", () => {
    const src = read("components/launch/PreLaunchScreen.tsx");
    // Slice around the demo opt-in only (avoid other checkboxes if any)
    const demoIdx = src.indexOf("Install demo log corpus");
    assert.ok(demoIdx > 0, "demo label present");
    const window = src.slice(Math.max(0, demoIdx - 800), demoIdx + 200);
    // input with type=checkbox then label htmlFor — not <label><input>
    assert.match(
      window,
      /type=["']checkbox["'][\s\S]{0,600}<label\s+htmlFor=/,
      "expected checkbox sibling then label htmlFor near demo title",
    );
    assert.ok(
      !/<label[^>]*>\s*<input[^>]*type=["']checkbox["']/.test(window),
      "demo checkbox must not be nested inside label",
    );
  });

  it("noise review exposes conservative ERROR copy and evidence fields", () => {
    const src = read("components/logExplorer/NoiseCandidateReview.tsx");
    assert.ok(
      src.includes("ERROR/WARN-heavy") || src.includes(SEL.noiseConservativeErrorCopy),
      "conservative ERROR product copy",
    );
    assert.ok(
      src.includes("Nothing is preselected") || src.includes(SEL.noiseNoPreselectCopy),
      "no-preselect product copy",
    );
    assert.ok(
      src.includes("Redacted representatives") ||
        src.includes(SEL.redactedRepresentatives),
      "evidence representatives",
    );
    assert.ok(src.includes("reasonCodes") || src.includes("reason"), "reason evidence");
    assert.ok(!/Accept all/.test(src), "Accept all must not appear in NoiseCandidateReview");
  });

  it("ChatContextMenu labels + clamp export match #837 product surface", () => {
    const src = read("components/shell/ChatContextMenu.tsx");
    assert.ok(
      src.includes("clampChatContextMenuPosition"),
      "viewport clamp helper must exist",
    );
    assert.ok(src.includes("VIEWPORT_GUTTER") || src.includes("gutter") || src.includes("8"));
    assert.ok(src.includes('role="menu"') || src.includes("role: \"menu\""));
    assert.ok(src.includes("chat-ctx-menu"), "menu class for release-host assert");
    for (const label of [
      SEL.chatMenuOpen,
      SEL.chatMenuRename,
      SEL.chatMenuPin,
      SEL.chatMenuArchive,
      SEL.chatMenuTrash,
    ]) {
      assert.ok(
        src.includes(label),
        `ChatContextMenu must contain menuitem label: ${JSON.stringify(label)}`,
      );
    }
    assert.ok(src.includes(SEL.chatMenuUnpin) || src.includes("Unpin from sidebar"));
  });

  it("SessionSidebar exposes New chat + session-list context menu hook", () => {
    const src = read("components/shell/SessionSidebar.tsx");
    assert.ok(src.includes(SEL.newChat) || src.includes("New chat"));
    assert.ok(src.includes("session-list__item"), "session list item class");
    assert.ok(src.includes("onContextMenu"), "right-click opens context menu");
    assert.ok(
      src.includes(SEL.chatNavAria) || src.includes("Chat navigation"),
      "nav aria-label",
    );
  });

  it("App wires ChatContextMenu from openChatCtxMenu client coordinates", () => {
    const src = read("App.tsx");
    assert.ok(src.includes("ChatContextMenu"));
    assert.ok(src.includes("openChatCtxMenu") || src.includes("setChatCtxMenu"));
    assert.ok(src.includes("clientX") && src.includes("clientY"));
  });

  it("checks trusted host corpus identity after cancel and before retry", () => {
    const helpers = readFileSync(join(here, "..", "specs", "helpers.mjs"), "utf8");
    assert.match(helpers, /invoke\("list_log_corpora"\)/);
    const afterCancel = helpers.indexOf("const corporaAfterCancel");
    const retry = helpers.indexOf("const retryBtn", afterCancel);
    assert.ok(afterCancel > 0, "post-cancel host snapshot must exist");
    assert.ok(retry > afterCancel, "host no-publication assertion must precede retry");
    assert.match(
      helpers.slice(afterCancel, retry),
      /JSON\.stringify\(corporaAfterCancel\).*JSON\.stringify\(corporaBefore\)/s,
    );
  });
});
