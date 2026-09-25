/**
 * Shared HTTP plumbing for the embed endpoints: CORS, bounded body reading, and
 * JSON error shaping.
 *
 * ## Why `Access-Control-Allow-Origin: *` is correct here too
 *
 * This mirrors the argument in lib/oauth/http.ts, and the same three facts hold.
 * The embed endpoints consult no cookie and no Auth.js session; their only
 * credential is an `Authorization: Bearer cmpfb_…` header the embedding page
 * supplies deliberately. `Access-Control-Allow-Credentials` is never set, so a
 * browser will not attach a Compass session cookie to these requests even for a
 * reader who happens to be logged in — and Compass's session cookie is
 * `SameSite=Lax`, so it would not travel cross-site regardless.
 *
 * A wildcard therefore grants an attacker page exactly what it could already get
 * from its own server with `fetch`: nothing, unless it also holds a valid embed
 * token.
 *
 * The origin allowlist is NOT enforced by these headers, and must not be
 * confused with them. CORS is a browser-side read restriction; the allowlist is
 * a server-side authorization check performed in the route handler against the
 * `Origin` header, and it is what actually stops a stolen token from being used
 * from an arbitrary page. Reflecting the allowlist into
 * `Access-Control-Allow-Origin` would make the two look like one control and
 * would give a `curl` caller — which sends no `Origin` at all — a false sense of
 * being blocked.
 */
import { NextResponse } from "next/server"

/**
 * Carries the visitor's scoped visitor token (`cmpvt_…`) on an embed request.
 *
 * A second, separate credential from the `Authorization: Bearer cmpfb_…` embed
 * token, and the two answer different questions: the embed token says *this page
 * may talk to this feedback source*, and this header says *who is writing*.
 * Neither substitutes for the other, which is why they are not merged into one.
 *
 * It is a header rather than a cookie because PORTAL_SESSION_COOKIE is
 * `SameSite=Lax` and these endpoints never set
 * `Access-Control-Allow-Credentials`. Note that what travels here is NOT that
 * cookie's value re-sent as a bearer — see lib/embed-visitor.ts for why a
 * separate, narrower credential is minted instead.
 */
export const EMBED_VISITOR_HEADER = "X-Compass-Visitor"

export const EMBED_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  // The visitor header must be listed or the browser's preflight rejects it
  // before the request is ever sent.
  "Access-Control-Allow-Headers": `Authorization, Content-Type, ${EMBED_VISITOR_HEADER}`,
  "Access-Control-Max-Age": "86400",
}

/** Embed responses are per-token and must never be shared by a cache. */
export const EMBED_NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
}

export function embedCorsPreflight(methods: string): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...EMBED_CORS_HEADERS, "Access-Control-Allow-Methods": `${methods}, OPTIONS` },
  })
}

/** Adds CORS + no-store to an already-built response. */
export function withEmbedCors(response: NextResponse, methods: string): NextResponse {
  for (const [key, value] of Object.entries({ ...EMBED_CORS_HEADERS, ...EMBED_NO_STORE_HEADERS })) {
    response.headers.set(key, value)
  }
  response.headers.set("Access-Control-Allow-Methods", `${methods}, OPTIONS`)
  return response
}

/**
 * `code` is for the failures a widget must *act* on rather than merely display —
 * chiefly PORTAL_AUTH_REQUIRED, which tells it to open the sign-in flow instead
 * of showing the visitor an error. Matching the shape the portal feedback route
 * already returns for the same condition.
 */
export function embedError(
  status: number,
  message: string,
  methods: string,
  extraHeaders?: Record<string, string>,
  code?: string
): NextResponse {
  const response = NextResponse.json(code ? { error: message, code } : { error: message }, { status, headers: extraHeaders })
  return withEmbedCors(response, methods)
}

export function embedJson(body: unknown, methods: string, status = 200): NextResponse {
  return withEmbedCors(NextResponse.json(body, { status }), methods)
}

/** Caps how much of an embed request body this server will buffer. */
export const MAX_EMBED_BODY_BYTES = 32 * 1024

/**
 * Reads at most {@link MAX_EMBED_BODY_BYTES}, then stops. Same reasoning as
 * readBoundedBody in lib/oauth/http.ts: these routes are reachable without a
 * Compass session, so none of them may buffer an unbounded body.
 *
 * `limit` exists for the screenshot endpoint, whose payload is a base64 image and
 * so is legitimately larger than a comment. It is a per-route ceiling rather than
 * a raised global one: every other embed route should keep the 32 KB cap, and a
 * single shared constant large enough for an image would have silently widened
 * all of them.
 */
export async function readBoundedEmbedBody(request: Request, limit = MAX_EMBED_BODY_BYTES): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) {
        await reader.cancel()
        throw new Error("Body too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString("utf8")
}
