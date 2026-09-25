/**
 * Unit tests for lib/embed-visitor.ts — the scoped credential a widget visitor
 * presents, and the nonce handoff that delivers it.
 *
 * What is being tested is the *policy*, not the plumbing: that a token is scoped
 * to one source, that nothing claimable is ever stored, that a nonce can be
 * claimed exactly once, and that the well-formedness gate runs before any query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mockSession = { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() };
const mockHandoff = { create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() };

const mockPrisma = { embedVisitorSession: mockSession, embedAuthHandoff: mockHandoff };

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));

import { EmbedSourceError } from "@/lib/embed-sources";
import {
  EMBED_VISITOR_TOKEN_PREFIX,
  HANDOFF_TTL_MS,
  VISITOR_SESSION_TTL_MS,
  claimEmbedAuthHandoff,
  depositEmbedAuthHandoff,
  hashVisitorSecret,
  mintEmbedVisitorSession,
  resolveEmbedVisitorToken,
  revokeEmbedVisitorToken,
} from "@/lib/embed-visitor";

const NONCE = "a".repeat(64);

function storedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "visitor-1",
    tokenHash: hashVisitorSecret(RAW_TOKEN),
    feedbackSourceId: "source-1",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    portalAccount: { id: "account-1", email: "someone@example.com", name: "Someone" },
    ...overrides,
  };
}

// A syntactically valid token, standing in for one mintEmbedVisitorSession made.
const RAW_TOKEN = `${EMBED_VISITOR_TOKEN_PREFIX}${"0".repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.create.mockResolvedValue({ id: "visitor-1" });
  mockSession.update.mockResolvedValue({});
  mockSession.updateMany.mockResolvedValue({ count: 1 });
  mockHandoff.create.mockResolvedValue({ id: "handoff-1" });
  mockHandoff.deleteMany.mockResolvedValue({ count: 1 });
});

describe("mintEmbedVisitorSession", () => {
  it("returns the raw token once and stores only its digest", async () => {
    const { token } = await mintEmbedVisitorSession({
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
    });

    const stored = mockSession.create.mock.calls[0][0].data;
    expect(token.startsWith(EMBED_VISITOR_TOKEN_PREFIX)).toBe(true);
    expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("carries the scope and an intrinsic expiry", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { expiresAt } = await mintEmbedVisitorSession({
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
      now,
    });

    const stored = mockSession.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ feedbackSourceId: "source-1", portalAccountId: "account-1" });
    // NOT NULL in the schema and never omitted here: this credential lives in a
    // page Compass does not serve, so expiry cannot be administrative.
    expect(stored.expiresAt).toEqual(new Date(now.getTime() + VISITOR_SESSION_TTL_MS));
    expect(expiresAt).toEqual(stored.expiresAt);
  });

  it("mints a distinct token each time", async () => {
    const first = await mintEmbedVisitorSession({ feedbackSourceId: "s", portalAccountId: "a" });
    const second = await mintEmbedVisitorSession({ feedbackSourceId: "s", portalAccountId: "a" });
    expect(first.token).not.toBe(second.token);
  });
});

describe("resolveEmbedVisitorToken", () => {
  it("resolves a live token to the portal identity behind it", async () => {
    mockSession.findUnique.mockResolvedValue(storedSession());

    await expect(resolveEmbedVisitorToken(RAW_TOKEN, "source-1")).resolves.toEqual({
      portalAccountId: "account-1",
      email: "someone@example.com",
      name: "Someone",
    });
    // Looked up by digest, never by the raw value.
    expect(mockSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashVisitorSecret(RAW_TOKEN) } })
    );
  });

  it("refuses a token minted for a different source", async () => {
    // The scope check, and the reason this function takes a second argument at
    // all: the same signed-in person presenting the same token through another
    // operator's prototype is not authorized there.
    mockSession.findUnique.mockResolvedValue(storedSession({ feedbackSourceId: "source-2" }));
    await expect(resolveEmbedVisitorToken(RAW_TOKEN, "source-1")).resolves.toBeNull();
  });

  it("gives unknown, revoked, and expired the identical null", async () => {
    for (const row of [
      null,
      storedSession({ revokedAt: new Date("2020-01-01") }),
      storedSession({ expiresAt: new Date("2020-01-01") }),
    ]) {
      mockSession.findUnique.mockResolvedValue(row);
      await expect(resolveEmbedVisitorToken(RAW_TOKEN, "source-1")).resolves.toBeNull();
    }
  });

  it("does not query at all for a credential of the wrong kind", async () => {
    // A source embed token (cmpfb_) authorizes a site, not a person. Accepting one
    // here would turn "this prototype may submit" into "this prototype is a
    // verified human".
    await expect(resolveEmbedVisitorToken("cmpfb_0011223344556677", "source-1")).resolves.toBeNull();
    await expect(resolveEmbedVisitorToken("cmp_live_something", "source-1")).resolves.toBeNull();
    expect(mockSession.findUnique).not.toHaveBeenCalled();
  });

  it("still resolves when the last-used stamp loses a race", async () => {
    // A working credential must not start failing because an observability write
    // hit a DSQL write conflict.
    mockSession.findUnique.mockResolvedValue(storedSession());
    mockSession.update.mockRejectedValue(Object.assign(new Error("conflict"), { code: "P2034" }));
    await expect(resolveEmbedVisitorToken(RAW_TOKEN, "source-1")).resolves.toMatchObject({
      portalAccountId: "account-1",
    });
  });
});

describe("revokeEmbedVisitorToken", () => {
  it("revokes by digest and only a live row", async () => {
    await revokeEmbedVisitorToken(RAW_TOKEN);
    expect(mockSession.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashVisitorSecret(RAW_TOKEN), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("is a no-op for a token of the wrong kind", async () => {
    await revokeEmbedVisitorToken("cmpfb_0011223344556677");
    expect(mockSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("depositEmbedAuthHandoff", () => {
  it("stores the nonce digest, the scope, and nothing claimable", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    await depositEmbedAuthHandoff({
      nonce: NONCE,
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
      now,
    });

    const stored = mockHandoff.create.mock.calls[0][0].data;
    expect(stored).toEqual({
      nonceHash: hashVisitorSecret(NONCE),
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
      expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
    });
    // The deposit row is not a credential store. Reading this table mid-handoff
    // must yield nothing a bearer could present — no token, and not the nonce.
    expect(JSON.stringify(stored)).not.toContain(NONCE);
    expect(Object.keys(stored)).not.toContain("token");
    expect(Object.keys(stored)).not.toContain("tokenHash");
    expect(mockSession.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed nonce before touching the database", async () => {
    // Both handoff endpoints are reachable without a Compass session, so this gate
    // is what stops a stranger using one as a query generator.
    for (const nonce of ["", "short", "g".repeat(64), "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const error = await depositEmbedAuthHandoff({
        nonce,
        feedbackSourceId: "source-1",
        portalAccountId: "account-1",
      }).catch((e) => e);
      expect(error).toBeInstanceOf(EmbedSourceError);
      expect((error as EmbedSourceError).status).toBe(400);
    }
    expect(mockHandoff.create).not.toHaveBeenCalled();
  });

  it("names neither the nonce nor the mechanism in its refusal", async () => {
    const error = await depositEmbedAuthHandoff({
      nonce: "nope",
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
    }).catch((e) => e);
    expect((error as Error).message).not.toContain("nope");
    expect((error as Error).message).not.toMatch(/nonce|hex|hash/i);
  });
});

describe("claimEmbedAuthHandoff", () => {
  function storedHandoff(overrides: Record<string, unknown> = {}) {
    return {
      id: "handoff-1",
      nonceHash: hashVisitorSecret(NONCE),
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it("mints a session scoped to the deposited source and account", async () => {
    mockHandoff.findUnique.mockResolvedValue(storedHandoff());

    const result = await claimEmbedAuthHandoff({ nonce: NONCE, feedbackSourceId: "source-1" });

    expect(result?.token.startsWith(EMBED_VISITOR_TOKEN_PREFIX)).toBe(true);
    // The account comes from the deposited row, never from the claim request —
    // the claim endpoint is unauthenticated, so a caller-supplied account id
    // would let anyone mint a session as anyone.
    expect(mockSession.create.mock.calls[0][0].data).toMatchObject({
      feedbackSourceId: "source-1",
      portalAccountId: "account-1",
    });
  });

  it("burns the nonce before minting, so a claim cannot be replayed", async () => {
    mockHandoff.findUnique.mockResolvedValue(storedHandoff());
    await claimEmbedAuthHandoff({ nonce: NONCE, feedbackSourceId: "source-1" });

    expect(mockHandoff.deleteMany).toHaveBeenCalledWith({ where: { id: "handoff-1" } });
    const deleteOrder = mockHandoff.deleteMany.mock.invocationCallOrder[0];
    const mintOrder = mockSession.create.mock.invocationCallOrder[0];
    // Delete first: a mint that fails must burn the nonce, because the visitor can
    // retry the popup but a replayable nonce cannot be un-leaked.
    expect(deleteOrder).toBeLessThan(mintOrder);
  });

  it("returns null for the loser of two concurrent claims, and mints nothing", async () => {
    // The conditional delete is the single-use mechanism: exactly one caller can
    // match the row.
    mockHandoff.findUnique.mockResolvedValue(storedHandoff());
    mockHandoff.deleteMany.mockResolvedValue({ count: 0 });

    await expect(claimEmbedAuthHandoff({ nonce: NONCE, feedbackSourceId: "source-1" })).resolves.toBeNull();
    expect(mockSession.create).not.toHaveBeenCalled();
  });

  it("refuses a nonce deposited for another source, having burned it anyway", async () => {
    mockHandoff.findUnique.mockResolvedValue(storedHandoff({ feedbackSourceId: "source-2" }));

    await expect(claimEmbedAuthHandoff({ nonce: NONCE, feedbackSourceId: "source-1" })).resolves.toBeNull();
    expect(mockHandoff.deleteMany).toHaveBeenCalled();
    expect(mockSession.create).not.toHaveBeenCalled();
  });

  it("refuses an expired nonce", async () => {
    mockHandoff.findUnique.mockResolvedValue(storedHandoff({ expiresAt: new Date("2020-01-01") }));
    await expect(claimEmbedAuthHandoff({ nonce: NONCE, feedbackSourceId: "source-1" })).resolves.toBeNull();
    expect(mockSession.create).not.toHaveBeenCalled();
  });

  it("returns null for an unknown nonce without distinguishing it from an expired one", async () => {
    mockHandoff.findUnique.mockResolvedValue(null);
    await expect(claimEmbedAuthHandoff({ nonce: NONCE, feedbackSourceId: "source-1" })).resolves.toBeNull();
    expect(mockHandoff.deleteMany).not.toHaveBeenCalled();
  });

  it("gates well-formedness before querying", async () => {
    const error = await claimEmbedAuthHandoff({ nonce: "../../etc/passwd", feedbackSourceId: "source-1" }).catch(
      (e) => e
    );
    expect((error as EmbedSourceError).status).toBe(400);
    expect(mockHandoff.findUnique).not.toHaveBeenCalled();
  });
});
