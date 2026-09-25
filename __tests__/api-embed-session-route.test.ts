/**
 * Unit tests for app/api/embed/session/route.ts — the widget's claim, check, and
 * sign-out endpoint.
 *
 * Same mocking shape as __tests__/api-embed-comments-route.test.ts: the embed
 * token resolver, the rate limiter, and the visitor-session library are stubbed,
 * while `isOriginAllowed` and `EmbedSourceError` stay real because the ordering of
 * the origin check relative to everything else is part of what is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return { ...actual, resolveEmbedToken: vi.fn(), consumeEmbedRate: vi.fn(), touchEmbedToken: vi.fn() };
});

vi.mock("@/lib/embed-visitor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-visitor")>();
  return {
    ...actual,
    claimEmbedAuthHandoff: vi.fn(),
    resolveEmbedVisitorToken: vi.fn(),
    revokeEmbedVisitorToken: vi.fn(),
  };
});

import { EMBED_TOKEN_PREFIX, EmbedSourceError, consumeEmbedRate, resolveEmbedToken } from "@/lib/embed-sources";
import { EMBED_VISITOR_HEADER } from "@/lib/embed/http";
import {
  EMBED_VISITOR_TOKEN_PREFIX,
  claimEmbedAuthHandoff,
  resolveEmbedVisitorToken,
  revokeEmbedVisitorToken,
} from "@/lib/embed-visitor";
import { DELETE, GET, OPTIONS, POST } from "@/app/api/embed/session/route";

const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);
const mockClaim = vi.mocked(claimEmbedAuthHandoff);
const mockResolveVisitor = vi.mocked(resolveEmbedVisitorToken);
const mockRevoke = vi.mocked(revokeEmbedVisitorToken);

const ORIGIN = "https://prototype.example.com";
// Assembled from the exported prefix rather than pasted whole: resolveEmbedToken
// is mocked here so nothing hashes or looks this up, and a bare 32-hex literal
// would read to the secret scanner as a credential it is not.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;
const VISITOR_TOKEN = `${EMBED_VISITOR_TOKEN_PREFIX}${"89abcdef89abcdef".repeat(2)}`;
const NONCE = "b".repeat(64);

const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: [ORIGIN],
};

const IDENTITY = { portalAccountId: "portal-1", email: "dana@example.com", name: "Dana" };
const EXPIRES = new Date("2026-01-01T12:00:00Z");

const AUTH = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN };

function post(body: unknown, headers: Record<string, string> = AUTH) {
  return new NextRequest("http://localhost/api/embed/session", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function get(headers: Record<string, string> = AUTH) {
  return new NextRequest("http://localhost/api/embed/session", { headers });
}

function del(headers: Record<string, string> = AUTH) {
  return new NextRequest("http://localhost/api/embed/session", { method: "DELETE", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockRate.mockResolvedValue(undefined);
  mockClaim.mockResolvedValue({ token: VISITOR_TOKEN, expiresAt: EXPIRES });
  mockResolveVisitor.mockResolvedValue({ ...IDENTITY });
  mockRevoke.mockResolvedValue(undefined);
});

describe("OPTIONS", () => {
  it("advertises all three methods so a browser preflight succeeds", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE, OPTIONS");
    // Without the visitor header listed, the preflight for a signed-in GET fails
    // before the request is ever sent.
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(EMBED_VISITOR_HEADER);
  });
});

describe("shared authorization", () => {
  it("rejects a request with no embed token on every method", async () => {
    for (const request of [get({ origin: ORIGIN }), post({ nonce: NONCE }, { origin: ORIGIN }), del({ origin: ORIGIN })]) {
      const handler = request.method === "GET" ? GET : request.method === "POST" ? POST : DELETE;
      const response = await handler(request);
      expect(response.status).toBe(401);
      // Nothing downstream runs: no quota charged, no nonce touched, no revoke.
      expect(mockRate).not.toHaveBeenCalled();
      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockRevoke).not.toHaveBeenCalled();
    }
  });

  it("rejects a disallowed origin on every method, before any work", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example.com" };
    for (const [handler, request] of [
      [GET, get(headers)],
      [POST, post({ nonce: NONCE }, headers)],
      [DELETE, del(headers)],
    ] as const) {
      const response = await handler(request);
      expect(response.status).toBe(403);
      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockRevoke).not.toHaveBeenCalled();
    }
  });

  it("surfaces a revoked or disabled source as the resolver's own status", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(403, "Feedback source is disabled"));
    const response = await POST(post({ nonce: NONCE }));
    expect(response.status).toBe(403);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the quota is spent", async () => {
    mockRate.mockRejectedValue(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    const response = await POST(post({ nonce: NONCE }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("never sets Access-Control-Allow-Credentials, so no cookie can ride along", async () => {
    const response = await GET(get());
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // A minted credential must never be cached by a shared proxy.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST — claiming a handoff nonce", () => {
  it("mints a visitor token scoped to the source the embed token named", async () => {
    const response = await POST(post({ nonce: NONCE, feedbackSourceId: "source-somewhere-else" }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      token: VISITOR_TOKEN,
      expiresAt: EXPIRES.toISOString(),
      email: "dana@example.com",
      name: "Dana",
    });
    // The scope comes from the resolved token, never from the body — a nonce
    // deposited through one prototype must not be redeemable through another's.
    expect(mockClaim).toHaveBeenCalledWith({ nonce: NONCE, feedbackSourceId: "source-1" });
  });

  it("charges the read bucket, not the submit bucket", async () => {
    await POST(post({ nonce: NONCE }));
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
    // The widget polls this while the visitor is away reading their email.
    // Spending the 20/min submit quota here would sign them in and immediately
    // deny them the comment they signed in to leave.
    expect(mockRate).not.toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("gives one answer for an unknown, spent, expired, or misscoped nonce", async () => {
    mockClaim.mockResolvedValue(null);
    const response = await POST(post({ nonce: NONCE }));
    expect(response.status).toBe(401);
    const body = await response.json();
    // The code is what tells the widget to reopen the sign-in popup rather than
    // show a dead end, matching the submit path's contract.
    expect(body.code).toBe("PORTAL_AUTH_REQUIRED");
    // Distinguishing the four cases would tell a guesser which guesses were
    // closer, and the widget's recovery is identical for all of them.
    expect(body.error).toBe("This sign-in has expired. Please sign in again.");
  });

  it("rejects a non-string nonce without reaching the library", async () => {
    for (const nonce of [undefined, 42, null, { toString: "no" }, ["a"]]) {
      const response = await POST(post({ nonce }));
      expect(response.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-object body", async () => {
    for (const body of ["not json", JSON.stringify(["a"]), JSON.stringify("string"), JSON.stringify(null)]) {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    }
  });

  it("passes a malformed nonce through as the library's own refusal", async () => {
    // The route does not second-guess the shape; assertWellFormedNonce is the
    // single gate, so its status is what the caller sees.
    mockClaim.mockRejectedValue(new EmbedSourceError(400, "Malformed sign-in request."));
    const response = await POST(post({ nonce: "too-short" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Malformed sign-in request." });
  });

  it("does not hand back a token it cannot name an account for", async () => {
    // Only reachable if the session is revoked between mint and read. Returning
    // the token anyway would leave the widget signed in as nobody.
    mockResolveVisitor.mockResolvedValue(null);
    const response = await POST(post({ nonce: NONCE }));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(VISITOR_TOKEN);
  });

  it("verifies the minted token through the same scope check the submit path uses", async () => {
    await POST(post({ nonce: NONCE }));
    expect(mockResolveVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("does not leak the portal account id to the embedding page", async () => {
    const response = await POST(post({ nonce: NONCE }));
    // Every script on the prototype page can read this response. The widget has
    // no use for an internal identifier.
    expect(await response.text()).not.toContain("portal-1");
  });
});

describe("GET — checking a stored visitor token", () => {
  it("names the account a live token belongs to", async () => {
    const response = await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: true, email: "dana@example.com", name: "Dana" });
    expect(mockResolveVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("answers signedIn:false with a 200 when there is no token at all", async () => {
    const response = await GET(get());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
    // Not merely "returns false": asking with no token must not cost a lookup.
    expect(mockResolveVisitor).not.toHaveBeenCalled();
  });

  it("answers signedIn:false rather than 401 for a dead token", async () => {
    // Expired, revoked from another tab, or minted for a different source — all
    // one answer, because a widget would otherwise treat "not signed in yet" as
    // an error state and show the visitor a failure they did not cause.
    mockResolveVisitor.mockResolvedValue(null);
    const response = await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
  });

  it("accepts the visitor token with or without a Bearer prefix", async () => {
    await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: `Bearer ${VISITOR_TOKEN}` }));
    // The widget holds two bearer-ish credentials; shaping this one like the
    // other is the obvious slip, and it is not worth a failed sign-in.
    expect(mockResolveVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("treats a whitespace-only header as absent", async () => {
    await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: "   " }));
    expect(mockResolveVisitor).not.toHaveBeenCalled();
  });
});

describe("DELETE — signing out of the widget", () => {
  it("revokes the presented token and reports the signed-out state", async () => {
    const response = await DELETE(del({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
    expect(mockRevoke).toHaveBeenCalledWith(VISITOR_TOKEN);
  });

  it("succeeds with nothing to revoke, and says nothing about whether there was", async () => {
    const response = await DELETE(del());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("keeps a token of the wrong shape off the database", async () => {
    await DELETE(del({ ...AUTH, [EMBED_VISITOR_HEADER]: "not-a-visitor-token" }));
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
