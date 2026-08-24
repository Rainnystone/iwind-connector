import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      ".wrangler/",
      "coverage/",
      "dist/",
      "gateway/src/worker-configuration.d.ts",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["gateway/test/**/*.ts", "skill/test/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
  })),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["gateway/src/**/*.ts"],
  })),
  {
    files: ["gateway/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
