"use server";

/**
 * The first-party half of the widget's sign-in handoff.
 *
 * ## Why this is a server action and not a route under /api/embed/
 *
 * Every other endpoint in this feature is a public API route, because every other
 * endpoint is called cross-site by JavaScript running on a page Compass does not
 * serve. This one is the opposite: it runs on a Compass page, in a popup the
 * visitor can see the URL bar of, and it is the only step in the flow that reads
 * the portal session cookie.
 *
 * Making it an action rather than a route removes the two things a route would
 * have had to get right by hand. There is no CORS surface to configure — a server
 * action is same-origin by construction, and Next rejects a cross-origin POST to
 * one before this file runs. And there is no bespoke CSRF check to review: the
 * portal cookie is `SameSite=Lax`, so it does not accompany a cross-site POST
 * even as a top-level form submission.
 *
 * ## The flow, and why the popup has to poll
 *
 * 1. The widget draws a 32-byte nonce and opens this page with it.
 * 2. This action reports `signin_required` until a portal session exists.
 * 3. The visitor signs in with the ordinary portal magic link. The emailed link
 *    opens wherever their mail client sends it — a new tab, possibly a different
 *    window — so it can never redirect the popup back here. The cookie it sets is
 *    for the Compass origin, which is this popup's origin too, so the popup learns
 *    about it by asking again. That is the whole reason the client polls rather
 *    than waiting for a redirect, and it is why no `returnTo` is involved:
 *    `sanitizeReturnTo` in app/api/portal/auth/{send,verify} deliberately admits
 *    only `/portal/…`, and widening an open-redirect guard to reach a popup that
 *    cannot be redirected anyway would be a real risk taken for nothing.
 * 4. Once signed in, this action deposits the handoff and the popup closes. The
 *    widget then claims the nonce for a scoped visitor token.
 *
 * Nothing claimable crosses back through this action's return value — see
 * lib/embed-visitor.ts. The token is minted at claim time, on the widget's own
 * authenticated request.
 */

import { getPortalSession } from "@/lib/portal-auth";
import { EmbedSourceError, consumeEmbedRate, resolveEmbedToken } from "@/lib/embed-sources";
import { depositEmbedAuthHandoff } from "@/lib/embed-visitor";

export type EmbedSignInResult =
  /** The handoff is deposited. The widget's claim will now succeed exactly once. */
  | { status: "deposited"; email: string }
  /** No portal session yet. The popup shows the magic-link form and asks again. */
  | { status: "signin_required" }
  /**
   * This popup cannot be completed at all: a bad, revoked, or disabled credential,
   * a malformed nonce, an unbound source, or a tripped quota. Carries a message
   * written for the visitor, because a thrown error would reach them as "An
   * unexpected error occurred" — Next redacts uncaught server-action messages in
   * production.
   */
  | { status: "unavailable"; error: string };

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * `token` is the source's embed token, the same `cmpfb_…` value the embedding page
 * carries in its script tag. It is passed here in the popup's URL, which is a
 * deliberate choice rather than an oversight: it is not a secret from the people
 * this popup is for, since anyone who can view the page it opened from can already
 * read it out of the DOM. What it buys is that this action can refuse a credential
 * that is fake, revoked, expired, or belongs to a disabled source before writing
 * anything — which a bare feedback-source id in a URL could not do, and which is
 * what keeps a stranger from depositing handoff rows against sources they have
 * nothing to do with.
 */
export async function depositEmbedSignIn(input: {
  token: string;
  nonce: string;
}): Promise<EmbedSignInResult> {
  try {
    const source = await resolveEmbedToken(input.token);

    // Metered on the read bucket, and metered before the session check so a
    // signed-out poll is counted too. A popup polls every few seconds while the
    // visitor is off reading their email, which is well inside the 120/min read
    // ceiling but is not free, and an unmetered loop reachable by anyone holding a
    // public embed token is exactly the shape of an accidental amplifier.
    await consumeEmbedRate(source.tokenId, "READ");

    const identity = await getPortalSession();
    if (!identity) return { status: "signin_required" };

    // The write bucket is charged only for a real deposit. Charging it on every
    // poll would exhaust a 20/min submit quota in under a minute of waiting and
    // lock the visitor out of the flow they are in the middle of completing.
    await consumeEmbedRate(source.tokenId, "SUBMIT");

    await depositEmbedAuthHandoff({
      nonce: input.nonce,
      feedbackSourceId: source.sourceId,
      portalAccountId: identity.portalAccountId,
    });

    return { status: "deposited", email: identity.email };
  } catch (error) {
    // A second deposit of the same nonce. The nonce is 32 CSPRNG bytes chosen by
    // one widget instance and never reused, so this is the same popup arriving
    // twice — two polls overlapping, or a double-mounted client — and not two
    // parties racing for one slot. Reported as success because the state the
    // caller asked for now holds.
    if (isUniqueViolation(error)) {
      const identity = await getPortalSession();
      if (identity) return { status: "deposited", email: identity.email };
    }
    // Every EmbedSourceError in this path carries a message meant for a person: an
    // invalid credential, a disabled source, an unbound source, a tripped quota,
    // or a malformed nonce.
    if (error instanceof EmbedSourceError) {
      return { status: "unavailable", error: error.message };
    }
    console.error("[embed-signin] deposit failed", error);
    return { status: "unavailable", error: "Something went wrong. Please try again." };
  }
}
