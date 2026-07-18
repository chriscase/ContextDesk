import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Initial ruleset: recommended TS + classic react-hooks (rules-of-hooks /
 * exhaustive-deps). Defer aggressive React Compiler-style rules (set-state-in-effect)
 * until the #96 App split — tree has many intentional sync-from-host effects.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src-tauri/**",
      "node_modules/**",
      "eslint.config.js",
      "vite.config.ts",
      "scripts/**",
      // Plain browser pre-paint scripts (#152); not TS modules.
      "public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Classic hooks only — not the full React Compiler recommended set.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
