import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/lib/route-access";

describe("isPublicPath", () => {
  it("allows the marketing root", () => {
    expect(isPublicPath("/")).toBe(true);
  });

  it("allows auth-related routes", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/callback/google")).toBe(true);
  });

  it("allows the MCP endpoint (Bearer-token auth handled by the route itself)", () => {
    expect(isPublicPath("/api/mcp")).toBe(true);
  });

  it("allows admin routes (x-migration-secret auth handled by the route itself)", () => {
    expect(isPublicPath("/api/admin/migrate")).toBe(true);
  });

  it("allows the public feedback/roadmap portal and its API", () => {
    expect(isPublicPath("/portal/rbcodelabs/compass/roadmap")).toBe(true);
    expect(isPublicPath("/api/portal/rbcodelabs/compass/feedback")).toBe(true);
  });

  it("allows the embedded feedback widget API (embed-token auth handled by the route itself)", () => {
    // Called by fetch from a page Compass does not serve, so a 302 to /login
    // would be unreadable to the caller — it has to reach the handler and get a
    // JSON 401.
    expect(isPublicPath("/api/embed/comments")).toBe(true);
    // The session endpoints and the screenshot upload are reached the same way and
    // authorize themselves the same way, so they must be reachable too. Named
    // individually rather than trusted to the prefix, so that adding a route under
    // /api/embed/ that is NOT meant to be public shows up here as a decision.
    expect(isPublicPath("/api/embed/session")).toBe(true);
    expect(isPublicPath("/api/embed/screenshot")).toBe(true);
    expect(isPublicPath("/api/embed")).toBe(false);
  });

  it("allows the widget's sign-in popup", () => {
    // The popup authenticates a *portal* account, a separate credential from the
    // Compass session — so a 302 to /login would offer the wrong login entirely.
    expect(isPublicPath("/embed/signin")).toBe(true);
    // An exact path, not a prefix: a second page under this segment should have to
    // be argued for in route-access.ts rather than inherited.
    expect(isPublicPath("/embed/signin/anything")).toBe(false);
    expect(isPublicPath("/embed")).toBe(false);
  });

  it("allows the widget script, which a third-party page loads in a script tag", () => {
    // Gating this does not withhold anything — it is a static file in public/ with
    // no secret in it. What it does is break the widget in a way that points
    // nowhere: the browser follows the 302, receives the /login HTML, and tries to
    // execute it as JavaScript, so the symptom is a syntax error rather than
    // anything resembling an auth problem.
    expect(isPublicPath("/embed/widget.js")).toBe(true);
    // Exact, like /embed/signin. Notably a sourcemap is NOT covered: publishing one
    // should be a deliberate addition here, not a side effect of this entry.
    expect(isPublicPath("/embed/widget.js.map")).toBe(false);
    expect(isPublicPath("/embed/widget")).toBe(false);
  });

  it("allows the vendored libraries the widget loads at runtime", () => {
    expect(isPublicPath("/vendor/html-to-image.js")).toBe(true);
    // A prefix here, unlike the two /embed entries, because this directory holds
    // only vendored open-source builds — already world-readable by virtue of being
    // in public/, and byte-identical to their published npm artifacts. There is
    // nothing for the gate to protect, so naming each file would be ceremony.
    expect(isPublicPath("/vendor/anything/nested.js")).toBe(true);
    // The trailing slash is load-bearing: it keeps the allowance off a sibling
    // route that merely starts with the same letters.
    expect(isPublicPath("/vendor")).toBe(false);
    expect(isPublicPath("/vendors/secret")).toBe(false);
  });

  it("allows token-authenticated participant research routes", () => {
    expect(isPublicPath("/research/opaque-participant-token")).toBe(true);
    expect(isPublicPath("/api/research/start")).toBe(true);
    expect(isPublicPath("/api/research/respond")).toBe(true);
    expect(isPublicPath("/api/research/complete")).toBe(true);
  });

  it("allows docs API routes (session auth handled internally)", () => {
    expect(isPublicPath("/api/docs/some-doc-id")).toBe(true);
  });

  it("allows PM interview API routes (session auth handled internally)", () => {
    expect(isPublicPath("/api/pm-interviews")).toBe(true);
    expect(isPublicPath("/api/pm-interviews/interview-id/complete")).toBe(true);
  });

  it("allows the public product docs", () => {
    expect(isPublicPath("/help")).toBe(true);
    expect(isPublicPath("/help/02-discovery")).toBe(true);
  });

  it("allows screenshots embedded in the public product docs", () => {
    expect(isPublicPath("/screenshots/docs/discovery-board.png")).toBe(true);
    expect(isPublicPath("/screenshots/docs/roadmap.png")).toBe(true);
  });

  it("allows the ADR-0009 preview-login page and its start route (both fail closed internally)", () => {
    expect(isPublicPath("/preview-login")).toBe(true);
    expect(isPublicPath("/api/preview-login/start")).toBe(true);
    expect(isPublicPath("/preview-login/extra")).toBe(false);
    expect(isPublicPath("/api/preview-login/other")).toBe(false);
  });

  it("does not allow authenticated app routes", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/rbcodelabs/compass/discovery")).toBe(false);
    expect(isPublicPath("/rbcodelabs/compass/settings")).toBe(false);
  });

  it("does not allow non-portal, non-admin API routes", () => {
    expect(isPublicPath("/api/branding/logo")).toBe(false);
  });

  it("allows the OAuth discovery documents", () => {
    // An MCP client fetches these before any user exists; a 302 to /login would
    // make Compass look like it has no authorization server at all.
    expect(isPublicPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isPublicPath("/.well-known/oauth-protected-resource/api/mcp")).toBe(true);
    expect(isPublicPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isPublicPath("/.well-known/openid-configuration")).toBe(true);
  });

  it("allows the OAuth machine-to-machine endpoints, which authenticate the client themselves", () => {
    expect(isPublicPath("/api/oauth/token")).toBe(true);
    expect(isPublicPath("/api/oauth/register")).toBe(true);
    expect(isPublicPath("/api/oauth/revoke")).toBe(true);
  });

  it("does NOT allow the authorize endpoint or the consent submission", () => {
    // Both must hit the middleware auth redirect: /oauth/authorize's first
    // question is "who is this?", and losing the session there would mean
    // issuing a token bound to nobody. proxy.ts preserves the query string,
    // which is where the entire authorization request lives.
    expect(isPublicPath("/oauth/authorize")).toBe(false);
    expect(isPublicPath("/oauth/consent")).toBe(false);
  });

  it("does not let the OAuth allowance widen to neighbouring paths", () => {
    expect(isPublicPath("/api/oauth")).toBe(false);
    expect(isPublicPath("/api/oauth/token/extra")).toBe(false);
    expect(isPublicPath("/api/oauth/introspect")).toBe(false);
    expect(isPublicPath("/well-known/oauth-authorization-server")).toBe(false);
  });

  it("allows only the exact bearer-authenticated voice callback family", () => {
    const base = "/api/internal/research/voice/00000000-0000-4000-8000-000000000001"
    for (const suffix of ["heartbeat", "events", "commands/claim", "commands/result"]) expect(isPublicPath(`${base}/${suffix}`)).toBe(true)
    for (const path of ["/api/internal/other", `${base}/ready`, `${base}/events/extra`, "/api/internal/research/voice/not-a-uuid/events"]) expect(isPublicPath(path)).toBe(false)
  });
});
