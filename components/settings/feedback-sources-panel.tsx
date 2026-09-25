"use client"

/**
 * Feedback sources: the admin surface for the embeddable widget's credential.
 *
 * Three things a source needs to be usable, all editable here: an artifact to
 * file comments against, an exact-match origin allowlist, and at least one live
 * token. The panel is deliberately explicit that a token is shown once — it is
 * stored only as a SHA-256 hash, so a lost one is re-minted, never recovered.
 *
 * Only semantic color tokens are used below. `scripts/check-ui-colors.mjs`
 * baselines raw Tailwind palette utilities per `file::class`, and a new file
 * starts at a baseline of zero — so this deliberately does not copy
 * manage-api-keys-panel.tsx's reveal-banner colors, whose palette utilities are
 * grandfathered into that file's baseline and would fail the gate here. (The
 * check reads the file as text, so naming such a class even in a comment trips
 * it: that is how this paragraph came to be worded without one.)
 */

import { useState, useTransition } from "react"
import {
  createFeedbackSource,
  mintFeedbackSourceToken,
  revokeFeedbackSourceToken,
  updateFeedbackSource,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/feedback-source-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type FeedbackSourceTokenRow = {
  id: string
  tokenPrefix: string
  label: string | null
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
  expiresAt: Date | null
}

export type FeedbackSourceRow = {
  id: string
  name: string
  artifactId: string | null
  artifactTitle: string | null
  allowedOrigins: string[]
  enabled: boolean
  tokens: FeedbackSourceTokenRow[]
}

export type ArtifactOption = { id: string; title: string }

type Props = {
  orgSlug: string
  workspaceSlug: string
  initialSources: FeedbackSourceRow[]
  artifacts: ArtifactOption[]
  /**
   * Absolute Compass origin for the copyable snippet, or null when the
   * deployment origin is not configured — see optionalCompassUrl in
   * lib/compass-url.ts. Resolved on the server so the first client render matches
   * it; reading `window.location.origin` during render would not.
   */
  embedBaseUrl: string | null
  /**
   * `Workspace.artifactFeedbackPublic`. A source can be fully configured while
   * this is off, in which case the widget's read path 403s — worth saying out
   * loud here rather than leaving someone to debug it from the widget.
   */
  artifactFeedbackPublic: boolean
}

function linesToOrigins(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean)
}

export function FeedbackSourcesPanel({
  orgSlug,
  workspaceSlug,
  initialSources,
  artifacts,
  embedBaseUrl,
  artifactFeedbackPublic,
}: Props) {
  const [sources, setSources] = useState<FeedbackSourceRow[]>(initialSources)
  const [isPending, startTransition] = useTransition()

  // Create form
  const [newName, setNewName] = useState("")
  const [newArtifactId, setNewArtifactId] = useState("")
  const [newOrigins, setNewOrigins] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)

  // Per-source scratch state, keyed by source id so two cards cannot share one
  // draft or one error message.
  const [originDrafts, setOriginDrafts] = useState<Record<string, string>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({})

  /** The single revealed token, if any. Never more than one at a time. */
  const [revealed, setRevealed] = useState<{ sourceId: string; token: string } | null>(null)

  function setRowError(sourceId: string, error: string | null) {
    setRowErrors((prev) => ({ ...prev, [sourceId]: error }))
  }

  function handleCreate() {
    setCreateError(null)
    if (!newName.trim()) return setCreateError("Give this feedback source a name.")
    if (!newArtifactId) return setCreateError("Choose which prototype this feedback belongs to.")
    startTransition(async () => {
      const result = await createFeedbackSource(orgSlug, workspaceSlug, {
        name: newName.trim(),
        artifactId: newArtifactId,
        allowedOrigins: linesToOrigins(newOrigins),
      })
      if (!result.ok) return setCreateError(result.error)
      const artifactTitle = artifacts.find((a) => a.id === newArtifactId)?.title ?? null
      setSources((prev) => [
        ...prev,
        {
          id: result.id,
          name: newName.trim(),
          artifactId: newArtifactId,
          artifactTitle,
          allowedOrigins: result.allowedOrigins,
          enabled: true,
          tokens: [
            {
              id: result.tokenId,
              tokenPrefix: result.tokenPrefix,
              label: "Initial token",
              createdAt: new Date(),
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: null,
            },
          ],
        },
      ])
      setRevealed({ sourceId: result.id, token: result.token })
      setNewName("")
      setNewArtifactId("")
      setNewOrigins("")
    })
  }

  function handleToggleEnabled(source: FeedbackSourceRow, enabled: boolean) {
    setRowError(source.id, null)
    // Optimistic: the switch must not feel laggy. Rolled back below on failure.
    setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, enabled } : s)))
    startTransition(async () => {
      const result = await updateFeedbackSource(orgSlug, workspaceSlug, source.id, { enabled })
      if (!result.ok) {
        setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, enabled: !enabled } : s)))
        setRowError(source.id, result.error)
      }
    })
  }

  function handleSaveOrigins(source: FeedbackSourceRow) {
    const draft = originDrafts[source.id]
    if (draft === undefined) return
    setRowError(source.id, null)
    startTransition(async () => {
      const result = await updateFeedbackSource(orgSlug, workspaceSlug, source.id, {
        allowedOrigins: linesToOrigins(draft),
      })
      if (!result.ok) return setRowError(source.id, result.error)
      // Replaced with the server's canonical form, not the draft: the operator
      // may have typed `HTTPS://Example.com/` and what actually gates requests is
      // what came back.
      setSources((prev) =>
        prev.map((s) => (s.id === source.id ? { ...s, allowedOrigins: result.allowedOrigins } : s))
      )
      setOriginDrafts((prev) => {
        const next = { ...prev }
        delete next[source.id]
        return next
      })
    })
  }

  function handleMint(source: FeedbackSourceRow) {
    setRowError(source.id, null)
    startTransition(async () => {
      const result = await mintFeedbackSourceToken(orgSlug, workspaceSlug, source.id, "Rotated token")
      if (!result.ok) return setRowError(source.id, result.error)
      setSources((prev) =>
        prev.map((s) =>
          s.id === source.id
            ? {
                ...s,
                tokens: [
                  ...s.tokens,
                  {
                    id: result.tokenId,
                    tokenPrefix: result.tokenPrefix,
                    label: "Rotated token",
                    createdAt: new Date(),
                    lastUsedAt: null,
                    revokedAt: null,
                    expiresAt: null,
                  },
                ],
              }
            : s
        )
      )
      setRevealed({ sourceId: source.id, token: result.token })
    })
  }

  function handleRevoke(source: FeedbackSourceRow, tokenId: string) {
    setRowError(source.id, null)
    startTransition(async () => {
      const result = await revokeFeedbackSourceToken(orgSlug, workspaceSlug, tokenId)
      if (!result.ok) return setRowError(source.id, result.error)
      setSources((prev) =>
        prev.map((s) =>
          s.id === source.id
            ? { ...s, tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, revokedAt: new Date() } : t)) }
            : s
        )
      )
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {!artifactFeedbackPublic && sources.length > 0 && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          Public feedback on artifacts is turned off for this workspace, so the widget cannot load existing
          comments. Turn on artifact feedback to make these sources readable.
        </p>
      )}

      {/* Existing sources */}
      {sources.map((source) => {
        const draft = originDrafts[source.id]
        const originsText = draft ?? source.allowedOrigins.join("\n")
        const dirty = draft !== undefined && draft !== source.allowedOrigins.join("\n")
        const activeTokens = source.tokens.filter((t) => !t.revokedAt)
        const error = rowErrors[source.id]
        const snippet = embedBaseUrl
          ? `<script src="${embedBaseUrl}/embed/widget.js" data-compass-token="cmpfb_…" defer></script>`
          : null

        return (
          <div
            key={source.id}
            data-testid={`feedback-source-${source.id}`}
            className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{source.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {source.artifactTitle ? `Files comments on ${source.artifactTitle}` : "Not bound to a prototype"}
                </span>
              </div>
              <Switch
                data-testid={`feedback-source-toggle-${source.id}`}
                aria-label={`Enable ${source.name}`}
                checked={source.enabled}
                disabled={isPending}
                onCheckedChange={(checked) => handleToggleEnabled(source, checked)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`origins-${source.id}`} className="text-xs">
                Allowed origins — one per line, exact match
              </Label>
              <Textarea
                id={`origins-${source.id}`}
                rows={Math.max(2, source.allowedOrigins.length + 1)}
                value={originsText}
                placeholder="https://my-prototype.vercel.app"
                disabled={isPending}
                onChange={(e) => setOriginDrafts((prev) => ({ ...prev, [source.id]: e.target.value }))}
                className="font-mono text-xs"
              />
              {source.allowedOrigins.length === 0 && !dirty && (
                <p className="text-xs text-muted-foreground">
                  No origins listed, so every request is refused. Add the site this prototype is served from.
                </p>
              )}
              {dirty && (
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={isPending} onClick={() => handleSaveOrigins(source)}>
                    Save origins
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() =>
                      setOriginDrafts((prev) => {
                        const next = { ...prev }
                        delete next[source.id]
                        return next
                      })
                    }
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>

            {/* Tokens */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Tokens</span>
              {activeTokens.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No live token. Mint one to let this prototype submit feedback.
                </p>
              )}
              {source.tokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className={token.revokedAt ? "font-mono text-text-subtle line-through" : "font-mono"}>
                    cmpfb_{token.tokenPrefix}…
                  </span>
                  <span className="flex-1 truncate text-muted-foreground">
                    {token.label ?? "Unlabeled"}
                    {token.lastUsedAt ? ` · last used ${token.lastUsedAt.toLocaleDateString()}` : " · never used"}
                  </span>
                  {token.revokedAt ? (
                    <span className="text-text-subtle">Revoked</span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleRevoke(source, token.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => handleMint(source)}
                className="self-start"
              >
                Mint a new token
              </Button>
            </div>

            {revealed?.sourceId === source.id && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted p-3">
                <p className="text-xs font-semibold">Copy this token now — it is never shown again.</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded border border-border bg-surface-panel px-2 py-1 font-mono text-xs">
                    {revealed.token}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void navigator.clipboard.writeText(revealed.token)}
                  >
                    Copy
                  </Button>
                </div>
                {snippet ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Paste this into the prototype, with the token above in place of the placeholder:
                    </p>
                    <code className="break-all rounded border border-border bg-surface-panel px-2 py-1 font-mono text-xs">
                      {snippet}
                    </code>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Set NEXT_PUBLIC_APP_URL to show the embed snippet for this deployment.
                  </p>
                )}
                <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => setRevealed(null)}>
                  I&apos;ve saved it ✓
                </Button>
              </div>
            )}

            {error && <p className="text-xs text-status-danger">{error}</p>}
          </div>
        )
      })}

      {sources.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No feedback sources yet. Create one to collect element-anchored feedback from a prototype.
        </p>
      )}

      {/* Create form */}
      {artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          A feedback source files comments against an artifact, and this workspace has none yet. Add a prototype
          under Artifacts first.
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-border border-dashed px-4 py-3.5">
          <span className="text-sm font-medium">New feedback source</span>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-feedback-source-name" className="text-xs">
              Name
            </Label>
            <Input
              id="new-feedback-source-name"
              value={newName}
              placeholder="Checkout prototype"
              disabled={isPending}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-feedback-source-artifact" className="text-xs">
              Prototype
            </Label>
            <Select value={newArtifactId} onValueChange={(value) => setNewArtifactId(value ?? "")}>
              <SelectTrigger id="new-feedback-source-artifact" aria-label="Prototype" className="w-full">
                <SelectValue placeholder="Choose an artifact" />
              </SelectTrigger>
              <SelectContent>
                {artifacts.map((artifact) => (
                  <SelectItem key={artifact.id} value={artifact.id}>
                    {artifact.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-feedback-source-origins" className="text-xs">
              Allowed origins — one per line, exact match
            </Label>
            <Textarea
              id="new-feedback-source-origins"
              rows={2}
              value={newOrigins}
              placeholder="https://my-prototype.vercel.app"
              disabled={isPending}
              onChange={(e) => setNewOrigins(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          {createError && <p className="text-xs text-status-danger">{createError}</p>}
          <Button type="button" className="self-start" disabled={isPending} onClick={handleCreate}>
            Create and mint a token
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        A token is shown once and stored only as a hash. To rotate one, mint a second, deploy it, then revoke the
        first — the source keeps its origins and its existing comments.
      </p>
    </div>
  )
}
