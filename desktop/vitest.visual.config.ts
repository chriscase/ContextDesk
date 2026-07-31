import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import baseConfig from "./vite.config";

/**
 * Renderer-level visual acceptance suite (real Chromium via Vitest browser
 * mode). Deliberately a SEPARATE config so `npm run test` — and therefore the
 * documented CI gate — stays byte-identical: unit tests keep running in
 * happy-dom from vite.config.ts, and this suite only runs via
 * `npm run test:visual`.
 *
 * Honesty boundary (docs/CLOSE_PROOF.md § Native packaged proof): everything
 * this suite proves is renderer-level — real layout, real CSS, real focus and
 * ARIA semantics inside a headless Chromium page. It is NOT native packaged
 * acceptance: no packaged shell, no OS window manager, no OS-level input.
 *
 * Determinism: one pinned environment per platform. Baseline filenames embed
 * browser + platform (…-chromium-darwin.png), so baselines are per-OS by
 * construction. Chromium flags pin the color profile and disable subpixel AA;
 * the context pins DPR 1, reduced motion, UTC, en-US.
 */
export default defineConfig({
  plugins: [react()],
  // Reuse the app's resolve.alias so @contextdesk/* stay source-consumed
  // exactly like production and the unit suite.
  resolve: baseConfig.resolve,
  test: {
    name: "visual",
    include: ["visual/**/*.test.{ts,tsx}"],
    globals: true,
    browser: {
      enabled: true,
      headless: true,
      // Failure screenshots default into __screenshots__/ next to reviewed
      // baselines and end up in commits; toMatchScreenshot already writes
      // actual+diff artifacts to .vitest-attachments/ (gitignored).
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          args: [
            "--force-color-profile=srgb",
            "--disable-lcd-text",
            "--hide-scrollbars",
          ],
        },
        contextOptions: {
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          timezoneId: "UTC",
          locale: "en-US",
          // The app themes via html[data-theme], not prefers-color-scheme;
          // tests flip the attribute. colorScheme only pins UA-native widgets.
          colorScheme: "dark",
        },
      }),
      viewport: { width: 1280, height: 800 },
      instances: [{ browser: "chromium" }],
      expect: {
        toMatchScreenshot: {
          comparatorName: "pixelmatch",
          // 0 mismatched pixels is vitest's default and flakes on AA jitter;
          // 0.1% keeps a 600×400 region under ~240px of slack while still
          // failing on any real layout or palette shift.
          comparatorOptions: { allowedMismatchedPixelRatio: 0.001 },
        },
      },
    },
  },
});
