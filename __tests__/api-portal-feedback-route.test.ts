/**
 * Unit tests for app/api/portal/[orgSlug]/[workspaceSlug]/feedback/route.ts.
 *
 * Prisma and lib/portal-auth's getPortalSession are both mocked. The exported
 * POST handler is called directly with a constructed NextRequest, following
 * the same "mock @/lib/db" pattern used elsewhere in this repo, applied here
 * to a route handler (no prior route-handler test precedent existed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspace = { findFirst: vi.fn() };
const mockFeedbackItem = { create: vi.fn() };

const mockPrisma = {
  workspace: mockWorkspace,
  feedbackItem: mockFeedbackItem,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/lib/portal-auth", () => ({
  getPortalSession: vi.fn(),
}));

import { getPortalSession } from "@/lib/portal-auth";
import { POST } from "@/app/api/portal/[orgSlug]/[workspaceSlug]/feedback/route";

const mockGetPortalSession = vi.mocked(getPortalSession);

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/portal/acme/ws/feedback", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgSlug: "acme", workspaceSlug: "ws" });

beforeEach(() => {
  vi.clearAllMocks();
  mockFeedbackItem.create.mockResolvedValue({
    id: "fb-1",
    title: "Test",
    status: "OPEN",
    voteCount: 0,
    type: "IDEA",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
});

describe("POST /api/portal/[orgSlug]/[workspaceSlug]/feedback", () => {
  it("portalAuthRequired=false: unaffected regression — client submitterEmail passes through untouched, no session lookup", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });

    const res = await POST(
      makeRequest({ title: "Idea", submitterEmail: "visitor@example.com" }),
      { params }
    );

    expect(res.status).toBe(200);
    expect(mockGetPortalSession).not.toHaveBeenCalled();
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submitterEmail: "visitor@example.com",
        portalAccountId: null,
      }),
      select: expect.any(Object),
    });
  });

  it("portalAuthRequired=true + no session: 401 with PORTAL_AUTH_REQUIRED, no item created", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ title: "Idea" }), { params });
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.code).toBe("PORTAL_AUTH_REQUIRED");
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("portalAuthRequired=true + valid session: client-supplied submitterEmail is ignored, session email + portalAccountId used", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue({
      portalAccountId: "account-1",
      email: "verified@example.com",
      name: null,
    });

    const res = await POST(
      makeRequest({ title: "Idea", submitterEmail: "spoofed@example.com" }),
      { params }
    );

    expect(res.status).toBe(200);
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submitterEmail: "verified@example.com",
        portalAccountId: "account-1",
      }),
      select: expect.any(Object),
    });
  });

  it("404s when the workspace doesn't exist", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ title: "Idea" }), { params });
    expect(res.status).toBe(404);
  });

  it("403s when feedback is not enabled, before ever checking portal auth", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: false,
      portalAuthRequired: true,
    });
    const res = await POST(makeRequest({ title: "Idea" }), { params });
    expect(res.status).toBe(403);
    expect(mockGetPortalSession).not.toHaveBeenCalled();
  });

  it("defaults type to IDEA when omitted", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });

    const res = await POST(makeRequest({ title: "Idea" }), { params });

    expect(res.status).toBe(200);
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "IDEA" }),
      select: expect.any(Object),
    });
  });

  it("accepts type: BUG and stores it", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    mockFeedbackItem.create.mockResolvedValue({
      id: "fb-1",
      title: "Test",
      status: "OPEN",
      voteCount: 0,
      type: "BUG",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await POST(makeRequest({ title: "Broken login", type: "BUG" }), { params });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.type).toBe("BUG");
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "BUG" }),
      select: expect.any(Object),
    });
  });

  it("422s when type is an invalid value", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });

    const res = await POST(makeRequest({ title: "Idea", type: "FEATURE" }), { params });

    expect(res.status).toBe(422);
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("persists a valid attachments array via a nested create", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const attachments = [
      {
        url: "https://abc123.public.blob.vercel-storage.com/feedback/ws-1/1-screenshot.png",
        filename: "screenshot.png",
        fileType: "image/png",
        fileSize: 1024,
      },
    ];
    mockFeedbackItem.create.mockResolvedValue({
      id: "fb-1",
      title: "Test",
      status: "OPEN",
      voteCount: 0,
      type: "IDEA",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      attachments: [{ id: "att-1", ...attachments[0] }],
    });

    const res = await POST(makeRequest({ title: "Idea", attachments }), { params });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.attachments).toEqual([{ id: "att-1", ...attachments[0] }]);
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attachments: { create: attachments },
      }),
      select: expect.any(Object),
    });
  });

  it("422s when the attachments array has more than 5 entries", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      url: `https://abc123.public.blob.vercel-storage.com/feedback/ws-1/${i}-file.png`,
      filename: `file-${i}.png`,
      fileType: "image/png",
      fileSize: 100,
    }));

    const res = await POST(makeRequest({ title: "Idea", attachments }), { params });
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.error).toBe("Maximum 5 attachments");
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("422s when an attachment URL isn't a valid blob-storage host", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const attachments = [
      {
        url: "https://evil.example.com/not-blob-storage.png",
        filename: "file.png",
        fileType: "image/png",
        fileSize: 100,
      },
    ];

    const res = await POST(makeRequest({ title: "Idea", attachments }), { params });
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.error).toBe("Invalid attachment URL");
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });
});
