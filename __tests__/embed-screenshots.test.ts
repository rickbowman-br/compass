/**
 * Unit tests for lib/embed-screenshots.ts.
 *
 * Two boundaries under test, and they face opposite directions. `decodeEmbedScreenshot`
 * guards bytes on the way in from the widget; `isEmbedScreenshotUrl` guards a URL on
 * the way back in from a page Compass does not control. The second one is the one
 * that would be a vulnerability if it were wrong, so it gets the most cases.
 *
 * `@vercel/blob`'s `put` is mocked. Nothing here touches the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPut = vi.fn();
vi.mock("@vercel/blob", () => ({ put: (...args: unknown[]) => mockPut(...args) }));

import {
  EMBED_SCREENSHOT_MAX_BYTES,
  EMBED_SCREENSHOT_MAX_BODY_BYTES,
  EMBED_SCREENSHOT_PREFIX,
  EmbedScreenshotError,
  decodeEmbedScreenshot,
  isEmbedScreenshotUrl,
  storeEmbedScreenshot,
} from "@/lib/embed-screenshots";

/** An 8-byte PNG signature, base64. Small, real, and padded — so the padding
 *  arithmetic is exercised by the happy path rather than only by failure cases. */
const PNG_BASE64 = "iVBORw0KGgo=";
const BLOB_HOST = "https://examplestore.public.blob.vercel-storage.com";

beforeEach(() => {
  vi.clearAllMocks();
  mockPut.mockResolvedValue({ url: `${BLOB_HOST}/${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture-abc.jpg` });
});

/** Asserts the thrown value is an EmbedScreenshotError carrying `status`. */
async function expectStatus(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmbedScreenshotError);
    expect((error as EmbedScreenshotError).status).toBe(status);
    return;
  }
  throw new Error(`Expected a ${status}, but nothing was thrown.`);
}

describe("decodeEmbedScreenshot", () => {
  it.each(["image/png", "image/jpeg", "image/webp"])("accepts %s and reports the type back", (mime) => {
    const { bytes, fileType } = decodeEmbedScreenshot(`data:${mime};base64,${PNG_BASE64}`);
    expect(fileType).toBe(mime);
    // The byte length the padding arithmetic predicted, confirmed against the decode.
    expect(bytes.length).toBe(8);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { dataUrl: `data:image/png;base64,${PNG_BASE64}` }],
    ["an empty string", ""],
  ])("refuses %s", async (_label, value) => {
    await expectStatus(() => decodeEmbedScreenshot(value), 400);
  });

  it.each([
    ["a bare base64 payload with no data-URL envelope", PNG_BASE64],
    ["a data URL that is not base64-encoded", "data:image/png,%89PNG"],
    ["the degenerate data URL", "data:,"],
    ["an empty payload", "data:image/png;base64,"],
    // Parameters between the media type and ;base64 are rejected rather than
    // skipped over: a permissive read is how a charset or a second media type
    // sneaks past a type allowlist.
    ["a charset parameter", `data:image/png;charset=utf-8;base64,${PNG_BASE64}`],
    ["an uppercase media type", `data:IMAGE/PNG;base64,${PNG_BASE64}`],
    ["a leading space", ` data:image/png;base64,${PNG_BASE64}`],
    ["trailing content after the payload", `data:image/png;base64,${PNG_BASE64} <script>`],
    // Buffer.from silently skips characters it does not recognise, so whitespace
    // inside the payload would decode "successfully" to different bytes.
    ["internal whitespace", "data:image/png;base64,iVBORw0 KGgo="],
    ["internal newline", "data:image/png;base64,iVBORw0\nKGgo="],
    ["padding in the middle", "data:image/png;base64,iVBO=Rw0KGgo="],
  ])("refuses %s", async (_label, value) => {
    await expectStatus(() => decodeEmbedScreenshot(value), 400);
  });

  // SVG is the one that matters: it is a document, it can carry script, and the
  // blob host serves it with its own content type — stored XSS, one allowlist
  // entry away.
  it.each([
    ["SVG", "image/svg+xml"],
    ["GIF", "image/gif"],
    ["AVIF", "image/avif"],
    ["plain text", "text/plain"],
    ["HTML", "text/html"],
  ])("refuses %s even though the envelope is well formed", async (_label, mime) => {
    await expectStatus(() => decodeEmbedScreenshot(`data:${mime};base64,${PNG_BASE64}`), 400);
  });

  it("distinguishes an unsupported type from a malformed envelope in its message", () => {
    // Worth pinning: the two 400s are different diagnoses, and a widget author
    // debugging a capture needs to know which one they hit.
    expect(() => decodeEmbedScreenshot(`data:image/gif;base64,${PNG_BASE64}`)).toThrow(
      /PNG, JPEG, or WebP/
    );
    expect(() => decodeEmbedScreenshot("data:,")).toThrow(/base64 image data URL/);
  });

  it("refuses a payload whose decoded length disagrees with its padding", async () => {
    // "QUJD=" claims one byte of padding but decodes to three. The re-check after
    // decoding is what makes the pre-decode size estimate trustworthy.
    await expectStatus(() => decodeEmbedScreenshot("data:image/png;base64,QUJD="), 400);
  });

  it("refuses a payload over the decoded cap with a 413, not a 400", async () => {
    // Unpadded, so decoded length is exactly 3/4 of this.
    const oversized = "A".repeat(Math.ceil(((EMBED_SCREENSHOT_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    await expectStatus(() => decodeEmbedScreenshot(`data:image/png;base64,${oversized}`), 413);
  });

  it("accepts a payload just under the decoded cap", () => {
    // 4 base64 chars per 3 bytes, unpadded, sized to land one group below the cap.
    const groups = Math.floor(EMBED_SCREENSHOT_MAX_BYTES / 3) - 1;
    const { bytes } = decodeEmbedScreenshot(`data:image/jpeg;base64,${"A".repeat(groups * 4)}`);
    expect(bytes.length).toBe(groups * 3);
    expect(bytes.length).toBeLessThanOrEqual(EMBED_SCREENSHOT_MAX_BYTES);
  });

  it("sizes the body ceiling above the decoded ceiling, with room for the JSON envelope", () => {
    // If these ever crossed, the route would reject a legal capture as too large
    // before this function got the chance to accept it.
    expect(EMBED_SCREENSHOT_MAX_BODY_BYTES).toBeGreaterThan((EMBED_SCREENSHOT_MAX_BYTES * 4) / 3);
  });
});

describe("storeEmbedScreenshot", () => {
  it("derives the whole path from server-resolved ids and returns the blob URL", async () => {
    const result = await storeEmbedScreenshot({
      workspaceId: "ws-1",
      feedbackSourceId: "source-1",
      bytes: Buffer.from("fake-bytes"),
      fileType: "image/jpeg",
    });

    expect(result.url).toBe(`${BLOB_HOST}/${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture-abc.jpg`);
    const [pathname, bytes, options] = mockPut.mock.calls[0];
    // Nothing in the pathname came from the request body — a caller cannot choose
    // where its bytes land or overwrite another workspace's object.
    expect(pathname).toBe(`${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture.jpg`);
    expect(bytes).toBeInstanceOf(Buffer);
    expect(options).toMatchObject({ access: "public", contentType: "image/jpeg" });
    // Public objects, so unguessable names are the compensating control.
    expect(options.addRandomSuffix).toBe(true);
  });

  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ])("gives %s the .%s extension and content type", async (fileType, extension) => {
    await storeEmbedScreenshot({
      workspaceId: "ws-1",
      feedbackSourceId: "source-1",
      bytes: Buffer.from("x"),
      fileType: fileType as "image/jpeg" | "image/png" | "image/webp",
    });
    expect(mockPut.mock.calls[0][0]).toBe(`${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture.${extension}`);
    expect(mockPut.mock.calls[0][2].contentType).toBe(fileType);
  });

  it("writes everything under the one prefix isEmbedScreenshotUrl trusts", async () => {
    // The pair only works if these two agree. If a future edit moved the write
    // path, every submitted URL would start being silently dropped.
    await storeEmbedScreenshot({
      workspaceId: "ws-1",
      feedbackSourceId: "source-1",
      bytes: Buffer.from("x"),
      fileType: "image/png",
    });
    expect(mockPut.mock.calls[0][0].startsWith(`${EMBED_SCREENSHOT_PREFIX}/`)).toBe(true);
    expect(isEmbedScreenshotUrl(`${BLOB_HOST}/${mockPut.mock.calls[0][0]}`)).toBe(true);
  });
});

describe("isEmbedScreenshotUrl", () => {
  it("accepts a blob object under the embed prefix", () => {
    expect(isEmbedScreenshotUrl(`${BLOB_HOST}/${EMBED_SCREENSHOT_PREFIX}/ws-1/source-1/capture-abc.jpg`)).toBe(true);
  });

  it("accepts any store subdomain, since the store id varies by environment", () => {
    expect(isEmbedScreenshotUrl(`https://otherstore.public.blob.vercel-storage.com/${EMBED_SCREENSHOT_PREFIX}/a.jpg`)).toBe(true);
  });

  // Each of the three checks, failed on its own, with the other two satisfied.
  it("rejects plain http on the right host and prefix", () => {
    expect(isEmbedScreenshotUrl(`http://examplestore.public.blob.vercel-storage.com/${EMBED_SCREENSHOT_PREFIX}/a.jpg`)).toBe(false);
  });

  it("rejects the right prefix on somebody else's host", () => {
    // The tracking-pixel case, and the reason this function exists.
    expect(isEmbedScreenshotUrl(`https://evil.example.com/${EMBED_SCREENSHOT_PREFIX}/a.jpg`)).toBe(false);
  });

  it("rejects the right host outside the embed prefix", () => {
    // Would otherwise let a widget surface an unrelated blob object — a feedback
    // attachment, a branding asset — as though it were a screenshot of a click.
    expect(isEmbedScreenshotUrl(`${BLOB_HOST}/feedback/ws-1/a.jpg`)).toBe(false);
  });

  it.each([
    ["a host that merely contains the blob domain", "https://blob.vercel-storage.com.evil.example.com/embed-feedback/a.jpg"],
    ["a host that prefixes the blob domain", "https://public.blob.vercel-storage.com.evil.test/embed-feedback/a.jpg"],
    ["the blob domain as a path segment", "https://evil.example.com/.public.blob.vercel-storage.com/embed-feedback/a.jpg"],
    ["the blob domain in userinfo", "https://foo.public.blob.vercel-storage.com@evil.example.com/embed-feedback/a.jpg"],
    ["the apex blob domain with no store subdomain", "https://public.blob.vercel-storage.com/embed-feedback/a.jpg"],
  ])("rejects %s", (_label, value) => {
    expect(isEmbedScreenshotUrl(value)).toBe(false);
  });

  it.each([
    ["the prefix without its trailing separator", `${BLOB_HOST}/embed-feedbackish/a.jpg`],
    ["the prefix as a bare path", `${BLOB_HOST}/embed-feedback`],
    ["the prefix deeper in the path", `${BLOB_HOST}/other/embed-feedback/a.jpg`],
  ])("rejects %s", (_label, value) => {
    expect(isEmbedScreenshotUrl(value)).toBe(false);
  });

  it.each([
    ["a data URL", "data:image/png;base64,iVBORw0KGgo="],
    ["a javascript URL", "javascript:alert(1)"],
    ["a protocol-relative URL", "//examplestore.public.blob.vercel-storage.com/embed-feedback/a.jpg"],
    ["a bare path", "/embed-feedback/ws-1/a.jpg"],
    ["a non-URL string", "not-a-url"],
    ["an empty string", ""],
    ["a whitespace string", "   "],
  ])("rejects %s", (_label, value) => {
    expect(isEmbedScreenshotUrl(value)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 17],
    ["an object", { url: `${BLOB_HOST}/embed-feedback/a.jpg` }],
    ["an array", [`${BLOB_HOST}/embed-feedback/a.jpg`]],
  ])("rejects %s without throwing", (_label, value) => {
    expect(isEmbedScreenshotUrl(value)).toBe(false);
  });
});
