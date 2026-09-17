import { defineConfig, devices } from "@playwright/test";
import crypto from "node:crypto";

/**
 * Set E2E_FUNCTIONAL=1 to enable the functional test suite.
 * Without it (e.g., `pnpm test:e2e`), only the screenshots project runs,
 * preserving existing CI behaviour with no local server or DB required.
 */
const functional = !!process.env.E2E_FUNCTIONAL;

/**
 * Port for the functional suite's `pnpm dev` webServer.
 *
 * This used to be a hardcoded 3002. That's a real hazard in a repo that runs
 * many concurrent git worktrees (see pr-guidelines.md): locally,
 * `reuseExistingServer: !process.env.CI` is true, so if *any* process is
 * already listening on 3002 — most commonly another worktree's own
 * `pnpm dev` — Playwright silently attaches to that unrelated server
 * instead of starting its own. Tests then run against a different
 * worktree's code (and potentially a stale/incompatible build), producing
 * failures that have nothing to do with the change under test. This was
 * confirmed while investigating a "functional suite fails broadly" report:
 * one run surfaced a `Module not found: Can't resolve '@/auth'` Build Error
 * that belonged entirely to a different worktree's checkout.
 *
 * `E2E_PORT` still wins if set (e.g. to pin a fixed CI runner config), but
 * that requires a human/agent to remember to set it every time — the actual
 * bug report this fixes came from a run that didn't. So the *default* (no
 * `E2E_PORT`) now derives the port from a hash of the worktree path instead
 * of a fixed 3002: stable across repeated runs in the *same* worktree (so
 * `reuseExistingServer` still gets its intended fast-reuse benefit locally)
 * while giving concurrent worktrees distinct ports so they can never
 * collide by default. Range 4100-4899 stays clear of the 3000-3099 range
 * used by this project's `nextdev` worktree dev-server manager.
 */
function functionalPort(): number {
  const hash = crypto.createHash("md5").update(process.cwd()).digest();
  return 4100 + (hash.readUInt16BE(0) % 800);
}

const FUNCTIONAL_PORT = process.env.E2E_PORT
  ? Number(process.env.E2E_PORT)
  : functional
    ? functionalPort()
    : 3002;
const FUNCTIONAL_BASE_URL = `http://localhost:${FUNCTIONAL_PORT}`;
const VERCEL_AUTOMATION_BYPASS_SECRET =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  // 90-second per-test timeout for functional specs — server actions + router
  // revalidation in Next.js dev mode can be slow.  Screenshots tests are
  // page-load-only and finish in a few seconds so this is fine for both.
  timeout: 90_000,
  // Functional specs mutate one shared seeded workspace. Running them in
  // parallel creates cross-test races in portal auth, membership, and roadmap
  // settings, so serialize only that suite; screenshot captures stay parallel.
  //
  // NOTE: this only serializes *within* one run. Serializing *across*
  // concurrent runs (multiple agents, multiple worktrees) is handled by the
  // machine-wide lock in scripts/run-functional-e2e.mjs — see the comment
  // there. `workers: 1` alone does not prevent N simultaneous dev servers.
  workers: functional ? 1 : undefined,

  // This repo keeps many nested git worktrees, each a full checkout with its
  // own `e2e/` tree and (often) its own `node_modules` carrying a second copy
  // of Playwright. Any project whose testDir resolves to the repository root —
  // `screenshots` does, since it sets only testMatch — would otherwise walk
  // into them and collect duplicate specs, multiplying browser launches.
  // The `functional-setup` project already worked around this by narrowing its
  // testDir; ignore the directories globally so the next project that forgets
  // to narrow its own testDir cannot reintroduce the fan-out.
  testIgnore: [
    "**/node_modules/**",
    "**/.claude/worktrees/**",
    "**/.worktrees/**",
  ],

  ...(functional && {
    globalSetup: "./e2e/functional/global-setup.ts",
    globalTeardown: "./e2e/functional/global-teardown.ts",
    webServer: {
      command: "pnpm dev",
      // TCP can listen before Next has made the login route available.
      // Probe the actual auth entry point; a 404 must not admit the tests.
      url: `${FUNCTIONAL_BASE_URL}/login`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(FUNCTIONAL_PORT),
        COMPASS_RESEARCH_CAPTURE_ENABLED: "1",
        COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED: "1",
        // tasks-agent-assignment.spec.ts needs agent assignment live: without
        // this, eligibleTaskAssignees() (lib/task-assignment.ts) returns people
        // only, no agent option ever renders, and the spec hangs to timeout.
        COMPASS_AGENTS_ENABLED: "1",
        // Deterministic test-only key; production must provide its own secret.
        SSO_SECRET_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
      },
      timeout: 120_000,
    },
  }),

  projects: [
    // ── Functional suite ────────────────────────────────────────────────────
    // Auth setup runs first (depends: functional-setup), then specs.
    // Requires E2E_FUNCTIONAL=1 to activate webServer + globalSetup.
    {
      name: "functional-setup",
      // Scope discovery to the canonical suite. Searching from repository root
      // also finds auth.setup.ts files inside .claude/worktrees, whose separate
      // node_modules load Playwright a second time and abort the run.
      testDir: "./e2e/functional",
      testMatch: "auth.setup.ts",
      use: { baseURL: FUNCTIONAL_BASE_URL },
    },
    {
      name: "functional",
      testDir: "./e2e/functional/specs",
      use: {
        storageState: "e2e/functional/.auth/user.json",
        baseURL: FUNCTIONAL_BASE_URL,
      },
      dependencies: ["functional-setup"],
    },

    // ── Docs screenshots ─────────────────────────────────────────────────────
    // No local server needed — this hits an already-deployed URL. Defaults to
    // production, which holds the curated demo org (rb-code-labs/helios) that
    // e2e/screenshots.spec.ts's hardcoded page list expects; a fresh local
    // dev DB or a random preview deployment won't have that workspace.
    //
    // The previous default pointed at a long-merged feature branch's preview
    // deployment, which no longer resolves — `pnpm test:e2e` would hang for
    // ~20 minutes and then fail with no useful output. Override via
    // DOCS_BASE_URL to point at a preview deployment instead. Protected
    // deployments also require VERCEL_AUTOMATION_BYPASS_SECRET in the test
    // environment; public/local targets continue to work without it.
    {
      name: "screenshots",
      testMatch: "e2e/screenshots.spec.ts",
      ...(functional && { dependencies: ["functional-setup"] }),
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: process.env.DOCS_BASE_URL || (functional ? FUNCTIONAL_BASE_URL : "https://compass.rbcodelabs.com"),
        ...(VERCEL_AUTOMATION_BYPASS_SECRET && {
          extraHTTPHeaders: {
            "x-vercel-protection-bypass": VERCEL_AUTOMATION_BYPASS_SECRET,
          },
        }),
      },
    },
  ],
});
