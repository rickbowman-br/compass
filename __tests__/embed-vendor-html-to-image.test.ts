/**
 * Guards on public/vendor/html-to-image.js — the one third-party file the embedded
 * widget loads at runtime.
 *
 * ## Why this file needs tests at all
 *
 * This specific file is outside all three of the repo's automated gates, each for a
 * different reason worth stating precisely, because the obvious summary — "public/
 * isn't checked" — is false and believing it is how this test nearly didn't exist.
 *
 * - **ESLint does lint public/**, including plain `.js`; the `**\/*.{ts,tsx}` glob in
 *   eslint.config.mjs is a rule override for one React rule, not the config's scope.
 *   It is only this directory that escapes, via an explicit `public/vendor/**` entry
 *   in `globalIgnores` — a deliberate exemption for minified third-party bundles,
 *   not an accident of globbing. Its sibling public/embed/widget.js stays linted.
 * - **Typecheck** never sees it: tsconfig's `include` lists `.ts`, `.tsx` and `.mts`
 *   but no `.js` glob, and nothing in the program imports this file, so it is not
 *   part of the program at all despite `allowJs` being on.
 * - **The color gate** (scripts/check-ui-colors.mjs) walks only app/ and components/.
 *
 * So the coverage this file gets is the coverage written here and nowhere else.
 * These tests execute the real bytes off disk rather than a fixture, because a
 * fixture would keep passing while the shipped file rotted.
 *
 * ## The two properties worth pinning
 *
 * **Provenance.** The header comment makes a factual claim — that the region from
 * the UMD preamble to the sourceMappingURL is byte-identical to the published npm
 * dist, and hashes to a stated sha256. A reviewer of a public PR is entitled to
 * treat that claim as load-bearing, so it is checked here instead of trusted. What
 * this cannot do is confirm the value against npm without a network call, so the
 * test asserts the header does not lie about its own contents; re-pointing it at
 * the registry is the documented manual command in the header itself.
 *
 * **Branch selection.** This is the one that is easy to get wrong and silent when
 * wrong, which is why it is here. The upstream build is a UMD bundle: it looks for
 * CommonJS, then AMD, and only then defines `globalThis.htmlToImage`. The widget is
 * a plain `<script src>` on somebody else's prototype page, and a page carrying
 * RequireJS or a stray `module` shim sends the bundle down one of the first two
 * branches — where it registers as an anonymous module nobody consumes and the
 * global never appears. Element capture would then fail on exactly the aging pages
 * this feature exists to gather feedback on, with nothing in the console to say so.
 * The fix is a scope wrapper in the vendored file; these tests are what stop a
 * future re-vendor from dropping it.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const VENDOR_PATH = path.join(process.cwd(), "public", "vendor", "html-to-image.js");
const source = readFileSync(VENDOR_PATH, "utf8");

/** The upstream region: the UMD preamble through the sourceMappingURL comment. */
function vendoredRegion(): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("!function"));
  const end = lines.findIndex((line) => line.startsWith("//# sourceMappingURL"));
  expect(start, "UMD preamble not found — has the vendored body been replaced?").toBeGreaterThan(-1);
  expect(end, "sourceMappingURL not found — has the vendored body been replaced?").toBeGreaterThan(start);
  // Rejoined with a trailing newline, matching how `sed -n '/…/,/…/p' | shasum`
  // reads it, so the header's documented command and this test agree.
  return `${lines.slice(start, end + 1).join("\n")}\n`;
}

/**
 * Loads the vendored file the way a browser would, in a context seeded to look
 * like a particular kind of host page. Returns the resulting context so a caller
 * can assert on both the library and what happened to the page's own globals.
 */
function loadOnHostPage(globals: Record<string, unknown> = {}): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { ...globals };
  // A browser global object is self-referential through both of these, and the
  // UMD consults `self` in its fallback chain.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

/** An AMD loader, as RequireJS and friends leave one on the window. */
function amdLoader() {
  const define = function define() {
    (define as unknown as { called?: boolean }).called = true;
  };
  (define as unknown as { amd: Record<string, unknown> }).amd = { jQuery: true };
  return define;
}

describe("public/vendor/html-to-image.js — provenance", () => {
  it("contains the version and license the header claims", () => {
    expect(source).toContain("html-to-image v1.11.13");
    expect(source).toContain("MIT License");
    expect(source).toContain("https://github.com/bubkoo/html-to-image");
  });

  it("hashes to the sha256 its own header asserts", () => {
    // Read the expectation out of the header rather than duplicating the digest
    // here. The claim under test is "this header describes this file", and a second
    // copy of the constant in the test file would just be a third thing to keep in
    // sync — one that a careless re-vendor would update alongside the other two.
    const claimed = /^ \*\s+([0-9a-f]{64})$/m.exec(source)?.[1];
    expect(claimed, "the header no longer states a sha256 for the vendored region").toBeTruthy();
    const actual = createHash("sha256").update(vendoredRegion()).digest("hex");
    expect(actual).toBe(claimed);
  });

  it("keeps the library's bytes free of anything Compass added", () => {
    // The additions are meant to be the header comment and the wrapper, nothing
    // else. If a future edit reaches into the minified body, this is the assertion
    // that turns "byte-identical to npm" from a comment into a checked fact —
    // the hash above already covers it, but this names the failure clearly.
    const region = vendoredRegion();
    expect(region).not.toContain("Compass");
    expect(region).not.toContain("compass");
  });
});

describe("public/vendor/html-to-image.js — exposes the global the widget needs", () => {
  it("defines htmlToImage with the capture API on a plain page", () => {
    const page = loadOnHostPage();
    const lib = page.htmlToImage as Record<string, unknown> | undefined;
    expect(lib).toBeTypeOf("object");
    // toCanvas specifically, because that is what the widget calls: it crops the
    // result, so it needs pixels rather than the encoded image toJpeg returns.
    expect(lib?.toCanvas).toBeTypeOf("function");
  });

  it.each([
    ["an AMD loader", () => ({ define: amdLoader() })],
    ["a CommonJS module/exports shim", () => ({ module: { exports: {} }, exports: {} })],
    ["both at once", () => ({ define: amdLoader(), module: { exports: {} }, exports: {} })],
  ])("still defines the global on a page with %s", (_label, seed) => {
    // Without the scope wrapper in the vendored file, every one of these cases
    // leaves htmlToImage undefined and the widget loses element capture with no
    // error anywhere. This is the regression the wrapper exists to prevent.
    const lib = loadOnHostPage(seed()).htmlToImage as Record<string, unknown> | undefined;
    expect(lib).toBeTypeOf("object");
    expect(lib?.toCanvas).toBeTypeOf("function");
  });

  it("leaves the host page's own module system alone", () => {
    // The alternative fix was for the widget to delete window.define around the
    // script load and put it back afterwards. That races any other async script the
    // page is loading, so the shadowing happens inside the vendored file instead —
    // and this is the assertion that the containment actually holds.
    const define = amdLoader();
    const page = loadOnHostPage({ define, module: { exports: { marker: "host" } } });
    expect(page.define).toBe(define);
    expect((define as unknown as { called?: boolean }).called).toBeUndefined();
    expect((page.module as { exports: { marker?: string } }).exports.marker).toBe("host");
  });

  it("does not reach for a DOM at load time", () => {
    // Nothing in loadOnHostPage supplies `document`, and the tests above pass — so
    // the bundle's top level is inert and it is safe for the widget to load it
    // eagerly rather than deferring until the first capture. Stated as its own test
    // because it is a property of the library, not of our wrapper, and a future
    // version could quietly change it.
    expect(() => loadOnHostPage()).not.toThrow();
  });
});
