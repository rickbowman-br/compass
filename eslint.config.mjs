import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local parallel-agent worktrees are complete nested checkouts and must
    // not be linted as part of this repository's source tree.
    ".claude/**",
    "coverage/**",
    // Vendored third-party builds, checked in because the embedded widget is a
    // plain <script src> on a page Compass does not serve and so cannot import
    // from node_modules (see the header of public/vendor/html-to-image.js).
    //
    // These are published, minified artifacts pinned by a sha256 recorded in each
    // file and asserted by __tests__/embed-vendor-html-to-image.test.ts. Linting
    // them reports on code nobody here can act on: a minified bundle trips
    // no-this-alias and 51 no-unused-expressions warnings purely by virtue of
    // being minified, and the only honest fix would be editing bytes we promise
    // are byte-identical to the upstream release.
    //
    // Deliberately `public/vendor/**` and not `public/**`. public/embed/widget.js
    // is our own hand-written source and must stay linted — when it was first
    // added the linter caught 14 real unused-binding warnings in it, which is
    // exactly the value this ignore is scoped to preserve.
    "public/vendor/**",
  ]),
  // React 19's advisory rule flags several established state-reset and
  // browser-storage synchronization effects. Keep these visible without
  // making unrelated legacy debt block the repository check.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Playwright fixtures use a callback named `use`; it is not a React hook.
  {
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["seed-screenshots.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
