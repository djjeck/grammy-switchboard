import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";

const importRules = {
  "@typescript-eslint/no-unused-vars": "off",
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      prefer: "type-imports",
      fixStyle: "inline-type-imports",
      disallowTypeAnnotations: false,
    },
  ],
  "import/consistent-type-specifier-style": ["error", "prefer-inline"],
  "import/no-duplicates": ["error", { "prefer-inline": true }],
  "unused-imports/no-unused-imports": "error",
  "simple-import-sort/imports": [
    "error",
    {
      groups: [
        [
          "^node:",
          "^(?!\\.)@?\\w",
          "^\\.(?!.*\\.(?:css|scss)$)",
          "^\\.\\.(?!.*\\.(?:css|scss)$)",
          "^\\u0000.*\\.(?:css|scss)$",
          "^\\u0000",
        ],
      ],
    },
  ],
  "simple-import-sort/exports": "error",
};

const plugins = {
  "@typescript-eslint": tsPlugin,
  import: importPlugin,
  "simple-import-sort": simpleImportSort,
  "unused-imports": unusedImports,
};

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins,
    rules: importRules,
  },
  {
    files: ["tests/**/*.ts", "examples/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins,
    rules: importRules,
  },
];
