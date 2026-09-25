/**
 * Unit tests for app/api/portal/[orgSlug]/[workspaceSlug]/vote/route.ts.
 *
 * Prisma and lib/portal-auth's getPortalSession are both mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspace = { findFirst: vi.fn() };
const mockFeedbackItem = { findFirst: vi.fn(), update: vi.fn() };
const mockFeedbackVote = { findFirst: vi.fn(), create: vi.fn() };
const mockRoadmapItem = { findFirst: vi.fn() };
const mockRoadmapVote = { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() };

const mockPrisma = {
  workspace: mockWorkspace,
  feedbackItem: mockFeedbackItem,
  feedbackVote: mockFeedbackVote,
  roadmapItem: mockRoadmapItem,
  roadmapVote: mockRoadmapVote,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/lib/portal-auth", () => ({
  getPortalSession: vi.fn(),
}));

import { getPortalSession } from "@/lib/portal-auth";
import { POST } from "@/app/api/portal/[orgSlug]/[workspaceSlug]/vote/route";

const mockGetPortalSession = vi.mocked(getPortalSession);

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/portal/acme/ws/vote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgSlug: "acme", workspaceSlug: "ws" });

beforeEach(() => {
  vi.clearAllMocks();
  mockFeedbackItem.findFirst.mockResolvedValue({ id: "fb-1", voteCount: 0 });
  mockFeedbackVote.findFirst.mockResolvedValue(null);
  mockFeedbackItem.update.mockResolvedValue({ voteCount: 1 });
  mockRoadmapItem.findFirst.mockResolvedValue({ id: "rm-1", isPrivate: false });
  mockRoadmapVote.findFirst.mockResolvedValue(null);
  mockRoadmapVote.count.mockResolvedValue(1);
});

describe("POST /api/portal/[orgSlug]/[workspaceSlug]/vote — feedback votes", () => {
  it("portalAuthRequired=false: unaffected regression — client voterEmail required and used, no session lookup", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: false,
    });

    const res = await POST(
      makeRequest({ type: "feedback", itemId: "fb-1", voterEmail: "Visitor@Example.com" }),
      { params }
    );

    expect(res.status).toBe(200);
    expect(mockGetPortalSession).not.toHaveBeenCalled();
    expect(mockFeedbackVote.create).toHaveBeenCalledWith({
      data: { feedbackId: "fb-1", voterEmail: "visitor@example.com", portalAccountId: null },
    });
  });

  it("portalAuthRequired=false: 422 when voterEmail is missing (unchanged existing behavior)", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: false,
    });

    const res = await POST(makeRequest({ type: "feedback", itemId: "fb-1" }), { params });
    expect(res.status).toBe(422);
    expect(mockFeedbackVote.create).not.toHaveBeenCalled();
  });

  it("portalAuthRequired=true + no session: 401 with PORTAL_AUTH_REQUIRED, no vote recorded", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ type: "feedback", itemId: "fb-1" }), { params });
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.code).toBe("PORTAL_AUTH_REQUIRED");
    expect(mockFeedbackVote.create).not.toHaveBeenCalled();
  });

  it("portalAuthRequired=true + valid session: client-supplied voterEmail is ignored, session email + portalAccountId used", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue({
      portalAccountId: "account-1",
      email: "verified@example.com",
      name: null,
    });

    const res = await POST(
      makeRequest({ type: "feedback", itemId: "fb-1", voterEmail: "spoofed@example.com" }),
      { params }
    );

    expect(res.status).toBe(200);
    expect(mockFeedbackVote.create).toHaveBeenCalledWith({
      data: { feedbackId: "fb-1", voterEmail: "verified@example.com", portalAccountId: "account-1" },
    });
  });
});

describe("POST /api/portal/[orgSlug]/[workspaceSlug]/vote — roadmap votes", () => {
  it("portalAuthRequired=true + valid session: session email + portalAccountId used, voterName still client-supplied", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue({
      portalAccountId: "account-1",
      email: "verified@example.com",
      name: null,
    });

    const res = await POST(
      makeRequest({
        type: "roadmap",
        itemId: "rm-1",
        voterEmail: "spoofed@example.com",
        voterName: "Jane",
      }),
      { params }
    );

    expect(res.status).toBe(200);
    expect(mockRoadmapVote.create).toHaveBeenCalledWith({
      data: {
        roadmapItemId: "rm-1",
        voterEmail: "verified@example.com",
        voterName: "Jane",
        portalAccountId: "account-1",
      },
    });
  });

  it("portalAuthRequired=true + no session: 401, no vote recorded", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ type: "roadmap", itemId: "rm-1" }), { params });
    expect(res.status).toBe(401);
    expect(mockRoadmapVote.create).not.toHaveBeenCalled();
  });

  it("rejects voting on a private roadmap item with 404, even with a valid session", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue({
      portalAccountId: "account-1",
      email: "verified@example.com",
      name: null,
    });
    mockRoadmapItem.findFirst.mockResolvedValue({ id: "rm-private", isPrivate: true });

    const res = await POST(
      makeRequest({ type: "roadmap", itemId: "rm-private", voterName: "Jane" }),
      { params }
    );
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBe("Roadmap item not found");
    expect(mockRoadmapVote.create).not.toHaveBeenCalled();
  });
});
