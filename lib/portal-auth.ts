/**
 * Portal Auth — fully independent of Auth.js (auth.ts).
 *
 * Portal sessions and Auth.js sessions are intentionally non-interoperable.
 * Do not attempt to unify them. Different cookie name, different token
 * format (opaque + DB-hashed, not JWT), different tables, different code
 * path end to end. See ADR: Claude/compass-portal-auth-adr-2026-07-03.md.
 *
 * Nothing under app/[orgSlug]/, app/api/mcp, or app/api/admin should ever
 * import from this file.
 */
import { randomBytes, createHash } from "crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import getPrisma from "@/lib/db";

export const PORTAL_SESSION_COOKIE = "compass_portal_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Normalizes a portal-facing email for storage/lookup: trim + lowercase. */
export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Creates a new PortalSession row for the given account, sets the
 * compass_portal_session cookie, and returns the raw (unhashed) token.
 * Only the hash is ever persisted — mirrors the ApiKey.keyHash precedent.
 */
export async function createPortalSession(portalAccountId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const prisma = getPrisma();
  await prisma.portalSession.create({
    data: {
      portalAccountId,
      tokenHash,
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(PORTAL_SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return rawToken;
}

/**
 * Reads the compass_portal_session cookie (if present), hashes it, and
 * looks up a matching, unexpired PortalSession. Fails closed: any absence,
 * mismatch, or expiry returns null rather than throwing.
 *
 * Memoized per-request with React's `cache()`. The portal layout and each
 * portal page (roadmap, feedback, ...) independently call this function.
 * Without memoization, each call issued its own `lastUsedAt` bump UPDATE
 * against the *same* PortalSession row within the same request. Aurora
 * DSQL uses optimistic concurrency control rather than row locking, so two
 * concurrent transactions writing the same row throw a write conflict
 * (Prisma P2034) instead of one blocking on the other — this was crashing
 * the public roadmap/feedback pages with a 500 for any visitor who had an
 * active portal session cookie. Memoizing collapses layout+page into a
 * single call (and a single write) per request.
 */
export const getPortalSession = cache(
  async (): Promise<PortalIdentity | null> => {
    const cookieStore = await cookies();
    const rawToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value;
    if (!rawToken) return null;

    const tokenHash = hashToken(rawToken);
    const prisma = getPrisma();

    const session = await prisma.portalSession.findUnique({
      where: { tokenHash },
      select: {
        portalAccountId: true,
        expiresAt: true,
        // `name` joins `email` here so a caller that has to *display* an identity
        // has one to display. The embedded feedback widget derives
        // `Comment.authorName` from this rather than from anything the submitting
        // page sends, which is the whole reason it is selected.
        portalAccount: { select: { email: true, name: true } },
      },
    });

    if (!session) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;

    // Bump lastUsedAt on successful use (sliding expiry bookkeeping). This
    // is best-effort: a *different* request touching the same row (e.g. a
    // second tab, or a prefetch racing the real navigation) can still hit
    // a DSQL write conflict even with per-request memoization. It's just
    // bookkeeping, so never let it fail the session lookup itself.
    try {
      await prisma.portalSession.update({
        where: { tokenHash },
        data: { lastUsedAt: new Date() },
      });
    } catch (err) {
      console.error("[portal-auth] failed to bump PortalSession.lastUsedAt", err);
    }

    return {
      portalAccountId: session.portalAccountId,
      email: session.portalAccount.email,
      name: session.portalAccount.name,
    };
  }
);

/**
 * A verified portal visitor.
 *
 * Named because more than one credential now resolves to one: this cookie, and
 * the scoped visitor token the embedded widget presents (see
 * lib/embed-visitor.ts). The two are deliberately NOT interchangeable as
 * credentials — a portal session is a thirty-day first-party cookie, a visitor
 * token is a twelve-hour bearer scoped to one feedback source — but what they
 * establish is the same thing, so the consumers can be.
 */
export interface PortalIdentity {
  portalAccountId: string;
  email: string;
  name: string | null;
}

/**
 * Deletes the current PortalSession row (if any) and always clears the
 * cookie, regardless of whether a matching row was found.
 */
export async function clearPortalSession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value;

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    const prisma = getPrisma();
    await prisma.portalSession.deleteMany({ where: { tokenHash } });
  }

  cookieStore.delete(PORTAL_SESSION_COOKIE);
}
