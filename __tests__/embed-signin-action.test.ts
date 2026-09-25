/**
 * Unit tests for app/embed/signin/actions.ts — the one step in the widget's
 * sign-in handoff that reads the portal session cookie.
 *
 * The policy under test: a bad credential is refused before any identity is
 * consulted, an unsigned-in visitor gets a retryable answer rather than an error,
 * the deposit is scoped to the source the *token* named rather than anything the
 * caller passed, polling does not exhaust the write quota, and no credential ever
 * travels back through the return value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/portal-auth", () => ({ getPortalSession: vi.fn() }));

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return { ...actual, resolveEmbedToken: vi.fn(), consumeEmbedRate: vi.fn() };
});

vi.mock("@/lib/embed-visitor", () => ({ depositEmbedAuthHandoff: vi.fn() }));

import { getPortalSession } from "@/lib/portal-auth";
import { EMBED_TOKEN_PREFIX, EmbedSourceError, consumeEmbedRate, resolveEmbedToken } from "@/lib/embed-sources";
import { depositEmbedAuthHandoff } from "@/lib/embed-visitor";
import { depositEmbedSignIn } from "@/app/embed/signin/actions";

const mockSession = vi.mocked(getPortalSession);
const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);
const mockDeposit = vi.mocked(depositEmbedAuthHandoff);

// Built from the exported prefix rather than pasted whole, same as
// __tests__/api-embed-comments-route.test.ts: resolveEmbedToken is mocked here, so
// nothing hashes or looks this up and a bare hex literal would read to the secret
// scanner as a credential it is not.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;
const NONCE = "a".repeat(64);

const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: ["https://prototype.example.com"],
};

const IDENTITY = { portalAccountId: "portal-1", email: "dana@example.com", name: "Dana" };

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockRate.mockResolvedValue(undefined);
  mockSession.mockResolvedValue({ ...IDENTITY });
  mockDeposit.mockResolvedValue(undefined);
});

describe("depositEmbedSignIn", () => {
  it("deposits a handoff scoped to the source the token resolved to", async () => {
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE })).resolves.toEqual({
      status: "deposited",
      email: "dana@example.com",
    });

    expect(mockDeposit).toHaveBeenCalledWith({
      nonce: NONCE,
      // From the resolved token, never from a caller-supplied parameter — this
      // action is reachable by anyone who can open the popup.
      feedbackSourceId: "source-1",
      // From the portal session cookie, never from the request.
      portalAccountId: "portal-1",
    });
  });

  it("returns nothing claimable: the token is minted later, at claim time", async () => {
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: NONCE });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("cmpvt_");
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain("portal-1");
    // The email is the one thing that does come back, because the popup has to be
    // able to tell the visitor which account it signed them in as.
    expect(result).toEqual({ status: "deposited", email: "dana@example.com" });
  });

  it("asks the visitor to sign in rather than failing, and writes nothing", async () => {
    mockSession.mockResolvedValue(null);
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE })).resolves.toEqual({
      status: "signin_required",
    });
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("refuses a bad credential before consulting any identity", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(401, "Invalid embed token"));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE })).resolves.toEqual({
      status: "unavailable",
      error: "Invalid embed token",
    });
    // Not merely "no deposit": a stranger must not be able to use this action to
    // learn whether the browser they are driving carries a portal session.
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("surfaces a disabled source and an unbound source as the visitor-facing refusal", async () => {
    for (const thrown of [
      new EmbedSourceError(403, "Feedback source is disabled"),
      new EmbedSourceError(501, "This feedback source is not bound to an artifact."),
    ]) {
      mockResolve.mockRejectedValue(thrown);
      await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE })).resolves.toEqual({
        status: "unavailable",
        error: thrown.message,
      });
    }
  });

  it("reports a malformed nonce as unavailable without leaking why", async () => {
    // The real gate is assertWellFormedNonce in lib/embed-visitor.ts, which throws
    // a message naming neither the nonce nor the mechanism.
    mockDeposit.mockRejectedValue(new EmbedSourceError(400, "Malformed sign-in request."));
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: "nope" });
    expect(result).toEqual({ status: "unavailable", error: "Malformed sign-in request." });
  });

  it("charges the read quota on every call, including a signed-out poll", async () => {
    mockSession.mockResolvedValue(null);
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE });
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
    // The popup polls for minutes while the visitor reads their email. Charging
    // the 20/min submit quota per poll would lock them out of the flow they are
    // halfway through.
    expect(mockRate).not.toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("charges the write quota once a real deposit happens", async () => {
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE });
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
    expect(mockRate).toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("reports a tripped quota to the visitor instead of throwing", async () => {
    // Next redacts an uncaught server-action message in production, so throwing
    // here would reach the visitor as "An unexpected error occurred".
    mockRate.mockRejectedValue(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE })).resolves.toEqual({
      status: "unavailable",
      error: "Too many requests. Please wait and try again.",
    });
  });

  it("treats a repeat deposit of the same nonce as success", async () => {
    // Two overlapping polls, or a client remounted by React's development double
    // invoke. One widget instance owns the nonce, so this is the same popup
    // arriving twice rather than two parties racing for one slot.
    mockDeposit.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE })).resolves.toEqual({
      status: "deposited",
      email: "dana@example.com",
    });
  });

  it("does not report a repeat deposit as success once the session is gone", async () => {
    mockDeposit.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    mockSession.mockResolvedValueOnce({ ...IDENTITY }).mockResolvedValueOnce(null);
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: NONCE });
    expect(result.status).toBe("unavailable");
  });

  it("does not report an unexpected fault as the visitor's mistake", async () => {
    mockDeposit.mockRejectedValue(new TypeError("cannot read properties of undefined"));
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: NONCE });
    // Generic on purpose: a bug in Compass is not something the visitor can act
    // on, and its message is not theirs to read.
    expect(result).toEqual({ status: "unavailable", error: "Something went wrong. Please try again." });
  });
});
