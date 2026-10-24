"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Bot, OctagonX } from "lucide-react"

import { Button } from "@/components/ui/button"
import { parseSseFrames } from "@/lib/sse-frames"
import { resolveNavigationPath, UI_SCREENSHOT_MAX_BASE64, type UiCommandKind } from "@/lib/ui-control"

/**
 * "Let agent drive".
 *
 * The user opts a tab in; from then on an agent can move it between screens,
 * read where it is, and ask for a screenshot of what is on screen. It cannot
 * click or type. While on, a banner with a Stop button is always visible, and
 * every element of this component is marked `data-agent-drive-ui` so it is left
 * out of screenshots.
 *
 * Deliberately lives in the workspace layout: that is the only component that
 * survives navigation between screens, which is exactly what the agent causes.
 */

type StreamCommand = { id: string; kind: UiCommandKind; args: Record<string, unknown> }
type Phase = "off" | "connecting" | "on"

const newTabId = () => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function visibleHeadings(): string[] {
  const out: string[] = []
  for (const el of Array.from(document.querySelectorAll("h1, h2, h3"))) {
    if (el.closest("[data-agent-drive-ui]")) continue
    const rect = (el as HTMLElement).getBoundingClientRect()
    const inView = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0
    const text = el.textContent?.trim()
    if (inView && text) out.push(text.slice(0, 120))
    if (out.length >= 20) break
  }
  return out
}

async function captureScreenshot() {
  const { toPng } = await import("html-to-image")
  // Smaller pixel ratios until the PNG fits the server's ceiling.
  for (const pixelRatio of [1, 0.6, 0.4, 0.25]) {
    const dataUrl = await toPng(document.body, {
      pixelRatio,
      cacheBust: true,
      width: window.innerWidth,
      height: window.innerHeight,
      filter: (node) => !(node instanceof HTMLElement && node.hasAttribute("data-agent-drive-ui")),
    })
    const pngBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
    if (pngBase64.length <= UI_SCREENSHOT_MAX_BASE64) {
      return {
        pngBase64,
        path: window.location.pathname + window.location.search,
        width: Math.round(window.innerWidth * pixelRatio),
        height: Math.round(window.innerHeight * pixelRatio),
      }
    }
  }
  throw new Error("Screenshot is too large to send even when downscaled.")
}

export function AgentDrive({ workspaceId, basePath }: { workspaceId: string; basePath: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const [phase, setPhase] = useState<Phase>("off")
  const [error, setError] = useState<string | null>(null)
  const tabId = useRef<string>("")
  const sessionId = useRef<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const navigateRef = useRef(router.push)
  navigateRef.current = router.push

  const postResult = useCallback(async (commandId: string, body: { ok: boolean; result?: unknown; error?: string }) => {
    await fetch(`/api/ui-control/commands/${commandId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  }, [])

  const execute = useCallback(
    async (command: StreamCommand) => {
      try {
        if (command.kind === "navigate") {
          // Validated again here: the server already did, but the browser is the
          // last line of defence for where it will agree to go.
          const target = resolveNavigationPath(String(command.args.path ?? ""), basePath)
          navigateRef.current(target)
          // Give the route a beat to commit so the reported title is the new one.
          await new Promise((resolve) => setTimeout(resolve, 600))
          await postResult(command.id, { ok: true, result: { path: target, title: document.title } })
        } else if (command.kind === "get_state") {
          await postResult(command.id, {
            ok: true,
            result: {
              path: window.location.pathname + window.location.search,
              title: document.title,
              headings: visibleHeadings(),
              viewport: { width: window.innerWidth, height: window.innerHeight },
            },
          })
        } else if (command.kind === "screenshot") {
          await postResult(command.id, { ok: true, result: await captureScreenshot() })
        } else {
          await postResult(command.id, { ok: false, error: `Unsupported command: ${String(command.kind)}` })
        }
      } catch (e) {
        await postResult(command.id, { ok: false, error: e instanceof Error ? e.message : "Command failed." })
      }
    },
    [basePath, postResult],
  )

  const stop = useCallback(async () => {
    abort.current?.abort()
    abort.current = null
    const id = sessionId.current
    sessionId.current = null
    setPhase("off")
    if (id) {
      await fetch("/api/ui-control/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
        keepalive: true,
      }).catch(() => undefined)
    }
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setPhase("connecting")
    if (!tabId.current) tabId.current = newTabId()
    try {
      const res = await fetch("/api/ui-control/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, tabId: tabId.current, currentPath: window.location.pathname }),
      })
      if (!res.ok) throw new Error("Could not start agent control.")
      const { sessionId: id } = (await res.json()) as { sessionId: string }
      sessionId.current = id
      const controller = new AbortController()
      abort.current = controller
      setPhase("on")

      // Reader loop: reconnects until the user stops or the server ends the session.
      void (async () => {
        let backoff = 500
        while (!controller.signal.aborted) {
          let ended = false
          try {
            const stream = await fetch(`/api/ui-control/stream?sessionId=${id}`, { signal: controller.signal })
            if (stream.status === 410 || stream.status === 401 || stream.status === 404) break
            if (!stream.ok || !stream.body) throw new Error("stream unavailable")
            backoff = 500
            const reader = stream.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const parsed = parseSseFrames(buffer)
              buffer = parsed.rest
              for (const frame of parsed.frames) {
                if (frame.event === "command") void execute(JSON.parse(frame.data) as StreamCommand)
                else if (frame.event === "ended") ended = true
              }
            }
          } catch {
            if (controller.signal.aborted) return
          }
          if (ended) break
          await new Promise((resolve) => setTimeout(resolve, backoff))
          backoff = Math.min(backoff * 2, 8_000)
        }
        if (!controller.signal.aborted) {
          abort.current = null
          sessionId.current = null
          setPhase("off")
        }
      })()
    } catch (e) {
      setPhase("off")
      setError(e instanceof Error ? e.message : "Could not start agent control.")
    }
  }, [execute, workspaceId])

  // Report location changes so the server knows where this tab is.
  useEffect(() => {
    const id = sessionId.current
    if (phase !== "on" || !id) return
    void fetch("/api/ui-control/session", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, currentPath: pathname }),
    }).catch(() => undefined)
  }, [pathname, phase])

  // Leaving the workspace layout (or the page) ends control.
  useEffect(() => {
    const onHide = () => {
      const id = sessionId.current
      if (id) {
        void fetch("/api/ui-control/session", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id }),
          keepalive: true,
        }).catch(() => undefined)
      }
    }
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      abort.current?.abort()
      onHide()
    }
  }, [])

  if (phase === "off") {
    return (
      <div data-agent-drive-ui className="fixed bottom-4 right-4 z-50 hidden md:block">
        <Button type="button" variant="outline" size="sm" onClick={start} title="Allow an agent to move you between screens and see this screen">
          <Bot className="size-4" />
          Let agent drive
        </Button>
        {error ? <p role="alert" className="mt-1 max-w-56 text-xs text-destructive">{error}</p> : null}
      </div>
    )
  }

  return (
    <div
      data-agent-drive-ui
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-full border bg-background px-4 py-2 text-sm shadow-lg"
    >
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-warning opacity-75" />
        <span className="relative inline-flex size-2.5 rounded-full bg-status-warning" />
      </span>
      <span>{phase === "connecting" ? "Connecting…" : "An agent can move this tab and see your screen"}</span>
      <Button type="button" variant="destructive" size="sm" onClick={stop}>
        <OctagonX className="size-4" />
        Stop
      </Button>
    </div>
  )
}
