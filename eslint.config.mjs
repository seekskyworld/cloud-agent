// 核心类型与复杂度门槛由 CI 和本地检查共用。
import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", URL: "readonly", fetch: "readonly" },
    },
  },
  ...ts.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      complexity: ["error", 20],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  { ignores: ["dist/**", "node_modules/**", "project/**"] },
);
