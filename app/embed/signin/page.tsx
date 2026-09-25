/**
 * The widget's sign-in popup.
 *
 * Opened by `window.open` from a page Compass does not serve, which is the entire
 * point of it: the visitor's email address and their magic link are handled on the
 * Compass origin, with the Compass URL in a real address bar, and the embedding
 * page never sees either. next.config.ts refuses to let this page be framed for
 * the same reason — a sign-in screen the operator of the surrounding page could
 * wrap is not a sign-in screen the visitor can trust, and it also sends no
 * referrer, because this URL carries the handoff nonce.
 *
 * Both query parameters are checked for shape here, before anything touches the
 * database. `assertWellFormedNonce` in lib/embed-visitor.ts is the real gate and
 * runs again server-side; this one exists so a visitor who lands on a mangled URL
 * gets an explanation instead of a spinner over a doomed poll.
 */
import type { Metadata } from "next";
import { EMBED_TOKEN_PREFIX } from "@/lib/embed-sources";
import { EmbedSignInPopup } from "./signin-popup";

/** A transient popup on a public path. Nothing here belongs in a search index. */
export const metadata: Metadata = {
  title: "Sign in to leave feedback",
  robots: { index: false, follow: false },
};

const NONCE_RE = /^[0-9a-f]{64}$/;

type Props = {
  searchParams: Promise<{ token?: string; nonce?: string }>;
};

export default async function EmbedSignInPage({ searchParams }: Props) {
  const { token, nonce } = await searchParams;

  const wellFormed =
    typeof token === "string" &&
    token.startsWith(EMBED_TOKEN_PREFIX) &&
    typeof nonce === "string" &&
    NONCE_RE.test(nonce);

  if (!wellFormed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
        <div className="rounded-xl border border-border bg-card p-5">
          <h1 className="mb-2 text-base font-semibold">This sign-in link is incomplete</h1>
          <p className="text-sm text-muted-foreground">
            Close this window and press the comment button on the page you came from to start again.
          </p>
        </div>
      </main>
    );
  }

  return <EmbedSignInPopup token={token} nonce={nonce} />;
}
