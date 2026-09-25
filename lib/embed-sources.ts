/**
 * Feedback sources and their embed tokens: the credential and origin boundary
 * for feedback submitted from a page Compass does not serve.
 *
 * ## The routing rule, stated once
 *
 * `FeedbackSource.artifactId` decides where a submission lands, and it is a
 * property of the stored source row — never of the request, the token, or the
 * widget's payload. A bound source (artifactId set) produces `Comment` rows with
 * `targetType: "ARTIFACT"`. An unbound source (artifactId null) is a real
 * application and will produce `FeedbackItem` rows; that path is not built yet
 * and {@link resolveEmbedToken} rejects unbound sources with a 501 rather than
 * quietly doing something else.
 *
 * ## Why a source and a token are two tables
 *
 * A deployed site has to be able to rotate its credential without losing its
 * origin allowlist, its artifact binding, or the comments already filed against
 * it. Mint a second token, deploy, revoke the first.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import getPrisma from "@/lib/db"

/** Errors carry the HTTP status the embed route should return. */
export class EmbedSourceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = "EmbedSourceError"
  }
}

export const EMBED_TOKEN_PREFIX = "cmpfb_"

/** Per-token, per-minute ceilings. Reads are cheap; writes create rows. */
export const MAX_EMBED_READS_PER_MINUTE = 120
export const MAX_EMBED_SUBMITS_PER_MINUTE = 20

export type MintedEmbedToken = { token: string; tokenId: string; tokenPrefix: string }

export type ResolvedEmbedSource = {
  tokenId: string
  sourceId: string
  workspaceId: string
  /** Non-null for a bound (prototype) source. See the routing rule above. */
  artifactId: string
  allowedOrigins: string[]
}

export function hashEmbedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Mints a token for an existing source. The raw token is returned exactly once
 * and never stored — only its SHA-256 is. Same construction as
 * lib/agent-mcp-key.ts, with a distinct human-readable prefix so a leaked
 * credential is identifiable on sight.
 */
export async function mintEmbedToken(input: {
  feedbackSourceId: string
  label?: string | null
  expiresAt?: Date | null
  createdById?: string | null
}): Promise<MintedEmbedToken> {
  const randomPart = randomBytes(16).toString("hex")
  const token = `${EMBED_TOKEN_PREFIX}${randomPart}`
  const tokenPrefix = randomPart.slice(0, 8)
  const row = await getPrisma().feedbackSourceToken.create({
    data: {
      feedbackSourceId: input.feedbackSourceId,
      tokenHash: hashEmbedToken(token),
      tokenPrefix,
      label: input.label ?? null,
      expiresAt: input.expiresAt ?? null,
      createdById: input.createdById ?? null,
    },
    select: { id: true },
  })
  return { token, tokenId: row.id, tokenPrefix }
}

/** Revocation is the kill switch — `expiresAt` is optional by design. */
export async function revokeEmbedToken(tokenId: string): Promise<boolean> {
  const updated = await getPrisma().feedbackSourceToken.updateMany({
    where: { id: tokenId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return updated.count === 1
}

/**
 * Reads a bearer credential out of an `Authorization` header.
 *
 * Returns null rather than throwing so the caller decides whether a missing
 * credential is a 401 or simply an anonymous read.
 */
export function readEmbedBearer(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  if (!token || !token.startsWith(EMBED_TOKEN_PREFIX)) return null
  return token
}

/**
 * Compares two hex digests without leaking a match position through timing.
 *
 * The database lookup is already by exact hash, so this is belt-and-braces for
 * the equality that follows it — but the lookup is the thing an attacker can
 * batch, and a constant-time confirm costs nothing.
 */
function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

function parseAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
}

/**
 * Resolves a raw embed token to its source, or throws with the status to return.
 *
 * Every rejection below is a 401/403/501 and never a redirect: the caller is a
 * `fetch` from someone else's page, and an HTML login page would be unreadable
 * to it.
 */
export async function resolveEmbedToken(rawToken: string): Promise<ResolvedEmbedSource> {
  const tokenHash = hashEmbedToken(rawToken)
  const row = await getPrisma().feedbackSourceToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      expiresAt: true,
      revokedAt: true,
      feedbackSource: {
        select: { id: true, workspaceId: true, artifactId: true, enabled: true, allowedOrigins: true },
      },
    },
  })
  // Same message and status for "no such token", "revoked", and "expired" — a
  // caller holding a bad credential learns only that it does not work.
  if (!row || !hashesEqual(row.tokenHash, tokenHash)) throw new EmbedSourceError(401, "Invalid embed token")
  if (row.revokedAt) throw new EmbedSourceError(401, "Invalid embed token")
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw new EmbedSourceError(401, "Invalid embed token")

  const source = row.feedbackSource
  if (!source || !source.enabled) throw new EmbedSourceError(403, "Feedback source is disabled")
  if (!source.artifactId) {
    // Unbound sources are real applications. The schema supports them so this
    // does not have to change later, but nothing writes FeedbackItem rows from
    // an embed yet, and inventing a destination here would be worse than a
    // clear refusal.
    throw new EmbedSourceError(501, "This feedback source is not bound to an artifact.")
  }

  return {
    tokenId: row.id,
    sourceId: source.id,
    workspaceId: source.workspaceId,
    artifactId: source.artifactId,
    allowedOrigins: parseAllowedOrigins(source.allowedOrigins),
  }
}

/**
 * Exact-match origin check.
 *
 * No patterns, no suffix matching, no wildcard. `https://evil-example.com` must
 * not pass a check written for `https://example.com`, and the cheapest way to
 * guarantee that is never to implement matching at all. An empty allowlist
 * accepts nothing.
 */
export function isOriginAllowed(allowedOrigins: string[], origin: string | null): boolean {
  if (!origin) return false
  return allowedOrigins.includes(origin)
}

/** Raised for input a human typed, so the message is safe to show them. */
export class EmbedOriginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmbedOriginError"
  }
}

/** A generous ceiling on how many sites one source may be embedded on. */
export const MAX_ALLOWED_ORIGINS = 20

/**
 * Canonicalizes one operator-typed origin, or throws {@link EmbedOriginError}.
 *
 * {@link isOriginAllowed} is an exact string comparison, which is only as strong
 * as what got stored — `https://example.com/` (with the trailing slash a browser
 * never sends) would silently match nothing, and the operator would see an
 * allowlist that looks correct and blocks everything. So the canonical form is
 * computed here, once, by the URL parser rather than by hand.
 *
 * Everything below is rejected rather than coerced:
 *
 *   - **A path, query, or fragment.** An `Origin` header is scheme + host + port
 *     and nothing else, so `https://example.com/app` could never match. Trimming
 *     it silently would store something the operator did not type.
 *   - **A wildcard.** There is deliberately no pattern matching anywhere in this
 *     module (see {@link isOriginAllowed}); accepting `*.example.com` here would
 *     create an allowlist entry that can never match a real origin, which reads
 *     as a subdomain grant while granting nothing.
 *   - **Any scheme but http/https.** `file:` and sandboxed-iframe origins both
 *     arrive as the literal string `null`, and a stored `"null"` would match
 *     *every* such page at once. The URL parser rejects it for us; this is the
 *     case worth knowing about, not a hypothetical.
 *   - **Embedded credentials.** `https://user:pw@example.com` parses fine and
 *     has origin `https://example.com`, so accepting it would quietly store a
 *     different value than the one typed — and persist a password.
 *
 * `http:` is allowed because local prototype development needs it. That is not a
 * weakening: the allowlist's job is to bound which pages may use a token, and a
 * forged `Origin` is equally forgeable over TLS.
 */
export function normalizeAllowedOrigin(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new EmbedOriginError("An origin cannot be blank.")
  if (trimmed.includes("*")) {
    throw new EmbedOriginError(
      `"${trimmed}" contains a wildcard. List each site's exact origin, for example https://app.example.com.`
    )
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new EmbedOriginError(`"${trimmed}" is not a valid origin. Include the scheme, for example https://app.example.com.`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EmbedOriginError(`"${trimmed}" must start with https:// or http://.`)
  }
  if (url.username || url.password) {
    throw new EmbedOriginError(`"${trimmed}" must not contain a username or password.`)
  }
  // `new URL("https://example.com")` normalizes pathname to "/", so a bare
  // origin and one with a trailing slash are both accepted; anything longer is
  // a path the operator meant to include and must be told about.
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new EmbedOriginError(
      `"${trimmed}" includes a path. An origin is just the scheme, host, and port — for example ${url.origin}.`
    )
  }
  // `url.origin` is the canonical form a browser sends: lowercased host, default
  // port omitted, no trailing slash.
  return url.origin
}

/**
 * Normalizes and de-duplicates a whole allowlist, preserving the order typed.
 *
 * An empty list is permitted and means "accepts nothing" — a source can exist
 * before anyone knows where it will be deployed, and {@link isOriginAllowed}
 * already fails closed. Refusing to save one would be a worse failure than
 * saving a source that cannot yet be used.
 */
export function normalizeAllowedOrigins(values: string[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim()) continue
    seen.add(normalizeAllowedOrigin(value))
  }
  if (seen.size > MAX_ALLOWED_ORIGINS) {
    throw new EmbedOriginError(`A feedback source may list at most ${MAX_ALLOWED_ORIGINS} origins.`)
  }
  return [...seen]
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

async function retryDsql<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (errorCode(error) !== "P2034" || attempt === attempts - 1) throw error
    }
  }
  throw lastError
}

/**
 * Per-token, per-minute rate limit as a compare-and-set, in the shape
 * lib/research-session.ts already uses.
 *
 * The conditional `updateMany` is the whole point: the window stamp and counter
 * it read are part of the WHERE clause, so if another request advanced them
 * first this update matches zero rows and is retried rather than both requests
 * believing they were under the limit.
 */
export async function consumeEmbedRate(tokenId: string, kind: "READ" | "SUBMIT"): Promise<void> {
  await retryDsql(async () => {
    const prisma = getPrisma()
    const token = await prisma.feedbackSourceToken.findUnique({
      where: { id: tokenId },
      select: { readWindowAt: true, readCount: true, submitWindowAt: true, submitCount: true },
    })
    if (!token) throw new EmbedSourceError(401, "Invalid embed token")
    const now = new Date()
    const windowAt = kind === "READ" ? token.readWindowAt : token.submitWindowAt
    const stored = kind === "READ" ? token.readCount : token.submitCount
    const limit = kind === "READ" ? MAX_EMBED_READS_PER_MINUTE : MAX_EMBED_SUBMITS_PER_MINUTE
    const active = Boolean(windowAt && now.getTime() - windowAt.getTime() < 60_000)
    const count = active ? (stored ?? 0) : 0
    if (count >= limit) throw new EmbedSourceError(429, "Too many requests. Please wait and try again.")
    const updated = await prisma.feedbackSourceToken.updateMany({
      where:
        kind === "READ"
          ? { id: tokenId, readWindowAt: token.readWindowAt, readCount: token.readCount }
          : { id: tokenId, submitWindowAt: token.submitWindowAt, submitCount: token.submitCount },
      data:
        kind === "READ"
          ? active
            ? { readCount: count + 1 }
            : { readWindowAt: now, readCount: 1 }
          : active
            ? { submitCount: count + 1 }
            : { submitWindowAt: now, submitCount: 1 },
    })
    if (updated.count !== 1) {
      throw Object.assign(new Error("Concurrent embed quota update"), { code: "P2034" })
    }
  })
}

/**
 * Best-effort last-used stamp.
 *
 * Deliberately not awaited-into-the-critical-path by callers and deliberately
 * swallowing its own failure: a token that works must not start 500ing because
 * an observability write lost a race.
 */
export async function touchEmbedToken(tokenId: string): Promise<void> {
  try {
    await getPrisma().feedbackSourceToken.update({ where: { id: tokenId }, data: { lastUsedAt: new Date() } })
  } catch {
    // ignored on purpose — see above
  }
}
