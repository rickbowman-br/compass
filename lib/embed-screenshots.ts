/**
 * Element screenshots submitted through the embedded widget.
 *
 * The widget rasterises the element a visitor clicked and sends it here so a
 * reviewer reading the thread later can see what was actually clicked. It is
 * evidence for a person, never an input to re-anchoring — `elementSelector` and
 * `elementFingerprint` do that work, and a comment whose capture failed is a
 * perfectly good comment.
 *
 * ## Two boundaries, both load-bearing
 *
 * **Decoding** happens here rather than in the route so the byte cap is enforced
 * on the *decoded* length, not the base64 length. A caller that sends 400 KB of
 * base64 has sent 300 KB of image, and a cap applied to the wrong one of those is
 * a cap that does not mean what it says.
 *
 * **Validation** of a URL on the way back in is the less obvious half, and it is
 * the one that matters more. The widget uploads, receives a URL, and later
 * submits that URL alongside its comment — so the URL arrives from a page Compass
 * does not control, and an attacker can put anything in that field. It is then
 * rendered as an `<img>` to an internal reviewer. Left unchecked, the field is a
 * tracking pixel pointed at the organisation, or a way to make Compass's own UI
 * fetch an attacker's endpoint every time a thread is opened. So a submitted URL
 * is accepted only if it is HTTPS, on the Vercel Blob host, and under the prefix
 * this module writes to.
 */
import { put } from "@vercel/blob"

/**
 * 400 KiB decoded. The widget caps its own capture at 480px wide JPEG at quality
 * 0.7, which lands well under this; the headroom is for a wide element on a
 * high-DPR screen, not for a different kind of upload. Deliberately far below the
 * 10 MB the feedback-attachment path allows, because nobody chose to send this —
 * it is produced automatically by a click, so its ceiling should be the size of
 * the thing it is, not the size a person might pick.
 */
export const EMBED_SCREENSHOT_MAX_BYTES = 400 * 1024

/**
 * The base64 envelope the widget sends, plus slack for the JSON around it. Base64
 * inflates by 4/3, so this admits a shade over the decoded cap and no more; the
 * decoded check below is the real gate.
 */
export const EMBED_SCREENSHOT_MAX_BODY_BYTES = Math.ceil(EMBED_SCREENSHOT_MAX_BYTES * 1.4) + 1024

/**
 * Raster formats only, and only ones a browser canvas actually produces.
 *
 * SVG is absent on purpose and must stay absent: it is a document, it can carry
 * script and external references, and Vercel Blob serves it with its own content
 * type — so an SVG here would be stored-XSS on the blob host, reachable from a
 * link in an internal review UI. GIF is absent because `canvas.toBlob` does not
 * emit it, so a caller claiming GIF is a caller not using the documented path.
 */
export const EMBED_SCREENSHOT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const

export type EmbedScreenshotMimeType = (typeof EMBED_SCREENSHOT_MIME_TYPES)[number]

const MIME_EXTENSIONS: Record<EmbedScreenshotMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

/** Everything this module writes lives under here, and nothing else does. */
export const EMBED_SCREENSHOT_PREFIX = "embed-feedback"

export class EmbedScreenshotError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "EmbedScreenshotError"
  }
}

/**
 * Turns `data:image/jpeg;base64,…` into bytes, refusing everything else.
 *
 * The regex anchors both ends and allows no parameters between the media type and
 * `;base64`, so `data:image/jpeg;charset=…;base64,` and a bare `data:,` are both
 * rejected rather than coerced. Whitespace inside the payload is rejected too:
 * `Buffer.from(…, "base64")` silently skips characters it does not recognise, so
 * a permissive read here would decode successfully and quietly produce different
 * bytes than the caller sent.
 */
export function decodeEmbedScreenshot(dataUrl: unknown): { bytes: Buffer; fileType: EmbedScreenshotMimeType } {
  if (typeof dataUrl !== "string" || !dataUrl) {
    throw new EmbedScreenshotError(400, "A screenshot data URL is required.")
  }
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match) {
    throw new EmbedScreenshotError(400, "Screenshot must be a base64 image data URL.")
  }
  const fileType = match[1] as EmbedScreenshotMimeType
  if (!(EMBED_SCREENSHOT_MIME_TYPES as readonly string[]).includes(fileType)) {
    throw new EmbedScreenshotError(400, "Screenshot must be a PNG, JPEG, or WebP image.")
  }

  const base64 = match[2]
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  const expectedBytes = Math.floor((base64.length * 3) / 4) - padding
  // Checked before decoding, so an oversized payload never becomes an oversized
  // allocation.
  if (expectedBytes > EMBED_SCREENSHOT_MAX_BYTES) {
    throw new EmbedScreenshotError(413, "Screenshot is too large.")
  }

  const bytes = Buffer.from(base64, "base64")
  // The re-check is what makes the estimate above trustworthy: if the decoded
  // length disagrees, the input was not the base64 it appeared to be.
  if (bytes.length < 1 || bytes.length !== expectedBytes) {
    throw new EmbedScreenshotError(400, "Screenshot must be a base64 image data URL.")
  }
  return { bytes, fileType }
}

/**
 * Stores the capture and returns its public URL.
 *
 * The path is derived entirely from ids the server resolved — never from the
 * request — so a caller cannot choose where its bytes land or overwrite another
 * workspace's object. `addRandomSuffix` makes the object name unguessable, which
 * matters because blob objects are public: a reviewer opening a thread must be
 * able to load the image without a Compass session, and the compensating control
 * for that is that the URL cannot be enumerated.
 *
 * The returned URL therefore carries the workspace and source ids to a page
 * Compass does not control. That is accepted, not overlooked. They are opaque
 * cuids that authorize nothing by themselves — every route here derives its scope
 * from a presented credential rather than from an id in a URL, and this route in
 * particular ignores a caller-supplied `workspaceId` outright. It also matches
 * what the product already does: the portal's own attachment upload returns
 * `feedback/<workspaceId>/…` to a public portal client.
 */
export async function storeEmbedScreenshot(input: {
  workspaceId: string
  feedbackSourceId: string
  bytes: Buffer
  fileType: EmbedScreenshotMimeType
}): Promise<{ url: string }> {
  const extension = MIME_EXTENSIONS[input.fileType]
  const blob = await put(
    `${EMBED_SCREENSHOT_PREFIX}/${input.workspaceId}/${input.feedbackSourceId}/capture.${extension}`,
    input.bytes,
    { access: "public", addRandomSuffix: true, contentType: input.fileType }
  )
  return { url: blob.url }
}

/**
 * Whether a URL submitted alongside a comment is one this module produced.
 *
 * Three checks, each closing a different door. HTTPS rules out a plaintext fetch
 * from an internal page. The blob-host suffix rules out an arbitrary origin —
 * which is the tracking-pixel case, and the reason this function exists. The
 * prefix rules out a URL pointing at some other part of Compass's own blob store,
 * so a widget cannot use this field to surface, say, an artifact bundle or a
 * branding asset as though it were a screenshot of a click.
 *
 * Note what is deliberately NOT checked: that the object exists, or that it
 * belongs to the same workspace. Both would need a network round trip on every
 * submit, and neither buys much — the prefix already confines the field to
 * screenshots, and a URL naming a nonexistent object renders as a broken image
 * rather than as anything harmful.
 */
export function isEmbedScreenshotUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:") return false
    if (!parsed.hostname.endsWith(".public.blob.vercel-storage.com")) return false
    return parsed.pathname.startsWith(`/${EMBED_SCREENSHOT_PREFIX}/`)
  } catch {
    return false
  }
}
