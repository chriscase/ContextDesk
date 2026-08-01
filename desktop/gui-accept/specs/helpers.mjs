/**
 * Shared scenario helpers — real pointer interactions, semantic waits.
 * Wizard labels must match PreLaunchScreen production strings exactly.
 *
 * WebdriverIO note: `*=text` is **partial link text** (anchors only). Never use it
 * for buttons/labels/body chrome — use button=… or XPath contains.
 */

import { TIMEOUTS } from "../harness/waits.mjs";
import { SEL, WIZARD_ADVANCE_LABELS } from "../harness/selectors.mjs";
import { join } from "node:path";

const runDir = process.env.GUI_ACCEPT_RUN_DIR || ".";

/**
 * Escape a string for inclusion in an XPath double-quoted literal.
 * @param {string} s
 */
function xpathLiteral(s) {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `concat(${s
    .split('"')
    .map((part, i, arr) => (i < arr.length - 1 ? `"${part}",'"'` : `"${part}"`))
    .join(",")})`;
}

/**
 * True if any visible DOM node contains the text (not link-only).
 * @param {string} text
 */
export async function pageHasText(text) {
  try {
    const el = await $(`//*[contains(normalize-space(.), ${xpathLiteral(text)})]`);
    return el.isExisting();
  } catch {
    return false;
  }
}

/**
 * Body text snapshot (for assertions + failure diagnostics).
 * @returns {Promise<string>}
 */
export async function bodyText() {
  try {
    return await $("body").getText();
  } catch {
    return "";
  }
}

/**
 * Fail fast if the binary is a cfg(dev) host still pointing at Vite.
 */
export async function assertNotDevUrlBlank() {
  const t = await bodyText();
  if (/Could not connect to localhost/i.test(t) || /ERR_CONNECTION_REFUSED/i.test(t)) {
    throw new Error(
      "WebView shows localhost connection failure — host was built with cargo-only / cfg(dev). Rebuild with `npm run tauri:build -- --bundles none`.",
    );
  }
}

/**
 * Real pointerdown → click sequence (not only synthetic click).
 * @param {WebdriverIO.Element} el
 */
export async function pointerClick(el) {
  await el.waitForDisplayed({ timeout: TIMEOUTS.action });
  await el.moveTo();
  try {
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: el })
      .down({ button: 0 })
      .up({ button: 0 })
      .perform();
  } catch {
    await el.click();
  }
}

/**
 * @param {string} name
 * @param {number} [timeout]
 */
export async function waitForText(name, timeout = TIMEOUTS.element) {
  const el = await $(`//*[contains(normalize-space(.), ${xpathLiteral(name)})]`);
  await el.waitForDisplayed({ timeout });
  return el;
}

/**
 * Click a button by exact accessible name when visible.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function clickButtonIfVisible(name) {
  try {
    const btn = await $(`button=${name}`);
    if (await btn.isExisting() && (await btn.isDisplayed())) {
      const disabled = await btn.getAttribute("disabled");
      if (disabled === "true" || disabled === true) return false;
      await pointerClick(btn);
      return true;
    }
  } catch {
    /* not present */
  }
  return false;
}

/**
 * Demo opt-in checkbox: input is a *sibling* of the label (htmlFor), not nested.
 * Prefer role/accessible-name path; fall back to id wiring via label[for].
 * @returns {Promise<WebdriverIO.Element>}
 */
export async function demoOptInCheckbox() {
  // aria/accessible: input associated with label "Install demo log corpus"
  const byLabel = await $(
    `//input[@type="checkbox" and @id=//label[contains(normalize-space(.), "${SEL.demoCheckboxName}")]/@for]`,
  );
  if (await byLabel.isExisting()) return byLabel;

  // Sibling structure: .launch-demo__choice > input + label
  const sibling = await $(
    `//div[contains(@class,"launch-demo")]//input[@type="checkbox"]`,
  );
  if (await sibling.isExisting()) return sibling;

  throw new Error(
    `Demo opt-in checkbox not found (expected sibling of label "${SEL.demoCheckboxName}")`,
  );
}

/**
 * Opt in if not already checked / installed.
 */
export async function ensureDemoOptIn() {
  const box = await demoOptInCheckbox();
  await box.waitForExist({ timeout: TIMEOUTS.element });
  if (!(await box.isSelected()) && !(await box.getAttribute("disabled"))) {
    await pointerClick(box);
  }
  // Install demo button appears only after opt-in (when not already installed)
}

/**
 * Advance Workspace → AI → Ready using production CTAs only.
 * Splash may show first; wait it out before advancing.
 */
export async function reachReadyStep() {
  await browser.waitUntil(
    async () => {
      const body = await $("body");
      return body.isDisplayed();
    },
    { timeout: TIMEOUTS.launch, timeoutMsg: "body not visible" },
  );
  await assertNotDevUrlBlank();

  // Already on Ready if demo section or Enter app is present
  if (await isReadyStepVisible()) return;
  // Main chrome already (setup completed path) — treat as ready for non-demo steps
  if (await isMainChromeVisible()) return;

  for (let attempt = 0; attempt < 24; attempt++) {
    if (await isReadyStepVisible()) return;
    if (await isMainChromeVisible()) return;
    await assertNotDevUrlBlank();

    let advanced = false;
    // Exact production CTAs only (no "Continue" / "Use OS default")
    for (const label of WIZARD_ADVANCE_LABELS) {
      if (await clickButtonIfVisible(label)) {
        advanced = true;
        await browser.pause(500);
        break;
      }
    }
    // Partial-match fallbacks for arrow variants / whitespace
    if (!advanced) {
      for (const partial of [
        "Use default folder",
        "Continue to AI",
        "Continue to Ready",
      ]) {
        try {
          const btn = await $(
            `//button[contains(normalize-space(.), ${xpathLiteral(partial)})]`,
          );
          if ((await btn.isExisting()) && (await btn.isDisplayed())) {
            const disabled = await btn.getAttribute("disabled");
            if (disabled !== "true" && disabled !== true) {
              await pointerClick(btn);
              advanced = true;
              await browser.pause(500);
              break;
            }
          }
        } catch {
          /* */
        }
      }
    }
    if (!advanced) {
      // Splash / animation / workspace detection
      await browser.pause(750);
    }
  }

  if (!(await isReadyStepVisible()) && !(await isMainChromeVisible())) {
    const snippet = (await bodyText()).slice(0, 500);
    throw new Error(
      `Could not reach Ready step or main chrome. Expected demo/Enter or Logs chrome. Body snippet: ${JSON.stringify(snippet)}`,
    );
  }
}

/**
 * @returns {Promise<boolean>}
 */
export async function isMainChromeVisible() {
  try {
    if (await $('[data-testid="status-bar-readiness"]').isExisting()) return true;
    if (await $(`button=${SEL.openExplorer}`).isExisting()) return true;
    if (await $(`button=${SEL.importLogs}`).isExisting()) return true;
    // Ellipsis variants / partial
    if (await pageHasText("Open Explorer")) return true;
    if (await pageHasText("Import logs")) return true;
    if (await pageHasText("Corpus library")) return true;
    if (await pageHasText("Demo · seven-day")) return true;
  } catch {
    /* */
  }
  return false;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isReadyStepVisible() {
  try {
    if (await pageHasText(SEL.demoCheckboxName)) return true;
    if (await $(`button=${SEL.enterApp}`).isExisting()) return true;
    if (await $(`button=${SEL.enterAppLogs}`).isExisting()) return true;
    if (await $(`button=${SEL.installDemo}`).isExisting()) return true;
  } catch {
    /* */
  }
  return false;
}

/**
 * Install the production 25k demo via the PreLaunch UI (full success path).
 */
export async function installDemo25k() {
  await reachReadyStep();
  await ensureDemoOptIn();

  // Already installed from prior cancel/retry recovery
  if (
    (await pageHasText(SEL.demoInstalled)) ||
    (await pageHasText(SEL.demoAlready))
  ) {
    return { already: true };
  }

  const installBtn = await $(`button=${SEL.installDemo}`);
  await installBtn.waitForDisplayed({ timeout: TIMEOUTS.element });
  await pointerClick(installBtn);

  // Truthful progress (aria-label on <progress>)
  try {
    const progress = await $(`[aria-label="${SEL.demoProgress}"]`);
    await progress.waitForExist({ timeout: 15_000 });
  } catch {
    /* very fast hosts may finish before progress paints */
  }

  await browser.waitUntil(
    async () => {
      return (
        (await pageHasText(SEL.demoInstalled)) ||
        (await pageHasText(SEL.demoAlready))
      );
    },
    {
      timeout: TIMEOUTS.import25k,
      timeoutMsg: "demo 25k install did not complete",
    },
  );
  return { already: false };
}

/** Trusted-host corpus identity snapshot; no renderer-derived library inference. */
async function hostCorpusIdentitySnapshot() {
  const result = await browser.executeAsync((done) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      done({ error: "Tauri invoke bridge unavailable" });
      return;
    }
    internals
      .invoke("list_log_corpora")
      .then((rows) =>
        done({
          rows: rows
            .map((row) => ({
              id: String(row.id),
              name: String(row.name),
              eventCount: Number(row.event_count ?? row.eventCount ?? 0),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }),
      )
      .catch((error) => done({ error: String(error) }));
  });
  if (!result || result.error || !Array.isArray(result.rows)) {
    throw new Error(`host list_log_corpora failed: ${result?.error || "invalid result"}`);
  }
  return result.rows;
}

/**
 * Cancel mid-install then retry — must assert real cancel UI, not soft-skip.
 * @returns {Promise<{ cancelled: boolean, retried: boolean }>}
 */
export async function cancelAndRetryDemoInstall() {
  await reachReadyStep();
  const corporaBefore = await hostCorpusIdentitySnapshot();

  // If demo already installed, cannot exercise cancel — hard skip signal
  if (
    (await pageHasText(SEL.demoInstalled)) ||
    (await pageHasText(SEL.demoAlready))
  ) {
    throw new Error(
      "cancel/retry requires a fresh install; demo already installed. Run this scenario before a successful install in the same session.",
    );
  }

  await ensureDemoOptIn();
  const installBtn = await $(`button=${SEL.installDemo}`);
  await installBtn.waitForDisplayed({ timeout: TIMEOUTS.element });
  await pointerClick(installBtn);

  // Cancel must appear while install runs
  const cancel = await $(`button=${SEL.cancelInstall}`);
  await cancel.waitForDisplayed({
    timeout: 20_000,
    timeoutMsg: "Cancel control did not appear during demo install (progress path missing)",
  });
  await pointerClick(cancel);

  // Truthful cancel feedback: Cancelling… and/or Installation cancelled + Retry
  await browser.waitUntil(
    async () => {
      const cancelling = await $(`button=${SEL.cancelling}`).isExisting();
      const cancelledCopy = await pageHasText(SEL.installCancelled);
      const retry = await $(`button=${SEL.retryInstall}`).isExisting();
      return cancelling || cancelledCopy || retry;
    },
    {
      timeout: 60_000,
      timeoutMsg: "no cancel acknowledgement (Cancelling… / Installation cancelled / Retry)",
    },
  );

  let cancelled =
    (await pageHasText(SEL.installCancelled)) ||
    (await $(`button=${SEL.retryInstall}`).isExisting());

  // Wait out Cancelling… until retry or terminal cancelled state
  await browser.waitUntil(
    async () => {
      return (
        (await $(`button=${SEL.retryInstall}`).isExisting()) ||
        (await pageHasText(SEL.installCancelled)) ||
        (await pageHasText(SEL.demoInstalled))
      );
    },
    { timeout: TIMEOUTS.import25k, timeoutMsg: "install did not settle after cancel" },
  );

  cancelled =
    cancelled ||
    (await pageHasText(SEL.installCancelled)) ||
    (await $(`button=${SEL.retryInstall}`).isExisting());

  if (!cancelled || (await pageHasText(SEL.demoInstalled))) {
    throw new Error(
      "cancel request did not settle in the terminal cancelled state before publication",
    );
  }

  // Load-bearing atomicity proof: query trusted host state before any retry.
  // A partial or fully published demo corpus changes this exact identity list.
  const corporaAfterCancel = await hostCorpusIdentitySnapshot();
  if (JSON.stringify(corporaAfterCancel) !== JSON.stringify(corporaBefore)) {
    throw new Error(
      `cancel published or mutated corpus state before retry: ${JSON.stringify(corporaBefore)} -> ${JSON.stringify(corporaAfterCancel)}`,
    );
  }

  let retried = false;
  const retryBtn = await $(`button=${SEL.retryInstall}`);
  if (await retryBtn.isExisting()) {
    await pointerClick(retryBtn);
    retried = true;
    await browser.waitUntil(
      async () => {
        return (
          (await pageHasText(SEL.demoInstalled)) ||
          (await pageHasText(SEL.demoAlready))
        );
      },
      {
        timeout: TIMEOUTS.import25k,
        timeoutMsg: "retry after cancel did not install demo",
      },
    );
  } else if (
    !(await pageHasText(SEL.demoInstalled)) &&
    !(await pageHasText(SEL.demoAlready))
  ) {
    // Cancelled without retryable — re-opt-in and install for suite continuity
    await ensureDemoOptIn();
    const again = await $(`button=${SEL.installDemo}`);
    if (await again.isDisplayed()) {
      await pointerClick(again);
      await browser.waitUntil(
        async () =>
          (await pageHasText(SEL.demoInstalled)) ||
          (await pageHasText(SEL.demoAlready)),
        { timeout: TIMEOUTS.import25k },
      );
    }
  }

  if (!cancelled && !retried) {
    throw new Error(
      "cancel/retry path did not produce Installation cancelled, Retry, or Cancelling… UI",
    );
  }

  return { cancelled, retried };
}

export async function enterAppOpenLogs() {
  let entered = false;
  for (const name of [SEL.enterAppLogs, SEL.enterApp]) {
    try {
      const btn = await $(`button=${name}`);
      if (await btn.isDisplayed()) {
        await pointerClick(btn);
        entered = true;
        break;
      }
    } catch {
      /* */
    }
  }
  if (!entered) {
    throw new Error("Enter app button not found");
  }
  await browser.waitUntil(
    async () => {
      try {
        return (
          (await pageHasText("Open Explorer")) ||
          (await pageHasText("Import logs")) ||
          (await $('[data-testid="status-bar-readiness"]').isExisting())
        );
      } catch {
        return false;
      }
    },
    { timeout: TIMEOUTS.launch, timeoutMsg: "main chrome not ready" },
  );
}

/**
 * Open the Logs library surface (corpus list + Open Explorer controls).
 * Production shell tab id is #pane-tab-logs (PaneTabs).
 */
export async function ensureLogsLibraryVisible() {
  const onLogsLibrary = async () => {
    if (await $(`//button[contains(@class,"log-card")]`).isExisting()) return true;
    // Header only appears on Logs pane (avoid false positives from other chrome)
    if (
      (await pageHasText("Corpus library")) &&
      (await pageHasText("Import logs"))
    ) {
      return true;
    }
    return false;
  };

  if (await onLogsLibrary()) return;

  // Prefer stable product tab id
  const tabSelectors = [
    `#pane-tab-logs`,
    `//button[@id="pane-tab-logs"]`,
    `//*[@role="tab"][@id="pane-tab-logs"]`,
    `//*[@role="tab"][normalize-space()="Logs"]`,
    `//button[normalize-space()="Logs"]`,
  ];
  let clicked = false;
  for (const sel of tabSelectors) {
    try {
      const el = await $(sel);
      if ((await el.isExisting()) && (await el.isDisplayed())) {
        await pointerClick(el);
        clicked = true;
        break;
      }
    } catch {
      /* */
    }
  }
  if (!clicked) {
    const snippet = (await bodyText()).slice(0, 400);
    throw new Error(
      `Logs tab (#pane-tab-logs) not found. Body snippet: ${JSON.stringify(snippet)}`,
    );
  }

  await browser.waitUntil(onLogsLibrary, {
    timeout: TIMEOUTS.launch,
    timeoutMsg: "Logs library not visible after #pane-tab-logs",
  });
}

/**
 * Click Enter app when PreLaunch Ready CTAs are present.
 * @returns {Promise<boolean>}
 */
export async function tryEnterAppOpenLogs() {
  for (const name of [SEL.enterAppLogs, SEL.enterApp]) {
    try {
      const btn = await $(`button=${name}`);
      if ((await btn.isExisting()) && (await btn.isDisplayed())) {
        await enterAppOpenLogs();
        return true;
      }
    } catch {
      /* */
    }
  }
  return false;
}

/**
 * Cold-session bootstrap: reach main Logs with at least one corpus card.
 * Shared HOME may already have demo installed from a prior WDIO worker
 * (setup_completed true → no Enter app; just open #pane-tab-logs).
 */
export async function bootstrapLogsWithDemoCorpus() {
  await browser.waitUntil(
    async () => (await $("body").isDisplayed()),
    { timeout: TIMEOUTS.launch, timeoutMsg: "body not visible" },
  );
  await assertNotDevUrlBlank();

  // Give main chrome a moment after session open
  for (let i = 0; i < 10; i++) {
    if (await isReadyStepVisible()) break;
    if (await isMainChromeVisible()) break;
    await browser.pause(400);
  }

  if (await isReadyStepVisible()) {
    // First-run PreLaunch: ensure demo, then enter if CTAs exist
    if (
      !(await pageHasText(SEL.demoInstalled)) &&
      !(await pageHasText(SEL.demoAlready))
    ) {
      try {
        await installDemo25k();
      } catch {
        /* already installed mid-flight */
      }
    }
    await tryEnterAppOpenLogs();
  } else if (!(await isMainChromeVisible())) {
    // Splash / mid-wizard — advance production CTAs only
    await reachReadyStep();
    if (await isReadyStepVisible()) {
      if (
        !(await pageHasText(SEL.demoInstalled)) &&
        !(await pageHasText(SEL.demoAlready))
      ) {
        try {
          await installDemo25k();
        } catch {
          /* */
        }
      }
      await tryEnterAppOpenLogs();
    }
  }
  // else: already in main chrome (post-setup cold worker)

  await ensureLogsLibraryVisible();

  // Corpora load async from host — wait for cards (not just empty Import CTA)
  try {
    await browser.waitUntil(
      async () => {
        const cards = await $$(`//button[contains(@class,"log-card")]`);
        return (await cards.length) > 0;
      },
      { timeout: 25_000, timeoutMsg: "no log-card after opening Logs" },
    );
  } catch (e) {
    const snippet = (await bodyText()).slice(0, 500);
    throw new Error(`${e}. Body snippet: ${JSON.stringify(snippet)}`);
  }

  await ensureDemoCorpusSelected();
}

/**
 * Select the demo corpus card in Logs library so Open Explorer / Open in app
 * are enabled (both require activeId). Cards are buttons.log-card.
 */
export async function ensureDemoCorpusSelected() {
  // Already selected?
  try {
    const active = await $(`//button[contains(@class,"log-card") and @data-active="true"]`);
    if (await active.isExisting()) return;
  } catch {
    /* */
  }

  // Prefer demo card by name (button.log-card)
  const selectors = [
    `//button[contains(@class,"log-card") and contains(., "Demo")]`,
    `//button[contains(@class,"log-card") and contains(., "seven-day")]`,
    `//button[contains(@class,"log-card")]`,
  ];
  for (const sel of selectors) {
    try {
      const cards = await $$(sel);
      if ((await cards.length) === 0) continue;
      await pointerClick(cards[0]);
      await browser.waitUntil(
        async () => {
          const active = await $(
            `//button[contains(@class,"log-card") and @data-active="true"]`,
          );
          return active.isExisting();
        },
        { timeout: 8_000, timeoutMsg: "corpus card not marked data-active" },
      );
      // Wait for Open Explorer enablement
      await browser.waitUntil(
        async () => {
          const btn = await $(SEL.openExplorerInAppTestId);
          if (!(await btn.isExisting())) return false;
          const d = await btn.getAttribute("disabled");
          return d !== "true" && d !== true;
        },
        { timeout: 8_000, timeoutMsg: "Open in app still disabled after corpus select" },
      );
      return;
    } catch {
      /* try next */
    }
  }
  throw new Error("No log-card corpus button found to select");
}

export async function openExplorer() {
  // Cold WDIO workers land on Chat or PreLaunch — full bootstrap to Logs + corpus.
  try {
    await bootstrapLogsWithDemoCorpus();
  } catch (e) {
    // Same-session path (already on Logs with corpus after 02 enter)
    try {
      await ensureLogsLibraryVisible();
      await ensureDemoCorpusSelected();
    } catch {
      throw e;
    }
  }

  // Prefer in-app explorer (same surface, no multi-window). tauri-driver +
  // WebKitWebDriver often does not surface secondary Tauri windows as handles.
  let usedMultiWindow = false;
  const inApp =
    (await $(SEL.openExplorerInAppTestId).isExisting())
      ? await $(SEL.openExplorerInAppTestId)
      : await $(`button=${SEL.openExplorerInApp}`);
  if (await inApp.isExisting()) {
    await inApp.waitForEnabled({ timeout: TIMEOUTS.element });
    await inApp.waitForDisplayed({ timeout: TIMEOUTS.element });
    await pointerClick(inApp);
  } else {
    let btn = await $(`button=${SEL.openExplorer}`);
    if (!(await btn.isExisting())) {
      btn = await $(SEL.openExplorerTestId);
    }
    if (!(await btn.isExisting())) {
      btn = await $(`//button[contains(normalize-space(.), "Open Explorer")]`);
    }
    await btn.waitForDisplayed({ timeout: TIMEOUTS.element });
    const before = await browser.getWindowHandles();
    await pointerClick(btn);
    try {
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > before.length,
        { timeout: 8_000 },
      );
      const after = await browser.getWindowHandles();
      const neu = after.find((h) => !before.includes(h));
      if (neu) {
        await browser.switchToWindow(neu);
        usedMultiWindow = true;
      }
    } catch {
      /* in-window explorer or handle not exposed */
    }
  }

  const explorer = await $(SEL.logExplorer);
  await explorer.waitForDisplayed({
    timeout: TIMEOUTS.explorerReady,
    timeoutMsg: `log-explorer not displayed (multiWindow=${usedMultiWindow})`,
  });
  return explorer;
}

export async function closeExplorerWindow() {
  // In-app explorer (same window)
  try {
    const closeBtn = await $(`button=Close Explorer`);
    if ((await closeBtn.isExisting()) && (await closeBtn.isDisplayed())) {
      await pointerClick(closeBtn);
      await browser.pause(300);
      return;
    }
  } catch {
    /* */
  }
  // Multi-window explorer
  try {
    const handles = await browser.getWindowHandles();
    if (handles.length > 1) {
      await browser.closeWindow();
      const remaining = await browser.getWindowHandles();
      await browser.switchToWindow(remaining[0]);
      return;
    }
  } catch {
    /* */
  }
  await browser.keys("Escape");
}

export async function screenshot(name) {
  const file = join(runDir, "screenshots", `${Date.now()}-${name}.png`);
  await browser.saveScreenshot(file);
  return file;
}

export async function assertNoAcceptAll() {
  const all = await $$(`button=${SEL.acceptAll}`);
  if ((await all.length) > 0) {
    throw new Error("Found Accept all control — forbidden in noise review");
  }
  const body = await $("body").getText();
  // Panel must not offer bulk accept as a primary action label
  if (/\bAccept all\b/i.test(body)) {
    throw new Error("Body text contains Accept all — forbidden in noise review");
  }
}

/**
 * Conservative ERROR labeling + evidence fields (NoiseCandidateReview product copy).
 * Hard-fails when the review surface is open but required copy/evidence is missing.
 */
export async function assertNoiseConservativeEvidence() {
  const body = await $("body").getText();

  // Product honesty copy uses "not confirmed noise"; only fail on a positive claim.
  if (
    /confirmed noise/i.test(body) &&
    !/\bnot\s+confirmed\s+noise\b/i.test(body)
  ) {
    throw new Error("UI claimed confirmed noise — detector is proposal-only");
  }

  const panelOpen =
    /Showing\s+\d+|suggestion|candidate|preselected|ERROR\/WARN|Redacted representatives|Suggestions unavailable/i.test(
      body,
    );
  if (!panelOpen) {
    throw new Error(
      "Noise review panel not open; cannot assert ERROR conservatism or evidence",
    );
  }

  // Load error path is honest but has no candidate evidence — still fail closed
  // on Accept all (caller) and confirmed-noise; require unavailability text.
  if (/Suggestions unavailable/i.test(body)) {
    return;
  }

  // Product intro always states no preselect + ERROR/WARN conservatism when ready
  if (!body.includes(SEL.noiseNoPreselectCopy) && !/Nothing is preselected/i.test(body)) {
    throw new Error(
      `Missing no-preselection product copy ("${SEL.noiseNoPreselectCopy}")`,
    );
  }
  if (
    !body.includes(SEL.noiseConservativeErrorCopy) &&
    !/ERROR\/WARN-heavy/i.test(body)
  ) {
    throw new Error(
      `Missing conservative ERROR labeling copy ("${SEL.noiseConservativeErrorCopy}")`,
    );
  }

  const showingMatch = body.match(/Showing\s+(\d+)\s+of\s+(\d+)/i);
  const showing = Boolean(showingMatch);
  const shown = showingMatch ? Number(showingMatch[1]) : 0;
  const hasReps = body.includes(SEL.redactedRepresentatives);
  const hasLevel =
    /\b(ERROR|WARN|INFO|DEBUG|unset)\b/i.test(body) ||
    /seq\s+\d+\s*·/i.test(body);
  const emptyHonest =
    showing && shown === 0
      ? true
      : /no eligible|Nothing to review|No suggestions/i.test(body);

  if (!showing && !hasReps && !emptyHonest) {
    throw new Error(
      "Noise review lacks Showing N of M, representatives, or honest empty state",
    );
  }

  // When candidates are shown, evidence fields must include level/source identity
  if (shown > 0) {
    if (!hasReps && !hasLevel) {
      throw new Error(
        "Candidates shown but missing redacted representatives / level evidence fields",
      );
    }
    if (hasReps && !hasLevel) {
      throw new Error(
        "Redacted representatives present but no level/seq evidence fields",
      );
    }
  }
}

/**
 * Ensure Chat pane + at least one session list item (for context menu tests).
 */
export async function ensureChatSessionListVisible() {
  // Expand sidebar / open chat if collapsed or on another pane
  const chatTabSelectors = [
    `#pane-tab-chat`,
    `//button[@id="pane-tab-chat"]`,
    `//*[@role="tab"][normalize-space()="Chat"]`,
    `//button[normalize-space()="Chat"]`,
  ];
  for (const sel of chatTabSelectors) {
    try {
      const el = await $(sel);
      if ((await el.isExisting()) && (await el.isDisplayed())) {
        await pointerClick(el);
        break;
      }
    } catch {
      /* */
    }
  }

  // Expand collapsed sidebar
  try {
    const expand = await $(
      `//button[@aria-label="Expand chat navigation" or @title="Expand chats"]`,
    );
    if ((await expand.isExisting()) && (await expand.isDisplayed())) {
      await pointerClick(expand);
    }
  } catch {
    /* */
  }

  // Create a session if none
  const hasItem = async () => {
    try {
      const items = await $$(`//button[contains(@class,"session-list__item")]`);
      // exclude Archive & trash button which also uses session-list__item
      for (const it of items) {
        const t = await it.getText();
        if (!/Archive/i.test(t)) return true;
      }
    } catch {
      /* */
    }
    return false;
  };

  if (!(await hasItem())) {
    const newBtn = await $(`button=${SEL.newChat}`);
    if ((await newBtn.isExisting()) && (await newBtn.isDisplayed())) {
      await pointerClick(newBtn);
    } else {
      // collapsed rail +
      try {
        const plus = await $(`//button[@aria-label="New chat"]`);
        if (await plus.isExisting()) await pointerClick(plus);
      } catch {
        /* */
      }
    }
  }

  await browser.waitUntil(hasItem, {
    timeout: TIMEOUTS.launch,
    timeoutMsg: "no chat session list item after New chat",
  });
}

/**
 * Return the first non-archive session list button.
 * @returns {Promise<WebdriverIO.Element>}
 */
export async function firstChatSessionButton() {
  const items = await $$(`//button[contains(@class,"session-list__item")]`);
  for (const it of items) {
    const t = await it.getText();
    if (!/Archive/i.test(t)) return it;
  }
  throw new Error("no chat session button (only Archive?)");
}

/**
 * Open session context menu via real right-click, or edge-coordinate synthetic
 * contextmenu on the session button (still hits production openChatCtxMenu).
 * @param {WebdriverIO.Element} sessionBtn
 * @param {{ edge?: boolean }} [opts]
 */
export async function openChatSessionContextMenu(sessionBtn, opts = {}) {
  await sessionBtn.waitForDisplayed({ timeout: TIMEOUTS.element });

  // Production openChatCtxMenu reads clientX/clientY from the native event.
  // Prefer JS contextmenu dispatch (reliable under WebKitWebDriver); optional
  // pointer button-2 is best-effort only.
  await browser.execute(
    (el, edge) => {
      const r = el.getBoundingClientRect();
      const w = window.innerWidth;
      const h = window.innerHeight;
      const clientX = edge ? Math.max(8, w - 8) : r.left + r.width / 2;
      const clientY = edge ? Math.max(8, h - 8) : r.top + r.height / 2;
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 2,
          view: window,
        }),
      );
    },
    sessionBtn,
    Boolean(opts.edge),
  );

  const menu = await $(SEL.chatCtxMenu);
  await menu.waitForDisplayed({
    timeout: TIMEOUTS.element,
    timeoutMsg: "Chat context menu (.chat-ctx-menu) not displayed",
  });
  return menu;
}

/**
 * Hard assert: context menu fully inside viewport (readable, not clipped).
 * Waits for clamp layout to settle (first paint may be 0×0 then re-clamp).
 * @param {WebdriverIO.Element} menu
 * @param {number} [gutter=4]
 */
export async function assertMenuFullyInViewport(menu, gutter = 4) {
  /** @type {{ left: number, top: number, right: number, bottom: number, width: number, height: number, vw: number, vh: number } | null} */
  let geom = null;
  await browser.waitUntil(
    async () => {
      geom = await browser.execute((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      }, menu);
      if (!geom || geom.width < 40 || geom.height < 40) return false;
      if (geom.left < -gutter) return false;
      if (geom.top < -gutter) return false;
      if (geom.right > geom.vw + gutter) return false;
      if (geom.bottom > geom.vh + gutter) return false;
      return true;
    },
    {
      timeout: TIMEOUTS.element,
      timeoutMsg: `context menu not fully in viewport after clamp (#837): ${JSON.stringify(geom)}`,
    },
  );

  // Readable: at least one known menuitem label visible
  const body = await menu.getText();
  const need = [SEL.chatMenuOpen, SEL.chatMenuRename, SEL.chatMenuTrash];
  for (const label of need) {
    if (!body.includes(label.replace("…", "")) && !body.includes(label)) {
      // allow ellipsis variants
      if (!body.includes(label.replace("…", "...")) && !body.includes("Rename")) {
        throw new Error(
          `menu missing readable label ${JSON.stringify(label)}; text=${JSON.stringify(body.slice(0, 200))}`,
        );
      }
    }
  }
  return geom;
}

export { TIMEOUTS, SEL, WIZARD_ADVANCE_LABELS, runDir };
