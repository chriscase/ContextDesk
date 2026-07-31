import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * @contextdesk/* packages are source-consumed (design handoff §7/B1): the
 * desktop bundler resolves them straight to their TypeScript sources — no
 * build step, no npm dependency, no lockfile churn. tsconfig.json carries the
 * matching `paths` entries for the type checker.
 */
const pkg = (name: string) =>
  fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url));

/**
 * Dev port strategy (see scripts/dev-port.mjs, docs/DEV.md):
 * - Prefer CD_DEV_PORT / PORT / VITE_DEV_PORT (set by `npm run tauri:dev` wrapper)
 * - Else ContextDesk base 1450 (not Tauri template default 1420)
 * - strictPort: true when wrapper picked a free port; false for bare `npm run dev`
 *   so a lone Vite can hop if needed
 */
const envPort = Number(
  process.env.CD_DEV_PORT || process.env.VITE_DEV_PORT || process.env.PORT || 0,
);
const port =
  Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535
    ? envPort
    : 1450;
// When the wrapper already reserved a free port, fail hard if stolen.
// Bare `vite` alone may scan (strictPort false) — less ideal for Tauri.
const strictPort = Boolean(
  process.env.CD_DEV_PORT || process.env.VITE_DEV_PORT || process.env.TAURI_ENV,
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@contextdesk/contracts": pkg("contracts"),
      "@contextdesk/client": pkg("client"),
      "@contextdesk/react": pkg("react"),
      "@contextdesk/ui": pkg("ui"),
    },
  },
  clearScreen: false,
  server: {
    port,
    strictPort: strictPort || process.env.CD_STRICT_PORT === "1",
    // If not strict and 1450 is busy, Vite will try next ports automatically
    // when strictPort is false — only for bare `npm run dev`.
    host: "127.0.0.1",
    fs: {
      // Serve the source-consumed @contextdesk/* packages (repo root).
      // In a git worktree `.git` is a file, so Vite's workspace-root
      // detection stops at desktop/ and would otherwise deny ../packages.
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
  envPrefix: ["VITE_", "TAURI_", "CD_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    environment: "happy-dom",
    globals: true,
    // Package tests are part of the desktop suite: @contextdesk/* packages
    // are source-consumed and have no test runner of their own (B1).
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "../packages/*/src/**/*.{test,spec}.{ts,tsx}",
    ],
  },
});
