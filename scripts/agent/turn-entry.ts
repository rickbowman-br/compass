// Agent turn entry script — runs INSIDE a Vercel Sandbox booted from the golden
// snapshot (deps pre-installed; see lib/agent-sandbox.ts). The host route
// (app/api/agent/turn/route.ts) writes this file into the sandbox and runs it
// per turn.
//
// It points the Claude Agent SDK at Compass's OWN /api/mcp catalog over HTTP,
// authenticated with an ephemeral per-user `cmp_` key — so the agent acts AS
// the user and Phase 1's per-user authorization scopes every tool. No custom
// tools, no DB access: the sandbox only makes authenticated MCP calls.
//
// ── Two transports, on purpose ──────────────────────────────────────────────
//
// stdout is kept exactly as it was: one prefixed JSON object per line. It is
// what the synchronous fallback path drains, and it is the only thing available
// when debugging a sandbox by hand.
//
// Additionally, when AGENT_RUN_ID + AGENT_RUN_TOKEN are present, every event is
// POSTed back to Compass in batches with a monotonic `seq`, plus a periodic
// heartbeat. That is what lets the run outlive the request that started it: the
// database, not the response body, becomes the durable seam. With those two vars
// absent this file behaves exactly as it did before, which is what makes the
// pre-migration fallback possible.
//
// Required env (passed at runCommand time, never baked into the snapshot):
//   AGENT_MODEL                model id for the Agent SDK (host resolves it from
//                              AGENT_MODEL_PROVIDER / AGENT_MODEL_ID)
//   ANTHROPIC_API_KEY          Claude API key (provider "anthropic", the default)
//   -- or, provider "bedrock" --
//   AWS_BEARER_TOKEN_BEDROCK   long-lived Bedrock bearer token
//   CLAUDE_CODE_USE_BEDROCK    "1" - routes the Agent SDK at Bedrock
//   AWS_REGION                 Bedrock region
//   MCP_BASE_URL               Compass origin to call back into (/api/mcp, and
//                              the run callbacks below)
//   MCP_TOKEN                  ephemeral per-user cmp_ key (scopes the agent)
//   AGENT_PROMPT               the assembled prompt (history + user turn)
//   MCP_BYPASS_SECRET          (optional) x-vercel-protection-bypass for
//                              protected preview deployments; unused in prod
//   AGENT_MCP_CONNECTORS       (optional) JSON [{ slug, displayName, guidance? }]
//                              — third-party MCP servers this user has connected
//                              (ADR-0018). Slugs only: each is reached through a
//                              Compass gateway path with the turn credential
//                              above, so no provider token is passed in here.
//   AGENT_GITHUB_SHELL         (optional) "1" when the host enabled Bash + GitHub for this
//                              turn (workspace has an approved repo list and a token was
//                              minted). Together with GH_TOKEN / AGENT_GITHUB_REPOS and
//                              DOCS_ROOT it gates the shell; see github-access.ts.
//   AGENT_RUN_ID               (optional) durable run this turn belongs to
//   AGENT_RUN_TOKEN            (optional) that run's worker bearer token — a
//                              separate credential from MCP_TOKEN on purpose,
//                              so forging a transcript and acting as the user
//                              are not the same capability
//   AGENT_RUN_HEARTBEAT_MS     (optional) heartbeat interval; default 15000
//   AGENT_MAX_TURNS            (optional) per-run turn cap; default 30
//   AGENT_SESSION_ID           (optional) UUID of the Agent SDK session this turn
//                              belongs to. With it the transcript is mirrored to an
//                              in-memory SessionStore and handed back to Compass at
//                              the end, so the NEXT turn can resume it. Absent => stateless, as before.
//   AGENT_SESSION_MODE         "resume" (session-in.jsonl.gz holds the prior
//                              transcript; AGENT_PROMPT is only the new message and
//                              fallback-prompt.txt is the full text replay) or
//                              "new" (AGENT_PROMPT is the full prompt).
//
// Session files (sandbox cwd): session-in.jsonl.gz is read when resuming;
// session-out.jsonl.gz is written on success for the synchronous path, which has no
// upload channel. Detached runs POST it to /api/internal/agent/runs/:id/session
// BEFORE reporting their terminal event (the worker token dies with the run).
//
// Output contract (one JSON object per line, prefixed):
//   AGENT_EVENT <json>     — each SDK stream message (assistant/tool/system)
//   AGENT_DOC_STATE <json> — final materialized doc tree (ADR 0019 §2.4), emitted
//                            once after query() finishes and before AGENT_RESULT
//   AGENT_RESULT <json>    — final { text, usage } on success
//   AGENT_ERROR <json>     — { message } on failure
//   AGENT_SESSION <json>   — { sessionId } the session a successful turn ended in
//                            (differs from AGENT_SESSION_ID after a resume fallback)

import { mkdir } from "node:fs/promises"
import { query, createSdkMcpServer, tool, type Options, type SessionKey, type SessionStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { openWikiSession, type WikiSession } from "@rbcodelabs/geode-headless/wiki"
import {
  createAllowedUrls,
  createDocsPreToolUseHook,
  createSearchResultCollector,
  createWebFetchPreToolUseHook,
  DOCS_GUARDED_TOOLS_MATCHER,
  scrubbedAgentEnv,
  WEB_FETCH_MATCHER,
  WEB_SEARCH_MATCHER,
} from "./docs-path-guard.ts"
import {
  agentTools,
  BASH_MATCHER,
  createBashPreToolUseHook,
  githubAccessFromEnv,
  prepareBashJail,
  REPOS_DIR,
  SHELL_UNAVAILABLE_NOTICE,
} from "./github-access.ts"
import { collectFinalDocState, isValidDocName, type CollectedDocState } from "./docs-final-state.ts"
import { DEFAULT_HEARTBEAT_MS, RunReporter } from "./run-reporter.ts"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"

const MCP_BASE_URL = process.env.MCP_BASE_URL
const MCP_TOKEN = process.env.MCP_TOKEN
const AGENT_PROMPT = process.env.AGENT_PROMPT
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT
const AGENT_PACK_CONFIG = process.env.AGENT_PACK_CONFIG
const MCP_BYPASS_SECRET = process.env.MCP_BYPASS_SECRET
const AGENT_MCP_CONNECTORS = process.env.AGENT_MCP_CONNECTORS
// The host materializes the workspace's doc tree here before running this
// script (app/api/agent/turn/route.ts) -- one directory per doc, each holding
// exactly one `_doc.md` file (spec §1.2). Never baked into the golden
// snapshot: it's per-turn, per-workspace content.
const DOCS_ROOT = process.env.DOCS_ROOT
const AGENT_RUN_ID = process.env.AGENT_RUN_ID
const AGENT_RUN_TOKEN = process.env.AGENT_RUN_TOKEN
const AGENT_SESSION_ID = process.env.AGENT_SESSION_ID
const AGENT_SESSION_MODE = process.env.AGENT_SESSION_MODE

function emit(kind: "AGENT_EVENT" | "AGENT_DOC_STATE" | "AGENT_RESULT" | "AGENT_ERROR" | "AGENT_SESSION", payload: unknown): void {
  // Single line so the host can split stdout on newlines and forward as SSE.
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

/** Diagnostics about this script's own setup, which must never masquerade as agent output. */
function note(message: string): void {
  process.stderr.write(`[turn-entry] ${message}\n`)
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}


let reporter: RunReporter | undefined
/** Captured at module scope so the session upload can authenticate after the env scrub. */
let runCallbackHeaders: Record<string, string> | undefined

// ── Session transcript ──────────────────────────────────────────

/** Mirrors lib/agent-session.ts; the server re-validates, this just avoids a doomed upload. */
const MAX_AGENT_SESSION_BYTES = 4_000_000
/** Decompressed ceiling for an inbound transcript — a bomb guard, not a product limit. */
const MAX_SESSION_INPUT_BYTES = 128 * 1024 * 1024
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_IN_FILE = "session-in.jsonl.gz"
const SESSION_OUT_FILE = "session-out.jsonl.gz"
const FALLBACK_PROMPT_FILE = "fallback-prompt.txt"

/**
 * In-memory SessionStore. The SDK mirrors every transcript line here as it runs,
 * so at the end of the turn we hold the exact bytes the next turn needs to
 * resume. Lines are `{ s: subpath | null, e: entry }`; the projectKey and
 * sessionId are intentionally not stored — the store is scoped to one
 * conversation, and the server (not this sandbox) decides which one.
 */
class MemorySessionStore implements SessionStore {
  private readonly lines: { s: string | null; e: SessionStoreEntry }[] = []
  private readonly seen = new Set<string>()
  /** The session id the SDK actually wrote the main transcript under. */
  mainSessionId: string | undefined

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const subpath = key.subpath ?? null
    if (subpath === null && key.sessionId) this.mainSessionId = key.sessionId
    for (const entry of entries) {
      // uuid is the SDK's idempotency key: a retried append must not duplicate.
      if (typeof entry.uuid === "string") {
        const id = `${subpath ?? ""}\u0000${entry.uuid}`
        if (this.seen.has(id)) continue
        this.seen.add(id)
      }
      this.lines.push({ s: subpath, e: entry })
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const subpath = key.subpath ?? null
    const entries = this.lines.filter((line) => line.s === subpath).map((line) => line.e)
    return entries.length > 0 ? entries : null
  }

  async listSubkeys(): Promise<string[]> {
    const subpaths = new Set<string>()
    for (const line of this.lines) if (line.s !== null) subpaths.add(line.s)
    return [...subpaths]
  }

  get size(): number {
    return this.lines.length
  }

  toGzip(): Buffer {
    const text = this.lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
    return gzipSync(Buffer.from(text, "utf8"))
  }

  /** Returns undefined for anything that is not a well-formed transcript. */
  static fromGzip(bytes: Buffer): MemorySessionStore | undefined {
    try {
      const text = gunzipSync(bytes, { maxOutputLength: MAX_SESSION_INPUT_BYTES }).toString("utf8")
      const store = new MemorySessionStore()
      for (const raw of text.split("\n")) {
        if (!raw) continue
        const parsed = JSON.parse(raw) as { s?: unknown; e?: unknown } | null
        const entry = parsed?.e as SessionStoreEntry | undefined
        const subpath = parsed?.s
        if (!entry || typeof entry !== "object" || typeof entry.type !== "string") return undefined
        if (subpath !== null && typeof subpath !== "string") return undefined
        if (typeof entry.uuid === "string") store.seen.add(`${subpath ?? ""}\u0000${entry.uuid}`)
        store.lines.push({ s: subpath, e: entry })
      }
      return store.size > 0 ? store : undefined
    } catch {
      return undefined
    }
  }
}

function readResumeStore(): MemorySessionStore | undefined {
  if (!existsSync(SESSION_IN_FILE)) return undefined
  return MemorySessionStore.fromGzip(readFileSync(SESSION_IN_FILE))
}

/** Hand the finished transcript back. Never throws: losing it costs the next turn its memory, not this turn its answer. */
async function publishSession(store: MemorySessionStore, requestedId: string, baseUrl: string): Promise<void> {
  try {
    const sessionId = store.mainSessionId && SESSION_UUID_RE.test(store.mainSessionId) ? store.mainSessionId : requestedId
    if (store.size === 0) {
      note("no transcript was recorded; the next turn will start a new session")
      return
    }
    const gz = store.toGzip()
    if (gz.length > MAX_AGENT_SESSION_BYTES) {
      note(`transcript is ${gz.length} bytes gzipped (cap ${MAX_AGENT_SESSION_BYTES}); not saving — the next turn falls back to text replay`)
      return
    }
    // Sync turns have no upload channel: the host reads this file back out.
    writeFileSync(SESSION_OUT_FILE, gz)
    emit("AGENT_SESSION", { sessionId })
    if (!reporter || !runCallbackHeaders || !AGENT_RUN_ID) return
    const url = new URL(`/api/internal/agent/runs/${AGENT_RUN_ID}/session`, baseUrl).toString()
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...runCallbackHeaders, "content-type": "application/gzip", "x-agent-session-id": sessionId },
          body: new Uint8Array(gz),
        })
        if (response.ok) return
        note(`session upload attempt ${attempt} returned ${response.status}`)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) return
      } catch (error) {
        note(`session upload attempt ${attempt} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } catch (error) {
    note(`session publish failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── Outbound MCP connectors (ADR-0018) ──────────────────────────────────────

type ConnectorRef = { slug: string; displayName: string; guidance?: string }

/**
 * The plan is the Compass-backed mcp__compass__Task* tools (a conversation's tasks, read back by the chat), so the SDK's TodoWrite is not
 * offered: two competing lists. Agent (Task in older SDKs; both listed, a name the SDK does not know is inert) delegates to a subagent (its
 * events carry parent_tool_use_id, which lib/agent-run-stream.ts nests). Neither
 * touches the filesystem or network itself; a subagent is expected to inherit this same
 * `tools`/hook set, so it is no wider than the parent.
 */
const PLANNING_TOOLS = ["Agent", "Task"]

/** The shape the Agent SDK's `mcpServers` map takes for an HTTP transport. */
type McpHttpServer = {
  type: "http"
  url: string
  headers: Record<string, string>
  alwaysLoad?: boolean
}

/** Per connector. Generous for a paragraph of advice, far short of a prompt injection budget. */
const MAX_CONNECTOR_GUIDANCE_CHARS = 2000

/**
 * Parses AGENT_MCP_CONNECTORS, dropping anything malformed rather than throwing.
 *
 * A bad entry must not cost the user their turn: the connectors are an additive
 * capability, and the agent is perfectly useful with only Compass's own catalog.
 * The slug is re-validated here even though the host built the value, because it
 * is interpolated into both a URL path and an `mcp__<slug>` tool-name prefix —
 * two places where a stray character would either widen the allowlist or point
 * the SDK somewhere unintended.
 */
function parseConnectors(raw: string | undefined): ConnectorRef[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    note("AGENT_MCP_CONNECTORS is not valid JSON; continuing with Compass only")
    return []
  }
  if (!Array.isArray(parsed)) {
    note("AGENT_MCP_CONNECTORS is not an array; continuing with Compass only")
    return []
  }
  const refs: ConnectorRef[] = []
  for (const entry of parsed) {
    const slug = (entry as { slug?: unknown } | null)?.slug
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
      note(`ignoring connector with unusable slug: ${JSON.stringify(slug)}`)
      continue
    }
    const displayName = (entry as { displayName?: unknown }).displayName
    const guidance = (entry as { guidance?: unknown }).guidance
    refs.push({
      slug,
      displayName: typeof displayName === "string" && displayName ? displayName : slug,
      // Capped rather than trusted wholesale: it is appended to the system
      // prompt, and the host is the only writer, but a runaway value would
      // silently eat the context budget the actual turn needs.
      ...(typeof guidance === "string" && guidance.trim()
        ? { guidance: guidance.trim().slice(0, MAX_CONNECTOR_GUIDANCE_CHARS) }
        : {}),
    })
  }
  return refs
}

// ── docs local filesystem tools (ADR 0019 §2.3) ─────────────────────────────
//
// The SDK's built-in file tools are Read/Write/Edit/Glob/Grep -- there is no
// built-in delete-file or move/rename-file tool; those live only inside Bash.
// Rather than add Bash (a materially larger surface -- it can read
// process.env, which holds the MCP bearer token, and could exfiltrate it over
// any open network egress), these two tools give the agent exactly "delete a
// doc" and "move/rename a doc". (Bash now exists for workspaces that approved GitHub
// repos, but only as a separate unprivileged Unix user behind an egress allowlist --
// see github-access.ts -- so these tools are still the way to delete/move docs.), wrapping an openWikiSession opened once at the
// top of main() -- local sandbox disk only, no network call, no DB mutation.
// The actual deleteDocument/movePath call against Compass happens in the same
// end-to-end reconciliation pass as every other change, after this process
// exits (app/api/agent/turn/route.ts).
async function refreshView(session: WikiSession): Promise<boolean> {
  try {
    return (await session.refresh()).status === "ok"
  } catch {
    return false
  }
}

function buildDocsFsServer(session: WikiSession, deletedByAgent: Set<string>) {
  return createSdkMcpServer({
    name: "docsfs",
    version: "1.0.0",
    tools: [
      tool(
        "delete_local_doc",
        "Deletes a doc's materialized file (its directory's _doc.md) from the local sandbox filesystem. " +
          "This does not touch Compass directly -- the real deletion is recorded when this turn ends.",
        { path: z.string().min(1).describe('Path to the doc\'s _doc.md file, e.g. "Product/Roadmap/Q3 Plan/_doc.md"') },
        async ({ path }) => {
          // The session is a scan: a file the agent wrote natively this turn is not in it until a refresh.
          const refreshed = await refreshView(session)
          if (!refreshed) return { content: [{ type: "text" as const, text: "Could not refresh the docs view; try again." }], isError: true }
          const result = await session.deleteNote(path)
          if (result.status !== "ok") {
            return { content: [{ type: "text" as const, text: `Could not delete "${path}": ${result.status}` }], isError: true }
          }
          // The ONLY signal that a doc going missing is intentional: a file that is
          // merely absent from the final tree (unreadable, past a walk limit) must
          // never be hard-deleted on that evidence alone.
          // Only a name the server would accept is recorded; anything else could not
          // have been a baseline doc, and the server drops what it cannot validate anyway.
          const docPath = (path.endsWith("/_doc.md") ? path.slice(0, -"/_doc.md".length) : path).replace(/^\.\//, "")
          if (isValidDocName(docPath)) deletedByAgent.add(docPath)
          return { content: [{ type: "text" as const, text: `Deleted ${path}` }] }
        }
      ),
      tool(
        "move_local_doc",
        "Moves/renames a doc's materialized file on the local sandbox filesystem, from one _doc.md path to " +
          "another. This does not touch Compass directly -- the real move is recorded when this turn ends.",
        {
          fromPath: z.string().min(1).describe("Current path to the doc's _doc.md file"),
          toPath: z.string().min(1).describe("Destination path for the doc's _doc.md file"),
        },
        async ({ fromPath, toPath }) => {
          // The wiki SDK has no rename primitive -- composed from create+delete,
          // same as any other move a human could make by hand in a folder of
          // Markdown files. The Compass-side reconciler detects the move by
          // comparing before/after compass_doc_id placement regardless of which
          // local syscalls produced the after-state.
          const refreshed = await refreshView(session)
          if (!refreshed) return { content: [{ type: "text" as const, text: "Could not refresh the docs view; try again." }], isError: true }
          const read = session.readNote(fromPath)
          if (read.status !== "ok") {
            return { content: [{ type: "text" as const, text: `Could not read "${fromPath}": ${read.status}` }], isError: true }
          }
          const created = await session.createNote(toPath, read.note.text)
          if (created.status !== "ok") {
            return { content: [{ type: "text" as const, text: `Could not create "${toPath}": ${created.status}` }], isError: true }
          }
          const deleted = await session.deleteNote(fromPath)
          if (deleted.status !== "ok") {
            return {
              content: [{ type: "text" as const, text: `Created "${toPath}" but could not remove "${fromPath}": ${deleted.status}` }],
              isError: true,
            }
          }
          return { content: [{ type: "text" as const, text: `Moved ${fromPath} -> ${toPath}` }] }
        }
      ),
    ],
  })
}

// ── doc tree reconciliation hand-off (ADR 0019 §2.4) ────────────────────────

const DOC_MANIFEST_PATH = "docs-manifest.json"
const DOCS_REREAD_FAILED_NOTICE = "(My working copy of the docs could not be re-read at the end of this turn, so none of my doc edits were saved. Please check the affected docs and ask me to redo them.)"
const DOCS_SAVE_FAILED_NOTICE = "(Some doc changes from this turn may not have saved -- please check the affected docs.)"

/**
 * Hands the final doc tree to Compass and returns the answer to show the user.
 *
 * Detached (a signed baseline manifest is on disk and the run callback is up): POST
 * to /api/internal/agent/runs/:id/docs, where Compass verifies the manifest,
 * reconciles, and replies with any conflict notice. To keep a large unchanged tree
 * off the wire, a file whose content still hashes to its baseline entry is sent as
 * a hash alone; anything else carries its content.
 *
 * Synchronous (no run callback): emit the whole tree on stdout as AGENT_DOC_STATE
 * and let the route, which holds the baseline in memory, reconcile.
 *
 * Never throws: a doc-saving problem must not cost the user the agent's answer.
 */
async function reportDocState(session: WikiSession, baseUrl: string, finalText: string, deletedByAgent: Set<string>): Promise<string> {
  let collected: CollectedDocState
  try {
    collected = await collectFinalDocState(session, note)
  } catch (error) {
    note(`could not read final doc state: ${error instanceof Error ? error.message : String(error)}`)
    return `${finalText}\n\n${DOCS_SAVE_FAILED_NOTICE}`
  }
  const { files, incomplete, skippedNames, refreshFailed } = collected
  if (refreshFailed) {
    // Everything collected is from a stale scan: reconciling it could save out-of-date content
    // over newer edits, or miss creates entirely. Save nothing and say so.
    note("docs working copy could not be re-read; skipping reconciliation")
    return `${finalText}\n\n${DOCS_REREAD_FAILED_NOTICE}`
  }
  const deletedPaths = [...deletedByAgent]
  const skippedNotice = skippedNames.length
    ? `\n\n${skippedNames.length} doc file${skippedNames.length === 1 ? " was" : "s were"} not saved because they are not valid doc files (a bad name, a root-level _doc.md, or a note other than a doc's _doc.md): ${skippedNames.slice(0, 5).map((n) => `'${n}'`).join(", ")}.`
    : ""
  const withNotice = (text: string) => `${text}${skippedNotice}`

  if (!reporter || !runCallbackHeaders || !AGENT_RUN_ID) {
    emit("AGENT_DOC_STATE", { files, incomplete, deletedPaths })
    return withNotice(finalText)
  }

  try {
    if (!existsSync(DOC_MANIFEST_PATH)) throw new Error("doc manifest is missing")
    const manifest = JSON.parse(readFileSync(DOC_MANIFEST_PATH, "utf8")) as { entries?: { docId: string; contentSha256: string }[] }
    const baselineHash = new Map((manifest.entries ?? []).map((e) => [e.docId, e.contentSha256]))
    const occurrences = new Map<string, number>()
    for (const file of files) {
      if (file.frontmatterDocId) occurrences.set(file.frontmatterDocId, (occurrences.get(file.frontmatterDocId) ?? 0) + 1)
    }
    const payloadFiles = files.map((file) => {
      const hash = createHash("sha256").update(file.content).digest("hex")
      const id = file.frontmatterDocId
      // A duplicated id needs real content for the copy that becomes a new doc.
      const unchanged = id !== null && baselineHash.get(id) === hash && occurrences.get(id) === 1
      return unchanged
        ? { path: file.path, frontmatterDocId: id, contentSha256: hash }
        : { path: file.path, frontmatterDocId: id, content: file.content }
    })
    const url = new URL(`/api/internal/agent/runs/${AGENT_RUN_ID}/docs`, baseUrl).toString()
    const response = await fetch(url, {
      method: "POST",
      headers: { ...runCallbackHeaders, "content-type": "application/json" },
      body: JSON.stringify({ manifest, files: payloadFiles, incomplete, deletedPaths }),
    })
    if (!response.ok) throw new Error(`docs reconciliation returned ${response.status}`)
    const result = (await response.json()) as { notice?: string | null }
    return withNotice(result.notice ? `${finalText}\n\n${result.notice}` : finalText)
  } catch (error) {
    note(`doc reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    return withNotice(`${finalText}\n\n${DOCS_SAVE_FAILED_NOTICE}`)
  }
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("MCP_BASE_URL", MCP_BASE_URL)
  const token = requireEnv("MCP_TOKEN", MCP_TOKEN)
  const prompt = requireEnv("AGENT_PROMPT", AGENT_PROMPT)
  const systemPrompt = requireEnv("AGENT_SYSTEM_PROMPT", AGENT_SYSTEM_PROMPT)
  // The credential depends on the provider. Without it query() would silently
  // fall back to looking for a key we never set.
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    requireEnv("AWS_BEARER_TOKEN_BEDROCK", process.env.AWS_BEARER_TOKEN_BEDROCK)
  } else {
    requireEnv("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY)
  }
  const model = requireEnv("AGENT_MODEL", process.env.AGENT_MODEL)

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (MCP_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = MCP_BYPASS_SECRET
  const packConfig = AGENT_PACK_CONFIG
    ? JSON.parse(AGENT_PACK_CONFIG) as { pluginPaths: string[]; skillIds: string[] }
    : { pluginPaths: [], skillIds: [] }

  if (AGENT_RUN_ID && AGENT_RUN_TOKEN) {
    const callbackHeaders: Record<string, string> = { Authorization: `Bearer ${AGENT_RUN_TOKEN}` }
    if (MCP_BYPASS_SECRET) callbackHeaders["x-vercel-protection-bypass"] = MCP_BYPASS_SECRET
    runCallbackHeaders = callbackHeaders
    const heartbeatMs = Number(process.env.AGENT_RUN_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS
    reporter = new RunReporter(
      new URL(`/api/internal/agent/runs/${AGENT_RUN_ID}/events`, baseUrl).toString(),
      new URL(`/api/internal/agent/runs/${AGENT_RUN_ID}/heartbeat`, baseUrl).toString(),
      callbackHeaders,
      heartbeatMs,
      note,
    )
    reporter.start()
    reporter.enqueue("status", { phase: "running" })
  }

  // ADR 0019: docs are file-shaped only when the host materialized them. Claim-scoped
  // handoff runs get no DOCS_ROOT (their MCP key is narrower than "act as the user"),
  // and keep the MCP-only configuration, including write_doc and friends.
  let docsSession: WikiSession | undefined
  const deletedByAgent = new Set<string>()
  const docsRoot = DOCS_ROOT
  if (docsRoot) {
    // The host may not have written anything under DOCS_ROOT at all (a
    // workspace with zero docs yet) -- openWikiSession expects the folder to
    // already exist, so ensure it does regardless.
    await mkdir(docsRoot, { recursive: true })
    const opened = await openWikiSession(docsRoot)
    if (opened.status !== "ok") throw new Error(`Could not open docs session at "${docsRoot}": ${opened.error.code}`)
    docsSession = opened.session
  }

  // ADR (agent shell + GitHub access): Bash exists only when the host enabled it AND the
  // jail user is provably usable. Any failure here degrades to the no-shell configuration
  // and says so in the prompt, rather than failing the turn or running Bash unconfined.
  let githubShell = false
  const githubAccess = githubAccessFromEnv(process.env, docsRoot)
  if (githubAccess.enabled && docsSession && docsRoot) {
    try {
      prepareBashJail({ docsRoot, note })
      githubShell = true
      note(`shell enabled for ${githubAccess.repos.length} repository(ies)`)
    } catch (error) {
      note(`shell disabled: could not set up the jail user: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (process.env.AGENT_GITHUB_SHELL === "1") {
    note(`shell disabled: ${githubAccess.enabled ? "docs session missing" : githubAccess.reason}`)
  }

  // Compass's own catalog plus one HTTP entry per connected provider (and, when
  // the host materialized docs, the in-process docsfs server — ADR 0019 §2.3).
  // Each connector points at a Compass gateway path, not the provider — the
  // sandbox presents its own turn credential and Compass attaches the
  // third-party bearer on the way out, so no provider token is ever present in
  // this microVM.
  // `alwaysLoad` is deliberately NOT set on the connectors: Compass's own catalog
  // is what the agent needs every turn, whereas a connector's tools are worth
  // discovering on demand rather than spending context on unconditionally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- docsfs is an SDK-instance server, not an HTTP one; a shared union type buys nothing here.
  const mcpServers: Record<string, McpHttpServer | any> = {
    compass: {
      type: "http",
      url: new URL("/api/mcp", baseUrl).toString(),
      headers,
      // Load the full Compass catalog into the prompt up front instead of
      // deferring it behind ToolSearch. Without this the agent burns turns
      // searching for tools; with it, it can act directly.
      alwaysLoad: true,
    },
    ...(docsSession ? { docsfs: buildDocsFsServer(docsSession, deletedByAgent) } : {}),
  }
  // Compass-hosted search. The name is reserved before connectors are
  // read so a connector slug cannot shadow it.
  // No Gateway credential enters the sandbox: it presents the same MCP_TOKEN.
  mcpServers.web_search = {
    type: "http",
    url: new URL("/api/agent/web-search/mcp", baseUrl).toString(),
    headers,
  }
  const connectors = parseConnectors(AGENT_MCP_CONNECTORS)
  const connectorToolPrefixes: string[] = []
  const connectorGuidance: string[] = []
  for (const connector of connectors) {
    // `compass` is this file's own entry, and shadowing it would silently
    // redirect the agent's entire tool catalog through the gateway.
    if (Object.prototype.hasOwnProperty.call(mcpServers, connector.slug)) {
      note(`ignoring connector "${connector.slug}": name is reserved`)
      continue
    }
    mcpServers[connector.slug] = {
      type: "http",
      url: new URL(`/api/integrations/mcp/${connector.slug}`, baseUrl).toString(),
      headers,
    }
    connectorToolPrefixes.push(`mcp__${connector.slug}`)
    if (connector.guidance) connectorGuidance.push(`${connector.displayName}: ${connector.guidance}`)
  }
  if (connectorToolPrefixes.length > 0) note(`connectors enabled: ${connectorToolPrefixes.join(", ")}`)

  // Appended after the host's prompt rather than merged into it, because it is
  // scoped to *this* turn's grants: the host prompt is the same for every user,
  // and this paragraph only exists while the connector it describes is reachable.
  const promptWithConnectors = connectorGuidance.length
    ? `${systemPrompt}\n\n## Connected third-party tools\n\n${connectorGuidance.join("\n\n")}`
    : systemPrompt
  // The host described a shell it expected to enable; if setup failed, retract that.
  const effectiveSystemPrompt =
    process.env.AGENT_GITHUB_SHELL === "1" && !githubShell ? `${promptWithConnectors}${SHELL_UNAVAILABLE_NOTICE}` : promptWithConnectors

  const allowedFetchUrls = createAllowedUrls(
    `${prompt}\n${existsSync(FALLBACK_PROMPT_FILE) ? readFileSync(FALLBACK_PROMPT_FILE, "utf8") : ""}`,
  )

  const baseOptions: Options = {
    // The model comes from the host (AGENT_MODEL): the deployment provider's default, or a named cloud agent's own choice.
    model,
    // Compass's own MCP catalog, reached AS the acting user, plus this turn's
    // connectors. Built above.
    mcpServers,
    plugins: packConfig.pluginPaths.map((pluginPath) => ({
      type: "local" as const,
      path: new URL(pluginPath, `file://${process.cwd()}/`).pathname,
      skipMcpDiscovery: true,
    })),
    skills: packConfig.skillIds,
    // Skill bodies and supported text assets are compiled into systemPrompt
    // by the host. SDK 0.3.224 does not provide Skill/Read with tools: [].
    //
    // WebFetch is the one built-in admitted: it lets the agent read a URL the
    // user names or a page it already knows about, instead of reporting that it
    // has no web access. Search is not a built-in: it is the Compass-hosted
    // web_search MCP tool registered above. Fetched content and search results
    // are untrusted input: treat them as data, never instructions.
    //
    // ADR 0019 §2.2: with docs materialized, `tools` is also the real gate on file
    // access -- `allowedTools` does nothing under `permissionMode: "bypassPermissions"`
    // (confirmed against the Agent SDK's current docs). Read/Write/Edit/Glob give
    // native access to the doc tree at `cwd`. Bash is omitted by default (see
    // buildDocsFsServer for why); it is added ONLY by agentTools(docs, githubShell) and only after the jail user was
    // proven (see above); its commands are rewritten to run as that user by the Bash hook.
    tools: [...agentTools(Boolean(docsSession), githubShell), ...PLANNING_TOOLS],
    // Scopes the agent's native file tools to the materialized doc tree.
    ...(docsSession && docsRoot ? { cwd: docsRoot } : {}),
    // `cwd` alone confines nothing: under bypassPermissions Read/Write/Edit/Glob
    // accept any absolute path (`Read /proc/self/environ` exposes every secret in
    // this process). The hook denies any path that does not resolve, symlinks
    // included, to a location inside the docs directory. See docs-path-guard.ts.
    //
    // WebFetch is the one way left to move data off the box with the file tools
    // confined, so it too is restricted when docs are materialized: only URLs the
    // user wrote (or the replayed history holds) and URLs web_search returned this
    // turn, matched exactly. See the WebFetch section of docs-path-guard.ts.
    ...(docsSession && docsRoot
      ? {
          hooks: {
            PreToolUse: [
              // The cloned-repo workdir is readable (never writable) by the native file tools.
              { matcher: DOCS_GUARDED_TOOLS_MATCHER, hooks: [createDocsPreToolUseHook(docsRoot, { readOnlyRoots: githubShell ? [REPOS_DIR] : [] })] },
              { matcher: WEB_FETCH_MATCHER, hooks: [createWebFetchPreToolUseHook(allowedFetchUrls)] },
              ...(githubShell ? [{ matcher: BASH_MATCHER, hooks: [createBashPreToolUseHook(process.env)] }] : []),
            ],
            PostToolUse: [{ matcher: WEB_SEARCH_MATCHER, hooks: [createSearchResultCollector(allowedFetchUrls)] }],
          },
        }
      : {}),
    // The model-facing CLI process does not need this script's own credentials
    // (the run callback token and the MCP bearer are used in-process only), so it
    // does not inherit them.
    env: scrubbedAgentEnv(process.env, { github: githubShell }),
    strictMcpConfig: true,
    settingSources: [],
    systemPrompt: effectiveSystemPrompt,
    // Compass MCP only, auto-approved. Headless (no human approver): the
    // real security boundary is the disposable sandbox + per-user MCP auth.
    allowedTools: [
      "mcp__compass",
      "WebFetch",
      ...PLANNING_TOOLS,
      "mcp__web_search",
      ...(docsSession ? ["mcp__docsfs", "Read", "Write", "Edit", "Glob"] : []),
      ...(githubShell ? ["Bash"] : []),
      ...connectorToolPrefixes,
    ],
    // Safety default (Phase 5): keep the two irreversible hard-delete tools
    // out of the agent's reach — everything else is reversible/auditable.
    // Remove entries here to let the agent perform destructive deletes.
    //
    // With docs materialized, write_doc/delete_doc/move_doc are also removed for THIS
    // agent: content and structure have a clean, lossless filesystem equivalent
    // (ADR 0019 §2.2). Comment/history/restore stay (no filesystem shape for those,
    // §2.5), as do the docId-addressed edit_doc/edit_canvas/build_canvas_tree/
    // capture_canvas, which act on the saved doc directly.
    disallowedTools: [
      // The SDK's own task tools would duplicate (and not persist like) the Compass-backed mcp__compass__TaskCreate/TaskUpdate/TaskList/TaskGet ones. (Keep any glob character out of this list's comments: agent-turn-entry-policy.test.ts scans from "allowedTools: [" for one.)
      "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite",
      "mcp__compass__delete_assumption",
      "mcp__compass__delete_solution_comment",
      ...(docsSession ? ["mcp__compass__write_doc", "mcp__compass__delete_doc", "mcp__compass__move_doc"] : []),
    ],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: Number(process.env.AGENT_MAX_TURNS) || 30,
  }

  type AttemptOutcome = { kind: "ok"; finalText: string; usage: unknown } | { kind: "canceled" }

  /** One pass of the SDK loop. `state.sawAssistant` lets the caller tell a failed resume from a failed turn. */
  async function runAttempt(
    attemptPrompt: string,
    sessionOptions: Partial<Options>,
    state: { sawAssistant: boolean },
  ): Promise<AttemptOutcome> {
    let finalText: string | undefined
    let usage: unknown
    for await (const message of query({ prompt: attemptPrompt, options: { ...baseOptions, ...sessionOptions } })) {
      emit("AGENT_EVENT", { type: message.type, message })
      reporter?.enqueue("agent", { type: message.type, message })
      if (message.type === "assistant") state.sawAssistant = true

      // Canceled or swept out from under us: stop spending model tokens on a
      // result nobody will accept. The server is already terminal, so there is
      // nothing to report back.
      if (reporter?.canceledStatus) {
        note(`stopping early: run is ${reporter.canceledStatus}`)
        emit("AGENT_ERROR", { message: `run terminated server-side (${reporter.canceledStatus})` })
        process.exitCode = 1
        return { kind: "canceled" }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          finalText = message.result
          usage = {
            durationMs: message.duration_ms,
            durationApiMs: message.duration_api_ms,
            numTurns: message.num_turns,
            totalCostUsd: message.total_cost_usd,
            usage: message.usage,
          }
        } else {
          throw new Error(`query() ended with subtype: ${message.subtype}`)
        }
      }
    }
    if (finalText === undefined) throw new Error("query() ended without a success result")
    return { kind: "ok", finalText, usage }
  }

  // Session resume. Anything that goes wrong *loading or resuming* the prior
  // transcript degrades to a brand-new session driven by the full text replay
  // the host also sent — the user loses nothing they had before this feature.
  const requestedSessionId = AGENT_SESSION_ID && SESSION_UUID_RE.test(AGENT_SESSION_ID) ? AGENT_SESSION_ID : undefined
  let outcome: AttemptOutcome | undefined
  let activeStore: MemorySessionStore | undefined
  let activeSessionId = requestedSessionId

  if (!requestedSessionId) {
    outcome = await runAttempt(prompt, {}, { sawAssistant: false })
  } else {
    const resuming = AGENT_SESSION_MODE === "resume"
    if (resuming) {
      const resumeStore = readResumeStore()
      if (!resumeStore) {
        note("session transcript is missing or malformed; starting a new session from the text replay")
      } else {
        const state = { sawAssistant: false }
        try {
          outcome = await runAttempt(
            prompt,
            { sessionStore: resumeStore, sessionStoreFlush: "eager", resume: requestedSessionId },
            state,
          )
          activeStore = resumeStore
        } catch (error) {
          // After the model has answered, this is a genuine turn failure, not a resume failure.
          if (state.sawAssistant) throw error
          note(`resume failed (${error instanceof Error ? error.message : String(error)}); starting a new session`)
        }
      }
    }
    if (!outcome) {
      // A resumed-then-abandoned id may already name a partial transcript, so never reuse it.
      activeSessionId = resuming ? randomUUID() : requestedSessionId
      let freshPrompt = prompt
      if (resuming) {
        if (existsSync(FALLBACK_PROMPT_FILE)) freshPrompt = readFileSync(FALLBACK_PROMPT_FILE, "utf8")
        else note("fallback prompt missing; continuing with the new message alone")
      }
      const freshStore = new MemorySessionStore()
      outcome = await runAttempt(
        freshPrompt,
        { sessionStore: freshStore, sessionStoreFlush: "eager", sessionId: activeSessionId },
        { sawAssistant: false },
      )
      activeStore = freshStore
    }
  }

  if (outcome.kind === "canceled") return

  // ADR 0019 §2.4: reconcile the doc tree the agent edited as files. Before the
  // terminal report and the session upload for the same reason as the session:
  // a detached run's worker token stops working the moment the run is terminal.
  let finalText = outcome.finalText
  if (docsSession) finalText = await reportDocState(docsSession, baseUrl, finalText, deletedByAgent)

  // Before the terminal report: a detached run's worker token stops working the
  // moment the run is terminal, so the upload has to land first.
  if (activeStore && activeSessionId) await publishSession(activeStore, activeSessionId, baseUrl)

  emit("AGENT_RESULT", { text: finalText, usage: outcome.usage })
  await reporter?.finish("result", { text: finalText, usage: outcome.usage })
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  emit("AGENT_ERROR", { message })
  try {
    await reporter?.finish("error", { message })
  } catch {
    /* the sweeper is the backstop when even the terminal report cannot land */
  }
  process.exit(1)
})
