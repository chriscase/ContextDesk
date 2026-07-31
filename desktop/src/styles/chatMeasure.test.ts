/**
 * Chat input-stack layout contract (#699, #767).
 *
 * The transcript rows, the context shelf, and the composer must present one
 * reading column: identical centered outer edges at every supported width.
 * That holds only when all three resolve the same `--chat-measure` inside
 * identical inline gutters, so this asserts the *computed* values from the
 * real stylesheets rather than matching source text.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const SHEETS = [
  "tokens.css",
  "layout.css",
  join("components", "chat.css"),
  join("components", "composer.css"),
];

/** Mount the production stylesheets and the real chat-pane nesting. */
function mountChatShell(): {
  transcriptRow: HTMLElement;
  scroll: HTMLElement;
  dock: HTMLElement;
  shelf: HTMLElement;
  composer: HTMLElement;
} {
  const style = document.createElement("style");
  style.textContent = SHEETS.map((f) => readFileSync(join(here, f), "utf8")).join(
    "\n",
  );
  document.head.appendChild(style);

  document.body.innerHTML = `
    <div class="pane-panel">
      <div class="chat-scroll-wrap">
        <div class="chat-scroll">
          <div class="chat-transcript">
            <div class="chat-transcript__row">
              <div class="msg" data-role="assistant"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="composer-dock">
        <div class="session-context-bar chat-input-surface"></div>
        <div class="composer chat-input-surface"></div>
      </div>
    </div>
  `;

  const q = (sel: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };

  return {
    transcriptRow: q(".msg"),
    scroll: q(".chat-scroll"),
    dock: q(".composer-dock"),
    shelf: q(".session-context-bar"),
    composer: q(".composer"),
  };
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("chat input-stack alignment (#699, #767)", () => {
  it("transcript, context shelf, and composer resolve one shared measure", () => {
    const { transcriptRow, shelf, composer } = mountChatShell();

    const transcriptWidth = getComputedStyle(transcriptRow).maxWidth;
    const shelfWidth = getComputedStyle(shelf).maxWidth;
    const composerWidth = getComputedStyle(composer).maxWidth;

    console.log(
      `measure: transcript=${transcriptWidth} shelf=${shelfWidth} composer=${composerWidth}`,
    );

    expect(transcriptWidth).toBe(composerWidth);
    expect(shelfWidth).toBe(composerWidth);
    // A real measure, not an unset/auto fallback that would silently pass.
    expect(transcriptWidth).toMatch(/^\d+(\.\d+)?px$/);
    expect(Number.parseFloat(transcriptWidth)).toBeGreaterThan(0);
  });

  it("the transcript scrollport and the composer dock use equal inline gutters", () => {
    const { scroll, dock } = mountChatShell();

    const scrollStyle = getComputedStyle(scroll);
    const dockStyle = getComputedStyle(dock);

    console.log(
      `gutters: scroll=${scrollStyle.paddingLeft}/${scrollStyle.paddingRight} dock=${dockStyle.paddingLeft}/${dockStyle.paddingRight}`,
    );

    expect(scrollStyle.paddingLeft).toBe(dockStyle.paddingLeft);
    expect(scrollStyle.paddingRight).toBe(dockStyle.paddingRight);
    // Equal gutters plus an equal centered measure is what makes the outer
    // edges line up; a zero-vs-zero match would be vacuous.
    expect(Number.parseFloat(scrollStyle.paddingLeft)).toBeGreaterThan(0);
  });

  it("both surfaces centre themselves rather than hugging a gutter", () => {
    const { transcriptRow, composer } = mountChatShell();

    const row = getComputedStyle(transcriptRow);
    const input = getComputedStyle(composer);

    expect(row.marginLeft).toBe("auto");
    expect(row.marginRight).toBe("auto");
    expect(input.marginLeft).toBe("auto");
    expect(input.marginRight).toBe("auto");
  });

});
