import type { PoolClient } from "pg"

export const EMBED_FEEDBACK_TABLES = [
  "feedback_sources",
  "feedback_source_tokens",
  "comment_element_anchors",
  "feedback_element_anchors",
  "comment_external_authors",
  "embed_visitor_sessions",
  "embed_auth_handoffs",
]

export const EMBED_FEEDBACK_INDEXES = [
  "idx_feedback_sources_workspace",
  "idx_feedback_sources_artifact",
  "idx_feedback_source_tokens_hash",
  "idx_feedback_source_tokens_source",
  "idx_comment_element_anchors_artifact_page",
  "idx_feedback_element_anchors_source_page",
  "idx_comment_external_authors_account",
  "idx_embed_visitor_sessions_hash",
  "idx_embed_visitor_sessions_scope",
  "idx_embed_auth_handoffs_nonce",
  "idx_embed_auth_handoffs_expiry",
]

/**
 * Postcondition for 062_embed_feedback_sources.
 *
 * Nullability is asserted column by column rather than just presence, because
 * two of the nullability choices here are load-bearing and a silently-wrong one
 * would only surface much later:
 *
 * - `feedback_sources.artifact_id` MUST be nullable. Null is what makes a source
 *   a real application rather than a prototype; NOT NULL would delete the whole
 *   unbound path.
 * - `feedback_source_tokens.expires_at` MUST be nullable, matching
 *   `api_keys.expires_at`. A production embed token has no natural expiry, and
 *   revocation — not expiry — is its kill switch.
 * - `comment_element_anchors.artifact_id` MUST be NOT NULL. The anchor is only
 *   ever written for an ARTIFACT-target comment, so a null there means a writer
 *   bypassed that invariant.
 * - `embed_visitor_sessions.expires_at` MUST be NOT NULL — the opposite of the
 *   token column above, and deliberately so. That credential lives in an
 *   operator's deployment where revocation is the kill switch; this one lives in
 *   a third party's page, so its expiry has to be intrinsic. A nullable column
 *   here would let one row become a permanent credential on someone else's
 *   origin.
 * - `embed_visitor_sessions.feedback_source_id` and
 *   `embed_auth_handoffs.feedback_source_id` MUST be NOT NULL. They are what
 *   makes these credentials scoped; a null would be a session good for every
 *   source in the deployment.
 */
export async function assertEmbedFeedbackSourcesMigration(client: PoolClient, schema: string) {
  const expectedColumns = [
    { name: "feedback_sources.id", nullable: false },
    { name: "feedback_sources.workspace_id", nullable: false },
    { name: "feedback_sources.artifact_id", nullable: true },
    { name: "feedback_sources.name", nullable: false },
    { name: "feedback_sources.allowed_origins", nullable: false },
    { name: "feedback_sources.enabled", nullable: false },
    { name: "feedback_sources.created_at", nullable: false },
    { name: "feedback_sources.updated_at", nullable: false },
    { name: "feedback_sources.created_by_id", nullable: true },
    { name: "feedback_source_tokens.id", nullable: false },
    { name: "feedback_source_tokens.feedback_source_id", nullable: false },
    { name: "feedback_source_tokens.token_hash", nullable: false },
    { name: "feedback_source_tokens.token_prefix", nullable: false },
    { name: "feedback_source_tokens.label", nullable: true },
    { name: "feedback_source_tokens.expires_at", nullable: true },
    { name: "feedback_source_tokens.revoked_at", nullable: true },
    { name: "feedback_source_tokens.last_used_at", nullable: true },
    { name: "feedback_source_tokens.created_at", nullable: false },
    { name: "feedback_source_tokens.created_by_id", nullable: true },
    { name: "feedback_source_tokens.read_window_at", nullable: true },
    { name: "feedback_source_tokens.read_count", nullable: true },
    { name: "feedback_source_tokens.submit_window_at", nullable: true },
    { name: "feedback_source_tokens.submit_count", nullable: true },
    { name: "comment_element_anchors.comment_id", nullable: false },
    { name: "comment_element_anchors.artifact_id", nullable: false },
    { name: "comment_element_anchors.artifact_revision_id", nullable: true },
    { name: "comment_element_anchors.page_url", nullable: false },
    { name: "comment_element_anchors.page_path", nullable: false },
    { name: "comment_element_anchors.element_selector", nullable: true },
    { name: "comment_element_anchors.element_fingerprint", nullable: true },
    { name: "feedback_element_anchors.feedback_item_id", nullable: false },
    { name: "feedback_element_anchors.feedback_source_id", nullable: false },
    { name: "feedback_element_anchors.page_url", nullable: false },
    { name: "feedback_element_anchors.page_path", nullable: false },
    { name: "feedback_element_anchors.element_selector", nullable: true },
    { name: "feedback_element_anchors.element_fingerprint", nullable: true },
    { name: "comment_external_authors.comment_id", nullable: false },
    { name: "comment_external_authors.submitter_email", nullable: true },
    { name: "comment_external_authors.portal_account_id", nullable: true },
    { name: "comment_external_authors.embed_token_id", nullable: true },
    { name: "comment_external_authors.created_at", nullable: false },
    { name: "embed_visitor_sessions.id", nullable: false },
    { name: "embed_visitor_sessions.feedback_source_id", nullable: false },
    { name: "embed_visitor_sessions.portal_account_id", nullable: false },
    { name: "embed_visitor_sessions.token_hash", nullable: false },
    { name: "embed_visitor_sessions.expires_at", nullable: false },
    { name: "embed_visitor_sessions.revoked_at", nullable: true },
    { name: "embed_visitor_sessions.created_at", nullable: false },
    { name: "embed_visitor_sessions.last_used_at", nullable: true },
    { name: "embed_auth_handoffs.id", nullable: false },
    { name: "embed_auth_handoffs.nonce_hash", nullable: false },
    { name: "embed_auth_handoffs.feedback_source_id", nullable: false },
    { name: "embed_auth_handoffs.portal_account_id", nullable: false },
    { name: "embed_auth_handoffs.expires_at", nullable: false },
    { name: "embed_auth_handoffs.created_at", nullable: false },
  ]

  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, EMBED_FEEDBACK_TABLES]
  )
  for (const expected of expectedColumns) {
    const actual = columns.rows.find(row => `${row.table_name}.${row.column_name}` === expected.name)
    if (!actual || (actual.is_nullable === "YES") !== expected.nullable) {
      throw new Error(`062_embed_feedback_sources: column postcondition failed: ${expected.name}`)
    }
  }

  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, EMBED_FEEDBACK_TABLES]
  )
  const missing = EMBED_FEEDBACK_TABLES.filter(name => !tables.rows.some(row => row.table_name === name))
  if (missing.length > 0) throw new Error(`062_embed_feedback_sources: missing tables: ${missing.join(", ")}`)

  // The public-read flag on Workspace. Nullable Boolean, matching roadmapPublic.
  const flag = await client.query<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'workspaces' AND column_name = 'artifact_feedback_public'",
    [schema]
  )
  if (flag.rows[0]?.is_nullable !== "YES") {
    throw new Error("062_embed_feedback_sources: workspaces.artifact_feedback_public missing or not nullable")
  }

  const indexes = await client.query<{ name: string; valid: boolean; unique: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`,
    [schema, EMBED_FEEDBACK_INDEXES]
  )
  const unfinished = EMBED_FEEDBACK_INDEXES.filter(name => !indexes.rows.some(row => row.name === name && row.valid))
  if (unfinished.length > 0) {
    throw new Error(`062_embed_feedback_sources: missing or unfinished indexes: ${unfinished.join(", ")}`)
  }
  // Token lookup is by hash; without uniqueness two sources could share a
  // credential and the lookup would be non-deterministic.
  if (!indexes.rows.find(row => row.name === "idx_feedback_source_tokens_hash")?.unique) {
    throw new Error("062_embed_feedback_sources: idx_feedback_source_tokens_hash is not unique")
  }
  // Same argument for the two credentials a widget visitor presents. Without
  // uniqueness a hash collision — or a duplicate insert after a retried write —
  // resolves to an arbitrary row, and for the handoff that means a nonce could be
  // claimed more than once.
  for (const name of ["idx_embed_visitor_sessions_hash", "idx_embed_auth_handoffs_nonce"]) {
    if (!indexes.rows.find(row => row.name === name)?.unique) {
      throw new Error(`062_embed_feedback_sources: ${name} is not unique`)
    }
  }
}
