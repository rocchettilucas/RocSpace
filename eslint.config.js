// ESLint flat config. Type-checked rules are deliberately OFF: `pnpm typecheck`
// already runs the compiler over the whole project, and the type-aware preset
// roughly triples lint time for rules that mostly restate compiler errors.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      // Generated IPC bindings (tauri-specta output; lands in a later phase).
      "src/lib/bindings.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2024 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // `_`-prefixed bindings are the codebase's convention for intentional
      // discards (destructured rest, unused catch params).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "**/*.config.{js,ts}",
      "vite.config.ts",
      "vitest.config.ts",
      // Build tooling: runs under node, never reaches the renderer.
      "scripts/**/*.{js,mjs}",
    ],
    languageOptions: { globals: globals.node },
  },
  // Must stay last: turns off every stylistic rule Prettier owns.
  prettierConfig,
);
