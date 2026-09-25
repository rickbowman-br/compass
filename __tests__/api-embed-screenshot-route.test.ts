/**
 * Unit tests for app/api/embed/screenshot/route.ts.
 *
 * Same mocking shape as __tests__/api-embed-comments-route.test.ts: Prisma never
 * appears because this route reaches the database only through the two mocked
 * libraries, `isOriginAllowed` and the error classes are the real implementations
 * because the ordering of the checks is part of what is under test, and
 * `@vercel/blob` is stubbed so nothing is uploaded.
 *
 * The ordering assertions matter more here than on the comment route. This
 * endpoint writes to durable storage on Compass's account and buffers up to ~560 KB,
 * so "authorize, meter, identify, *then* read the body" is a property worth
 * pinning rather than a stylistic preference.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockPut = vi.fn();
vi.mock("@vercel/blob", () => ({ put: (...args: unknown[]) => mockPut(...args) }));

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return {
    ...actual,
    resolveEmbedToken: vi.fn(),
    consumeEmbedRate: vi.fn(),
    touchEmbedToken: vi.fn(),
  };
});

vi.mock("@/lib/embed-visitor", () => ({ resolveEmbedVisitorToken: vi.fn() }));

import {
  EMBED_TOKEN_PREFIX,
  EmbedSourceError,
  consumeEmbedRate,
  resolveEmbedToken,
  touchEmbedToken,
} from "@/lib/embed-sources";
import { resolveEmbedVisitorToken } from "@/lib/embed-visitor";
import { EMBED_SCREENSHOT_MAX_BYTES, EMBED_SCREENSHOT_PREFIX } from "@/lib/embed-screenshots";
import { EMBED_VISITOR_HEADER } from "@/lib/embed/http";
import { OPTIONS, POST } from "@/app/api/embed/screenshot/route";

const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);
const mockVisitor = vi.mocked(resolveEmbedVisitorToken);

const ORIGIN = "https://prototype.example.com";
// Assembled from the exported prefix rather than pasted as a literal: a 32-hex
// string reads as a credential to the secret scanner, and this is not one —
// resolveEmbedToken is mocked, so nothing hashes or looks it up.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;
const VISITOR_TOKEN = "visitor-session-token";

const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: [ORIGIN],
};

const VISITOR = { portalAccountId: "portal-1", email: "dana@example.com", name: "Dana" };

/** Both credentials plus an allowed Origin: what a signed-in widget sends. */
const AUTHED = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN };

/** The embed token and origin but no visitor token: what a signed-out widget sends. */
const ANONYMOUS = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN };

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const BLOB_HOST = "https://examplestore.public.blob.vercel-storage.com";
const STORED_URL = `${BLOB_HOST}/${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture-abc.png`;

function post(body: unknown, headers: Record<string, string> = AUTHED) {
  return new NextRequest("http://localhost/api/embed/screenshot", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockVisitor.mockResolvedValue({ ...VISITOR });
  mockRate.mockResolvedValue(undefined);
  vi.mocked(touchEmbedToken).mockResolvedValue(undefined);
  mockPut.mockResolvedValue({ url: STORED_URL });
});

describe("OPTIONS /api/embed/screenshot", () => {
  it("advertises only POST, and the visitor header alongside Authorization", async () => {
    const response = await OPTIONS();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(EMBED_VISITOR_HEADER);
    // Wildcard origin and no credentials, the house pattern. A credentialed CORS
    // response here would be the one thing that could make a cookie travel.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("POST /api/embed/screenshot — authorization", () => {
  it("rejects a request with no embed token before metering or storing anything", async () => {
    const response = await POST(post({ dataUrl: PNG_DATA_URL }, { origin: ORIGIN }));
    expect(response.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockRate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects an origin that is not on the source's allowlist", async () => {
    const response = await POST(
      post({ dataUrl: PNG_DATA_URL }, { ...AUTHED, origin: "https://evil.example.com" })
    );
    expect(response.status).toBe(403);
    expect(mockRate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("surfaces the resolver's own status for a disabled source", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(403, "This feedback source is disabled."));
    const response = await POST(post({ dataUrl: PNG_DATA_URL }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "This feedback source is disabled." });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("surfaces an unbound source as the resolver's 501 rather than storing an orphan capture", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(501, "This feedback source is not bound to an artifact."));
    const response = await POST(post({ dataUrl: PNG_DATA_URL }));
    expect(response.status).toBe(501);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("charges the SUBMIT bucket, not READ: this is a durable write", async () => {
    await POST(post({ dataUrl: PNG_DATA_URL }));
    expect(mockRate).toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("returns 429 with Retry-After when the submit bucket is spent", async () => {
    mockRate.mockRejectedValue(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    const response = await POST(post({ dataUrl: PNG_DATA_URL }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe("POST /api/embed/screenshot — visitor identity", () => {
  it("refuses an anonymous upload with PORTAL_AUTH_REQUIRED", async () => {
    const response = await POST(post({ dataUrl: PNG_DATA_URL }, ANONYMOUS));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "PORTAL_AUTH_REQUIRED" });
    expect(mockVisitor).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("does not read the body when no visitor token is presented", async () => {
    // The point of ordering the identity check first: an unauthenticated caller
    // must not be able to make this server buffer a 400 KB payload.
    const request = post({ dataUrl: PNG_DATA_URL }, ANONYMOUS);
    const bodySpy = vi.spyOn(request, "body", "get");
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(bodySpy).not.toHaveBeenCalled();

    // The same spy on an authorized request, to prove the assertion above is
    // about ordering rather than about a getter that is never consulted at all.
    const authorized = post({ dataUrl: PNG_DATA_URL });
    const authorizedSpy = vi.spyOn(authorized, "body", "get");
    expect((await POST(authorized)).status).toBe(201);
    expect(authorizedSpy).toHaveBeenCalled();
  });

  it("refuses a visitor token that does not resolve for this source", async () => {
    mockVisitor.mockResolvedValue(null);
    const response = await POST(post({ dataUrl: PNG_DATA_URL }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "PORTAL_AUTH_REQUIRED" });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("scopes the visitor lookup to the source the embed token named, not the body", async () => {
    await POST(post({ dataUrl: PNG_DATA_URL, sourceId: "source-somewhere-else" }));
    expect(mockVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("tolerates a Bearer prefix on the visitor header", async () => {
    await POST(post({ dataUrl: PNG_DATA_URL }, { ...AUTHED, [EMBED_VISITOR_HEADER]: `Bearer ${VISITOR_TOKEN}` }));
    expect(mockVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("treats a whitespace-only visitor token as absent rather than looking it up", async () => {
    const response = await POST(post({ dataUrl: PNG_DATA_URL }, { ...AUTHED, [EMBED_VISITOR_HEADER]: "   " }));
    expect(response.status).toBe(401);
    expect(mockVisitor).not.toHaveBeenCalled();
  });
});

describe("POST /api/embed/screenshot — storage", () => {
  it("stores the capture and returns only its URL", async () => {
    const response = await POST(post({ dataUrl: PNG_DATA_URL }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ url: STORED_URL });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("derives the blob path from the resolved source, ignoring anything in the body", async () => {
    await POST(
      post({
        dataUrl: PNG_DATA_URL,
        // A hostile widget trying to write into another workspace's namespace.
        workspaceId: "ws-2",
        feedbackSourceId: "source-2",
        pathname: "../../../etc/passwd",
      })
    );
    expect(mockPut.mock.calls[0][0]).toBe(`${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture.png`);
  });

  it("exposes nothing about the submitter or their credential in its response", async () => {
    const serialized = JSON.stringify(await (await POST(post({ dataUrl: PNG_DATA_URL }))).json());
    for (const leak of ["portal-1", "dana@example.com", "token-1", VISITOR_TOKEN]) {
      expect(serialized).not.toContain(leak);
    }
    // The workspace and source ids DO appear, inside the blob path, and that is
    // accepted rather than overlooked: they are opaque cuids that authorize
    // nothing on their own, every route derives its own scope from a presented
    // credential instead of from an id in a URL, and `addRandomSuffix` is what
    // keeps the objects unenumerable. Upstream's own portal upload route already
    // returns `feedback/<workspaceId>/…` to a public portal client, so this
    // follows the established shape rather than inventing a laxer one.
    expect(serialized).toContain("ws-1");
  });

  it("passes the decoded content type through to the blob", async () => {
    await POST(post({ dataUrl: "data:image/jpeg;base64,iVBORw0KGgo=" }));
    expect(mockPut.mock.calls[0][2]).toMatchObject({ contentType: "image/jpeg", access: "public" });
  });
});

describe("POST /api/embed/screenshot — payload validation", () => {
  it("rejects a body that is not JSON as too large or malformed", async () => {
    const response = await POST(post("not json at all"));
    expect(response.status).toBe(413);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it.each([
    ["an array", []],
    ["a bare string", JSON.stringify("hello")],
    ["null", JSON.stringify(null)],
    ["a number", JSON.stringify(3)],
  ])("rejects %s as a body", async (_label, body) => {
    const response = await POST(post(body));
    expect([400, 413]).toContain(response.status);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("surfaces a malformed data URL as the library's 400 rather than throwing", async () => {
    const response = await POST(post({ dataUrl: "data:," }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("base64 image data URL") });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("surfaces a missing dataUrl as a 400", async () => {
    const response = await POST(post({}));
    expect(response.status).toBe(400);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("refuses an SVG payload, which would be stored XSS on the blob host", async () => {
    const response = await POST(post({ dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }));
    expect(response.status).toBe(400);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("surfaces an oversized capture as the library's 413", async () => {
    const oversized = "A".repeat(Math.ceil(((EMBED_SCREENSHOT_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    const response = await POST(post({ dataUrl: `data:image/png;base64,${oversized}` }));
    expect(response.status).toBe(413);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("lets an unexpected error propagate rather than reporting a fake success", async () => {
    // A blob outage is not a 4xx and must not be laundered into one — the widget
    // needs to know the capture did not land.
    mockPut.mockRejectedValue(new TypeError("fetch failed"));
    await expect(POST(post({ dataUrl: PNG_DATA_URL }))).rejects.toThrow(TypeError);
  });
});
