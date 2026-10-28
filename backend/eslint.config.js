import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "starter-kit", "data"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Domain and application layers must not reach into adapters (Shopify is replaceable).
    files: ["src/domain/**/*.ts", "src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/adapters/**"], message: "Domain/application code depends on ports, never on adapters." }] }],
    },
  },
);
