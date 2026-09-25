-- Embedded prototype/application feedback: sources, rotatable tokens, and the
-- two element-anchor extension tables. Purely additive — no existing column
-- changes type or nullability, and no existing row is rewritten.
--
-- Aurora DSQL: no foreign keys (relationMode="prisma", application-scoped
-- integrity), one DDL per statement, and every index is built with
-- CREATE INDEX ASYNC. There is deliberately no ASC/DESC on any index column —
-- DSQL's CREATE INDEX grammar has none.

CREATE TABLE IF NOT EXISTS "feedback_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  -- NULL = real application (submissions become feedback rows).
  -- Set = Artifact-backed prototype (submissions become comments).
  "artifact_id" UUID,
  "name" VARCHAR(255) NOT NULL,
  -- JSON array of exact origins. Never a pattern, never '*'.
  "allowed_origins" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" UUID
);

-- expires_at is nullable on purpose, matching api_keys.expires_at. A deployed
-- site's embed token has no natural expiry; revocation is the kill switch.
CREATE TABLE IF NOT EXISTS "feedback_source_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "feedback_source_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "token_prefix" VARCHAR(16) NOT NULL,
  "label" VARCHAR(255),
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" UUID,
  -- Compare-and-set rate-limit counters, same shape as research_sessions.
  "read_window_at" TIMESTAMP(3),
  "read_count" INTEGER,
  "submit_window_at" TIMESTAMP(3),
  "submit_count" INTEGER
);

CREATE TABLE IF NOT EXISTS "comment_element_anchors" (
  "comment_id" UUID NOT NULL PRIMARY KEY,
  -- Non-null by construction: written only for targetType=ARTIFACT comments,
  -- always equal to the parent comment's target_id.
  "artifact_id" UUID NOT NULL,
  "artifact_revision_id" UUID,
  "page_url" TEXT NOT NULL,
  "page_path" TEXT NOT NULL,
  "element_selector" TEXT,
  "element_fingerprint" JSONB,
  -- A Vercel Blob URL for the element screenshot the widget captured, or null.
  -- Purely an aid for a human reading the thread later ("what did they actually
  -- click"); nothing re-anchors from it. Capture is best-effort in the widget, so
  -- the overwhelmingly common case for internal review comments is null.
  "screenshot_url" TEXT
);

-- Created now, written in a later phase (the unbound/real-application path).
-- Separate from comment_element_anchors because a feedback row has no artifact.
CREATE TABLE IF NOT EXISTS "feedback_element_anchors" (
  "feedback_item_id" UUID NOT NULL PRIMARY KEY,
  "feedback_source_id" UUID NOT NULL,
  "page_url" TEXT NOT NULL,
  "page_path" TEXT NOT NULL,
  "element_selector" TEXT,
  "element_fingerprint" JSONB,
  -- Same column as on comment_element_anchors, so the two anchor shapes stay
  -- interchangeable when the unbound path starts writing here.
  "screenshot_url" TEXT
);

-- Identity for a comment whose author is not a Compass user, so author_id on
-- comments can stay a User reference and stay null for outside submitters.
CREATE TABLE IF NOT EXISTS "comment_external_authors" (
  "comment_id" UUID NOT NULL PRIMARY KEY,
  "submitter_email" VARCHAR(255),
  "portal_account_id" UUID,
  "embed_token_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "artifact_feedback_public" BOOLEAN DEFAULT false;

CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_sources_workspace" ON "feedback_sources" ("workspace_id", "enabled");
CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_sources_artifact" ON "feedback_sources" ("artifact_id");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_feedback_source_tokens_hash" ON "feedback_source_tokens" ("token_hash");
CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_source_tokens_source" ON "feedback_source_tokens" ("feedback_source_id", "revoked_at");
CREATE INDEX ASYNC IF NOT EXISTS "idx_comment_element_anchors_artifact_page" ON "comment_element_anchors" ("artifact_id", "page_url");
CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_element_anchors_source_page" ON "feedback_element_anchors" ("feedback_source_id", "page_url");
CREATE INDEX ASYNC IF NOT EXISTS "idx_comment_external_authors_account" ON "comment_external_authors" ("portal_account_id");

-- ── Widget visitor identity ───────────────────────────────────────────────────
--
-- A visitor who leaves anchored feedback from a prototype must be a verified
-- PortalAccount, but the widget runs on an origin Compass does not serve and
-- portal_sessions.token travels only as a SameSite=Lax cookie. The obvious
-- shortcut — hand the widget the portal session token as a bearer — would give
-- the prototype's JavaScript a credential that also authenticates that person to
-- the roadmap and feedback portal for 30 days. So the widget gets its own
-- credential instead: scoped to ONE feedback source, short-lived, and useless
-- anywhere else in the product.
CREATE TABLE IF NOT EXISTS "embed_visitor_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Scope. A session minted for one source must not authorize another, even for
  -- the same account, so this is checked against the presented embed token.
  "feedback_source_id" UUID NOT NULL,
  "portal_account_id" UUID NOT NULL,
  -- SHA-256 only, same as portal_sessions and feedback_source_tokens.
  "token_hash" VARCHAR(64) NOT NULL,
  -- NOT NULL, unlike feedback_source_tokens.expires_at. That column is nullable
  -- because a deployed site's embed token has no natural expiry; this one is the
  -- opposite case — it lives in a third party's page, so it must die on its own.
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3)
);

-- Server-brokered sign-in handoff: how a credential crosses from the first-party
-- popup (which has the portal cookie) to the widget (which cannot receive it).
--
-- Deliberately stores NOTHING CLAIMABLE. The deposit step records only that this
-- nonce entitles its bearer to a session for this account and this source; the
-- claim step mints the token and returns it once. A reader of this table — a
-- backup, a log, a support query — therefore gains nothing, which is not true of
-- the design this is ported from, where deposit persisted the raw token for the
-- length of the handoff window.
CREATE TABLE IF NOT EXISTS "embed_auth_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Knowledge of the nonce is the credential, so only its digest is stored.
  "nonce_hash" VARCHAR(64) NOT NULL,
  "feedback_source_id" UUID NOT NULL,
  "portal_account_id" UUID NOT NULL,
  -- Two minutes. Long enough to finish a magic-link login in a popup, short
  -- enough that an unclaimed row is not a standing liability.
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_embed_visitor_sessions_hash" ON "embed_visitor_sessions" ("token_hash");
CREATE INDEX ASYNC IF NOT EXISTS "idx_embed_visitor_sessions_scope" ON "embed_visitor_sessions" ("feedback_source_id", "portal_account_id");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_embed_auth_handoffs_nonce" ON "embed_auth_handoffs" ("nonce_hash");
CREATE INDEX ASYNC IF NOT EXISTS "idx_embed_auth_handoffs_expiry" ON "embed_auth_handoffs" ("expires_at");
