@AGENTS.md

# Compass — Project Notes

## Secrets

Every secret below is retrieved from **the agent harness**, which holds it in the OS
keychain and injects it as an environment variable. There is no external password
manager in this loop: if a value is not in the harness, **ask the operator for it
through the harness secret prompt** rather than going looking for it elsewhere.

- **`MIGRATION_SECRET`** (gates `/api/admin/migrate`, the admin DDL-execution endpoint): harness env var, per environment — `COMPASS_PRODUCTION_MIGRATION_SECRET` and `COMPASS_PREVIEW_MIGRATION_SECRET`.
  - **Production and preview are independent secrets.** Having one working tells you nothing about the other.
  - `checkAuth()` in the migrate route rejects an empty secret, so if the endpoint 401s unexpectedly, the overwhelmingly likely cause is that the value you sent is wrong or stale — not that the deployment's var is unset.
  - If the deployment's copy genuinely needs replacing: `vercel env rm MIGRATION_SECRET <env>` then `vercel env add MIGRATION_SECRET <env>` (no trailing newline), store the same value in the harness, then **redeploy** — env changes don't take effect until a fresh deployment.
  - Verify by hitting the live endpoint (GET status) with it. Never trust `vercel env pull`/`env ls` display.

- **`REPAIR_SECRET`** (gates `/api/admin/repair-workspace-memberships`, the one-time membership-backfill endpoint): harness env var.
  - Same trust boundary and same rotate-and-lose-it risk as `MIGRATION_SECRET` — it's a Vercel "sensitive" var, write-only once set.
  - Verify without mutating real data: `POST` with a garbage `orgSlug` (e.g. `__verify-probe__`) — a correct secret returns `404 "No org found with slug ..."`; a wrong/stale secret returns `401 Unauthorized`.

- **`COMPASS_VERCEL_BYPASS_SECRET`** — Vercel Deployment Protection bypass for this project's `*.vercel.app` preview and production URLs. Harness env var, like the rest.
  - Pass as the header `x-vercel-protection-bypass: $COMPASS_VERCEL_BYPASS_SECRET`. Without it, a protected preview answers **302 → `vercel.com/sso-api`** and nothing else works. Note that not every preview is protected — check with a plain request before assuming you need this.
  - It clears *Vercel's* SSO gate only — it is **not** app auth. NextAuth login is still required for any authenticated page.
  - Unlike the secrets above, this one is not consumed by the app at runtime, so there is nothing to redeploy after changing it.

**Storing a secret costs you the current session.** The harness writes to the keychain
immediately but injects env vars only into **newly started sessions** — a secret you
request now is *not* readable by `$VAR` in the session that asked for it. Verified:
requesting `COMPASS_PREVIEW_MIGRATION_SECRET` returned `success: true` while
`[ -n "$COMPASS_PREVIEW_MIGRATION_SECRET" ]` stayed false in the same session. So
request the secret *before* the work that needs it, and expect to resume in a fresh
session. Never work around this by passing the value inline on a command line.

**Standing rule:** the moment you rotate a value in Vercel, store it in the harness
*before* doing anything else with it — before testing, before the next step. A dropped
connection should never mean losing the value. Because Vercel's sensitive vars can't be
read back, a harness copy that no longer matches what's live is an incident: rotate
fresh, store immediately, redeploy, verify live.

### Reading a secret: the only correct order

Vercel env values are **write-only**. `vercel env pull` and `vercel env ls` will happily return a var as present-but-blank, and that tells you **nothing** about the value the running deployment actually has.

1. **The harness is the system of record. Look there FIRST** — `COMPASS_*` env vars. There is a **preview** secret as well as a prod one; don't assume only prod exists.
2. **If it isn't there, request it from the operator** via the harness secret prompt. Do not ask for a secret to be pasted into the conversation, and do not substitute direct database credentials.
3. **Verify a secret only by using it against the live endpoint** (authenticated `GET /api/admin/migrate`). Never by comparing pulled values or hashes.
4. **Never propose rotating a secret until you have confirmed the harness does not already hold a working value.** Rotation is destructive and needs a redeploy; it is close to never the right first move.

**Forbidden inference — this has already cost a session:** a blank/0-char value from `vercel env pull` is **not** evidence that the deployment's var is empty, and therefore **not** an explanation for a `401`. Concluding "the var is an empty string, so `checkAuth()` rejects everything" from pulled output is a fabricated diagnosis. The real cause of a `401` is almost always that *you* sent the wrong value. Retry with the harness value before theorising about infrastructure, and never propose an env-var rotation or a redeploy on the strength of a pulled blank.

**Second forbidden inference, same family:** a command that returns *nothing* is not a
finding. `vercel env ls` in an unlinked worktree prints an error, not an absence; an
unauthorized API call returns `{"error":…}`, and a naive `j.link ? … : "NOT LINKED"`
will report that as a fact about the project. Distinguish "no value" from "the request
failed" before reporting either.

Related: when checking whether a migration is applied, compare **exact names**, never substrings. `"051" in name` matches `051_pm_agent_handoff` as readily as `051_decision_task_bridge`. Note also that duplicate leading numbers are normal and accepted here (`main` carries two `049_*` migrations) because the runner keys on the exact name — a collision is not a bug to "fix", and branch previews share one `compass_preview` schema, so its applied list routinely contains migrations from branches other than yours.

## Production data migrations

Production schema and data maintenance runs through the registered migrations in `lib/migrations/runner.ts` and the authenticated `/api/admin/migrate` endpoint. Do not run local scripts directly against Aurora DSQL or use an AWS CLI login as an alternate production write path.

For a targeted migration: deploy the registered migration, use authenticated `GET /api/admin/migrate` to confirm the schema, manifest, preflight, and pending state, then `POST /api/admin/migrate` with `{"script":"<exact migration name>"}`. Do not omit `script` when unrelated migrations are pending. Afterward, repeat the status GET and perform application-level readback. A data migration must finish its postconditions before the runner records a successful receipt; reruns must be idempotent and safely resume unfinished work.

In the agent harness, retrieve the production migration credential as `COMPASS_PRODUCTION_MIGRATION_SECRET` and pass it only as the `x-migration-secret` header (for example by assigning it to `MIGRATION_SECRET` in the command environment). Never print it, persist it in a repository file, or substitute direct database credentials when it is unavailable.

## Portal SSO Identify — resyncing a drifted customer secret

A customer's SSO Identify integration signs JWTs with a shared secret that
Compass stores encrypted per-workspace (`Workspace.ssoSecretEncrypted`). That
raw value is shown to the customer **once**, at generation time in
Settings → Portal → SSO Identify — there's no way to look it up again later,
only regenerate.

If a customer reports `"This sign-in link is invalid, expired, or has an
invalid signature"`, and you've confirmed `SSO_SECRET_ENCRYPTION_KEY` decrypts
without throwing (i.e. it's a genuine secret mismatch, not a key/config
issue), use `POST /api/admin/portal-sso-resync` (gated by `MIGRATION_SECRET`,
same trust boundary as `/api/admin/migrate`) to force a fresh value
server-to-server without needing an interactive Settings login:

```bash
curl -s -X POST https://compass.rbcodelabs.com/api/admin/portal-sso-resync \
  -H "x-migration-secret: $MIGRATION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"orgSlug": "rbcodelabs", "workspaceSlug": "golden-wealth"}'
```

Returns `{ "rawSecret": "..." }` — that response is the only time this value
is ever visible again. Immediately update the customer's stored copy (env
var + password manager) and redeploy their app before the response is gone.
