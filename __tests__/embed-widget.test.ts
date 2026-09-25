// @vitest-environment jsdom

/**
 * Tests for the embedded feedback widget — the real shipped bytes.
 *
 * ## Why this file loads a string off disk instead of importing something
 *
 * `public/embed/widget.js` is served verbatim to a third-party page: no bundler,
 * no transpile, no module system. It is also invisible to every other gate in this
 * repository — ESLint and `tsc` only walk `.ts`/`.tsx`, and the colour gate only
 * `app/` and `components/`. So this file is the *only* automated check on that
 * code, and it earns that by reading the shipped file with `readFileSync` and
 * evaluating it. A reimplementation of the widget here would pass forever while
 * the deployed file rotted.
 *
 * The consequence worth stating: `WIDGET_SOURCE` is the actual production text, so
 * the source-level assertions at the bottom (no `innerHTML`, no `Math.random`, no
 * post-ES2018 syntax) are real guarantees about what ships, not lint theatre.
 *
 * ## What stays real and what gets stubbed
 *
 * Real: jsdom's DOM, Shadow DOM attachment and retargeting, `localStorage`,
 * `URL`, event dispatch and propagation, and every line of the widget.
 *
 * Stubbed: `fetch` (a small router, so each test states the API's answer),
 * `window.open` (a popup cannot be opened in jsdom, and the URL it would receive
 * is exactly what one of these tests is about), `crypto.getRandomValues` (so a
 * nonce is deterministic *and* so we can prove the widget asks the CSPRNG rather
 * than `Math.random`), `requestAnimationFrame` (recorded and run by hand, so pin
 * repositioning is tested deterministically instead of by waiting a frame), and
 * `htmlToImage` (the vendored library is exercised by
 * `__tests__/embed-vendor-html-to-image.test.ts`; what matters here is only that
 * every way it can fail still lets the comment through).
 *
 * jsdom limitation, stated rather than worked around: it ships no canvas
 * implementation, so `getContext("2d")` returns null and a *successful* capture
 * cannot be observed here. Every failure path can be and is. See the note on the
 * screenshot describe block.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Resolved from `process.cwd()`, not from `import.meta.url`: under the jsdom
 * environment `import.meta.url` is an `http://localhost` URL, so `new URL(…)`
 * against it throws "The URL must be of scheme file". This is the same approach
 * the other file-reading tests in this directory take.
 */
const WIDGET_PATH = path.join(process.cwd(), "public", "embed", "widget.js")
const WIDGET_SOURCE = readFileSync(WIDGET_PATH, "utf8")

/**
 * `WIDGET_SOURCE` with its comments removed, for the source-level rules at the
 * bottom of this file.
 *
 * Those rules enforce things the widget's own comments *explain*: the file states in
 * prose that `Math.random()` here would be a real vulnerability, so a grep for
 * `Math.random(` matches the very sentence forbidding it. Stripping comments first
 * is what lets a rule be both documented in the file and enforced against it.
 *
 * The stripping is naive — block comments, then line comments — which is safe only
 * because this particular file holds no string or regular-expression literal
 * containing `//` or a comment opener. The first test in that block checks the
 * result still contains real code, so a stripper that ate the file would fail loudly
 * rather than making every later assertion vacuously true.
 */
const WIDGET_CODE = WIDGET_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

/** The origin the script tag is loaded from, and therefore the expected API base. */
const ORIGIN = "https://compass.example.com"
const SCRIPT_SRC = ORIGIN + "/embed/widget.js"

/**
 * Assembled from the prefix rather than pasted as a literal, for the same reason
 * `__tests__/api-embed-session-route.test.ts` does it: a bare 38-character opaque
 * string beginning `cmpfb_` reads to a secret scanner as a credential it is not.
 */
const TOKEN = "cmpfb_" + "a".repeat(32)
const OTHER_TOKEN = "cmpfb_" + "b".repeat(32)
const VISITOR = "cmpv_" + "c".repeat(32)

/** Mirrors the widget's own key derivation, so a change to either side fails here. */
function storageKey(embedToken: string) {
  return "compass.embedFeedback.visitor." + embedToken.slice(-12)
}

/* ------------------------------------------------------------------ *
 * fetch router
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>
type Reply = { status: number; data: unknown }
type Handler = (body: Json | null, url: URL) => Reply

type Recorded = {
  method: string
  url: URL
  headers: Record<string, string>
  body: Json | null
  /** Captured verbatim so a test can assert it was never set. */
  credentials: unknown
}

let calls: Recorded[] = []
let routes: Map<string, Handler> = new Map()

function on(key: string, handler: Handler) {
  routes.set(key, handler)
}

function reply(status: number, data: unknown): Handler {
  return () => ({ status, data })
}

/** Every call the widget made to `<method> <pathname>`. */
function callsTo(key: string) {
  return calls.filter((call) => call.method + " " + call.url.pathname === key)
}

function lastCall(key: string) {
  const matching = callsTo(key)
  if (!matching.length) throw new Error("no call to " + key + "; saw: " + calls.map((c) => c.method + " " + c.url.pathname).join(", "))
  return matching[matching.length - 1]
}

function installFetch() {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : null

    calls.push({ method, url, headers, body, credentials: (init as { credentials?: unknown } | undefined)?.credentials })

    const handler = routes.get(method + " " + url.pathname)
    const result: Reply = handler ? handler(body, url) : { status: 404, data: { error: "no route in test" } }
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.data,
    }
  })
  window.fetch = fetchMock as unknown as typeof fetch
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * Every listener a mounted widget added to `window` or `document`, so teardown can
 * take them back off again.
 *
 * The widget has no unmount API, and should not grow one: in production it is
 * mounted once and lives until the page navigates away, so a teardown path would be
 * code that never runs. The consequence is local to this file — without this,
 * instance 39's `window.dispatchEvent(new Event("scroll"))` is also heard by the
 * 38 instances earlier tests mounted, and a "one frame per scroll burst" assertion
 * counts 39 frames instead of one.
 */
let listeners: { target: EventTarget; type: string; handler: EventListenerOrEventListenerObject; options?: unknown }[] = []

function recordListeners() {
  for (const target of [window, document] as EventTarget[]) {
    const original = target.addEventListener.bind(target)
    vi.spyOn(target, "addEventListener").mockImplementation((type, handler, options) => {
      if (handler) listeners.push({ target, type, handler, options })
      original(type, handler, options)
    })
  }
}

let openCalls: { url: string; name: string; features: string }[] = []
let popupClosed = false
let rafQueue: FrameRequestCallback[] = []
/** Counts up so successive nonces differ, which one test asserts. */
let randomSeed = 0

/** Runs every frame callback the widget has queued, once. */
function runFrames() {
  const queued = rafQueue
  rafQueue = []
  for (const callback of queued) callback(0)
}

/**
 * Drains the microtask queue. The widget's request path is five or six `then`s
 * deep (fetch, `json()`, the result wrapper, the guarded handler, a render), and a
 * submit adds the capture and upload on top, so this is generous on purpose.
 */
async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

type MountOptions = { token?: string | null; src?: string; pagePath?: string; tokenAttr?: string }

function installScript(options: MountOptions = {}) {
  const tag = document.createElement("script")
  tag.setAttribute("src", options.src ?? SCRIPT_SRC)
  const token = options.token === undefined ? TOKEN : options.token
  if (token !== null) tag.setAttribute(options.tokenAttr ?? "data-compass-token", token)
  if (options.pagePath) tag.setAttribute("data-compass-page-path", options.pagePath)
  document.head.appendChild(tag)
  return tag
}

/** Evaluates the shipped file. Globals resolve to jsdom's, exactly as in a browser. */
function evaluateWidget() {
  new Function(WIDGET_SOURCE)()
}

async function mount(options: MountOptions = {}) {
  installScript(options)
  evaluateWidget()
  await flush()
}

function hostElement() {
  return document.querySelector("[data-compass-feedback]")
}

function shadow(): ShadowRoot {
  const host = hostElement()
  if (!host) throw new Error("widget did not mount: no host element")
  if (!host.shadowRoot) throw new Error("widget mounted without a shadow root")
  return host.shadowRoot
}

function maybePart(name: string) {
  return shadow().querySelector<HTMLElement>('[data-compass="' + name + '"]')
}

function part(name: string): HTMLElement {
  const found = maybePart(name)
  if (!found) throw new Error('no widget part named "' + name + '"')
  return found
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }))
}

/** Sets a textarea's value without firing `input`, so the Send button stays enabled. */
function type(element: HTMLElement, value: string) {
  ;(element as HTMLTextAreaElement).value = value
}

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

function stubRect(element: Element, value: DOMRect) {
  ;(element as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => value
}

function setScroll(x: number, y: number) {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true, writable: true })
  Object.defineProperty(window, "scrollY", { value: y, configurable: true, writable: true })
}

/** A host-page element to anchor a comment to. */
function addTarget(id = "target") {
  const node = document.createElement("div")
  node.setAttribute("id", id)
  node.textContent = "Pick me"
  document.body.appendChild(node)
  stubRect(node, rect(100, 200, 300, 50))
  return node
}

function storeVisitor(embedToken = TOKEN, expiresAt: string | null = new Date(Date.now() + 3_600_000).toISOString()) {
  window.localStorage.setItem(storageKey(embedToken), JSON.stringify({ token: VISITOR, expiresAt }))
}

function storedVisitor(embedToken = TOKEN) {
  return window.localStorage.getItem(storageKey(embedToken))
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

type CommentFixture = {
  id: string
  body: string
  status: string
  authorName: string
  source: string
  createdAt: string
  updatedAt: string
  edited: boolean
  anchor: Json | null
  replies: CommentFixture[]
}

function comment(overrides: Partial<CommentFixture> = {}): CommentFixture {
  const now = new Date(Date.now() - 60_000).toISOString()
  return {
    id: "cmt_1",
    body: "The button is hard to find.",
    status: "OPEN",
    authorName: "Ada Lovelace",
    source: "WIDGET",
    createdAt: now,
    updatedAt: now,
    edited: false,
    anchor: null,
    replies: [],
    ...overrides,
  }
}

function anchor(overrides: Json = {}): Json {
  return {
    pageUrl: "https://prototype.example.com/pricing",
    pagePath: "/pricing",
    elementSelector: null,
    elementFingerprint: { tag: "div", text: "Pick me", rectXRatio: 0.1, rectYRatio: 0.1, rectWRatio: 0.3, rectHRatio: 0.025 },
    screenshotUrl: null,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

beforeEach(() => {
  calls = []
  routes = new Map()
  openCalls = []
  popupClosed = false
  rafQueue = []
  randomSeed = 0
  listeners = []
  recordListeners()

  document.head.replaceChildren()
  document.body.replaceChildren()
  window.localStorage.clear()

  installFetch()

  // The two reads every boot makes. A test that cares about either overrides it.
  on("GET /api/embed/session", reply(200, { signedIn: false }))
  on("GET /api/embed/comments", reply(200, { artifactId: "art_1", comments: [] }))

  window.open = vi.fn((url?: string | URL, name?: string, features?: string) => {
    openCalls.push({ url: String(url ?? ""), name: String(name ?? ""), features: String(features ?? "") })
    // Only `closed` is readable on a cross-origin popup, so only `closed` is offered.
    return { closed: popupClosed, close: () => { popupClosed = true } } as unknown as Window
  }) as unknown as typeof window.open

  window.requestAnimationFrame = ((callback: FrameRequestCallback) => rafQueue.push(callback)) as unknown as typeof window.requestAnimationFrame

  /**
   * A counting CSPRNG stand-in. Deterministic so a nonce can be predicted, and
   * varying so two sign-in attempts provably draw different nonces.
   */
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: {
      getRandomValues: vi.fn((array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) array[i] = (randomSeed * 31 + i) % 256
        randomSeed++
        return array
      }),
    },
  })

  // jsdom reports 0 for both, which would make every fingerprint ratio meaningless.
  Object.defineProperty(document.documentElement, "scrollWidth", { configurable: true, value: 1000 })
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 2000 })
  setScroll(0, 0)
})

afterEach(() => {
  /**
   * Pick mode installs capture-phase listeners on `document`, and a leaked one would
   * swallow clicks in a later test. Escape is the widget's own way out of pick mode,
   * so pressing it makes the widget remove them itself rather than having this file
   * reach into its internals.
   */
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))

  // After the Escape above, so the widget still has the listeners it needs to act on it.
  for (const entry of listeners) {
    entry.target.removeEventListener(entry.type, entry.handler, entry.options as EventListenerOptions | undefined)
  }
  listeners = []

  hostElement()?.remove()
  delete (window as unknown as Record<string, unknown>).__compassFeedbackWidget
  delete (window as unknown as Record<string, unknown>).htmlToImage
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ *
 * Boot and configuration
 * ------------------------------------------------------------------ */

describe("boot and configuration", () => {
  /**
   * The regression test for a name mismatch that would be miserable to debug.
   *
   * `components/settings/feedback-sources-panel.tsx` generates the install snippet
   * Compass hands an admin, and it emits `data-compass-token`. If the widget ever
   * reads a different attribute it will ignore a correctly configured page and do
   * nothing at all, while View Source looks perfectly right. That belongs in CI,
   * not in someone's browser.
   */
  it("boots from data-compass-token", async () => {
    await mount()
    expect(hostElement()).not.toBeNull()
    expect(part("launcher").textContent).toContain("Feedback")
    expect(WIDGET_SOURCE).toContain('"data-compass-token"')
  })

  it("does nothing at all when the token attribute has a different name", async () => {
    await mount({ tokenAttr: "data-feedback-token" })
    expect(hostElement()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("does nothing when the token attribute is absent or blank", async () => {
    await mount({ token: null })
    expect(hostElement()).toBeNull()

    delete (window as unknown as Record<string, unknown>).__compassFeedbackWidget
    document.head.replaceChildren()
    await mount({ token: "   " })
    expect(hostElement()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("derives the API base from its own src origin rather than a hard-coded host", async () => {
    await mount({ src: "https://compass-preview.vercel.app/embed/widget.js" })
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.url.origin).toBe("https://compass-preview.vercel.app")
      expect(call.url.pathname.startsWith("/api/embed/")).toBe(true)
    }
  })

  it("falls back to querySelector when document.currentScript is unavailable", async () => {
    // `new Function` evaluation leaves `currentScript` null, which is precisely the
    // fallback path — so reaching a mounted widget at all exercises it. Asserted
    // explicitly so the fallback cannot be deleted as dead code.
    expect(document.currentScript).toBeNull()
    await mount()
    expect(hostElement()).not.toBeNull()
    expect(WIDGET_SOURCE).toContain('script[" + TOKEN_ATTR + "]')
  })

  it("sends location.pathname as pagePath by default", async () => {
    await mount()
    expect(lastCall("GET /api/embed/comments").url.searchParams.get("pagePath")).toBe(window.location.pathname)
  })

  it("prefers data-compass-page-path when the host page supplies one", async () => {
    await mount({ pagePath: "/prototypes/checkout/step-2" })
    expect(lastCall("GET /api/embed/comments").url.searchParams.get("pagePath")).toBe("/prototypes/checkout/step-2")
  })

  it("mounts once when the install snippet appears twice on the page", async () => {
    await mount()
    // A tag manager firing twice, or the snippet pasted into both a layout and a
    // page. Two overlapping widgets would be visibly broken.
    installScript()
    evaluateWidget()
    await flush()
    expect(document.querySelectorAll("[data-compass-feedback]")).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * Isolation
 * ------------------------------------------------------------------ */

describe("isolation from the host page", () => {
  it("puts every style inside a shadow root and none on the host page", async () => {
    await mount()
    const styles = shadow().querySelectorAll("style")
    expect(styles).toHaveLength(1)
    // `:host { all: initial }` is what stops the page's inherited font, colour and
    // text-transform from leaking in; shadow DOM alone only blocks selectors.
    expect(styles[0].textContent).toContain(":host")
    expect(styles[0].textContent).toContain("all: initial")

    expect(document.head.querySelectorAll("style, link[rel=stylesheet]")).toHaveLength(0)
    expect(document.body.querySelectorAll("style")).toHaveLength(0)
  })

  it("adds exactly one element to the host page, sized zero and stacked on top", async () => {
    document.body.appendChild(document.createElement("p"))
    await mount()

    const host = hostElement() as HTMLElement
    expect(host.parentElement).toBe(document.documentElement)
    expect(document.querySelectorAll("[data-compass-feedback]")).toHaveLength(1)
    // Zero-size and fixed, so the host box itself can never intercept a click on the
    // page beneath; the interactive pieces opt back in individually inside the root.
    expect(host.style.position).toBe("fixed")
    expect(host.style.width).toBe("0px")
    expect(host.style.height).toBe("0px")
    expect(Number(host.style.zIndex)).toBeGreaterThan(2_000_000_000)
    // The page's own content is untouched.
    expect(document.body.querySelectorAll("p")).toHaveLength(1)
  })

  it("leaves the widget's own controls clickable while pick mode is armed", async () => {
    await mount()
    click(part("pick"))
    expect(part("pick").getAttribute("aria-pressed")).toBe("true")

    // A click on our own launcher must not be mistaken for picking the launcher.
    click(part("launcher"))
    expect(maybePart("anchor-chip")?.hidden).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Request invariants
 * ------------------------------------------------------------------ */

describe("request invariants", () => {
  it("presents the embed token as a bearer on every call and never sends cookies", async () => {
    await mount()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.headers.Authorization).toBe("Bearer " + TOKEN)
      // Not "omit", not "same-origin" — absent. The server never returns
      // Access-Control-Allow-Credentials, so a credentialed request would fail CORS
      // outright and the widget would stop working entirely.
      expect(call.credentials).toBeUndefined()
    }
    expect(WIDGET_SOURCE).not.toMatch(/credentials\s*:\s*["']/)
  })

  it("omits X-Compass-Visitor when no visitor token is held", async () => {
    await mount()
    for (const call of calls) expect(call.headers["X-Compass-Visitor"]).toBeUndefined()
  })

  it("presents a stored visitor token in X-Compass-Visitor", async () => {
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    await mount()
    expect(lastCall("GET /api/embed/session").headers["X-Compass-Visitor"]).toBe(VISITOR)
    expect(part("who").textContent).toContain("Ada")
    expect(maybePart("signout")).not.toBeNull()
  })

  it("scopes stored identity per embed token, so two sources on one origin do not share one", async () => {
    // Two prototypes on the same static host are one origin and therefore one
    // localStorage. A shared key would present source A's visitor token to source
    // B, which the server would reject as out-of-scope.
    storeVisitor(OTHER_TOKEN)
    await mount({ token: TOKEN })
    for (const call of calls) expect(call.headers["X-Compass-Visitor"]).toBeUndefined()
  })

  it("discards a stored token that has already expired rather than presenting it", async () => {
    storeVisitor(TOKEN, new Date(Date.now() - 1000).toISOString())
    await mount()
    for (const call of calls) expect(call.headers["X-Compass-Visitor"]).toBeUndefined()
    expect(storedVisitor()).toBeNull()
  })

  it("keeps working when localStorage throws, as it does in Safari private mode", async () => {
    const denied = () => {
      throw new Error("The operation is insecure.")
    }
    vi.spyOn(window.localStorage, "getItem").mockImplementation(denied)
    vi.spyOn(window.localStorage, "setItem").mockImplementation(denied)
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(denied)

    await mount()
    // Booting at all is the assertion: an unguarded `localStorage` read here would
    // have thrown before the widget ever reached `mount`.
    expect(hostElement()).not.toBeNull()
    expect(part("launcher")).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 * Rendering, and the XSS rule
 * ------------------------------------------------------------------ */

describe("rendering a thread", () => {
  it("renders attacker-controlled bodies and author names as text, never as markup", async () => {
    // Both fields are typed by whoever signed in, and they render inside a document
    // belonging to a third party. This is the single most important test in the file.
    const payload = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>'
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ body: payload, authorName: payload, replies: [comment({ id: "cmt_2", body: payload, authorName: payload })] })],
      })
    )
    await mount()

    expect(part("comment-body").textContent).toBe(payload)
    expect(shadow().querySelectorAll("img")).toHaveLength(0)
    expect(shadow().querySelectorAll("script")).toHaveLength(0)
    expect(shadow().querySelectorAll("[onerror]")).toHaveLength(0)
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
    // The reply body too — the recursive render path is the easy one to forget.
    expect(part("reply").textContent).toContain(payload)
  })

  it("refuses a non-http screenshot URL from the API", async () => {
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ anchor: anchor({ screenshotUrl: "javascript:window.__pwned = true" }) })],
      })
    )
    await mount()
    expect(shadow().querySelectorAll("img")).toHaveLength(0)
  })

  it("renders an https screenshot when the anchor carries one", async () => {
    const url = ORIGIN + "/blob/embed-feedback/shot.jpg"
    on("GET /api/embed/comments", reply(200, { artifactId: "art_1", comments: [comment({ anchor: anchor({ screenshotUrl: url }) })] }))
    await mount()
    const image = part("screenshot") as HTMLImageElement
    expect(image.getAttribute("src")).toBe(url)
    expect(image.getAttribute("alt")).toBeTruthy()
  })

  it("shows an empty state when the page has no feedback yet", async () => {
    await mount()
    expect(part("empty").textContent).toContain("No feedback")
    expect(maybePart("count")?.hidden).toBe(true)
  })

  it("shows the author, a relative time, and a count on the launcher", async () => {
    on(
      "GET /api/embed/comments",
      reply(200, { artifactId: "art_1", comments: [comment({ replies: [comment({ id: "cmt_2" })] })] })
    )
    await mount()
    expect(part("thread").textContent).toContain("Ada Lovelace")
    expect(part("thread").textContent).toContain("minute ago")
    // One root plus one reply.
    expect(part("count").textContent).toBe("2")
  })

  it("explains quietly when feedback is not publicly readable, and does not re-ask", async () => {
    on("GET /api/embed/comments", reply(403, { error: "Feedback on this workspace's artifacts is not publicly readable." }))
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    on("POST /api/embed/comments", reply(201, { comment: { id: "cmt_new", createdAt: new Date().toISOString() } }))
    await mount()

    expect(part("read-blocked").textContent).toContain("not published")
    expect(callsTo("GET /api/embed/comments")).toHaveLength(1)

    // A submit normally refreshes the thread. A 403 is a standing configuration
    // answer, not a transient one, so re-asking would burn read quota forever to
    // learn the same thing.
    type(part("composer-body"), "Still worth saying.")
    click(part("composer-submit"))
    await flush()
    expect(callsTo("POST /api/embed/comments")).toHaveLength(1)
    expect(callsTo("GET /api/embed/comments")).toHaveLength(1)
  })

  it("backs off with a readable message on a 429 instead of hammering", async () => {
    on("GET /api/embed/comments", reply(429, { error: "Too many requests" }))
    await mount()
    expect(part("message").textContent).toContain("try again in a moment")
    expect(part("message").getAttribute("role")).toBe("alert")
    expect(callsTo("GET /api/embed/comments")).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * Submitting
 * ------------------------------------------------------------------ */

describe("submitting", () => {
  beforeEach(() => {
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    on("POST /api/embed/comments", reply(201, { comment: { id: "cmt_new", createdAt: new Date().toISOString() } }))
  })

  it("sends a root comment with pageUrl and pagePath", async () => {
    await mount({ pagePath: "/pricing" })
    type(part("composer-body"), "The button is hard to find.")
    click(part("composer-submit"))
    await flush()

    const body = lastCall("POST /api/embed/comments").body as Json
    expect(body.body).toBe("The button is hard to find.")
    // Both are required by the route and a root comment is rejected without them.
    expect(body.pageUrl).toBe(window.location.href)
    expect(body.pagePath).toBe("/pricing")
    expect(body.parentId).toBeUndefined()
  })

  it("clears the composer and refreshes the thread after a successful submit", async () => {
    await mount()
    type(part("composer-body"), "Nearly there.")
    click(part("composer-submit"))
    await flush()

    expect((part("composer-body") as HTMLTextAreaElement).value).toBe("")
    expect(part("message").textContent).toContain("sent")
    expect(callsTo("GET /api/embed/comments")).toHaveLength(2)
  })

  it("sends a reply with parentId and no anchor of its own", async () => {
    on("GET /api/embed/comments", reply(200, { artifactId: "art_1", comments: [comment({ id: "cmt_root" })] }))
    await mount()

    type(part("reply-body"), "Agreed, I could not find it either.")
    click(part("reply-submit"))
    await flush()

    const body = lastCall("POST /api/embed/comments").body as Json
    expect(body).toEqual({ body: "Agreed, I could not find it either.", parentId: "cmt_root" })
    // Spelled out as well as compared, because a reply that smuggles an anchor is
    // silently ignored server-side and would look like it worked.
    expect(body.pageUrl).toBeUndefined()
    expect(body.elementSelector).toBeUndefined()
    expect(body.elementFingerprint).toBeUndefined()
    expect(body.screenshotUrl).toBeUndefined()
  })

  it("refuses an over-length body before spending a submit-quota slot", async () => {
    await mount()
    // Set without firing `input`, so the Send button is still enabled: the disabled
    // state is belt and braces, and the guard inside the submit path is what is
    // under test here.
    type(part("composer-body"), "x".repeat(4001))
    click(part("composer-submit"))
    await flush()

    expect(callsTo("POST /api/embed/comments")).toHaveLength(0)
    expect(part("message").textContent).toContain("4000")
  })

  it("accepts a body of exactly the limit", async () => {
    await mount()
    type(part("composer-body"), "x".repeat(4000))
    click(part("composer-submit"))
    await flush()
    expect(callsTo("POST /api/embed/comments")).toHaveLength(1)
  })

  it("refuses an empty body without a request", async () => {
    await mount()
    type(part("composer-body"), "   \n  ")
    click(part("composer-submit"))
    await flush()
    expect(callsTo("POST /api/embed/comments")).toHaveLength(0)
    expect(part("message").textContent).toContain("Write something")
  })

  it("shows the server's own validation message on a 400", async () => {
    on("POST /api/embed/comments", reply(400, { error: "Comment body is required and must be at most 4000 characters." }))
    await mount()
    type(part("composer-body"), "Something the server dislikes.")
    click(part("composer-submit"))
    await flush()
    expect(part("message").textContent).toContain("must be at most 4000 characters")
  })

  it("surfaces a 429 on submit without retrying", async () => {
    on("POST /api/embed/comments", reply(429, { error: "Too many requests" }))
    await mount()
    type(part("composer-body"), "One more thing.")
    click(part("composer-submit"))
    await flush()
    expect(part("message").textContent).toContain("try again in a moment")
    expect(callsTo("POST /api/embed/comments")).toHaveLength(1)
  })

  it("does not lose the comment when the network fails outright", async () => {
    window.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    await mount()
    type(part("composer-body"), "Offline thoughts.")
    click(part("composer-submit"))
    await flush()
    // The draft survives, and the widget is still alive rather than having thrown
    // into the host page.
    expect((part("composer-body") as HTMLTextAreaElement).value).toBe("Offline thoughts.")
    expect(part("message").getAttribute("data-tone")).toBe("error")
  })
})

/* ------------------------------------------------------------------ *
 * Element picking and anchors
 * ------------------------------------------------------------------ */

describe("picking an element", () => {
  beforeEach(() => {
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    on("POST /api/embed/comments", reply(201, { comment: { id: "cmt_new", createdAt: new Date().toISOString() } }))
    // A capture that rejects, so these tests are about the anchor rather than the
    // screenshot. The screenshot paths have their own block below.
    ;(window as unknown as Record<string, unknown>).htmlToImage = { toCanvas: () => Promise.reject(new Error("no canvas in jsdom")) }
  })

  it("highlights the element under the cursor while picking", async () => {
    const target = addTarget()
    await mount()
    click(part("pick"))

    expect(part("hint").getAttribute("data-on")).toBe("true")
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))

    const highlight = part("highlight")
    expect(highlight.getAttribute("data-on")).toBe("true")
    expect(highlight.style.left).toBe("100px")
    expect(highlight.style.top).toBe("200px")
    expect(highlight.style.width).toBe("300px")
    expect(highlight.style.height).toBe("50px")
  })

  it("swallows the picking click so the prototype's own handler does not run", async () => {
    const target = addTarget()
    const hostHandler = vi.fn()
    target.addEventListener("click", hostHandler)
    await mount()
    click(part("pick"))

    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    // The visitor meant "comment on this", not "activate this"; letting the click
    // through could navigate away from the comment they are about to write.
    expect(event.defaultPrevented).toBe(true)
    expect(hostHandler).not.toHaveBeenCalled()
  })

  it("leaves pick mode and shows what is being commented on", async () => {
    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)
    await flush()

    expect(part("pick").getAttribute("aria-pressed")).toBe("false")
    expect(part("hint").getAttribute("data-on")).toBe("false")
    expect(part("panel").getAttribute("data-open")).toBe("true")
    expect(part("anchor-chip").hidden).toBe(false)
    expect(part("anchor-chip").textContent).toContain("Pick me")
  })

  it("sends a selector and exactly the six fingerprint fields the route keeps", async () => {
    const target = addTarget("cta")
    await mount()
    click(part("pick"))
    click(target)
    await flush()

    type(part("composer-body"), "This is the element.")
    click(part("composer-submit"))
    await flush()

    const body = lastCall("POST /api/embed/comments").body as Json
    expect(body.elementSelector).toBe("#cta")

    const fingerprint = body.elementFingerprint as Record<string, unknown>
    // Anything beyond these six is rebuilt away server-side, so sending more would
    // read as an attempt to use the JSON column as storage.
    expect(Object.keys(fingerprint).sort()).toEqual(["rectHRatio", "rectWRatio", "rectXRatio", "rectYRatio", "tag", "text"])
    expect(fingerprint.tag).toBe("div")
    expect(fingerprint.text).toBe("Pick me")
    // Fractions of the document scroll size (1000 x 2000), so they mean the same
    // thing when the comment is read back on a different screen.
    expect(fingerprint.rectXRatio).toBeCloseTo(0.1, 6)
    expect(fingerprint.rectYRatio).toBeCloseTo(0.1, 6)
    expect(fingerprint.rectWRatio).toBeCloseTo(0.3, 6)
    expect(fingerprint.rectHRatio).toBeCloseTo(0.025, 6)
  })

  it("lets the visitor drop the anchor and comment on the page instead", async () => {
    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)
    await flush()

    click(part("anchor-clear"))
    expect(part("anchor-chip").hidden).toBe(true)

    type(part("composer-body"), "General remark.")
    click(part("composer-submit"))
    await flush()
    const body = lastCall("POST /api/embed/comments").body as Json
    expect(body.elementSelector).toBeUndefined()
    expect(body.elementFingerprint).toBeUndefined()
    expect(body.pagePath).toBeTruthy()
  })

  it("cancels pick mode on Escape", async () => {
    await mount()
    click(part("pick"))
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(part("pick").getAttribute("aria-pressed")).toBe("false")
    expect(part("hint").getAttribute("data-on")).toBe("false")
  })
})

/* ------------------------------------------------------------------ *
 * Pins
 * ------------------------------------------------------------------ */

describe("pins over anchored comments", () => {
  it("positions a pin from the stored fingerprint ratios", async () => {
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ anchor: anchor({ elementFingerprint: { tag: "div", rectXRatio: 0.2, rectYRatio: 0.1, rectWRatio: 0.3, rectHRatio: 0.02 } }) })],
      })
    )
    await mount()

    const pin = part("pin")
    // 0.2 * 1000 - 0 scroll - 8 nudge, and 0.1 * 2000 - 0 - 8.
    expect(pin.style.left).toBe("192px")
    expect(pin.style.top).toBe("192px")
    expect(pin.textContent).toBe("1")
  })

  it("prefers a selector that still resolves over the stored ratios", async () => {
    const target = addTarget("cta")
    stubRect(target, rect(40, 60, 10, 10))
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ anchor: anchor({ elementSelector: "#cta", elementFingerprint: { rectXRatio: 0.9, rectYRatio: 0.9 } }) })],
      })
    )
    await mount()
    // The live element has moved since the comment was left; it is the truth.
    expect(part("pin").style.left).toBe("32px")
    expect(part("pin").style.top).toBe("52px")
  })

  it("survives an anchor whose selector no longer parses", async () => {
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ anchor: anchor({ elementSelector: "div:::nonsense((", elementFingerprint: { rectXRatio: 0.2, rectYRatio: 0.1 } }) })],
      })
    )
    await mount()
    // An invalid selector is data, not a crash; the ratios take over.
    expect(part("pin").style.left).toBe("192px")
  })

  it("repositions on scroll, throttled to one frame", async () => {
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ anchor: anchor({ elementFingerprint: { rectXRatio: 0.2, rectYRatio: 0.1 } }) })],
      })
    )
    await mount()
    expect(part("pin").style.top).toBe("192px")

    setScroll(0, 150)
    window.dispatchEvent(new Event("scroll"))
    window.dispatchEvent(new Event("scroll"))
    window.dispatchEvent(new Event("scroll"))
    // Three scroll events, one frame of work: `scroll` fires far faster than a frame
    // and each pass reads layout.
    expect(rafQueue).toHaveLength(1)
    runFrames()
    expect(part("pin").style.top).toBe("42px")
  })

  it("renders no pin for a comment with no anchor", async () => {
    on("GET /api/embed/comments", reply(200, { artifactId: "art_1", comments: [comment({ anchor: null })] }))
    await mount()
    expect(maybePart("pin")).toBeNull()
  })

  it("opens the panel on the matching thread when a pin is clicked", async () => {
    on(
      "GET /api/embed/comments",
      reply(200, {
        artifactId: "art_1",
        comments: [comment({ id: "cmt_root", anchor: anchor({ elementFingerprint: { rectXRatio: 0.2, rectYRatio: 0.1 } }) })],
      })
    )
    await mount()
    click(part("pin"))
    expect(part("panel").getAttribute("data-open")).toBe("true")
    expect(part("thread").getAttribute("data-selected")).toBe("true")
  })
})

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

describe("sign-in", () => {
  /** The nonce the stubbed CSPRNG produces on its Nth draw, N counting from 0. */
  function expectedNonce(draw: number) {
    let hex = ""
    for (let i = 0; i < 32; i++) hex += ((draw * 31 + i) % 256 + 0x100).toString(16).slice(1)
    return hex
  }

  it("opens a popup on the Compass origin carrying the token and a fresh nonce", async () => {
    await mount()
    click(part("signin"))

    expect(openCalls).toHaveLength(1)
    const url = new URL(openCalls[0].url)
    // Compass's own origin, so the visitor sees a real Compass address bar and the
    // embedding page never sees their email or their magic link.
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe("/embed/signin")
    expect(url.searchParams.get("token")).toBe(TOKEN)
    expect(url.searchParams.get("nonce")).toBe(expectedNonce(0))
  })

  it("draws 64 lowercase hex characters from the CSPRNG, never Math.random", async () => {
    await mount()
    click(part("signin"))

    const getRandomValues = window.crypto.getRandomValues as unknown as ReturnType<typeof vi.fn>
    expect(getRandomValues).toHaveBeenCalledTimes(1)
    const drawn = getRandomValues.mock.calls[0][0] as Uint8Array
    // 32 bytes, because the server's regex is /^[0-9a-f]{64}$/ and a predictable
    // nonce would let a stranger claim somebody else's freshly minted token.
    expect(drawn).toBeInstanceOf(Uint8Array)
    expect(drawn.length).toBe(32)

    const nonce = new URL(openCalls[0].url).searchParams.get("nonce") as string
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    // That the file contains no `Math.random(` at all is asserted separately, in
    // "draws randomness only from the CSPRNG" below.
  })

  it("draws a new nonce each time sign-in is pressed", async () => {
    await mount()
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      click(part("signin"))
      seen.add(new URL(openCalls[openCalls.length - 1].url).searchParams.get("nonce") as string)
    }
    // A visitor who let the popup time out has no other way back, so pressing again
    // must start over rather than be ignored.
    expect(seen.size).toBe(4)
    expect(openCalls).toHaveLength(4)
    // Nothing has been claimed yet: the first poll is one interval out, not immediate.
    expect(callsTo("POST /api/embed/session")).toHaveLength(0)
  })

  it("tells the visitor what to do when the popup is blocked", async () => {
    window.open = vi.fn(() => null) as unknown as typeof window.open
    await mount()
    click(part("signin"))
    expect(part("message").textContent).toContain("pop-ups")
  })

  it("keeps polling through a PORTAL_AUTH_REQUIRED, then claims the token", async () => {
    vi.useFakeTimers()
    let attempt = 0
    on("POST /api/embed/session", () => {
      attempt++
      // The documented deviation: on this one endpoint PORTAL_AUTH_REQUIRED means
      // "this nonce is not claimable yet", which is the normal answer while the
      // visitor is still reading their email. Treating it as a session failure would
      // abort every sign-in on its first poll.
      if (attempt < 3) return { status: 401, data: { error: "This sign-in has expired.", code: "PORTAL_AUTH_REQUIRED" } }
      return {
        status: 201,
        data: { token: VISITOR, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "ada@example.com", name: "Ada" },
      }
    })

    await mount()
    click(part("signin"))
    await vi.advanceTimersByTimeAsync(2500)
    expect(callsTo("POST /api/embed/session")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2500)
    await vi.advanceTimersByTimeAsync(2500)
    expect(callsTo("POST /api/embed/session")).toHaveLength(3)

    // Returned exactly once, so it is persisted before anything else can throw.
    expect(JSON.parse(storedVisitor() as string).token).toBe(VISITOR)
    expect(part("who").textContent).toContain("Ada")
    expect(maybePart("signout")).not.toBeNull()

    // The poll stops once it has what it came for.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(callsTo("POST /api/embed/session")).toHaveLength(3)
  })

  it("polls anonymously and never puts a nonce anywhere but the popup URL and the body", async () => {
    vi.useFakeTimers()
    on("POST /api/embed/session", reply(401, { error: "expired", code: "PORTAL_AUTH_REQUIRED" }))
    storeVisitor()
    await mount()
    click(part("signin"))
    await vi.advanceTimersByTimeAsync(2500)

    const poll = lastCall("POST /api/embed/session")
    expect((poll.body as Json).nonce).toBe(expectedNonce(0))
    // Anonymous on purpose: this is the request that mints an identity, so presenting
    // a stale one would be meaningless and could get it cleared.
    expect(poll.headers["X-Compass-Visitor"]).toBeUndefined()
    expect(poll.url.search).toBe("")
  })

  it("gives up at the ten-minute ceiling", async () => {
    vi.useFakeTimers()
    on("POST /api/embed/session", reply(401, { error: "expired", code: "PORTAL_AUTH_REQUIRED" }))
    await mount()
    click(part("signin"))

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 5000)
    const afterCeiling = callsTo("POST /api/embed/session").length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callsTo("POST /api/embed/session")).toHaveLength(afterCeiling)
    expect(part("message").textContent).toContain("timed out")
  })

  it("does not treat a closed popup as instant failure", async () => {
    vi.useFakeTimers()
    on("POST /api/embed/session", reply(401, { error: "expired", code: "PORTAL_AUTH_REQUIRED" }))
    // Closed from the outset: the visitor may well have signed in and then closed it,
    // in which case the handoff is already waiting for the very next poll.
    popupClosed = true
    await mount()
    click(part("signin"))

    await vi.advanceTimersByTimeAsync(2500)
    expect(callsTo("POST /api/embed/session")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(callsTo("POST /api/embed/session").length).toBeGreaterThan(2)

    // But it does stop after the grace period rather than polling for ten minutes.
    await vi.advanceTimersByTimeAsync(60_000)
    const settled = callsTo("POST /api/embed/session").length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callsTo("POST /api/embed/session")).toHaveLength(settled)
    expect(part("message").textContent).toContain("cancelled")
  })

  it("resumes the interrupted submit once sign-in completes", async () => {
    vi.useFakeTimers()
    on("POST /api/embed/session", () => ({
      status: 201,
      data: { token: VISITOR, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "ada@example.com", name: "Ada" },
    }))
    on("POST /api/embed/comments", reply(201, { comment: { id: "cmt_new", createdAt: new Date().toISOString() } }))
    await mount()

    type(part("composer-body"), "Worth keeping.")
    click(part("composer-submit"))
    await flush()
    // No token, so no request was wasted on a submit that would have 401'd.
    expect(callsTo("POST /api/embed/comments")).toHaveLength(0)
    expect(part("message").textContent).toContain("Sign in")
    expect((part("composer-body") as HTMLTextAreaElement).value).toBe("Worth keeping.")

    click(part("signin"))
    await vi.advanceTimersByTimeAsync(2500)

    const submitted = lastCall("POST /api/embed/comments")
    expect((submitted.body as Json).body).toBe("Worth keeping.")
    expect(submitted.headers["X-Compass-Visitor"]).toBe(VISITOR)
  })

  it("discards the stored token and offers sign-in on a PORTAL_AUTH_REQUIRED submit", async () => {
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    on("POST /api/embed/comments", reply(401, { error: "Sign in required to leave feedback.", code: "PORTAL_AUTH_REQUIRED" }))
    await mount()
    expect(maybePart("signout")).not.toBeNull()

    type(part("composer-body"), "Revoked mid-compose.")
    click(part("composer-submit"))
    await flush()

    // Not an error state: nothing is wrong, they are simply not signed in here.
    expect(storedVisitor()).toBeNull()
    expect(maybePart("signin")).not.toBeNull()
    expect(maybePart("signout")).toBeNull()
    expect((part("composer-body") as HTMLTextAreaElement).value).toBe("Revoked mid-compose.")
  })

  it("signs out through the API and forgets the token locally", async () => {
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    on("DELETE /api/embed/session", reply(200, { signedIn: false }))
    await mount()

    click(part("signout"))
    await flush()
    expect(lastCall("DELETE /api/embed/session").headers["X-Compass-Visitor"]).toBe(VISITOR)
    expect(storedVisitor()).toBeNull()
    expect(maybePart("signin")).not.toBeNull()
  })

  it("trusts the session endpoint over storage when a stored token has gone stale", async () => {
    storeVisitor()
    // Revoked from another tab, or minted for a different source. Either way the
    // endpoint answers `{ signedIn: false }` and the widget must not render a
    // signed-in state it cannot back up.
    on("GET /api/embed/session", reply(200, { signedIn: false }))
    await mount()
    expect(maybePart("signin")).not.toBeNull()
    expect(storedVisitor()).toBeNull()
  })

  it("keeps a signed-in session usable when localStorage refuses to persist it", async () => {
    vi.useFakeTimers()
    const denied = () => {
      throw new Error("The operation is insecure.")
    }
    vi.spyOn(window.localStorage, "getItem").mockImplementation(denied)
    vi.spyOn(window.localStorage, "setItem").mockImplementation(denied)
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(denied)

    on("POST /api/embed/session", () => ({
      status: 201,
      data: { token: VISITOR, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "ada@example.com", name: "Ada" },
    }))
    on("POST /api/embed/comments", reply(201, { comment: { id: "cmt_new", createdAt: new Date().toISOString() } }))

    await mount()
    click(part("signin"))
    await vi.advanceTimersByTimeAsync(2500)
    expect(part("who").textContent).toContain("Ada")

    type(part("composer-body"), "Stored nowhere but memory.")
    click(part("composer-submit"))
    await flush()
    // The in-memory fallback carries the credential for the life of the page; the
    // visitor simply signs in again on the next navigation.
    expect(lastCall("POST /api/embed/comments").headers["X-Compass-Visitor"]).toBe(VISITOR)
  })
})

/* ------------------------------------------------------------------ *
 * Screenshots
 * ------------------------------------------------------------------ */

/**
 * jsdom ships no canvas, so `getContext("2d")` returns null and the widget's
 * happy path deliberately bails there. That means **a successful capture is not
 * observable in this file** — every test below is a failure path, which is the
 * half that actually matters: the brief's requirement is that no capture failure
 * ever blocks a comment. The success path is reached only in a real browser.
 */
describe("screenshots", () => {
  beforeEach(() => {
    storeVisitor()
    on("GET /api/embed/session", reply(200, { signedIn: true, email: "ada@example.com", name: "Ada" }))
    on("POST /api/embed/comments", reply(201, { comment: { id: "cmt_new", createdAt: new Date().toISOString() } }))
    on("POST /api/embed/screenshot", reply(201, { url: ORIGIN + "/blob/embed-feedback/shot.jpg" }))
  })

  function vendorTag() {
    return document.querySelector("script[data-compass-feedback-vendor]")
  }

  it("does not fetch the capture library until a capture is actually needed", async () => {
    await mount()
    // The library is far larger than the widget, and most visitors never anchor a
    // comment. Loading it eagerly would be the biggest cost of installing this.
    expect(vendorTag()).toBeNull()

    const target = addTarget()
    click(part("pick"))
    click(target)
    await flush()

    expect(vendorTag()?.getAttribute("src")).toBe(ORIGIN + "/vendor/html-to-image.js")
  })

  it("submits without a screenshot when the library never loads", async () => {
    vi.useFakeTimers()
    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)

    // A host-page CSP that forbids our origin makes the tag fire neither load nor
    // error in some browsers, so without the timeout the capture would hang forever
    // and the visitor's Send would never resolve.
    await vi.advanceTimersByTimeAsync(9000)
    type(part("composer-body"), "No picture, but the words matter.")
    click(part("composer-submit"))
    await vi.advanceTimersByTimeAsync(100)

    expect(callsTo("POST /api/embed/screenshot")).toHaveLength(0)
    const body = lastCall("POST /api/embed/comments").body as Json
    expect(body.screenshotUrl).toBeUndefined()
    expect(body.body).toBe("No picture, but the words matter.")
  })

  it("submits without a screenshot when the library is blocked outright", async () => {
    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)

    const tag = vendorTag() as HTMLScriptElement
    tag.dispatchEvent(new Event("error"))
    await flush()

    type(part("composer-body"), "Blocked by CSP.")
    click(part("composer-submit"))
    await flush()
    expect(callsTo("POST /api/embed/screenshot")).toHaveLength(0)
    expect((lastCall("POST /api/embed/comments").body as Json).screenshotUrl).toBeUndefined()
  })

  it("submits without a screenshot when the library loads but exposes no global", async () => {
    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)

    ;(vendorTag() as HTMLScriptElement).dispatchEvent(new Event("load"))
    await flush()

    type(part("composer-body"), "Global missing.")
    click(part("composer-submit"))
    await flush()
    expect((lastCall("POST /api/embed/comments").body as Json).screenshotUrl).toBeUndefined()
  })

  it("submits without a screenshot when toCanvas rejects", async () => {
    ;(window as unknown as Record<string, unknown>).htmlToImage = { toCanvas: () => Promise.reject(new Error("SecurityError")) }
    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)
    await flush()

    type(part("composer-body"), "Rasterise failed.")
    click(part("composer-submit"))
    await flush()
    expect(callsTo("POST /api/embed/screenshot")).toHaveLength(0)
    expect((lastCall("POST /api/embed/comments").body as Json).screenshotUrl).toBeUndefined()
  })

  it("submits without a screenshot when there is no 2D context, as in jsdom", async () => {
    // The real jsdom condition, asserted rather than left implicit.
    ;(window as unknown as Record<string, unknown>).htmlToImage = {
      toCanvas: () => Promise.resolve(document.createElement("canvas")),
    }
    expect(document.createElement("canvas").getContext("2d")).toBeNull()

    const target = addTarget()
    await mount()
    click(part("pick"))
    click(target)
    await flush()

    type(part("composer-body"), "No context.")
    click(part("composer-submit"))
    await flush()
    expect(callsTo("POST /api/embed/screenshot")).toHaveLength(0)
    expect((lastCall("POST /api/embed/comments").body as Json).screenshotUrl).toBeUndefined()
  })

  it("never asks for a capture on a reply", async () => {
    ;(window as unknown as Record<string, unknown>).htmlToImage = { toCanvas: () => Promise.reject(new Error("unused")) }
    on("GET /api/embed/comments", reply(200, { artifactId: "art_1", comments: [comment({ id: "cmt_root" })] }))
    await mount()

    type(part("reply-body"), "Replies inherit their parent's anchor.")
    click(part("reply-submit"))
    await flush()
    expect(vendorTag()).toBeNull()
    expect(callsTo("POST /api/embed/screenshot")).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * Panel behaviour
 * ------------------------------------------------------------------ */

describe("panel", () => {
  it("toggles from the launcher and reports its state to assistive tech", async () => {
    await mount()
    expect(part("panel").getAttribute("data-open")).toBe("false")
    expect(part("launcher").getAttribute("aria-expanded")).toBe("false")

    click(part("launcher"))
    expect(part("panel").getAttribute("data-open")).toBe("true")
    expect(part("launcher").getAttribute("aria-expanded")).toBe("true")

    click(part("launcher"))
    expect(part("panel").getAttribute("data-open")).toBe("false")
  })

  it("closes on the close button and on Escape", async () => {
    await mount()
    click(part("launcher"))
    click(part("close"))
    expect(part("panel").getAttribute("data-open")).toBe("false")

    click(part("launcher"))
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(part("panel").getAttribute("data-open")).toBe("false")
  })

  it("counts down from the body limit as the visitor types", async () => {
    await mount()
    const input = part("composer-body") as HTMLTextAreaElement
    input.value = "hello"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(part("counter").textContent).toBe("5 / 4000")
    expect(part("counter").getAttribute("data-over")).toBe("false")

    input.value = "x".repeat(4001)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(part("counter").getAttribute("data-over")).toBe("true")
    expect((part("composer-submit") as HTMLButtonElement).disabled).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Guarantees about the shipped source
 * ------------------------------------------------------------------ */

describe("the shipped file itself", () => {
  it("has comments stripped without the code going with them", () => {
    // Guards every assertion below: an over-eager stripper would make all of them
    // trivially true. The Math.random sentence is the prose this exists to exclude.
    expect(WIDGET_SOURCE).toContain("Math.random")
    expect(WIDGET_CODE).toContain('GLOBAL_KEY = "__compassFeedbackWidget"')
    expect(WIDGET_CODE).toContain("function mount(")
    expect(WIDGET_CODE).toContain("function submitComment(")
    expect(WIDGET_CODE.length).toBeGreaterThan(WIDGET_SOURCE.length * 0.4)
  })

  it("never assigns markup from a string", () => {
    // The whole XSS argument rests on this. A reviewer can grep for these sinks and
    // expect no hits, and this keeps that true.
    expect(WIDGET_CODE).not.toMatch(/\.innerHTML\s*=/)
    expect(WIDGET_CODE).not.toMatch(/\.outerHTML\s*=/)
    expect(WIDGET_CODE).not.toMatch(/insertAdjacentHTML\s*\(/)
    expect(WIDGET_CODE).not.toMatch(/document\s*\.\s*write/)
    expect(WIDGET_CODE).not.toMatch(/\.srcdoc\s*=/)
    // The one authored string that becomes CSS reaches the DOM as text.
    expect(WIDGET_CODE).toContain("style.textContent = CSS")
  })

  it("draws randomness only from the CSPRNG", () => {
    expect(WIDGET_CODE).not.toMatch(/Math\s*\.\s*random\s*\(/)
    expect(WIDGET_CODE).toContain("crypto.getRandomValues")
  })

  it("is parseable as ES2018, the floor this file targets", () => {
    // No build step means no transpile, so anything newer than the oldest browser
    // the widget must run on is a runtime SyntaxError on a stranger's page.
    expect(WIDGET_CODE).not.toMatch(/\?\./)
    expect(WIDGET_CODE).not.toMatch(/\?\?/)
    // `catch {}` without a binding is ES2019.
    expect(WIDGET_CODE).not.toMatch(/catch\s*\{/)
    expect(WIDGET_CODE).not.toMatch(/Object\s*\.\s*fromEntries/)
    expect(WIDGET_CODE).not.toMatch(/\.flatMap\s*\(/)
    expect(WIDGET_CODE).not.toMatch(/\.replaceAll\s*\(/)
    expect(WIDGET_CODE).not.toMatch(/globalThis/)
    expect(WIDGET_CODE).not.toMatch(/\bclass\s+\w+/)
  })

  it("is one IIFE that claims a single namespaced global", () => {
    // On the raw text on purpose: the banner is part of what ships, and it is what
    // a minifier is told to preserve.
    expect(WIDGET_SOURCE.trimStart().startsWith("/*!")).toBe(true)
    expect(WIDGET_SOURCE.trimEnd().endsWith("})();")).toBe(true)
    expect(WIDGET_CODE).toContain('"use strict"')
    // No import, export, or require: this file is served verbatim.
    expect(WIDGET_CODE).not.toMatch(/^\s*import\s/m)
    expect(WIDGET_CODE).not.toMatch(/^\s*export\s/m)
    expect(WIDGET_CODE).not.toMatch(/require\s*\(/)
  })

  it("leaves the host page's module loaders alone", () => {
    // The vendored library's UMD is already forced onto its global branch, and
    // __tests__/embed-vendor-html-to-image.test.ts covers that. The widget must not
    // second-guess it by shimming `define` around the load, which would race any
    // other async script the host page is loading.
    expect(WIDGET_CODE).not.toMatch(/delete\s+window\s*\.\s*define/)
    expect(WIDGET_CODE).not.toMatch(/window\s*\.\s*define\s*=/)
    expect(WIDGET_CODE).not.toMatch(/window\s*\.\s*module\s*=/)
  })

  it("hard-codes no host at all", () => {
    // Every live URL is built from API_BASE, which is read off this script's own src.
    // The only absolute URL in the file is the example in the header banner, which
    // the comment stripper has already removed.
    expect(WIDGET_CODE).not.toMatch(/https?:\/\//)
    expect(WIDGET_CODE).toContain('API_BASE + "/api/embed')
  })
})
