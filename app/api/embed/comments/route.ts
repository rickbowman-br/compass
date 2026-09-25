/**
 * The embedded feedback widget's only endpoint.
 *
 * Reachable without a Compass session (see lib/route-access.ts) and called by
 * `fetch` from a page Compass does not serve, so every failure below is a JSON
 * status and never a redirect.
 *
 * Three independent checks gate every request, in this order:
 *
 *   1. **Embed token** — `Authorization: Bearer cmpfb_…`, hashed and looked up.
 *      No cookie is read and none would arrive (`SameSite=Lax`, and
 *      `Access-Control-Allow-Credentials` is never set).
 *   2. **Origin allowlist** — the request's `Origin` must appear verbatim in the
 *      source's allowlist. This is the check that limits a leaked token to the
 *      pages it was issued for; the wildcard CORS header does NOT do that and
 *      must not be mistaken for it.
 *   3. **Rate limit** — per token, per minute, compare-and-set.
 *
 * ## Reading is open; writing is not
 *
 * Reading is additionally gated on `Workspace.artifactFeedbackPublic` and needs
 * no identity: anyone holding the page can read the thread. **Submitting
 * additionally requires a verified portal identity** — a fourth check, presented
 * in the `X-Compass-Visitor` header as the scoped visitor token from
 * lib/embed-visitor.ts and resolved back to a `PortalAccount`.
 *
 * That token, and not the portal session cookie, for two reasons. The cookie is
 * `SameSite=Lax` and so never accompanies this cross-site `fetch` — but the
 * reason it is not simply re-sent as a bearer instead is that a portal session
 * authenticates its holder to the roadmap and the feedback portal for thirty
 * days, and this credential ends up in the JavaScript of a page Compass does not
 * control. The visitor token authorizes one thing: commenting through this one
 * source.
 *
 * The embed token is not an identity and must not be read as one. It says *this
 * page may talk to this feedback source*; it says nothing about who is typing,
 * and every visitor to a prototype page shares it. Accepting a free-text name
 * alongside it — which this route did in its first draft — produces a thread
 * whose every author is unverifiable, and attributes comments to whoever the
 * submitter claimed to be. The prior art this feature comes from shipped exactly
 * that, then deliberately deleted the name field for exactly this reason.
 *
 * So `Comment.authorName` here is derived server-side from the resolved account
 * and no caller-supplied name or email is read. Anonymous *reading* is the
 * feature; anonymous *writing* was never part of it.
 */
import type { NextRequest } from "next/server"
import getPrisma from "@/lib/db"
import { createComment, type ElementAnchorInput } from "@/lib/comments"
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
import { isEmbedScreenshotUrl } from "@/lib/embed-screenshots"
import type { PortalIdentity } from "@/lib/portal-auth"
import { EMBED_VISITOR_HEADER, embedCorsPreflight, embedError, embedJson, readBoundedEmbedBody } from "@/lib/embed/http"

const METHODS = "GET, POST"

/** Long enough for a paragraph of feedback, short enough to bound a public write. */
const MAX_BODY_LENGTH = 4000
const MAX_URL_LENGTH = 2048
const MAX_SELECTOR_LENGTH = 1000

export async function OPTIONS() {
  return embedCorsPreflight(METHODS)
}

type Authorized = { source: ResolvedEmbedSource }

/**
 * Runs checks 1 and 2. Rate limiting is left to the caller so a read and a write
 * can draw on separate counters.
 */
async function authorize(request: NextRequest): Promise<Authorized> {
  const token = readEmbedBearer(request)
  if (!token) throw new EmbedSourceError(401, "Missing embed token")
  const source = await resolveEmbedToken(token)
  if (!isOriginAllowed(source.allowedOrigins, request.headers.get("origin"))) {
    // Deliberately the same message whether the Origin was absent, malformed, or
    // simply not on the list. A caller learns only that this page may not use
    // this token.
    throw new EmbedSourceError(403, "This origin is not allowed for this feedback source.")
  }
  return { source }
}

function errorResponse(error: unknown) {
  if (error instanceof EmbedSourceError) {
    return embedError(error.status, error.message, METHODS, error.status === 429 ? { "Retry-After": "60" } : undefined)
  }
  throw error
}

type AnchorRow = {
  pageUrl: string
  pagePath: string
  elementSelector: string | null
  elementFingerprint: unknown
  screenshotUrl: string | null
}

type CommentRow = {
  id: string
  parentId: string | null
  body: string
  status: string
  authorName: string
  source: string
  createdAt: Date
  updatedAt: Date
  elementAnchor: AnchorRow | null
}

/**
 * The public shape. Deliberately narrow: no `authorId`, no `submitterEmail`, no
 * token id, no workspace id. A reader of a published thread sees the display name
 * the submitter chose and nothing that identifies them further.
 *
 * Written out as a named type rather than inferred, because `toDto` is recursive
 * through `replies` and TypeScript cannot infer a return type for that.
 */
export type EmbedCommentDto = {
  id: string
  body: string
  status: string
  authorName: string
  source: string
  createdAt: string
  updatedAt: string
  edited: boolean
  anchor: {
    pageUrl: string
    pagePath: string
    elementSelector: string | null
    elementFingerprint: unknown
    /**
     * Included in the public read shape on purpose. The thread is readable by
     * anyone holding the page, and this image is a picture of that same page — so
     * it discloses nothing the reader cannot already see, and withholding it
     * would leave a commenter unable to see the evidence attached to their own
     * comment.
     */
    screenshotUrl: string | null
  } | null
  replies: EmbedCommentDto[]
}

function toDto(row: CommentRow, replies: CommentRow[] = []): EmbedCommentDto {
  return {
    id: row.id,
    body: row.body,
    status: row.status,
    authorName: row.authorName,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    edited: row.updatedAt.getTime() - row.createdAt.getTime() > 1000,
    anchor: row.elementAnchor
      ? {
          pageUrl: row.elementAnchor.pageUrl,
          pagePath: row.elementAnchor.pagePath,
          elementSelector: row.elementAnchor.elementSelector,
          elementFingerprint: row.elementAnchor.elementFingerprint ?? null,
          screenshotUrl: row.elementAnchor.screenshotUrl,
        }
      : null,
    replies: replies.map((reply) => toDto(reply)),
  }
}

export async function GET(request: NextRequest) {
  try {
    const { source } = await authorize(request)
    await consumeEmbedRate(source.tokenId, "READ")

    const prisma = getPrisma()
    const workspace = await prisma.workspace.findUnique({
      where: { id: source.workspaceId },
      select: { artifactFeedbackPublic: true },
    })
    if (!workspace?.artifactFeedbackPublic) {
      return embedError(403, "Feedback on this workspace's artifacts is not publicly readable.", METHODS)
    }

    // An absent pagePath means "every page of this prototype", which is what a
    // dashboard view of the widget's own comments wants.
    const pagePath = request.nextUrl.searchParams.get("pagePath")
    const rows = (await prisma.comment.findMany({
      where: {
        workspaceId: source.workspaceId,
        targetType: "ARTIFACT",
        targetId: source.artifactId,
        // `is`/`isNot` rather than a bare object: elementAnchor is an optional
        // to-one relation, same shape as the solutionPlanProposal filter in
        // lib/comment-browser.ts. The filter is also what keeps internal review
        // comments — which carry no anchor — out of a published thread.
        ...(pagePath ? { elementAnchor: { is: { pagePath } } } : { elementAnchor: { isNot: null } }),
      },
      select: {
        id: true, parentId: true, body: true, status: true, authorName: true, source: true,
        createdAt: true, updatedAt: true,
        elementAnchor: { select: { pageUrl: true, pagePath: true, elementSelector: true, elementFingerprint: true, screenshotUrl: true } },
      },
      orderBy: { createdAt: "asc" },
    })) as CommentRow[]

    // Replies carry no anchor of their own, so they are fetched by parent rather
    // than caught by the anchor filter above.
    const rootIds = rows.filter((row) => !row.parentId).map((row) => row.id)
    const replies = rootIds.length
      ? ((await prisma.comment.findMany({
          where: { workspaceId: source.workspaceId, parentId: { in: rootIds } },
          select: {
            id: true, parentId: true, body: true, status: true, authorName: true, source: true,
            createdAt: true, updatedAt: true,
            elementAnchor: { select: { pageUrl: true, pagePath: true, elementSelector: true, elementFingerprint: true, screenshotUrl: true } },
          },
          orderBy: { createdAt: "asc" },
        })) as CommentRow[])
      : []

    const byParent = new Map<string, CommentRow[]>()
    for (const reply of replies) {
      if (!reply.parentId) continue
      const bucket = byParent.get(reply.parentId) ?? []
      bucket.push(reply)
      byParent.set(reply.parentId, bucket)
    }

    void touchEmbedToken(source.tokenId)
    return embedJson(
      {
        artifactId: source.artifactId,
        comments: rows.filter((row) => !row.parentId).map((row) => toDto(row, byParent.get(row.id) ?? [])),
      },
      METHODS
    )
  } catch (error) {
    return errorResponse(error)
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

/**
 * Resolves the writer from the `X-Compass-Visitor` scoped visitor token.
 *
 * `source.sourceId` is passed as the scope, not as a filter. A visitor token
 * minted through one prototype must not authorize writes through another, even
 * for the same signed-in person — the two prototypes are different deployments
 * with different origin allowlists, and the embed token presented alongside is
 * what names which one this is. Deriving the scope from the resolved embed token
 * rather than from a request parameter is what makes that check meaningful.
 *
 * Deliberately tolerant of a `Bearer ` prefix: the widget holds two bearer-ish
 * credentials and sending this one in the shape of the other is the obvious
 * mistake. Whitespace-only, unknown, expired, revoked, and out-of-scope tokens
 * are all indistinguishable from absent, so a caller learns only that it is not
 * signed in here.
 */
async function readVisitor(request: NextRequest, source: ResolvedEmbedSource): Promise<PortalIdentity | null> {
  const raw = request.headers.get(EMBED_VISITOR_HEADER)?.trim()
  if (!raw) return null
  const token = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw
  if (!token) return null
  return resolveEmbedVisitorToken(token, source.sourceId)
}

function fingerprint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const num = (key: string) => (typeof input[key] === "number" && Number.isFinite(input[key]) ? (input[key] as number) : undefined)
  const str = (key: string, max: number) => (typeof input[key] === "string" ? (input[key] as string).slice(0, max) : undefined)
  // Rebuilt field by field rather than passed through, so an embedding page
  // cannot use the JSON column as arbitrary storage.
  return {
    tag: str("tag", 40),
    text: str("text", 200),
    rectXRatio: num("rectXRatio"),
    rectYRatio: num("rectYRatio"),
    rectWRatio: num("rectWRatio"),
    rectHRatio: num("rectHRatio"),
  }
}

export async function POST(request: NextRequest) {
  try {
    const { source } = await authorize(request)
    // Before the body is parsed: an unauthenticated writer must not be able to
    // make this server do work by sending one.
    await consumeEmbedRate(source.tokenId, "SUBMIT")

    // Identity is checked before the body too, and for the same reason. The
    // `code` is what tells the widget to open the sign-in flow rather than
    // showing the visitor a dead end.
    const visitor = await readVisitor(request, source)
    if (!visitor) {
      return embedError(
        401,
        "Sign in required to leave feedback.",
        METHODS,
        undefined,
        "PORTAL_AUTH_REQUIRED"
      )
    }

    let payload: unknown
    try {
      payload = JSON.parse(await readBoundedEmbedBody(request))
    } catch {
      return embedError(400, "Request body must be JSON and under 32 KB.", METHODS)
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return embedError(400, "Request body must be a JSON object.", METHODS)
    }
    const input = payload as Record<string, unknown>

    const body = text(input.body, MAX_BODY_LENGTH)
    if (!body) return embedError(400, `Comment body is required and must be at most ${MAX_BODY_LENGTH} characters.`, METHODS)

    const parentId = text(input.parentId, 64)

    // Only a root comment carries an anchor; a reply inherits its parent's.
    let elementAnchor: ElementAnchorInput | undefined
    if (!parentId) {
      const pageUrl = text(input.pageUrl, MAX_URL_LENGTH)
      const pagePath = text(input.pagePath, MAX_URL_LENGTH)
      if (!pageUrl || !pagePath) return embedError(400, "pageUrl and pagePath are required.", METHODS)
      elementAnchor = {
        pageUrl,
        pagePath,
        elementSelector: text(input.elementSelector, MAX_SELECTOR_LENGTH),
        elementFingerprint: fingerprint(input.elementFingerprint),
        artifactRevisionId: text(input.artifactRevisionId, 64),
        // Validated, not trusted. The widget obtained this URL from
        // /api/embed/screenshot, but it arrives here from a page Compass does not
        // control, and it will be rendered as an image to an internal reviewer —
        // so anything that is not a blob URL under the embed prefix is dropped
        // rather than rejected. Dropped, because a comment is worth keeping even
        // when its decoration is not.
        screenshotUrl: isEmbedScreenshotUrl(input.screenshotUrl) ? input.screenshotUrl : null,
      }
    }

    const comment = await createComment({
      workspaceId: source.workspaceId,
      targetType: "ARTIFACT",
      targetId: source.artifactId,
      parentId,
      body,
      source: "WIDGET",
      // Null on purpose: the submitter is not a Compass User. Their identity, if
      // any, lives on CommentExternalAuthor.
      authorId: null,
      // Server-derived from the verified account, never from the request. A
      // `submitterName` in the body is ignored rather than rejected, matching how
      // lib/comments' own callers treat a caller-supplied author.
      authorName: visitor.name ?? visitor.email,
      authorType: "HUMAN",
      elementAnchor,
      externalAuthor: {
        submitterEmail: visitor.email,
        portalAccountId: visitor.portalAccountId,
        embedTokenId: source.tokenId,
      },
    })

    void touchEmbedToken(source.tokenId)
    // Only the id and timestamp: the widget does not need the stored row back,
    // and echoing it would re-expose fields the read path deliberately omits.
    return embedJson(
      { comment: comment ? { id: comment.id, createdAt: comment.createdAt.toISOString() } : null },
      METHODS,
      201
    )
  } catch (error) {
    if (error instanceof EmbedSourceError) return errorResponse(error)
    // createComment signals its own invariants (unknown target, cross-workspace
    // target, reply depth, anchor placement) with a plain `new Error`. Matching on
    // `name === "Error"` keeps that mapping narrow: a Prisma error, a TypeError,
    // or anything else with its own name still reaches the platform as a 500
    // rather than being reported to the caller as their mistake.
    if (error instanceof Error && error.name === "Error") {
      return embedError(400, error.message, METHODS)
    }
    throw error
  }
}
