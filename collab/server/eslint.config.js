import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";
import noModuleDeepImport from "./eslint-rules/no-module-deep-import.mjs";

/**
 * Modular-monolith boundaries: other code may depend on a module only through
 * that module's public `index.ts` entry point. Deep imports into another
 * module's internals are lint errors so later slices land as modules, not tangles.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src/modules/_fixtures/**",
      "vitest.config.ts",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries, local: noModuleDeepImport },
    languageOptions: {
      globals: { ...globals.node },
    },
    settings: {
      "boundaries/include": ["src/**/*.ts"],
      "boundaries/elements": [
        {
          type: "module",
          pattern: "src/modules/*",
          mode: "folder",
          capture: ["module"],
        },
        {
          type: "non-module",
          pattern: "src/**",
          mode: "full",
        },
      ],
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "local/no-module-deep-import": "error",
      "boundaries/entry-point": [
        "error",
        {
          default: "disallow",
          rules: [
            {
              target: ["module"],
              allow: "index.ts",
            },
          ],
        },
      ],
      "boundaries/no-unknown": "off",
      "boundaries/no-unknown-files": "off",
    },
  },
);
