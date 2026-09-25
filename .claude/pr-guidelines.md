# PR Guidelines — Compass

## Quick-Reference Commands

| Task | Command |
|---|---|
| Type-check | `pnpm tsc --noEmit` |
| Unit tests | `pnpm test` |
| E2E screenshots | `pnpm test:e2e` |
| E2E functional | `pnpm test:e2e:functional` |
| Build | `pnpm build` |

## Branch Naming

- `fix/<slug>` for bug fixes
- `feat/<slug>` for new features
- `chore/<slug>` for non-user-facing changes (deps, config, tooling)

## Before Opening a PR

### 0. Sync with `main` first

This repo runs many concurrent worktrees/PRs — branches go stale fast (PR #49 landed 10 commits behind `main` and hit real merge conflicts across `schema.prisma`, layout files, and the MCP docs table because this step was skipped).

Before starting a feature and again right before opening the PR:

```bash
git fetch origin main
git rev-list --left-right --count origin/main...HEAD   # <ahead>  <behind>
```

If the branch is behind by more than a couple commits, merge main in **before** writing more code (small, early conflicts are far cheaper to resolve than a full feature's worth):

```bash
git merge origin/main --no-edit
```

When resolving conflicts, be suspicious of any conflict where two branches added props/fields with the **same surrounding text** (e.g. two components both taking `orgSlug`/`workspaceSlug`/`workspaceName` as their first props) — git's diff can misalign and attach one branch's new lines to the wrong JSX tag or function. Re-read the resolved file, don't just trust that the merge tool aligned things correctly. Re-run the full verification suite (tests, typecheck, build, E2E) *after* resolving conflicts, not just before — a clean merge can still break typecheck (e.g. a prop moved to the wrong component).

### 1. Unit and Integration Tests

```bash
pnpm test
```

Runs Vitest in non-watch mode. All tests must pass. Tests live alongside source files — do not skip or mark as pending to make the suite pass. New tools and routes must have unit tests in `__tests__/`.

### 2. TypeScript

```bash
pnpm tsc --noEmit
```

Must produce no errors. `any` casts require a comment explaining why.

### 3. Build

```bash
pnpm build
```

Run before opening a PR to catch type errors and build failures that `tsc` alone might miss.

### 4. E2E Tests

There are two separate Playwright suites:

**Screenshots**:
```bash
pnpm test:e2e
```
Saves PNGs to `public/screenshots/docs/`. No assertions — its only job is keeping docs screenshots current. Run (or manually update the screenshot) whenever a UI page visibly changes. Pages are hardcoded to the `rbcodelabs/compass` org/workspace in `e2e/screenshots.spec.ts` — keep that slug pair in sync if the demo workspace is ever renamed again (it drifted once already: `rb-code-labs/helios` → `rbcodelabs/compass`, breaking this suite silently for a long time).

Defaults `DOCS_BASE_URL` to production (`compass.rbcodelabs.com`), so running it with no overrides doesn't need a local server. But most pages require auth and there's no way to pass real production credentials from an agent session — for actually regenerating screenshots (e.g. after a settings UI change), run against local dev with seeded demo data instead:

```bash
# 1. Start a local dev server against local Postgres (.env.local already points there)
# 2. Seed realistic demo content for rbcodelabs/compass (idempotent):
DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass node seed-screenshots.ts
# 3. Capture a real session as rick@rbcodelabs.com (the UI's Dev Login button
#    hardcodes dev@localhost.dev, so this hits the NextAuth endpoint directly):
BASE_URL=http://localhost:<port> LOGIN_EMAIL=rick@rbcodelabs.com \
  OUT_FILE=/tmp/dev-session.json node e2e/capture-dev-session.ts
# 4. Run against local with that session:
DOCS_BASE_URL=http://localhost:<port> DOCS_SESSION_FILE=/tmp/dev-session.json pnpm test:e2e
```

Review every regenerated screenshot before committing — an unauthenticated or mis-seeded run silently captures a login-redirect page or empty/broken content instead of failing loudly.

**Functional** (requires local Podman Postgres + dev server):
```bash
# Auto-starts dev server on port 3002, seeds e2e-test-org, runs assertions, teardown:
pnpm test:e2e:functional

# Keep DB state for post-failure inspection:
E2E_SKIP_TEARDOWN=1 pnpm test:e2e:functional
```
Covers OKRs, Discovery→Roadmap, Experiments, and Portal flows with real DB mutations. Run when a PR touches any of these journeys. Requires `.env.local` in the worktree and local Podman Postgres running.

**New journeys require new specs.** A PR that introduces a new user-facing flow (new section, new entity lifecycle, new portal surface) must add a functional spec in `e2e/functional/specs/` covering that journey — running the existing suite green is not sufficient.

**Suites live in:**
- `e2e/screenshots.spec.ts` — docs screenshots
- `e2e/functional/specs/` — functional journeys (OKRs, Discovery, Experiments, Portal)
- `e2e/functional/global-setup.ts` / `global-teardown.ts` — DB seed + cleanup

## Visual Verification

Any PR that touches UI components must be checked at both breakpoints:

- **Desktop** (`md+` breakpoint, 768px+ / 1280×800): sidebar visible, workspace dropdown, nav links, user area.
- **Mobile** (below `md` / 390×844 iPhone 14): bottom nav and mobile header visible, sidebar hidden.

Use browser DevTools device emulation or resize to verify. Screenshot both breakpoints for UI-only changes.

## Deployment

Vercel creates a preview deployment automatically for each PR branch. Before requesting review:

1. Confirm the PR is actually mergeable — do not rely on eyeballing the diff:
   ```bash
   gh pr view <N> --json mergeable,mergeStateStatus
   ```
   Must read `"mergeable":"MERGEABLE"`. `"CONFLICTING"` means resolve now (see "Sync with main first" above) — don't report the PR as done with unresolved conflicts. `mergeStateStatus` of `UNSTABLE` just means CI/deploy checks are still running; wait and re-check rather than treating it as a conflict.
2. Wait for the preview URL to appear in the PR.
3. Smoke-test the primary user flows in the preview (login, workspace nav, at least one data view).
4. Note the preview URL in the PR description.

### Production deployment (after merge to main)

**Claude handles this — the user does not run these steps manually.**

After a PR merges to main and Vercel deploys to production:

1. **Wait for the production deploy** — poll `gh run list --branch main --limit 3` or check the Vercel dashboard. Production URL: `https://compass.rbcodelabs.com`.

2. **Run any registered schema or data migration** listed in the PR description through the authenticated migration endpoint. Check status first, then target the exact migration so unrelated pending work is not applied:
   ```bash
   curl -s https://compass.rbcodelabs.com/api/admin/migrate \
     -H "x-migration-secret: $COMPASS_PRODUCTION_MIGRATION_SECRET"
   curl -s -X POST https://compass.rbcodelabs.com/api/admin/migrate \
     -H "x-migration-secret: $COMPASS_PRODUCTION_MIGRATION_SECRET" \
     -H "content-type: application/json" \
     -d '{"script":"<migration-name>"}'
   ```
   Repeat the status GET and perform application-level readback. Check the PR body for a "Migration required" section; if none is listed, skip this step. Never run a local script directly against production DSQL.

   **If `prisma/schema.prisma` or `prisma/migrations/` changed in this PR**, first confirm `MIGRATION_SECRET` actually works in the target environment — do not assume it does just because it exists:
   ```bash
   vercel curl /api/admin/migrate --deployment <prod-or-preview-url> -- --header "x-migration-secret: $SECRET"
   ```
   A `{"error":"Unauthorized"}` response (or a Prisma `TableDoesNotExist` error when hitting the new feature) means the secret is missing or stale **for that specific environment** — production and preview are independent, and having it set up for one tells you nothing about the other. This has bitten twice on the same PR (#35 shipped with an unusable `MIGRATION_SECRET` on both preview and production). Because it's a Vercel "sensitive" env var, it is **write-only** — if the value isn't already held by the agent harness, it cannot be recovered and must be rotated: generate a new one, `vercel env rm` / `vercel env add --sensitive` for that environment, store it in the harness **immediately** (before testing — a dropped connection mid-test shouldn't mean losing it again), redeploy, then re-run the status check above.

3. **Smoke-test production** using `agent-browser`:
   - Log in at `https://compass.rbcodelabs.com/login`
   - Exercise the primary flows touched by the PR (e.g. if docs changed, open a doc and verify formatting)
   - Verify no 500s or console errors on the affected pages
   - Take a screenshot as evidence

4. **Report back** with: deploy URL, migration result (if applicable), and smoke-test outcome. If anything is broken, open a fix PR immediately.

## Database Migrations

If `prisma/schema.prisma` changes, add the corresponding DSQL-compatible SQL under `prisma/migrations/<number>_<name>/migration.sql` and register it in `lib/migrations/runner.ts`. The schema file is not the deployment mechanism. Validate locally through the same runner used by `/api/admin/migrate`; production and preview apply the registered migration through that authenticated endpoint.

- Do **not** use `prisma db push`, `prisma migrate dev`, or `prisma migrate deploy` as the production deployment path.
- Never use `@default(autoincrement())` or `CREATE TYPE` in schema changes.
- Confirm migration manifest parity, DSQL schema compatibility, runner execution, and postconditions before opening the PR.

### DSQL Gotchas (all of these have bitten before)

- **No `@updatedAt` triggers.** DSQL cannot auto-update timestamps. Every `update` call must set `updatedAt: new Date()` explicitly.
- **No cascade deletes.** `relationMode = "prisma"` means the DB enforces nothing. Deleting a parent requires explicitly nulling or deleting child references in application code (see squad deletion for the established pattern).
- **Indexes are async.** New indexes on non-empty tables use `CREATE INDEX ASYNC` semantics — the runner must wait or expose resumable status, and verification must confirm the index exists before enabling the feature.

### Data migrations

Any change that reshapes **existing data** (renaming, splitting, re-linking, or repairing rows) requires a registered data migration. Use SQL in the migration file when it is sufficient, or a runner hook for bounded logic that SQL cannot safely express:

- Packaged with an exact migration name and invoked only by `lib/migrations/runner.ts` before its receipt is marked finished. Do not add a separate production database CLI.
- **Idempotent** — safe to run twice without duplicating or corrupting data.
- **Fail closed with postconditions** — a partial or invalid repair leaves an unfinished forensic attempt and must not receive a successful migration receipt.
- **Tested through the migration runner** against an isolated local schema with real data before the PR is opened; note the observed result in the PR body.
- The PR description must include a **"Migration required"** section naming the registered migration, the exact targeted POST, verification/readback, and a one-line rollback or recovery note.

## MCP Tools

Every new MCP tool must have unit tests in `__tests__/`. Handlers should be extracted into `lib/` for testability (e.g., `lib/feedback-tool-handlers.ts`).

- **Read/write symmetry.** Shipping a `create_*` tool without matching `list_*`/`get_*` and an update path is a known failure mode (it happened with workspaces, roadmap items, and feedback — three separate dogfood reports). Every new entity exposed over MCP gets the full set: create, list, get, update.
- **Consistent response format.** Every mutation response includes the entity ID on its own line, formatted exactly `ID: <uuid>` (plain, no bold). Agents parse these responses; formatting drift breaks them.
- **Docs.** Every new or changed tool must be reflected in `docs/content/09-mcp-api.md` in the same PR.

## Docs Review

User-facing docs live in `docs/content/` (rendered at `/help/[slug]`).

- Any PR that changes user-facing behavior must update the related doc page(s).
- Entirely new features get a new doc page.
- New MCP tools: update `docs/content/09-mcp-api.md` (see above) **and** flag in the PR description that the Compass SKILL.md tool catalog (`~/.claude/skills/compass/SKILL.md`) needs a matching update — stale skill docs have caused real agent failures before.

## Code Patterns

- **Data fetching**: use async server components. Call `getPrisma()` from `lib/db.ts` — never import `PrismaClient` directly.
- **Client components**: add `"use client"` only when the component needs browser APIs, event handlers, or React hooks. Data fetching belongs in the server layer.
- **Scripts**: TypeScript/Node.js only. Node v22.6+ runs `.ts` files natively with a `#!/usr/bin/env node` shebang — no compilation step. No Python scripts.
- **Styling**: Tailwind utility classes driven by the semantic tokens in `app/globals.css` — see `docs/design/ui-system.md`. Navigation chrome (sidebar, mobile header, bottom nav) is paper-toned via the `sidebar-*` roles; do not reintroduce `slate-950`/`slate-900`/`slate-50` literals. Follow existing patterns in `components/`.

## Tracking

No Linear integration — track work in Compass itself.
