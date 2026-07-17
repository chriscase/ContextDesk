import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
  clearScreen: false,
  server: {
    port,
    strictPort: strictPort || process.env.CD_STRICT_PORT === "1",
    // If not strict and 1450 is busy, Vite will try next ports automatically
    // when strictPort is false — only for bare `npm run dev`.
    host: "127.0.0.1",
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
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
