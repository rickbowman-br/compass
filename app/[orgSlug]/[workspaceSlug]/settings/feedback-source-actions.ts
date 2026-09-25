"use server";

/**
 * Server actions for feedback sources — the admin half of the embed credential.
 *
 * ## Why these return a result object instead of throwing
 *
 * Next redacts the message of an uncaught server-action error in production, so
 * a thrown `EmbedOriginError` would reach the operator as "An unexpected error
 * occurred" — losing the one thing that tells them how to fix their typo. Every
 * expected failure below is therefore returned as `{ ok: false, error }`, the
 * shape lib/analytics/action-result.ts already established for the same reason.
 * Unexpected failures are logged server-side and reported generically.
 *
 * ## Why workspace admin, not workspace member
 *
 * Minting an embed token creates a credential that lets an arbitrary page write
 * comments into this workspace, and editing the origin allowlist decides which
 * pages those are. That is a higher bar than changing a WIP limit, so these use
 * resolveWorkspaceAdmin (which also admits org admins) rather than the
 * membership-only resolveWorkspace used by most of settings/actions.ts.
 *
 * ## There is no delete
 *
 * Disabling a source is the off switch, and revoking a token is the kill switch.
 * Deleting one would orphan every Comment and CommentElementAnchor already filed
 * through it, and Aurora DSQL enforces no cascades, so the cleanup would have to
 * be hand-rolled here — deleting public feedback as a side effect of tidying up
 * a settings list. Not offered on purpose.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions";
import {
  EmbedOriginError,
  mintEmbedToken,
  normalizeAllowedOrigins,
  revokeEmbedToken,
} from "@/lib/embed-sources";

const MAX_NAME_LENGTH = 255;
const MAX_LABEL_LENGTH = 255;

/** Operator-facing input failures, distinct from a bug or a permission denial. */
class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

type Err = { ok: false; error: string };

export type CreateFeedbackSourceResult =
  | { ok: true; id: string; token: string; tokenId: string; tokenPrefix: string; allowedOrigins: string[] }
  | Err;

export type UpdateFeedbackSourceResult =
  | { ok: true; allowedOrigins: string[]; name: string; enabled: boolean }
  | Err;

export type MintFeedbackSourceTokenResult =
  | { ok: true; token: string; tokenId: string; tokenPrefix: string }
  | Err;

export type RevokeFeedbackSourceTokenResult = { ok: true } | Err;

async function guard<T extends { ok: true }>(run: () => Promise<T>): Promise<T | Err> {
  try {
    return await run();
  } catch (error) {
    // Both carry messages written for a human to read and act on.
    if (error instanceof EmbedOriginError || error instanceof InputError) {
      return { ok: false, error: error.message };
    }
    if (isPermissionError(error)) return { ok: false, error: error.message };
    console.error("[feedback-sources] action failed", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new InputError("Give this feedback source a name.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new InputError(`A name may be at most ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

function optionalLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (!label) return null;
  if (label.length > MAX_LABEL_LENGTH) {
    throw new InputError(`A token label may be at most ${MAX_LABEL_LENGTH} characters.`);
  }
  return label;
}

/**
 * Resolves the caller as a workspace admin and returns their user id alongside.
 *
 * `resolveWorkspaceAdmin` deliberately returns no user id, but `createdById` on
 * both tables wants one, so the session is read again here rather than widening
 * a helper the whole app shares.
 */
async function adminContext(orgSlug: string, workspaceSlug: string) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  const session = await auth();
  return { prisma, workspaceId, userId: session?.user?.id ?? null };
}

/**
 * A source is only usable when bound to an artifact in *this* workspace —
 * resolveEmbedToken refuses an unbound source with a 501, and a cross-workspace
 * binding would let an admin of one workspace open a write path into another.
 */
async function requireArtifact(
  prisma: Awaited<ReturnType<typeof adminContext>>["prisma"],
  workspaceId: string,
  artifactId: string
): Promise<string> {
  const id = artifactId.trim();
  if (!id) throw new InputError("Choose which prototype this feedback belongs to.");
  const artifact = await prisma.artifact.findFirst({
    where: { id, workspaceId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!artifact) throw new InputError("That prototype no longer exists in this workspace.");
  return artifact.id;
}

export async function createFeedbackSource(
  orgSlug: string,
  workspaceSlug: string,
  input: { name: string; artifactId: string; allowedOrigins: string[] }
): Promise<CreateFeedbackSourceResult> {
  return guard(async () => {
    const { prisma, workspaceId, userId } = await adminContext(orgSlug, workspaceSlug);
    const name = requireName(input.name);
    const allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins);
    const artifactId = await requireArtifact(prisma, workspaceId, input.artifactId);

    const source = await prisma.feedbackSource.create({
      data: { workspaceId, artifactId, name, allowedOrigins, enabled: true, createdById: userId },
      select: { id: true },
    });
    // Minted in the same action rather than as a second step: a source with no
    // token cannot be embedded, and making the operator press two buttons to
    // reach a usable state is how half-configured sources happen.
    const minted = await mintEmbedToken({
      feedbackSourceId: source.id,
      label: "Initial token",
      createdById: userId,
    });

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return {
      ok: true as const,
      id: source.id,
      token: minted.token,
      tokenId: minted.tokenId,
      tokenPrefix: minted.tokenPrefix,
      allowedOrigins,
    };
  });
}

export async function updateFeedbackSource(
  orgSlug: string,
  workspaceSlug: string,
  sourceId: string,
  input: { name?: string; allowedOrigins?: string[]; enabled?: boolean }
): Promise<UpdateFeedbackSourceResult> {
  return guard(async () => {
    const { prisma, workspaceId } = await adminContext(orgSlug, workspaceSlug);

    // Scoped by workspaceId, not just id: `sourceId` arrives from the browser and
    // a valid uuid belonging to another workspace must not be editable here.
    const existing = await prisma.feedbackSource.findFirst({
      where: { id: sourceId, workspaceId },
      select: { id: true, name: true, allowedOrigins: true, enabled: true },
    });
    if (!existing) throw new InputError("That feedback source no longer exists.");

    const name = input.name === undefined ? existing.name : requireName(input.name);
    const allowedOrigins =
      input.allowedOrigins === undefined
        ? (existing.allowedOrigins as string[])
        : normalizeAllowedOrigins(input.allowedOrigins);
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled;

    await prisma.feedbackSource.update({
      where: { id: existing.id },
      data: { name, allowedOrigins, enabled, updatedAt: new Date() },
    });

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const, name, allowedOrigins, enabled };
  });
}

export async function mintFeedbackSourceToken(
  orgSlug: string,
  workspaceSlug: string,
  sourceId: string,
  label?: string | null
): Promise<MintFeedbackSourceTokenResult> {
  return guard(async () => {
    const { prisma, workspaceId, userId } = await adminContext(orgSlug, workspaceSlug);
    const source = await prisma.feedbackSource.findFirst({
      where: { id: sourceId, workspaceId },
      select: { id: true },
    });
    if (!source) throw new InputError("That feedback source no longer exists.");

    const minted = await mintEmbedToken({
      feedbackSourceId: source.id,
      label: optionalLabel(label),
      createdById: userId,
    });

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const, token: minted.token, tokenId: minted.tokenId, tokenPrefix: minted.tokenPrefix };
  });
}

export async function revokeFeedbackSourceToken(
  orgSlug: string,
  workspaceSlug: string,
  tokenId: string
): Promise<RevokeFeedbackSourceTokenResult> {
  return guard(async () => {
    const { prisma, workspaceId } = await adminContext(orgSlug, workspaceSlug);
    // The workspace is reached through the parent source, so this is the same
    // cross-workspace guard as above — a token id alone proves nothing.
    const token = await prisma.feedbackSourceToken.findFirst({
      where: { id: tokenId, feedbackSource: { workspaceId } },
      select: { id: true },
    });
    if (!token) throw new InputError("That token no longer exists.");

    // False means it was already revoked. Reported as success: the caller asked
    // for a state that now holds, and an error would only be confusing.
    await revokeEmbedToken(token.id);

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const };
  });
}
