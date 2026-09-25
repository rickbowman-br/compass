import getPrisma from "@/lib/db"
import { resolveCommentAuthors } from "@/lib/comment-authors"
import { withWorkspaceUpdates, recordWorkspaceUpdate } from "@/lib/workspace-updates-capture"
import { workspaceMutationActor } from "@/lib/workspace-update-mutations"

export const COMMENT_TARGET_TYPES = [
  "OBJECTIVE", "KEY_RESULT", "OPPORTUNITY", "SOLUTION", "ASSUMPTION",
  "EXPERIMENT", "ROADMAP_ITEM", "FEEDBACK_ITEM", "TASK", "DOC", "ARTIFACT",
  "RESEARCH_STUDY", "REVIEW_REQUEST",
] as const

export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number]
export type CommentStatus = "OPEN" | "RESOLVED"
export type CommentAuthorType = "AGENT" | "HUMAN"
/// "WIDGET" is a comment submitted from an embedded feedback widget on a page
/// Compass does not serve. `source` is a plain VarChar(20) column, so widening
/// this union needs no migration.
export type CommentSource = "UI" | "MCP" | "MIGRATION" | "WIDGET"

export type DocAnchorInput = {
  anchorText: string
  anchorPrefix?: string | null
  anchorSuffix?: string | null
  anchorStart?: number | null
  anchorEnd?: number | null
}

export type SolutionPlanInput = {
  trackedDecisionRequestId?: string | null
  legacyPlanStatus?: "PENDING" | "APPROVED" | "REJECTED" | null
}

/// Where on a rendered page the comment was left. `elementFingerprint` ratios are
/// DOCUMENT-relative so re-anchoring does not depend on the reader's viewport.
export type ElementAnchorInput = {
  artifactRevisionId?: string | null
  pageUrl: string
  pagePath: string
  elementSelector?: string | null
  elementFingerprint?: {
    tag?: string
    text?: string
    rectXRatio?: number
    rectYRatio?: number
    rectWRatio?: number
    rectHRatio?: number
  } | null
  /**
   * Vercel Blob URL of a screenshot of the anchored element, or null.
   *
   * Callers must not pass a URL a submitter handed them verbatim. The embed
   * route validates the shape against the blob host and the embed prefix before
   * it reaches here (see lib/embed-screenshots.ts) precisely because this value
   * is rendered as an image to an internal reviewer, and an arbitrary URL there
   * would be a tracking pixel aimed at the org.
   */
  screenshotUrl?: string | null
}

/// Identity for an author who is not a Compass User, so `authorId` can stay a
/// User reference and stay null for outside submitters.
export type ExternalAuthorInput = {
  submitterEmail?: string | null
  portalAccountId?: string | null
  embedTokenId?: string | null
}

type CreateCommentInput = {
  id?: string
  workspaceId: string
  targetType: CommentTargetType
  targetId: string
  parentId?: string | null
  body: string
  status?: CommentStatus
  authorId?: string | null
  authorName: string
  authorType?: CommentAuthorType
  source?: CommentSource
  createdAt?: Date
  updatedAt?: Date
  docAnchor?: DocAnchorInput
  solutionPlan?: SolutionPlanInput
  elementAnchor?: ElementAnchorInput
  externalAuthor?: ExternalAuthorInput
}

export async function resolveCommentTarget(targetType: CommentTargetType, targetId: string) {
  const prisma = getPrisma()
  switch (targetType) {
    case "OBJECTIVE": {
      const row = await prisma.objective.findUnique({ where: { id: targetId }, select: { cycle: { select: { workspaceId: true } } } })
      return row ? { workspaceId: row.cycle.workspaceId } : null
    }
    case "KEY_RESULT": {
      const row = await prisma.keyResult.findUnique({ where: { id: targetId }, select: { objective: { select: { cycle: { select: { workspaceId: true } } } } } })
      return row ? { workspaceId: row.objective.cycle.workspaceId } : null
    }
    case "OPPORTUNITY": return prisma.opportunity.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "SOLUTION": {
      const row = await prisma.solution.findUnique({ where: { id: targetId }, select: { opportunity: { select: { workspaceId: true } } } })
      return row ? { workspaceId: row.opportunity.workspaceId } : null
    }
    case "ASSUMPTION": {
      const row = await prisma.assumption.findUnique({ where: { id: targetId }, select: { solution: { select: { opportunity: { select: { workspaceId: true } } } } } })
      return row ? { workspaceId: row.solution.opportunity.workspaceId } : null
    }
    case "EXPERIMENT": return prisma.experiment.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "ROADMAP_ITEM": return prisma.roadmapItem.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "FEEDBACK_ITEM": return prisma.feedbackItem.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "TASK": return prisma.task.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "DOC": return prisma.doc.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "ARTIFACT": return prisma.artifact.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "RESEARCH_STUDY": return prisma.researchStudy.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "REVIEW_REQUEST": {
      const row = await prisma.reviewRequest.findUnique({ where: { id: targetId }, select: { workspaceId: true, gateType: true } })
      return row?.gateType === "TRACKED_DECISION" ? { workspaceId: row.workspaceId } : null
    }
  }
}

function validateExtensions(input: CreateCommentInput) {
  if (input.docAnchor && (input.targetType !== "DOC" || input.parentId)) {
    throw new Error("Anchors are allowed only on root Doc comments.")
  }
  if (input.solutionPlan && (input.targetType !== "SOLUTION" || input.parentId)) {
    throw new Error("Plan proposals are allowed only on root Solution comments.")
  }
  if (input.docAnchor && !input.docAnchor.anchorText.trim()) throw new Error("Anchor text must not be empty.")
  // Element anchors are the Artifact analogue of a doc anchor: one per root
  // comment, and only where the target is the thing being rendered. The ARTIFACT
  // check is what keeps CommentElementAnchor.artifactId non-null by
  // construction — it is always the parent comment's targetId.
  if (input.elementAnchor && (input.targetType !== "ARTIFACT" || input.parentId)) {
    throw new Error("Element anchors are allowed only on root Artifact comments.")
  }
  if (input.elementAnchor && !input.elementAnchor.pageUrl.trim()) throw new Error("Element anchor page URL must not be empty.")
  if (input.elementAnchor && !input.elementAnchor.pagePath.trim()) throw new Error("Element anchor page path must not be empty.")
  // An external author, unlike an anchor, is valid on a reply too: an outside
  // submitter answering a question on their own thread is the normal case.
  if (input.externalAuthor && input.authorId) {
    throw new Error("A comment cannot have both a Compass author and an external author.")
  }
}

export async function createComment(input: CreateCommentInput) {
  const prisma = getPrisma()
  const body = input.body.trim()
  if (!body) throw new Error("Comment body must not be empty.")
  validateExtensions(input)

  const target = await resolveCommentTarget(input.targetType, input.targetId)
  if (!target) throw new Error(`${input.targetType} target not found or not commentable.`)
  if (target.workspaceId !== input.workspaceId) throw new Error("Comment target does not belong to the declared workspace.")

  if (input.parentId) {
    const parent = await prisma.comment.findUnique({ where: { id: input.parentId }, select: { id: true, workspaceId: true, targetType: true, targetId: true, parentId: true } })
    if (!parent || parent.workspaceId !== input.workspaceId || parent.targetType !== input.targetType || parent.targetId !== input.targetId) {
      throw new Error("Parent comment must share the exact workspace and target.")
    }
    if (parent.parentId) throw new Error("Comment threads are only one level deep.")
  }

  const comment = await withWorkspaceUpdates(prisma, async (tx, capture) => {
  const comment = await tx.comment.create({
    data: {
      ...(input.id ? { id: input.id } : {}), workspaceId: input.workspaceId,
      targetType: input.targetType, targetId: input.targetId, parentId: input.parentId ?? null,
      body, status: input.status ?? "OPEN", authorId: input.authorId ?? null,
      authorName: input.authorName, authorType: input.authorType ?? "HUMAN",
      source: input.source ?? "UI", ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    },
  })
  try {
    if (input.docAnchor) await tx.docCommentAnchor.create({ data: { commentId: comment.id, ...input.docAnchor } })
    if (input.solutionPlan) await tx.solutionPlanProposal.create({ data: { commentId: comment.id, trackedDecisionRequestId: input.solutionPlan.trackedDecisionRequestId ?? null, legacyPlanStatus: input.solutionPlan.legacyPlanStatus ?? null } })
    // artifactId is the comment's own targetId, never a caller-supplied value —
    // validateExtensions has already established targetType === "ARTIFACT".
    if (input.elementAnchor) await tx.commentElementAnchor.create({ data: { commentId: comment.id, artifactId: input.targetId, artifactRevisionId: input.elementAnchor.artifactRevisionId ?? null, pageUrl: input.elementAnchor.pageUrl, pagePath: input.elementAnchor.pagePath, elementSelector: input.elementAnchor.elementSelector ?? null, elementFingerprint: input.elementAnchor.elementFingerprint ?? undefined, screenshotUrl: input.elementAnchor.screenshotUrl ?? null } })
    if (input.externalAuthor) await tx.commentExternalAuthor.create({ data: { commentId: comment.id, submitterEmail: input.externalAuthor.submitterEmail ?? null, portalAccountId: input.externalAuthor.portalAccountId ?? null, embedTokenId: input.externalAuthor.embedTokenId ?? null } })
  } catch (error) {
    if (!capture) {
      // `capture === false` can mean `tx` is the plain client, so this delete is
      // the only rollback there is. A comment can now carry TWO extensions at
      // once (element anchor + external author), so the successful one has to be
      // removed first: relationMode="prisma" emulates `onDelete: Restrict`, and
      // leaving an extension row behind would make the compensating delete throw
      // a second error that masks the real one.
      await tx.commentElementAnchor.deleteMany({ where: { commentId: comment.id } })
      await tx.commentExternalAuthor.deleteMany({ where: { commentId: comment.id } })
      await tx.docCommentAnchor.deleteMany({ where: { commentId: comment.id } })
      await tx.solutionPlanProposal.deleteMany({ where: { commentId: comment.id } })
      await tx.comment.delete({ where: { id: comment.id } })
    }
    throw error
  }
  if (capture && !input.parentId && input.source !== "MIGRATION" && ["TASK", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "EXPERIMENT", "ROADMAP_ITEM", "REVIEW_REQUEST"].includes(input.targetType)) {
    const actor = await workspaceMutationActor(input.source === "MCP" ? "MCP" : "UI")
    await recordWorkspaceUpdate(tx, { workspaceId: input.workspaceId, entityType: "COMMENT", entityId: comment.id, groupType: input.targetType === "REVIEW_REQUEST" ? "DECISION" : input.targetType, groupId: input.targetId, kind: input.solutionPlan ? "PLAN_PROPOSED" : "COMMENT_ADDED", ...actor })
  }
  return comment
  })
  return getComment(comment.id)
}

export async function listComments(workspaceId: string, targetType: CommentTargetType, targetId: string, status?: CommentStatus) {
  const comments = await getPrisma().comment.findMany({
    where: { workspaceId, targetType, targetId, ...(status ? { status } : {}) },
    include: { docAnchor: true, solutionPlanProposal: true, elementAnchor: true, externalAuthor: true }, orderBy: { createdAt: "asc" },
  })
  return resolveCommentAuthors(comments)
}

export async function getComment(commentId: string) {
  const comment = await getPrisma().comment.findUnique({ where: { id: commentId }, include: { docAnchor: true, solutionPlanProposal: true, elementAnchor: true, externalAuthor: true } })
  return comment ? (await resolveCommentAuthors([comment]))[0] : null
}

export async function updateCommentBody(commentId: string, body: string) {
  const prisma = getPrisma(); const trimmed = body.trim()
  if (!trimmed) throw new Error("Comment body must not be empty.")
  if (!await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } })) return null
  await prisma.comment.update({ where: { id: commentId }, data: { body: trimmed, updatedAt: new Date() } })
  return getComment(commentId)
}

export async function setCommentStatus(commentId: string, status: CommentStatus) {
  const prisma = getPrisma()
  if (!await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } })) return null
  await prisma.comment.update({ where: { id: commentId }, data: { status, updatedAt: new Date() } })
  return getComment(commentId)
}

export async function deleteComment(commentId: string) {
  const prisma = getPrisma()
  const existing = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true, parentId: true } })
  if (!existing) return null
  const replies = existing.parentId ? [] : await prisma.comment.findMany({ where: { parentId: commentId }, select: { id: true } })
  const ids = [...replies.map((reply) => reply.id), commentId]
  await prisma.docCommentAnchor.deleteMany({ where: { commentId: { in: ids } } })
  await prisma.solutionPlanProposal.deleteMany({ where: { commentId: { in: ids } } })
  await prisma.commentElementAnchor.deleteMany({ where: { commentId: { in: ids } } })
  await prisma.commentExternalAuthor.deleteMany({ where: { commentId: { in: ids } } })
  if (!existing.parentId) await prisma.comment.deleteMany({ where: { parentId: commentId } })
  await prisma.comment.delete({ where: { id: commentId } })
  return { id: commentId, deletedReplies: replies.length }
}
