import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_CONTEXTDESK_SYNTHETIC_DEMO": JSON.stringify(
      mode === "synthetic-demo" ? "1" : "0",
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    // Pure projection modules carry no JSX; keep them testable as plain .ts
    // rather than forcing a .tsx extension on a file with no components.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
}));
