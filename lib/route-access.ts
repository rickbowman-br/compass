/**
 * Paths that are reachable without a signed-in session.
 *
 * Kept as a standalone, pure function (rather than inlined in proxy.ts) so it
 * can be unit tested directly — the proxy.ts middleware itself is wrapped by
 * next-auth's `auth()` helper and isn't easily testable in isolation.
 */
/**
 * Note on OAuth: `/oauth/authorize` and `/oauth/consent` are deliberately
 * **not** listed below. The authorize endpoint's first question is "who is
 * this?", and it must hit the middleware auth redirect so an anonymous visitor
 * is sent to `/login` and returned afterward with the query string intact —
 * `client_id`, `redirect_uri`, `state`, `code_challenge`, `scope` and
 * `resource` all live there. Making either public would turn the one endpoint
 * that binds a token to a human into one that runs without a session.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    // Fixed-path signed relay authenticates HMAC in its handler.
    pathname === "/api/analytics/activity" ||
    pathname.startsWith("/_vercel/insights/") ||
    ["/api/preview-automation/bootstrap", "/api/preview-automation/session", "/api/preview-automation/teardown"].includes(pathname) ||
    // ADR-0009 preview-login page + its start route. Both fail closed
    // internally (404 before any DB access) unless VERCEL_ENV=preview and
    // PREVIEW_LOGIN_ENABLED=1, so making them reachable without a session
    // here does not widen access on production or non-opted-in previews —
    // it only lets an anonymous visitor reach the gate at all, which is the
    // entire point of a login page.
    pathname === "/preview-login" ||
    pathname === "/api/preview-login/start" ||
    pathname === "/" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    // MCP route uses Bearer token auth — let it through so the route
    // handler can validate the API key and return 401 (not 302) on failure.
    pathname.startsWith("/api/mcp") ||
    // OAuth discovery documents (RFC 8414 / RFC 9728 / OIDC Discovery). An MCP
    // client fetches these before any user exists, so a 302 to /login would
    // make the server look like it has no authorization server at all.
    pathname.startsWith("/.well-known/") ||
    // The OAuth authorization server's machine-to-machine endpoints. Each one
    // authenticates the *client* (client_id, and a client_secret where the
    // client registered one) rather than a browser session, and each returns a
    // proper OAuth error body — a 302 to /login would be unparseable to them.
    // Registration is unauthenticated by design: it happens before any user is
    // involved, so there is no session to gate it on (decision 2).
    pathname === "/api/oauth/token" ||
    pathname === "/api/oauth/register" ||
    pathname === "/api/oauth/revoke" ||
    // All admin routes use x-migration-secret header auth
    pathname.startsWith("/api/admin/") ||
    // Public portal routes — no auth, workspace settings control access
    pathname.startsWith("/portal/") ||
    pathname.startsWith("/api/portal/") ||
    // Embedded feedback widget API. Called by `fetch` from a page Compass does
    // not serve, so a 302 to /login would be unreadable to the caller — it has
    // to reach the handler and get a JSON 401. The handler authenticates an
    // `Authorization: Bearer cmpfb_…` embed token and separately checks the
    // request's Origin against the source's exact-match allowlist; neither check
    // consults a session, and no Compass cookie travels here (SameSite=Lax, and
    // Access-Control-Allow-Credentials is never set).
    pathname.startsWith("/api/embed/") ||
    // The widget's sign-in popup. A visitor arriving here has no Compass session
    // and is not going to get one — this page authenticates a *portal* account,
    // which is a separate credential on a separate table (lib/portal-auth.ts), so
    // sending them to /login would offer the wrong login entirely. The page reads
    // an embed token and a nonce from its query string, refuses a malformed pair
    // before touching the database, and its server action refuses everything else.
    // Listed as an exact path rather than a `/embed/` prefix so that adding a
    // second page under this segment is a decision someone has to make here.
    pathname === "/embed/signin" ||
    // The widget script itself, loaded by a `<script src>` tag on a third-party
    // page. A redirect here is worse than it sounds: the browser would fetch
    // /login, receive HTML, and try to execute it as JavaScript, so the widget
    // would fail with a syntax error rather than anything that points at auth.
    //
    // Nothing is withheld by gating it. It is a static file in public/, identical
    // for every deployment, and it carries no secret — the embed token lives in
    // the host page's script tag, not in here. Its whole job is to read that
    // token and call the /api/embed/ routes above, each of which authenticates
    // every request on its own.
    pathname === "/embed/widget.js" ||
    // Participant research routes use a hashed, expiring study token. Their
    // API handlers validate the token and session-to-study scope themselves.
    pathname.startsWith("/research/") ||
    pathname.startsWith("/api/research/") ||
    // Only these internal callbacks bypass browser login; each requires its bound worker bearer.
    /^\/api\/internal\/research\/voice\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(?:heartbeat|events|commands\/(?:claim|result))$/i.test(pathname) ||
    // Docs API routes use session auth internally — let them handle 401 themselves
    pathname.startsWith("/api/docs/") ||
    // Agent turn route uses session auth internally (returns 401, not a 302)
    pathname.startsWith("/api/agent/") ||
    // PM interview routes use session auth internally so API clients receive
    // an explicit 401 instead of a browser-login redirect.
    pathname === "/api/pm-interviews" ||
    pathname.startsWith("/api/pm-interviews/") ||
    // Product docs — public, no auth required
    pathname.startsWith("/help") ||
    // Repository-native UI registry. The page itself returns 404 in production
    // unless COMPASS_UI_REGISTRY=1; keeping the route public makes the enabled
    // registry deterministic and independent of session/database fixtures.
    pathname === "/ui" ||
    // Images referenced by the public product docs (e.g. /help/02-discovery
    // embeds /screenshots/docs/discovery-board.png) — served from public/,
    // so the middleware matcher catches them like any other route. Without
    // this, every screenshot in the public docs 302s to /login for anyone
    // without a session, making the images appear broken.
    pathname.startsWith("/screenshots") ||
    // Third-party libraries the embedded widget loads at runtime (currently just
    // html-to-image, for element screenshots). Served from public/, so — like
    // /screenshots above — the middleware matcher catches them and a missing entry
    // here turns into a 302 to /login that the widget receives as HTML where it
    // expected JavaScript.
    //
    // A prefix rather than a list of filenames, because this directory holds only
    // vendored open-source builds: files that are already world-readable by virtue
    // of being in public/, that are byte-identical to their published npm artifacts,
    // and whose provenance is recorded in a header comment in each one. There is
    // nothing here for the gate to protect, so a per-file decision would be
    // ceremony rather than a control.
    pathname.startsWith("/vendor/")
  )
}
