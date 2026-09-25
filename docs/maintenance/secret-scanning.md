# Secret scanning

Compass is a public repository. Any credential committed to it — on any branch,
in any commit, however briefly — must be treated as burned and rotated. Three
independent layers guard against that.

| Layer | Scope | Blocking? | Where |
| --- | --- | --- | --- |
| Local pre-commit hook | Complete staged snapshot | Yes, when installed (bypassable) | `scripts/hooks/pre-commit` |
| CI secret scan | Complete staged snapshot and full fetched git history | Fails on findings/errors; require `gitleaks` in branch protection to block merges | `.github/workflows/secret-scan.yml` |
| GitHub push protection | Supported provider token patterns | When enabled, at push time | Repository settings |

These reduce accidental exposure; they cannot guarantee that every secret will
be detected. Local hooks are opt-in and can be bypassed with `--no-verify`.
GitHub Actions runs after pushing, so any real credential that reaches CI must
be revoked even when CI blocks the merge. Require the `gitleaks` check for `main`
in branch protection or a ruleset; a failing workflow alone does not prevent
merges. Review changes to scanner rules, ignore fingerprints, and the workflow.

## Enabling the local hook

The hook is opt-in and adds no npm dependency. It needs the gitleaks binary:

```bash
brew install gitleaks   # or see https://github.com/gitleaks/gitleaks
pnpm hooks:install
```

`pnpm hooks:install` points `core.hooksPath` at `scripts/hooks`. Undo with
`pnpm hooks:uninstall`. Once installed, the hook blocks commits if gitleaks is
missing or returns an error. CI installs the pinned scanner automatically.

The hook exports Git's index into a temporary directory and scans the entire
snapshot using its staged `.gitleaks.toml`. This catches multiline assignments,
including values added far below an existing header, and scans what will
actually be committed even when the working tree has different content. A
pre-existing secret still present in the snapshot also blocks unrelated commits.
Untracked files and unstaged edits are not included. The temporary copy is
removed when the hook exits. CI runs the same snapshot check before scanning
history, preserving both full-file context and detection of removed secrets.

To scan the full history yourself at any time:

```bash
pnpm scan:secrets
```

Run the scanner integration tests (Node 22 and gitleaks; no package install needed):

```bash
pnpm test:secret-scanning
# equivalent: node --test scripts/test-secret-scanning.mjs
```

CI runs these tests before scanning. They use disposable repositories and
runtime-generated synthetic values to test literals, safe environment references,
staged vs. unstaged content, missing/broken scanners, and historical exceptions.

## When the scan fails

**If it is a real secret**, the commit is the least of the problem:

1. Remove the value from the code.
2. **Rotate the credential.** Assume it is compromised the moment it is
   committed — rotation is not optional even if it was never pushed.
3. Store the new value in the agent harness *before* doing anything else with
   it, per the standing rule in `CLAUDE.md`.
4. If it was already pushed, the value remains in history after removal from
   current code. Verify revocation. History rewriting is optional after
   revocation and cannot erase existing forks or caches; do not force-push
   without coordinating with contributors.

**If it is a false positive**, apply the narrowest possible fix. In order of
preference:

1. A `gitleaks:allow` trailing comment on that one line.
2. A scoped entry in `.gitleaks.toml` that matches the exact value or the
   specific line shape.

Never disable a rule outright and never allowlist a whole directory. Doing
either blinds the scanner for all future code in that scope, which is how a
real secret eventually slips through.

## How `.gitleaks.toml` is structured

The config inherits the entire gitleaks default ruleset (`useDefault = true`)
and deliberately uses **no** `disabledRules`. Each known false positive is
allowlisted by its specific value or line shape, so the underlying rule stays
armed everywhere else:

- **`vercel-protection-bypass-literal`** — explicit bypass values in header
  objects, header setter calls, and curl headers, including multiline values.
- **`vercel-automation-bypass-assignment`** — explicit assignments to
  `VERCEL_AUTOMATION_BYPASS_SECRET`, `COMPASS_VERCEL_BYPASS_SECRET`, and
  `MCP_BYPASS_SECRET`. These two rules match literal token-shaped values of
  at least 16 characters without requiring high entropy. Environment references
  and empty values remain valid. Constructed/obfuscated values and unfamiliar
  secret formats may evade pattern-based detection.

- **`generic-api-key`** — test-fixture idempotency keys such as
  `idempotencyKey: "voice-hangup-0001"`. Scoped with `condition = "AND"` so it
  only applies to lines declaring an `idempotencyKey` inside `__tests__/` or
  `e2e/`. A real API key in a test file is still reported.
- **`private-key`** — the throwaway Ed25519 keypair in
  `e2e/functional/fixtures/native-policy-config.ts`, used only to sign policy
  fixtures in the functional suite. Allowlisted by its exact key material, not
  by path, so any *other* private key — including a different one added to that
  same file — is still reported.
- **`curl-auth-header`** — documentation placeholders matching
  `your_..._here`. A real token pasted into the docs is still reported.

When you change this config, verify both directions: that the intended false
positive goes quiet, **and** that a planted real secret in the same path is
still caught. A config that reports zero findings because it is blind is worse
than no config at all.

## Already revoked historical findings

`.gitleaksignore` acknowledges three exact findings of the revoked bypass
credential removed in PR #133. Each entry identifies the commit, path, rule,
and line; it contains no credential material. The values were verified in memory
against the revoked credential fingerprint before adding these entries.

Do not allowlist the credential value globally. A new occurrence of the same
value must still fail, whether staged locally or reintroduced in a later commit.
Integration tests verify this distinction. Only add a historical fingerprint
after confirming the credential is inactive, removed from current code, and the
exception does not excuse new occurrences.

## Upgrading gitleaks

The CI pin lives in `GITLEAKS_VERSION` in `.github/workflows/secret-scan.yml`.
Bump it there and re-run `pnpm scan:secrets` locally with the matching version
to confirm the ruleset change does not introduce new findings.
