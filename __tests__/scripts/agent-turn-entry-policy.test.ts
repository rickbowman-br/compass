/**
 * The sandbox entry script runs inside a microVM and executes on import, so it is
 * asserted as source text rather than called. What is pinned here is the tool
 * policy: every capability the agent gets must be declared, and nothing may be
 * inherited from the machine it happens to be running on.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync("scripts/agent/turn-entry.ts", "utf8")

describe("agent entry capability-pack policy", () => {
  it("keeps plugins declarative while Compass owns MCP and no unscoped built-ins are exposed", () => {
    expect(source).toContain("skipMcpDiscovery: true")
    expect(source).toContain("strictMcpConfig: true")
    expect(source).toMatch(/settingSources:\s*\[\]/)
  })

  it("exposes WebFetch as the only built-in tool unless the host materialized docs", () => {
    // The list comes from agentTools() (scripts/agent/github-access.ts), whose output is
    // pinned in github-access.test.ts: the failure mode is additive drift, one more
    // "harmless" built-in at a time, none reviewed as a boundary change.
    // The only addition is PLANNING_TOOLS (subagent delegation); it is pinned below so widening it is a reviewed change.
    expect(source).toContain("tools: [...agentTools(Boolean(docsSession), githubShell), ...PLANNING_TOOLS],")
    expect(source).toContain('const PLANNING_TOOLS = ["Agent", "Task"]')
    // Bash exists only through the jail: it is added by agentTools() when githubShell is
    // true, and githubShell is set only after prepareBashJail() proved the jail user.
    // Nothing else may name it in `tools`.
    for (const forbidden of ["Bash", "MultiEdit", "NotebookEdit", "Grep", "Task", "Skill", "WebSearch"]) {
      expect(source).not.toMatch(new RegExp(`tools:[^\\n]*"${forbidden}"`))
    }
    expect(source).toMatch(/prepareBashJail\(\{ docsRoot, note \}\)\n\s+githubShell = true/)
    expect(source).toContain('...(githubShell ? ["Bash"] : []),')
    // Every Bash call goes through the policy + jail-rewrite hook, and the CLI gets the
    // GitHub token only on a shell turn.
    expect(source).toContain("...(githubShell ? [{ matcher: BASH_MATCHER, hooks: [createBashPreToolUseHook(process.env)] }] : []),")
    expect(source).toContain("env: scrubbedAgentEnv(process.env, { github: githubShell }),")
  })

  it("ADR 0019: scopes the native file tools to the materialized doc tree via cwd", () => {
    // `allowedTools` does nothing under bypassPermissions (see the comment in
    // turn-entry.ts) -- `tools` is the real gate, and `cwd` is what keeps Read/
    // Write/Edit/Glob inside the doc tree.
    expect(source).toContain("...(docsSession && docsRoot ? { cwd: docsRoot } : {})")
  })

  it("admits Compass, WebFetch, docsfs plus the native doc-file tools (only with docs), and per-turn connector prefixes -- nothing wider", () => {
    // The literal is pinned rather than matched loosely because the failure mode
    // is a silent widening: `allowedTools: ["mcp__*"]`, or dropping the option
    // entirely, both leave a headless agent running in bypassPermissions mode with
    // no allowlist at all. `connectorToolPrefixes` is the only sanctioned way for
    // this list to grow, and it grows per turn from the grants that user holds.
    expect(source).toContain('...(docsSession ? ["mcp__docsfs", "Read", "Write", "Edit", "Glob"] : []),\n      ...(githubShell ? ["Bash"] : []),')
    expect(source).toContain('"mcp__compass",\n      "WebFetch",\n      ...PLANNING_TOOLS,\n      "mcp__web_search",')
    expect(source).toContain("...connectorToolPrefixes,")
    expect(source).not.toMatch(/allowedTools:\s*\[[^\]]*\*/)
  })

  it("ADR 0019: supersedes write_doc/delete_doc/move_doc for this agent with the native file tools", () => {
    // Comment/history/restore tools are deliberately NOT in this list -- there
    // is no clean filesystem shape for them (spec §2.5), so they stay reachable
    // over MCP exactly as they are for an external agent.
    expect(source).toContain('"mcp__compass__write_doc"')
    expect(source).toContain('"mcp__compass__delete_doc"')
    expect(source).toContain('"mcp__compass__move_doc"')
    expect(source).not.toContain('"mcp__compass__list_doc_history"')
    expect(source).not.toContain('"mcp__compass__restore_doc_version"')
    // The docId-addressed tools act on the saved doc directly and have no file
    // shape; they stay reachable, and stay out of the disallow list.
    for (const kept of ["edit_doc", "edit_canvas", "build_canvas_tree", "capture_canvas"]) {
      expect(source).not.toContain(`"mcp__compass__${kept}"`)
    }
    // ...but only the docs-materialized agent loses the MCP doc writers.
    expect(source).toContain('...(docsSession ? ["mcp__compass__write_doc", "mcp__compass__delete_doc", "mcp__compass__move_doc"] : []),')
  })

  it("ADR 0019: docs are file-shaped only when the host materialized them (claim-scoped runs keep MCP-only docs)", () => {
    expect(source).toContain("const docsRoot = DOCS_ROOT")
    expect(source).toContain("if (docsRoot) {")
    expect(source).toContain("...(docsSession ? { docsfs: buildDocsFsServer(docsSession, deletedByAgent) } : {}),")
    expect(source).not.toContain('requireEnv("DOCS_ROOT"')
  })

  it("ADR 0019: confines the file tools with a PreToolUse path guard and keeps run credentials out of the CLI's environment", () => {
    // Without the hook, `Read /proc/self/environ` returns every secret in this process.
    expect(source).toContain('from "./docs-path-guard.ts"')
    expect(source).toContain("{ matcher: DOCS_GUARDED_TOOLS_MATCHER, hooks: [createDocsPreToolUseHook(docsRoot, { readOnlyRoots: githubShell ? [REPOS_DIR] : [] })] }")
    expect(source).toContain("env: scrubbedAgentEnv(process.env, { github: githubShell }),")
    // The guard must be registered exactly when the file tools are.
    expect(source).toMatch(/docsSession && docsRoot\s*\?\s*\{\s*hooks:/)
  })

  it("ADR 0019: WebFetch is limited to user-supplied and web_search-returned URLs whenever docs are materialized", () => {
    expect(source).toContain("{ matcher: WEB_FETCH_MATCHER, hooks: [createWebFetchPreToolUseHook(allowedFetchUrls)] }")
    expect(source).toContain("PostToolUse: [{ matcher: WEB_SEARCH_MATCHER, hooks: [createSearchResultCollector(allowedFetchUrls)] }]")
    // The matcher itself is behaviour-tested in docs-path-guard.test.ts; here, make sure the entry registers the
    // real server and tool the matcher is written for (mcp__web_search__web_search).
    expect(source).toContain("mcpServers.web_search = {")
    expect(readFileSync("app/api/agent/web-search/[transport]/route.ts", "utf8")).toContain('"web_search",')
    // seeded from the prompt (and the replayed history on a resumed turn), never from agent output
    expect(source).toMatch(/createAllowedUrls\(\s*`\$\{prompt\}/)
  })

  it("ADR 0019: reports whether the sandbox's view was complete and which docs the agent deleted on purpose", () => {
    // Collection (refresh first, completeness flags) lives in docs-final-state.ts and is behaviour-tested against a
    // real wiki session in docs-final-state.test.ts; here, make sure the entry uses it and refreshes before acting.
    const finalState = readFileSync("scripts/agent/docs-final-state.ts", "utf8")
    expect(finalState).toContain("await session.refresh()")
    expect(finalState.indexOf("await session.refresh()")).toBeLessThan(finalState.indexOf("session.info()"))
    expect(finalState).toContain("!info.discoveryComplete || !info.noteContentComplete")
    expect(source).toContain("await collectFinalDocState(session, note)")
    // a failed refresh means a stale scan: nothing is reconciled, and the user is told
    expect(source).toContain("if (refreshFailed) {")
    expect(source).toContain("DOCS_REREAD_FAILED_NOTICE")
    const guardIndex = source.indexOf("if (refreshFailed) {")
    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(source.indexOf('emit("AGENT_DOC_STATE"'))
    expect(guardIndex).toBeLessThan(source.indexOf("/api/internal/agent/runs/${AGENT_RUN_ID}/docs"))
    expect(source.match(/await refreshView\(session\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(source).toContain("deletedByAgent.add(")
    expect(source).toContain("JSON.stringify({ manifest, files: payloadFiles, incomplete, deletedPaths })")
    expect(source).toContain('emit("AGENT_DOC_STATE", { files, incomplete, deletedPaths })')
    // move_local_doc must not count as a deletion: the doc survives at its new path.
    const moveTool = source.slice(source.indexOf('"move_local_doc"'), source.indexOf("// ── doc tree reconciliation hand-off"))
    expect(moveTool).not.toContain("deletedByAgent")
  })

  it("ADR 0019: a detached run reconciles docs over the run callback before its terminal event", () => {
    const reconcile = source.indexOf("await reportDocState(docsSession, baseUrl, finalText, deletedByAgent)")
    const session = source.indexOf("await publishSession(activeStore, activeSessionId, baseUrl)")
    const terminal = source.indexOf('await reporter?.finish("result"')
    expect(reconcile).toBeGreaterThan(-1)
    expect(reconcile).toBeLessThan(terminal)
    expect(reconcile).toBeLessThan(session)
    expect(source).toContain("/api/internal/agent/runs/${AGENT_RUN_ID}/docs")
  })

  it("derives each connector tool prefix from a slug it has re-validated", () => {
    // The slug is interpolated into both a URL path and an `mcp__<slug>` prefix.
    // A stray `*` or `_` in it would widen the allowlist past the one server it
    // was meant to name, so the charset check is part of the policy, not a
    // formatting nicety.
    expect(source).toContain("/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)")
    expect(source).toContain("connectorToolPrefixes.push(`mcp__${connector.slug}`)")
  })

  it("always adds web_search as one fixed server, before connectors are read", () => {
    // The server name and URL are literals; nothing derives them from input, and the
    // name is registered before connectors so a connector slug cannot shadow it.
    expect(source).not.toContain("AGENT_WEB_SEARCH")
    expect(source).toContain('new URL("/api/agent/web-search/mcp", baseUrl)')
    expect(source.indexOf("mcpServers.web_search")).toBeLessThan(source.indexOf("hasOwnProperty.call(mcpServers, connector.slug)"))
  })

  it("never lets a connector shadow Compass's own MCP entry", () => {
    // Registering a connector under the name `compass` would silently route the
    // agent's entire tool catalog through the gateway.
    expect(source).toContain("hasOwnProperty.call(mcpServers, connector.slug)")
  })
})

/**
 * Per-connector guidance reaches the model through the system prompt, which makes
 * it the one host-supplied string in this script that the model reads as
 * instructions. Pinned as source text for the same reason as the tool policy: the
 * failure modes are silent. Guidance that stops being passed reverts the v0
 * timeout fix with every test still green, and guidance that is not capped lets
 * the host spend the turn's context budget.
 */
describe("agent entry connector guidance", () => {
  it("passes the prompt that carries the guidance, not the bare host prompt", () => {
    // The whole seam is inert if `query()` is handed `systemPrompt` instead.
    expect(source).toContain("systemPrompt: effectiveSystemPrompt")
    expect(source).not.toMatch(/systemPrompt:\s*systemPrompt\b/)
  })

  it("appends guidance after the host prompt rather than merging into it", () => {
    // Scoped to *this* turn's grants: the host prompt is identical for every user,
    // while this paragraph exists only while the connector it describes is
    // reachable. Appending keeps that distinction legible in the transcript.
    expect(source).toContain("`${systemPrompt}\\n\\n## Connected third-party tools\\n\\n${connectorGuidance.join(\"\\n\\n\")}`")
    // Falls back to the unmodified prompt when no connector had anything to say,
    // so a user with no grants pays no context for an empty section header.
    expect(source).toMatch(/connectorGuidance\.length\s*\n?\s*\?/)
  })

  it("only emits guidance for connectors the turn actually enabled", () => {
    // Collected inside the same loop that registers the MCP server, so a connector
    // the user has not granted can never contribute advice about tools the agent
    // cannot call.
    expect(source).toContain("if (connector.guidance) connectorGuidance.push(")
  })

  it("caps guidance instead of trusting the host's string wholesale", () => {
    expect(source).toContain("MAX_CONNECTOR_GUIDANCE_CHARS")
    expect(source).toContain("guidance.trim().slice(0, MAX_CONNECTOR_GUIDANCE_CHARS)")
    // A bound in the low thousands: room for a paragraph of advice, far short of a
    // budget worth injecting into.
    const cap = source.match(/const MAX_CONNECTOR_GUIDANCE_CHARS = (\d+)/)
    expect(cap).not.toBeNull()
    expect(Number(cap![1])).toBeLessThanOrEqual(4000)
  })

  it("ignores a non-string or blank guidance value", () => {
    // The host is the only writer today, but the parser is the trust boundary for
    // everything arriving as JSON in an env var.
    expect(source).toContain('typeof guidance === "string" && guidance.trim()')
  })
})
