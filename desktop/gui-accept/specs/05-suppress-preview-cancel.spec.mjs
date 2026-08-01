/**
 * Scenario: Suppress rationale → Preview → Cancel → reopen → Preview
 * with no rule/exclusion mutation; window survival.
 *
 * Hard-fail path: fill required rationale, click "Preview impact", assert
 * suppression preview surface, Cancel without Confirm, reopen and Preview
 * again, prove Noise rule counts did not increase.
 *
 * Under tauri-driver + WebKitWebDriver:
 * - Prefer in-page JS for open/click (intercept / out-of-bounds).
 * - Prefer WebDriver element APIs for textarea setValue (execute queries
 *   of the portaled dialog were flaky).
 * - After Cancel (post-preview) the product reloads policy — wait for
 *   Suppress… to remount before the second open.
 */
import {
  bootstrapLogsWithDemoCorpus,
  openExplorer,
  pointerClick,
  screenshot,
  TIMEOUTS,
  SEL,
} from "./helpers.mjs";

const RATIONALE =
  "GUI accept: exact-template noise candidate for cancel-integrity only.";

/**
 * Fast DOM check — no WDIO implicit waits (those stall reopen polls).
 * @returns {Promise<boolean>}
 */
async function suppressDialogOpen() {
  return browser.execute(() => {
    const root =
      document.querySelector('[data-testid="suppress-template-backdrop"]') ||
      document.querySelector('[role="dialog"]');
    if (!root) return false;
    const t = root.textContent || "";
    if (!/Suppress exact template/i.test(t)) return false;
    return Boolean(root.querySelector("textarea"));
  });
}

/**
 * @returns {Promise<boolean>}
 */
async function previewSurfaceVisible() {
  return browser.execute(() => {
    if (document.querySelector('[aria-label="Suppression preview"]')) return true;
    const root =
      document.querySelector('[data-testid="suppress-template-backdrop"]') ||
      document.querySelector('[role="dialog"]');
    if (!root) return false;
    const t = root.textContent || "";
    return (
      /exact matches/i.test(t) &&
      /Newly hidden/i.test(t) &&
      /Confirm suppression/i.test(t)
    );
  });
}

/**
 * True if a candidate Suppress control is in the document (any ellipsis form).
 * @returns {Promise<boolean>}
 */
async function suppressButtonsReady() {
  return browser.execute(() => {
    return Array.from(document.querySelectorAll("button")).some((b) => {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!t.includes("Suppress")) return false;
      if (/Confirm/i.test(t)) return false;
      if (/exact template/i.test(t)) return false;
      // "Suppress…" / "Suppress..." / "Suppress" only (not longer CTAs)
      return /^Suppress/.test(t) && t.length <= 12;
    });
  });
}

/**
 * Click first matching Suppress… control.
 * Returns debug string on failure (button labels) so logs show why.
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
async function clickSuppressControl() {
  // 1) In-page click (no disabled skip — product may flip disabled during reload)
  const js = await browser.execute(() => {
    const labels = [];
    const buttons = Array.from(document.querySelectorAll("button"));
    let target = null;
    for (const b of buttons) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (t) labels.push(t);
      if (
        t.includes("Suppress") &&
        !/Confirm/i.test(t) &&
        !/exact template/i.test(t) &&
        /^Suppress/.test(t) &&
        t.length <= 12
      ) {
        target = b;
        break;
      }
    }
    if (!target) {
      return { ok: false, detail: labels.slice(0, 40).join(" || ") };
    }
    try {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* */
    }
    try {
      target.focus();
    } catch {
      /* */
    }
    // Full pointer sequence — pure .click() can no-op after policy reload remount
    const fire = (type, Ctor, extra) => {
      try {
        target.dispatchEvent(
          new Ctor(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: 1,
            ...extra,
          }),
        );
      } catch {
        /* older WebKit may lack PointerEvent */
      }
    };
    fire("pointerdown", typeof PointerEvent === "function" ? PointerEvent : MouseEvent, {
      pointerType: "mouse",
    });
    fire("mousedown", MouseEvent, {});
    fire("pointerup", typeof PointerEvent === "function" ? PointerEvent : MouseEvent, {
      pointerType: "mouse",
    });
    fire("mouseup", MouseEvent, {});
    fire("click", MouseEvent, {});
    target.click();
    return { ok: true, detail: (target.textContent || "").trim() };
  });
  if (js && js.ok) return js;

  // 2) WDIO button= selectors (unicode ellipsis + three dots)
  for (const label of ["Suppress…", "Suppress...", "Suppress"]) {
    try {
      const btn = await $(`button=${label}`);
      if (await btn.isExisting()) {
        try {
          await btn.click();
        } catch {
          await browser.execute((n) => n && n.click && n.click(), btn);
        }
        return { ok: true, detail: label };
      }
    } catch {
      /* */
    }
  }

  // 3) XPath contains Suppress
  try {
    const btn = await $(
      `//button[contains(normalize-space(.), "Suppress") and not(contains(., "Confirm")) and not(contains(., "exact"))]`,
    );
    if (await btn.isExisting()) {
      await browser.execute((n) => n && n.click && n.click(), btn);
      return { ok: true, detail: "xpath-suppress" };
    }
  } catch {
    /* */
  }

  return {
    ok: false,
    detail: (js && js.detail) || "no Suppress control found",
  };
}

/**
 * Click a dialog button by exact label.
 * @param {string} label
 * @returns {Promise<boolean>}
 */
async function clickDialogButton(label) {
  return browser.execute((want) => {
    const root =
      document.querySelector('[data-testid="suppress-template-backdrop"]') ||
      document.querySelector('[role="dialog"]') ||
      document.body;
    const btn = Array.from(root.querySelectorAll("button")).find((b) => {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      return t === want;
    });
    if (!btn || btn.disabled) return false;
    try {
      btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* */
    }
    const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 };
    btn.dispatchEvent(new PointerEvent("pointerdown", opts));
    btn.dispatchEvent(new MouseEvent("mousedown", opts));
    btn.dispatchEvent(new PointerEvent("pointerup", opts));
    btn.dispatchEvent(new MouseEvent("mouseup", opts));
    btn.click();
    return true;
  }, label);
}

/**
 * @returns {Promise<WebdriverIO.Element>}
 */
async function rationaleTextarea() {
  const selectors = [
    "textarea.log-explorer__suppress-rationale",
    '[data-testid="suppress-template-backdrop"] textarea',
    '[role="dialog"] textarea',
    "//*[@role='dialog']//textarea",
  ];
  for (const sel of selectors) {
    try {
      const el = await $(sel);
      // isExisting is immediate (no long implicit wait when using custom $)
      if (await el.isExisting()) return el;
    } catch {
      /* */
    }
  }
  throw new Error("Rationale textarea not found in Suppress dialog");
}

/**
 * @param {string} text
 */
async function fillRationale(text) {
  await browser.waitUntil(
    async () => {
      try {
        return await (await rationaleTextarea()).isExisting();
      } catch {
        return false;
      }
    },
    {
      timeout: TIMEOUTS.element,
      interval: 150,
      timeoutMsg: "Rationale textarea never appeared after Suppress dialog open",
    },
  );
  const ta = await rationaleTextarea();
  try {
    await ta.click();
  } catch {
    await browser.execute((n) => n && n.focus && n.focus(), ta);
  }
  try {
    await ta.clearValue();
  } catch {
    /* */
  }
  try {
    await ta.setValue(text);
  } catch {
    /* */
  }
  await browser.execute(
    (node, value) => {
      if (!node) return;
      const proto = window.HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(node, value);
      else node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    ta,
    text,
  );
  const current = await browser.execute((node) => (node ? node.value : ""), ta);
  if (!current || !String(current).includes("GUI accept")) {
    throw new Error(
      `Rationale not set after fill (got ${JSON.stringify(current)})`,
    );
  }
}

async function ensureRuleName() {
  await browser.execute(() => {
    const root =
      document.querySelector('[data-testid="suppress-template-backdrop"]') ||
      document.querySelector('[role="dialog"]');
    if (!root) return;
    const input =
      Array.from(root.querySelectorAll("label"))
        .find((l) => /Rule name/i.test(l.textContent || ""))
        ?.querySelector("input") ||
      root.querySelector('input:not([type="checkbox"]):not([type="hidden"])');
    if (!input || (input.value || "").trim()) return;
    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, "gui-accept-cancel-integrity");
    else input.value = "gui-accept-cancel-integrity";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/**
 * Open Suppress dialog and run Preview impact to the impact surface.
 */
async function openSuppressAndPreviewImpact() {
  // Wait for candidate Suppress controls (post-cancel policy reload remounts them)
  await browser.waitUntil(async () => suppressButtonsReady(), {
    timeout: TIMEOUTS.noiseReview,
    interval: 200,
    timeoutMsg: "Suppress… control not available on noise review",
  });

  let opened = await suppressDialogOpen();
  let lastClickDetail = "";
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    const click = await clickSuppressControl();
    lastClickDetail = click.detail || "";
    if (!click.ok) {
      // Brief pause for policy-reload remount, then retry
      await browser.pause(300);
      if (attempt >= 3) {
        throw new Error(
          `Suppress… control not found — cannot exercise Preview impact path (buttons: ${lastClickDetail})`,
        );
      }
      continue;
    }
    const start = Date.now();
    while (Date.now() - start < 12_000) {
      if (await suppressDialogOpen()) {
        opened = true;
        break;
      }
      await browser.pause(150);
    }
  }
  if (!opened) {
    throw new Error(
      `Suppress exact template dialog did not open after retries (last click: ${lastClickDetail})`,
    );
  }

  await ensureRuleName();
  await fillRationale(RATIONALE);

  if (!(await previewSurfaceVisible())) {
    let ok = await clickDialogButton(SEL.previewImpact);
    if (!ok) {
      ok = await browser.execute(() => {
        const form =
          document.querySelector(
            '[data-testid="suppress-template-backdrop"] form',
          ) ||
          document.querySelector('[role="dialog"]') ||
          document.querySelector(".log-explorer__suppress-dialog");
        if (!form) return false;
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
          return true;
        }
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        return true;
      });
    }
    if (!ok) {
      throw new Error("Preview impact control not found / not submitted");
    }
  }

  await browser.waitUntil(async () => previewSurfaceVisible(), {
    timeout: TIMEOUTS.suppressPreview,
    interval: 200,
    timeoutMsg:
      "Suppression preview surface missing after Preview impact (need exact matches / Newly hidden / Confirm suppression)",
  });
}

async function cancelSuppressDialog() {
  let ok = await clickDialogButton(SEL.cancelPreview);
  if (!ok) ok = await clickDialogButton("Close");
  if (!ok) {
    try {
      await browser.keys("Escape");
    } catch {
      /* */
    }
  }
  await browser.waitUntil(async () => !(await suppressDialogOpen()), {
    timeout: TIMEOUTS.element,
    interval: 150,
    timeoutMsg: "Suppress dialog still open after Cancel",
  });
  // Product reloads policy after cancel-with-preview — wait for Suppress remount
  await browser.waitUntil(async () => suppressButtonsReady(), {
    timeout: TIMEOUTS.noiseReview,
    interval: 200,
    timeoutMsg: "Suppress… did not remount after Cancel / policy reload",
  });
}

/**
 * Force a clean Noise → Review suggestions mount.
 * After Cancel-with-preview the product reloads policy; remounted Suppress
 * buttons can be non-interactive until the review panel is re-entered.
 */
async function ensureNoiseReviewOpen({ forceRemount = false } = {}) {
  const reviewLooksOpen = async () =>
    browser.execute(() => {
      const t = document.body?.innerText || "";
      return (
        /Redacted representatives/i.test(t) ||
        /Nothing is preselected/i.test(t) ||
        (/Showing\s+\d+/i.test(t) && /eligible suggestion/i.test(t))
      );
    });

  if (forceRemount || !(await reviewLooksOpen())) {
    // Leave review if present (Done / Back to policy)
    await browser.execute(() => {
      const labels = ["Done", "Back to policy"];
      for (const label of labels) {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => (b.textContent || "").replace(/\s+/g, " ").trim() === label,
        );
        if (btn) {
          btn.click();
          return;
        }
      }
    });
    await browser.pause(250);

    // Open Noise menu → Review suggestions
    await browser.execute(() => {
      const noise = Array.from(document.querySelectorAll("button")).find((b) =>
        /Noise/i.test((b.textContent || "").trim()),
      );
      if (noise) noise.click();
    });
    await browser.pause(200);
    await browser.execute(() => {
      const review = Array.from(document.querySelectorAll("button")).find((b) =>
        /Review suggestions/i.test((b.textContent || "").trim()),
      );
      if (review) review.click();
    });
    // Fallback WDIO if execute path missed
    if (!(await reviewLooksOpen())) {
      const noiseBtns = await $$(`//button[contains(., "Noise")]`);
      if ((await noiseBtns.length) > 0) await pointerClick(noiseBtns[0]);
      try {
        const review = await $(
          `//button[contains(normalize-space(.), "Review suggestions")]`,
        );
        if (await review.isDisplayed()) await pointerClick(review);
      } catch {
        /* */
      }
    }
  }

  await browser.waitUntil(async () => reviewLooksOpen(), {
    timeout: TIMEOUTS.noiseReview,
    interval: 200,
    timeoutMsg: "noise review panel did not re-open",
  });
  await browser.waitUntil(async () => suppressButtonsReady(), {
    timeout: TIMEOUTS.noiseReview,
    interval: 200,
    timeoutMsg: "Suppress… not ready after noise review remount",
  });
}

describe("05 Suppress Preview → Cancel integrity", () => {
  it("preview cancel does not mutate suppression rules", async () => {
    await bootstrapLogsWithDemoCorpus();
    try {
      await openExplorer();
    } catch {
      /* already open */
    }

    const noiseBtns = await $$(`//button[contains(., "Noise")]`);
    if ((await noiseBtns.length) === 0) {
      throw new Error("Noise control not found — cannot prove cancel integrity");
    }
    const baselineNoise = await noiseBtns[0].getText();
    const baseRulesMatch = baselineNoise.match(/(\d+)\s*rule/);
    const baseRules = baseRulesMatch ? Number(baseRulesMatch[1]) : 0;

    await pointerClick(noiseBtns[0]);
    try {
      const review = await $(
        `//button[contains(normalize-space(.), "Review suggestions")]`,
      );
      if (await review.isDisplayed()) await pointerClick(review);
    } catch {
      const link = await $(
        `//*[contains(normalize-space(.), "Review suggestions")]`,
      );
      await pointerClick(link);
    }
    await browser.waitUntil(
      async () =>
        /Showing\s+\d+|suggestion|candidate|Redacted representatives/i.test(
          await $("body").getText(),
        ),
      {
        timeout: TIMEOUTS.noiseReview,
        timeoutMsg: "noise review panel did not open before Suppress",
      },
    );

    // First Preview impact
    await openSuppressAndPreviewImpact();
    await screenshot("05-preview-open");

    await cancelSuppressDialog();
    await screenshot("05-preview-cancelled");

    // Reopen after policy reload — force remount so Suppress onClick is live
    await ensureNoiseReviewOpen({ forceRemount: true });
    await browser.pause(400);
    await openSuppressAndPreviewImpact();
    await screenshot("05-preview-reopened");
    await cancelSuppressDialog();

    const noiseAfter = await $$(`//button[contains(., "Noise")]`);
    if ((await noiseAfter.length) === 0) {
      throw new Error(
        "Noise control missing after cancel — window integrity failed",
      );
    }
    const afterNoise = await noiseAfter[0].getText();
    const afterRulesMatch = afterNoise.match(/(\d+)\s*rule/);
    const afterRules = afterRulesMatch ? Number(afterRulesMatch[1]) : 0;
    if (afterRules > baseRules) {
      throw new Error(
        `suppression rule count increased after cancel: ${baselineNoise} → ${afterNoise}`,
      );
    }
    if (baseRulesMatch && afterRulesMatch && afterRules !== baseRules) {
      throw new Error(
        `suppression rule count changed after cancel (expected ${baseRules}): ${baselineNoise} → ${afterNoise}`,
      );
    }

    const body = await $("body");
    await expect(body).toBeDisplayed();
    await screenshot("05-window-survived");
  });
});
