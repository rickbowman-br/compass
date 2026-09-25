/**
 * Stores an element screenshot the widget captured, and returns its URL.
 *
 * Separate from /api/embed/comments rather than folded into it, for three
 * reasons. The comment route's body cap is 32 KB and must stay there — it is the
 * ceiling on a public JSON write, and raising it so an image could ride along
 * would widen the wrong endpoint. The widget's capture completes
 * asynchronously while the visitor is still typing, so uploading it then, rather
 * than at submit, is both faster for them and the only way a slow rasterise does
 * not delay the comment. And keeping it separate means the image path has its own
 * auditable blast radius: one method, one content type family, one hard byte cap,
 * one blob prefix.
 *
 * Authorization is the same four checks the submit path runs, in the same order —
 * embed token, origin allowlist, rate limit, scoped visitor token — and for the
 * same reason. This writes to durable storage on Compass's account, so it must
 * not be reachable by anyone who merely scraped an embed token off a page: the
 * visitor token means a real person signed in through the Compass origin and can
 * be named in the thread the capture will hang off.
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
import { resolveEmbedVisitorToken } from "@/lib/embed-visitor"
import {
  EMBED_SCREENSHOT_MAX_BODY_BYTES,
  EmbedScreenshotError,
  decodeEmbedScreenshot,
  storeEmbedScreenshot,
} from "@/lib/embed-screenshots"
import { EMBED_VISITOR_HEADER, embedCorsPreflight, embedError, embedJson, readBoundedEmbedBody } from "@/lib/embed/http"

const METHODS = "POST"

export async function OPTIONS() {
  return embedCorsPreflight(METHODS)
}

async function authorize(request: NextRequest): Promise<ResolvedEmbedSource> {
  const token = readEmbedBearer(request)
  if (!token) throw new EmbedSourceError(401, "Missing embed token")
  const source = await resolveEmbedToken(token)
  if (!isOriginAllowed(source.allowedOrigins, request.headers.get("origin"))) {
    throw new EmbedSourceError(403, "This origin is not allowed for this feedback source.")
  }
  return source
}

export async function POST(request: NextRequest) {
  try {
    const source = await authorize(request)
    // The write bucket, not the read bucket. This is a durable write, and one
    // capture accompanies at most one comment, so sharing the 20/min submit
    // ceiling with commenting is the right coupling rather than an unlucky one.
    await consumeEmbedRate(source.tokenId, "SUBMIT")

    // Before the body is read, so an unauthenticated caller cannot make this
    // server buffer 400 KB.
    const raw = request.headers.get(EMBED_VISITOR_HEADER)?.trim()
    const presented = raw?.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw
    const visitor = presented ? await resolveEmbedVisitorToken(presented, source.sourceId) : null
    if (!visitor) {
      return embedError(401, "Sign in required to leave feedback.", METHODS, undefined, "PORTAL_AUTH_REQUIRED")
    }

    let payload: unknown
    try {
      payload = JSON.parse(await readBoundedEmbedBody(request, EMBED_SCREENSHOT_MAX_BODY_BYTES))
    } catch {
      return embedError(413, "Screenshot payload is too large or not JSON.", METHODS)
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return embedError(400, "Request body must be a JSON object.", METHODS)
    }

    const { bytes, fileType } = decodeEmbedScreenshot((payload as Record<string, unknown>).dataUrl)
    const stored = await storeEmbedScreenshot({
      workspaceId: source.workspaceId,
      feedbackSourceId: source.sourceId,
      bytes,
      fileType,
    })

    void touchEmbedToken(source.tokenId)
    // Only the URL. The widget hands it back on the comment submit, where it is
    // re-validated rather than trusted — see isEmbedScreenshotUrl.
    return embedJson({ url: stored.url }, METHODS, 201)
  } catch (error) {
    if (error instanceof EmbedSourceError) {
      return embedError(error.status, error.message, METHODS, error.status === 429 ? { "Retry-After": "60" } : undefined)
    }
    if (error instanceof EmbedScreenshotError) {
      return embedError(error.status, error.message, METHODS)
    }
    throw error
  }
}
