/**
 * The widget's visitor session: claim one, check one, end one.
 *
 * Three methods, one credential pair, and a deliberate asymmetry between them.
 * Every request here presents the source's embed token (`Authorization: Bearer
 * cmpfb_…`) and is checked against the source's origin allowlist, exactly like
 * /api/embed/comments. What varies is the second credential:
 *
 *   - **POST** presents a handoff nonce and receives a scoped visitor token. This
 *     is the only endpoint that mints one.
 *   - **GET** presents a visitor token and reports whose it is, so a widget that
 *     found one in storage can render a signed-in state without guessing whether
 *     it still works.
 *   - **DELETE** presents a visitor token and revokes it. Sign-out.
 *
 * ## Why this is unauthenticated, and why that is safe
 *
 * Nothing here reads a cookie, and no cookie would arrive: the caller is
 * JavaScript on a page Compass does not serve, PORTAL_SESSION_COOKIE is
 * `SameSite=Lax`, and these responses never set
 * `Access-Control-Allow-Credentials`. A caller's authority comes entirely from
 * what it presents in headers and body.
 *
 * The nonce is what makes POST safe to leave open. It is 32 CSPRNG bytes that
 * only ever existed in one widget instance and in the popup URL that instance
 * opened; it is stored hashed; it is single-use by conditional delete; it lives
 * two minutes; and a claim is scoped to the source it was deposited for, so a
 * nonce from one prototype cannot be redeemed through another's token. Guessing
 * one inside its window is a 2^256 search, and the popup page that carries it
 * sends `Referrer-Policy: no-referrer` for exactly this reason (next.config.ts).
 *
 * ## Why the minted token comes back in a response body rather than a cookie
 *
 * A cookie set here would be a third-party cookie on the prototype's page —
 * blocked outright by default in Safari and Firefox, and being removed in
 * Chrome. The widget therefore holds the token itself and presents it in
 * `X-Compass-Visitor`. That is also why the token is scoped and short-lived
 * rather than being the portal session re-sent: see lib/embed-visitor.ts.
 */
import type { NextRequest } from "next/server"
import {
  EmbedSourceError,
  consumeEmbedRate,
  isOriginAllowed,
  readEmbedBearer,
  resolveEmbedToken,
  touchEmbedToken,
  type ResolvedEmbedSource,
} from "@/lib/embed-sources"
import {
  claimEmbedAuthHandoff,
  resolveEmbedVisitorToken,
  revokeEmbedVisitorToken,
  EMBED_VISITOR_TOKEN_PREFIX,
} from "@/lib/embed-visitor"
import { EMBED_VISITOR_HEADER, embedCorsPreflight, embedError, embedJson, readBoundedEmbedBody } from "@/lib/embed/http"

const METHODS = "GET, POST, DELETE"

export async function OPTIONS() {
  return embedCorsPreflight(METHODS)
}

/**
 * Embed token + origin allowlist, the same two checks /api/embed/comments runs
 * and in the same order. Rate limiting is charged by each handler rather than
 * here, because what a handler costs differs per method.
 */
async function authorize(request: NextRequest): Promise<ResolvedEmbedSource> {
  const token = readEmbedBearer(request)
  if (!token) throw new EmbedSourceError(401, "Missing embed token")
  const source = await resolveEmbedToken(token)
  if (!isOriginAllowed(source.allowedOrigins, request.headers.get("origin"))) {
    throw new EmbedSourceError(403, "This origin is not allowed for this feedback source.")
  }
  return source
}

function errorResponse(error: unknown) {
  if (error instanceof EmbedSourceError) {
    return embedError(error.status, error.message, METHODS, error.status === 429 ? { "Retry-After": "60" } : undefined)
  }
  throw error
}

/**
 * Reads the visitor token from its header, tolerating a `Bearer ` prefix for the
 * same reason /api/embed/comments does: the widget carries two bearer-ish
 * credentials and shaping this one like the other is the obvious slip.
 */
function readVisitorHeader(request: NextRequest): string | null {
  const raw = request.headers.get(EMBED_VISITOR_HEADER)?.trim()
  if (!raw) return null
  const token = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw
  return token || null
}

/**
 * Reports who a stored visitor token belongs to.
 *
 * A widget that finds a token in storage has no way to know whether it expired,
 * was revoked from another tab, or was minted for a different source — so rather
 * than have it present the token to a submit and discover the answer by having a
 * comment rejected, it asks here first.
 *
 * `{ signedIn: false }` with a 200 for every failure, on purpose. An absent
 * token, a malformed one, an expired one, one revoked elsewhere, and one minted
 * for another source are all the same answer to the only question the widget is
 * asking, and the recovery is identical: offer to sign in. A 401 would invite a
 * widget to treat "not signed in yet" as an error state.
 */
export async function GET(request: NextRequest) {
  try {
    const source = await authorize(request)
    await consumeEmbedRate(source.tokenId, "READ")

    const token = readVisitorHeader(request)
    const identity = token ? await resolveEmbedVisitorToken(token, source.sourceId) : null
    if (!identity) return embedJson({ signedIn: false }, METHODS)

    void touchEmbedToken(source.tokenId)
    // The email and display name, and nothing else. No portalAccountId: the
    // widget has no use for an internal identifier, and this response is
    // readable by every script on the embedding page.
    return embedJson({ signedIn: true, email: identity.email, name: identity.name }, METHODS)
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * Exchanges a handoff nonce for a scoped visitor token.
 *
 * Metered on the read bucket rather than the write bucket even though it writes.
 * A bad nonce costs one indexed lookup, and the widget polls this endpoint while
 * the visitor is away reading their email — charging the 20/min submit quota for
 * that would leave them signed in and unable to comment, which is precisely
 * backwards. The 120/min read ceiling is what bounds a stranger hammering it with
 * invented nonces.
 */
export async function POST(request: NextRequest) {
  try {
    const source = await authorize(request)
    await consumeEmbedRate(source.tokenId, "READ")

    let payload: unknown
    try {
      payload = JSON.parse(await readBoundedEmbedBody(request))
    } catch {
      return embedError(400, "Request body must be JSON and under 32 KB.", METHODS)
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return embedError(400, "Request body must be a JSON object.", METHODS)
    }
    const nonce = (payload as Record<string, unknown>).nonce
    if (typeof nonce !== "string") {
      return embedError(400, "Malformed sign-in request.", METHODS)
    }

    // The source id comes from the resolved embed token, never from the body.
    // That is the check that keeps a nonce deposited through one prototype from
    // being redeemed through another's widget.
    const minted = await claimEmbedAuthHandoff({ nonce, feedbackSourceId: source.sourceId })
    if (!minted) {
      // Unknown, already claimed, expired, or deposited for another source — one
      // message for all four. The widget's recovery is the same in every case,
      // and distinguishing them would tell a guesser which guesses were closer.
      return embedError(401, "This sign-in has expired. Please sign in again.", METHODS, undefined, "PORTAL_AUTH_REQUIRED")
    }

    // A second round trip to name the account, rather than plumbing an identity
    // back out of the mint. It reuses the same scope check the submit path runs,
    // so the widget is told it is signed in only if the token it just received
    // actually resolves through this source.
    const identity = await resolveEmbedVisitorToken(minted.token, source.sourceId)
    if (!identity) {
      // Only reachable if the session was revoked between mint and read. Treated
      // as a failed sign-in rather than returning a token with no name attached.
      return embedError(401, "This sign-in has expired. Please sign in again.", METHODS, undefined, "PORTAL_AUTH_REQUIRED")
    }

    void touchEmbedToken(source.tokenId)
    return embedJson(
      {
        // Returned exactly once; only its hash is stored. The widget keeps it and
        // presents it in X-Compass-Visitor from here on.
        token: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
        email: identity.email,
        name: identity.name,
      },
      METHODS,
      201
    )
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * Sign-out. Idempotent, and deliberately incurious: a token that was already
 * revoked, has expired, or was minted for another source all produce the same
 * success, because in every case the caller's request — stop honouring this —
 * holds afterward. Reporting which of those it was would make sign-out an oracle
 * for whether a given token had ever been live.
 *
 * Note this revokes only the visitor session, not the portal session on the
 * Compass origin. Signing out of the widget must not sign the visitor out of the
 * roadmap portal in another tab, which is a second reason the widget holds its
 * own narrow credential rather than the portal cookie.
 */
export async function DELETE(request: NextRequest) {
  try {
    const source = await authorize(request)
    await consumeEmbedRate(source.tokenId, "READ")

    const token = readVisitorHeader(request)
    // The prefix check keeps an arbitrary string out of a hash-and-update. The
    // library re-checks it; this one keeps the work off the database.
    if (token?.startsWith(EMBED_VISITOR_TOKEN_PREFIX)) {
      await revokeEmbedVisitorToken(token)
    }

    // The same shape GET returns, so a widget can feed either response through
    // one code path to arrive at its signed-out state.
    return embedJson({ signedIn: false }, METHODS)
  } catch (error) {
    return errorResponse(error)
  }
}
