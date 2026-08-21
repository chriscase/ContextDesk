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
    include: ["src/**/*.test.tsx"],
  },
}));
