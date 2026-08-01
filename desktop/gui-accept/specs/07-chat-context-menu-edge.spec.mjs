/**
 * #837 — Chat session context menu at right/bottom edge stays fully in viewport.
 * Linux release host via tauri-driver. Renderer geometry + label asserts + screenshot.
 */
import {
  bootstrapLogsWithDemoCorpus,
  reachReadyStep,
  tryEnterAppOpenLogs,
  isReadyStepVisible,
  isMainChromeVisible,
  ensureChatSessionListVisible,
  firstChatSessionButton,
  openChatSessionContextMenu,
  assertMenuFullyInViewport,
  screenshot,
  assertNotDevUrlBlank,
  TIMEOUTS,
} from "./helpers.mjs";

describe("07 chat context menu edge viewport (#837)", () => {
  it("clamps edge-opened session menu fully inside the viewport and keeps labels readable", async () => {
    await assertNotDevUrlBlank();

    if (await isReadyStepVisible()) {
      await reachReadyStep();
      await tryEnterAppOpenLogs();
    } else if (!(await isMainChromeVisible())) {
      try {
        await bootstrapLogsWithDemoCorpus();
      } catch {
        await reachReadyStep();
        await tryEnterAppOpenLogs();
      }
    }

    await ensureChatSessionListVisible();
    const session = await firstChatSessionButton();
    await session.waitForDisplayed({ timeout: TIMEOUTS.element });

    const menu = await openChatSessionContextMenu(session, { edge: true });
    const geom = await assertMenuFullyInViewport(menu);

    // Prove clamp moved the menu off the raw corner click (w-8 / h-8)
    if (geom.right >= geom.vw - 2) {
      throw new Error(`menu still flush to right edge: ${JSON.stringify(geom)}`);
    }
    if (geom.bottom >= geom.vh - 2) {
      throw new Error(`menu still flush to bottom edge: ${JSON.stringify(geom)}`);
    }
    if (geom.left < 4 || geom.top < 4) {
      throw new Error(`menu clipped past gutter: ${JSON.stringify(geom)}`);
    }

    const labels = await menu.getText();
    if (!/Open/i.test(labels) || !/Rename/i.test(labels) || !/Trash/i.test(labels)) {
      throw new Error(`menu labels not readable: ${JSON.stringify(String(labels).slice(0, 200))}`);
    }

    await screenshot("07-chat-ctx-menu-edge-viewport");
    console.log(
      `JSON_EVIDENCE ${JSON.stringify({
        scenario: "07-chat-context-menu-edge",
        issue: 837,
        edgeGeom: geom,
      })}`,
    );
  });
});
