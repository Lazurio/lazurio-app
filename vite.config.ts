import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Formatting, lint and test defaults follow Lazurio/t3code's vite.config.ts, so that code written
// here already passes the rules it will meet in Lazurio App GEN5 (docs/adr/0001).

const IGNORED = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-electron/**",
  "**/dist-ui/**",
  "**/release/**",
  "**/target/**",
  "**/gen/**",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
];

// The local windows' interface runs in a sandboxed renderer: no Node, no Electron, no helpers.
const RENDERER_RESTRICTED_IMPORTS = {
  paths: [
    {
      name: "electron",
      message: "The interface talks to the main process only through the preload bridge.",
    },
    {
      name: "@effect/platform-node",
      message: "Node services do not exist in a sandboxed renderer.",
    },
  ],
  patterns: [{ group: ["node:*"], message: "Node modules do not exist in a sandboxed renderer." }],
};

// The main process renders nothing.
const MAIN_RESTRICTED_IMPORTS = {
  paths: [
    { name: "react", message: "The main process renders nothing; the interface lives in src/ui." },
    {
      name: "react-dom",
      message: "The main process renders nothing; the interface lives in src/ui.",
    },
  ],
};

export default defineConfig({
  test: {
    environment: "node",
    exclude: IGNORED,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
      ],
    },
  },
  fmt: {
    ignorePatterns: IGNORED,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: IGNORED,
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./tools/oxlint-plugin-t3code/index.ts"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "warn",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-extraneous-class": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unneeded-ternary": "error",
      "unicorn/no-useless-spread": "error",
      "unicorn/require-module-specifiers": "error",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "react-in-jsx-scope": "off",
      "t3code/namespace-node-imports": "error",
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "error",
      "t3code/no-low-value-comments": "error",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      "t3code/no-polling-loop-in-tests": "error",
      "t3code/no-real-time-wait-in-tests": "error",
      "t3code/no-test-in-loop": "error",
      "t3code/no-test-timeout-or-unreasoned-skip": "error",
      "t3code/no-unscoped-has": "error",
      "t3code/no-wall-clock-in-tests": "error",
      "t3code/prefer-catch-tags": "error",
      "t3code/prefer-effect-fn": "error",
      "t3code/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: ["**/*.test.{ts,tsx}", "**/{test,tests,testing,fixtures,e2e}/**"],
        rules: { "t3code/prefer-effect-fn": "off" },
      },
      {
        // Vendored unchanged from Lazurio/t3code, whose lint has no rule against `!`.
        files: ["tools/oxlint-plugin-t3code/**"],
        rules: { "typescript/no-non-null-assertion": "off" },
      },
      {
        // The one place that reads the host's platform and architecture.
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "t3code/no-global-process-runtime": "off" },
      },
      {
        files: ["apps/desktop/src/ui/**"],
        rules: {
          "eslint/no-restricted-imports": ["error", RENDERER_RESTRICTED_IMPORTS],
          "t3code/no-outset-state-indicators": "error",
        },
      },
      {
        files: ["apps/desktop/src/main/**"],
        rules: { "eslint/no-restricted-imports": ["error", MAIN_RESTRICTED_IMPORTS] },
      },
    ],
  },
});
