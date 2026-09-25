/**
 * Unit tests for lib/embed-sources.ts — the credential and origin boundary for
 * feedback submitted from a page Compass does not serve.
 *
 * Prisma is mocked following the "mock @/lib/db" pattern used elsewhere in this
 * repo. What is being tested here is the *policy*: which tokens resolve, which
 * origins pass, and that the per-minute ceiling is a compare-and-set rather than
 * a read-then-write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mockToken = { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), update: vi.fn() };

const mockPrisma = { feedbackSourceToken: mockToken };

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

import {
  EMBED_TOKEN_PREFIX,
  EmbedOriginError,
  EmbedSourceError,
  MAX_ALLOWED_ORIGINS,
  MAX_EMBED_SUBMITS_PER_MINUTE,
  consumeEmbedRate,
  hashEmbedToken,
  isOriginAllowed,
  normalizeAllowedOrigin,
  normalizeAllowedOrigins,
  readEmbedBearer,
  resolveEmbedToken,
  touchEmbedToken,
} from "@/lib/embed-sources";

const RAW_TOKEN = `${EMBED_TOKEN_PREFIX}00112233445566778899aabbccddeeff`;

function storedToken(overrides: Record<string, unknown> = {}) {
  return {
    id: "token-1",
    tokenHash: hashEmbedToken(RAW_TOKEN),
    expiresAt: null,
    revokedAt: null,
    feedbackSource: {
      id: "source-1",
      workspaceId: "ws-1",
      artifactId: "artifact-1",
      enabled: true,
      allowedOrigins: ["https://prototype.example.com"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hashEmbedToken", () => {
  it("stores only a SHA-256 of the token", () => {
    expect(hashEmbedToken(RAW_TOKEN)).toBe(createHash("sha256").update(RAW_TOKEN).digest("hex"));
    // The digest must not contain the credential it was derived from.
    expect(hashEmbedToken(RAW_TOKEN)).not.toContain(RAW_TOKEN);
  });
});

describe("readEmbedBearer", () => {
  const withHeader = (value: string | null) =>
    new Request("http://localhost/api/embed/comments", { headers: value ? { authorization: value } : {} });

  it("reads a correctly prefixed bearer token", () => {
    expect(readEmbedBearer(withHeader(`Bearer ${RAW_TOKEN}`))).toBe(RAW_TOKEN);
    expect(readEmbedBearer(withHeader(`bearer ${RAW_TOKEN}`))).toBe(RAW_TOKEN);
  });

  it("ignores anything that is not an embed token", () => {
    // A Compass API key or an OAuth access token must not be usable here: they
    // authorize far more than leaving a comment on one prototype.
    expect(readEmbedBearer(withHeader("Bearer cmp_live_somethingelse"))).toBeNull();
    expect(readEmbedBearer(withHeader(`Basic ${RAW_TOKEN}`))).toBeNull();
    expect(readEmbedBearer(withHeader(null))).toBeNull();
  });
});

describe("resolveEmbedToken", () => {
  it("resolves a live token bound to an artifact", async () => {
    mockToken.findUnique.mockResolvedValue(storedToken());
    await expect(resolveEmbedToken(RAW_TOKEN)).resolves.toEqual({
      tokenId: "token-1",
      sourceId: "source-1",
      workspaceId: "ws-1",
      artifactId: "artifact-1",
      allowedOrigins: ["https://prototype.example.com"],
    });
    // Looked up by hash, never by the raw value.
    expect(mockToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashEmbedToken(RAW_TOKEN) } })
    );
  });

  it("gives an unknown, revoked, and expired token the identical 401", async () => {
    const statuses: number[] = [];
    const messages: string[] = [];
    for (const row of [null, storedToken({ revokedAt: new Date("2020-01-01") }), storedToken({ expiresAt: new Date("2020-01-01") })]) {
      mockToken.findUnique.mockResolvedValue(row);
      const error = await resolveEmbedToken(RAW_TOKEN).catch((e) => e);
      expect(error).toBeInstanceOf(EmbedSourceError);
      statuses.push((error as EmbedSourceError).status);
      messages.push((error as EmbedSourceError).message);
    }
    // A caller holding a bad credential must not learn *why* it is bad.
    expect(statuses).toEqual([401, 401, 401]);
    expect(new Set(messages).size).toBe(1);
  });

  it("accepts a future expiry", async () => {
    mockToken.findUnique.mockResolvedValue(storedToken({ expiresAt: new Date(Date.now() + 60_000) }));
    await expect(resolveEmbedToken(RAW_TOKEN)).resolves.toMatchObject({ tokenId: "token-1" });
  });

  it("refuses a disabled source with a 403", async () => {
    mockToken.findUnique.mockResolvedValue(storedToken({ feedbackSource: { ...storedToken().feedbackSource, enabled: false } }));
    const error = await resolveEmbedToken(RAW_TOKEN).catch((e) => e);
    expect((error as EmbedSourceError).status).toBe(403);
  });

  it("refuses an unbound source with a 501 rather than inventing a destination", async () => {
    // Unbound sources are a real Phase 2 application. Phase 1 creates the schema
    // for them but must not guess where their submissions land.
    mockToken.findUnique.mockResolvedValue(storedToken({ feedbackSource: { ...storedToken().feedbackSource, artifactId: null } }));
    const error = await resolveEmbedToken(RAW_TOKEN).catch((e) => e);
    expect((error as EmbedSourceError).status).toBe(501);
  });

  it("tolerates a malformed allowed_origins JSON value by allowing nothing", async () => {
    // The column is JSONB, so a hand-edited row can hold anything. Degrading to
    // an empty allowlist fails closed.
    mockToken.findUnique.mockResolvedValue(
      storedToken({ feedbackSource: { ...storedToken().feedbackSource, allowedOrigins: { nope: true } } })
    );
    const resolved = await resolveEmbedToken(RAW_TOKEN);
    expect(resolved.allowedOrigins).toEqual([]);
    expect(isOriginAllowed(resolved.allowedOrigins, "https://prototype.example.com")).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["https://prototype.example.com"];

  it("accepts only an exact match", () => {
    expect(isOriginAllowed(allowed, "https://prototype.example.com")).toBe(true);
  });

  it("rejects the near-misses a pattern match would let through", () => {
    for (const origin of [
      "https://prototype.example.com.evil.test", // suffix attack
      "https://evil-prototype.example.com", // prefix attack
      "http://prototype.example.com", // scheme downgrade
      "https://prototype.example.com:8443", // different port is a different origin
      "https://prototype.example.com/", // trailing slash is not an origin
      "https://PROTOTYPE.example.com", // case differs; browsers send lowercase
    ]) {
      expect(isOriginAllowed(allowed, origin)).toBe(false);
    }
  });

  it("rejects a missing Origin, and accepts nothing when the allowlist is empty", () => {
    // A curl caller sends no Origin at all. It still needs a valid token, but it
    // must not pass the allowlist check by omission.
    expect(isOriginAllowed(allowed, null)).toBe(false);
    expect(isOriginAllowed([], "https://prototype.example.com")).toBe(false);
  });
});

describe("consumeEmbedRate", () => {
  it("opens a new window on the first request", async () => {
    mockToken.findUnique.mockResolvedValue({ readWindowAt: null, readCount: null, submitWindowAt: null, submitCount: null });
    mockToken.updateMany.mockResolvedValue({ count: 1 });
    await consumeEmbedRate("token-1", "SUBMIT");
    const call = mockToken.updateMany.mock.calls[0][0];
    expect(call.data.submitCount).toBe(1);
    expect(call.data.submitWindowAt).toBeInstanceOf(Date);
  });

  it("increments within a live window and writes the prior value into the WHERE clause", async () => {
    const submitWindowAt = new Date(Date.now() - 1_000);
    mockToken.findUnique.mockResolvedValue({ readWindowAt: null, readCount: null, submitWindowAt, submitCount: 3 });
    mockToken.updateMany.mockResolvedValue({ count: 1 });
    await consumeEmbedRate("token-1", "SUBMIT");
    const call = mockToken.updateMany.mock.calls[0][0];
    // The compare-and-set is the whole mechanism: the values just read are part
    // of the WHERE clause, so a concurrent request cannot also believe it was
    // under the limit.
    expect(call.where).toEqual({ id: "token-1", submitWindowAt, submitCount: 3 });
    expect(call.data).toEqual({ submitCount: 4 });
  });

  it("throws 429 once the window is full", async () => {
    mockToken.findUnique.mockResolvedValue({
      readWindowAt: null,
      readCount: null,
      submitWindowAt: new Date(Date.now() - 1_000),
      submitCount: MAX_EMBED_SUBMITS_PER_MINUTE,
    });
    const error = await consumeEmbedRate("token-1", "SUBMIT").catch((e) => e);
    expect(error).toBeInstanceOf(EmbedSourceError);
    expect((error as EmbedSourceError).status).toBe(429);
    expect(mockToken.updateMany).not.toHaveBeenCalled();
  });

  it("resets a stale window instead of counting against it", async () => {
    mockToken.findUnique.mockResolvedValue({
      readWindowAt: null,
      readCount: null,
      submitWindowAt: new Date(Date.now() - 61_000),
      submitCount: MAX_EMBED_SUBMITS_PER_MINUTE + 5,
    });
    mockToken.updateMany.mockResolvedValue({ count: 1 });
    await consumeEmbedRate("token-1", "SUBMIT");
    expect(mockToken.updateMany.mock.calls[0][0].data.submitCount).toBe(1);
  });

  it("retries a lost compare-and-set race", async () => {
    mockToken.findUnique.mockResolvedValue({ readWindowAt: null, readCount: null, submitWindowAt: null, submitCount: null });
    mockToken.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await expect(consumeEmbedRate("token-1", "SUBMIT")).resolves.toBeUndefined();
    expect(mockToken.updateMany).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated contention rather than looping", async () => {
    mockToken.findUnique.mockResolvedValue({ readWindowAt: null, readCount: null, submitWindowAt: null, submitCount: null });
    mockToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(consumeEmbedRate("token-1", "SUBMIT")).rejects.toMatchObject({ code: "P2034" });
    expect(mockToken.updateMany).toHaveBeenCalledTimes(3);
  });

  it("counts reads and submits separately", async () => {
    mockToken.findUnique.mockResolvedValue({ readWindowAt: null, readCount: null, submitWindowAt: new Date(), submitCount: 19 });
    mockToken.updateMany.mockResolvedValue({ count: 1 });
    await consumeEmbedRate("token-1", "READ");
    const call = mockToken.updateMany.mock.calls[0][0];
    expect(call.data.readCount).toBe(1);
    expect(call.data).not.toHaveProperty("submitCount");
  });
});

describe("touchEmbedToken", () => {
  it("swallows its own failure", async () => {
    // A working token must not start 500ing because an observability write lost
    // a race.
    mockToken.update.mockRejectedValue(new Error("write conflict"));
    await expect(touchEmbedToken("token-1")).resolves.toBeUndefined();
  });
});

describe("normalizeAllowedOrigin", () => {
  it("returns the canonical origin a browser actually sends", () => {
    // Each left-hand value is something an operator plausibly pastes; the
    // right-hand value is what `Origin:` will literally contain.
    expect(normalizeAllowedOrigin("https://app.example.com")).toBe("https://app.example.com");
    expect(normalizeAllowedOrigin("  https://app.example.com  ")).toBe("https://app.example.com");
    expect(normalizeAllowedOrigin("https://app.example.com/")).toBe("https://app.example.com");
    expect(normalizeAllowedOrigin("HTTPS://APP.EXAMPLE.COM")).toBe("https://app.example.com");
    expect(normalizeAllowedOrigin("https://app.example.com:443")).toBe("https://app.example.com");
    expect(normalizeAllowedOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("produces a value isOriginAllowed will match, which is the whole point", () => {
    const stored = [normalizeAllowedOrigin("https://app.example.com/")];
    // Without normalization this stored entry would be "https://app.example.com/"
    // and the exact-match check below would fail against every real request.
    expect(isOriginAllowed(stored, "https://app.example.com")).toBe(true);
  });

  it("rejects a wildcard instead of storing an entry that can never match", () => {
    expect(() => normalizeAllowedOrigin("https://*.example.com")).toThrow(EmbedOriginError);
    expect(() => normalizeAllowedOrigin("*")).toThrow(/wildcard/);
  });

  it("rejects the literal null origin, which would match every file: and sandboxed frame at once", () => {
    expect(() => normalizeAllowedOrigin("null")).toThrow(EmbedOriginError);
    expect(() => normalizeAllowedOrigin("file:///Users/someone/proto.html")).toThrow(/https:\/\/ or http:\/\//);
  });

  it("rejects a scheme that is not http or https", () => {
    expect(() => normalizeAllowedOrigin("ftp://example.com")).toThrow(/https:\/\/ or http:\/\//);
    expect(() => normalizeAllowedOrigin("javascript:alert(1)")).toThrow(EmbedOriginError);
  });

  it("rejects embedded credentials rather than silently storing a password", () => {
    expect(() => normalizeAllowedOrigin("https://user:secret@example.com")).toThrow(/username or password/);
  });

  it("rejects a path, query, or fragment rather than trimming it away", () => {
    // An Origin header is scheme + host + port, so any of these could only ever
    // have come from a misunderstanding worth surfacing.
    expect(() => normalizeAllowedOrigin("https://example.com/app")).toThrow(/includes a path/);
    expect(() => normalizeAllowedOrigin("https://example.com/?a=1")).toThrow(/includes a path/);
    expect(() => normalizeAllowedOrigin("https://example.com/#top")).toThrow(/includes a path/);
  });

  it("rejects input with no scheme, since a bare host is not parseable as an origin", () => {
    expect(() => normalizeAllowedOrigin("app.example.com")).toThrow(/not a valid origin/);
    expect(() => normalizeAllowedOrigin("")).toThrow(/cannot be blank/);
  });
});

describe("normalizeAllowedOrigins", () => {
  it("de-duplicates after canonicalizing, not before", () => {
    // These three strings are distinct as text and identical as origins.
    expect(
      normalizeAllowedOrigins(["https://app.example.com", "https://app.example.com/", "HTTPS://App.Example.com:443"])
    ).toEqual(["https://app.example.com"]);
  });

  it("preserves the order typed and drops blank lines", () => {
    expect(normalizeAllowedOrigins(["https://b.example.com", "   ", "https://a.example.com", ""])).toEqual([
      "https://b.example.com",
      "https://a.example.com",
    ]);
  });

  it("allows an empty list, which fails closed rather than open", () => {
    expect(normalizeAllowedOrigins([])).toEqual([]);
    expect(isOriginAllowed([], "https://app.example.com")).toBe(false);
  });

  it("rejects the whole list when one entry is bad, so a typo cannot be saved half-applied", () => {
    expect(() => normalizeAllowedOrigins(["https://good.example.com", "https://*.bad.example.com"])).toThrow(
      EmbedOriginError
    );
  });

  it("refuses more origins than the ceiling", () => {
    const tooMany = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://site-${i}.example.com`);
    expect(() => normalizeAllowedOrigins(tooMany)).toThrow(new RegExp(`at most ${MAX_ALLOWED_ORIGINS} origins`));
    expect(normalizeAllowedOrigins(tooMany.slice(0, MAX_ALLOWED_ORIGINS))).toHaveLength(MAX_ALLOWED_ORIGINS);
  });
});
