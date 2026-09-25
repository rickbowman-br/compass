/**
 * Visitor identity for the embedded widget: a credential scoped to one feedback
 * source, and the server-brokered handoff that delivers it.
 *
 * ## Why not just use the portal session
 *
 * A widget visitor signs in exactly the way anyone signs into the public portal —
 * `lib/portal-auth.ts`, an emailed magic link, a `PortalAccount`. What the widget
 * receives afterwards is NOT that session, and the difference is the whole reason
 * this module exists.
 *
 * `portal_sessions.token` travels as a `SameSite=Lax` cookie, which by definition
 * never accompanies a cross-site `fetch`. The obvious workaround — hand the
 * widget the portal session token as a bearer instead — would put a credential
 * into the JavaScript of a page Compass does not control that also authenticates
 * that person to the roadmap and the feedback portal, for thirty days. A stray
 * analytics script on the prototype would be reading a portal login.
 *
 * So the widget gets its own credential: one source, one purpose, short-lived,
 * and worth nothing anywhere else in the product.
 *
 * ## How it crosses the origin boundary
 *
 * The sign-in popup runs on Compass's own origin, so it has the portal cookie and
 * the widget cannot read anything it returns. A nonce closes that gap:
 *
 *   1. The widget draws a nonce with `crypto.getRandomValues` and opens the popup
 *      with it in the URL. The nonce never has to travel back cross-origin,
 *      because the widget already knows it.
 *   2. The popup finishes the magic-link login and POSTs a *deposit*: "this nonce
 *      entitles its bearer to a session for this account and this source."
 *   3. The widget POSTs a *claim* with the same nonce and receives the token.
 *
 * Knowledge of the nonce is therefore the credential for step 3, which is sound
 * only because of four properties held together: the nonce is CSPRNG-drawn and
 * 32 bytes, only its digest is ever stored, the window is two minutes, and a
 * claim is single-use enforced by a conditional delete.
 *
 * `embed_auth_handoffs` deliberately holds **nothing claimable**: the token is
 * minted at claim time, not at deposit time. The design this is ported from
 * persisted the raw identity token for the length of the window, so reading that
 * table mid-handoff — a backup, a log, a support query — yielded a usable
 * credential. Reading this one yields a digest and a scope.
 *
 * ## Why not postMessage
 *
 * The prior art avoided `postMessage` because its widget could run on an opaque
 * origin (a sandboxed iframe, where `window.origin` is the string `"null"`),
 * leaving no origin to target and only the wildcard form deliverable — which
 * would broadcast an identity token to every listener on the page. Compass has no
 * opaque-origin case, so that argument does not transfer. The nonce is used here
 * for the separate reason that the token then never passes through the embedding
 * page's JavaScript environment on its way in, and the claim is auditable and
 * revocable as a row.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import getPrisma from "@/lib/db"
import type { PortalIdentity } from "@/lib/portal-auth"
import { EmbedSourceError } from "@/lib/embed-sources"

/**
 * Distinct from `cmpfb_` (the source's embed token) so the two can never be
 * confused at a boundary, and so a leaked credential is identifiable on sight.
 */
export const EMBED_VISITOR_TOKEN_PREFIX = "cmpvt_"

/**
 * Twelve hours: long enough to review a prototype across an afternoon without
 * signing in again, short enough that a token scraped out of someone else's page
 * is dead the same day. Not thirty days, which is what a portal session gets —
 * that lives in a first-party cookie, this lives in a third party's DOM.
 */
export const VISITOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Two minutes. Long enough to finish a magic-link login in a popup, short enough
 * that an unclaimed row is not a standing liability.
 */
export const HANDOFF_TTL_MS = 2 * 60 * 1000

/** 32 bytes as hex. The widget must produce exactly this shape. */
const NONCE_HEX_LENGTH = 64

export type MintedVisitorSession = {
  /** Returned exactly once. Only its SHA-256 is stored. */
  token: string
  expiresAt: Date
}

export function hashVisitorSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/**
 * Rejects anything that is not 32 bytes of hex, **before** the value reaches a
 * query.
 *
 * Both the deposit and the claim endpoint are reachable without a Compass
 * session, so without this gate a stranger could use either as a query generator
 * with arbitrary input. A well-formedness check is not a security boundary on its
 * own; it is what keeps the boundary from being the database.
 */
function assertWellFormedNonce(nonce: string): void {
  if (nonce.length !== NONCE_HEX_LENGTH || !/^[0-9a-f]+$/.test(nonce)) {
    throw new EmbedSourceError(400, "Malformed sign-in request.")
  }
}

/**
 * Mints a visitor session for one source. The raw token is returned once.
 *
 * Callers must have already established both arguments from trustworthy places:
 * `portalAccountId` from a verified portal session, `feedbackSourceId` from a
 * presented embed token — never from a sibling request parameter, which anyone
 * could set to any value while presenting a credential for something else.
 */
export async function mintEmbedVisitorSession(input: {
  feedbackSourceId: string
  portalAccountId: string
  now?: Date
}): Promise<MintedVisitorSession> {
  const now = input.now ?? new Date()
  const token = `${EMBED_VISITOR_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`
  const expiresAt = new Date(now.getTime() + VISITOR_SESSION_TTL_MS)
  await getPrisma().embedVisitorSession.create({
    data: {
      feedbackSourceId: input.feedbackSourceId,
      portalAccountId: input.portalAccountId,
      tokenHash: hashVisitorSecret(token),
      expiresAt,
    },
    select: { id: true },
  })
  return { token, expiresAt }
}

/**
 * Resolves a visitor token, but only for the source it was minted for.
 *
 * `feedbackSourceId` is not a convenience filter — it is the scope check. A token
 * minted for one prototype must not authorize writes through another, even for
 * the same signed-in person, because the embed token that names the source is
 * held by a different operator with a different origin allowlist.
 *
 * Returns null for every failure (unknown, revoked, expired, wrong source) so a
 * caller holding a bad credential learns only that it does not work. NOT
 * memoized with `cache()`, unlike the cookie path in lib/portal-auth.ts: there is
 * no per-request repetition to collapse here, since the widget presents the token
 * once per request.
 */
export async function resolveEmbedVisitorToken(
  rawToken: string,
  feedbackSourceId: string
): Promise<PortalIdentity | null> {
  if (!rawToken.startsWith(EMBED_VISITOR_TOKEN_PREFIX)) return null
  const tokenHash = hashVisitorSecret(rawToken)
  const row = await getPrisma().embedVisitorSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      feedbackSourceId: true,
      expiresAt: true,
      revokedAt: true,
      portalAccount: { select: { id: true, email: true, name: true } },
    },
  })
  if (!row || !digestsEqual(row.tokenHash, tokenHash)) return null
  if (row.feedbackSourceId !== feedbackSourceId) return null
  if (row.revokedAt) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  if (!row.portalAccount) return null

  // Best-effort, and swallowed for the same reason touchEmbedToken swallows its
  // own failure: under DSQL's Repeatable Read this write can lose a race (P2034),
  // and a working credential must not start 500ing because an observability
  // stamp did.
  try {
    await getPrisma().embedVisitorSession.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
  } catch {
    // ignored on purpose — see above
  }

  return {
    portalAccountId: row.portalAccount.id,
    email: row.portalAccount.email,
    name: row.portalAccount.name,
  }
}

/** Sign-out from the widget. Idempotent: an already-dead token is still a yes. */
export async function revokeEmbedVisitorToken(rawToken: string): Promise<void> {
  if (!rawToken.startsWith(EMBED_VISITOR_TOKEN_PREFIX)) return
  await getPrisma().embedVisitorSession.updateMany({
    where: { tokenHash: hashVisitorSecret(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/**
 * Records that a nonce entitles its bearer to a session for this account and
 * source. Called from the first-party popup, which holds a verified portal
 * session.
 *
 * Stores no token. See the module header for why that differs from the design
 * this is ported from.
 */
export async function depositEmbedAuthHandoff(input: {
  nonce: string
  feedbackSourceId: string
  portalAccountId: string
  now?: Date
}): Promise<void> {
  assertWellFormedNonce(input.nonce)
  const now = input.now ?? new Date()
  await getPrisma().embedAuthHandoff.create({
    data: {
      nonceHash: hashVisitorSecret(input.nonce),
      feedbackSourceId: input.feedbackSourceId,
      portalAccountId: input.portalAccountId,
      expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
    },
    select: { id: true },
  })
}

/**
 * Exchanges a nonce for a freshly minted visitor session, once.
 *
 * Single-use is enforced by a conditional delete rather than a flag: the delete
 * either matches one row or zero, so under DSQL's Repeatable Read two concurrent
 * claims cannot both proceed to mint. The delete happens BEFORE the mint, so a
 * mint that fails burns the nonce — the safe direction, since the visitor can
 * retry the popup but a replayable nonce cannot be un-leaked.
 *
 * Returns null on every failure, including an expired or already-claimed nonce
 * and a nonce deposited for a different source. The widget's recovery is the same
 * in all cases: sign in again.
 */
export async function claimEmbedAuthHandoff(input: {
  nonce: string
  feedbackSourceId: string
}): Promise<MintedVisitorSession | null> {
  assertWellFormedNonce(input.nonce)
  const prisma = getPrisma()
  const nonceHash = hashVisitorSecret(input.nonce)
  const row = await prisma.embedAuthHandoff.findUnique({
    where: { nonceHash },
    select: { id: true, nonceHash: true, feedbackSourceId: true, portalAccountId: true, expiresAt: true },
  })
  if (!row || !digestsEqual(row.nonceHash, nonceHash)) return null

  // Burn it regardless of whether it turns out to be usable: a nonce presented
  // for the wrong source, or after expiry, has been on the wire and should not
  // survive to be presented again.
  const burned = await prisma.embedAuthHandoff.deleteMany({ where: { id: row.id } })
  if (burned.count !== 1) return null

  if (row.feedbackSourceId !== input.feedbackSourceId) return null
  if (row.expiresAt.getTime() <= Date.now()) return null

  return mintEmbedVisitorSession({
    feedbackSourceId: row.feedbackSourceId,
    portalAccountId: row.portalAccountId,
  })
}
